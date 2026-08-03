import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { defaultConfig } from "../../src/router/core/config.js";
import { EmbeddingClassifier } from "../../src/router/core/embedding-classifier.js";

interface BundleManifest {
  schema_version: number;
  bundle_version: string;
  embedding_model: string;
  embedding_model_digest: string;
  embedding_dimensions: number;
  contains_prompt_text: boolean;
  files: Record<string, { sha256: string }>;
}

const bundleDirectory = resolve("resources/router/classifier-v1");
const requiredHeads = ["intent.json", "category.json", "complexity.json"] as const;
const publishedHeadFields = [
  "class_weight",
  "classes",
  "coefficients",
  "effective_train_sha256",
  "embedding_dimensions",
  "embedding_max_chars",
  "embedding_model",
  "embedding_model_digest",
  "embedding_preprocessing",
  "intercepts",
  "kind",
  "max_iter",
  "normalization",
  "random_state",
  "regularization_c",
  "schema_version",
  "solver",
  "source_train_sha256",
  "target",
].sort();

test("published classifier bundle matches its manifest and runtime schema", async () => {
  const manifest = JSON.parse(
    await readFile(resolve(bundleDirectory, "manifest.json"), "utf8"),
  ) as BundleManifest;
  const config = defaultConfig().classifier;

  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.bundle_version, "1.3.0");
  assert.equal(manifest.embedding_model, config.model);
  assert.equal(manifest.embedding_model_digest, config.modelDigest);
  assert.equal(manifest.embedding_dimensions, 1024);
  assert.equal(manifest.contains_prompt_text, false);
  assert.deepEqual(Object.keys(manifest.files).sort(), [...requiredHeads].sort());

  for (const file of requiredHeads) {
    const contents = await readFile(resolve(bundleDirectory, file));
    assert.equal(
      createHash("sha256").update(contents).digest("hex"),
      manifest.files[file]?.sha256,
      `${file} checksum must match manifest`,
    );
    const head = JSON.parse(contents.toString("utf8")) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(head).sort(),
      publishedHeadFields,
      `${file} must contain only approved runtime fields`,
    );
  }

  const embedding = new Array<number>(manifest.embedding_dimensions).fill(0);
  embedding[0] = 1;
  const classifier = new EmbeddingClassifier(
    { ...config, modelDirectory: bundleDirectory },
    async () =>
      new Response(JSON.stringify({ embeddings: [embedding] }), { status: 200 }),
  );
  const result = await classifier.classify("verify published classifier bundle");
  assert.equal(result.status, "ok");
  assert.ok(result.decision);
});
