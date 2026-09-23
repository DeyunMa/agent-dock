import type { RouteOptions, RoutingEngine } from "../core/engine.js";
import { hardGuard } from "../core/hard-guards.js";
import { parseModelCatalog } from "../core/model-catalog.js";
import { extractTurnPrompt } from "../core/prompt.js";
import type { JsonRpcMessage, RouteDecision, RouteProfile, TurnStartParams } from "../core/types.js";
import { ROUTER_MODEL, RouterSelections, routerModelEntry, type RouterSelection } from "./router-selection.js";
import { CodexModelObservation, publishDesktopModels } from "./codex-model-catalog.js";

function idKey(id: unknown): string | undefined {
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

interface ThreadRequest {
  method: string;
  params: Record<string, unknown>;
  mode?: "auto" | "manual";
}

export interface ProtocolRouterOptions extends RouteOptions {
  onDecision?: (observation: RoutedTurnObservation) => void | Promise<void>;
}

export interface RoutedTurnObservation {
  decision: RouteDecision;
  triggeredAt: string;
  threadId?: string;
}

export class ProtocolRouter {
  private readonly modelListRequestIds = new Set<string>();
  private readonly modelCatalogWaiters = new Set<() => void>();
  private readonly catalogFirstPages = new Set<string>();
  private readonly threadRequests = new Map<string, ThreadRequest>();
  private readonly configReads = new Set<string>();
  private readonly configWrites = new Map<string, RouterSelection>();
  private readonly existingThreads = new Set<string>();
  private readonly selections: RouterSelections;
  private hasModelCatalog = false;
  private readonly modelObservation: CodexModelObservation;

  constructor(
    private readonly engine: RoutingEngine,
    private readonly options: ProtocolRouterOptions = {},
  ) {
    this.selections = new RouterSelections(engine.config.routing.stateDirectory);
    this.modelObservation = new CodexModelObservation(async (models) => {
      if (this.options.surface === "desktop") {
        await publishDesktopModels(this.engine.config.routing.stateDirectory, models);
      }
    });
  }

  async transformClientLine(line: string): Promise<string> {
    let message: JsonRpcMessage;
    try { message = JSON.parse(line) as JsonRpcMessage; } catch { return line; }
    const key = idKey(message.id);
    const raw = message.params as Record<string, unknown> | undefined;

    if (message.method === "model/list") {
      if (key) {
        this.modelObservation.request(key, raw);
        this.modelListRequestIds.add(key);
        if (!raw?.cursor) this.catalogFirstPages.add(key);
      }
      return line;
    }
    if (message.method === "config/read" && key) {
      this.configReads.add(key);
      return line;
    }
    if ((message.method === "config/value/write" || message.method === "config/batchWrite") && raw) {
      return this.transformConfigWrite(message, raw, key);
    }
    if (["thread/resume", "thread/fork", "thread/read", "thread/start"].includes(message.method ?? "") && raw) {
      return this.transformThreadRequest(message, raw, key, line);
    }
    if (message.method !== "turn/start" || !raw) return line;
    return this.transformTurn(message, line);
  }

  private async transformConfigWrite(message: JsonRpcMessage, raw: Record<string, unknown>, key: string | undefined): Promise<string> {
    const transformed = structuredClone(message);
    const params = transformed.params as Record<string, unknown>;
    const edits = message.method === "config/value/write"
      ? [params]
      : Array.isArray(params.edits) ? params.edits as Record<string, unknown>[] : [];
    for (const edit of edits) {
      if (edit.keyPath !== "model" || typeof edit.value !== "string") continue;
      const automatic = edit.value === ROUTER_MODEL;
      const previous = await this.selection("default");
      const seed = previous?.profile ?? this.seedProfile();
      const profile = { ...seed, model: automatic ? seed.model : edit.value };
      if (automatic) edit.value = profile.model;
      if (key) this.configWrites.set(key, { mode: automatic ? "auto" : "manual", profile, firstTurn: true });
    }
    return JSON.stringify(transformed);
  }

  private async transformThreadRequest(
    message: JsonRpcMessage,
    raw: Record<string, unknown>,
    key: string | undefined,
    original: string,
  ): Promise<string> {
    const threadId = typeof raw.threadId === "string" ? raw.threadId : undefined;
    const previous = threadId ? await this.selection(threadId) : undefined;
    const preference = message.method === "thread/start" ? await this.selection("default") : undefined;
    const explicit = typeof raw.model === "string" ? raw.model : undefined;
    const mode = explicit ? explicit === ROUTER_MODEL ? "auto" : "manual" : previous?.mode ?? preference?.mode;
    if (key) this.threadRequests.set(key, { method: message.method!, params: raw, ...(mode ? { mode } : {}) });
    if (explicit !== ROUTER_MODEL && !(message.method === "thread/start" && mode === "auto")) return original;

    const transformed = structuredClone(message);
    const params = transformed.params as Record<string, unknown>;
    if (message.method === "thread/start") params.model = (preference?.profile ?? this.seedProfile()).model;
    else delete params.model;
    return JSON.stringify(transformed);
  }

  private async transformTurn(message: JsonRpcMessage, original: string): Promise<string> {
    try {
      const triggeredAt = new Date().toISOString();
      await this.waitForPendingModelCatalog();
      const transformed = structuredClone(message);
      const params = transformed.params as TurnStartParams;
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      const selected = threadId ? await this.selection(threadId) : undefined;
      const explicit = params.collaborationMode?.settings?.model ?? params.model;
      const automatic = explicit === ROUTER_MODEL || (explicit == null && selected?.mode === "auto");

      if (!automatic || this.options.manualModelOverride) {
        if (threadId) await this.remember(threadId, {
          mode: "manual",
          profile: this.profileFromParams(params, selected?.profile ?? this.seedProfile()),
          firstTurn: false,
        });
        return original;
      }

      const baseline = selected?.profile ?? this.seedProfile();
      this.applyProfile(params, baseline);
      const decision = await this.engine.routeTurn(params, {
        manualModelOverride: false,
        existingThread: selected
          ? selected.firstTurn !== true
          : threadId !== undefined && this.existingThreads.has(threadId),
        triggeredAt,
        ...(this.options.surface ? { surface: this.options.surface } : {}),
      });
      this.publish(decision, triggeredAt, threadId);

      const profile = decision.action === "apply" && decision.profile ? decision.profile : baseline;
      const guard = hardGuard(extractTurnPrompt(params));
      if (threadId) await this.remember(threadId, {
        mode: "auto",
        profile,
          firstTurn: decision.reason === "manual_auto" || Boolean(
            selected?.firstTurn &&
            (guard?.reason === "empty_request" || guard?.reason === "internal_context"),
          ),
      });
      this.applyProfile(params, profile);
      return JSON.stringify(transformed);
    } catch {
      const params = message.params as TurnStartParams;
      const explicit = params.collaborationMode?.settings?.model ?? params.model;
      if (explicit !== ROUTER_MODEL) return original;
      const transformed = structuredClone(message);
      this.applyProfile(transformed.params as TurnStartParams, this.seedProfile());
      return JSON.stringify(transformed);
    }
  }

  private publish(decision: RouteDecision, triggeredAt: string, threadId?: string): void {
    try {
      void Promise.resolve(this.options.onDecision?.({ decision, triggeredAt, ...(threadId ? { threadId } : {}) })).catch(() => undefined);
    } catch {
      // Presentation is observational and must never affect request forwarding.
    }
  }

  async transformServerLine(line: string): Promise<string> {
    let message: JsonRpcMessage;
    try { message = JSON.parse(line) as JsonRpcMessage; } catch { return line; }
    const key = idKey(message.id);
    const request = key ? this.threadRequests.get(key) : undefined;
    const firstPage = key !== undefined && this.catalogFirstPages.delete(key);
    const configRead = key !== undefined && this.configReads.delete(key);
    const configWrite = key ? this.configWrites.get(key) : undefined;
    if (key) this.configWrites.delete(key);

    this.observeServerLine(line);
    if (key) await this.modelObservation.response(key, message.result).catch(() => undefined);
    if (configWrite && message.error === undefined) await this.remember("default", configWrite);
    if (!message.result || typeof message.result !== "object") return line;
    const result = message.result as Record<string, unknown>;
    try {
      if (firstPage && Array.isArray(result.data)) {
        result.data = [routerModelEntry(), ...result.data.filter((row) => {
          const model = row as { id?: unknown; model?: unknown };
          return model.id !== ROUTER_MODEL && model.model !== ROUTER_MODEL;
        })];
        return JSON.stringify(message);
      }
      if (configRead && result.config && typeof result.config === "object") {
        const preference = await this.selection("default");
        const config = result.config as Record<string, unknown>;
        if (preference?.mode === "auto" && config.model === preference.profile.model) {
          config.model = ROUTER_MODEL;
          return JSON.stringify(message);
        }
      }
      if (request) return this.transformThreadResponse(message, result, request, line);
    } catch {
      // Storage/display failures keep the real model response intact.
    }
    return line;
  }

  private async transformThreadResponse(message: JsonRpcMessage, result: Record<string, unknown>, request: ThreadRequest, original: string): Promise<string> {
    const thread = result.thread as { id?: string; turns?: unknown[] } | undefined;
    if (!thread?.id) return original;
    const previous = await this.selection(thread.id);
    const source = typeof request.params.threadId === "string" ? await this.selection(request.params.threadId) : undefined;
    const baseline = previous?.profile ?? source?.profile ?? this.seedProfile();
    const mode = request.mode ?? previous?.mode ?? "manual";
    const profile: RouteProfile = {
      model: typeof result.model === "string" && result.model !== ROUTER_MODEL ? result.model : baseline.model,
      effort: typeof result.reasoningEffort === "string" ? result.reasoningEffort : baseline.effort,
      fast: result.serviceTier === undefined ? baseline.fast : result.serviceTier === "priority",
    };
    const confirmedEmptyResume = request.params.excludeTurns !== true && Array.isArray(thread.turns) && thread.turns.length === 0 && !result.turnsBackwardsCursor;
    const firstTurn = previous?.firstTurn === false
      ? false
      : (request.method === "thread/start" || confirmedEmptyResume) && !this.existingThreads.has(thread.id);
    await this.remember(thread.id, { mode, profile, firstTurn });

    if (mode !== "auto" || typeof result.model !== "string") return original;
    result.model = ROUTER_MODEL;
    result.reasoningEffort = "medium";
    result.serviceTier = null;
    const collaboration = result.collaborationMode as { settings?: Record<string, unknown> } | undefined;
    if (collaboration?.settings) {
      collaboration.settings.model = ROUTER_MODEL;
      collaboration.settings.reasoning_effort = "medium";
    }
    return JSON.stringify(message);
  }

  observeServerLine(line: string): void {
    try {
      const message = JSON.parse(line) as JsonRpcMessage;
      const key = idKey(message.id);
      if (key && this.threadRequests.has(key)) {
        const request = this.threadRequests.get(key)!;
        this.threadRequests.delete(key);
        const result = message.result as { thread?: { id?: string; turns?: unknown[] } } | undefined;
        const thread = result?.thread;
        if (thread?.id && (Array.isArray(thread.turns)
          ? thread.turns.length > 0 || request.params.excludeTurns === true
          : request.method !== "thread/start")) this.existingThreads.add(thread.id);
      }
      if (!key || !this.modelListRequestIds.delete(key)) return;
      const catalog = parseModelCatalog(message.result);
      if (catalog) {
        this.engine.setModelCatalog(catalog);
        this.hasModelCatalog = true;
      }
      for (const resolve of this.modelCatalogWaiters) resolve();
      this.modelCatalogWaiters.clear();
    } catch {
      // Server traffic is observational only.
    }
  }

  private seedProfile(): RouteProfile {
    return { ...this.engine.config.routes.balanced! };
  }

  private profileFromParams(params: TurnStartParams, baseline: RouteProfile): RouteProfile {
    const model = params.collaborationMode?.settings?.model ?? params.model;
    const effort = params.collaborationMode?.settings?.reasoning_effort ?? params.effort;
    return {
      model: typeof model === "string" && model !== ROUTER_MODEL ? model : baseline.model,
      effort: typeof effort === "string" ? effort : baseline.effort,
      fast: params.serviceTier === undefined ? baseline.fast : params.serviceTier === "priority",
    };
  }

  private applyProfile(params: TurnStartParams, profile: RouteProfile): void {
    params.model = profile.model;
    params.effort = profile.effort;
    params.serviceTier = profile.fast ? "priority" : null;
    if ("serviceTierForTurn" in params) params.serviceTierForTurn = profile.fast ? "priority" : null;
    if (params.collaborationMode?.settings) {
      params.collaborationMode.settings.model = profile.model;
      params.collaborationMode.settings.reasoning_effort = profile.effort;
    }
  }

  private async selection(id: string): Promise<RouterSelection | undefined> {
    return this.selections.read(id).catch(() => undefined);
  }

  private async remember(id: string, selection: RouterSelection): Promise<void> {
    await this.selections.save(id, selection).catch(() => undefined);
  }

  private async waitForPendingModelCatalog(): Promise<void> {
    if (this.hasModelCatalog || this.modelListRequestIds.size === 0) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.modelCatalogWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, 200);
      timer.unref();
      this.modelCatalogWaiters.add(finish);
    });
  }
}
