import { appendAudit, promptHash } from "./audit.js";
import { resolveExecutionIntent, type IntentDecision } from "./intent.js";
import { validateProfile } from "./model-catalog.js";
import { OllamaClassifier } from "./ollama-classifier.js";
import { deterministicComplexity, extractTurnPrompt } from "./prompt.js";
import { classifyWithRules } from "./rules.js";
import type {
  AiDecision,
  AiClassification,
  ModelCatalog,
  RouteDecision,
  RouterConfig,
  RoutingRuleSet,
  SemanticCategory,
  TurnStartParams,
} from "./types.js";

export interface RoutingEngine {
  readonly config: RouterConfig;
  warmup(): void;
  setModelCatalog(catalog: ModelCatalog): void;
  routeTurn(params: TurnStartParams, options?: RouteOptions): Promise<RouteDecision>;
}

interface StoredRoute {
  category: SemanticCategory;
  complexity: RouteDecision["complexity"];
  routeName: string;
}

export interface RouteOptions {
  manualModelOverride?: boolean;
  triggeredAt?: string;
  surface?: "desktop" | "terminal" | "management";
}

export interface AiClassifier {
  classify(prompt: string): Promise<AiClassification>;
  warmup(): Promise<void>;
}

type RoutingControl = "step_up" | "max" | "auto";

const MAX_STORED_THREAD_ROUTES = 256;

/**
 * Session continuity is owned independently from a particular config/rules
 * snapshot, so a hot reload cannot silently forget the current thread route.
 */
export class RouterSessionState {
  private readonly routes = new Map<string, StoredRoute>();

  get(key: string): StoredRoute | undefined {
    const value = this.routes.get(key);
    if (!value) return undefined;
    this.routes.delete(key);
    this.routes.set(key, value);
    return value;
  }

  set(key: string, value: StoredRoute): void {
    this.routes.delete(key);
    this.routes.set(key, value);
    while (this.routes.size > MAX_STORED_THREAD_ROUTES) {
      const oldest = this.routes.keys().next().value as string | undefined;
      if (!oldest) break;
      this.routes.delete(oldest);
    }
  }

  delete(key: string): void {
    this.routes.delete(key);
  }
}

function normalizeControlText(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[。！!？?]+$/u, "")
    .trim();
}

export class RouterEngine implements RoutingEngine {
  private catalog?: ModelCatalog;

  constructor(
    readonly config: RouterConfig,
    private readonly rules: RoutingRuleSet,
    private readonly ai: AiClassifier = new OllamaClassifier(config.ollama),
    private readonly sessionState = new RouterSessionState(),
  ) {}

  warmup(): void {
    void this.ai.warmup();
  }

  setModelCatalog(catalog: ModelCatalog): void {
    this.catalog = catalog;
  }

  private stickyDecision(
    params: TurnStartParams,
    prompt: string,
    rule: ReturnType<typeof classifyWithRules>,
    intent: IntentDecision,
    started: number,
  ): RouteDecision | undefined {
    if (!this.config.routing.stickyTurns || rule.suppressed) return undefined;
    const key = params.threadId ?? "__default__";
    const stored = this.sessionState.get(key);
    if (!stored) return undefined;
    const configuredProfile = this.config.routes[stored.routeName];
    if (!configuredProfile) {
      this.sessionState.delete(key);
      return undefined;
    }
    const validation = validateProfile(configuredProfile, this.catalog);
    if (!validation.valid) {
      this.sessionState.delete(key);
      return undefined;
    }
    return {
      action: "apply",
      intent: intent.intent,
      intentSource: intent.source,
      intentReason: intent.reason,
      category: stored.category,
      complexity: stored.complexity,
      routeName: stored.routeName,
      profile: { ...validation.profile },
      reason: "sticky_context",
      rule,
      sticky: true,
      promptHash: promptHash(prompt),
      promptChars: prompt.length,
      latencyMs: Math.round(performance.now() - started),
    };
  }

  private routeRank(name: string): number {
    const index = this.config.routing.routeOrder.indexOf(name);
    return index < 0 ? 0 : index;
  }

  private routingControl(prompt: string): RoutingControl | undefined {
    const normalized = normalizeControlText(prompt);
    if (!normalized) return undefined;
    const matches = (values: string[]) =>
      values.some((value) => normalizeControlText(value) === normalized);
    if (matches(this.config.routing.controls.auto)) return "auto";
    if (matches(this.config.routing.controls.max)) return "max";
    if (matches(this.config.routing.controls.stepUp)) return "step_up";
    return undefined;
  }

