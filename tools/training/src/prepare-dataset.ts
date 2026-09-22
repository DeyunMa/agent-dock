import { createHash } from "node:crypto";
import {
  createReadStream,
  type Stats,
} from "node:fs";
import {
  mkdir,
  readdir,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultConfig, loadConfig } from "./legacy-router/config.js";
import {
  deterministicComplexity,
  scoringText,
  truncateForClassifier,
} from "./legacy-prompt.js";
import type {
  Complexity,
  ExecutionIntent,
  RouteName,
  RouterConfig,
  SemanticCategory,
} from "./legacy-router/types.js";
import {
  classifyWithRules,
  loadRules,
  type RoutingRuleSet,
} from "./legacy-rules.js";
import { classifyExecutionIntent } from "./legacy-intent.js";
import { redactSensitiveText } from "./redaction.js";
import {
  assertSeparatedTrees,
  hardenPrivateTree,
  writePrivateAtomically,
} from "./private-files.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TRAINING_ROOT = resolve(PROJECT_ROOT, "local-training");
const DEFAULT_SOURCE_ROOT = resolve(homedir(), ".codex/sessions");
const DEFAULT_OUTPUT_ROOT = resolve(TRAINING_ROOT, "work/v1");
const DEFAULT_RULES_FILE = resolve(
  TRAINING_ROOT,
  "resources/legacy-router-rules.json",
);
const MAX_PROMPT_CHARS = 3_500;

type Language = "zh" | "en" | "mixed";
type Split = "train" | "validation" | "test";
type LabelStatus = "observed" | "seed_high_confidence" | "needs_review";

export interface DatasetRecord {
  schema_version: 1;
  id: string;
  thread_id: string;
  timestamp?: string;
  prompt_hash: string;
  text: string;
  chars: number;
  language: Language;
  split: Split;
  eligible_for_seed_training: boolean;
  label_status: LabelStatus;
  labels: {
    intent: ExecutionIntent;
    category: SemanticCategory;
    complexity: Complexity;
    route: RouteName | "native";
  };
  evidence: {
    intent_source: "audit" | "rule" | "fallback";
    category_source: "rule";
    route_source: "audit" | "deterministic";
    rule_reason: string;
    rule_confidence: number;
    category_candidate?: SemanticCategory;
  };
}

interface AuditObservation {
  intent: ExecutionIntent;
  route: string;
}

interface SnapshotFile {
  path: string;
  size: number;
  ino: number;
  dev: number;
  mtimeMs: number;
}

interface ExtractionStats {
  source_files: number;
  source_bytes: number;
  lines_read: number;
  malformed_lines: number;
  user_messages_seen: number;
  generated_context_filtered: number;
  empty_after_cleaning: number;
  duplicate_prompts: number;
  retained_prompts: number;
  audit_matches: number;
  source_files_unchanged: number;
  source_files_grown: number;
  source_files_shrunk_or_replaced: number;
}

interface CliOptions {
  sourceRoot: string;
  outputRoot: string;
}

interface SessionMessage {
  threadId: string;
  timestamp?: string;
  rawPrompt: string;
}

function sha256(value: string, length = 64): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
}

function removeXmlBlock(value: string, tag: string): string {
  return value.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "giu"), " ");
}

export function isGeneratedContext(rawPrompt: string): boolean {
  const value = rawPrompt.trim();
  return (
    /^#\s+AGENTS\.md instructions\b/iu.test(value) ||
    /^<subagent_notification>[\s\S]*<\/subagent_notification>$/iu.test(value) ||
    /^<turn_aborted>[\s\S]*<\/turn_aborted>$/iu.test(value) ||
    /^<recommended_plugins>[\s\S]*<\/recommended_plugins>$/iu.test(value)
  );
}

