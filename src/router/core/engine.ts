import { appendAudit, promptHash } from "./audit.js";
import { EmbeddingClassifier } from "./embedding-classifier.js";
import { hardGuard, isExplicitContinuation } from "./hard-guards.js";
import { validateProfile } from "./model-catalog.js";
import { extractTurnPrompt } from "./prompt.js";
import type {
  AiClassification,
  Complexity,
  ExecutionIntent,
  IntentSource,
  ModelCatalog,
  RouteDecision,
  RouteProfile,
  RouterConfig,
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
  complexity: Complexity;
  routeName: string;
}

type ResolvedRoute =
  | {
      action: "apply";
      routeName: string;
      profile: RouteProfile;
    }
  | {
      action: "inherit";
      routeName?: string;
      reason: string;
    };

export interface RouteOptions {
  manualModelOverride?: boolean;
  triggeredAt?: string;
  surface?: "desktop" | "terminal" | "management";
}

export interface AiClassifier {
  classify(prompt: string): Promise<AiClassification>;
  warmup(): Promise<void>;
}

interface IntentMetadata {
  intent: ExecutionIntent;
  intentSource: IntentSource;
  intentReason: string;
}

type RoutingControl = "step_up" | "max" | "auto";

const MAX_STORED_THREAD_ROUTES = 256;