  private routeFromTurnParams(params: TurnStartParams): string | undefined {
    const collaborationSettings = params.collaborationMode?.settings;
    const model = collaborationSettings?.model ?? params.model;
    const effort = collaborationSettings?.reasoning_effort ?? params.effort;
    if (typeof model !== "string" && typeof effort !== "string") return undefined;
    return this.config.routing.routeOrder.find((name) => {
      const profile = this.config.routes[name];
      if (!profile) return false;
      if (typeof model === "string" && profile.model !== model) return false;
      if (typeof effort === "string" && profile.effort !== effort) return false;
      return true;
    });
  }

  private chooseRoute(category: SemanticCategory, complexity: RouteDecision["complexity"]): string | undefined {
    const categoryRoute = this.config.routing.categoryRoutes[category];
    const complexityRoute = this.config.routing.complexityRoutes[complexity];
    if (categoryRoute === "inherit" && complexityRoute === "inherit") return undefined;
    if (categoryRoute === "inherit") return complexityRoute;
    if (complexityRoute === "inherit") return categoryRoute;
    return this.routeRank(complexityRoute) > this.routeRank(categoryRoute)
      ? complexityRoute
      : categoryRoute;
  }

  private mergeComplexity(
    deterministic: RouteDecision["complexity"],
    ai: AiDecision | undefined,
  ): RouteDecision["complexity"] {
    if (!ai || ai.confidence < 0.5) return deterministic;
    const order: RouteDecision["complexity"][] = ["simple", "normal", "complex", "extreme"];
    const deterministicIndex = order.indexOf(deterministic);
    const aiIndex = order.indexOf(ai.complexity);
    if (deterministic === "extreme") return "extreme";
    // A 2B classifier is useful for a one-level escalation but is not trusted
    // to jump a short request straight to the most expensive route.
    const aiCeiling = Math.min(deterministicIndex + 1, order.indexOf("complex"));
    return order[Math.max(deterministicIndex, Math.min(aiIndex, aiCeiling))] ?? deterministic;
  }

  private async audit(
    params: TurnStartParams,
    prompt: string,
    decision: RouteDecision,
    triggeredAt?: string,
    surface?: RouteOptions["surface"],
  ): Promise<RouteDecision> {
    try {
      await appendAudit(this.config, params, decision, {
        ...(triggeredAt ? { triggeredAt } : {}),
        ...(surface ? { surface } : {}),
      });
    } catch {
      // Auditing must never break routing or the Codex protocol.
    }
    return decision;
  }

