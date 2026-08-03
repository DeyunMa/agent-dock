import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  COMPLEXITIES,
  EXECUTION_INTENTS,
  SEMANTIC_CATEGORIES,
  type AiClassification,
  type AiDecision,
  type Complexity,
  type EmbeddingClassifierConfig,
  type ExecutionIntent,
  type SemanticCategory,
} from "./types.js";

type Target = "intent" | "category" | "complexity";

interface LinearHead {
  target: Target;
  classes: string[];
  coefficients: number[][];
  intercepts: number[];
  embeddingModel: string;
  embeddingModelDigest: string;
  dimensions: number;
  maxChars: number;
}

interface ClassifierBundle {
  intent: LinearHead;
  category: LinearHead;
  complexity: LinearHead;
}

interface OllamaEmbedResponse {
  embeddings?: number[][];
}

const TARGET_CLASSES = {
  intent: EXECUTION_INTENTS,
  category: SEMANTIC_CATEGORIES,
  complexity: COMPLEXITIES,
} as const;

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function finiteNumberArray(value: unknown, length?: number): value is number[] {
  return (
    Array.isArray(value) &&
    (length === undefined || value.length === length) &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

function exactClassSet(
  value: unknown,
  expected: readonly string[],
): value is string[] {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  if (!value.every((item): item is string => typeof item === "string")) return false;
  const actual = new Set(value);
  return (
    actual.size === expected.length &&
    expected.every((item) => actual.has(item))
  );
}

async function loadHead(
  directory: string,
  target: Target,
  config: EmbeddingClassifierConfig,
): Promise<LinearHead> {
  const path = join(directory, `${target}.json`);
  if ((await lstat(path)).isSymbolicLink()) {
    throw new Error(`classifier model must not be a symlink: ${path}`);
  }
  const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const dimensions = parsed.embedding_dimensions;
  const classes = parsed.classes;
  const coefficients = parsed.coefficients;
  const intercepts = parsed.intercepts;
  if (
    parsed.schema_version !== 1 ||
    parsed.kind !== "multinomial_logistic_regression" ||
    parsed.target !== target ||
    parsed.embedding_preprocessing !== "collapse_whitespace_then_tail_v1" ||
    parsed.normalization !== "l2_unit_embedding" ||
    parsed.embedding_model !== config.model ||
    parsed.embedding_model_digest !== config.modelDigest ||
    typeof dimensions !== "number" ||
    !Number.isInteger(dimensions) ||
    dimensions < 1 ||
    typeof parsed.embedding_max_chars !== "number" ||
    !Number.isInteger(parsed.embedding_max_chars) ||
    parsed.embedding_max_chars < 256 ||
    !exactClassSet(classes, TARGET_CLASSES[target]) ||
    !Array.isArray(coefficients) ||
    coefficients.length !== classes.length ||
    !coefficients.every((row) => finiteNumberArray(row, dimensions)) ||
    !finiteNumberArray(intercepts, classes.length)
  ) {
    throw new Error(`invalid ${target} classifier model`);
  }
  return {
    target,
    classes: classes as string[],
    coefficients: coefficients as number[][],
    intercepts,
    embeddingModel: config.model,
    embeddingModelDigest: config.modelDigest,
    dimensions,
    maxChars: parsed.embedding_max_chars,
  };
}

async function loadBundle(config: EmbeddingClassifierConfig): Promise<ClassifierBundle> {
  const [intent, category, complexity] = await Promise.all([
    loadHead(config.modelDirectory, "intent", config),
    loadHead(config.modelDirectory, "category", config),
    loadHead(config.modelDirectory, "complexity", config),
  ]);
  const heads = [intent, category, complexity];
  if (
    heads.some(
      (head) =>
        head.dimensions !== intent.dimensions ||
        head.maxChars !== intent.maxChars ||
        head.embeddingModel !== intent.embeddingModel ||
        head.embeddingModelDigest !== intent.embeddingModelDigest,
    )
  ) {
    throw new Error("classifier model heads are incompatible");
  }
  return { intent, category, complexity };
}

function embeddingText(prompt: string, maxChars: number): string {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  return normalized.length <= maxChars ? normalized : normalized.slice(-maxChars);
}

function normalize(vector: number[]): number[] | undefined {
  let sumSquares = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) return undefined;
    sumSquares += value * value;
  }
  const magnitude = Math.sqrt(sumSquares);
  if (!Number.isFinite(magnitude) || magnitude === 0) return undefined;
  return vector.map((value) => value / magnitude);
}

