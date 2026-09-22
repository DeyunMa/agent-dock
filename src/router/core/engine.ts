import { appendAudit, promptHash } from "./audit.js";
import { JevClassifier } from "./jev-classifier.js";
import { ThreadRoutes, type ThreadRoute } from "./thread-routes.js";
import { hardGuard, isExplicitContinuation } from "./hard-guards.js";
import { validateProfile } from "./model-catalog.js";
import { extractTurnPrompt } from "./prompt.js";
import type {
  AiClassification,
  ExecutionIntent,
  IntentSource,
  ModelCatalog,
  RouteDecision,
  RouteProfile,
  RouterConfig,
  TurnStartParams,
} from "./types.js";

export interface RoutingEngine {
  readonly config: RouterConfig;
  warmup(): void;
  setModelCatalog(catalog: ModelCatalog): void;
  routeTurn(params: TurnStartParams, options?: RouteOptions): Promise<RouteDecision>;
}

export interface RouteOptions {
  manualModelOverride?: boolean;
  existingThread?: boolean;
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
  private readonly store: ThreadRoutes;
  private readonly pending = new Map<string, Promise<RouteDecision>>();

  constructor(
    readonly config: RouterConfig,
    private readonly ai: AiClassifier = new JevClassifier(config),
  ) { this.store = new ThreadRoutes(config.routing.stateDirectory); }

  warmup(): void {
    void this.ai.warmup();
  }

  setModelCatalog(catalog: ModelCatalog): void {
    this.catalog = catalog;
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
    const key = params.threadId;
    if (key) await this.pending.get(key)?.catch(() => undefined);
    const task = this.routeOnce(params, options);
    if (key) this.pending.set(key, task);
    try { return await task; }
    finally { if (key && this.pending.get(key) === task) this.pending.delete(key); }
  }

  private async routeOnce(params: TurnStartParams, options: RouteOptions): Promise<RouteDecision> {
    const started = performance.now();
    const prompt = extractTurnPrompt(params);
    const key = params.threadId;
    const base: RouteDecision = { action: "inherit", ...fallbackIntent(prompt, "first_turn_only"), category: "PASS_CONTEXT", complexity: "normal", reason: "first_turn_inherit", sticky: false, promptHash: promptHash(prompt), promptChars: prompt.length, latencyMs: 0 };
    const finish = (extra: Partial<RouteDecision>) => this.audit(params, prompt, { ...base, ...extra, latencyMs: Math.round(performance.now() - started) }, options.triggeredAt, options.surface);
    const inherited = (): ThreadRoute => {
      const model = params.collaborationMode?.settings?.model ?? params.model;
      const effort = params.collaborationMode?.settings?.reasoning_effort ?? params.effort;
      return { status: "done", ...(typeof model === "string" && typeof effort === "string" ? { profile: { model, effort, fast: params.serviceTier === "priority" } } : {}) };
    };
    const reuse = (record: ThreadRoute | undefined) => {
      if (!record?.profile || record.status !== "done") return finish({ reason: "first_turn_inherit", sticky: true });
      const checked = validateProfile(record.profile, this.catalog);
      // Never choose a new model when a previously pinned model disappears.
      if (!checked.valid) return finish({ reason: "pinned_profile_unavailable", sticky: true });
      return finish({ action: "apply", profile: { ...checked.profile }, ...(record.routeName ? { routeName: record.routeName } : {}), reason: "first_turn_pinned", sticky: true });
    };
    try {
      if (!this.config.enabled || options.manualModelOverride) {
        if (key && !await this.store.read(key)) await this.store.save(key, inherited());
        return finish({ reason: !this.config.enabled ? "router_disabled" : "manual_model_override" });
      }
      const control = this.routingControl(prompt);
      if (control === "auto") {
        if (key) await this.store.reset(key);
        return finish({ intent: "control", intentSource: "manual", intentReason: "router_control", reason: "manual_auto" });
      }
      if (control === "step_up" || control === "max") {
        const stored = key ? await this.store.read(key) : undefined;
        const order = this.config.routing.routeOrder;
        const current = stored?.routeName ?? this.routeFromTurnParams(params);
        const index = current ? order.indexOf(current) : -1;
        const routeName = (control === "max" ? order.at(-1) : index >= 0 ? order[Math.min(index + 1, order.length - 1)] : this.config.routing.controls.fallbackRoute)!;
        const profile = this.config.routes[routeName];
        if (!profile) return finish({ reason: "manual_control_route_missing" });
        const checked = validateProfile(profile, this.catalog);
        if (!checked.valid) return finish({ reason: checked.reason ?? "manual_control_route_invalid" });
        if (key) await this.store.save(key, { status: "done", routeName, profile: { ...checked.profile } });
        return finish({ action: "apply", profile: { ...checked.profile }, routeName, intent: "control", intentSource: "manual", intentReason: "router_control", reason: control === "max" ? "manual_max" : "manual_step_up" });
      }
      const guard = hardGuard(prompt);
      if (guard) {
        if (key && guard.reason === "explicit_suppression" && !await this.store.read(key)) await this.store.save(key, inherited());
        return finish({ ...fallbackIntent(prompt, guard.reason), reason: guard.reason });
      }
      if (key) {
        let stored = await this.store.read(key);
        if (stored?.status === "pending") stored = await this.store.wait(key, this.config.classifier.timeoutMs + 500);
        if (stored) return reuse(stored);
        if (options.existingThread) {
          const snapshot = inherited();
          await this.store.save(key, snapshot);
          return finish({ reason: "existing_thread_inherit", sticky: true });
        }
        if (!await this.store.claim(key)) return reuse(await this.store.wait(key, this.config.classifier.timeoutMs + 500));
      }
      let result: AiClassification;
      try { result = await this.ai.classify(prompt); } catch { result = { status: "error" }; }
      const ai = result.decision;
      const metadata = { aiStatus: result.status, ...(result.latencyMs !== undefined ? { aiLatencyMs: result.latencyMs } : {}), ...(ai ? { ai } : {}) };
      const profile = ai ? this.config.routes[ai.routeName] : undefined;
      const checked = profile ? validateProfile(profile, this.catalog) : undefined;
      if (!ai || !checked?.valid) {
        if (key) await this.store.save(key, inherited());
        return finish({ ...metadata, ...fallbackIntent(prompt, `classifier_${result.status}`), reason: ai ? "invalid_route_profile" : "classifier_fail_open" });
      }
      if (key) await this.store.save(key, { status: "done", routeName: ai.routeName, profile: { ...checked.profile } });
      return finish({ ...metadata, action: "apply", routeName: ai.routeName, profile: { ...checked.profile }, intent: ai.intent, intentSource: "classifier", intentReason: "jev_first_turn", category: ai.category, complexity: ai.complexity, reason: "jev_first_turn" });
    } catch {
      return finish({ reason: "route_state_fail_open" });
    }
  }
}