  async routeTurn(params: TurnStartParams, options: RouteOptions = {}): Promise<RouteDecision> {
    const started = performance.now();
    const prompt = extractTurnPrompt(params);
    const rule = classifyWithRules(prompt, this.rules);
    const key = params.threadId ?? "__default__";
    const control = this.routingControl(prompt);
    const initialIntent = resolveExecutionIntent(prompt, { control: control !== undefined });
    const base = {
      rule,
      intent: initialIntent.intent,
      intentSource: initialIntent.source,
      intentReason: initialIntent.reason,
      sticky: false,
      promptHash: promptHash(prompt),
      promptChars: prompt.length,
    };
    const finish = (decision: RouteDecision) =>
      this.audit(params, prompt, decision, options.triggeredAt, options.surface);

    if (!this.config.enabled || options.manualModelOverride) {
      return finish({
        action: "inherit",
        category: rule.category,
        complexity: deterministicComplexity(prompt),
        reason: !this.config.enabled ? "router_disabled" : "manual_model_override",
        ...base,
        latencyMs: Math.round(performance.now() - started),
      });
    }

    if (control === "auto") {
      this.sessionState.delete(key);
      return finish({
        action: "inherit",
        category: "PASS_CONTEXT",
        complexity: deterministicComplexity(prompt),
        reason: "manual_auto",
        ...base,
        latencyMs: Math.round(performance.now() - started),
      });
    }

    if (control === "step_up" || control === "max") {
      const stored = this.sessionState.get(key);
      const routeOrder = this.config.routing.routeOrder;
      const baselineRoute = stored?.routeName ?? this.routeFromTurnParams(params);
      const baselineIndex = baselineRoute ? routeOrder.indexOf(baselineRoute) : -1;
      const routeName =
        control === "max"
          ? routeOrder.at(-1)
          : baselineIndex >= 0
            ? routeOrder[Math.min(baselineIndex + 1, routeOrder.length - 1)]
            : this.config.routing.controls.fallbackRoute;
      const configuredProfile = routeName ? this.config.routes[routeName] : undefined;
      if (!routeName || !configuredProfile) {
        return finish({
          action: "inherit",
          category: stored?.category ?? "PASS_CONTEXT",
          complexity: stored?.complexity ?? deterministicComplexity(prompt),
          reason: "manual_control_route_missing",
          ...base,
          latencyMs: Math.round(performance.now() - started),
        });
      }
      const validation = validateProfile(configuredProfile, this.catalog);
      if (!validation.valid) {
        return finish({
          action: "inherit",
          category: stored?.category ?? "PASS_CONTEXT",
          complexity: stored?.complexity ?? deterministicComplexity(prompt),
          reason: validation.reason ?? "manual_control_route_invalid",
          ...base,
          latencyMs: Math.round(performance.now() - started),
        });
      }

      const category = stored?.category ?? "PASS_CONTEXT";
      const complexity = stored?.complexity ?? deterministicComplexity(prompt);
      const decision: RouteDecision = {
        action: "apply",
        category,
        complexity,
        routeName,
        profile: { ...validation.profile },
        reason: control === "max" ? "manual_max" : "manual_step_up",
        ...base,
        latencyMs: Math.round(performance.now() - started),
      };
      this.sessionState.set(key, {
        category,
        complexity,
        routeName,
      });
      return finish(decision);
    }

    if (!prompt || rule.suppressed || rule.passContext) {
      const sticky = this.stickyDecision(params, prompt, rule, initialIntent, started);
      if (sticky) return finish(sticky);
      return finish({
        action: "inherit",
        category: "PASS_CONTEXT",
        complexity: deterministicComplexity(prompt),
        reason: rule.reason,
        ...base,
        latencyMs: Math.round(performance.now() - started),
      });
    }

    let aiResult: AiClassification | undefined;
    try {
      aiResult = await this.ai.classify(prompt);
    } catch {
      aiResult = { status: "error" };
    }
    const ai = aiResult?.decision;
    const resolvedIntent = resolveExecutionIntent(prompt, ai ? { aiIntent: ai.intent } : {});
    const resolvedBase = {
      ...base,
      intent: resolvedIntent.intent,
      intentSource: resolvedIntent.source,
      intentReason: resolvedIntent.reason,
    };
    const aiMetadata = {
      ...(ai ? { ai } : {}),
      ...(aiResult ? { aiStatus: aiResult.status } : {}),
      ...(aiResult?.latencyMs !== undefined ? { aiLatencyMs: aiResult.latencyMs } : {}),
    };

    let category = rule.category;
    if (
      category === "PASS_CONTEXT" &&
      ai &&
      ai.category !== "PASS_CONTEXT" &&
      ai.confidence >= this.config.ollama.minimumConfidence
    ) {
      category = ai.category;
    }

    if (category === "PASS_CONTEXT") {
      const sticky = this.stickyDecision(params, prompt, rule, resolvedIntent, started);
      if (sticky) return finish({ ...sticky, ...aiMetadata });
      return finish({
        action: "inherit",
        category,
        complexity: this.mergeComplexity(deterministicComplexity(prompt), ai),
        reason: ai ? "ai_below_threshold" : "unclassified_fail_open",
        ...resolvedBase,
        ...aiMetadata,
        latencyMs: Math.round(performance.now() - started),
      });
    }

    const complexity = this.mergeComplexity(deterministicComplexity(prompt), ai);
    const routeName = this.chooseRoute(category, complexity);
    const configuredProfile = routeName ? this.config.routes[routeName] : undefined;
    if (!routeName || !configuredProfile) {
      return finish({
        action: "inherit",
        category,
        complexity,
        reason: "route_inherit",
        ...resolvedBase,
        ...aiMetadata,
        latencyMs: Math.round(performance.now() - started),
      });
    }

    const validation = validateProfile(configuredProfile, this.catalog);
    if (!validation.valid) {
      return finish({
        action: "inherit",
        category,
        complexity,
        routeName,
        reason: validation.reason ?? "invalid_route_profile",
        ...resolvedBase,
        ...aiMetadata,
        latencyMs: Math.round(performance.now() - started),
      });
    }

    const decision: RouteDecision = {
      action: "apply",
      category,
      complexity,
      routeName,
      profile: { ...validation.profile },
      reason: rule.category !== "PASS_CONTEXT" ? "rule_plus_ai" : "ai_fallback",
      ...resolvedBase,
      ...aiMetadata,
      latencyMs: Math.round(performance.now() - started),
    };
    this.sessionState.set(key, {
      category,
      complexity,
      routeName,
    });
    return finish(decision);
  }
}
