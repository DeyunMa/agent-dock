import { createHash } from "node:crypto";
import { appendFile, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { visibleDecision } from "./presentation.js";
import {
  EXECUTION_INTENTS,
  type ExecutionIntent,
  type RouteDecision,
  type RouterConfig,
  type TurnStartParams,
} from "./types.js";

export interface LatestAuditDecision {
  timestamp: string;
  triggeredAt: string;
  surface?: "desktop" | "terminal" | "management";
  intent: ExecutionIntent;
  route: string;
  threadId?: string;
}

export interface AuditContext {
  triggeredAt?: string;
  surface?: "desktop" | "terminal" | "management";
}

export function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isNotFound(error)) return 0;
    throw error;
  }
}

async function moveIfPresent(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function rotateAuditIfNeeded(config: RouterConfig): Promise<void> {
  const { auditFile, maxBackups, maxFileBytes } = config.logging;
  if ((await fileSize(auditFile)) < maxFileBytes) return;

  const lockFile = `${auditFile}.rotate.lock`;
  let lock;
  try {
    lock = await open(lockFile, "wx", 0o600);
  } catch (error) {
    // Another Desktop/CLI Router process is already rotating. Its result is safe to append to.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }

  try {
    if ((await fileSize(auditFile)) < maxFileBytes) return;
    if (maxBackups === 0) {
      await removeIfPresent(auditFile);
      return;
    }
    for (let index = maxBackups; index >= 1; index -= 1) {
      const source = index === 1 ? auditFile : `${auditFile}.${index - 1}`;
      const destination = `${auditFile}.${index}`;
      await removeIfPresent(destination);
      await moveIfPresent(source, destination);
    }
  } finally {
    await lock.close();
    await removeIfPresent(lockFile);
  }
}

export async function appendAudit(
  config: RouterConfig,
  params: TurnStartParams,
  decision: RouteDecision,
  context: AuditContext = {},
): Promise<void> {
  if (!config.logging.auditFile) return;
  const visible = visibleDecision(decision);
  const timestamp = new Date().toISOString();
  const event: Record<string, unknown> = {
    timestamp,
    triggered_at: context.triggeredAt ?? timestamp,
    surface: context.surface,
    schema_version: 3,
    action: decision.action,
    intent: visible.intent,
    intent_source: decision.intentSource,
    intent_reason: decision.intentReason,
    route: visible.route,
    fast: decision.profile?.fast,
    reason: decision.reason,
    total_latency_ms: decision.latencyMs,
    prompt_hash: decision.promptHash,
    thread_id: params.threadId,
  };

  if (decision.aiStatus) {
    event.classifier_model = config.classifier.model;
    event.classifier_kind = "jev_api";
    event.ai_status = decision.aiStatus;
    event.ai_latency_ms = decision.aiLatencyMs;
  }

  await mkdir(dirname(config.logging.auditFile), { recursive: true, mode: 0o700 });
  await rotateAuditIfNeeded(config);
  await appendFile(config.logging.auditFile, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function readLatestAuditDecision(
  auditFile: string,
): Promise<LatestAuditDecision | undefined> {
  let handle;
  try {
    handle = await open(auditFile, "r");
    const size = (await handle.stat()).size;
    if (size === 0) return undefined;
    const length = Math.min(size, 16_384);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").trimEnd().split("\n").reverse();
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as {
          timestamp?: unknown;
          triggered_at?: unknown;
          surface?: unknown;
          intent?: unknown;
          route?: unknown;
          thread_id?: unknown;
        };
        if (
          typeof event.timestamp === "string" &&
          Number.isFinite(Date.parse(event.timestamp)) &&
          (event.triggered_at === undefined ||
            (typeof event.triggered_at === "string" &&
              Number.isFinite(Date.parse(event.triggered_at)))) &&
          typeof event.intent === "string" &&
          EXECUTION_INTENTS.includes(event.intent as ExecutionIntent) &&
          typeof event.route === "string" &&
          event.route.length > 0
        ) {
          return {
            timestamp: event.timestamp,
            triggeredAt:
              typeof event.triggered_at === "string"
                ? event.triggered_at
                : event.timestamp,
            ...(event.surface === "desktop" ||
            event.surface === "terminal" ||
            event.surface === "management"
              ? { surface: event.surface }
              : {}),
            intent: event.intent as ExecutionIntent,
            route: event.route,
            ...(typeof event.thread_id === "string" ? { threadId: event.thread_id } : {}),
          };
        }
      } catch {
        // A partially written or legacy line is ignored; scan the prior event.
      }
    }
    return undefined;
  } catch {
    // Latest-decision display is optional observation data. It must never make
    // the Router controls unavailable when the audit path cannot be read.
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
