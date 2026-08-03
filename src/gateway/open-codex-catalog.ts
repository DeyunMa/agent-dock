import type { GatewayModel } from "./gateway.js";

type Table = Record<string, unknown>;

function table(value: unknown): Table | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Table)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values.flatMap((value) => {
        if (typeof value === "string") return value.trim() ? [value.trim()] : [];
        const item = table(value);
        const candidate = nonEmptyString(item?.effort) ?? nonEmptyString(item?.id);
        return candidate ? [candidate] : [];
      }),
    ),
  ];
}

function identity(id: string, ownedBy?: string): Pick<GatewayModel, "provider" | "requiresGateway"> {
  const separator = id.indexOf("/");
  return {
    provider: ownedBy ?? (separator > 0 ? id.slice(0, separator) : "openai"),
    requiresGateway: separator > 0,
  };
}

function richModel(value: unknown): GatewayModel | undefined {
  const item = table(value);
  const id = nonEmptyString(item?.slug);
  if (!item || !id) return undefined;
  const defaultReasoningEffort = nonEmptyString(item.default_reasoning_level);
  return {
    id,
    displayName: nonEmptyString(item.display_name) ?? id,
    ...identity(id),
    reasoningEfforts: uniqueStrings(item.supported_reasoning_levels),
    serviceTiers: uniqueStrings(item.service_tiers),
    capabilitiesKnown: true,
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
  };
}

function listModel(value: unknown): GatewayModel | undefined {
  const item = table(value);
  const id = nonEmptyString(item?.id) ?? nonEmptyString(item?.model);
  if (!item || !id) return undefined;
  return {
    id,
    displayName: id,
    ...identity(id, nonEmptyString(item.owned_by)),
    reasoningEfforts: [],
    serviceTiers: [],
    capabilitiesKnown: false,
  };
}

/** Normalizes both OpenCodex's rich Codex catalog and its OpenAI model list. */
export function parseOpenCodexModels(payload: unknown): GatewayModel[] {
  const root = table(payload);
  const rich = Array.isArray(root?.models)
    ? root.models.flatMap((value) => {
        const parsed = richModel(value);
        return parsed ? [parsed] : [];
      })
    : [];
  if (rich.length > 0) return rich;

  return Array.isArray(root?.data)
    ? root.data.flatMap((value) => {
        const parsed = listModel(value);
        return parsed ? [parsed] : [];
      })
    : [];
}
