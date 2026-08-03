import assert from "node:assert/strict";
import test from "node:test";
import { dedupeTrainingBundle, type BundleRecord } from "../src/pretraining-bundle.js";

function record(
  id: string,
  text: string,
  split: BundleRecord["split"],
  provenance: BundleRecord["provenance"] = "real_teacher_reviewed",
): BundleRecord {
  return { id, text, split, provenance };
}

test("bundle dedupe preserves frozen test and drops a colliding train row", () => {
  const result = dedupeTrainingBundle([
    record("train-real", "检查 Router 配置", "train"),
    record("test-real", "检查 Router 配置！", "test"),
  ]);
  assert.deepEqual(result.kept.map((item) => item.id), ["test-real"]);
  assert.equal(result.dropped[0]?.dropped_id, "train-real");
});

test("bundle dedupe prefers real validation over synthetic and train rows", () => {
  const result = dedupeTrainingBundle([
    record("train-real", "同一个请求", "train"),
    record("validation-synthetic", "同一个请求。", "validation", "synthetic_v1"),
    record("validation-real", "同一个请求！", "validation"),
  ]);
  assert.deepEqual(result.kept.map((item) => item.id), ["validation-real"]);
  assert.equal(result.dropped.length, 2);
});

test("bundle dedupe refuses to mutate a duplicated frozen test", () => {
  assert.throws(
    () =>
      dedupeTrainingBundle([
        record("test-a", "保持测试集", "test"),
        record("test-b", "保持测试集。", "test"),
      ]),
    /frozen real test contains duplicate prompts/,
  );
});
