import assert from "node:assert/strict";
import test from "node:test";
import { IslandEngine } from "../../src/island/core/engine.js";
import type { IslandEvent } from "../../src/island/core/types.js";

class FakeClock {
  constructor(private value = 0) {}

  now = (): number => this.value;

  advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

function event(
  id: string,
  kind: IslandEvent["kind"],
  occurredAt: number,
  overrides: Partial<IslandEvent> = {},
): IslandEvent {
  return {
    schemaVersion: 1,
    id,
    occurredAt: new Date(occurredAt).toISOString(),
    source: "router",
    kind,
    ...overrides,
  };
}

function engine(clock: FakeClock, schedule: Partial<{
  routingHoldMs: number;
  workingMinimumMs: number;
  workingIdleMs: number;
  settlingHoldMs: number;
}> = {}): IslandEngine {
  return new IslandEngine({ clock, schedule });
}

test("routing is transient when no work follows", () => {
  const clock = new FakeClock(1_000);
  const island = engine(clock, { routingHoldMs: 1_000 });

  assert.equal(
    island.accept(event("route", "route_selected", 1_000, { route: "balanced" })).state,
    "routing",
  );
  clock.advance(999);
  assert.equal(island.snapshot().state, "routing");
  clock.advance(1);
  assert.equal(island.snapshot().state, "idle");
});

test("working has a minimum stay before turn completion can settle it", () => {
  const clock = new FakeClock(2_000);
  const island = engine(clock, {
    workingMinimumMs: 1_500,
    workingIdleMs: 10_000,
    settlingHoldMs: 1_000,
  });

  assert.equal(island.accept(event("work", "work_started", 2_000)).state, "working");
  clock.advance(200);
  assert.equal(island.accept(event("stop", "turn_stopped", 2_200)).state, "working");
  clock.advance(1_300);
  assert.equal(island.snapshot().state, "settling");
  clock.advance(1_000);
  assert.equal(island.snapshot().state, "idle");
});

test("approval stays visible until work actually resumes", () => {
  const clock = new FakeClock(3_000);
  const island = engine(clock);

  island.accept(event("work", "work_started", 3_000));
  assert.equal(island.accept(event("approval", "approval_needed", 3_001)).state, "awaiting_approval");
  assert.equal(
    island.accept(event("route", "route_selected", 3_002, { route: "quick" })).state,
    "awaiting_approval",
  );
  assert.equal(island.accept(event("resume", "work_progressed", 3_003)).state, "working");
});

test("coalesced work events extend liveness without replaying a state revision", () => {
  const clock = new FakeClock(4_000);
  const island = engine(clock, { workingIdleMs: 1_000 });
  const first = island.accept(event("work-1", "work_progressed", 4_000));
  clock.advance(100);
  const duplicate = island.accept(event("work-2", "work_progressed", 4_001));

  assert.equal(duplicate.state, "working");
  assert.equal(duplicate.revision, first.revision);
  clock.advance(900);
  assert.equal(island.snapshot().state, "working");
  clock.advance(100);
  assert.equal(island.snapshot().state, "idle");
});

test("older observations cannot replace the latest visible state", () => {
  const clock = new FakeClock(5_000);
  const island = engine(clock);

  island.accept(event("new", "work_started", 5_100));
  clock.advance(1);
  assert.equal(
    island.accept(event("late", "route_selected", 5_000, { route: "quick" })).state,
    "working",
  );
});
