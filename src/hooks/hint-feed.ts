import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { RouterConfig } from "../router/core/types.js";

const MAX_HINT_EVENTS = 5;

export interface HookHintEvent {
  schemaVersion: 1;
  id: string;
  timestamp: string;
  threadId?: string;
  projectName?: string;
  candidateNames: string[];
  hasAlternatives: boolean;
  hasComplementary: boolean;
  unresolvedChoice: boolean;
  contextProduced: boolean;
}

export function hintFeedPath(config: RouterConfig): string | undefined {
  if (!config.logging.auditFile) return undefined;
  return join(dirname(config.logging.auditFile), "hook-hints");
}

function eventFiles(path: string): Promise<string[]> {
  return readdir(path).then(
    (names) => names.filter((name) => /^\d{13}-[0-9a-f-]+\.json$/i.test(name)).sort(),
    () => [],
  );
}

function validEvent(value: unknown): value is HookHintEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<HookHintEvent>;
  return event.schemaVersion === 1
    && typeof event.id === "string"
    && typeof event.timestamp === "string"
    && Number.isFinite(Date.parse(event.timestamp))
    && (event.threadId === undefined || typeof event.threadId === "string")
    && (event.projectName === undefined || typeof event.projectName === "string")
    && Array.isArray(event.candidateNames)
    && event.candidateNames.length <= 4
    && event.candidateNames.every((name) => typeof name === "string")
    && typeof event.hasAlternatives === "boolean"
    && typeof event.hasComplementary === "boolean"
    && typeof event.unresolvedChoice === "boolean"
    && typeof event.contextProduced === "boolean";
}

export async function publishHookHint(
  config: RouterConfig,
  input: { cwd: string; sessionId?: string },
  context: string | undefined,
): Promise<void> {
  const path = hintFeedPath(config);
  if (!path) return;
  const timestamp = new Date().toISOString();
  const event: HookHintEvent = {
    schemaVersion: 1,
    id: randomUUID(),
    timestamp,
    ...(input.sessionId ? { threadId: input.sessionId } : {}),
    ...(basename(input.cwd) ? { projectName: basename(input.cwd).slice(0, 80) } : {}),
    candidateNames: context
      ? [...context.matchAll(/^- ([\p{L}\p{N}._:-]+): /gmu)].map((match) => match[1]!).slice(0, 4)
      : [],
    hasAlternatives: context?.includes("可能互斥：") ?? false,
    hasComplementary: context?.includes("可互补：") ?? false,
    unresolvedChoice: context?.includes("用户留有会影响结果的选择") ?? false,
    contextProduced: Boolean(context),
  };
  const name = `${String(Date.now()).padStart(13, "0")}-${event.id}.json`;
  const target = join(path, name);
  const temporary = `${target}.tmp-${process.pid}`;
  await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, `${JSON.stringify(event)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  const files = await eventFiles(path);
  await Promise.all(files.slice(0, Math.max(0, files.length - MAX_HINT_EVENTS)).map(
    (stale) => unlink(join(path, stale)).catch(() => undefined),
  ));
}

export async function readRecentHookHints(config: RouterConfig): Promise<HookHintEvent[]> {
  const path = hintFeedPath(config);
  if (!path) return [];
  const files = (await eventFiles(path)).slice(-MAX_HINT_EVENTS).reverse();
  const events = await Promise.all(files.map(async (name) => {
    try {
      const value = JSON.parse(await readFile(join(path, name), "utf8")) as unknown;
      return validEvent(value) ? value : undefined;
    } catch { return undefined; }
  }));
  return events.filter((event): event is HookHintEvent => event !== undefined);
}
