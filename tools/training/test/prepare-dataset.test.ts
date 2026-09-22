import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "../src/legacy-router/config.js";
import {
  detectLanguage,
  isGeneratedContext,
  routeForLabels,
  sanitizePrompt,
  splitForThread,
} from "../src/prepare-dataset.js";
import { redactSensitiveText } from "../src/redaction.js";

test("sanitization extracts the explicit request without preserving attachment wrappers", () => {
  const value = sanitizePrompt(`
# Files mentioned by the user:

## secret.txt: /Users/mdy/secret.txt

## My request for Codex:
帮我 review RouterEngine，然后修复 tests。
`);
  assert.equal(value, "帮我 review RouterEngine，然后修复 tests。");
  assert.equal(value.includes("/Users/mdy"), false);
});

test("sanitization redacts secrets before a prompt can enter the project dataset", () => {
  const value = sanitizePrompt(
    "请检查 api_key=sk-1234567890abcdefghijklmnop 和 mdy@example.com 为什么不能使用",
  );
  assert.match(value, /\[REDACTED_SECRET]/);
  assert.match(value, /\[REDACTED_EMAIL]/);
  assert.equal(value.includes("sk-1234567890"), false);
});

test("redaction covers provider-prefixed tokens and natural-language passwords", () => {
  const value = redactSensitiveText(
    "API key给你：jina_7539073af55b4e64812ae1a7f976b111Lbs5，密码是admin123；登录测试用 admin123；这是token，请写入环境变量AbCdEf1234567890GhIjKlMnOpQrStUvWxYz。",
  );
  assert.equal(value.includes("jina_"), false);
  assert.equal(value.includes("admin123"), false);
  assert.equal(value.includes("AbCdEf1234567890"), false);
  assert.match(value, /\[REDACTED_SECRET]/);
});

test("generated plugin context without a user request is discarded", () => {
  assert.equal(
    sanitizePrompt("<recommended_plugins><plugin>Example</plugin></recommended_plugins>"),
    "",
  );
});

test("system-authored messages stored with a user role are not training prompts", () => {
  assert.equal(
    isGeneratedContext("# AGENTS.md instructions for /tmp/example\n<INSTRUCTIONS>test</INSTRUCTIONS>"),
    true,
  );
  assert.equal(
    isGeneratedContext(
      '<subagent_notification>{"agent_path":"id","status":"shutdown"}</subagent_notification>',
    ),
    true,
  );
  assert.equal(
    isGeneratedContext(
      "<turn_aborted>The user interrupted the previous turn on purpose.</turn_aborted>",
    ),
    true,
  );
  assert.equal(isGeneratedContext("继续执行"), false);
});

test("language detection distinguishes Chinese, English and mixed development prompts", () => {
  assert.equal(detectLanguage("请解释这个设计为什么合理"), "zh");
  assert.equal(detectLanguage("Explain why this design is correct"), "en");
  assert.equal(detectLanguage("请 review RouterEngine 的 fallback 逻辑"), "mixed");
});

test("dataset split is deterministic at the thread seam", () => {
  const first = splitForThread("019f83d2-7adb-7001-a96a-fc90e38a1b23");
  assert.equal(splitForThread("019f83d2-7adb-7001-a96a-fc90e38a1b23"), first);
  assert.ok(["train", "validation", "test"].includes(first));
});

test("reviewed semantic labels derive routes from the current Router contract", () => {
  const config = defaultConfig();
  assert.equal(routeForLabels("PASS_CONTEXT", "complex", config), "native");
  assert.equal(routeForLabels("RESEARCH_EXPLAIN", "simple", config), "quick");
  assert.equal(routeForLabels("AUDIT_ANALYZE", "complex", config), "deep");
  assert.equal(routeForLabels("IMPLEMENT_CHANGE", "extreme", config), "max");
});
