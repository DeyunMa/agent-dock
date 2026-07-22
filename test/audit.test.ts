import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendAudit, promptHash } from "../src/routing/audit.js";
import { defaultConfig } from "../src/routing/config.js";
import type { RouteDecision } from "../src/routing/types.js";

function decision(overrides: Partial<RouteDecision> = {}): RouteDecision {
  return {
    action: "apply",
    category: "AUDIT_ANALYZE",
    complexity: "simple",
    routeName: "balanced",
    profile: { model: "gpt-5.6-terra", effort: "max", fast: false },
    reason: "rule_plus_ai",
    rule: {
      category: "AUDIT_ANALYZE",
      confidence: 0.9,
      reason: "classified",
      scores: { AUDIT_ANALYZE: 5 },
      margin: 5,
      suppressed: false,
      passContext: false,
    },
    ai: {
      category: "AUDIT_ANALYZE",
      complexity: "simple",
      confidence: 0.95,
      reason: "local_qwen_classifier",
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
  const directory = await mkdtemp(join(tmpdir(), "codex-router-audit-"));
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
    rule: {
      category: "PASS_CONTEXT",
      candidate: "OPERATE_VERIFY",
      confidence: 0.75,
      reason: "below_threshold",
      scores: { OPERATE_VERIFY: 4, AUDIT_ANALYZE: 3 },
      margin: 1,
      suppressed: false,
      passContext: false,
    },
  });
  delete failure.routeName;
  delete failure.profile;
  delete failure.ai;

  await appendAudit(config, { threadId: "thread-1", cwd: "/private/project" }, failure);
  const event = JSON.parse(await readFile(config.logging.auditFile, "utf8")) as Record<string, unknown>;

  assert.equal(event.schema_version, 2);
  assert.equal(event.thread_id, "thread-1");
  assert.equal(event.action, "inherit");
  assert.equal(event.ai_status, "timeout");
  assert.equal(event.ai_latency_ms, 3000);
  assert.equal(event.rule_candidate, "OPERATE_VERIFY");
  assert.equal(event.rule_margin, 1);
  assert.equal(event.classifier_model, "qwen3.5:2b-q4_K_M");
  assert.equal("model" in event, false);
  assert.equal("effort" in event, false);
  assert.equal("cwd" in event, false);
  assert.equal("prompt" in event, false);
  assert.equal("prompt_chars" in event, false);
  assert.equal("sticky" in event, false);
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
