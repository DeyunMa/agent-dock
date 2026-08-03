import { createHash } from "node:crypto";
import {
  COMPLEXITIES,
  EXECUTION_INTENTS,
  SEMANTIC_CATEGORIES,
  type Complexity,
  type ExecutionIntent,
  type SemanticCategory,
} from "../../../src/router/core/types.js";

export const SYNTHETIC_SCHEMA_VERSION = 1 as const;
export const SYNTHETIC_MIN_REVIEW_CONFIDENCE = 0.8;

export const SYNTHETIC_BATCH_SPECS = [
  {
    id: "batch-01",
    title: "Router control versus Router configuration changes",
    target: 120,
    families: {
      router_control_positive: 90,
      router_config_change_negative: 30,
    },
  },
  {
    id: "batch-02",
    title: "Extreme versus complex workload boundary",
    target: 120,
    families: {
      genuine_extreme: 50,
      complex_not_extreme: 70,
    },
  },
  {
    id: "batch-03",
    title: "Continue, explicit action, and unknown fragment boundary",
    target: 120,
    families: {
      continuation_context: 45,
      explicit_action_short: 55,
      underspecified_fragment: 20,
    },
  },
  {
    id: "batch-04",
    title: "Polite ask versus authorized action boundary",
    target: 120,
    families: {
      polite_question: 60,
      polite_authorized_action: 60,
    },
  },
  {
    id: "batch-05",
    title: "Agent workflow, implementation, and operation category boundary",
    target: 120,
    families: {
      agent_workflow: 40,
      implement_change: 40,
      operate_verify: 40,
    },
  },
  {
    id: "batch-06",
    title: "Underrepresented engineering categories",
    target: 120,
    families: {
      diagnose_fix: 30,
      create_artifact: 25,
      plan_design: 25,
      audit_analyze: 20,
      research_explain: 20,
    },
  },
] as const;

export type SyntheticBatchSpec = (typeof SYNTHETIC_BATCH_SPECS)[number];
export type SyntheticBatchId = SyntheticBatchSpec["id"];
type FamilyKeys<T> = T extends { families: infer Families } ? keyof Families : never;
export type SyntheticFamily = FamilyKeys<SyntheticBatchSpec>;
export type SyntheticLanguage = "zh" | "en" | "mixed";
export type SyntheticDifficulty = "medium" | "hard";

export interface SyntheticLabels {
  intent: ExecutionIntent;
  category: SemanticCategory;
  complexity: Complexity;
}

export interface SyntheticRecord {
  schema_version: typeof SYNTHETIC_SCHEMA_VERSION;
  id: string;
  batch_id: SyntheticBatchId;
  family: SyntheticFamily;
  text: string;
  language: SyntheticLanguage;
  difficulty: SyntheticDifficulty;
  labels: SyntheticLabels;
  rationale: string;
}

export interface SyntheticReviewResult {
  schema_version: typeof SYNTHETIC_SCHEMA_VERSION;
  id: string;
  verdict: "agree" | "correct" | "reject";
  labels: SyntheticLabels;
  confidence: number;
  reason: string;
}

