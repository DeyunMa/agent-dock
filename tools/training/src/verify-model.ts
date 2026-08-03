import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writePrivateAtomically } from "./private-files.js";

interface ModelLock {
  schema_version: number;
  embedding_model: string;
  provider: "ollama";
  endpoint: string;
  ollama_manifest_digest: string;
  expected_dimensions: number;
}

interface DatasetRecord {
  id: string;
  prompt_hash: string;
  text: string;
  chars: number;
  language: string;
  labels: {
    intent: string;
    category: string;
    complexity: string;
    route: string;
  };
}

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
    digest?: string;
    size?: number;
  }>;
}

interface OllamaEmbedResponse {
  embeddings?: number[][];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
}

interface EmbedMeasurement {
  prompt_id: string;
  prompt_hash: string;
  chars: number;
  language: string;
  intent: string;
  category: string;
  complexity: string;
  route: string;
  latency_ms: number;
  dimension: number;
  ollama_total_ms: number | null;
  ollama_load_ms: number | null;
  prompt_tokens: number | null;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const trainingDirectory = resolve(scriptDirectory, "..");
const projectDirectory = resolve(trainingDirectory, "../..");
const modelLockPath = resolve(trainingDirectory, "model-lock.json");
const datasetPath = resolve(trainingDirectory, "work/v1/all.jsonl");
const reportPath = resolve(
  trainingDirectory,
  "work/v1/reports/model-smoke.json",
);

function normalizeOllamaBaseUrl(rawHost: string | undefined): URL {
  const raw = rawHost?.trim() || "http://127.0.0.1:11434";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const url = new URL(withScheme);
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

  if (!loopbackHosts.has(url.hostname)) {
    throw new Error(
      `Refusing to send local prompts to non-loopback Ollama host: ${url.hostname}`,
    );
  }

  return url;
}

function parseDataset(raw: string): DatasetRecord[] {
  const records: DatasetRecord[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parsed = JSON.parse(trimmed) as DatasetRecord;
    if (
      typeof parsed.id === "string" &&
      typeof parsed.prompt_hash === "string" &&
      typeof parsed.text === "string" &&
      parsed.text.length > 0
    ) {
      records.push(parsed);
    }
  }

  return records;
}

function selectSamples(records: DatasetRecord[], count: number): DatasetRecord[] {
  if (records.length < count) {
    throw new Error(`Need ${count} dataset records, found ${records.length}`);
  }

  const selected: DatasetRecord[] = [];
  const selectedIds = new Set<string>();
  const targetPredicates: Array<(record: DatasetRecord) => boolean> = [
    (record) => record.language === "zh" && record.labels.intent === "ask",
    (record) => record.language === "zh" && record.labels.intent === "do",
    (record) => record.language === "mixed" && record.labels.intent === "ask",
    (record) => record.language === "mixed" && record.labels.intent === "do",
    (record) => record.language === "en",
    (record) => record.labels.complexity === "simple",
    (record) => record.labels.complexity === "normal",
    (record) => record.labels.complexity === "complex",
    (record) => record.labels.route === "quick",
    (record) => record.labels.route === "deep",
  ];

  for (const predicate of targetPredicates) {
    const match = records.find(
      (record) => !selectedIds.has(record.id) && predicate(record),
    );
    if (match) {
      selected.push(match);
      selectedIds.add(match.id);
    }
  }

  for (const record of records) {
    if (selected.length >= count) {
      break;
    }
    if (!selectedIds.has(record.id)) {
      selected.push(record);
      selectedIds.add(record.id);
    }
  }

  return selected.slice(0, count);
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index] ?? 0;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

function durationToMilliseconds(value: number | undefined): number | null {
  return value === undefined ? null : roundMilliseconds(value / 1_000_000);
}

async function fetchJson<T>(
  url: URL,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new Error(
      `Ollama request failed (${response.status}): ${await response.text()}`,
    );
  }

  return (await response.json()) as T;
}

