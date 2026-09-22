import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import {
  COMPLEXITIES,
  SEMANTIC_CATEGORIES,
  type Complexity,
  type GatewayKind,
  type RouteProfile,
  type RouterConfig,
  type RoutingControlConfig,
  type SemanticCategory,
} from "./types.js";

export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL("../../resources/router-v2.toml", import.meta.url));
export const CURRENT_CONFIG_VERSION = 2;

export function configuredConfigPath(): string {
  return process.env.AGENT_DOCK_TRAINING_CONFIG ?? DEFAULT_CONFIG_PATH;
}

const DEFAULT_ROUTES: Record<string, RouteProfile> = {
  quick: { model: "gpt-5.6-luna", effort: "low", fast: true },
  balanced: { model: "gpt-5.6-terra", effort: "max", fast: false },
  deep: { model: "gpt-5.6-sol", effort: "high", fast: false },
  max: { model: "gpt-5.6-sol", effort: "xhigh", fast: false },
};

const DEFAULT_CATEGORY_ROUTES: Record<SemanticCategory, string> = {
  RESEARCH_EXPLAIN: "quick",
  AUDIT_ANALYZE: "balanced",
  DIAGNOSE_FIX: "deep",
  PLAN_DESIGN: "deep",
  IMPLEMENT_CHANGE: "balanced",
  OPERATE_VERIFY: "balanced",
  CREATE_ARTIFACT: "deep",
  AGENT_WORKFLOW: "deep",
  PASS_CONTEXT: "inherit",
};

const DEFAULT_COMPLEXITY_ROUTES: Record<Complexity, string> = {
  simple: "quick",
  normal: "inherit",
  complex: "deep",
  extreme: "max",
};

const DEFAULT_ROUTING_CONTROLS: RoutingControlConfig = {
  stepUp: ["加强一点", "再加强一点", "提高一档"],
  max: ["最高强度", "拉满"],
  auto: ["恢复自动", "自动路由"],
  fallbackRoute: "deep",
};

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

export function defaultConfig(): RouterConfig {
  return {
    version: CURRENT_CONFIG_VERSION,
    enabled: true,
    classifier: {
      enabled: true,
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3-embedding:0.6b",
      modelDigest: "ac6da0dfba84a81fdbfbaf330198c33cd77c4cdfc53e8bc50eb581914a15621d",
      modelDirectory: expandHome("~/.agent-dock/classifier-v1"),
      timeoutMs: 1600,
      keepAlive: "30m",
    },
    routing: {
      stickyTurns: true,
      respectCliModelFlag: true,
      controls: structuredClone(DEFAULT_ROUTING_CONTROLS),
      categoryRoutes: { ...DEFAULT_CATEGORY_ROUTES },
      complexityRoutes: { ...DEFAULT_COMPLEXITY_ROUTES },
      routeOrder: ["quick", "balanced", "deep", "max"],
    },
    routes: structuredClone(DEFAULT_ROUTES),
    gateway: {
      kind: "native-codex",
      baseUrl: "http://127.0.0.1:10100",
      managed: false,
    },
    codex: {
      cliBinary: "/opt/homebrew/bin/codex",
      desktopBinary: "/Applications/ChatGPT.app/Contents/Resources/codex",
    },
    logging: {
      auditFile: expandHome("~/.agent-dock/events.jsonl"),
      maxFileBytes: 30 * 1024 * 1024,
      maxBackups: 1,
    },
  };
}

type Table = Record<string, unknown>;

function table(value: unknown): Table {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Table)
    : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function parseRoutes(raw: Table, fallback: Record<string, RouteProfile>): Record<string, RouteProfile> {
  const routes: Record<string, RouteProfile> = structuredClone(fallback);
  for (const [name, value] of Object.entries(raw)) {
    const route = table(value);
    const previous = routes[name] ?? fallback.balanced;
    if (!previous) continue;
    routes[name] = {
      model: stringValue(route.model, previous.model),
      effort: stringValue(route.effort, previous.effort),
      fast: booleanValue(route.fast, previous.fast),
    };
  }
  return routes;
}

