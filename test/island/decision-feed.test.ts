import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  decisionFeedPath,
  publishDecisionEvent,
  readDecisionEvents,
  readLatestDecisionEvent,
  readRecentDecisionEvents,
} from "../../src/island/decision-feed.js";
import { defaultConfig } from "../../src/router/core/config.js";
import type { RouteDecision } from "../../src/router/core/types.js";

function decision(routeName = "balanced"): RouteDecision {
  return {
    action: "apply",
    intent: "ask",
    intentSource: "classifier",
    intentReason: "local_embedding_classifier",
    category: "AUDIT_ANALYZE",
    complexity: "normal",
    routeName,
    profile: { model: "gpt-5.6-terra", effort: "max", fast: true },
    reason: "embedding_primary",
    sticky: false,
    promptHash: "hash",
    promptChars: 4,
    latencyMs: 1,
  };
}

async function feedConfig() {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-decision-"));
  const config = defaultConfig();
  config.logging.auditFile = join(directory, "events.jsonl");
  return config;
}

test("decision feed preserves every event and reads forward from a cursor", async () => {
  const config = await feedConfig();
  const first = await publishDecisionEvent(config, "desktop", decision("quick"), {
    threadId: "thread-a",
    triggeredAt: "2026-07-22T08:00:00.000Z",
  });
  const second = await publishDecisionEvent(config, "terminal", decision("balanced"), {
    threadId: "thread-b",
    triggeredAt: "2026-07-22T08:00:00.100Z",
  });
  const third = await publishDecisionEvent(config, "desktop", decision("deep"), {
    threadId: "thread-c",
    triggeredAt: "2026-07-22T08:00:00.200Z",
  });

  assert(first && second && third);
  assert.deepEqual(await readDecisionEvents(config, { afterId: first.id }), [second, third]);
  assert.deepEqual(await readLatestDecisionEvent(config), third);
  assert.equal(third.threadId, "thread-c");
  assert.equal(third.triggeredAt, "2026-07-22T08:00:00.200Z");
});

test("a missing cursor resynchronizes to only the newest event", async () => {
  const config = await feedConfig();
  await publishDecisionEvent(config, "desktop", decision("quick"), {
    triggeredAt: "2026-07-22T08:01:00.000Z",
  });
  const latest = await publishDecisionEvent(config, "desktop", decision("deep"), {
    triggeredAt: "2026-07-22T08:01:00.001Z",
  });
  assert(latest);
  assert.deepEqual(await readDecisionEvents(config, { afterId: "evicted" }), [latest]);
});

test("menu bar reads only the five newest user-facing router decisions", async () => {
  const config = await feedConfig();
  for (let index = 0; index < 6; index += 1) {
    await publishDecisionEvent(config, "desktop", decision("balanced"), {
      threadId: `thread-${index}`,
      triggeredAt: `2026-07-22T08:00:0${index}.000Z`,
    });
  }
  const recent = await readRecentDecisionEvents(config);
  assert.equal(recent.length, 5);
  assert.equal(recent[0]?.threadId, "thread-5");
  assert.equal(recent[4]?.threadId, "thread-1");
});

test("a late older decision cannot replace or replay after a newer trigger", async () => {
  const config = await feedConfig();
  const newer = await publishDecisionEvent(config, "desktop", decision("deep"), {
    threadId: "newer-thread",
    triggeredAt: "2026-07-22T08:02:00.200Z",
  });
  const older = await publishDecisionEvent(config, "desktop", decision("quick"), {
    threadId: "older-thread",
    triggeredAt: "2026-07-22T08:02:00.100Z",
  });
  assert(newer && older);

  assert.deepEqual(await readLatestDecisionEvent(config), newer);
  assert.deepEqual(await readDecisionEvents(config, { afterId: newer.id }), []);
});

test("decision feed ignores malformed observation files", async () => {
  const config = await feedConfig();
  const path = decisionFeedPath(config);
  assert(path);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "0000000000000-00000000-0000-0000-0000-000000000000.json"), "not-json", {
    mode: 0o600,
  });
  await writeFile(
    join(path, "0000000000001-00000000-0000-0000-0000-000000000001.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      id: "invalid-intent",
      timestamp: "2026-07-22T08:03:00.000Z",
      triggeredAt: "2026-07-22T08:03:00.000Z",
      surface: "desktop",
      intent: "surprise",
      route: "quick",
    })}\n`,
    { mode: 0o600 },
  );
  assert.deepEqual(await readDecisionEvents(config), []);
});
