import { createHash } from "node:crypto";
import {
  readDecisionEvents,
  type DecisionEvent,
  type DecisionFeedReadOptions,
} from "../decision-feed.js";
import type { RouterConfig } from "../../router/core/types.js";
import type { IslandEvent, IslandSnapshot } from "../core/types.js";

export interface IslandEventSink {
  accept(event: IslandEvent): IslandSnapshot;
  snapshot(): IslandSnapshot;
}

export type DecisionFeedReader = (
  options: DecisionFeedReadOptions,
) => Promise<DecisionEvent[]>;

function opaqueSessionId(threadId: string): string {
  return createHash("sha256")
    .update(`agent-dock-island-v1:${threadId}`)
    .digest("base64url")
    .slice(0, 22);
}

/** Converts the existing content-free Router feed into Island Core's contract. */
export function decisionEventToIslandEvent(event: DecisionEvent): IslandEvent {
  return {
    schemaVersion: 1,
    id: `router:${event.id}`,
    occurredAt: event.triggeredAt,
    source: "router",
    kind: "route_selected",
    ...(event.threadId ? { sessionIdHash: opaqueSessionId(event.threadId) } : {}),
    surface: event.surface,
    intent: event.intent,
    route: event.route,
  };
}

/**
 * Input Adapter for the existing bounded Decision Feed. Errors deliberately
 * return the last snapshot so observation failures cannot affect routing.
 */
export class DecisionFeedInput {
  private cursor?: string;

  constructor(
    private readonly sink: IslandEventSink,
    private readonly read: DecisionFeedReader,
  ) {}

  async poll(): Promise<IslandSnapshot> {
    try {
      const events = await this.read(this.cursor ? { afterId: this.cursor } : {});
      for (const event of events) {
        this.sink.accept(decisionEventToIslandEvent(event));
        this.cursor = event.id;
      }
    } catch {
      // Island observation must remain fail-open with respect to Router.
    }
    return this.sink.snapshot();
  }
}

export function createDecisionFeedInput(
  config: RouterConfig,
  sink: IslandEventSink,
): DecisionFeedInput {
  return new DecisionFeedInput(sink, (options) => readDecisionEvents(config, options));
}
