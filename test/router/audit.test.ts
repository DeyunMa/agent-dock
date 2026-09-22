import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendAudit,
  promptHash,
  readLatestAuditDecision,
} from "../../src/router/core/audit.js";
import { defaultConfig } from "../../src/router/core/config.js";
import type { RouteDecision } from "../../src/router/core/types.js";

function decision(overrides: Partial<RouteDecision> = {}): RouteDecision {
  return {
    action: "apply",
    intent: "ask",
    intentSource: "classifier",
    intentReason: "local_embedding_classifier",
    category: "AUDIT_ANALYZE",
    complexity: "simple",
    routeName: "balanced",
    profile: { model: "gpt-5.6-terra", effort: "max", fast: false },
    reason: "embedding_primary",
    ai: {
      routeName: "balanced",
      category: "AUDIT_ANALYZE",
      complexity: "simple",
      intent: "ask",
      confidence: 0.95,
      reason: "local_embedding_classifier",
      latencyMs: 12,
    },
    aiStatus: "ok",
    aiLatencyMs: 12,
    sticky: false,
    promptHash: promptHash("检查当前状态"),
    promptChars: 6,
    latencyMs: 14,
    ...overrides,
  };
}

async function logConfig(maxFileBytes = 30 * 1024 * 1024) {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-audit-"));
  const config = defaultConfig();
  config.logging.auditFile = join(directory, "events.jsonl");
  config.logging.maxFileBytes = maxFileBytes;
  config.logging.maxBackups = 1;
  return config;
}

test("audit stores only the Router decision delta", async () => {
  const config = await logConfig();
  const failure = decision({
    action: "inherit",
    category: "PASS_CONTEXT",
    reason: "unclassified_fail_open",
    aiStatus: "timeout",
    aiLatencyMs: 3000,
  });
  delete failure.ai;

  await appendAudit(
    config,
    { threadId: "thread-1", cwd: "/private/project" },
    failure,
    { triggeredAt: "2026-07-22T08:00:00.000Z", surface: "desktop" },
  );
  const event = JSON.parse(await readFile(config.logging.auditFile, "utf8")) as Record<string, unknown>;

  assert.equal(event.schema_version, 3);
  assert.equal(event.triggered_at, "2026-07-22T08:00:00.000Z");
  assert.equal(event.surface, "desktop");
  assert.equal(event.thread_id, "thread-1");
  assert.equal(event.action, "inherit");
  assert.equal(event.intent, "ask");
  assert.equal(event.intent_source, "classifier");
  assert.equal(event.intent_reason, "local_embedding_classifier");
  assert.equal(event.route, "native");
  assert.equal(event.ai_status, "timeout");
  assert.equal(event.ai_latency_ms, 3000);
  assert.equal(event.classifier_model, "jev-latest");
  assert.equal(event.classifier_kind, "jev_api");
  assert.equal("semantic_category" in event, false);
  assert.equal("complexity" in event, false);
  assert.equal("ai_category" in event, false);
  assert.equal("ai_complexity" in event, false);
  assert.equal("model" in event, false);
  assert.equal("effort" in event, false);
  assert.equal("cwd" in event, false);
  assert.equal("prompt" in event, false);
  assert.equal("prompt_chars" in event, false);
  assert.equal("sticky" in event, false);
});

test("hard-guard decisions keep the v3 audit shape without classifier fields", async () => {
  const config = await logConfig();
  const fastPath = decision({
    reason: "explicit_suppression",
    latencyMs: 4,
  });
  delete fastPath.ai;
  delete fastPath.aiStatus;
  delete fastPath.aiLatencyMs;

  await appendAudit(config, { threadId: "hard-guard" }, fastPath);
  const event = JSON.parse(
    await readFile(config.logging.auditFile, "utf8"),
  ) as Record<string, unknown>;

  assert.equal(event.schema_version, 3);
  assert.equal(event.reason, "explicit_suppression");
  assert.equal(event.total_latency_ms, 4);
  assert.equal("classifier_model" in event, false);
  assert.equal("ai_status" in event, false);
  assert.equal("ai_latency_ms" in event, false);
});

test("latest audit observation fails open when its path is unreadable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-audit-directory-"));
  assert.equal(await readLatestAuditDecision(directory), undefined);
});

test("latest audit decision exposes only the visible intent and route", async () => {
  const config = await logConfig();
  await appendAudit(config, { threadId: "thread-3" }, decision(), {
    triggeredAt: "2026-07-22T08:01:00.000Z",
    surface: "terminal",
  });

  const latest = await readLatestAuditDecision(config.logging.auditFile);
  assert(latest);
  assert.equal(latest.triggeredAt, "2026-07-22T08:01:00.000Z");
  assert.equal(latest.surface, "terminal");
  assert.equal(latest.threadId, "thread-3");
  assert.equal(latest.intent, "ask");
  assert.equal(latest.route, "balanced");
  assert(Number.isFinite(Date.parse(latest.timestamp)));
});

test("audit keeps one previous file when the active file reaches its limit", async () => {
  const config = await logConfig(1);
  const first = decision({ promptHash: promptHash("first") });
  const second = decision({ promptHash: promptHash("second") });

  await appendAudit(config, { threadId: "thread-2" }, first);
  await appendAudit(config, { threadId: "thread-2" }, second);

  const current = JSON.parse(await readFile(config.logging.auditFile, "utf8")) as Record<string, unknown>;
  const previous = JSON.parse(await readFile(`${config.logging.auditFile}.1`, "utf8")) as Record<string, unknown>;
  assert.equal(current.prompt_hash, promptHash("second"));
  assert.equal(previous.prompt_hash, promptHash("first"));
});
