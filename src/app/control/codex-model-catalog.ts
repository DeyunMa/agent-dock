import type { RouterConfig } from "../../router/core/types.js";
import { parseCodexModels, readDesktopModels, type CodexModelSnapshot } from "../../router/adapters/codex-model-catalog.js";
import { LocalCodexThreadCatalog } from "./codex-thread-catalog.js";

export interface CodexModelCatalog {
  read(config: RouterConfig, refresh?: boolean): Promise<CodexModelSnapshot>;
}

/** Desktop observations win. A metadata-only child supplies a clearly labelled preview otherwise. */
export class LocalCodexModelCatalog implements CodexModelCatalog {
  private cached?: { key: string; expiresAt: number; snapshot: CodexModelSnapshot };
  private flight: Promise<CodexModelSnapshot> | undefined;

  async read(config: RouterConfig, refresh = false): Promise<CodexModelSnapshot> {
    const observed = await readDesktopModels(config.routing.stateDirectory);
    if (observed) return observed;
    const key = config.codex.desktopBinary;
    if (!refresh && this.cached?.key === key && this.cached.expiresAt > Date.now()) return this.cached.snapshot;
    if (this.flight) { await this.flight; return this.read(config, false); }
    this.flight = this.probe(key).then(snapshot => {
      this.cached = { key, expiresAt: Date.now() + 30_000, snapshot };
      return snapshot;
    }).finally(() => { this.flight = undefined; });
    return this.flight;
  }

  private async probe(executable: string): Promise<CodexModelSnapshot> {
    const client = new LocalCodexThreadCatalog();
    try {
      const models = new Map<string, NonNullable<ReturnType<typeof parseCodexModels>>[number]>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      const deadline = Date.now() + 5_000;
      for (let page = 0; page < 100 && Date.now() < deadline; page++) {
        const result = await client.modelList(executable, cursor) as { nextCursor?: unknown };
        const entries = parseCodexModels(result);
        if (!entries) throw new Error("Invalid model/list");
        for (const model of entries) models.set(model.id, model);
        if (result.nextCursor == null || result.nextCursor === "") {
          return { source: "codex", models: [...models.values()], updatedAt: new Date().toISOString(),
            message: "已读取 Codex 当前配置的模型列表；已打开的桌面窗口可能需要重新加载。" };
        }
        if (typeof result.nextCursor !== "string" || cursors.has(result.nextCursor)) throw new Error("Invalid cursor");
        cursor = result.nextCursor;
        cursors.add(cursor);
      }
      throw new Error("Too many model pages");
    } catch {
      return { source: "unavailable", models: [], message: "暂未取得 Codex 模型列表；已有档位保持不变。" };
    } finally {
      await client.close();
    }
  }
}