function predict<T extends string>(
  head: LinearHead,
  embedding: number[],
): { value: T; confidence: number } {
  const logits = head.coefficients.map((row, rowIndex) => {
    let value = head.intercepts[rowIndex] ?? 0;
    for (let index = 0; index < embedding.length; index += 1) {
      value += (row[index] ?? 0) * (embedding[index] ?? 0);
    }
    return value;
  });
  const maximum = Math.max(...logits);
  const exponentials = logits.map((value) => Math.exp(value - maximum));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  let bestIndex = 0;
  for (let index = 1; index < logits.length; index += 1) {
    if ((logits[index] ?? Number.NEGATIVE_INFINITY) > (logits[bestIndex] ?? Number.NEGATIVE_INFINITY)) {
      bestIndex = index;
    }
  }
  return {
    value: head.classes[bestIndex] as T,
    confidence: (exponentials[bestIndex] ?? 0) / total,
  };
}

export class EmbeddingClassifier {
  private bundlePromise?: Promise<ClassifierBundle>;
  private warmupPromise?: Promise<void>;
  private warming = false;
  private warmed = false;

  constructor(
    private readonly config: EmbeddingClassifierConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!isLoopbackUrl(config.baseUrl)) {
      throw new Error("embedding classifier requires a loopback HTTP URL");
    }
  }

  private bundle(): Promise<ClassifierBundle> {
    this.bundlePromise ??= loadBundle(this.config);
    return this.bundlePromise;
  }

  async warmup(): Promise<void> {
    if (!this.config.enabled) return;
    this.warmupPromise ??= this.performWarmup();
    return this.warmupPromise;
  }

  private async performWarmup(): Promise<void> {
    this.warming = true;
    try {
      const bundle = await this.bundle();
      const response = await this.embed("router warmup", bundle.intent.maxChars, 15_000);
      this.warmed = response !== undefined;
    } catch {
      // Warmup is opportunistic. User traffic remains fail-open.
    } finally {
      this.warming = false;
    }
  }

  private async embed(
    prompt: string,
    maxChars: number,
    timeoutMs: number,
  ): Promise<number[] | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.config.model,
          input: embeddingText(prompt, maxChars),
          keep_alive: this.config.keepAlive,
          truncate: true,
        }),
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      const payload = (await response.json()) as OllamaEmbedResponse;
      const vector = payload.embeddings?.[0];
      return vector ? normalize(vector) : undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  async classify(prompt: string): Promise<AiClassification> {
    if (!this.config.enabled) return { status: "disabled" };
    if (this.warming && !this.warmed && this.warmupPromise) {
      // A warm local model usually finishes inside this small budget. A real
      // cold load still fails open instead of delaying the Codex turn.
      await Promise.race([
        this.warmupPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 25)),
      ]);
      if (!this.warmed) return { status: "warming" };
    }
    const started = performance.now();
    try {
      const bundle = await this.bundle();
      const embedding = await this.embed(
        prompt,
        bundle.intent.maxChars,
        this.config.timeoutMs,
      );
      const latencyMs = Math.round(performance.now() - started);
      if (!embedding || embedding.length !== bundle.intent.dimensions) {
        return { status: "invalid_response", latencyMs };
      }
      const intent = predict<ExecutionIntent>(bundle.intent, embedding);
      const category = predict<SemanticCategory>(bundle.category, embedding);
      const complexity = predict<Complexity>(bundle.complexity, embedding);
      const decision: AiDecision = {
        intent: intent.value,
        category: category.value,
        complexity: complexity.value,
        confidence: Math.min(intent.confidence, category.confidence, complexity.confidence),
        reason: "local_embedding_classifier",
        latencyMs,
      };
      return { status: "ok", decision, latencyMs };
    } catch (error) {
      return {
        status:
          error instanceof DOMException && error.name === "AbortError"
            ? "timeout"
            : "error",
        latencyMs: Math.round(performance.now() - started),
      };
    }
  }
}
