import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../../src/router/core/config.js";
import { backendEnvironment } from "../../src/router/adapters/codex-process.js";
import { hookOutput, skillSuggestionContext, type Skill } from "../../src/hooks/user-prompt-submit.js";

const skills: Skill[] = [
  { name: "pdf", description: "Create and inspect PDF documents.", path: "/skills/pdf/SKILL.md" },
  { name: "documents", description: "Create and edit documents.", path: "/skills/documents/SKILL.md" },
];

function answer(value: number) { return { type: "noul", noul: value }; }
function choice(value: string, options: string[]) { return { type: "choice", choice: value, confidence: 1, probabilities: Object.fromEntries(options.map((name) => [name, name === value ? 1 : 0])) }; }
function yesNo(value: "yes" | "no") { return choice(value, ["yes", "no"]); }
function relation(value: string) { return choice(value, ["complementary", "alternative", "independent", "unclear"]); }

test("hook suggests several skills and flags a genuine alternative without rewriting the prompt", async () => {
  const config = defaultConfig();
  let calls = 0;
  const context = await skillSuggestionContext({ prompt: "Make a report, but I have not chosen PDF or Word." }, config, skills, async (url, init) => {
    calls++;
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init?.redirect, "error");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-key");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.state.user_prompt, "Make a report, but I have not chosen PDF or Word.");
    if (calls === 1) {
      assert.equal(body.questions.skill_0.type, "noul");
      assert.equal(body.questions.skill_1.type, "noul");
      return Response.json({ answers: { skill_0: answer(0.95), skill_1: answer(0.91), open_choice: yesNo("yes"), skill_hint: yesNo("yes") } });
    }
    assert.equal(body.questions.pair_0_1.type, "choice");
    return Response.json({ answers: { fit_0: yesNo("yes"), fit_1: yesNo("yes"), pair_0_1: relation("alternative") } });
  }, async () => "test-key");
  assert.equal(calls, 2);
  assert.match(context ?? "", /pdf \/ documents/);
  assert.match(context ?? "", /若缺少必要偏好，再问一个针对性问题/);
  assert.match(context ?? "", /\/skills\/pdf\/SKILL.md/);
  const output = hookOutput(context!);
  assert.equal(output.hookSpecificOutput.additionalContext, context);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
});

test("hook leaves no context when Jev finds no useful hint or returns malformed data", async () => {
  const config = defaultConfig();
  for (const response of [Response.json({ answers: { skill_0: answer(0.5), skill_1: answer(0.2), open_choice: yesNo("no"), skill_hint: yesNo("no") } }), Response.json({ answers: { skill_0: { type: "noul", noul: 2 } } }), new Response("private", { status: 429 })]) {
    const context = await skillSuggestionContext({ prompt: "hello" }, config, skills, async () => response, async () => "test-key");
    assert.equal(context, undefined);
  }
  let calls = 0;
  const missing = await skillSuggestionContext({ prompt: "hello" }, config, skills, async () => { calls++; return Response.json({}); }, async () => { throw new Error("missing key"); });
  assert.equal(missing, undefined);
  assert.equal(calls, 0);
});

test("complementary skills are named together without an unnecessary question", async () => {
  const context = await skillSuggestionContext({ prompt: "Write a document and export a PDF." }, defaultConfig(), skills, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json(body.questions.skill_0 ? { answers: { skill_0: answer(0.96), skill_1: answer(0.97), open_choice: yesNo("no"), skill_hint: yesNo("yes") } } : { answers: { fit_0: yesNo("yes"), fit_1: yesNo("yes"), pair_0_1: relation("complementary") } });
  }, async () => "test-key");
  assert.match(context ?? "", /可互补：documents \/ pdf/);
  assert.doesNotMatch(context ?? "", /先问一个针对性问题/);
});

test("explicit unresolved choice survives low skill scores and failed candidate confirmation", async () => {
  let calls = 0;
  const feishuSkills: Skill[] = [
    { name: "lark-base", description: "Create and manage Feishu Base tables.", path: "/skills/lark-base/SKILL.md" },
    { name: "lark-sheets", description: "Create and manage Feishu spreadsheets.", path: "/skills/lark-sheets/SKILL.md" },
  ];
  const context = await skillSuggestionContext({ prompt: "在飞书里建立客户跟进表，我还没决定用普通电子表格还是多维表格。" }, defaultConfig(), feishuSkills, async () => {
    calls++;
    return Response.json(calls === 1
      ? { answers: { skill_0: answer(0.37), skill_1: answer(0.34), open_choice: yesNo("yes"), skill_hint: yesNo("yes") } }
      : { answers: { fit_0: yesNo("no"), fit_1: yesNo("no"), pair_0_1: relation("unclear") } });
  }, async () => "test-key");
  assert.equal(calls, 2);
  assert.match(context ?? "", /用户留有会影响结果的选择/);
  assert.match(context ?? "", /若缺少必要偏好，再问一个针对性问题/);
  assert.doesNotMatch(context ?? "", /\/skills\//);
});

test("four candidate cap bounds pairwise checks but allows several complementary skills", async () => {
  const manySkills = Array.from({ length: 5 }, (_, index) => ({ name: `skill-${index}`, description: `Workflow ${index}`, path: `/skills/skill-${index}/SKILL.md` }));
  let calls = 0;
  const context = await skillSuggestionContext({ prompt: "Complete all parts of this workflow." }, defaultConfig(), manySkills, async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    if (calls === 1) return Response.json({ answers: { ...Object.fromEntries(manySkills.map((_, index) => [`skill_${index}`, answer(0.45 + index * 0.05)])), open_choice: yesNo("no"), skill_hint: yesNo("yes") } });
    assert.equal(body.state.skills.length, 4);
    assert.equal(Object.keys(body.questions).length, 10);
    return Response.json({ answers: {
      ...Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`fit_${index}`, yesNo("yes")])),
      ...Object.fromEntries(Object.keys(body.questions).filter((name) => name.startsWith("pair_")).map((name) => [name, relation("complementary")])),
    } });
  }, async () => "test-key");
  assert.equal(calls, 2);
  assert.match(context ?? "", /skill-4/);
  assert.match(context ?? "", /可互补/);
  assert.doesNotMatch(context ?? "", /skill-0/);
});

test("low ranked scores can still yield a verified skill and never dump all top candidates", async () => {
  let calls = 0;
  const context = await skillSuggestionContext({ prompt: "Create a PDF report." }, defaultConfig(), skills, async () => {
    calls++;
    return Response.json(calls === 1
      ? { answers: { skill_0: answer(0.37), skill_1: answer(0.34), open_choice: yesNo("no"), skill_hint: yesNo("yes") } }
      : { answers: { fit_0: yesNo("yes"), fit_1: yesNo("no"), pair_0_1: relation("independent") } });
  }, async () => "test-key");
  assert.match(context ?? "", /\/skills\/pdf\/SKILL.md/);
  assert.doesNotMatch(context ?? "", /\/skills\/documents\/SKILL.md/);
});

test("Codex backend never inherits the Jev environment credential", () => {
  const prior = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "test-key";
  try { assert.equal(backendEnvironment().TYPESAFE_API_KEY, undefined); }
  finally { if (prior === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = prior; }
});
