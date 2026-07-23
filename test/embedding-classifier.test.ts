import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EmbeddingClassifier } from "../src/routing/embedding-classifier.js";
import { defaultConfig } from "../src/routing/config.js";
import {
  COMPLEXITIES,
  EXECUTION_INTENTS,
  SEMANTIC_CATEGORIES,
  type EmbeddingClassifierConfig,
} from "../src/routing/types.js";

const dimensions = 2;

function rows(classes: readonly string[], winner: string): number[][] {
  return classes.map((value) => (value === winner ? [0, 2] : [0, -1]));
}

async function modelDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-router-classifier-"));
  const config = defaultConfig().classifier;
  const heads = {
    intent: { classes: [...EXECUTION_INTENTS].sort(), winner: "do" },
    category: { classes: [...SEMANTIC_CATEGORIES].sort(), winner: "IMPLEMENT_CHANGE" },
    complexity: { classes: [...COMPLEXITIES].sort(), winner: "normal" },
  } as const;
  await Promise.all(
    Object.entries(heads).map(([target, value]) =>
      writeFile(
        join(directory, `${target}.json`),
        `${JSON.stringify({
          schema_version: 1,
          kind: "multinomial_logistic_regression",
          target,
          classes: value.classes,
          coefficients: rows(value.classes, value.winner),
          intercepts: value.classes.map(() => 0),
          embedding_model: config.model,
          embedding_model_digest: config.modelDigest,
          embedding_dimensions: dimensions,
          embedding_max_chars: 256,
          embedding_preprocessing: "collapse_whitespace_then_tail_v1",
          normalization: "l2_unit_embedding",
        })}\n`,
        { mode: 0o600 },
      ),
    ),
  );
  return directory;
}

async function classifierConfig(): Promise<EmbeddingClassifierConfig> {
  return {
    ...defaultConfig().classifier,
    modelDirectory: await modelDirectory(),
    timeoutMs: 500,
  };
}

test("embedding classifier loads linear heads and predicts all three targets", async () => {
  const config = await classifierConfig();
  let requestBody: Record<string, unknown> | undefined;
  const classifier = new EmbeddingClassifier(config, async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ embeddings: [[3, 4]] }), { status: 200 });
  });
  const result = await classifier.classify("  修改按钮   并运行测试  ");
  assert.equal(result.status, "ok");
  assert.equal(result.decision?.intent, "do");
  assert.equal(result.decision?.category, "IMPLEMENT_CHANGE");
  assert.equal(result.decision?.complexity, "normal");
  assert.equal(result.decision?.reason, "local_embedding_classifier");
  assert.deepEqual(requestBody, {
    model: "qwen3-embedding:0.6b",
    input: "修改按钮 并运行测试",
    keep_alive: "30m",
    truncate: true,
  });
});

test("embedding classifier rejects an incompatible embedding shape", async () => {
  const classifier = new EmbeddingClassifier(
    await classifierConfig(),
    async () =>
      new Response(JSON.stringify({ embeddings: [[1, 2, 3]] }), { status: 200 }),
  );
  const result = await classifier.classify("修改按钮");
  assert.equal(result.status, "invalid_response");
  assert.equal(result.decision, undefined);
});

test("disabled embedding classifier does not read artifacts or call Ollama", async () => {
  const config = defaultConfig().classifier;
  config.enabled = false;
  config.modelDirectory = "/path/that/does/not/exist";
  let calls = 0;
  const classifier = new EmbeddingClassifier(config, async () => {
    calls += 1;
    return new Response();
  });
  assert.deepEqual(await classifier.classify("hello"), { status: "disabled" });
  assert.equal(calls, 0);
});

test("warmup never blocks a concurrent first request behind a cold model", async () => {
  const config = await classifierConfig();
  let release: (() => void) | undefined;
  const classifier = new EmbeddingClassifier(
    config,
    async () =>
      new Promise<Response>((resolve) => {
        release = () =>
          resolve(new Response(JSON.stringify({ embeddings: [[3, 4]] }), { status: 200 }));
      }),
  );
  const warming = classifier.warmup();
  while (!release) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(await classifier.classify("hello"), { status: "warming" });
  release();
  await warming;
});
