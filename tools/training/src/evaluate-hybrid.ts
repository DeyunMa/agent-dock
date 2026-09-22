import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./legacy-router/config.js";
import type {
  Complexity,
  ExecutionIntent,
  RouterConfig,
  SemanticCategory,
} from "./legacy-router/types.js";
import {
  classifyWithRules,
  loadRules,
  type RuleDecision,
  type RoutingRuleSet,
} from "./legacy-rules.js";
import { classifyExecutionIntent } from "./legacy-intent.js";
import { deterministicComplexity } from "./legacy-prompt.js";
import { writePrivateAtomically } from "./private-files.js";

interface ValidationPrediction {
  id: string;
  text: string;
  truth: {
    intent: ExecutionIntent;
    category: SemanticCategory;
    complexity: Complexity;
    route: string;
  };
  prediction: {
    intent: ExecutionIntent;
    category: SemanticCategory;
    complexity: Complexity;
    route: string;
  };
  confidence: {
    intent: number;
    category: number;
    complexity: number;
  };
  correct: {
    intent: boolean;
    category: boolean;
    complexity: boolean;
    route: boolean;
  };
}

interface RulesOnlyResult {
  accuracy: number;
  classifier_calls: number;
  routes: Map<string, string>;
  decisions: Map<string, RuleDecision>;
}

interface RouteComparison {
  accuracy: number;
  overrides: number;
  corrections: number;
  regressions: number;
  net_corrections: number;
}

interface HybridResult {
  threshold: number;
  accuracy: number;
  classifier_calls: number;
  accepted: number;
  accepted_coverage: number;
  accepted_rate_among_calls: number;
  corrections: number;
  regressions: number;
  net_corrections: number;
}

interface ConfidenceSegment {
  minimum: number;
  maximum: number;
  records: number;
  embedding_accuracy: number | null;
  rules_accuracy: number | null;
  embedding_advantage: number | null;
}

interface IntentComparison {
  accuracy: number;
  correct: number;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptDirectory, "../../..");
const trainingRoot = resolve(projectDirectory, "tools/training");
const predictionPath = resolve(
  trainingRoot,
  "work/v1/training-runs/baseline-v3/validation-predictions.jsonl",
);
const pretrainingManifestPath = resolve(
  trainingRoot,
  "work/v1/pretraining-v1/manifest.json",
);
const reportPath = resolve(
  trainingRoot,
  "work/v1/reports/hybrid-validation.json",
);
const legacyRulesPath = resolve(
  trainingRoot,
  "resources/legacy-router-rules.json",
);
const thresholds = [0.5, 0.55, 0.58, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function routeForLabels(
  config: RouterConfig,
  category: SemanticCategory,
  complexity: Complexity,
): string {
  const categoryRoute = config.routing.categoryRoutes[category];
  const complexityRoute = config.routing.complexityRoutes[complexity];
  if (categoryRoute === "inherit" && complexityRoute === "inherit") return "native";
  if (categoryRoute === "inherit") return complexityRoute;
  if (complexityRoute === "inherit") return categoryRoute;
  const categoryRank = config.routing.routeOrder.indexOf(categoryRoute);
  const complexityRank = config.routing.routeOrder.indexOf(complexityRoute);
  return complexityRank > categoryRank ? complexityRoute : categoryRoute;
}

function legacyMergedComplexity(
  deterministic: Complexity,
  predicted: Complexity,
): Complexity {
  const order: Complexity[] = ["simple", "normal", "complex", "extreme"];
  const deterministicIndex = order.indexOf(deterministic);
  const predictedIndex = order.indexOf(predicted);
  if (deterministic === "extreme") return "extreme";
  const ceiling = Math.min(deterministicIndex + 1, order.indexOf("complex"));
  return order[Math.max(deterministicIndex, Math.min(predictedIndex, ceiling))] ?? deterministic;
}

function parsePredictions(source: string): ValidationPrediction[] {
  const records = source
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      const value = JSON.parse(line) as Partial<ValidationPrediction>;
      if (
        typeof value.id !== "string" ||
        typeof value.text !== "string" ||
        !value.truth ||
        !value.prediction ||
        !value.confidence
      ) {
        throw new Error(`invalid validation prediction at line ${index + 1}`);
      }
      return value as ValidationPrediction;
    });
  const ids = new Set(records.map((record) => record.id));
  const texts = new Set(records.map((record) => record.text));
  if (ids.size !== records.length) {
    throw new Error("validation predictions contain duplicate ids");
  }
  if (texts.size !== records.length) {
    throw new Error("validation predictions contain duplicate prompt text");
  }
  return records;
}

function assertProjectionMatches(
  config: RouterConfig,
  manifest: {
    route_projection?: {
      routeOrder?: unknown;
      categoryRoutes?: unknown;
      complexityRoutes?: unknown;
    };
  },
): void {
  const expected = manifest.route_projection;
  if (!expected) throw new Error("pretraining manifest has no route projection");
  assert.deepEqual(config.routing.routeOrder, expected.routeOrder);
  assert.deepEqual(config.routing.categoryRoutes, expected.categoryRoutes);
  assert.deepEqual(config.routing.complexityRoutes, expected.complexityRoutes);
}