function gatewayKind(value: unknown, fallback: GatewayKind): GatewayKind {
  return value === "native-codex" || value === "opencodex" ? value : fallback;
}

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export function routeProfileValidationError(profile: RouteProfile): string | undefined {
  if (
    !profile.model.trim() ||
    profile.model.length > 200 ||
    /[\u0000-\u001f]/u.test(profile.model)
  ) {
    return "model must be a non-empty model id of at most 200 characters";
  }
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(profile.effort)) {
    return "effort must be a simple value of at most 32 characters";
  }
  return undefined;
}

function validateConfig(config: RouterConfig): RouterConfig {
  if (config.version !== 1 && config.version !== CURRENT_CONFIG_VERSION) {
    throw new Error(`unsupported config version: ${config.version}`);
  }
  if (!isLoopbackHttpUrl(config.classifier.baseUrl)) {
    throw new Error("classifier.base_url must be a loopback HTTP URL");
  }
  if (!config.classifier.model.trim()) {
    throw new Error("classifier.model must be non-empty");
  }
  if (!/^[a-f0-9]{64}$/u.test(config.classifier.modelDigest)) {
    throw new Error("classifier.model_digest must be a SHA-256 digest");
  }
  if (!config.classifier.modelDirectory.trim()) {
    throw new Error("classifier.model_directory must be non-empty");
  }
  if (config.classifier.timeoutMs < 100 || config.classifier.timeoutMs > 30_000) {
    throw new Error("classifier.timeout_ms must be between 100 and 30000");
  }
  if (config.logging.maxFileBytes < 1024 || config.logging.maxFileBytes > 1024 * 1024 * 1024) {
    throw new Error("logging.max_file_bytes must be between 1024 and 1073741824");
  }
  if (!Number.isInteger(config.logging.maxBackups) || config.logging.maxBackups < 0 || config.logging.maxBackups > 10) {
    throw new Error("logging.max_backups must be an integer between 0 and 10");
  }
  if (config.routing.routeOrder.length === 0) {
    throw new Error("routing.route_order must contain at least one route");
  }
  if (new Set(config.routing.routeOrder).size !== config.routing.routeOrder.length) {
    throw new Error("routing.route_order must not contain duplicate routes");
  }
  for (const [name, profile] of Object.entries(config.routes)) {
    if (!name.trim() || name.length > 64) {
      throw new Error("route names must contain 1 to 64 characters");
    }
    const profileError = routeProfileValidationError(profile);
    if (profileError) throw new Error(`route ${name}: ${profileError}`);
  }
  for (const name of config.routing.routeOrder) {
    if (!config.routes[name]) throw new Error(`routing.route_order references missing route: ${name}`);
  }
  if (!config.routes[config.routing.controls.fallbackRoute]) {
    throw new Error(
      `routing.controls.fallback_route references missing route: ${config.routing.controls.fallbackRoute}`,
    );
  }
  for (const [category, route] of Object.entries(config.routing.categoryRoutes)) {
    if (route !== "inherit" && !config.routes[route]) {
      throw new Error(`category ${category} references missing route: ${route}`);
    }
  }
  for (const [complexity, route] of Object.entries(config.routing.complexityRoutes)) {
    if (route !== "inherit" && !config.routes[route]) {
      throw new Error(`complexity ${complexity} references missing route: ${route}`);
    }
  }
  if (config.gateway.kind === "opencodex") {
    let url: URL;
    try {
      url = new URL(config.gateway.baseUrl);
    } catch {
      throw new Error("gateway.base_url must be a valid URL");
    }
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
    ) {
      throw new Error("managed opencodex gateway must use a loopback HTTP URL");
    }
  }
  return config;
}