export function sanitizePrompt(rawPrompt: string): string {
  if (isGeneratedContext(rawPrompt)) return "";
  const scored = scoringText(rawPrompt);
  let value = scored.text;
  if (!value) return "";

  for (const tag of [
    "recommended_plugins",
    "app-context",
    "environment_context",
    "permissions instructions",
  ]) {
    value = removeXmlBlock(value, tag);
  }

  value = value
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/giu, " [IMAGE] ")
    .replace(/<image\b[^>]*\/?>/giu, " [IMAGE] ")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " [IMAGE] ")
    .replace(/^##\s+My request for Codex:\s*/gimu, " ")
    .replace(/^#\s+Response annotations:\s*/gimu, " ");

  value = redactSensitiveText(value);
  value = truncateForClassifier(value, MAX_PROMPT_CHARS);
  value = normalized(value);

  if (
    !value ||
    /^<recommended_plugins>[\s\S]*<\/recommended_plugins>$/iu.test(value) ||
    !/[\p{L}\p{N}]/u.test(value)
  ) {
    return "";
  }
  return value;
}

export function detectLanguage(value: string): Language {
  const chinese = value.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latinWords = value.match(/[A-Za-z][A-Za-z0-9_.:/-]*/g)?.length ?? 0;
  if (chinese >= 2 && latinWords >= 2) return "mixed";
  return chinese >= 2 ? "zh" : "en";
}

export function splitForThread(threadId: string): Split {
  const bucket = Number.parseInt(sha256(threadId, 8), 16) % 100;
  if (bucket < 70) return "train";
  if (bucket < 85) return "validation";
  return "test";
}

export function routeForLabels(
  category: SemanticCategory,
  complexity: Complexity,
  config: RouterConfig,
): RouteName | "native" {
  if (category === "PASS_CONTEXT") return "native";
  const categoryRoute = config.routing.categoryRoutes[category];
  const complexityRoute = config.routing.complexityRoutes[complexity];
  if (complexityRoute === "inherit") return categoryRoute ?? "native";
  if (!categoryRoute) return complexityRoute ?? "native";
  const categoryIndex = config.routing.routeOrder.indexOf(categoryRoute);
  const complexityIndex = config.routing.routeOrder.indexOf(complexityRoute);
  if (categoryIndex < 0 || complexityIndex < 0) return "native";
  return categoryIndex >= complexityIndex ? categoryRoute : complexityRoute;
}

function promptHash(value: string): string {
  return sha256(value, 16);
}

function auditKey(threadId: string, hash: string): string {
  return `${threadId}:${hash}`;
}

async function walkJsonl(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        result.push(path);
      }
    }
  };
  await visit(root);
  return result.sort();
}

async function snapshotFiles(root: string): Promise<SnapshotFile[]> {
  const paths = await walkJsonl(root);
  return Promise.all(
    paths.map(async (path) => {
      const value = await stat(path);
      return {
        path,
        size: value.size,
        ino: Number(value.ino),
        dev: Number(value.dev),
        mtimeMs: value.mtimeMs,
      };
    }),
  );
}

function threadIdFromPath(path: string): string {
  return basename(path).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/iu)?.[1] ?? sha256(path, 16);
}

function inputText(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.content)) return "";
  return payload.content
    .filter(
      (item): item is { type: "input_text"; text: string } =>
        item !== null &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "input_text" &&
        typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => item.text)
    .join("\n")
    .trim();
}

async function readSession(
  snapshot: SnapshotFile,
  stats: ExtractionStats,
): Promise<SessionMessage[]> {
  if (snapshot.size === 0) return [];
  let threadId = threadIdFromPath(snapshot.path);
  const messages: SessionMessage[] = [];
  const stream = createReadStream(snapshot.path, { start: 0, end: snapshot.size - 1 });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const line of lines) {
    stats.lines_read += 1;
    let row: { type?: unknown; timestamp?: unknown; payload?: unknown };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      stats.malformed_lines += 1;
      continue;
    }
    const payload =
      row.payload !== null && typeof row.payload === "object"
        ? (row.payload as Record<string, unknown>)
        : undefined;
    if (!payload) continue;
    if (row.type === "session_meta" && typeof payload.id === "string") {
      threadId = payload.id;
      continue;
    }
    if (
      row.type !== "response_item" ||
      payload.type !== "message" ||
      payload.role !== "user"
    ) {
      continue;
    }
    stats.user_messages_seen += 1;
    const rawPrompt = inputText(payload);
    if (!rawPrompt) {
      stats.empty_after_cleaning += 1;
      continue;
    }
    messages.push({
      threadId,
      ...(typeof row.timestamp === "string" ? { timestamp: row.timestamp } : {}),
      rawPrompt,
    });
  }
  return messages;
}

