import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { defaultConfig } from "../src/routing/config.js";
import {
  RouterEngine,
  type AiClassifier,
  type RoutingEngine,
} from "../src/routing/engine.js";
import type {
  AiClassification,
  AiDecision,
  ModelCatalog,
  RouteDecision,
  RoutingRuleSet,
} from "../src/routing/types.js";
import { ProtocolRouter } from "../src/transport/protocol-router.js";

const rules = JSON.parse(
  await readFile(new URL("../resources/router-rules.json", import.meta.url), "utf8"),
) as RoutingRuleSet;

class FakeAi implements AiClassifier {
  constructor(private readonly decision?: Omit<AiDecision, "latencyMs">) {}
  async warmup(): Promise<void> {}
  async classify(): Promise<AiClassification> {
    if (!this.decision) return { status: "invalid_response", latencyMs: 1 };
    const decision = { ...this.decision, latencyMs: 1 };
    return { status: "ok", decision, latencyMs: 1 };
  }
}

function config() {
  const value = defaultConfig();
  value.logging.auditFile = "";
  return value;
}

test("strong weighted rules beat a mistaken local-model category", async () => {
  const engine = new RouterEngine(
    config(),
    rules,
    new FakeAi({
      category: "RESEARCH_EXPLAIN",
      complexity: "extreme",
      intent: "ask",
      confidence: 0.9,
      reason: "mistaken",
    }),
  );
  const decision = await engine.routeTurn({
    threadId: "t1",
    input: [{ type: "text", text: "设计并实现 Codex Router 的透明 App Server 代理" }],
  });
  assert.equal(decision.category, "AGENT_WORKFLOW");
  assert.equal(decision.complexity, "complex", "2B model alone must not select the max route");
  assert.equal(decision.routeName, "deep");
  assert.equal(decision.profile?.model, "gpt-5.6-sol");
});

test("short continuation inherits the last route while explicit suppression does not", async () => {
  const engine = new RouterEngine(config(), rules, new FakeAi());
  const first = await engine.routeTurn({
    threadId: "t2",
    input: [{ type: "text", text: "页面报500错误，定位根因并修复后跑回归测试" }],
  });
  assert.equal(first.routeName, "deep");
  assert.equal(first.intent, "do");
  const continued = await engine.routeTurn({
    threadId: "t2",
    input: [{ type: "text", text: "继续" }],
  });
  assert.equal(continued.action, "apply");
  assert.equal(continued.routeName, "deep");
  assert.equal(continued.sticky, true);
  assert.equal(continued.intent, "continue");

  const suppressed = await engine.routeTurn({
    threadId: "t2",
    input: [{ type: "text", text: "后面不要路由" }],
  });
  assert.equal(suppressed.action, "inherit");
});

test("manual controls step up one route, cap at max and restore automatic routing", async () => {
  const engine = new RouterEngine(config(), rules, new FakeAi());
  const first = await engine.routeTurn({
    threadId: "manual-controls",
    input: [{ type: "text", text: "只回复结论" }],
  });
  assert.equal(first.routeName, "quick");

  const balanced = await engine.routeTurn({
    threadId: "manual-controls",
    input: [{ type: "text", text: "加强一点。" }],
  });
  assert.equal(balanced.routeName, "balanced");
  assert.equal(balanced.reason, "manual_step_up");
  assert.equal(balanced.intent, "control");

  const deep = await engine.routeTurn({
    threadId: "manual-controls",
    input: [{ type: "text", text: "再加强一点" }],
  });
  assert.equal(deep.routeName, "deep");

  const max = await engine.routeTurn({
    threadId: "manual-controls",
    input: [{ type: "text", text: "提高一档" }],
  });
  assert.equal(max.routeName, "max");

  const capped = await engine.routeTurn({
    threadId: "manual-controls",
    input: [{ type: "text", text: "加强一点" }],
  });
  assert.equal(capped.routeName, "max");

  const automatic = await engine.routeTurn({
    threadId: "manual-controls",
    input: [{ type: "text", text: "恢复自动" }],
  });
  assert.equal(automatic.action, "inherit");
  assert.equal(automatic.reason, "manual_auto");

  const continued = await engine.routeTurn({
    threadId: "manual-controls",
    input: [{ type: "text", text: "继续" }],
  });
  assert.equal(continued.action, "inherit");
});

