import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../../src/router/core/config.js";
import {
  RouterEngine,
  type AiClassifier,
  type RoutingEngine,
} from "../../src/router/core/engine.js";
import type {
  AiClassification,
  AiDecision,
  ModelCatalog,
  RouteDecision,
} from "../../src/router/core/types.js";
import { ProtocolRouter } from "../../src/router/adapters/protocol-router.js";

class FakeAi implements AiClassifier {
  constructor(private readonly decision?: Omit<AiDecision, "latencyMs">) {}

  async warmup(): Promise<void> {}

  async classify(): Promise<AiClassification> {
    if (!this.decision) return { status: "invalid_response", latencyMs: 1 };
    return {
      status: "ok",
      decision: { ...this.decision, latencyMs: 1 },
      latencyMs: 1,
    };
  }
}

class CountingAi extends FakeAi {
  calls = 0;

  override async classify(): Promise<AiClassification> {
    this.calls += 1;
    return super.classify();
  }
}

function config() {
  const value = defaultConfig();
  value.logging.auditFile = "";
  return value;
}

function prediction(
  overrides: Partial<Omit<AiDecision, "latencyMs">> = {},
): Omit<AiDecision, "latencyMs"> {
  return {
    category: "IMPLEMENT_CHANGE",
    complexity: "normal",
    intent: "do",
    confidence: 0.9,
    reason: "test_embedding",
    ...overrides,
  };
}

test("embedding output is the primary semantic decision", async () => {
  const ai = new CountingAi(
    prediction({
      category: "AGENT_WORKFLOW",
      complexity: "extreme",
    }),
  );
  const decision = await new RouterEngine(config(), ai).routeTurn({
    threadId: "embedding-primary",
    input: [{ type: "text", text: "设计并实现 Agent Dock 的透明代理" }],
  });
  assert.equal(ai.calls, 1);
  assert.equal(decision.category, "AGENT_WORKFLOW");
  assert.equal(decision.complexity, "extreme");
  assert.equal(decision.routeName, "max");
  assert.equal(decision.intent, "do");
  assert.equal(decision.intentSource, "classifier");
  assert.equal(decision.reason, "embedding_primary");
});

test("intent stays observational and cannot change the route", async () => {
  const prompt = {
    threadId: "intent-observation",
    input: [{ type: "text", text: "处理一下" }],
  };
  const ask = await new RouterEngine(
    config(),
    new FakeAi(prediction({ intent: "ask" })),
  ).routeTurn(prompt);
  const action = await new RouterEngine(
    config(),
    new FakeAi(prediction({ intent: "do" })),
  ).routeTurn(prompt);
  assert.equal(ask.intent, "ask");
  assert.equal(action.intent, "do");
  assert.equal(ask.routeName, action.routeName);
  assert.deepEqual(ask.profile, action.profile);
});

test("classifier failures fail open without semantic rule fallback", async () => {
  const decision = await new RouterEngine(config(), new FakeAi()).routeTurn({
    threadId: "classifier-failure",
    input: [{ type: "text", text: "请实现一个复杂功能" }],
  });
  assert.equal(decision.action, "inherit");
  assert.equal(decision.routeName, undefined);
  assert.equal(decision.intent, "unknown");
  assert.equal(decision.reason, "classifier_fail_open");
  assert.equal(decision.aiStatus, "invalid_response");
});

test("bypass, manual override and hard guards never call the classifier", async () => {
  const disabledConfig = config();
  disabledConfig.enabled = false;
  const disabledAi = new CountingAi(prediction());
  await new RouterEngine(disabledConfig, disabledAi).routeTurn({
    input: [{ type: "text", text: "实现这个功能" }],
  });
  assert.equal(disabledAi.calls, 0);

  const manualAi = new CountingAi(prediction());
  await new RouterEngine(config(), manualAi).routeTurn(
    { input: [{ type: "text", text: "实现这个功能" }] },
    { manualModelOverride: true },
  );
  assert.equal(manualAi.calls, 0);

  const guardAi = new CountingAi(prediction());
  const engine = new RouterEngine(config(), guardAi);
  assert.equal(
    (
      await engine.routeTurn({
        input: [{ type: "text", text: "不要使用路由，直接回答" }],
      })
    ).reason,
    "explicit_suppression",
  );
  await engine.routeTurn({
    input: [{ type: "text", text: "<environment_context>private</environment_context>" }],
  });
  assert.equal(guardAi.calls, 0);
});