/**
 * Session continuity is owned independently from a particular config or
 * classifier snapshot, so hot reloads cannot forget the current thread route.
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

function fallbackIntent(
  prompt: string,
  reason: string,
): IntentMetadata {
  return {
    intent: isExplicitContinuation(prompt) ? "continue" : "unknown",
    intentSource: "fallback",
    intentReason: reason,
  };
}

export class RouterEngine implements RoutingEngine {
  private catalog?: ModelCatalog;

  constructor(
    readonly config: RouterConfig,
    private readonly ai: AiClassifier = new EmbeddingClassifier(config.classifier),
    private readonly sessionState = new RouterSessionState(),
  ) {}

  warmup(): void {
    void this.ai.warmup();
  }

  setModelCatalog(catalog: ModelCatalog): void {
    this.catalog = catalog;
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

  private chooseRoute(category: SemanticCategory, complexity: Complexity): string | undefined {
    const categoryRoute = this.config.routing.categoryRoutes[category];
    const complexityRoute = this.config.routing.complexityRoutes[complexity];
    if (categoryRoute === "inherit" && complexityRoute === "inherit") return undefined;
    if (categoryRoute === "inherit") return complexityRoute;
    if (complexityRoute === "inherit") return categoryRoute;
    return this.routeRank(complexityRoute) > this.routeRank(categoryRoute)
      ? complexityRoute
      : categoryRoute;
  }

  private resolveRoute(category: SemanticCategory, complexity: Complexity): ResolvedRoute {
    const routeName = this.chooseRoute(category, complexity);
    const configuredProfile = routeName ? this.config.routes[routeName] : undefined;
    if (!routeName || !configuredProfile) {
      return { action: "inherit", reason: "route_inherit" };
    }
    const validation = validateProfile(configuredProfile, this.catalog);
    if (!validation.valid) {
      return {
        action: "inherit",
        routeName,
        reason: validation.reason ?? "invalid_route_profile",
      };
    }
    return {
      action: "apply",
      routeName,
      profile: { ...validation.profile },
    };
  }

  private stickyDecision(
    params: TurnStartParams,
    prompt: string,
    intent: IntentMetadata,
    started: number,
  ): RouteDecision | undefined {
    if (!this.config.routing.stickyTurns) return undefined;
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
      ...intent,
      category: stored.category,
      complexity: stored.complexity,
      routeName: stored.routeName,
      profile: { ...validation.profile },
      reason: "sticky_context",
      sticky: true,
      promptHash: promptHash(prompt),
      promptChars: prompt.length,
      latencyMs: Math.round(performance.now() - started),
    };
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
    const key = params.threadId ?? "__default__";
    const control = this.routingControl(prompt);
    const finish = (decision: RouteDecision) =>
      this.audit(params, prompt, decision, options.triggeredAt, options.surface);
    const common = {
      sticky: false,
      promptHash: promptHash(prompt),
      promptChars: prompt.length,
    };

    if (!this.config.enabled || options.manualModelOverride) {
      return finish({
        action: "inherit",
        ...fallbackIntent(prompt, "router_bypass"),
        category: "PASS_CONTEXT",
        complexity: "normal",
        reason: !this.config.enabled ? "router_disabled" : "manual_model_override",
        ...common,
        latencyMs: Math.round(performance.now() - started),
      });
    }

    const manualIntent: IntentMetadata = {
      intent: "control",
      intentSource: "manual",
      intentReason: "router_control",
    };

    if (control === "auto") {
      this.sessionState.delete(key);
      return finish({
        action: "inherit",
        ...manualIntent,
        category: "PASS_CONTEXT",
        complexity: "normal",
        reason: "manual_auto",
        ...common,
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
      const category = stored?.category ?? "PASS_CONTEXT";
      const complexity = stored?.complexity ?? "normal";
      if (!routeName || !configuredProfile) {
        return finish({
          action: "inherit",
          ...manualIntent,
          category,
          complexity,
          reason: "manual_control_route_missing",
          ...common,
          latencyMs: Math.round(performance.now() - started),
        });
      }
      const validation = validateProfile(configuredProfile, this.catalog);
      if (!validation.valid) {
        return finish({
          action: "inherit",
          ...manualIntent,
          category,
          complexity,
          reason: validation.reason ?? "manual_control_route_invalid",
          ...common,
          latencyMs: Math.round(performance.now() - started),
        });
      }
      const decision: RouteDecision = {
        action: "apply",
        ...manualIntent,
        category,
        complexity,
        routeName,
        profile: { ...validation.profile },
        reason: control === "max" ? "manual_max" : "manual_step_up",
        ...common,
        latencyMs: Math.round(performance.now() - started),
      };
      this.sessionState.set(key, { category, complexity, routeName });
      return finish(decision);
    }

    const guard = hardGuard(prompt);
    if (guard) {
      return finish({
        action: "inherit",
        ...fallbackIntent(prompt, guard.reason),
        category: "PASS_CONTEXT",
        complexity: "normal",
        reason: guard.reason,
        ...common,
        latencyMs: Math.round(performance.now() - started),
      });
    }

    let aiResult: AiClassification;
    try {
      aiResult = await this.ai.classify(prompt);
    } catch {
      aiResult = { status: "error" };
    }
    const ai = aiResult.decision;
    const aiMetadata = {
      ...(ai ? { ai } : {}),
      aiStatus: aiResult.status,
      ...(aiResult.latencyMs !== undefined ? { aiLatencyMs: aiResult.latencyMs } : {}),
    };

    if (!ai) {
      const intent = fallbackIntent(prompt, `classifier_${aiResult.status}`);
      if (intent.intent === "continue") {
        const sticky = this.stickyDecision(params, prompt, intent, started);
        if (sticky) return finish({ ...sticky, ...aiMetadata });
      }
      return finish({
        action: "inherit",
        ...intent,
        category: "PASS_CONTEXT",
        complexity: "normal",
        reason: "classifier_fail_open",
        ...aiMetadata,
        ...common,
        latencyMs: Math.round(performance.now() - started),
      });
    }

    const classifierIntent: IntentMetadata = {
      intent: ai.intent,
      intentSource: "classifier",
      intentReason: "local_embedding_classifier",
    };
    if (ai.category === "PASS_CONTEXT") {
      const sticky = this.stickyDecision(params, prompt, classifierIntent, started);
      if (sticky) return finish({ ...sticky, ...aiMetadata });
      return finish({
        action: "inherit",
        ...classifierIntent,
        category: ai.category,
        complexity: ai.complexity,
        reason: "classifier_pass_context",
        ...aiMetadata,
        ...common,
        latencyMs: Math.round(performance.now() - started),
      });
    }

    const resolution = this.resolveRoute(ai.category, ai.complexity);
    if (resolution.action === "inherit") {
      return finish({
        action: "inherit",
        ...classifierIntent,
        category: ai.category,
        complexity: ai.complexity,
        ...(resolution.routeName ? { routeName: resolution.routeName } : {}),
        reason: resolution.reason,
        ...aiMetadata,
        ...common,
        latencyMs: Math.round(performance.now() - started),
      });
    }

    const decision: RouteDecision = {
      action: "apply",
      ...classifierIntent,
      category: ai.category,
      complexity: ai.complexity,
      routeName: resolution.routeName,
      profile: resolution.profile,
      reason: "embedding_primary",
      ...aiMetadata,
      ...common,
      latencyMs: Math.round(performance.now() - started),
    };
    this.sessionState.set(key, {
      category: ai.category,
      complexity: ai.complexity,
      routeName: resolution.routeName,
    });
    return finish(decision);
  }
}