async function readAudit(path: string, observations: Map<string, AuditObservation>): Promise<void> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return;
  }
  if (size === 0) return;
  const lines = createInterface({
    input: createReadStream(path, { start: 0, end: size - 1 }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof event.thread_id === "string" &&
        typeof event.prompt_hash === "string" &&
        typeof event.intent === "string" &&
        typeof event.route === "string"
      ) {
        observations.set(auditKey(event.thread_id, event.prompt_hash), {
          intent: event.intent as ExecutionIntent,
          route: event.route,
        });
      }
    } catch {
      // A malformed audit line is not allowed to block local preparation.
    }
  }
}

async function currentConfig(): Promise<RouterConfig> {
  try {
    return await loadConfig();
  } catch {
    return defaultConfig();
  }
}

async function currentRules(): Promise<RoutingRuleSet> {
  return loadRules(DEFAULT_RULES_FILE);
}

function buildRecord(
  message: SessionMessage,
  text: string,
  config: RouterConfig,
  rules: RoutingRuleSet,
  observations: Map<string, AuditObservation>,
): DatasetRecord {
  const rawHash = promptHash(message.rawPrompt);
  const cleanedHash = promptHash(text);
  const audit =
    observations.get(auditKey(message.threadId, rawHash)) ??
    observations.get(auditKey(message.threadId, cleanedHash));
  const intent = classifyExecutionIntent(text);
  const rule = classifyWithRules(text, rules);
  const complexity = deterministicComplexity(text);
  const observedIntent = audit?.intent ?? intent.intent;
  const route = audit?.route ?? routeForLabels(rule.category, complexity, config);
  const eligible =
    (observedIntent === "ask" || observedIntent === "do") &&
    rule.category !== "PASS_CONTEXT" &&
    rule.confidence >= rules.minimum_confidence;
  const labelStatus: LabelStatus = audit
    ? "observed"
    : eligible
      ? "seed_high_confidence"
      : "needs_review";

  return {
    schema_version: 1,
    id: sha256(`${message.threadId}\0${cleanedHash}`, 20),
    thread_id: message.threadId,
    ...(message.timestamp ? { timestamp: message.timestamp } : {}),
    prompt_hash: rawHash,
    text,
    chars: text.length,
    language: detectLanguage(text),
    split: splitForThread(message.threadId),
    eligible_for_seed_training: eligible,
    label_status: labelStatus,
    labels: {
      intent: observedIntent,
      category: rule.category,
      complexity,
      route,
    },
    evidence: {
      intent_source: audit ? "audit" : intent.source === "rule" ? "rule" : "fallback",
      category_source: "rule",
      route_source: audit ? "audit" : "deterministic",
      rule_reason: rule.reason,
      rule_confidence: rule.confidence,
      ...(rule.candidate ? { category_candidate: rule.candidate } : {}),
    },
  };
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const value = key(item);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function examplesBy(
  records: DatasetRecord[],
  key: (record: DatasetRecord) => string,
): Record<string, string[]> {
  const groups = new Map<string, DatasetRecord[]>();
  for (const record of records) {
    const value = key(record);
    const group = groups.get(value) ?? [];
    group.push(record);
    groups.set(value, group);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, group]) => [
        label,
        group
          .filter((item) => item.text.length <= 500)
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, 10)
          .map((item) => item.text),
      ]),
  );
}

