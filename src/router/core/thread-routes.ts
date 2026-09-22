import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RouteProfile } from "./types.js";

export interface ThreadRoute {
  status: "pending" | "done";
  routeName?: string;
  profile?: RouteProfile;
}

/** One file per task, no prompts or credentials. Exclusive claim prevents duplicate API calls across processes. */
export class ThreadRoutes {
  constructor(private readonly directory: string) {}
  private path(id: string) { return join(this.directory, `${createHash("sha256").update(id).digest("hex")}.json`); }
  async read(id: string): Promise<ThreadRoute | undefined> {
    try {
      const record = JSON.parse(await readFile(this.path(id), "utf8")) as ThreadRoute;
      if (record.status !== "pending" && record.status !== "done") throw new Error("Invalid thread route");
      if (record.profile && (typeof record.profile.model !== "string" || typeof record.profile.effort !== "string" || typeof record.profile.fast !== "boolean")) throw new Error("Invalid thread profile");
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
  async claim(id: string): Promise<boolean> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path(id)}.${randomUUID()}.tmp`;
    // Link a fully written inode atomically: peers never observe an empty claim.
    await writeFile(temporary, JSON.stringify({ status: "pending" }), { flag: "wx", mode: 0o600 });
    try { await link(temporary, this.path(id)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    finally { await unlink(temporary).catch(() => undefined); }
  }
  async save(id: string, record: ThreadRoute): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(record), { mode: 0o600 }); await rename(temporary, path); }
    finally { await unlink(temporary).catch(() => undefined); }
  }
  async reset(id: string): Promise<void> { await unlink(this.path(id)).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
  async wait(id: string, timeoutMs: number): Promise<ThreadRoute | undefined> {
    const end = Date.now() + timeoutMs;
    let record = await this.read(id);
    while (record?.status === "pending" && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      record = await this.read(id);
    }
    return record;
  }
}
