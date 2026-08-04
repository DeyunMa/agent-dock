import { reduceIslandEvent } from "./reducer.js";
import {
  DEFAULT_ISLAND_SCHEDULE,
  IslandStateScheduler,
  type IslandScheduleOptions,
} from "./scheduler.js";
import {
  ISLAND_EVENT_KINDS,
  ISLAND_EVENT_SOURCES,
  ISLAND_SURFACES,
  ISLAND_TOOL_CLASSES,
  type IslandEvent,
  type IslandSnapshot,
} from "./types.js";
import { EXECUTION_INTENTS } from "../../router/core/types.js";

export interface IslandClock {
  now(): number;
}

export interface IslandEngineOptions {
  clock?: IslandClock;
  dedupeMs?: number;
  maxRememberedEvents?: number;
  schedule?: Partial<IslandScheduleOptions>;
}

const SYSTEM_CLOCK: IslandClock = { now: () => Date.now() };
const DEFAULT_DEDUPE_MS = 1_500;
const DEFAULT_MAX_REMEMBERED_EVENTS = 512;

function includes<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value as T[number]);
}

function isIslandEvent(event: IslandEvent): boolean {
  return (
    event.schemaVersion === 1 &&
    typeof event.id === "string" &&
    event.id.length > 0 &&
    typeof event.occurredAt === "string" &&
    Number.isFinite(Date.parse(event.occurredAt)) &&
    includes(ISLAND_EVENT_SOURCES, event.source) &&
    includes(ISLAND_EVENT_KINDS, event.kind) &&
    (event.sessionIdHash === undefined || typeof event.sessionIdHash === "string") &&
    (event.turnIdHash === undefined || typeof event.turnIdHash === "string") &&
    (event.toolClass === undefined || includes(ISLAND_TOOL_CLASSES, event.toolClass)) &&
    (event.surface === undefined || includes(ISLAND_SURFACES, event.surface)) &&
    (event.intent === undefined || includes(EXECUTION_INTENTS, event.intent)) &&
    (event.route === undefined || (typeof event.route === "string" && event.route.length > 0))
  );
}

function signalKey(event: IslandEvent): string {
  return [
    event.source,
    event.kind,
    event.sessionIdHash ?? "",
    event.turnIdHash ?? "",
    event.toolClass ?? "",
    event.surface ?? "",
    event.intent ?? "",
    event.route ?? "",
  ].join("\u0000");
}

function isWorkSignal(event: IslandEvent): boolean {
  return event.kind === "work_started" || event.kind === "work_progressed";
}

/**
 * Island Core's public Module. Callers submit a safe event or ask for the
 * latest M4-display-safe snapshot. Timing, ordering, and duplicate suppression
 * remain inside the Implementation.
 */
export class IslandEngine {
  private readonly clock: IslandClock;
  private readonly scheduler: IslandStateScheduler;
  private readonly dedupeMs: number;
  private readonly maxRememberedEvents: number;
  private readonly seenEventIds = new Map<string, number>();
  private readonly recentSignals = new Map<string, number>();
  private lastOccurredAt = Number.NEGATIVE_INFINITY;

  constructor(options: IslandEngineOptions = {}) {
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.dedupeMs = Math.max(0, options.dedupeMs ?? DEFAULT_DEDUPE_MS);
    this.maxRememberedEvents = Math.max(
      1,
      Math.floor(options.maxRememberedEvents ?? DEFAULT_MAX_REMEMBERED_EVENTS),
    );
    this.scheduler = new IslandStateScheduler(
      { ...DEFAULT_ISLAND_SCHEDULE, ...options.schedule },
      this.clock.now(),
    );
  }

  accept(event: IslandEvent): IslandSnapshot {
    const now = this.clock.now();
    this.scheduler.snapshot(now);
    if (!isIslandEvent(event)) return this.scheduler.snapshot(now);
    if (this.seenEventIds.has(event.id)) return this.scheduler.snapshot(now);

    const occurredAt = Date.parse(event.occurredAt);
    if (occurredAt < this.lastOccurredAt) return this.scheduler.snapshot(now);
    this.remember(this.seenEventIds, event.id, now);
    this.lastOccurredAt = Math.max(this.lastOccurredAt, occurredAt);

    const key = signalKey(event);
    const previousSignalAt = this.recentSignals.get(key);
    const coalesced =
      previousSignalAt !== undefined && now - previousSignalAt >= 0 && now - previousSignalAt < this.dedupeMs;
    this.remember(this.recentSignals, key, now);
    if (coalesced) {
      if (isWorkSignal(event)) this.scheduler.touch(event, now);
      return this.scheduler.snapshot(now);
    }

    const transition = reduceIslandEvent(this.scheduler.state, event);
    if (transition) this.scheduler.apply(transition, event, now);
    return this.scheduler.snapshot(now);
  }

  snapshot(): IslandSnapshot {
    return this.scheduler.snapshot(this.clock.now());
  }

  private remember(store: Map<string, number>, key: string, value: number): void {
    store.delete(key);
    store.set(key, value);
    while (store.size > this.maxRememberedEvents) {
      const oldest = store.keys().next().value as string | undefined;
      if (!oldest) break;
      store.delete(oldest);
    }
  }
}
