import { createHash } from "node:crypto";
import { appendFile, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { RouteDecision, RouterConfig, TurnStartParams } from "./types.js";

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
): Promise<void> {
  if (!config.logging.auditFile) return;
  const event: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    schema_version: 2,
    action: decision.action,
    semantic_category: decision.category,
    complexity: decision.complexity,
    route: decision.routeName,
    fast: decision.profile?.fast,
    reason: decision.reason,
    total_latency_ms: decision.latencyMs,
    prompt_hash: decision.promptHash,
    thread_id: params.threadId,
  };

  if (decision.aiStatus) {
    event.classifier_model = config.ollama.model;
    event.ai_status = decision.aiStatus;
    event.ai_latency_ms = decision.aiLatencyMs;
    event.ai_category = decision.ai?.category;
    event.ai_complexity = decision.ai?.complexity;
    event.ai_confidence = decision.ai?.confidence;
  }

  if (decision.action === "inherit" || decision.rule.category === "PASS_CONTEXT") {
    event.rule_reason = decision.rule.reason;
    event.rule_candidate = decision.rule.candidate;
    event.rule_margin = decision.rule.margin;
    event.rule_confidence = decision.rule.confidence;
  }

  await mkdir(dirname(config.logging.auditFile), { recursive: true, mode: 0o700 });
  await rotateAuditIfNeeded(config);
  await appendFile(config.logging.auditFile, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
