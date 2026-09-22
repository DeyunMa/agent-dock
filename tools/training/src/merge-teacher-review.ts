import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultConfig, loadConfig } from "./legacy-router/config.js";
import {
  COMPLEXITIES,
  EXECUTION_INTENTS,
  SEMANTIC_CATEGORIES,
  type Complexity,
  type ExecutionIntent,
  type RouteName,
  type SemanticCategory,
} from "./legacy-router/types.js";
import {
  routeForLabels,
  type DatasetRecord,
} from "./prepare-dataset.js";
import { writePrivateAtomically as writeAtomically } from "./private-files.js";

interface ReviewManifest {
  schema_version: 1;
  source: string;
  source_sha256: string;
  total_records: number;
  batches: Array<{
    index: number;
    path: string;
    records: number;
    sha256: string;
  }>;
}

interface ReviewInput {
  schema_version: 1;
  id: string;
}

interface TeacherReviewResult {
  schema_version: 1;
  id: string;
  teacher_labels: {
    intent: ExecutionIntent;
    category: SemanticCategory;
    complexity: Complexity;
  };
  confidence: number;
  reason: string;
}

type LabelField = "intent" | "category" | "complexity" | "route";

interface TeacherReviewedRecord
  extends Omit<
    DatasetRecord,
    "eligible_for_seed_training" | "label_status" | "labels" | "evidence"
  > {
  eligible_for_training: boolean;
  label_status: "teacher_reviewed";
  labels: {
    intent: ExecutionIntent;
    category: SemanticCategory;
    complexity: Complexity;
    route: RouteName | "native";
  };
  teacher_review: {
    confidence: number;
    reason: string;
    source_label_status: DatasetRecord["label_status"];
    previous_labels: DatasetRecord["labels"];
    changed_fields: LabelField[];
  };
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const trainingDirectory = resolve(scriptDirectory, "..");
const projectDirectory = resolve(trainingDirectory, "../..");
const datasetPath = resolve(trainingDirectory, "work/v1/all.jsonl");
const reviewDirectory = resolve(trainingDirectory, "work/v1/teacher-review");
const inputDirectory = resolve(reviewDirectory, "input");
const resultDirectory = resolve(reviewDirectory, "results");
const outputDirectory = resolve(reviewDirectory, "merged");
const inputManifestPath = resolve(inputDirectory, "manifest.json");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseJsonl<T>(raw: string, path: string): T[] {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        throw new Error(`Invalid JSON at ${path}:${index + 1}`);
      }
    });
}

function asJsonl(items: unknown[]): string {
  return items.map((item) => JSON.stringify(item)).join("\n") + "\n";
}

function assertResult(
  value: TeacherReviewResult,
  path: string,
  line: number,
): void {
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "confidence",
    "id",
    "reason",
    "schema_version",
    "teacher_labels",
  ];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `Unexpected result fields at ${path}:${line}; prompt text and extra metadata are forbidden`,
    );
  }
  if (
    value.schema_version !== 1 ||
    typeof value.id !== "string" ||
    typeof value.reason !== "string" ||
    value.reason.length === 0 ||
    value.reason.length > 120 ||
    typeof value.confidence !== "number" ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    throw new Error(`Invalid result metadata at ${path}:${line}`);
  }
  const labelKeys = Object.keys(value.teacher_labels ?? {}).sort();
  const expectedLabelKeys = ["category", "complexity", "intent"];
  if (
    JSON.stringify(labelKeys) !== JSON.stringify(expectedLabelKeys)
  ) {
    throw new Error(`Unexpected teacher label fields at ${path}:${line}`);
  }
  if (
    !EXECUTION_INTENTS.includes(value.teacher_labels?.intent) ||
    !SEMANTIC_CATEGORIES.includes(value.teacher_labels?.category) ||
    !COMPLEXITIES.includes(value.teacher_labels?.complexity)
  ) {
    throw new Error(`Invalid teacher labels at ${path}:${line}`);
  }
}

function countBy<T>(
  items: T[],
  key: (item: T) => string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const value = key(item);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function transitionCounts(
  records: TeacherReviewedRecord[],
  field: LabelField,
): Record<string, number> {
  return countBy(records, (record) => {
    const before = record.teacher_review.previous_labels[field];
    const after = record.labels[field];
    return `${before} -> ${after}`;
  });
}

function examplesBy(
  records: TeacherReviewedRecord[],
  key: (record: TeacherReviewedRecord) => string,
): Record<string, string[]> {
  const groups = new Map<string, TeacherReviewedRecord[]>();
  for (const record of records) {
    const label = key(record);
    const group = groups.get(label) ?? [];
    group.push(record);
    groups.set(label, group);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([label, group]) => [
        label,
        group
          .filter((record) => record.text.length <= 500)
          .sort((left, right) => left.id.localeCompare(right.id))
          .slice(0, 10)
          .map((record) => record.text),
      ]),
  );
}

