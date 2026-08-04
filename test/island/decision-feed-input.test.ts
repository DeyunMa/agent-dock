import assert from "node:assert/strict";
import test from "node:test";
import {
  DecisionFeedInput,
  decisionEventToIslandEvent,
  type IslandEventSink,
} from "../../src/island/inputs/decision-feed-input.js";
import type { IslandEvent, IslandSnapshot } from "../../src/island/core/types.js";
import type { DecisionEvent } from "../../src/island/decision-feed.js";

function decisionEvent(id: string, threadId?: string): DecisionEvent {
  return {
    schemaVersion: 2,
    id,
    timestamp: "2026-08-04T00:00:01.000Z",
    triggeredAt: "2026-08-04T00:00:00.000Z",
    surface: "desktop",
    ...(threadId ? { threadId } : {}),
    intent: "do",
    route: "balanced",
  };
}

function snapshot(): IslandSnapshot {
  return {
    schemaVersion: 1,
    revision: 0,
    state: "idle",
    changedAt: "2026-08-04T00:00:00.000Z",
  };
}

test("decision feed conversion keeps only display-safe fields and hashes a thread id", () => {
  const event = decisionEvent("event-1", "thread-secret");
  const converted = decisionEventToIslandEvent(event);

  assert.deepEqual(converted, {
    schemaVersion: 1,
    id: "router:event-1",
    occurredAt: "2026-08-04T00:00:00.000Z",
    source: "router",
    kind: "route_selected",
    sessionIdHash: converted.sessionIdHash,
    surface: "desktop",
    intent: "do",
    route: "balanced",
  });
  assert.notEqual(converted.sessionIdHash, "thread-secret");
  assert.equal(converted.sessionIdHash?.length, 22);
});

test("input adapter moves its cursor forward and remains fail-open on reader errors", async () => {
  const accepted: IslandEvent[] = [];
  const reads: Array<{ afterId?: string }> = [];
  const sink: IslandEventSink = {
    accept(event) {
      accepted.push(event);
      return snapshot();
    },
    snapshot,
  };
  const first = decisionEvent("first", "thread-a");
  const second = decisionEvent("second", "thread-b");
  let calls = 0;
  const input = new DecisionFeedInput(sink, async (options) => {
    reads.push(options);
    calls += 1;
    if (calls === 1) return [first];
    if (calls === 2) return [second];
    throw new Error("feed unavailable");
  });

  await input.poll();
  await input.poll();
  const afterError = await input.poll();

  assert.deepEqual(reads, [{}, { afterId: "first" }, { afterId: "second" }]);
  assert.deepEqual(
    accepted.map((event) => event.id),
    ["router:first", "router:second"],
  );
  assert.equal(afterError.state, "idle");
});
