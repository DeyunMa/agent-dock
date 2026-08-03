import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyExecutionIntent,
  resolveExecutionIntent,
} from "../src/legacy-intent.js";

test("intent rules distinguish observation from execution", () => {
  const fixtures = [
    ["分析这个问题，先不要改", "ask"],
    ["搜索高星项目，先不要安装", "ask"],
    ["这些文件可以删除吗？", "ask"],
    ["后续如果要迁移，应该怎么做？", "ask"],
    ["先分析，然后修复并验证", "do"],
    ["帮我修改代码并运行测试", "do"],
    ["那就按这个方案实现吧", "do"],
    ["实现一个支持重试的 TypeScript 函数并测试。", "do"],
    ["把按钮颜色改成蓝色并运行测试。", "do"],
    ["继续", "continue"],
    ["你好", "unknown"],
  ] as const;

  for (const [prompt, expected] of fixtures) {
    assert.equal(classifyExecutionIntent(prompt).intent, expected, prompt);
  }
});

test("explicit rules beat AI intent and Router controls stay separate", () => {
  assert.deepEqual(resolveExecutionIntent("先检查，不要修改", { aiIntent: "do" }), {
    intent: "ask",
    source: "rule",
    reason: "negated_action",
  });
  assert.deepEqual(resolveExecutionIntent("处理一下", { aiIntent: "do" }), {
    intent: "do",
    source: "ai",
    reason: "local_classifier",
  });
  assert.deepEqual(resolveExecutionIntent("拉满", { control: true, aiIntent: "ask" }), {
    intent: "control",
    source: "manual",
    reason: "router_control",
  });
});
