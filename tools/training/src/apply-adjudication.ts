import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig, loadConfig } from "./legacy-router/config.js";
import {
  COMPLEXITIES,
  EXECUTION_INTENTS,
  SEMANTIC_CATEGORIES,
  type Complexity,
  type ExecutionIntent,
  type SemanticCategory,
} from "./legacy-router/types.js";
import { routeForLabels } from "./prepare-dataset.js";
import { writePrivateAtomically as writeAtomically } from "./private-files.js";

interface ReviewManifest {
  schema_version: 1;
  source: string;
  source_sha256: string;
  rubric: string;
  rubric_sha256: string;
  total_records: number;
  batches: Array<{
    index: number;
    path: string;
    records: number;
    sha256: string;
  }>;
}

interface AdjudicationInput {
  id: string;
}

interface SemanticLabels {
  intent: ExecutionIntent;
  category: SemanticCategory;
  complexity: Complexity;
}

interface AdjudicationResult {
  schema_version: 1;
  id: string;
  verdict: "agree" | "correct";
  teacher_labels: SemanticLabels;
  confidence: number;
  reason: string;
}

interface FirstPassRecord {
  id: string;
  split: "train" | "validation" | "test";
  text: string;
  labels: SemanticLabels & { route: string };
  eligible_for_training: boolean;
  teacher_review: {
    confidence: number;
  };
}

type AdjudicatedRecord = Omit<
  FirstPassRecord,
  "labels" | "eligible_for_training"
> & {
  labels: SemanticLabels & { route: string };
  eligible_for_training: boolean;
  adjudication?: {
    verdict: "agree" | "correct";
    confidence: number;
    reason: string;
    previous_teacher_labels: SemanticLabels;
    changed_fields: Array<keyof SemanticLabels>;
  };
};

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const trainingDirectory = resolve(scriptDirectory, "..");
const projectDirectory = resolve(trainingDirectory, "../..");
const adjudicationDirectory = resolve(
  trainingDirectory,
  "work/v1/teacher-review/adjudication",
);
const inputDirectory = resolve(adjudicationDirectory, "input");
const resultDirectory = resolve(adjudicationDirectory, "results");
const outputDirectory = resolve(adjudicationDirectory, "final");
const manifestPath = resolve(inputDirectory, "manifest.json");
const rubricPath = resolve(trainingDirectory, "review-rubric.md");

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

function semanticLabels(labels: FirstPassRecord["labels"]): SemanticLabels {
  return {
    intent: labels.intent,
    category: labels.category,
    complexity: labels.complexity,
  };
}

