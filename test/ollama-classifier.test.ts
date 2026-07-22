import assert from "node:assert/strict";
import test from "node:test";
import { OllamaClassifier } from "../src/routing/ollama-classifier.js";
import type { OllamaConfig } from "../src/routing/types.js";

const config: OllamaConfig = {
  enabled: true,
  baseUrl: "http://127.0.0.1:11434",
  model: "qwen-test",
  timeoutMs: 1_000,
  keepAlive: "5m",
  contextLength: 2_048,
  maxPromptChars: 2_000,
  minimumConfidence: 0.7,
};

test("Ollama classification requests intent and maps it independently", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        response: JSON.stringify({
          category: "IMPLEMENT",
          complexity: "complex",
          intent: "DO",
          confidence: 0.92,
        }),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const result = await new OllamaClassifier(config, fetchImpl).classify("实现并验证这个改动");

  assert.equal(result.status, "ok");
  assert.equal(result.decision?.category, "IMPLEMENT_CHANGE");
  assert.equal(result.decision?.complexity, "complex");
  assert.equal(result.decision?.intent, "do");

  const format = requestBody?.format as { required?: unknown[] } | undefined;
  assert.equal(format?.required?.includes("intent"), true);
});

test("an older classifier response without intent keeps routing data usable", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        response: JSON.stringify({
          category: "AUDIT",
          complexity: "normal",
          confidence: 0.81,
        }),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const result = await new OllamaClassifier(config, fetchImpl).classify("检查当前实现");

  assert.equal(result.status, "ok");
  assert.equal(result.decision?.category, "AUDIT_ANALYZE");
  assert.equal(result.decision?.complexity, "normal");
  assert.equal(result.decision?.intent, "unknown");
});