function markdownExamples(
  title: string,
  groups: Record<string, string[]>,
): string {
  const lines = [`## ${title}`, ""];
  for (const [label, examples] of Object.entries(groups)) {
    lines.push(`### ${label}`, "");
    if (examples.length === 0) {
      lines.push("_No examples_", "");
      continue;
    }
    examples.forEach((example, index) => {
      lines.push(`${index + 1}. ${example}`);
    });
    lines.push("");
  }
  return lines.join("\n");
}

async function currentConfig() {
  try {
    return await loadConfig();
  } catch {
    return defaultConfig();
  }
}

async function main(): Promise<void> {
  const [datasetRaw, manifestRaw, config] = await Promise.all([
    readFile(datasetPath, "utf8"),
    readFile(inputManifestPath, "utf8"),
    currentConfig(),
  ]);
  const manifest = JSON.parse(manifestRaw) as ReviewManifest;
  if (
    manifest.schema_version !== 1 ||
    manifest.source_sha256 !== sha256(datasetRaw)
  ) {
    throw new Error("Review input manifest does not match the current dataset");
  }

  const sourceRecords = parseJsonl<DatasetRecord>(datasetRaw, datasetPath);
  if (
    sourceRecords.length !== manifest.total_records ||
    new Set(sourceRecords.map((record) => record.id)).size !==
      sourceRecords.length
  ) {
    throw new Error("Source dataset count or uniqueness check failed");
  }

  const reviewById = new Map<string, TeacherReviewResult>();
  for (const batch of manifest.batches) {
    const inputPath = resolve(projectDirectory, batch.path);
    const resultPath = resolve(
      resultDirectory,
      `batch-${String(batch.index).padStart(2, "0")}.jsonl`,
    );
    const [inputRaw, resultRaw] = await Promise.all([
      readFile(inputPath, "utf8"),
      readFile(resultPath, "utf8"),
    ]);
    if (sha256(inputRaw) !== batch.sha256) {
      throw new Error(`Review input was modified: ${inputPath}`);
    }
    const inputs = parseJsonl<ReviewInput>(inputRaw, inputPath);
    const results = parseJsonl<TeacherReviewResult>(resultRaw, resultPath);
    if (
      inputs.length !== batch.records ||
      results.length !== batch.records
    ) {
      throw new Error(
        `Review count mismatch for batch ${batch.index}: expected ${batch.records}, got ${results.length}`,
      );
    }
    results.forEach((result, index) => {
      assertResult(result, resultPath, index + 1);
      if (result.id !== inputs[index]?.id) {
        throw new Error(
          `Review id/order mismatch at ${resultPath}:${index + 1}`,
        );
      }
      if (reviewById.has(result.id)) {
        throw new Error(`Duplicate reviewed id: ${result.id}`);
      }
      reviewById.set(result.id, result);
    });
  }

  if (reviewById.size !== sourceRecords.length) {
    throw new Error(
      `Review coverage mismatch: expected ${sourceRecords.length}, got ${reviewById.size}`,
    );
  }

  const reviewedRecords: TeacherReviewedRecord[] = sourceRecords.map(
    (record) => {
      const review = reviewById.get(record.id);
      if (!review) {
        throw new Error(`Missing review for ${record.id}`);
      }
      const route = routeForLabels(
        review.teacher_labels.category,
        review.teacher_labels.complexity,
        config,
      );
      const labels = { ...review.teacher_labels, route };
      const changedFields = (
        ["intent", "category", "complexity", "route"] as const
      ).filter((field) => record.labels[field] !== labels[field]);
      const eligible =
        review.confidence >= 0.8 &&
        review.teacher_labels.intent !== "unknown";

      return {
        schema_version: 1,
        id: record.id,
        thread_id: record.thread_id,
        ...(record.timestamp ? { timestamp: record.timestamp } : {}),
        prompt_hash: record.prompt_hash,
        text: record.text,
        chars: record.chars,
        language: record.language,
        split: record.split,
        eligible_for_training: eligible,
        label_status: "teacher_reviewed",
        labels,
        teacher_review: {
          confidence: review.confidence,
          reason: review.reason,
          source_label_status: record.label_status,
          previous_labels: record.labels,
          changed_fields: changedFields,
        },
      };
    },
  );
  const trainable = reviewedRecords.filter(
    (record) => record.eligible_for_training,
  );
  const lowConfidence = reviewedRecords.filter(
    (record) => !record.eligible_for_training,
  );
  const changed = reviewedRecords.filter(
    (record) => record.teacher_review.changed_fields.length > 0,
  );
  const splitRecords = {
    train: trainable.filter((record) => record.split === "train"),
    validation: trainable.filter(
      (record) => record.split === "validation",
    ),
    test: trainable.filter((record) => record.split === "test"),
  };
  const distributions = {
    intent: countBy(reviewedRecords, (record) => record.labels.intent),
    category: countBy(reviewedRecords, (record) => record.labels.category),
    complexity: countBy(
      reviewedRecords,
      (record) => record.labels.complexity,
    ),
    route: countBy(reviewedRecords, (record) => record.labels.route),
    confidence_band: countBy(reviewedRecords, (record) =>
      record.teacher_review.confidence >= 0.95
        ? "0.95-1.00"
        : record.teacher_review.confidence >= 0.8
          ? "0.80-0.94"
          : record.teacher_review.confidence >= 0.6
            ? "0.60-0.79"
            : "0.00-0.59",
    ),
  };
  const transitions = {
    intent: transitionCounts(reviewedRecords, "intent"),
    category: transitionCounts(reviewedRecords, "category"),
    complexity: transitionCounts(reviewedRecords, "complexity"),
    route: transitionCounts(reviewedRecords, "route"),
  };
  const changedFields = {
    intent: changed.filter((record) =>
      record.teacher_review.changed_fields.includes("intent"),
    ).length,
    category: changed.filter((record) =>
      record.teacher_review.changed_fields.includes("category"),
    ).length,
    complexity: changed.filter((record) =>
      record.teacher_review.changed_fields.includes("complexity"),
    ).length,
    route: changed.filter((record) =>
      record.teacher_review.changed_fields.includes("route"),
    ).length,
  };
  const manifestOutput = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source_dataset: relative(projectDirectory, datasetPath),
    source_sha256: sha256(datasetRaw),
    reviewed_records: reviewedRecords.length,
    reviewer_batches: manifest.batches.length,
    trainable_records: trainable.length,
    low_confidence_records: lowConfidence.length,
    changed_records: changed.length,
    unchanged_records: reviewedRecords.length - changed.length,
    changed_fields: changedFields,
    distributions,
    transitions,
    output_sha256: {
      teacher_reviewed: sha256(asJsonl(reviewedRecords)),
      teacher_trainable: sha256(asJsonl(trainable)),
      teacher_low_confidence: sha256(asJsonl(lowConfidence)),
    },
  };

  await mkdir(resolve(outputDirectory, "splits"), { recursive: true });
  await mkdir(resolve(outputDirectory, "reports"), { recursive: true });
  await writeAtomically(
    resolve(outputDirectory, "teacher-reviewed.jsonl"),
    asJsonl(reviewedRecords),
  );
  await writeAtomically(
    resolve(outputDirectory, "teacher-trainable.jsonl"),
    asJsonl(trainable),
  );
  await writeAtomically(
    resolve(outputDirectory, "teacher-low-confidence.jsonl"),
    asJsonl(lowConfidence),
  );
  await writeAtomically(
    resolve(outputDirectory, "splits/train.jsonl"),
    asJsonl(splitRecords.train),
  );
  await writeAtomically(
    resolve(outputDirectory, "splits/validation.jsonl"),
    asJsonl(splitRecords.validation),
  );
  await writeAtomically(
    resolve(outputDirectory, "splits/test.jsonl"),
    asJsonl(splitRecords.test),
  );
  await writeAtomically(
    resolve(outputDirectory, "manifest.json"),
    `${JSON.stringify(manifestOutput, null, 2)}\n`,
  );
  const examples = {
    intent: examplesBy(reviewedRecords, (record) => record.labels.intent),
    category: examplesBy(reviewedRecords, (record) => record.labels.category),
    complexity: examplesBy(
      reviewedRecords,
      (record) => record.labels.complexity,
    ),
    route: examplesBy(reviewedRecords, (record) => record.labels.route),
  };
  const report = [
    "# Teacher-reviewed Router dataset",
    "",
    `Generated: ${manifestOutput.generated_at}`,
    "",
    "All prompts below were sanitized before review. This directory is ignored by Git.",
    "",
    "## Summary",
    "",
    "```json",
    JSON.stringify(
      {
        reviewed_records: manifestOutput.reviewed_records,
        trainable_records: manifestOutput.trainable_records,
        low_confidence_records: manifestOutput.low_confidence_records,
        changed_records: manifestOutput.changed_records,
        unchanged_records: manifestOutput.unchanged_records,
        changed_fields: manifestOutput.changed_fields,
        distributions,
      },
      null,
      2,
    ),
    "```",
    "",
    markdownExamples("Intent examples", examples.intent),
    markdownExamples("Category examples", examples.category),
    markdownExamples("Complexity examples", examples.complexity),
    markdownExamples("Route examples", examples.route),
  ].join("\n");
  await writeAtomically(
    resolve(outputDirectory, "reports/teacher-review.md"),
    `${report}\n`,
  );
  process.stdout.write(`${JSON.stringify(manifestOutput, null, 2)}\n`);
}

const entrypoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entrypoint === import.meta.url) {
  await main();
}
