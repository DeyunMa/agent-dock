import assert from "node:assert/strict";
import test from "node:test";
import { formatDecisionMarker, visibleDecision } from "../src/routing/presentation.js";
import type { RouteDecision } from "../src/routing/types.js";

function decision(routeName?: string): RouteDecision {
  return {
    action: routeName ? "apply" : "inherit",
    intent: "do",
    intentSource: "rule",
    intentReason: "explicit_action",
    category: "IMPLEMENT_CHANGE",
    complexity: "normal",
    ...(routeName ? { routeName } : {}),
    reason: "test",
    rule: {
      category: "IMPLEMENT_CHANGE",
      confidence: 0.9,
      reason: "classified",
      scores: {},
      suppressed: false,
      passContext: false,
    },
    sticky: false,
    promptHash: "hash",
    promptChars: 4,
    latencyMs: 1,
  };
}

test("visible decisions contain only intent and actual route", () => {
  assert.deepEqual(visibleDecision(decision("deep")), { intent: "do", route: "deep" });
  assert.equal(formatDecisionMarker(decision("deep")), "[do] [deep]");
  assert.deepEqual(visibleDecision(decision()), { intent: "do", route: "native" });

  const failedRoute = decision("deep");
  failedRoute.action = "inherit";
  assert.deepEqual(visibleDecision(failedRoute), { intent: "do", route: "native" });
  assert.equal(formatDecisionMarker(failedRoute), "[do] [native]");
});