function markdownExamples(title: string, groups: Record<string, string[]>): string {
  const sections = [`## ${title}`];
  for (const [label, examples] of Object.entries(groups)) {
    sections.push(`### ${label}`, "");
    examples.forEach((example, index) => {
      sections.push(`${index + 1}. ${example.replace(/\n/g, " ")}`);
    });
    sections.push("");
  }
  return sections.join("\n");
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await writePrivateAtomically(path, contents);
}

function asJsonl(records: DatasetRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
}

async function verifySources(
  snapshots: SnapshotFile[],
  stats: ExtractionStats,
): Promise<void> {
  for (const snapshot of snapshots) {
    let after: Stats;
    try {
      after = await stat(snapshot.path);
    } catch {
      stats.source_files_shrunk_or_replaced += 1;
      continue;
    }
    if (
      Number(after.ino) !== snapshot.ino ||
      Number(after.dev) !== snapshot.dev ||
      after.size < snapshot.size
    ) {
      stats.source_files_shrunk_or_replaced += 1;
    } else if (after.size > snapshot.size) {
      stats.source_files_grown += 1;
    } else {
      stats.source_files_unchanged += 1;
    }
  }
  if (stats.source_files_shrunk_or_replaced > 0) {
    throw new Error("one or more source session files were replaced or shrank during extraction");
  }
}

function parseOptions(args: string[]): CliOptions {
  let sourceRoot = DEFAULT_SOURCE_ROOT;
  let outputRoot = DEFAULT_OUTPUT_ROOT;
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === "--source" && args[index + 1]) {
      sourceRoot = resolve(args[++index] as string);
    } else if (item === "--output" && args[index + 1]) {
      outputRoot = resolve(args[++index] as string);
    } else {
      throw new Error(`unknown or incomplete argument: ${item}`);
    }
  }
  if (!isInside(TRAINING_ROOT, outputRoot)) {
    throw new Error("output must stay inside tools/training/");
  }
  if (isInside(sourceRoot, outputRoot) || isInside(outputRoot, sourceRoot)) {
    throw new Error("source and output paths must not overlap");
  }
  return { sourceRoot, outputRoot };
}

