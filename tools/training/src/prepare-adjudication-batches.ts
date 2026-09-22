import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Complexity, ExecutionIntent, SemanticCategory } from "./legacy-router/types.js";
import { writePrivateAtomically as writeAtomically } from "./private-files.js";

interface FirstPassRecord {
  id: string;
  text: string;
  eligible_for_training: boolean;
  labels: {
    intent: ExecutionIntent;
    category: SemanticCategory;
    complexity: Complexity;
    route: string;
  };
  teacher_review: {
    confidence: number;
    previous_labels: {
      intent: ExecutionIntent;
      category: SemanticCategory;
      complexity: Complexity;
      route: string;
    };
  };
}

interface AdjudicationInput {
  schema_version: 1;
  id: string;
  text: string;
  first_pass_labels: {
    intent: ExecutionIntent;
    category: SemanticCategory;
    complexity: Complexity;
  };
  first_pass_confidence: number;
  selection_reasons: string[];
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const trainingDirectory = resolve(scriptDirectory, "..");
const projectDirectory = resolve(trainingDirectory, "../..");
const sourcePath = resolve(
  trainingDirectory,
  "work/v1/teacher-review/merged/teacher-reviewed.jsonl",
);
const outputDirectory = resolve(
  trainingDirectory,
  "work/v1/teacher-review/adjudication/input",
);
const rubricPath = resolve(trainingDirectory, "review-rubric.md");
const batchCount = 4;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asJsonl(items: unknown[]): string {
  return items.map((item) => JSON.stringify(item)).join("\n") + "\n";
}

async function main(): Promise<void> {
  const [source, rubric] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(rubricPath, "utf8"),
  ]);
  const records = source
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FirstPassRecord);
  const selected = records
    .map((record): AdjudicationInput | undefined => {
      const selectionReasons: string[] = [];
      if (!record.eligible_for_training) {
        selectionReasons.push("low_confidence_or_unknown");
      }
      if (record.labels.intent === "continue") {
        selectionReasons.push("continuation_boundary");
      }
      if (
        record.teacher_review.previous_labels.intent === "ask" &&
        record.labels.intent === "do"
      ) {
        selectionReasons.push("ask_to_do_authorization_risk");
      }
      if (
        record.labels.intent === "control" ||
        record.labels.complexity === "extreme"
      ) {
        selectionReasons.push("rare_high_impact_label");
      }
      if (selectionReasons.length === 0) return undefined;
      return {
        schema_version: 1,
        id: record.id,
        text: record.text,
        first_pass_labels: {
          intent: record.labels.intent,
          category: record.labels.category,
          complexity: record.labels.complexity,
        },
        first_pass_confidence: record.teacher_review.confidence,
        selection_reasons: selectionReasons,
      };
    })
    .filter((record): record is AdjudicationInput => record !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id));
  const batches: AdjudicationInput[][] = Array.from(
    { length: batchCount },
    () => [],
  );
  selected.forEach((record, index) => {
    batches[index % batchCount]!.push(record);
  });

  await mkdir(outputDirectory, { recursive: true });
  const manifestBatches = [];
  for (const [index, batch] of batches.entries()) {
    const filename = `batch-${String(index + 1).padStart(2, "0")}.jsonl`;
    const path = resolve(outputDirectory, filename);
    const content = asJsonl(batch);
    await writeAtomically(path, content);
    manifestBatches.push({
      index: index + 1,
      path: relative(projectDirectory, path),
      records: batch.length,
      sha256: sha256(content),
    });
  }
  const manifest = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source: relative(projectDirectory, sourcePath),
    source_sha256: sha256(source),
    rubric: relative(projectDirectory, rubricPath),
    rubric_sha256: sha256(rubric),
    total_records: selected.length,
    batch_count: batchCount,
    selection_policy: {
      low_confidence_or_unknown: true,
      all_continue: true,
      all_ask_to_do_transitions: true,
      all_control_or_extreme: true,
    },
    batches: manifestBatches,
  };
  await writeAtomically(
    resolve(outputDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

await main();
