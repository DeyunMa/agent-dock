import type { RouteDecision } from "./types.js";

export interface VisibleDecision {
  intent: RouteDecision["intent"];
  route: string;
}

export function visibleDecision(decision: RouteDecision): VisibleDecision {
  return {
    intent: decision.intent,
    route: decision.action === "apply" && decision.routeName ? decision.routeName : "native",
  };
}

export function formatDecisionMarker(decision: RouteDecision): string {
  const visible = visibleDecision(decision);
  return `[${visible.intent}] [${visible.route}]`;
}