function assertFamilyLabels(
  family: SyntheticFamily,
  labels: SyntheticLabels,
  id: string,
): void {
  const expect = (condition: boolean, description: string): void => {
    if (!condition) throw new Error(`${id} family ${family} requires ${description}`);
  };
  switch (family) {
    case "router_control_positive":
      expect(labels.intent === "control", "intent=control");
      expect(labels.category === "AGENT_WORKFLOW", "category=AGENT_WORKFLOW");
      break;
    case "router_config_change_negative":
      expect(labels.intent === "do", "intent=do");
      expect(labels.category === "AGENT_WORKFLOW", "category=AGENT_WORKFLOW");
      break;
    case "genuine_extreme":
      expect(labels.complexity === "extreme", "complexity=extreme");
      break;
    case "complex_not_extreme":
      expect(labels.complexity === "complex", "complexity=complex");
      break;
    case "continuation_context":
      expect(labels.intent === "continue", "intent=continue");
      expect(labels.category === "PASS_CONTEXT", "category=PASS_CONTEXT");
      break;
    case "explicit_action_short":
      expect(labels.intent === "do", "intent=do");
      expect(labels.category !== "PASS_CONTEXT", "a non-PASS_CONTEXT category");
      break;
    case "underspecified_fragment":
      expect(labels.intent === "unknown", "intent=unknown");
      expect(labels.category === "PASS_CONTEXT", "category=PASS_CONTEXT");
      break;
    case "polite_question":
      expect(labels.intent === "ask", "intent=ask");
      break;
    case "polite_authorized_action":
      expect(labels.intent === "do", "intent=do");
      break;
    case "agent_workflow":
      expect(labels.category === "AGENT_WORKFLOW", "category=AGENT_WORKFLOW");
      break;
    case "implement_change":
      expect(labels.category === "IMPLEMENT_CHANGE", "category=IMPLEMENT_CHANGE");
      break;
    case "operate_verify":
      expect(labels.category === "OPERATE_VERIFY", "category=OPERATE_VERIFY");
      break;
    case "diagnose_fix":
      expect(labels.category === "DIAGNOSE_FIX", "category=DIAGNOSE_FIX");
      break;
    case "create_artifact":
      expect(labels.category === "CREATE_ARTIFACT", "category=CREATE_ARTIFACT");
      break;
    case "plan_design":
      expect(labels.category === "PLAN_DESIGN", "category=PLAN_DESIGN");
      break;
    case "audit_analyze":
      expect(labels.category === "AUDIT_ANALYZE", "category=AUDIT_ANALYZE");
      break;
    case "research_explain":
      expect(labels.category === "RESEARCH_EXPLAIN", "category=RESEARCH_EXPLAIN");
      break;
  }
}

