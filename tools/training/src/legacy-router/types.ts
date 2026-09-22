export const SEMANTIC_CATEGORIES = [
  "RESEARCH_EXPLAIN",
  "AUDIT_ANALYZE",
  "DIAGNOSE_FIX",
  "PLAN_DESIGN",
  "IMPLEMENT_CHANGE",
  "OPERATE_VERIFY",
  "CREATE_ARTIFACT",
  "AGENT_WORKFLOW",
  "PASS_CONTEXT",
] as const;

export type SemanticCategory = (typeof SEMANTIC_CATEGORIES)[number];

export const COMPLEXITIES = ["simple", "normal", "complex", "extreme"] as const;
export type Complexity = (typeof COMPLEXITIES)[number];

export const EXECUTION_INTENTS = ["ask", "do", "continue", "control", "unknown"] as const;
export type ExecutionIntent = (typeof EXECUTION_INTENTS)[number];
export type IntentSource = "classifier" | "manual" | "fallback" | "rule" | "ai";

export type RouteName = string;

export interface RouteProfile {
  model: string;
  effort: string;
  fast: boolean;
}

export interface EmbeddingClassifierConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  modelDigest: string;
  modelDirectory: string;
  timeoutMs: number;
  keepAlive: string;
}

export interface RoutingControlConfig {
  stepUp: string[];
  max: string[];
  auto: string[];
  fallbackRoute: RouteName;
}

export interface RoutingConfig {
  stickyTurns: boolean;
  respectCliModelFlag: boolean;
  controls: RoutingControlConfig;
  categoryRoutes: Record<SemanticCategory, RouteName>;
  complexityRoutes: Record<Complexity, RouteName | "inherit">;
  routeOrder: RouteName[];
}

export interface CodexConfig {
  cliBinary: string;
  desktopBinary: string;
}

export interface LoggingConfig {
  auditFile: string;
  maxFileBytes: number;
  maxBackups: number;
}

export type GatewayKind = "native-codex" | "opencodex";

export interface GatewayConfig {
  kind: GatewayKind;
  baseUrl: string;
  managed: boolean;
}

export interface RouterConfig {
  version: number;
  enabled: boolean;
  classifier: EmbeddingClassifierConfig;
  routing: RoutingConfig;
  routes: Record<RouteName, RouteProfile>;
  gateway: GatewayConfig;
  codex: CodexConfig;
  logging: LoggingConfig;
}

export interface AiDecision {
  category: SemanticCategory;
  complexity: Complexity;
  intent: ExecutionIntent;
  confidence: number;
  reason: string;
  latencyMs: number;
}

export type AiStatus =
  | "ok"
  | "disabled"
  | "warming"
  | "timeout"
  | "http_error"
  | "invalid_response"
  | "error";

export interface AiClassification {
  decision?: AiDecision;
  status: AiStatus;
  latencyMs?: number;
}

export interface ModelDescriptor {
  id: string;
  supportedReasoningEfforts: string[];
  serviceTiers: string[];
}

export interface ModelCatalog {
  models: Map<string, ModelDescriptor>;
}

export interface RouteDecision {
  action: "apply" | "inherit";
  intent: ExecutionIntent;
  intentSource: IntentSource;
  intentReason: string;
  category: SemanticCategory;
  complexity: Complexity;
  routeName?: RouteName;
  profile?: RouteProfile;
  reason: string;
  ai?: AiDecision;
  aiStatus?: AiStatus;
  aiLatencyMs?: number;
  sticky: boolean;
  promptHash: string;
  promptChars: number;
  latencyMs: number;
}

export interface TurnStartParams {
  threadId?: string;
  input?: unknown[];
  model?: string | null;
  effort?: string | null;
  serviceTier?: string | null;
  collaborationMode?: {
    mode?: string;
    settings?: {
      model?: string;
      reasoning_effort?: string | null;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  } | null;
  cwd?: string | null;
  [key: string]: unknown;
}

export interface JsonRpcMessage {
  id?: string | number | null;
  method?: string;
  params?: TurnStartParams | Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  [key: string]: unknown;
}