test("intent is observational and does not change the selected route", async () => {
  const prompt = {
    threadId: "intent-observation",
    input: [{ type: "text", text: "处理一下" }],
  };
  const ask = await new RouterEngine(
    config(),
    rules,
    new FakeAi({
      category: "RESEARCH_EXPLAIN",
      complexity: "normal",
      intent: "ask",
      confidence: 0.9,
      reason: "ask",
    }),
  ).routeTurn(prompt);
  const action = await new RouterEngine(
    config(),
    rules,
    new FakeAi({
      category: "RESEARCH_EXPLAIN",
      complexity: "normal",
      intent: "do",
      confidence: 0.9,
      reason: "do",
    }),
  ).routeTurn(prompt);

  assert.equal(ask.intent, "ask");
  assert.equal(action.intent, "do");
  assert.equal(ask.routeName, action.routeName);
  assert.deepEqual(ask.profile, action.profile);
});

test("manual max and fallback controls work without a stored route", async () => {
  const engine = new RouterEngine(config(), rules, new FakeAi());
  const fallback = await engine.routeTurn({
    threadId: "manual-fallback",
    input: [{ type: "text", text: "加强一点" }],
  });
  assert.equal(fallback.routeName, "deep");
  assert.equal(fallback.reason, "manual_step_up");

  const max = await engine.routeTurn({
    threadId: "manual-max",
    input: [{ type: "text", text: "拉满！" }],
  });
  assert.equal(max.routeName, "max");
  assert.equal(max.reason, "manual_max");
});

test("manual step-up infers the current route after a Router restart", async () => {
  const engine = new RouterEngine(config(), rules, new FakeAi());
  const decision = await engine.routeTurn({
    threadId: "resumed-thread",
    model: "gpt-5.6-sol",
    effort: "high",
    input: [{ type: "text", text: "加强一点" }],
  });
  assert.equal(decision.routeName, "max");
  assert.equal(decision.profile?.effort, "xhigh");
  assert.equal(decision.reason, "manual_step_up");
});

test("manual control phrases only match the complete user message", async () => {
  const engine = new RouterEngine(
    config(),
    rules,
    new FakeAi({
      category: "PLAN_DESIGN",
      complexity: "normal",
      intent: "ask",
      confidence: 0.9,
      reason: "plan",
    }),
  );
  const decision = await engine.routeTurn({
    threadId: "embedded-control",
    input: [{ type: "text", text: "把这个方案再加强一点，我们先讨论边界" }],
  });
  assert.notEqual(decision.reason, "manual_step_up");
  assert.equal(decision.routeName, "deep");
});

test("protocol changes only routing fields and collaboration settings", async () => {
  const engine = new RouterEngine(config(), rules, new FakeAi());
  const protocol = new ProtocolRouter(engine);
  const message = {
    id: 7,
    method: "turn/start",
    params: {
      threadId: "t3",
      input: [{ type: "text", text: "安装这个CLI，然后执行初始化并确认版本" }],
      model: "original-model",
      effort: "low",
      serviceTier: "priority",
      cwd: "/tmp/project",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "original-model",
          reasoning_effort: "low",
          developer_instructions: "preserve me",
        },
      },
    },
  };
  const original = structuredClone(message);
  const transformed = JSON.parse(await protocol.transformClientLine(JSON.stringify(message)));
  assert.deepEqual(message, original, "input object must not be mutated");
  assert.deepEqual(transformed.params.input, original.params.input, "prompt must be byte-for-byte unchanged");
  assert.equal(transformed.params.model, "gpt-5.6-terra");
  assert.equal(transformed.params.effort, "max");
  assert.equal(transformed.params.serviceTier, null);
  assert.equal(transformed.params.collaborationMode.mode, "plan");
  assert.equal(transformed.params.collaborationMode.settings.model, "gpt-5.6-terra");
  assert.equal(transformed.params.collaborationMode.settings.reasoning_effort, "max");
  assert.equal(
    transformed.params.collaborationMode.settings.developer_instructions,
    "preserve me",
  );
  assert.equal("intent" in transformed.params, false);
  assert.equal("category" in transformed.params, false);
  assert.equal("complexity" in transformed.params, false);
  assert.equal("additionalContext" in transformed.params, false);
  assert.equal("intent" in transformed.params.collaborationMode.settings, false);
});

