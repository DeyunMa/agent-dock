import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatasetRecord } from "./prepare-dataset.js";
import { writePrivateAtomically as writeAtomically } from "./private-files.js";

interface ReviewInput {
  schema_version: 1;
  id: string;
  text: string;
  language: DatasetRecord["language"];
  label_status: DatasetRecord["label_status"];
  current_labels: DatasetRecord["labels"];
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const trainingDirectory = resolve(scriptDirectory, "..");
const projectDirectory = resolve(trainingDirectory, "../..");
const datasetPath = resolve(trainingDirectory, "work/v1/all.jsonl");
const outputDirectory = resolve(
  trainingDirectory,
  "work/v1/teacher-review/input",
);
const batchCount = 12;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asJsonl(items: unknown[]): string {
  return items.map((item) => JSON.stringify(item)).join("\n") + "\n";
}

async function main(): Promise<void> {
  const source = await readFile(datasetPath, "utf8");
  const records = source
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DatasetRecord)
    .sort((left, right) => left.id.localeCompare(right.id));

  if (records.length === 0) {
    throw new Error(`No records found in ${datasetPath}`);
  }

  const batches: ReviewInput[][] = Array.from(
    { length: batchCount },
    () => [],
  );
  records.forEach((record, index) => {
    batches[index % batchCount]!.push({
      schema_version: 1,
      id: record.id,
      text: record.text,
      language: record.language,
      label_status: record.label_status,
      current_labels: record.labels,
    });
  });

  await mkdir(outputDirectory, { recursive: true });
  const manifestBatches: Array<{
    index: number;
    path: string;
    records: number;
    sha256: string;
  }> = [];

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
    source: relative(projectDirectory, datasetPath),
    source_sha256: sha256(source),
    total_records: records.length,
    batch_count: batchCount,
    review_contract: "tools/training/review-rubric.md",
    batches: manifestBatches,
  };
  const manifestPath = resolve(outputDirectory, "manifest.json");
  await writeAtomically(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

await main();
