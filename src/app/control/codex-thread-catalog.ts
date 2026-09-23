import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { backendEnvironment } from "../../router/adapters/codex-process.js";
import { VERSION } from "../../version.js";

export interface CodexThreadSummary {
  id: string;
  name?: string;
  preview?: string;
  cwd?: string;
  source?: string;
  createdAt?: number;
  updatedAt?: number;
  recencyAt?: number;
}

export interface CodexThreadCatalog {
  read(threadId: string, executable: string): Promise<CodexThreadSummary | undefined>;
  close(): Promise<void>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface CachedThread {
  expiresAt: number;
  value: CodexThreadSummary | undefined;
}

const MAX_CACHED_THREADS = 256;

function compactText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().replace(/\s+/g, " ").slice(0, 120)
    : undefined;
}

function sourceLabel(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  if ("custom" in value && typeof (value as { custom?: unknown }).custom === "string") {
    return `custom:${(value as { custom: string }).custom}`;
  }
  if ("subAgent" in value) return "subAgent";
  return undefined;
}

function parseThread(value: unknown): CodexThreadSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const thread = value as Record<string, unknown>;
  if (typeof thread.id !== "string") return undefined;
  const name = compactText(thread.name);
  const preview = compactText(thread.preview);
  const source = sourceLabel(thread.source);
  return {
    id: thread.id,
    ...(name ? { name } : {}),
    ...(preview ? { preview } : {}),
    ...(typeof thread.cwd === "string" ? { cwd: thread.cwd } : {}),
    ...(source ? { source } : {}),
    ...(typeof thread.createdAt === "number" ? { createdAt: thread.createdAt } : {}),
    ...(typeof thread.updatedAt === "number" ? { updatedAt: thread.updatedAt } : {}),
    ...(typeof thread.recencyAt === "number" ? { recencyAt: thread.recencyAt } : {}),
  };
}

/**
 * Resolves user-facing thread metadata through Codex's stable app-server
 * interface. The child is metadata-only and never starts turns.
 */
export class LocalCodexThreadCatalog implements CodexThreadCatalog {
  private child: ChildProcessWithoutNullStreams | undefined;
  private lines: ReadlineInterface | undefined;
  private executable: string | undefined;
  private startTask: Promise<void> | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly cache = new Map<string, CachedThread>();

  async modelList(executable: string, cursor?: string): Promise<unknown> {
    await this.ensureStarted(executable);
    return this.requestRaw("model/list", { includeHidden: false, ...(cursor ? { cursor } : {}) }, 5_000);
  }

  async read(threadId: string, executable: string): Promise<CodexThreadSummary | undefined> {
    if (!threadId || threadId === "cli-exec") return undefined;
    const cacheKey = `${executable}\u0000${threadId}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    try {
      await this.ensureStarted(executable);
      const result = (await this.request("thread/read", {
        threadId,
        includeTurns: false,
      })) as { thread?: unknown };
      const value = parseThread(result?.thread);
      this.setCache(cacheKey, value, 5_000);
      return value;
    } catch {
      this.setCache(cacheKey, undefined, 1_000);
      return undefined;
    }
  }

  private async ensureStarted(executable: string): Promise<void> {
    if (
      this.child &&
      this.child.exitCode === null &&
      this.executable === executable &&
      !this.child.killed
    ) {
      return;
    }
    if (this.startTask) {
      await this.startTask;
      return this.ensureStarted(executable);
    }
    this.startTask = this.start(executable).finally(() => {
      this.startTask = undefined;
    });
    await this.startTask;
  }

  private async start(executable: string): Promise<void> {
    await this.close();
    const child = spawn(executable, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: backendEnvironment(),
    });
    this.child = child;
    this.executable = executable;
    child.stderr.resume();
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.handleLine(line));
    child.once("error", (error) => this.failChild(child, error));
    child.once("exit", () =>
      this.failChild(child, new Error("Codex metadata app-server exited")),
    );

    try {
      await this.requestRaw(
        "initialize",
        {
          clientInfo: {
            name: "agent_dock",
            title: "Agent Dock",
            version: VERSION,
          },
        },
        1_500,
      );
      child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    } catch (error) {
      if (this.child === child) await this.close();
      throw error;
    }
  }

  private handleLine(line: string): void {
    try {
      const message = JSON.parse(line) as {
        id?: string | number | null;
        result?: unknown;
        error?: { message?: unknown };
      };
      if (message.id === undefined || message.id === null) return;
      const key = String(message.id);
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new Error(
            typeof message.error.message === "string"
              ? message.error.message
              : "Codex metadata request failed",
          ),
        );
      } else {
        pending.resolve(message.result);
      }
    } catch {
      // Notifications and malformed metadata are observational only.
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return this.requestRaw(method, params, 1_000);
  }

  private requestRaw(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin.writable) return Promise.reject(new Error("Codex metadata app-server unavailable"));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Codex metadata request timed out: ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(String(id), { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  private failChild(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.rejectPending(error);
    const lines = this.lines;
    this.lines = undefined;
    this.child = undefined;
    this.executable = undefined;
    lines?.close();
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.executable = undefined;
    const lines = this.lines;
    this.lines = undefined;
    lines?.close();
    this.rejectPending(new Error("Codex metadata app-server closed"));
    if (!child || child.killed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 300);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private setCache(
    key: string,
    value: CodexThreadSummary | undefined,
    ttlMs: number,
  ): void {
    this.cache.delete(key);
    this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.cache.size > MAX_CACHED_THREADS) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
