import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SYNTHETIC_BATCH_SPECS,
  SYNTHETIC_SCHEMA_VERSION,
  normalizeForDedupe,
  sha256,
  stableBucket,
  validateSyntheticBatch,
  type SyntheticRecord,
} from "./synthetic-contract.js";
import { redactSensitiveText } from "./redaction.js";
import {
  ensurePrivateDirectory,
  hardenPrivateTree,
  writePrivateAtomically as writeAtomically,
} from "./private-files.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptDirectory, "../..");
const root = resolve(projectDirectory, "local-training/work/v1/synthetic-v1");
const generationResults = resolve(root, "generation/results");
const reviewDirectory = resolve(root, "review");
const inputDirectory = resolve(reviewDirectory, "input");
const resultDirectory = resolve(reviewDirectory, "results");
const reviewerCount = 4;

interface SyntheticReviewInput {
  schema_version: 1;
  id: string;
  batch_id: SyntheticRecord["batch_id"];
  family: SyntheticRecord["family"];
  text: string;
  language: SyntheticRecord["language"];
  difficulty: SyntheticRecord["difficulty"];
  labels: SyntheticRecord["labels"];
}

function parseJsonl(source: string, name: string): unknown[] {
  return source
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error(`${name}:${index + 1} is not valid JSON`);
      }
    });
}

function asJsonl(records: readonly unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

async function main(): Promise<void> {
  await hardenPrivateTree(root);
  const records: SyntheticRecord[] = [];
  const ids = new Set<string>();
  const normalized = new Map<string, string>();
  const generationHashes: Record<string, string> = {};

  for (const spec of SYNTHETIC_BATCH_SPECS) {
    const path = resolve(generationResults, `${spec.id}.jsonl`);
    const source = await readFile(path, "utf8");
    generationHashes[spec.id] = sha256(source);
    const batch = validateSyntheticBatch(parseJsonl(source, spec.id), spec);
    for (const record of batch) {
      if (ids.has(record.id)) throw new Error(`duplicate synthetic id: ${record.id}`);
      ids.add(record.id);
      const key = normalizeForDedupe(record.text);
      const previous = normalized.get(key);
      if (previous) throw new Error(`exact normalized duplicate: ${previous} and ${record.id}`);
      if (redactSensitiveText(record.text) !== record.text) {
        throw new Error(`${record.id} contains data rejected by the redaction contract`);
      }
      normalized.set(key, record.id);
      records.push(record);
    }
  }

  const shards = Array.from({ length: reviewerCount }, () => [] as SyntheticReviewInput[]);
  for (const record of records) {
    shards[stableBucket(record.id, reviewerCount)]?.push({
      schema_version: 1,
      id: record.id,
      batch_id: record.batch_id,
      family: record.family,
      text: record.text,
      language: record.language,
      difficulty: record.difficulty,
      labels: record.labels,
    });
  }
  await ensurePrivateDirectory(inputDirectory);
  await ensurePrivateDirectory(resultDirectory);
  const batches = [];
  for (let index = 0; index < shards.length; index += 1) {
    const shard = shards[index] ?? [];
    shard.sort((left, right) => left.id.localeCompare(right.id));
    const filename = `batch-${String(index + 1).padStart(2, "0")}.jsonl`;
    const source = asJsonl(shard);
    await writeAtomically(resolve(inputDirectory, filename), source);
    batches.push({ filename, records: shard.length, sha256: sha256(source) });
  }
  const manifest = {
    schema_version: SYNTHETIC_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    source_records: records.length,
    source_hashes: generationHashes,
    result_contract: {
      fields: ["schema_version", "id", "verdict", "labels", "confidence", "reason"],
      prompt_text_forbidden: true,
      minimum_trainable_confidence: 0.8,
    },
    batches,
  };
  await writeAtomically(
    resolve(reviewDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await hardenPrivateTree(root);
  process.stdout.write(`${JSON.stringify({ records: records.length, batches })}\n`);
}

await main();