async function evaluateRulesOnly(
  records: ValidationPrediction[],
  config: RouterConfig,
  rules: RoutingRuleSet,
): Promise<RulesOnlyResult> {
  const routes = new Map<string, string>();
  const decisions = new Map<string, RuleDecision>();
  let correct = 0;
  for (const record of records) {
    const decision = classifyWithRules(record.text, rules);
    decisions.set(record.id, decision);
    const route = routeForLabels(
      config,
      decision.category,
      deterministicComplexity(record.text),
    );
    routes.set(record.id, route);
    if (route === record.truth.route) correct += 1;
  }
  return {
    accuracy: round(correct / records.length),
    classifier_calls: records.length,
    routes,
    decisions,
  };
}

function compareWithDirectEmbedding(
  records: ValidationPrediction[],
  candidateRoute: (record: ValidationPrediction) => string,
): RouteComparison {
  let correct = 0;
  let overrides = 0;
  let corrections = 0;
  let regressions = 0;
  for (const record of records) {
    const directRoute = record.prediction.route;
    const route = candidateRoute(record);
    const directCorrect = directRoute === record.truth.route;
    const candidateCorrect = route === record.truth.route;
    if (candidateCorrect) correct += 1;
    if (route !== directRoute) overrides += 1;
    if (!directCorrect && candidateCorrect) corrections += 1;
    if (directCorrect && !candidateCorrect) regressions += 1;
  }
  return {
    accuracy: round(correct / records.length),
    overrides,
    corrections,
    regressions,
    net_corrections: corrections - regressions,
  };
}

function evaluateEmbeddingPrimaryWithHardGuards(
  records: ValidationPrediction[],
  rulesOnly: RulesOnlyResult,
): RouteComparison {
  return compareWithDirectEmbedding(records, (record) => {
    const rule = rulesOnly.decisions.get(record.id);
    if (rule?.suppressed || rule?.passContext) {
      return rulesOnly.routes.get(record.id) ?? "native";
    }
    return record.prediction.route;
  });
}

function evaluateConfidenceEnsemble(
  records: ValidationPrediction[],
  rulesOnly: RulesOnlyResult,
  ruleThreshold: number,
  embeddingCeiling: number,
): RouteComparison & {
  rule_threshold: number;
  embedding_ceiling: number;
} {
  return {
    rule_threshold: ruleThreshold,
    embedding_ceiling: embeddingCeiling,
    ...compareWithDirectEmbedding(records, (record) => {
      const rule = rulesOnly.decisions.get(record.id);
      if (!rule) return record.prediction.route;
      const hardGuard = rule.suppressed || rule.passContext;
      const embeddingConfidence = Math.min(
        record.confidence.category,
        record.confidence.complexity,
      );
      const confidenceOverride =
        rule.confidence >= ruleThreshold &&
        embeddingConfidence < embeddingCeiling;
      if (hardGuard || confidenceOverride) {
        return rulesOnly.routes.get(record.id) ?? "native";
      }
      return record.prediction.route;
    }),
  };
}

function evaluateConfidenceSegments(
  records: ValidationPrediction[],
  rulesOnly: RulesOnlyResult,
): ConfidenceSegment[] {
  const boundaries = [0, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.000001];
  return boundaries.slice(0, -1).map((minimum, index) => {
    const maximum = boundaries[index + 1] ?? 1.000001;
    const selected = records.filter((record) => {
      const confidence = Math.min(
        record.confidence.category,
        record.confidence.complexity,
      );
      return confidence >= minimum && confidence < maximum;
    });
    if (selected.length === 0) {
      return {
        minimum,
        maximum: Math.min(maximum, 1),
        records: 0,
        embedding_accuracy: null,
        rules_accuracy: null,
        embedding_advantage: null,
      };
    }
    const embeddingCorrect = selected.filter(
      (record) => record.prediction.route === record.truth.route,
    ).length;
    const rulesCorrect = selected.filter(
      (record) => rulesOnly.routes.get(record.id) === record.truth.route,
    ).length;
    const embeddingAccuracy = embeddingCorrect / selected.length;
    const rulesAccuracy = rulesCorrect / selected.length;
    return {
      minimum,
      maximum: Math.min(maximum, 1),
      records: selected.length,
      embedding_accuracy: round(embeddingAccuracy),
      rules_accuracy: round(rulesAccuracy),
      embedding_advantage: round(embeddingAccuracy - rulesAccuracy),
    };
  });
}

function intentAccuracy(
  records: ValidationPrediction[],
  predict: (record: ValidationPrediction) => ExecutionIntent,
): IntentComparison {
  const correct = records.filter(
    (record) => predict(record) === record.truth.intent,
  ).length;
  return {
    accuracy: round(correct / records.length),
    correct,
  };
}

