import type { ExecutionIntent } from "../../router/core/types.js";

export const ISLAND_EVENT_SOURCES = ["router", "codex-hook"] as const;
export type IslandEventSource = (typeof ISLAND_EVENT_SOURCES)[number];

export const ISLAND_EVENT_KINDS = [
  "route_selected",
  "session_started",
  "work_started",
  "work_progressed",
  "approval_needed",
  "turn_stopped",
  "session_ended",
] as const;
export type IslandEventKind = (typeof ISLAND_EVENT_KINDS)[number];

export const ISLAND_STATES = [
  "idle",
  "routing",
  "working",
  "awaiting_approval",
  "settling",
] as const;
export type IslandState = (typeof ISLAND_STATES)[number];

export const ISLAND_SURFACES = ["desktop", "terminal", "management"] as const;
export type IslandSurface = (typeof ISLAND_SURFACES)[number];

export const ISLAND_TOOL_CLASSES = ["shell", "write", "mcp"] as const;
export type IslandToolClass = (typeof ISLAND_TOOL_CLASSES)[number];

/**
 * A content-free observation consumed by Island Core. It intentionally has no
 * prompt, response, command, path, cwd, transcript, or tool payload fields.
 */
export interface IslandEvent {
  schemaVersion: 1;
  id: string;
  occurredAt: string;
  source: IslandEventSource;
  kind: IslandEventKind;
  sessionIdHash?: string;
  turnIdHash?: string;
  toolClass?: IslandToolClass;
  surface?: IslandSurface;
  intent?: ExecutionIntent;
  route?: string;
}

/**
 * The stable, display-safe output from Island Core. Output Adapters may render
 * this snapshot but must not use it to influence Router or Codex behavior.
 */
export interface IslandSnapshot {
  schemaVersion: 1;
  revision: number;
  state: IslandState;
  changedAt: string;
  expiresAt?: string;
  source?: IslandEventSource;
  surface?: IslandSurface;
  intent?: ExecutionIntent;
  route?: string;
}
