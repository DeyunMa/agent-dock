import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProtocolRouter } from "../../src/router/adapters/protocol-router.js";
import { ROUTER_MODEL } from "../../src/router/adapters/router-selection.js";
import { defaultConfig } from "../../src/router/core/config.js";
import { RouterEngine, type AiClassifier } from "../../src/router/core/engine.js";

async function fixture() {
  const config = defaultConfig();
  config.logging.auditFile = "";
  config.routing.stateDirectory = await mkdtemp(join(tmpdir(), "dock-virtual-"));
  let calls = 0;
  const ai: AiClassifier = {
    async warmup() {},
    async classify() {
      calls += 1;
      return {
        status: "ok",
        latencyMs: 1,
        decision: {
          routeName: "quick",
          category: "PASS_CONTEXT",
          complexity: "simple",
          intent: "ask",
          confidence: 1,
          reason: "test",
          latencyMs: 1,
        },
      };
    },
  };
  return { config, ai, calls: () => calls };
}

const models = {
  data: [
    {
      id: "gpt-5.6-terra",
      model: "gpt-5.6-terra",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }],
      serviceTiers: [{ id: "priority" }],
    },
    {
      id: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      supportedReasoningEfforts: [{ reasoningEffort: "high" }],
      serviceTiers: [{ id: "priority" }],
    },
    {
      id: "gpt-6-astra",
      model: "gpt-6-astra",
      supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }],
      serviceTiers: [{ id: "priority" }],
    },
  ],
};

test("model/list registers Jev Router without adding it to the real capability catalog", async () => {
  const f = await fixture();
  const engine = new RouterEngine(f.config, f.ai);
  const protocol = new ProtocolRouter(engine);
  await protocol.transformClientLine(JSON.stringify({ id: 1, method: "model/list", params: {} }));
  const response = JSON.parse(await protocol.transformServerLine(JSON.stringify({ id: 1, result: models })));
  assert.equal(response.result.data[0].id, ROUTER_MODEL);
  assert.equal(response.result.data[0].displayName, "Jev Router");
  assert.equal(response.result.data.filter((item: { id: string }) => item.id === ROUTER_MODEL).length, 1);
});

test("Jev Router classifies the first turn and pins the real profile afterwards", async () => {
  const f = await fixture();
  const protocol = new ProtocolRouter(new RouterEngine(f.config, f.ai));
  const start = JSON.parse(await protocol.transformClientLine(JSON.stringify({
    id: 2,
    method: "thread/start",
    params: { model: ROUTER_MODEL },
  })));
  assert.equal(start.params.model, "gpt-5.6-sol");
  const started = JSON.parse(await protocol.transformServerLine(JSON.stringify({
    id: 2,
    result: {
      thread: { id: "auto-thread", turns: [] },
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      serviceTier: null,
    },
  })));
  assert.equal(started.result.model, ROUTER_MODEL);

  const first = JSON.parse(await protocol.transformClientLine(JSON.stringify({
    id: 3,
    method: "turn/start",
    params: {
      threadId: "auto-thread",
      model: ROUTER_MODEL,
      effort: "medium",
      input: [{ type: "text", text: "解释幂等性" }],
    },
  })));
  assert.equal(first.params.model, "gpt-5.6-terra");
  assert.equal(first.params.effort, "low");
  assert.equal(first.params.serviceTier, "priority");

  const followup = JSON.parse(await protocol.transformClientLine(JSON.stringify({
    id: 4,
    method: "turn/start",
    params: {
      threadId: "auto-thread",
      model: ROUTER_MODEL,
      effort: "medium",
      input: [{ type: "text", text: "现在做一个更复杂的任务" }],
    },
  })));
  assert.equal(followup.params.model, "gpt-5.6-terra");
  assert.equal(f.calls(), 1);

  await protocol.transformClientLine(JSON.stringify({
    id: 5,
    method: "turn/start",
    params: {
      threadId: "auto-thread",
      model: ROUTER_MODEL,
      input: [{ type: "text", text: "恢复自动" }],
    },
  }));
  await protocol.transformClientLine(JSON.stringify({
    id: 6,
    method: "turn/start",
    params: {
      threadId: "auto-thread",
      model: ROUTER_MODEL,
      input: [{ type: "text", text: "重新判断这个任务" }],
    },
  }));
  assert.equal(f.calls(), 2);
});

test("a concrete model is an exact manual passthrough and never calls Jev", async () => {
  const f = await fixture();
  const protocol = new ProtocolRouter(new RouterEngine(f.config, f.ai));
  const line = JSON.stringify({
    id: 7,
    method: "turn/start",
    params: {
      threadId: "manual-thread",
      model: "gpt-6-astra",
      effort: "xhigh",
      serviceTier: null,
      input: [{ type: "text", text: "手动执行" }],
    },
  });
  assert.equal(await protocol.transformClientLine(line), line);
  assert.equal(f.calls(), 0);
});

test("selecting Jev Router on a resumed non-empty thread preserves its real model", async () => {
  const f = await fixture();
  const protocol = new ProtocolRouter(new RouterEngine(f.config, f.ai));
  await protocol.transformClientLine(JSON.stringify({
    id: 8,
    method: "thread/resume",
    params: { threadId: "old-thread", model: ROUTER_MODEL },
  }));
  const resumed = JSON.parse(await protocol.transformServerLine(JSON.stringify({
    id: 8,
    result: {
      thread: { id: "old-thread", turns: [{ id: "old-turn" }] },
      model: "gpt-6-astra",
      reasoningEffort: "xhigh",
      serviceTier: null,
    },
  })));
  assert.equal(resumed.result.model, ROUTER_MODEL);

  const turn = JSON.parse(await protocol.transformClientLine(JSON.stringify({
    id: 9,
    method: "turn/start",
    params: {
      threadId: "old-thread",
      model: ROUTER_MODEL,
      effort: "medium",
      input: [{ type: "text", text: "继续" }],
    },
  })));
  assert.equal(turn.params.model, "gpt-6-astra");
  assert.equal(turn.params.effort, "xhigh");
  assert.equal(f.calls(), 0);
});