async function measureEmbedding(
  baseUrl: URL,
  modelLock: ModelLock,
  record: DatasetRecord,
): Promise<EmbedMeasurement> {
  const startedAt = performance.now();
  const endpoint = new URL(modelLock.endpoint, baseUrl);
  const response = await fetchJson<OllamaEmbedResponse>(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: modelLock.embedding_model,
      input: record.text,
      keep_alive: "5m",
    }),
  });
  const latency = performance.now() - startedAt;
  const embedding = response.embeddings?.[0];

  if (!embedding) {
    throw new Error(`Ollama returned no embedding for sample ${record.id}`);
  }

  if (embedding.length !== modelLock.expected_dimensions) {
    throw new Error(
      `Expected ${modelLock.expected_dimensions} dimensions, got ${embedding.length}`,
    );
  }

  return {
    prompt_id: record.id,
    prompt_hash: record.prompt_hash,
    chars: record.chars,
    language: record.language,
    intent: record.labels.intent,
    category: record.labels.category,
    complexity: record.labels.complexity,
    route: record.labels.route,
    latency_ms: roundMilliseconds(latency),
    dimension: embedding.length,
    ollama_total_ms: durationToMilliseconds(response.total_duration),
    ollama_load_ms: durationToMilliseconds(response.load_duration),
    prompt_tokens: response.prompt_eval_count ?? null,
  };
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await writePrivateAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const [modelLockRaw, datasetRaw] = await Promise.all([
    readFile(modelLockPath, "utf8"),
    readFile(datasetPath, "utf8"),
  ]);
  const modelLock = JSON.parse(modelLockRaw) as ModelLock;
  const records = parseDataset(datasetRaw);
  const samples = selectSamples(records, 10);
  const baseUrl = normalizeOllamaBaseUrl(process.env.OLLAMA_HOST);
  const tagsUrl = new URL("/api/tags", baseUrl);
  const tags = await fetchJson<OllamaTagsResponse>(tagsUrl);
  const installedModel = tags.models?.find(
    (model) =>
      model.name === modelLock.embedding_model ||
      model.model === modelLock.embedding_model,
  );

  if (!installedModel) {
    throw new Error(
      `Model ${modelLock.embedding_model} is not installed. Run: ollama pull ${modelLock.embedding_model}`,
    );
  }

  if (installedModel.digest !== modelLock.ollama_manifest_digest) {
    throw new Error(
      `Model digest mismatch: expected ${modelLock.ollama_manifest_digest}, got ${installedModel.digest ?? "unknown"}`,
    );
  }

  const coldStart = await measureEmbedding(baseUrl, modelLock, samples[0]!);
  const warmMeasurements: EmbedMeasurement[] = [];
  for (const sample of samples) {
    warmMeasurements.push(await measureEmbedding(baseUrl, modelLock, sample));
  }

  const warmLatencies = warmMeasurements.map(
    (measurement) => measurement.latency_ms,
  );
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    model: {
      name: modelLock.embedding_model,
      manifest_digest: installedModel.digest,
      size_bytes: installedModel.size ?? null,
      expected_dimensions: modelLock.expected_dimensions,
      actual_dimensions: coldStart.dimension,
    },
    privacy: {
      loopback_only: true,
      endpoint_host: baseUrl.hostname,
      prompt_text_persisted: false,
      embeddings_persisted: false,
    },
    dataset: {
      path: relative(projectDirectory, datasetPath),
      total_records: records.length,
      sampled_records: samples.length,
    },
    cold_start: coldStart,
    warm: {
      runs: warmMeasurements.length,
      min_ms: Math.min(...warmLatencies),
      median_ms: percentile(warmLatencies, 0.5),
      p95_ms: percentile(warmLatencies, 0.95),
      max_ms: Math.max(...warmLatencies),
      average_ms: roundMilliseconds(
        warmLatencies.reduce((sum, value) => sum + value, 0) /
          warmLatencies.length,
      ),
      measurements: warmMeasurements,
    },
  };

  await writeJsonAtomically(reportPath, report);
  process.stdout.write(
    `${JSON.stringify(
      {
        model: modelLock.embedding_model,
        digest: installedModel.digest,
        dimensions: coldStart.dimension,
        cold_start_ms: coldStart.latency_ms,
        warm_median_ms: report.warm.median_ms,
        warm_p95_ms: report.warm.p95_ms,
        report: relative(projectDirectory, reportPath),
      },
      null,
      2,
    )}\n`,
  );
}

await main();
