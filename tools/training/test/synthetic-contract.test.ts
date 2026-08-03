import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeForDedupe,
  stableBucket,
  SYNTHETIC_BATCH_SPECS,
  validateSyntheticBatch,
  validateSyntheticRecord,
  validateSyntheticReview,
} from "../src/synthetic-contract.js";

const validRecord = {
  schema_version: 1,
  id: "syn-v1-batch-01-001",
  batch_id: "batch-01",
  family: "router_control_positive",
  text: "恢复自动路由",
  language: "zh",
  difficulty: "hard",
  labels: {
    intent: "control",
    category: "AGENT_WORKFLOW",
    complexity: "simple",
  },
  rationale: "直接控制 Router 运行模式",
};

test("synthetic generation contract accepts a valid hard-boundary record", () => {
  assert.deepEqual(validateSyntheticRecord(validRecord).labels, validRecord.labels);
});

test("synthetic generation contract rejects prompt-bearing extra fields", () => {
  assert.throws(
    () => validateSyntheticRecord({ ...validRecord, raw_prompt: "forbidden" }),
    /unexpected fields/,
  );
});

test("synthetic family quotas also constrain their semantic labels", () => {
  assert.throws(
    () =>
      validateSyntheticRecord({
        ...validRecord,
        labels: { ...validRecord.labels, intent: "do" },
      }),
    /requires intent=control/,
  );
});

test("synthetic batch contract requires the exact contiguous ID sequence", () => {
  const spec = SYNTHETIC_BATCH_SPECS[0];
  const records = Array.from({ length: spec.target }, (_, index) => ({
    ...validRecord,
    id: `syn-v1-batch-01-${String(index + 1).padStart(3, "0")}`,
    family: index < 90 ? "router_control_positive" : "router_config_change_negative",
    labels:
      index < 90
        ? validRecord.labels
        : { ...validRecord.labels, intent: "do" },
    text: `样本 ${index + 1}`,
  }));
  records[0] = { ...records[0]!, id: "syn-v1-batch-01-000" };
  assert.throws(() => validateSyntheticBatch(records, spec), /must have id/);
});

test("synthetic review contract requires label-only exact fields", () => {
  const review = validateSyntheticReview({
    schema_version: 1,
    id: validRecord.id,
    verdict: "agree",
    labels: validRecord.labels,
    confidence: 0.98,
    reason: "direct Router runtime control",
  });
  assert.equal(review.verdict, "agree");
  assert.throws(
    () =>
      validateSyntheticReview({
        ...review,
        text: validRecord.text,
      }),
    /unexpected fields/,
  );
});

test("dedupe normalization removes cosmetic punctuation and whitespace", () => {
  assert.equal(normalizeForDedupe("恢复 自动路由！"), normalizeForDedupe("恢复自动路由"));
});

test("stable buckets are deterministic", () => {
  assert.equal(stableBucket(validRecord.id, 4), stableBucket(validRecord.id, 4));
  assert.ok(stableBucket(validRecord.id, 4) >= 0);
  assert.ok(stableBucket(validRecord.id, 4) < 4);
});