export async function prepareDataset(options: CliOptions): Promise<Record<string, unknown>> {
  await assertSeparatedTrees(options.sourceRoot, options.outputRoot, TRAINING_ROOT);
  const snapshots = await snapshotFiles(options.sourceRoot);
  const stats: ExtractionStats = {
    source_files: snapshots.length,
    source_bytes: snapshots.reduce((sum, item) => sum + item.size, 0),
    lines_read: 0,
    malformed_lines: 0,
    user_messages_seen: 0,
    generated_context_filtered: 0,
    empty_after_cleaning: 0,
    duplicate_prompts: 0,
    retained_prompts: 0,
    audit_matches: 0,
    source_files_unchanged: 0,
    source_files_grown: 0,
    source_files_shrunk_or_replaced: 0,
  };
  const config = await currentConfig();
  const rules = await currentRules();
  const audit = new Map<string, AuditObservation>();
  await readAudit(config.logging.auditFile, audit);
  await readAudit(`${config.logging.auditFile}.1`, audit);

  const records: DatasetRecord[] = [];
  const seen = new Set<string>();
  for (const snapshot of snapshots) {
    const messages = await readSession(snapshot, stats);
    for (const message of messages) {
      if (isGeneratedContext(message.rawPrompt)) {
        stats.generated_context_filtered += 1;
        continue;
      }
      const text = sanitizePrompt(message.rawPrompt);
      if (!text) {
        stats.empty_after_cleaning += 1;
        continue;
      }
      const dedupeKey = sha256(normalized(text));
      if (seen.has(dedupeKey)) {
        stats.duplicate_prompts += 1;
        continue;
      }
      seen.add(dedupeKey);
      const record = buildRecord(message, text, config, rules, audit);
      if (record.label_status === "observed") stats.audit_matches += 1;
      records.push(record);
    }
  }
  records.sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? "") || a.id.localeCompare(b.id));
  stats.retained_prompts = records.length;
  await verifySources(snapshots, stats);

  const trainable = records.filter((record) => record.eligible_for_seed_training);
  const review = records.filter((record) => record.label_status === "needs_review");
  const splits = {
    train: trainable.filter((record) => record.split === "train"),
    validation: trainable.filter((record) => record.split === "validation"),
    test: trainable.filter((record) => record.split === "test"),
  };
  const distributions = {
    language: countBy(records, (record) => record.language),
    label_status: countBy(records, (record) => record.label_status),
    intent: countBy(records, (record) => record.labels.intent),
    category: countBy(records, (record) => record.labels.category),
    complexity: countBy(records, (record) => record.labels.complexity),
    route: countBy(records, (record) => record.labels.route),
    split: countBy(trainable, (record) => record.split),
  };
  const examples = {
    language: examplesBy(records, (record) => record.language),
    label_status: examplesBy(records, (record) => record.label_status),
    intent: examplesBy(records, (record) => record.labels.intent),
    category: examplesBy(records, (record) => record.labels.category),
    complexity: examplesBy(records, (record) => record.labels.complexity),
    route: examplesBy(records, (record) => record.labels.route),
  };
  const generatedAt = new Date().toISOString();
  const manifest = {
    schema_version: 1,
    generated_at: generatedAt,
    source_root: options.sourceRoot,
    output_root: options.outputRoot,
    source_policy: "read_only_snapshot",
    raw_prompts_copied: false,
    sanitization: {
      home_paths: true,
      emails: true,
      common_api_keys: true,
      bearer_tokens: true,
      jwt: true,
      max_prompt_chars: MAX_PROMPT_CHARS,
    },
    stats,
    datasets: {
      all: records.length,
      trainable_seed: trainable.length,
      review: review.length,
      train: splits.train.length,
      validation: splits.validation.length,
      test: splits.test.length,
    },
    distributions,
    output_sha256: {
      all: sha256(asJsonl(records)),
      trainable_seed: sha256(asJsonl(trainable)),
      review: sha256(asJsonl(review)),
    },
  };

  await atomicWrite(resolve(options.outputRoot, "all.jsonl"), asJsonl(records));
  await atomicWrite(resolve(options.outputRoot, "trainable-seed.jsonl"), asJsonl(trainable));
  await atomicWrite(resolve(options.outputRoot, "review.jsonl"), asJsonl(review));
  await atomicWrite(resolve(options.outputRoot, "splits/train.jsonl"), asJsonl(splits.train));
  await atomicWrite(
    resolve(options.outputRoot, "splits/validation.jsonl"),
    asJsonl(splits.validation),
  );
  await atomicWrite(resolve(options.outputRoot, "splits/test.jsonl"), asJsonl(splits.test));
  await atomicWrite(
    resolve(options.outputRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const report = [
    "# Local Router dataset review",
    "",
    `Generated: ${generatedAt}`,
    "",
    "This report contains sanitized local examples. It is ignored by Git together with the dataset.",
    "",
    "## Counts",
    "",
    "```json",
    JSON.stringify({ datasets: manifest.datasets, distributions }, null, 2),
    "```",
    "",
    markdownExamples("Language examples", examples.language),
    markdownExamples("Label-status examples", examples.label_status),
    markdownExamples("Intent examples", examples.intent),
    markdownExamples("Category examples", examples.category),
    markdownExamples("Complexity examples", examples.complexity),
    markdownExamples("Route examples", examples.route),
  ].join("\n");
  await atomicWrite(resolve(options.outputRoot, "reports/review.md"), `${report}\n`);
  await hardenPrivateTree(options.outputRoot);
  return manifest;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const manifest = await prepareDataset(options);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) {
  await main();
}
