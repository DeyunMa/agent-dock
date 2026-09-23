import type { GatewayConfig } from "../router/core/types.js";

export interface GatewayModel {
  id: string;
  displayName: string;
  provider: string;
  requiresGateway: boolean;
  reasoningEfforts: string[];
  serviceTiers: string[];
  capabilitiesKnown: boolean;
  defaultReasoningEffort?: string;
}

export interface GatewaySnapshot {
  kind: GatewayConfig["kind"];
  installed: boolean;
  running: boolean;
  routed: boolean;
  managed: boolean;
  baseUrl: string;
  version?: string;
  message: string;
}

export interface GatewayAdapter {
  snapshot(config: GatewayConfig): Promise<GatewaySnapshot>;
  setRouted(routed: boolean, config: GatewayConfig): Promise<void>;
  openDashboard(config: GatewayConfig): Promise<void>;
}
