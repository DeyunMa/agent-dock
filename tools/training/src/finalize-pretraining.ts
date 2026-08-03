import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../../src/router/core/config.js";
import type {
  Complexity,
  ExecutionIntent,
  RouteName,
  SemanticCategory,
} from "../../../src/router/core/types.js";
import { routeForLabels } from "./prepare-dataset.js";
import { dedupeTrainingBundle } from "./pretraining-bundle.js";
import {
  hardenPrivateTree,
  writePrivateAtomically as writeAtomically,
} from "./private-files.js";
import {
  SYNTHETIC_BATCH_SPECS,
  SYNTHETIC_MIN_REVIEW_CONFIDENCE,
  SYNTHETIC_SCHEMA_VERSION,
  normalizeForDedupe,
  sha256,
  stableBucket,
  validateSyntheticBatch,
  validateSyntheticReview,
  type SyntheticLabels,
  type SyntheticRecord,
} from "./synthetic-contract.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptDirectory, "../../..");
const root = resolve(projectDirectory, "tools/training/work/v1");
const syntheticRoot = resolve(root, "synthetic-v1");
const generationResults = resolve(syntheticRoot, "generation/results");
const reviewDirectory = resolve(syntheticRoot, "review");
const reviewInputDirectory = resolve(reviewDirectory, "input");
const reviewResultDirectory = resolve(reviewDirectory, "results");
const finalDirectory = resolve(syntheticRoot, "final");
const bundleDirectory = resolve(root, "pretraining-v1");
const realSourcePath = resolve(
  root,
  "teacher-review/adjudication/final/teacher-trainable-final.jsonl",
);
const modelLockPath = resolve(projectDirectory, "tools/training/model-lock.json");
const frozenTestLockPath = resolve(projectDirectory, "tools/training/frozen-test-lock.json");
const reviewManifestPath = resolve(reviewDirectory, "manifest.json");
const provenancePath = resolve(syntheticRoot, "provenance.json");
const semanticDuplicateThreshold = 0.985;
const realTestCollisionThreshold = 0.995;
const semanticWarningThreshold = 0.95;
const embeddingBatchSize = 32;

interface RealRecord {
  id: string;
  text: string;
  split: "train" | "validation" | "test";
  labels: {
    intent: ExecutionIntent;
    category: SemanticCategory;
    complexity: Complexity;
    route: RouteName | "native";
  };
}

interface ModelLock {
  embedding_model: string;
  endpoint: string;
  expected_dimensions: number;
  ollama_manifest_digest: string;
}

interface ReviewManifest {
  source_records: number;
  source_hashes: Record<string, string>;
  batches: Array<{ filename: string; records: number; sha256: string }>;
}

interface OllamaEmbedResponse {
  embeddings?: number[][];
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string; digest?: string }>;
}

interface ReviewedSyntheticRecord extends SyntheticRecord {
  labels: SyntheticLabels & { route: RouteName | "native" };
  review: {
    verdict: "agree" | "correct";
    confidence: number;
    reason: string;
    changed: boolean;
  };
}

interface TrainingRecord {
  schema_version: 1;
  id: string;
  text: string;
  split: "train" | "validation" | "test";
  provenance: "real_teacher_reviewed" | "synthetic_v1";
  labels: {
    intent: ExecutionIntent;
    category: SemanticCategory;
    complexity: Complexity;
    route: RouteName | "native";
  };
}

function parseJsonl<T>(source: string, name: string): T[] {
  return source
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        throw new Error(`${name}:${index + 1} is not valid JSON`);
      }
    });
}

