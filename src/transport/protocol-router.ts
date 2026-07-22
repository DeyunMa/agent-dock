import type { RouteOptions, RoutingEngine } from "../routing/engine.js";
import { parseModelCatalog } from "../routing/model-catalog.js";
import type { JsonRpcMessage, RouteDecision, TurnStartParams } from "../routing/types.js";

function idKey(id: unknown): string | undefined {
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

export interface ProtocolRouterOptions extends RouteOptions {
  onDecision?: (decision: RouteDecision) => void;
}

export class ProtocolRouter {
  private readonly modelListRequestIds = new Set<string>();

  constructor(
    private readonly engine: RoutingEngine,
    private readonly options: ProtocolRouterOptions = {},
  ) {}

  async transformClientLine(line: string): Promise<string> {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return line;
    }

    if (message.method === "model/list") {
      const key = idKey(message.id);
      if (key) this.modelListRequestIds.add(key);
      return line;
    }
    if (message.method !== "turn/start" || !message.params || typeof message.params !== "object") {
      return line;
    }

    try {
      const transformed = structuredClone(message);
      const params = transformed.params as TurnStartParams;
      const decision = await this.engine.routeTurn(params, {
        manualModelOverride: this.options.manualModelOverride ?? false,
      });
      this.options.onDecision?.(decision);
      if (decision.action !== "apply" || !decision.profile) return line;

      params.model = decision.profile.model;
      params.effort = decision.profile.effort;
      params.serviceTier = decision.profile.fast ? "priority" : null;

      // Collaboration mode takes precedence over top-level model/effort in the
      // App Server contract, so keep its mode/instructions and route only its
      // model settings.
      if (
        params.collaborationMode &&
        typeof params.collaborationMode === "object" &&
        params.collaborationMode.settings &&
        typeof params.collaborationMode.settings === "object"
      ) {
        params.collaborationMode.settings.model = decision.profile.model;
        params.collaborationMode.settings.reasoning_effort = decision.profile.effort;
      }
      return JSON.stringify(transformed);
    } catch {
      return line;
    }
  }

  observeServerLine(line: string): void {
    try {
      const message = JSON.parse(line) as JsonRpcMessage;
      const key = idKey(message.id);
      if (!key || !this.modelListRequestIds.delete(key)) return;
      const catalog = parseModelCatalog(message.result);
      if (catalog) this.engine.setModelCatalog(catalog);
    } catch {
      // Server traffic is observational only and must remain byte-for-byte forwarded.
    }
  }
}
