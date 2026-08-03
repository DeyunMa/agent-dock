import type { TurnStartParams } from "./types.js";

export function extractTurnPrompt(params: TurnStartParams): string {
  if (!Array.isArray(params.input)) return "";
  return params.input
    .filter(
      (item): item is { type: "text"; text: string } =>
        item !== null &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => item.text)
    .join("\n")
    .trim();
}
