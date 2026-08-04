import type { IslandEvent, IslandState } from "./types.js";

export const ISLAND_STATE_PRIORITY: Readonly<Record<IslandState, number>> = {
  idle: 0,
  settling: 1,
  routing: 2,
  working: 3,
  awaiting_approval: 4,
};

export interface IslandTransition {
  state: IslandState;
  /** Session termination is allowed to bypass a visual minimum-stay period. */
  immediate?: boolean;
}

/**
 * Purely maps meaningful lifecycle observations to the single display state.
 * It deliberately ignores low-priority route changes while work or approval is
 * visible, so a busy M4 display cannot flicker back into a routing state.
 */
export function reduceIslandEvent(
  current: IslandState,
  event: IslandEvent,
): IslandTransition | undefined {
  switch (event.kind) {
    case "session_started":
      return current === "idle" ? { state: "idle" } : undefined;
    case "route_selected":
      return current === "idle" || current === "routing" || current === "settling"
        ? { state: "routing" }
        : undefined;
    case "work_started":
    case "work_progressed":
      return { state: "working" };
    case "approval_needed":
      return { state: "awaiting_approval" };
    case "turn_stopped":
      return current === "idle" ? undefined : { state: "settling" };
    case "session_ended":
      return { state: "idle", immediate: true };
  }
}