export function parseConfig(source: string): RouterConfig {
  const defaults = defaultConfig();
  const raw = table(parse(source));
  const classifier = table(raw.classifier);
  const legacyOllama = table(raw.ollama);
  const routing = table(raw.routing);
  const controls = table(routing.controls);
  const rawCategoryRoutes = table(routing.category_routes);
  const rawComplexityRoutes = table(routing.complexity_routes);
  const codex = table(raw.codex);
  const gateway = table(raw.gateway);
  const logging = table(raw.logging);
  const routes = parseRoutes(table(raw.routes), defaults.routes);

  const categoryRoutes = { ...defaults.routing.categoryRoutes };
  for (const category of SEMANTIC_CATEGORIES) {
    categoryRoutes[category] = stringValue(rawCategoryRoutes[category], categoryRoutes[category]);
  }

  const complexityRoutes = { ...defaults.routing.complexityRoutes };
  for (const complexity of COMPLEXITIES) {
    complexityRoutes[complexity] = stringValue(
      rawComplexityRoutes[complexity],
      complexityRoutes[complexity],
    );
  }

  const routeOrder = Array.isArray(routing.route_order)
    ? routing.route_order.filter((value): value is string => typeof value === "string")
    : defaults.routing.routeOrder;

  return validateConfig({
    version: numberValue(raw.version, defaults.version),
    enabled: booleanValue(raw.enabled, defaults.enabled),
    classifier: {
      enabled: booleanValue(
        classifier.enabled,
        booleanValue(legacyOllama.enabled, defaults.classifier.enabled),
      ),
      baseUrl: stringValue(
        classifier.base_url,
        stringValue(legacyOllama.base_url, defaults.classifier.baseUrl),
      ).replace(/\/$/, ""),
      model: stringValue(classifier.model, defaults.classifier.model),
      modelDigest: stringValue(
        classifier.model_digest,
        defaults.classifier.modelDigest,
      ),
      modelDirectory: expandHome(
        stringValue(classifier.model_directory, defaults.classifier.modelDirectory),
      ),
      timeoutMs: numberValue(classifier.timeout_ms, defaults.classifier.timeoutMs),
      keepAlive: stringValue(
        classifier.keep_alive,
        stringValue(legacyOllama.keep_alive, defaults.classifier.keepAlive),
      ),
    },
    routing: {
      stickyTurns: booleanValue(routing.sticky_turns, defaults.routing.stickyTurns),
      respectCliModelFlag: booleanValue(
        routing.respect_cli_model_flag,
        defaults.routing.respectCliModelFlag,
      ),
      controls: {
        stepUp: stringArray(controls.step_up, defaults.routing.controls.stepUp),
        max: stringArray(controls.max, defaults.routing.controls.max),
        auto: stringArray(controls.auto, defaults.routing.controls.auto),
        fallbackRoute: stringValue(
          controls.fallback_route,
          defaults.routing.controls.fallbackRoute,
        ),
      },
      categoryRoutes,
      complexityRoutes,
      routeOrder,
    },
    routes,
    gateway: {
      kind: gatewayKind(gateway.kind, defaults.gateway.kind),
      baseUrl: stringValue(gateway.base_url, defaults.gateway.baseUrl).replace(/\/$/, ""),
      managed: booleanValue(gateway.managed, defaults.gateway.managed),
    },
    codex: {
      cliBinary: expandHome(stringValue(codex.cli_binary, defaults.codex.cliBinary)),
      desktopBinary: expandHome(stringValue(codex.desktop_binary, defaults.codex.desktopBinary)),
    },
    logging: {
      auditFile: expandHome(stringValue(logging.audit_file, defaults.logging.auditFile)),
      maxFileBytes: numberValue(logging.max_file_bytes, defaults.logging.maxFileBytes),
      maxBackups: numberValue(logging.max_backups, defaults.logging.maxBackups),
    },
  });
}

export async function loadConfig(path = configuredConfigPath()): Promise<RouterConfig> {
  const expanded = expandHome(path);
  try {
    return parseConfig(await readFile(expanded, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
    throw error;
  }
}

export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