test("classifier PASS_CONTEXT and fail-open continuation preserve sticky route", async () => {
  const decisions: Array<Omit<AiDecision, "latencyMs"> | undefined> = [
    prediction({
      category: "DIAGNOSE_FIX",
      complexity: "complex",
    }),
    prediction({
      category: "PASS_CONTEXT",
      complexity: "simple",
      intent: "continue",
    }),
    undefined,
  ];
  const ai: AiClassifier = {
    async warmup() {},
    async classify() {
      const value = decisions.shift();
      return value
        ? { status: "ok", decision: { ...value, latencyMs: 1 }, latencyMs: 1 }
        : { status: "timeout", latencyMs: 1 };
    },
  };
  const engine = new RouterEngine(config(), ai);
  assert.equal(
    (
      await engine.routeTurn({
        threadId: "sticky",
        input: [{ type: "text", text: "修复 500 错误" }],
      })
    ).routeName,
    "deep",
  );
  assert.equal(
    (
      await engine.routeTurn({
        threadId: "sticky",
        input: [{ type: "text", text: "继续" }],
      })
    ).reason,
    "sticky_context",
  );
  const failOpenContinuation = await engine.routeTurn({
    threadId: "sticky",
    input: [{ type: "text", text: "继续做" }],
  });
  assert.equal(failOpenContinuation.reason, "sticky_context");
  assert.equal(failOpenContinuation.intent, "continue");
});

test("manual controls remain deterministic and classifier-free", async () => {
  const ai = new CountingAi(prediction());
  const engine = new RouterEngine(config(), ai);
  const fallback = await engine.routeTurn({
    threadId: "manual",
    input: [{ type: "text", text: "加强一点" }],
  });
  assert.equal(fallback.routeName, "deep");
  assert.equal(fallback.intent, "control");

  const max = await engine.routeTurn({
    threadId: "manual",
    input: [{ type: "text", text: "拉满！" }],
  });
  assert.equal(max.routeName, "max");

  const automatic = await engine.routeTurn({
    threadId: "manual",
    input: [{ type: "text", text: "恢复自动" }],
  });
  assert.equal(automatic.action, "inherit");
  assert.equal(automatic.reason, "manual_auto");
  assert.equal(ai.calls, 0);
});

test("manual step-up infers the current route after a Router restart", async () => {
  const decision = await new RouterEngine(config(), new FakeAi()).routeTurn({
    threadId: "resumed-thread",
    model: "gpt-5.6-sol",
    effort: "high",
    input: [{ type: "text", text: "加强一点" }],
  });
  assert.equal(decision.routeName, "max");
  assert.equal(decision.profile?.effort, "xhigh");
});

test("manual control phrases only match the complete user message", async () => {
  const decision = await new RouterEngine(
    config(),
    new FakeAi(
      prediction({
        category: "PLAN_DESIGN",
        intent: "ask",
      }),
    ),
  ).routeTurn({
    input: [{ type: "text", text: "把这个方案再加强一点，我们先讨论边界" }],
  });
  assert.notEqual(decision.reason, "manual_step_up");
  assert.equal(decision.routeName, "deep");
});

test("protocol changes only routing fields and collaboration settings", async () => {
  const engine = new RouterEngine(
    config(),
    new FakeAi(
      prediction({
        category: "OPERATE_VERIFY",
      }),
    ),
  );
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
  assert.deepEqual(message, original);
  assert.deepEqual(transformed.params.input, original.params.input);
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
});

test("presentation failure cannot block the current routing decision", async () => {
  const engine = new RouterEngine(config(), new FakeAi(prediction()));
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
          input: [{ type: "text", text: "修改这个功能" }],
          model: "original-model",
          effort: "low",
        },
      }),
    ),
  );
  assert.equal(transformed.params.model, "gpt-5.6-terra");
  assert.equal(presentationCalls, 1);
});

test("non-turn protocol messages remain exact", async () => {
  const protocol = new ProtocolRouter(
    new RouterEngine(config(), new FakeAi(prediction())),
  );
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
    intentSource: "classifier",
    intentReason: "test",
    category: "PASS_CONTEXT",
    complexity: "simple",
    reason: "test",
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
  const protocol = new ProtocolRouter(
    new RouterEngine(config(), new FakeAi(prediction())),
    { manualModelOverride: true },
  );
  const line = JSON.stringify({
    id: 1,
    method: "turn/start",
    params: { threadId: "t4", input: [{ type: "text", text: "实现登录接口" }] },
  });
  assert.equal(await protocol.transformClientLine(line), line);
});
