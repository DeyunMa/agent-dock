import { readFile } from "node:fs/promises";
import { scoringText } from "./legacy-prompt.js";
import {
  SEMANTIC_CATEGORIES,
  type SemanticCategory,
} from "../../../src/router/core/types.js";

export interface RulePattern {
  regex: string;
  weight: number;
}

export interface CategoryRule {
  id: SemanticCategory;
  priority: number;
  context: string;
  requires?: string[][];
  patterns?: RulePattern[];
}

export interface RuleModifier {
  id: string;
  regex: string;
  adjust: Partial<Record<SemanticCategory, number>>;
}

export interface RoutingRuleSet {
  schema_version: number;
  router_version: string;
  minimum_score: number;
  minimum_margin: number;
  minimum_confidence: number;
  category_thresholds?: Partial<
    Record<
      SemanticCategory,
      { minimum_score?: number; minimum_margin?: number; minimum_confidence?: number }
    >
  >;
  strong_evidence_override?: {
    minimum_score: number;
    minimum_margin: number;
    minimum_confidence: number;
    minimum_evidence_count: number;
  };
  categories: CategoryRule[];
  modifiers?: RuleModifier[];
  pass_patterns: string[];
  suppress_patterns?: string[];
}

export interface RuleDecision {
  category: SemanticCategory;
  candidate?: SemanticCategory;
  confidence: number;
  reason: string;
  scores: Partial<Record<SemanticCategory, number>>;
  margin?: number;
  modifierHits?: string[];
  evidenceCount?: number;
  preprocessing?: string;
  suppressed: boolean;
  passContext: boolean;
}

export async function loadRules(path: string): Promise<RoutingRuleSet> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as RoutingRuleSet;
  if (
    parsed.schema_version !== 1 ||
    !Array.isArray(parsed.categories) ||
    !Array.isArray(parsed.pass_patterns)
  ) {
    throw new Error("unsupported router rules schema");
  }
  return parsed;
}

const regexCache = new Map<string, RegExp | undefined>();

function compiledRegex(pattern: string): RegExp | undefined {
  if (regexCache.has(pattern)) return regexCache.get(pattern);
  try {
    let source = pattern;
    let flags = "is";
    const inline = source.match(/^\(\?([ims]+)\)/);
    if (inline) {
      if (inline[1]?.includes("m")) flags += "m";
      source = source.slice(inline[0].length);
    }
    const compiled = new RegExp(source, [...new Set(flags)].join(""));
    regexCache.set(pattern, compiled);
    return compiled;
  } catch {
    regexCache.set(pattern, undefined);
    return undefined;
  }
}

function matches(pattern: string, text: string): boolean {
  return compiledRegex(pattern)?.test(text) ?? false;
}

function requirementsMet(category: CategoryRule, prompt: string): boolean {
  return (category.requires ?? []).every((group) => group.some((pattern) => matches(pattern, prompt)));
}

function passDecision(reason: string, suppressed = false, preprocessing?: string): RuleDecision {
  return {
    category: "PASS_CONTEXT",
    confidence: suppressed ? 1 : 0.99,
    reason,
    scores: {},
    suppressed,
    passContext: true,
    ...(preprocessing ? { preprocessing } : {}),
  };
}

const ROUTER_SUPPRESSION = /(?:不要|不用|关闭|停用|跳过).{0,8}(?:这个)?(?:路由|router|routing)|(?:路由|router|routing).{0,8}(?:关闭|停用|off)/is;
const PLAIN_ANSWER = /(?:no workflow|just chat|plain answer)|(?:只|直接)(?:回答|回复)(?:一句话|结论|问题|即可|就行)?/is;
const AGENT_SURFACE = /(?:Codex|AGENTS\.md|CLAUDE\.md|SKILL\.md|UserPromptSubmit|PreToolUse|PostToolUse|hook|hooks|skill|技能|子智能体|subagent|agent|智能体|MCP|自动化|automation|router|路由器)/is;
const AGENT_WORK = /(?:配置|安装|接入|修改|创建|编写|实现|审计|检查|分析|调用|触发|加载|工作流|机制|路由|分类|设计|架构|代理|怎么做|如何做|优化|同步|说明|约束|生成|增强|讨论|判断|调试|作用域|步骤|流程|透明)/is;