test("presentation publishes with the current routing decision and remains fail-open", async () => {
  const engine = new RouterEngine(config(), rules, new FakeAi());
  let presentationCalls = 0;
  const protocol = new ProtocolRouter(engine, {
    onDecision: async () => {
      presentationCalls += 1;
      throw new Error("display unavailable");
    },
  });
  const transformed = JSON.parse(
    await protocol.transformClientLine(
      JSON.stringify({
        id: 8,
        method: "turn/start",
        params: {
          threadId: "presentation-fail-open",
          input: [{ type: "text", text: "安装这个CLI，然后执行初始化并确认版本" }],
          model: "original-model",
          effort: "low",
        },
      }),
    ),
  );
  assert.equal(transformed.params.model, "gpt-5.6-terra");
  assert.equal(transformed.params.effort, "max");
  assert.equal(presentationCalls, 1, "the current decision should be presented immediately");
  protocol.observeServerLine(
    JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "presentation-fail-open",
        turn: { id: "turn-1", status: "completed", items: [] },
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(presentationCalls, 1, "turn completion must not republish a stale decision");
});

test("non-turn protocol messages remain exact", async () => {
  const engine = new RouterEngine(config(), rules, new FakeAi());
  const protocol = new ProtocolRouter(engine);
  const line = '{"id":1,"method":"thread/list","params":{"limit":20}}';
  assert.equal(await protocol.transformClientLine(line), line);
  assert.equal(await protocol.transformClientLine("not-json"), "not-json");
});

test("a first turn waits briefly for an already requested model catalog", async () => {
  let catalogReady = false;
  let routedWithCatalog = false;
  const fallbackDecision: RouteDecision = {
    action: "inherit",
    intent: "ask",
    intentSource: "rule",
    intentReason: "read_only_request",
    category: "PASS_CONTEXT",
    complexity: "simple",
    reason: "test",
    rule: {
      category: "PASS_CONTEXT",
      confidence: 0,
      reason: "test",
      scores: {},
      suppressed: false,
      passContext: true,
    },
    sticky: false,
    promptHash: "hash",
    promptChars: 1,
    latencyMs: 0,
  };
  const engine: RoutingEngine = {
    config: config(),
    warmup() {},
    setModelCatalog(_catalog: ModelCatalog) {
      catalogReady = true;
    },
    async routeTurn() {
      routedWithCatalog = catalogReady;
      return fallbackDecision;
    },
  };
  const protocol = new ProtocolRouter(engine);
  await protocol.transformClientLine(
    JSON.stringify({ id: 30, method: "model/list", params: {} }),
  );
  const turn = protocol.transformClientLine(
    JSON.stringify({
      id: 31,
      method: "turn/start",
      params: { threadId: "catalog-first-turn", input: [{ type: "text", text: "检查" }] },
    }),
  );
  setTimeout(() => {
    protocol.observeServerLine(
      JSON.stringify({
        id: 30,
        result: {
          data: [
            {
              id: "gpt-5.6-luna",
              supportedReasoningEfforts: [{ reasoningEffort: "low" }],
              serviceTiers: [{ id: "priority" }],
            },
          ],
        },
      }),
    );
  }, 10);
  await turn;
  assert.equal(routedWithCatalog, true);
});

test("manual CLI model override fails open", async () => {
  const engine = new RouterEngine(config(), rules, new FakeAi());
  const protocol = new ProtocolRouter(engine, { manualModelOverride: true });
  const line = JSON.stringify({
    id: 1,
    method: "turn/start",
    params: { threadId: "t4", input: [{ type: "text", text: "实现登录接口" }] },
  });
  assert.equal(await protocol.transformClientLine(line), line);
});

test("an expected output token containing router does not force a deep route", async () => {
  const engine = new RouterEngine(
    config(),
    rules,
    new FakeAi({
      category: "IMPLEMENT_CHANGE",
      complexity: "extreme",
      intent: "do",
      confidence: 0.95,
      reason: "mistaken",
    }),
  );
  const decision = await engine.routeTurn({
    threadId: "t5",
    input: [{ type: "text", text: "只回复 ROUTER_E2E_OK，不调用工具。" }],
  });
  assert.equal(decision.category, "RESEARCH_EXPLAIN");
  assert.equal(decision.routeName, "quick");
  assert.equal(decision.profile?.model, "gpt-5.6-luna");
});