const batchIds = new Set<string>(SYNTHETIC_BATCH_SPECS.map((spec) => spec.id));
const families = new Set<string>(
  SYNTHETIC_BATCH_SPECS.flatMap((spec) => Object.keys(spec.families)),
);
const intents = new Set<string>(EXECUTION_INTENTS);
const categories = new Set<string>(SEMANTIC_CATEGORIES);
const complexities = new Set<string>(COMPLEXITIES);

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${name} has unexpected fields: ${actual.join(", ")}`);
  }
}

function nonEmptyString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${name} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

export function validateSyntheticLabels(value: unknown, name = "labels"): SyntheticLabels {
  const labels = object(value, name);
  exactKeys(labels, ["intent", "category", "complexity"], name);
  if (typeof labels.intent !== "string" || !intents.has(labels.intent)) {
    throw new Error(`${name}.intent is invalid`);
  }
  if (typeof labels.category !== "string" || !categories.has(labels.category)) {
    throw new Error(`${name}.category is invalid`);
  }
  if (typeof labels.complexity !== "string" || !complexities.has(labels.complexity)) {
    throw new Error(`${name}.complexity is invalid`);
  }
  return {
    intent: labels.intent as ExecutionIntent,
    category: labels.category as SemanticCategory,
    complexity: labels.complexity as Complexity,
  };
}

export function validateSyntheticRecord(
  value: unknown,
  expectedBatch?: SyntheticBatchSpec,
): SyntheticRecord {
  const record = object(value, "synthetic record");
  exactKeys(
    record,
    [
      "schema_version",
      "id",
      "batch_id",
      "family",
      "text",
      "language",
      "difficulty",
      "labels",
      "rationale",
    ],
    "synthetic record",
  );
  if (record.schema_version !== SYNTHETIC_SCHEMA_VERSION) {
    throw new Error("synthetic record schema_version is invalid");
  }
  const id = nonEmptyString(record.id, "synthetic record id", 80);
  const batchId = nonEmptyString(record.batch_id, "synthetic record batch_id", 20);
  const family = nonEmptyString(record.family, "synthetic record family", 80);
  if (!batchIds.has(batchId)) throw new Error(`unknown batch_id: ${batchId}`);
  if (!families.has(family)) throw new Error(`unknown family: ${family}`);
  if (expectedBatch && batchId !== expectedBatch.id) {
    throw new Error(`${id} belongs to ${batchId}, expected ${expectedBatch.id}`);
  }
  if (expectedBatch && !(family in expectedBatch.families)) {
    throw new Error(`${id} uses family ${family} outside ${expectedBatch.id}`);
  }
  if (!new RegExp(`^syn-v1-${batchId}-\\d{3}$`).test(id)) {
    throw new Error(`${id} does not follow syn-v1-${batchId}-NNN`);
  }
  const text = nonEmptyString(record.text, `${id}.text`, 3_500).trim();
  if (text.includes("[REDACTED_SECRET]") || text.includes("[REDACTED_EMAIL]")) {
    throw new Error(`${id}.text must not contain redaction placeholders`);
  }
  if (!["zh", "en", "mixed"].includes(String(record.language))) {
    throw new Error(`${id}.language is invalid`);
  }
  if (!["medium", "hard"].includes(String(record.difficulty))) {
    throw new Error(`${id}.difficulty is invalid`);
  }
  const labels = validateSyntheticLabels(record.labels, `${id}.labels`);
  assertFamilyLabels(family as SyntheticFamily, labels, id);
  return {
    schema_version: SYNTHETIC_SCHEMA_VERSION,
    id,
    batch_id: batchId as SyntheticBatchId,
    family: family as SyntheticFamily,
    text,
    language: record.language as SyntheticLanguage,
    difficulty: record.difficulty as SyntheticDifficulty,
    labels,
    rationale: nonEmptyString(record.rationale, `${id}.rationale`, 120),
  };
}

export function validateSyntheticBatch(
  values: readonly unknown[],
  spec: SyntheticBatchSpec,
): SyntheticRecord[] {
  const records = values.map((value) => validateSyntheticRecord(value, spec));
  if (records.length !== spec.target) {
    throw new Error(`${spec.id} has ${records.length} rows, expected ${spec.target}`);
  }
  const familyCounts: Record<string, number> = {};
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const expectedId = `syn-v1-${spec.id}-${String(index + 1).padStart(3, "0")}`;
    if (!record || record.id !== expectedId) {
      throw new Error(`${spec.id} row ${index + 1} must have id ${expectedId}`);
    }
    familyCounts[record.family] = (familyCounts[record.family] ?? 0) + 1;
  }
  for (const [family, expected] of Object.entries(spec.families)) {
    if (familyCounts[family] !== expected) {
      throw new Error(
        `${spec.id} family ${family} has ${familyCounts[family] ?? 0}, expected ${expected}`,
      );
    }
  }
  return records;
}

export function validateSyntheticReview(value: unknown): SyntheticReviewResult {
  const review = object(value, "synthetic review");
  exactKeys(
    review,
    ["schema_version", "id", "verdict", "labels", "confidence", "reason"],
    "synthetic review",
  );
  if (review.schema_version !== SYNTHETIC_SCHEMA_VERSION) {
    throw new Error("synthetic review schema_version is invalid");
  }
  const verdict = String(review.verdict);
  if (!["agree", "correct", "reject"].includes(verdict)) {
    throw new Error("synthetic review verdict is invalid");
  }
  if (
    typeof review.confidence !== "number" ||
    !Number.isFinite(review.confidence) ||
    review.confidence < 0 ||
    review.confidence > 1
  ) {
    throw new Error("synthetic review confidence must be between 0 and 1");
  }
  return {
    schema_version: SYNTHETIC_SCHEMA_VERSION,
    id: nonEmptyString(review.id, "synthetic review id", 80),
    verdict: verdict as SyntheticReviewResult["verdict"],
    labels: validateSyntheticLabels(review.labels, "synthetic review labels"),
    confidence: review.confidence,
    reason: nonEmptyString(review.reason, "synthetic review reason", 120),
  };
}

export function normalizeForDedupe(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableBucket(id: string, buckets: number): number {
  if (!Number.isInteger(buckets) || buckets < 1) throw new Error("buckets must be positive");
  return Number.parseInt(sha256(id).slice(0, 8), 16) % buckets;
}