export function classifyWithRules(prompt: string, rules: RoutingRuleSet): RuleDecision {
  const rawNormalized = prompt.trim().replace(/\s+/g, " ");
  if (ROUTER_SUPPRESSION.test(rawNormalized)) {
    return passDecision("explicit_suppression", true);
  }
  if (PLAIN_ANSWER.test(rawNormalized)) {
    return {
      category: "RESEARCH_EXPLAIN",
      confidence: 0.95,
      reason: "plain_answer_guard",
      scores: { RESEARCH_EXPLAIN: 10 },
      margin: 10,
      evidenceCount: 1,
      suppressed: false,
      passContext: false,
    };
  }
  if ((rules.suppress_patterns ?? []).some((pattern) => matches(pattern, rawNormalized))) {
    return passDecision("explicit_suppression", true);
  }
  if (rules.pass_patterns.some((pattern) => matches(pattern, rawNormalized))) {
    return passDecision("pass_pattern");
  }

  const scored = scoringText(prompt);
  if (!scored.text) {
    return passDecision(scored.preprocessing ?? "empty", false, scored.preprocessing);
  }
  if (rules.pass_patterns.some((pattern) => matches(pattern, scored.text))) {
    return passDecision("context_dependent", false, scored.preprocessing);
  }

  // Weighted rules intentionally favor precision and can abstain on short
  // Router/Hook requests. This two-signal guard is more reliable than a 2B
  // model for the Router's own control surface.
  if (AGENT_SURFACE.test(scored.text) && AGENT_WORK.test(scored.text)) {
    return {
      category: "AGENT_WORKFLOW",
      confidence: 0.95,
      reason: "agent_surface_guard",
      scores: { AGENT_WORKFLOW: 10 },
      margin: 10,
      evidenceCount: 2,
      suppressed: false,
      passContext: false,
      ...(scored.preprocessing ? { preprocessing: scored.preprocessing } : {}),
    };
  }

  const categories = new Map(rules.categories.map((category) => [category.id, category]));
  const scores: Partial<Record<SemanticCategory, number>> = {};
  const evidence: Partial<Record<SemanticCategory, string[]>> = {};
  const eligible: Partial<Record<SemanticCategory, boolean>> = {};
  for (const category of rules.categories) {
    scores[category.id] = 0;
    evidence[category.id] = [];
    eligible[category.id] = requirementsMet(category, scored.text);
    if (!eligible[category.id]) continue;
    for (const item of category.patterns ?? []) {
      if (matches(item.regex, scored.text)) {
        scores[category.id] = (scores[category.id] ?? 0) + item.weight;
        evidence[category.id]?.push(item.regex);
      }
    }
  }

  const modifierHits: string[] = [];
  for (const modifier of rules.modifiers ?? []) {
    if (!matches(modifier.regex, scored.text)) continue;
    modifierHits.push(modifier.id);
    for (const category of SEMANTIC_CATEGORIES) {
      const adjustment = modifier.adjust[category];
      if (eligible[category] && typeof adjustment === "number") {
        scores[category] = (scores[category] ?? 0) + adjustment;
      }
    }
  }

  const ranked = rules.categories
    .filter((category) => eligible[category.id])
    .sort((a, b) => {
      const scoreDifference = (scores[b.id] ?? 0) - (scores[a.id] ?? 0);
      return scoreDifference || b.priority - a.priority;
    });
  const topRule = ranked[0];
  if (!topRule) {
    return {
      category: "PASS_CONTEXT",
      confidence: 0.6,
      reason: "no_eligible_category",
      scores,
      suppressed: false,
      passContext: false,
      ...(scored.preprocessing ? { preprocessing: scored.preprocessing } : {}),
    };
  }

  const runner = ranked[1];
  const topScore = scores[topRule.id] ?? 0;
  const runnerScore = runner ? (scores[runner.id] ?? 0) : 0;
  const margin = topScore - runnerScore;
  const confidence = Math.min(0.98, Math.max(0, 0.55 + 0.04 * topScore + 0.04 * margin));
  const threshold = rules.category_thresholds?.[topRule.id] ?? {};
  const minimumScore = threshold.minimum_score ?? rules.minimum_score;
  const minimumMargin = threshold.minimum_margin ?? rules.minimum_margin;
  const minimumConfidence = threshold.minimum_confidence ?? rules.minimum_confidence;
  const override = rules.strong_evidence_override;
  const evidenceCount = evidence[topRule.id]?.length ?? 0;
  const strongEvidence = Boolean(
    override &&
      topScore >= override.minimum_score &&
      margin >= override.minimum_margin &&
      confidence >= override.minimum_confidence &&
      evidenceCount >= override.minimum_evidence_count,
  );

  const common = {
    confidence: Math.round(confidence * 1000) / 1000,
    scores,
    margin: Math.round(margin * 1000) / 1000,
    modifierHits,
    suppressed: false,
    passContext: false,
    ...(scored.preprocessing ? { preprocessing: scored.preprocessing } : {}),
  };

  if (
    !strongEvidence &&
    (topScore < minimumScore || margin < minimumMargin || confidence < minimumConfidence)
  ) {
    return {
      category: "PASS_CONTEXT",
      candidate: topRule.id,
      reason: "below_threshold",
      ...common,
    };
  }

  return {
    category: topRule.id,
    reason: "classified",
    evidenceCount,
    ...common,
  };
}

export function isSemanticCategory(value: unknown): value is SemanticCategory {
  return typeof value === "string" && SEMANTIC_CATEGORIES.includes(value as SemanticCategory);
}
