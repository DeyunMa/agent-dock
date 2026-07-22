import type { ModelCatalog, ModelDescriptor, RouteProfile } from "./types.js";

interface RawModel {
  id?: unknown;
  model?: unknown;
  supportedReasoningEfforts?: unknown;
  serviceTiers?: unknown;
}

export function parseModelCatalog(result: unknown): ModelCatalog | undefined {
  if (!result || typeof result !== "object") return undefined;
  const data = (result as { data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;
  const models = new Map<string, ModelDescriptor>();
  for (const item of data as RawModel[]) {
    const id = typeof item.id === "string" ? item.id : typeof item.model === "string" ? item.model : undefined;
    if (!id) continue;
    const supportedReasoningEfforts = Array.isArray(item.supportedReasoningEfforts)
      ? item.supportedReasoningEfforts
          .map((effort) =>
            effort && typeof effort === "object"
              ? (effort as { reasoningEffort?: unknown }).reasoningEffort
              : undefined,
          )
          .filter((effort): effort is string => typeof effort === "string")
      : [];
    const serviceTiers = Array.isArray(item.serviceTiers)
      ? item.serviceTiers
          .map((tier) =>
            tier && typeof tier === "object" ? (tier as { id?: unknown }).id : undefined,
          )
          .filter((tier): tier is string => typeof tier === "string")
      : [];
    models.set(id, { id, supportedReasoningEfforts, serviceTiers });
  }
  return { models };
}

export function validateProfile(
  profile: RouteProfile,
  catalog: ModelCatalog | undefined,
): { valid: boolean; profile: RouteProfile; reason?: string } {
  if (!catalog || catalog.models.size === 0) return { valid: true, profile };
  const model = catalog.models.get(profile.model);
  if (!model) return { valid: false, profile, reason: `model_not_available:${profile.model}` };
  if (
    model.supportedReasoningEfforts.length > 0 &&
    !model.supportedReasoningEfforts.includes(profile.effort)
  ) {
    return { valid: false, profile, reason: `effort_not_supported:${profile.effort}` };
  }
  if (profile.fast && model.serviceTiers.length > 0 && !model.serviceTiers.includes("priority")) {
    return { valid: true, profile: { ...profile, fast: false }, reason: "fast_not_supported" };
  }
  return { valid: true, profile };
}