function asJsonl(records: readonly unknown[]): string {
  return records.length === 0
    ? ""
    : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function objectHash(value: unknown): string {
  return sha256(`${JSON.stringify(value)}\n`);
}

function countBy<T>(records: readonly T[], select: (record: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    const key = select(record);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function examplesByFamily(
  records: readonly ReviewedSyntheticRecord[],
): Record<string, Array<{ id: string; text: string; labels: ReviewedSyntheticRecord["labels"] }>> {
  const examples: Record<
    string,
    Array<{ id: string; text: string; labels: ReviewedSyntheticRecord["labels"] }>
  > = {};
  for (const record of records) {
    const familyExamples = examples[record.family] ?? [];
    if (familyExamples.length < 10) {
      familyExamples.push({ id: record.id, text: record.text, labels: record.labels });
      examples[record.family] = familyExamples;
    }
  }
  return Object.fromEntries(
    Object.entries(examples).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function labelsEqual(left: SyntheticLabels, right: SyntheticLabels): boolean {
  return (
    left.intent === right.intent &&
    left.category === right.category &&
    left.complexity === right.complexity
  );
}

function normalizeVector(vector: readonly number[], expectedDimensions: number): Float32Array {
  if (vector.length !== expectedDimensions) {
    throw new Error(`expected ${expectedDimensions} embedding dimensions, got ${vector.length}`);
  }
  let squared = 0;
  for (const value of vector) squared += value * value;
  const magnitude = Math.sqrt(squared);
  if (!Number.isFinite(magnitude) || magnitude === 0) throw new Error("invalid embedding vector");
  const normalized = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    normalized[index] = (vector[index] ?? 0) / magnitude;
  }
  return normalized;
}

function cosine(left: Float32Array, right: Float32Array): number {
  let value = 0;
  for (let index = 0; index < left.length; index += 1) {
    value += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return value;
}

function rememberTop<T extends { similarity: number }>(
  items: T[],
  item: T,
  limit = 20,
): void {
  items.push(item);
  items.sort((left, right) => right.similarity - left.similarity);
  if (items.length > limit) items.length = limit;
}

function ollamaBaseUrl(rawHost: string | undefined): URL {
  const raw = rawHost?.trim() || "http://127.0.0.1:11434";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const url = new URL(withScheme);
  if (!new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(url.hostname)) {
    throw new Error(`refusing non-loopback Ollama host: ${url.hostname}`);
  }
  return url;
}

async function embed(
  texts: readonly string[],
  modelLock: ModelLock,
  baseUrl: URL,
): Promise<Float32Array[]> {
  const endpoint = new URL(modelLock.endpoint, baseUrl);
  const vectors: Float32Array[] = [];
  for (let offset = 0; offset < texts.length; offset += embeddingBatchSize) {
    const input = texts.slice(offset, offset + embeddingBatchSize);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: modelLock.embedding_model,
        input,
        keep_alive: "30m",
        truncate: true,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      throw new Error(`Ollama embed failed (${response.status}): ${await response.text()}`);
    }
    const payload = (await response.json()) as OllamaEmbedResponse;
    if (!payload.embeddings || payload.embeddings.length !== input.length) {
      throw new Error(`Ollama returned ${payload.embeddings?.length ?? 0} vectors for ${input.length} inputs`);
    }
    vectors.push(
      ...payload.embeddings.map((vector) =>
        normalizeVector(vector, modelLock.expected_dimensions),
      ),
    );
  }
  return vectors;
}

async function verifyInstalledModel(modelLock: ModelLock, baseUrl: URL): Promise<string> {
  const response = await fetch(new URL("/api/tags", baseUrl), {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Ollama tags failed (${response.status})`);
  const payload = (await response.json()) as OllamaTagsResponse;
  const installed = payload.models?.find(
    (model) =>
      model.name === modelLock.embedding_model || model.model === modelLock.embedding_model,
  );
  if (!installed) throw new Error(`embedding model is not installed: ${modelLock.embedding_model}`);
  if (installed.digest !== modelLock.ollama_manifest_digest) {
    throw new Error(
      `embedding model digest mismatch: expected ${modelLock.ollama_manifest_digest}, got ${installed.digest ?? "unknown"}`,
    );
  }
  return installed.digest;
}

function validateReviewManifest(value: unknown): ReviewManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("synthetic review manifest must be an object");
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.schema_version !== SYNTHETIC_SCHEMA_VERSION) {
    throw new Error("synthetic review manifest schema_version is invalid");
  }
  if (manifest.source_records !== SYNTHETIC_BATCH_SPECS.reduce((sum, spec) => sum + spec.target, 0)) {
    throw new Error("synthetic review manifest source_records is invalid");
  }
  if (manifest.source_hashes === null || typeof manifest.source_hashes !== "object") {
    throw new Error("synthetic review manifest source_hashes is invalid");
  }
  const sourceHashes = manifest.source_hashes as Record<string, unknown>;
  const expectedSourceKeys = SYNTHETIC_BATCH_SPECS.map((spec) => spec.id).sort();
  if (Object.keys(sourceHashes).sort().join(",") !== expectedSourceKeys.join(",")) {
    throw new Error("synthetic review manifest source_hashes batch set is invalid");
  }
  for (const key of expectedSourceKeys) {
    if (typeof sourceHashes[key] !== "string" || !/^[a-f0-9]{64}$/.test(sourceHashes[key])) {
      throw new Error(`synthetic review manifest source hash is invalid: ${key}`);
    }
  }
  if (!Array.isArray(manifest.batches) || manifest.batches.length !== 4) {
    throw new Error("synthetic review manifest must contain four review batches");
  }
  const batches = manifest.batches.map((value, index) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`synthetic review batch ${index + 1} is invalid`);
    }
    const batch = value as Record<string, unknown>;
    const expectedFilename = `batch-${String(index + 1).padStart(2, "0")}.jsonl`;
    if (
      batch.filename !== expectedFilename ||
      !Number.isInteger(batch.records) ||
      (batch.records as number) < 1 ||
      typeof batch.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(batch.sha256)
    ) {
      throw new Error(`synthetic review batch contract is invalid: ${expectedFilename}`);
    }
    return {
      filename: expectedFilename,
      records: batch.records as number,
      sha256: batch.sha256,
    };
  });
  if (batches.reduce((sum, batch) => sum + batch.records, 0) !== manifest.source_records) {
    throw new Error("synthetic review batch record counts do not match source_records");
  }
  return {
    source_records: manifest.source_records as number,
    source_hashes: sourceHashes as Record<string, string>,
    batches,
  };
}

async function loadGenerated(manifest: ReviewManifest): Promise<SyntheticRecord[]> {
  const records: SyntheticRecord[] = [];
  for (const spec of SYNTHETIC_BATCH_SPECS) {
    const source = await readFile(resolve(generationResults, `${spec.id}.jsonl`), "utf8");
    if (sha256(source) !== manifest.source_hashes[spec.id]) {
      throw new Error(`${spec.id} changed after review preparation`);
    }
    records.push(...validateSyntheticBatch(parseJsonl<unknown>(source, spec.id), spec));
  }
  if (records.length !== manifest.source_records) {
    throw new Error(`generated records changed: ${records.length} != ${manifest.source_records}`);
  }
  return records;
}

async function loadReviews(
  manifest: ReviewManifest,
): Promise<Map<string, ReturnType<typeof validateSyntheticReview>>> {
  const reviews = new Map<string, ReturnType<typeof validateSyntheticReview>>();
  for (const batch of manifest.batches) {
    const inputSource = await readFile(resolve(reviewInputDirectory, batch.filename), "utf8");
    if (sha256(inputSource) !== batch.sha256) {
      throw new Error(`${batch.filename} review input changed`);
    }
    const inputs = parseJsonl<{ id: string; labels: SyntheticLabels }>(
      inputSource,
      batch.filename,
    );
    if (inputs.length !== batch.records) {
      throw new Error(`${batch.filename} has ${inputs.length} inputs, expected ${batch.records}`);
    }
    const inputIds = inputs.map((record) => record.id);
    const resultSource = await readFile(resolve(reviewResultDirectory, batch.filename), "utf8");
    const results = parseJsonl<unknown>(resultSource, batch.filename).map(
      validateSyntheticReview,
    );
    if (results.length !== inputIds.length) {
      throw new Error(`${batch.filename} has ${results.length} reviews, expected ${inputIds.length}`);
    }
    for (let index = 0; index < inputIds.length; index += 1) {
      const expectedId = inputIds[index];
      const review = results[index];
      if (!review || review.id !== expectedId) {
        throw new Error(`${batch.filename}:${index + 1} review order/id mismatch`);
      }
      const input = inputs[index];
      if (!input) throw new Error(`${batch.filename}:${index + 1} input is missing`);
      const unchanged = labelsEqual(input.labels, review.labels);
      if (review.verdict === "agree" && !unchanged) {
        throw new Error(`${review.id} verdict=agree must preserve labels`);
      }
      if (review.verdict === "correct" && unchanged) {
        throw new Error(`${review.id} verdict=correct must change at least one label`);
      }
      if (reviews.has(review.id)) throw new Error(`duplicate review id: ${review.id}`);
      reviews.set(review.id, review);
    }
  }
  return reviews;
}

function trainingRecordFromReal(record: RealRecord): TrainingRecord {
  return {
    schema_version: 1,
    id: `real-${record.id}`,
    text: record.text,
    split: record.split,
    provenance: "real_teacher_reviewed",
    labels: record.labels,
  };
}

async function main(): Promise<void> {
  await hardenPrivateTree(root);
  const reviewManifestSource = await readFile(reviewManifestPath, "utf8");
  const reviewManifest = validateReviewManifest(JSON.parse(reviewManifestSource) as unknown);
  const generated = await loadGenerated(reviewManifest);
  const reviews = await loadReviews(reviewManifest);
  const config = await loadConfig();
  const rejected: Array<{ id: string; reason: string }> = [];
  const reviewed: ReviewedSyntheticRecord[] = [];

  for (const record of generated) {
    const review = reviews.get(record.id);
    if (!review) throw new Error(`missing review for ${record.id}`);
    if (
      review.verdict === "reject" ||
      review.confidence < SYNTHETIC_MIN_REVIEW_CONFIDENCE
    ) {
      rejected.push({ id: record.id, reason: review.reason });
      continue;
    }
    const route = routeForLabels(review.labels.category, review.labels.complexity, config);
    reviewed.push({
      ...record,
      labels: { ...review.labels, route },
      review: {
        verdict: review.verdict,
        confidence: review.confidence,
        reason: review.reason,
        changed: !labelsEqual(record.labels, review.labels),
      },
    });
  }

  const exact = new Map<string, string>();
  for (const record of reviewed) {
    const normalized = normalizeForDedupe(record.text);
    const previous = exact.get(normalized);
    if (previous) throw new Error(`reviewed exact duplicate: ${previous} and ${record.id}`);
    exact.set(normalized, record.id);
  }

  const realSource = await readFile(realSourcePath, "utf8");
  const realLines = realSource.split(/\r?\n/).filter(Boolean);
  const realRecords = realLines.map((line, index) => {
    try {
      return JSON.parse(line) as RealRecord;
    } catch {
      throw new Error(`teacher-trainable-final:${index + 1} is not valid JSON`);
    }
  });
  const realTest = realRecords.filter((record) => record.split === "test");
  const realTestSource = `${realLines
    .filter((_, index) => realRecords[index]?.split === "test")
    .join("\n")}\n`;
  const frozenTestLockSource = await readFile(frozenTestLockPath, "utf8");
  const frozenTestLock = JSON.parse(frozenTestLockSource) as {
    schema_version?: unknown;
    records?: unknown;
    sha256?: unknown;
  };
  if (
    frozenTestLock.schema_version !== 1 ||
    frozenTestLock.records !== realTest.length ||
    frozenTestLock.sha256 !== sha256(realTestSource)
  ) {
    throw new Error("frozen real test does not match tools/training/frozen-test-lock.json");
  }
  const modelLock = JSON.parse(await readFile(modelLockPath, "utf8")) as ModelLock;
  const baseUrl = ollamaBaseUrl(process.env.OLLAMA_HOST);
  const actualModelDigest = await verifyInstalledModel(modelLock, baseUrl);
  const allTexts = [...reviewed.map((record) => record.text), ...realTest.map((record) => record.text)];
  const allVectors = await embed(allTexts, modelLock, baseUrl);
  const syntheticVectors = allVectors.slice(0, reviewed.length);
  const testVectors = allVectors.slice(reviewed.length);
  const semanticRejected = new Set<string>();
  const semanticDuplicates: Array<{ left_id: string; right_id: string; similarity: number }> = [];
  const hardNegativePairs: Array<{ left_id: string; right_id: string; similarity: number }> = [];
  const testWarnings: Array<{ synthetic_id: string; real_test_id: string; similarity: number }> = [];
  const topSameLabelPairs: Array<{ left_id: string; right_id: string; similarity: number }> = [];
  const topCrossLabelPairs: Array<{ left_id: string; right_id: string; similarity: number }> = [];
  const topTestPairs: Array<{ synthetic_id: string; real_test_id: string; similarity: number }> = [];

  for (let leftIndex = 0; leftIndex < reviewed.length; leftIndex += 1) {
    const left = reviewed[leftIndex];
    const leftVector = syntheticVectors[leftIndex];
    if (!left || !leftVector || semanticRejected.has(left.id)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < reviewed.length; rightIndex += 1) {
      const right = reviewed[rightIndex];
      const rightVector = syntheticVectors[rightIndex];
      if (!right || !rightVector || semanticRejected.has(right.id)) continue;
      const similarity = cosine(leftVector, rightVector);
      const pair = {
        left_id: left.id,
        right_id: right.id,
        similarity: Number(similarity.toFixed(6)),
      };
      if (labelsEqual(left.labels, right.labels)) {
        rememberTop(topSameLabelPairs, pair);
        if (similarity >= semanticDuplicateThreshold) {
          semanticRejected.add(right.id);
          semanticDuplicates.push(pair);
        }
      } else {
        rememberTop(topCrossLabelPairs, pair);
        if (similarity >= semanticDuplicateThreshold) hardNegativePairs.push(pair);
      }
    }
  }

  for (let syntheticIndex = 0; syntheticIndex < reviewed.length; syntheticIndex += 1) {
    const record = reviewed[syntheticIndex];
    const vector = syntheticVectors[syntheticIndex];
    if (!record || !vector || semanticRejected.has(record.id)) continue;
    for (let testIndex = 0; testIndex < realTest.length; testIndex += 1) {
      const test = realTest[testIndex];
      const testVector = testVectors[testIndex];
      if (!test || !testVector) continue;
      const similarity = cosine(vector, testVector);
      const pair = {
        synthetic_id: record.id,
        real_test_id: test.id,
        similarity: Number(similarity.toFixed(6)),
      };
      rememberTop(topTestPairs, pair);
      if (similarity >= semanticWarningThreshold) {
        testWarnings.push(pair);
      }
      if (similarity >= realTestCollisionThreshold) {
        semanticRejected.add(record.id);
        break;
      }
    }
  }

  const accepted = reviewed.filter((record) => !semanticRejected.has(record.id));
  for (const id of semanticRejected) {
    rejected.push({ id, reason: "semantic duplicate or frozen-test collision" });
  }

  const syntheticTraining: TrainingRecord[] = accepted.map((record) => {
    const split = stableBucket(record.id, 100) < 85 ? "train" : "validation";
    return {
      schema_version: 1,
      id: record.id,
      text: record.text,
      split,
      provenance: "synthetic_v1",
      labels: record.labels,
    };
  });
  const realTraining = realRecords.map(trainingRecordFromReal);
  const bundle = dedupeTrainingBundle([...realTraining, ...syntheticTraining]);
  const train = bundle.kept.filter((record) => record.split === "train");
  const validation = bundle.kept.filter((record) => record.split === "validation");
  const test = bundle.kept.filter((record) => record.split === "test");
  if (test.length !== realTest.length) {
    throw new Error(`frozen real test changed during bundle dedupe: ${test.length} != ${realTest.length}`);
  }
  const acceptedSource = asJsonl(accepted);
  const rejectedSource = asJsonl(rejected);
  const trainSource = asJsonl(train);
  const validationSource = asJsonl(validation);
  const testSource = realTestSource;
  await writeAtomically(resolve(finalDirectory, "synthetic-reviewed.jsonl"), acceptedSource);
  await writeAtomically(resolve(finalDirectory, "synthetic-rejected.jsonl"), rejectedSource);
  await writeAtomically(resolve(bundleDirectory, "datasets/train.jsonl"), trainSource);
  await writeAtomically(resolve(bundleDirectory, "datasets/validation.jsonl"), validationSource);
  await writeAtomically(resolve(bundleDirectory, "datasets/test-real-only.jsonl"), testSource);
  await writeAtomically(
    resolve(bundleDirectory, "reports/exact-duplicates.json"),
    `${JSON.stringify(bundle.dropped, null, 2)}\n`,
  );
  await writeAtomically(
    resolve(bundleDirectory, "reports/semantic-pairs.json"),
    `${JSON.stringify(
      {
        same_label_duplicates: semanticDuplicates,
        hard_negative_pairs: hardNegativePairs,
        top_same_label_pairs: topSameLabelPairs,
        top_cross_label_pairs: topCrossLabelPairs,
        top_frozen_test_pairs: topTestPairs,
        frozen_test_warnings: testWarnings.sort((left, right) => right.similarity - left.similarity),
      },
      null,
      2,
    )}\n`,
  );
  await writeAtomically(
    resolve(bundleDirectory, "reports/examples-by-family.json"),
    `${JSON.stringify(examplesByFamily(accepted), null, 2)}\n`,
  );

  const configProjection = {
    routeOrder: config.routing.routeOrder,
    categoryRoutes: config.routing.categoryRoutes,
    complexityRoutes: config.routing.complexityRoutes,
  };
  const provenanceSource = await readFile(provenancePath, "utf8");
  const provenance = JSON.parse(provenanceSource) as {
    schema_version?: unknown;
    generators?: unknown[];
    reviewers?: unknown[];
  };
  if (
    provenance.schema_version !== 1 ||
    provenance.generators?.length !== SYNTHETIC_BATCH_SPECS.length ||
    provenance.reviewers?.length !== reviewManifest.batches.length
  ) {
    throw new Error("synthetic provenance does not cover every generation and review batch");
  }
  const manifest = {
    schema_version: SYNTHETIC_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    status: "ready_for_training",
    training_executed: false,
    sources: {
      real_trainable_path:
        "tools/training/work/v1/teacher-review/adjudication/final/teacher-trainable-final.jsonl",
      real_trainable_sha256: sha256(realSource),
      frozen_real_test_records: test.length,
      frozen_real_test_sha256: sha256(testSource),
      frozen_test_lock_sha256: sha256(frozenTestLockSource),
      synthetic_review_manifest_sha256: sha256(reviewManifestSource),
      synthetic_provenance_sha256: sha256(provenanceSource),
    },
    model: {
      embedding_model: modelLock.embedding_model,
      manifest_digest: modelLock.ollama_manifest_digest,
      verified_installed_digest: actualModelDigest,
      dimensions: modelLock.expected_dimensions,
      vectors_persisted: false,
    },
    route_projection: {
      sha256: objectHash(configProjection),
      ...configProjection,
    },
    gates: {
      generated_records: generated.length,
      independently_reviewed_records: reviews.size,
      review_verdicts: countBy([...reviews.values()], (review) => review.verdict),
      corrected_records: reviewed.filter((record) => record.review.changed).length,
      accepted_synthetic_records: accepted.length,
      rejected_synthetic_records: rejected.length,
      bundle_exact_duplicates_removed: bundle.dropped.length,
      bundle_remaining_exact_duplicates: 0,
      same_label_semantic_duplicates_removed: semanticDuplicates.length,
      cross_label_hard_negative_pairs_kept: hardNegativePairs.length,
      frozen_test_collisions_removed: testWarnings.filter(
        (warning) => warning.similarity >= realTestCollisionThreshold,
      ).length,
      maximum_same_label_similarity: topSameLabelPairs[0]?.similarity ?? null,
      maximum_cross_label_similarity: topCrossLabelPairs[0]?.similarity ?? null,
      maximum_frozen_test_similarity: topTestPairs[0]?.similarity ?? null,
      semantic_duplicate_threshold: semanticDuplicateThreshold,
      frozen_test_collision_threshold: realTestCollisionThreshold,
      minimum_review_confidence: SYNTHETIC_MIN_REVIEW_CONFIDENCE,
    },
    datasets: {
      train: { records: train.length, sha256: sha256(trainSource) },
      validation: { records: validation.length, sha256: sha256(validationSource) },
      test_real_only: { records: test.length, sha256: sha256(testSource) },
    },
    distributions: {
      synthetic_intent: countBy(accepted, (record) => record.labels.intent),
      synthetic_category: countBy(accepted, (record) => record.labels.category),
      synthetic_complexity: countBy(accepted, (record) => record.labels.complexity),
      synthetic_family: countBy(accepted, (record) => record.family),
      combined_train_provenance: countBy(train, (record) => record.provenance),
      combined_validation_provenance: countBy(validation, (record) => record.provenance),
    },
    output_sha256: {
      synthetic_reviewed: sha256(acceptedSource),
      synthetic_rejected: sha256(rejectedSource),
    },
  };
  await writeAtomically(
    resolve(bundleDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await hardenPrivateTree(root);
  process.stdout.write(`${JSON.stringify(manifest.gates)}\n`);
}

await main();
