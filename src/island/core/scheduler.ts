import type { IslandTransition } from "./reducer.js";
import type {
  IslandEvent,
  IslandEventSource,
  IslandSnapshot,
  IslandState,
  IslandSurface,
} from "./types.js";
import type { ExecutionIntent } from "../../router/core/types.js";

export interface IslandScheduleOptions {
  routingHoldMs: number;
  workingMinimumMs: number;
  workingIdleMs: number;
  settlingHoldMs: number;
}

export const DEFAULT_ISLAND_SCHEDULE: Readonly<IslandScheduleOptions> = {
  routingHoldMs: 1_000,
  workingMinimumMs: 1_500,
  workingIdleMs: 60_000,
  settlingHoldMs: 1_000,
};

interface SnapshotDetails {
  source?: IslandEventSource;
  surface?: IslandSurface;
  intent?: ExecutionIntent;
  route?: string;
}

interface ScheduledState {
  state: IslandState;
  revision: number;
  enteredAt: number;
  expiresAt?: number;
  details?: SnapshotDetails;
}

interface DeferredTransition {
  transition: IslandTransition;
  event: IslandEvent;
  dueAt: number;
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

function detailsFrom(event: IslandEvent, previous?: SnapshotDetails): SnapshotDetails {
  return {
    source: event.source,
    ...(event.surface ? { surface: event.surface } : previous?.surface ? { surface: previous.surface } : {}),
    ...(event.intent ? { intent: event.intent } : previous?.intent ? { intent: previous.intent } : {}),
    ...(event.route ? { route: event.route } : previous?.route ? { route: previous.route } : {}),
  };
}

/**
 * Holds the temporal behavior behind Island Core's small Interface: duplicate
 * signals cannot replay animations, working gets a minimum visible duration,
 * and transient routing / settling states return to idle without a device
 * Adapter needing its own timing logic.
 */
export class IslandStateScheduler {
  private current: ScheduledState;
  private pending: DeferredTransition | undefined;

  constructor(
    private readonly options: IslandScheduleOptions,
    initialAt: number,
  ) {
    this.current = {
      state: "idle",
      revision: 0,
      enteredAt: initialAt,
    };
  }

  get state(): IslandState {
    return this.current.state;
  }

  apply(transition: IslandTransition, event: IslandEvent, now: number): void {
    this.advance(now);
    if (transition.state === this.current.state) {
      this.refresh(event, now);
      return;
    }

    if (
      this.current.state === "working" &&
      transition.state === "settling" &&
      !transition.immediate
    ) {
      const dueAt = this.current.enteredAt + this.options.workingMinimumMs;
      if (now < dueAt) {
        this.pending = { transition, event, dueAt };
        return;
      }
    }

    this.pending = undefined;
    this.set(transition.state, event, now);
  }

  /** A coalesced work event only extends liveness; it does not emit a frame. */
  touch(event: IslandEvent, now: number): void {
    this.advance(now);
    if (this.current.state !== "working") return;
    this.current.expiresAt = now + this.options.workingIdleMs;
    this.current.details = detailsFrom(event, this.current.details);
  }

  snapshot(now: number): IslandSnapshot {
    this.advance(now);
    const details = this.current.details;
    return {
      schemaVersion: 1,
      revision: this.current.revision,
      state: this.current.state,
      changedAt: iso(this.current.enteredAt),
      ...(this.current.expiresAt ? { expiresAt: iso(this.current.expiresAt) } : {}),
      ...(details?.source ? { source: details.source } : {}),
      ...(details?.surface ? { surface: details.surface } : {}),
      ...(details?.intent ? { intent: details.intent } : {}),
      ...(details?.route ? { route: details.route } : {}),
    };
  }

  private refresh(event: IslandEvent, now: number): void {
    if (this.current.state === "working") {
      this.touch(event, now);
    }
  }

  private advance(now: number): void {
    if (this.pending && now >= this.pending.dueAt) {
      const pending = this.pending;
      this.pending = undefined;
      this.set(pending.transition.state, pending.event, pending.dueAt);
    }

    if (this.current.expiresAt !== undefined && now >= this.current.expiresAt) {
      this.pending = undefined;
      this.set("idle", undefined, this.current.expiresAt);
    }
  }

  private set(state: IslandState, event: IslandEvent | undefined, enteredAt: number): void {
    const previous = this.current;
    const expiresAt = this.expiresAt(state, enteredAt);
    this.current = {
      state,
      revision: previous.revision + 1,
      enteredAt,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(state === "idle" || !event ? {} : { details: detailsFrom(event, previous.details) }),
    };
  }

  private expiresAt(state: IslandState, enteredAt: number): number | undefined {
    switch (state) {
      case "routing":
        return enteredAt + this.options.routingHoldMs;
      case "working":
        return enteredAt + this.options.workingIdleMs;
      case "settling":
        return enteredAt + this.options.settlingHoldMs;
      case "idle":
      case "awaiting_approval":
        return undefined;
    }
  }
}