async function evaluateHybrid(
  records: ValidationPrediction[],
  config: RouterConfig,
  rules: RoutingRuleSet,
  threshold: number,
  rulesOnly: RulesOnlyResult,
): Promise<HybridResult> {
  let correct = 0;
  let corrections = 0;
  let regressions = 0;
  let accepted = 0;
  for (const record of records) {
    const rule = classifyWithRules(record.text, rules);
    const routeConfidence =
      rule.category === "PASS_CONTEXT"
        ? Math.min(record.confidence.category, record.confidence.complexity)
        : record.confidence.complexity;
    const useEmbedding = routeConfidence >= threshold;
    if (useEmbedding) accepted += 1;
    const category =
      useEmbedding &&
      rule.category === "PASS_CONTEXT" &&
      record.prediction.category !== "PASS_CONTEXT"
        ? record.prediction.category
        : rule.category;
    const complexity = useEmbedding
      ? legacyMergedComplexity(
          deterministicComplexity(record.text),
          record.prediction.complexity,
        )
      : deterministicComplexity(record.text);
    const route = routeForLabels(config, category, complexity);
    const ruleRoute = rulesOnly.routes.get(record.id);
    const ruleCorrect = ruleRoute === record.truth.route;
    const hybridCorrect = route === record.truth.route;
    if (hybridCorrect) correct += 1;
    if (!ruleCorrect && hybridCorrect) corrections += 1;
    if (ruleCorrect && !hybridCorrect) regressions += 1;
  }
  return {
    threshold,
    accuracy: round(correct / records.length),
    classifier_calls: records.length,
    accepted,
    accepted_coverage: round(accepted / records.length),
    accepted_rate_among_calls: round(accepted / records.length),
    corrections,
    regressions,
    net_corrections: corrections - regressions,
  };
}

async function main(): Promise<void> {
  const [predictionSource, manifestSource, config] = await Promise.all([
    readFile(predictionPath, "utf8"),
    readFile(pretrainingManifestPath, "utf8"),
    loadConfig(),
  ]);
  const records = parsePredictions(predictionSource);
  const manifest = JSON.parse(manifestSource) as Parameters<
    typeof assertProjectionMatches
  >[1];
  assertProjectionMatches(config, manifest);
  const rulesSource = await readFile(legacyRulesPath, "utf8");
  const rules = await loadRules(legacyRulesPath);
  const rulesOnly = await evaluateRulesOnly(records, config, rules);
  const hybrid: HybridResult[] = [];
  for (const threshold of thresholds) {
    hybrid.push(
      await evaluateHybrid(records, config, rules, threshold, rulesOnly),
    );
  }
  const directCorrect = records.filter((record) => record.correct.route).length;
  const embeddingPrimaryWithHardGuards =
    evaluateEmbeddingPrimaryWithHardGuards(records, rulesOnly);
  const confidenceSegments = evaluateConfidenceSegments(records, rulesOnly);
  const intent = {
    rules_only: intentAccuracy(
      records,
      (record) => classifyExecutionIntent(record.text).intent,
    ),
    embedding_only: intentAccuracy(
      records,
      (record) => record.prediction.intent,
    ),
    rule_first_embedding_fallback: intentAccuracy(records, (record) => {
      const deterministic = classifyExecutionIntent(record.text).intent;
      return deterministic === "unknown"
        ? record.prediction.intent
        : deterministic;
    }),
  };
  const confidenceEnsembles = [0.6, 0.7, 0.8, 0.9, 0.95].flatMap(
    (ruleThreshold) =>
      [0.4, 0.5, 0.6, 0.7, 0.8].map((embeddingCeiling) =>
        evaluateConfidenceEnsemble(
          records,
          rulesOnly,
          ruleThreshold,
          embeddingCeiling,
        ),
      ),
  );
  const bestConfidenceEnsemble = [...confidenceEnsembles].sort(
    (left, right) =>
      right.accuracy - left.accuracy ||
      right.rule_threshold - left.rule_threshold ||
      left.embedding_ceiling - right.embedding_ceiling,
  )[0];
  const best = [...hybrid].sort(
    (left, right) =>
      right.accuracy - left.accuracy || right.threshold - left.threshold,
  )[0];
  const report = {
    schema_version: 1,
    phase: "validation_hybrid_without_2b",
    records: records.length,
    frozen_test_read: false,
    two_b_model_called: false,
    prediction_source_sha256: sha256(predictionSource),
    rules_sha256: sha256(rulesSource),
    rules_only: {
      accuracy: rulesOnly.accuracy,
      simulated_classifier_fail_open_records: rulesOnly.classifier_calls,
    },
    direct_embedding: {
      route_accuracy: round(directCorrect / records.length),
    },
    embedding_primary_with_hard_guards: embeddingPrimaryWithHardGuards,
    confidence_segments: confidenceSegments,
    intent,
    confidence_ensembles: confidenceEnsembles,
    best_confidence_ensemble: bestConfidenceEnsemble,
    hybrid,
    best_by_accuracy: best,
  };
  await writePrivateAtomically(
    reportPath,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
