import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GatewayModel } from "../../gateway/gateway.js";
import { ROUTER_MODEL } from "./router-selection.js";

export interface CodexModelSnapshot {
  source: "desktop" | "codex" | "unavailable";
  models: GatewayModel[];
  updatedAt?: string;
  message: string;
}

/** Only persist public model metadata, never the surrounding RPC response. */
export function parseCodexModels(result: unknown): GatewayModel[] | undefined {
  const data = (result as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return undefined;
  return data.flatMap((row: unknown) => {
    if (!row || typeof row !== "object") return [];
    const model = row as Record<string, unknown>;
    const id = typeof model.model === "string" ? model.model : model.id;
    if (typeof id !== "string" || !id || id === ROUTER_MODEL || model.hidden === true) return [];
    const strings = (items: unknown, key: string): string[] => Array.isArray(items)
      ? items.flatMap(item => {
        const value = typeof item === "string" ? item : item?.[key];
        return typeof value === "string" ? [value] : [];
      }) : [];
    return [{
      id,
      displayName: typeof model.displayName === "string" ? model.displayName : id,
      provider: id.includes("/") ? id.split("/")[0]! : "openai",
      requiresGateway: id.includes("/"),
      reasoningEfforts: strings(model.supportedReasoningEfforts, "reasoningEffort"),
      serviceTiers: strings(model.serviceTiers, "id"),
      capabilitiesKnown: true,
      ...(typeof model.defaultReasoningEffort === "string"
        ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
    }];
  });
}

/** Collect whole paginated lists. A failed/incomplete refresh keeps the previous snapshot. */
export class CodexModelObservation {
  private generation = 0;
  private requests = new Map<string, { generation: number; cursor?: string }>();
  private cursors = new Map<string, number>();
  private models = new Map<string, GatewayModel>();

  constructor(private readonly publish: (models: GatewayModel[]) => Promise<void>) {}

  request(id: string, params: Record<string, unknown> | undefined): void {
    // Hidden-inclusive lists are not the user's picker.
    if (params?.includeHidden === true) return;
    const cursor = typeof params?.cursor === "string" ? params.cursor : undefined;
    if (!cursor) {
      this.generation++;
      this.models.clear();
      this.cursors.clear();
      this.requests.clear();
    }
    const generation = cursor ? this.cursors.get(cursor) : this.generation;
    if (generation === undefined) return;
    this.requests.set(id, { generation, ...(cursor ? { cursor } : {}) });
  }

  async response(id: string, result: unknown): Promise<void> {
    const request = this.requests.get(id);
    this.requests.delete(id);
    if (!request || request.generation !== this.generation) return;
    const models = parseCodexModels(result);
    if (!models) return;
    for (const model of models) this.models.set(model.id, model);
    const cursor = (result as { nextCursor?: unknown }).nextCursor;
    if (typeof cursor === "string" && cursor) {
      this.cursors.set(cursor, this.generation);
      return;
    }
    await this.publish([...this.models.values()]);
  }
}

export async function publishDesktopModels(directory: string, models: GatewayModel[]): Promise<void> {
  const root = join(directory, "model-catalogs");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${process.pid}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ pid: process.pid, updatedAt: new Date().toISOString(), models }), { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function readDesktopModels(directory: string): Promise<CodexModelSnapshot | undefined> {
  const root = join(directory, "model-catalogs");
  const snapshots: CodexModelSnapshot[] = [];
  for (const file of await readdir(root).catch(() => [])) {
    if (!/^\d+\.json$/.test(file)) continue;
    try {
      const value = JSON.parse(await readFile(join(root, file), "utf8"));
      if (!Number.isInteger(value.pid) || value.pid <= 1 || file !== `${value.pid}.json`) continue;
      try { process.kill(value.pid, 0); } catch {
        await unlink(join(root, file)).catch(() => undefined);
        continue;
      }
      if (!Number.isFinite(Date.parse(value.updatedAt)) || !Array.isArray(value.models)) continue;
      if (!value.models.every((m: GatewayModel) => m && typeof m.id === "string" && m.id !== ROUTER_MODEL &&
        typeof m.displayName === "string" && Array.isArray(m.reasoningEfforts) && Array.isArray(m.serviceTiers))) continue;
      snapshots.push({ source: "desktop", models: value.models, updatedAt: value.updatedAt,
        message: "已同步 Codex 桌面返回的模型列表。" });
    } catch { /* Partial/corrupt observations cannot affect routing. */ }
  }
  return snapshots.sort((a, b) => Date.parse(b.updatedAt!) - Date.parse(a.updatedAt!))[0];
}
