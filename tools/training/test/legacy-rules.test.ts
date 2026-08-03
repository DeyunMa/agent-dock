import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  classifyWithRules,
  type RoutingRuleSet,
} from "../src/legacy-rules.js";

const rules = JSON.parse(
  await readFile(
    new URL("../resources/legacy-router-rules.json", import.meta.url),
    "utf8",
  ),
) as RoutingRuleSet;

test("weighted rules preserve the semantic category contract", () => {
  const fixtures: Array<[string, string]> = [
    ["帮我搜索当前高星的开源会话分析项目，给出官方链接", "RESEARCH_EXPLAIN"],
    ["先检查本地代码和日志，判断现在是否已经闭环，先不要修改", "AUDIT_ANALYZE"],
    ["页面打开时报500错误，定位根因并修复后跑回归测试", "DIAGNOSE_FIX"],
    ["我们先讨论这个数据模型应该分几层，给出方案，不要实现", "PLAN_DESIGN"],
    ["修改登录接口并补上测试，完成后运行最小验证", "IMPLEMENT_CHANGE"],
    ["安装这个CLI，然后执行初始化并确认版本", "OPERATE_VERIFY"],
    ["根据这些资料生成一份带目录的PDF报告", "CREATE_ARTIFACT"],
    ["给UserPromptSubmit做一个分类hook并验证additionalContext", "AGENT_WORKFLOW"],
    ["继续", "PASS_CONTEXT"],
  ];
  for (const [prompt, expected] of fixtures) {
    assert.equal(classifyWithRules(prompt, rules).category, expected, prompt);
  }
});

test("explicit suppression is a hard fail-open guard", () => {
  const decision = classifyWithRules("搜索高星项目，不要路由", rules);
  assert.equal(decision.category, "PASS_CONTEXT");
  assert.equal(decision.reason, "explicit_suppression");
  assert.equal(decision.suppressed, true);
});

test("plain-answer requests use the quick semantic route instead of disabling routing", () => {
  for (const prompt of ["解释一下这个概念，no workflow", "什么是幂等性？只回答一句话"]) {
    const decision = classifyWithRules(prompt, rules);
    assert.equal(decision.category, "RESEARCH_EXPLAIN");
    assert.equal(decision.reason, "plain_answer_guard");
    assert.equal(decision.suppressed, false);
  }
});

test("latest request marker prevents quoted history from dominating", () => {
  const prompt = `${"实现修改部署并提交 ".repeat(200)}\n## My request for Codex:\n先讨论技术选型，不要修改`;
  const decision = classifyWithRules(prompt, rules);
  assert.equal(decision.category, "PLAN_DESIGN");
  assert.match(decision.preprocessing ?? "", /^marker:/);
});
