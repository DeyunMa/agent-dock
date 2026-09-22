import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RouteProfile } from "../core/types.js";

export const ROUTER_MODEL = "jev-router";

export interface RouterSelection {
  mode: "auto" | "manual";
  profile: RouteProfile;
  // Positive evidence from thread/start or an explicitly empty, fully hydrated resume.
  firstTurn: boolean;
}

/** UI choice is separate from the engine's immutable first-turn decision. */
export class RouterSelections {
  constructor(private readonly directory: string) {}

  private path(id: string): string {
    return join(this.directory, "selections", `${createHash("sha256").update(id).digest("hex")}.json`);
  }

  async read(id: string): Promise<RouterSelection | undefined> {
    try {
      const value = JSON.parse(await readFile(this.path(id), "utf8")) as RouterSelection;
      if (!["auto", "manual"].includes(value.mode) || typeof value.firstTurn !== "boolean" ||
          !value.profile || typeof value.profile.model !== "string" || value.profile.model === ROUTER_MODEL ||
          typeof value.profile.effort !== "string" || typeof value.profile.fast !== "boolean") {
        throw new Error("Invalid router selection");
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  async save(id: string, value: RouterSelection): Promise<void> {
    await mkdir(join(this.directory, "selections"), { recursive: true, mode: 0o700 });
    const path = this.path(id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

/** App-server model/list schema, not OpenCodex's raw ModelInfo catalog schema. */
export function routerModelEntry() {
  return {
    id: ROUTER_MODEL, model: ROUTER_MODEL, displayName: "Jev Router",
    description: "自动：首次请求选择轻量、标准或深入档位，后续固定。具体模型为手动模式。",
    hidden: false, isDefault: false, defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "由 Jev 自动选择实际推理强度" }],
    serviceTiers: [], additionalSpeedTiers: [], defaultServiceTier: null,
    inputModalities: ["text", "image"], supportsPersonality: false,
    upgrade: null, upgradeInfo: null, availabilityNux: null,
  };
}