function assertResult(
  value: AdjudicationResult,
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
    "verdict",
  ];
  const labelKeys = Object.keys(value.teacher_labels ?? {}).sort();
  if (
    JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
    JSON.stringify(labelKeys) !==
      JSON.stringify(["category", "complexity", "intent"])
  ) {
    throw new Error(`Unexpected fields at ${path}:${line}`);
  }
  if (
    value.schema_version !== 1 ||
    typeof value.id !== "string" ||
    (value.verdict !== "agree" && value.verdict !== "correct") ||
    typeof value.confidence !== "number" ||
    value.confidence < 0 ||
    value.confidence > 1 ||
    typeof value.reason !== "string" ||
    value.reason.length === 0 ||
    value.reason.length > 120 ||
    !EXECUTION_INTENTS.includes(value.teacher_labels.intent) ||
    !SEMANTIC_CATEGORIES.includes(value.teacher_labels.category) ||
    !COMPLEXITIES.includes(value.teacher_labels.complexity)
  ) {
    throw new Error(`Invalid adjudication at ${path}:${line}`);
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

function examplesBy(
  records: AdjudicatedRecord[],
  key: (record: AdjudicatedRecord) => string,
): Record<string, string[]> {
  const groups = new Map<string, AdjudicatedRecord[]>();
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
  const [manifestRaw, rubricRaw, config] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(rubricPath, "utf8"),
    currentConfig(),
  ]);
  const manifest = JSON.parse(manifestRaw) as ReviewManifest;
  const sourcePath = resolve(projectDirectory, manifest.source);
  const sourceRaw = await readFile(sourcePath, "utf8");
  if (
    manifest.schema_version !== 1 ||
    manifest.source_sha256 !== sha256(sourceRaw) ||
    manifest.rubric_sha256 !== sha256(rubricRaw)
  ) {
    throw new Error("Adjudication source or rubric changed");
  }
  const sourceRecords = parseJsonl<FirstPassRecord>(sourceRaw, sourcePath);
  const resultById = new Map<string, AdjudicationResult>();
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
      throw new Error(`Adjudication input was modified: ${inputPath}`);
    }
    const inputs = parseJsonl<AdjudicationInput>(inputRaw, inputPath);
    const results = parseJsonl<AdjudicationResult>(resultRaw, resultPath);
    if (
      inputs.length !== batch.records ||
      results.length !== batch.records
    ) {
      throw new Error(`Adjudication count mismatch for batch ${batch.index}`);
    }
    results.forEach((result, index) => {
      assertResult(result, resultPath, index + 1);
      if (result.id !== inputs[index]?.id || resultById.has(result.id)) {
        throw new Error(
          `Adjudication id/order mismatch at ${resultPath}:${index + 1}`,
        );
      }
      resultById.set(result.id, result);
    });
  }
  if (resultById.size !== manifest.total_records) {
    throw new Error(
      `Adjudication coverage mismatch: expected ${manifest.total_records}, got ${resultById.size}`,
    );
  }

  const finalRecords: AdjudicatedRecord[] = sourceRecords.map((record) => {
    const adjudication = resultById.get(record.id);
    if (!adjudication) return record;
    const previous = semanticLabels(record.labels);
    const changedFields = (
      ["intent", "category", "complexity"] as const
    ).filter(
      (field) => previous[field] !== adjudication.teacher_labels[field],
    );
    if (
      (adjudication.verdict === "agree" && changedFields.length > 0) ||
      (adjudication.verdict === "correct" && changedFields.length === 0)
    ) {
      throw new Error(`Adjudication verdict/labels disagree for ${record.id}`);
    }
    const labels = {
      ...adjudication.teacher_labels,
      route: routeForLabels(
        adjudication.teacher_labels.category,
        adjudication.teacher_labels.complexity,
        config,
      ),
    };
    return {
      ...record,
      eligible_for_training:
        adjudication.confidence >= 0.8 &&
        adjudication.teacher_labels.intent !== "unknown",
      labels,
      adjudication: {
        verdict: adjudication.verdict,
        confidence: adjudication.confidence,
        reason: adjudication.reason,
        previous_teacher_labels: previous,
        changed_fields: changedFields,
      },
    };
  });
  const trainable = finalRecords.filter(
    (record) => record.eligible_for_training,
  );
  const lowConfidence = finalRecords.filter(
    (record) => !record.eligible_for_training,
  );
  const corrected = finalRecords.filter(
    (record) => record.adjudication?.verdict === "correct",
  );
  const splitRecords = {
    train: trainable.filter((record) => record.split === "train"),
    validation: trainable.filter((record) => record.split === "validation"),
    test: trainable.filter((record) => record.split === "test"),
  };
  const distributions = {
    intent: countBy(finalRecords, (record) => record.labels.intent),
    category: countBy(finalRecords, (record) => record.labels.category),
    complexity: countBy(finalRecords, (record) => record.labels.complexity),
    route: countBy(finalRecords, (record) => record.labels.route),
  };
  const correctionChangedFields = {
    intent: corrected.filter((record) =>
      record.adjudication?.changed_fields.includes("intent"),
    ).length,
    category: corrected.filter((record) =>
      record.adjudication?.changed_fields.includes("category"),
    ).length,
    complexity: corrected.filter((record) =>
      record.adjudication?.changed_fields.includes("complexity"),
    ).length,
  };
  const outputManifest = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    first_pass_source: relative(projectDirectory, sourcePath),
    reviewed_records: finalRecords.length,
    adjudicated_records: resultById.size,
    adjudication_agreements:
      resultById.size - corrected.length,
    adjudication_corrections: corrected.length,
    correction_changed_fields: correctionChangedFields,
    trainable_records: trainable.length,
    low_confidence_records: lowConfidence.length,
    splits: {
      train: splitRecords.train.length,
      validation: splitRecords.validation.length,
      test: splitRecords.test.length,
    },
    distributions,
    output_sha256: {
      final_reviewed: sha256(asJsonl(finalRecords)),
      final_trainable: sha256(asJsonl(trainable)),
      final_low_confidence: sha256(asJsonl(lowConfidence)),
    },
  };

  await mkdir(resolve(outputDirectory, "splits"), { recursive: true });
  await writeAtomically(
    resolve(outputDirectory, "teacher-reviewed-final.jsonl"),
    asJsonl(finalRecords),
  );
  await writeAtomically(
    resolve(outputDirectory, "teacher-trainable-final.jsonl"),
    asJsonl(trainable),
  );
  await writeAtomically(
    resolve(outputDirectory, "teacher-low-confidence-final.jsonl"),
    asJsonl(lowConfidence),
  );
  await writeAtomically(
    resolve(outputDirectory, "adjudication-corrections.jsonl"),
    asJsonl(corrected),
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
    `${JSON.stringify(outputManifest, null, 2)}\n`,
  );
  const examples = {
    intent: examplesBy(finalRecords, (record) => record.labels.intent),
    category: examplesBy(finalRecords, (record) => record.labels.category),
    complexity: examplesBy(
      finalRecords,
      (record) => record.labels.complexity,
    ),
    route: examplesBy(finalRecords, (record) => record.labels.route),
  };
  const correctionExamples = corrected
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, 30)
    .map((record, index) => {
      const before = record.adjudication?.previous_teacher_labels;
      const after = semanticLabels(record.labels);
      return [
        `${index + 1}. ${record.text}`,
        `   - before: ${JSON.stringify(before)}`,
        `   - after: ${JSON.stringify(after)}`,
        `   - reason: ${record.adjudication?.reason}`,
      ].join("\n");
    });
  const report = [
    "# Final teacher-reviewed Router dataset",
    "",
    `Generated: ${outputManifest.generated_at}`,
    "",
    "This report contains sanitized local examples and is ignored by Git.",
    "",
    "## Summary",
    "",
    "```json",
    JSON.stringify(
      {
        reviewed_records: outputManifest.reviewed_records,
        adjudicated_records: outputManifest.adjudicated_records,
        adjudication_agreements: outputManifest.adjudication_agreements,
        adjudication_corrections: outputManifest.adjudication_corrections,
        correction_changed_fields: correctionChangedFields,
        trainable_records: outputManifest.trainable_records,
        low_confidence_records: outputManifest.low_confidence_records,
        splits: outputManifest.splits,
        distributions,
      },
      null,
      2,
    ),
    "```",
    "",
    "## Adjudication correction examples",
    "",
    ...(correctionExamples.length > 0
      ? correctionExamples
      : ["_No corrections_"]),
    "",
    markdownExamples("Intent examples", examples.intent),
    markdownExamples("Category examples", examples.category),
    markdownExamples("Complexity examples", examples.complexity),
    markdownExamples("Route examples", examples.route),
  ].join("\n");
  await mkdir(resolve(outputDirectory, "reports"), { recursive: true });
  await writeAtomically(
    resolve(outputDirectory, "reports/final-review.md"),
    `${report}\n`,
  );
  process.stdout.write(`${JSON.stringify(outputManifest, null, 2)}\n`);
}

await main();
