import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  readDecisionEvents,
  readLatestDecisionEvent,
  type DecisionEvent,
  type DecisionFeedReadOptions,
} from "../../island/decision-feed.js";
import {
  readLatestAuditDecision,
  type LatestAuditDecision,
} from "../../router/core/audit.js";
import {
  CURRENT_CONFIG_VERSION,
  configuredConfigPath,
  expandHome,
  loadConfig,
  routeProfileValidationError,
} from "../../router/core/config.js";
import type { RouteProfile, RouterConfig } from "../../router/core/types.js";
import type {
  CodexThreadCatalog,
  CodexThreadSummary,
} from "./codex-thread-catalog.js";
import type { GatewayAdapter, GatewaySnapshot } from "../../gateway/gateway.js";

export const CONTROL_SCHEMA_VERSION = 6;

export class ControlInputError extends Error {}

export function validateRouteCapabilities(
  profile: RouteProfile,
  gateway: GatewaySnapshot,
): void {
  const model = gateway.modelCatalog.find((candidate) => candidate.id === profile.model);
  if (!model?.capabilitiesKnown) return;
  if (
    model.reasoningEfforts.length > 0 &&
    !model.reasoningEfforts.includes(profile.effort)
  ) {
    throw new ControlInputError(
      `${profile.model} does not support reasoning effort ${profile.effort}`,
    );
  }
  if (profile.fast && !model.serviceTiers.includes("priority")) {
    throw new ControlInputError(`${profile.model} does not support Fast`);
  }
}

export interface ControlStatus {
  schemaVersion: number;
  control: {
    status: "running";
    version: string;
    endpoint: string;
  };
  router: {
    enabled: boolean;
    failOpen: boolean;
    configPath: string;
    classifier: {
      enabled: boolean;
      model: string;
    };
  };
  routes: Array<{
    name: string;
    model: string;
    effort: string;
    fast: boolean;
  }>;
  activation: {
    requiresCodexRestart: boolean;
    message: string;
  };
  latestDecision?: LatestDecision;
  gateway: GatewaySnapshot;
}

export interface LatestDecision {
  id?: string;
  timestamp: string;
  triggeredAt: string;
  surface?: DecisionEvent["surface"];
  threadId?: string;
  intent: LatestAuditDecision["intent"];
  route: string;
  session?: CodexThreadSummary;
}

function statusFromConfig(
  config: RouterConfig,
  configPath: string,
  endpoint: string,
  version: string,
  gateway: GatewaySnapshot,
  latestDecision: LatestDecision | undefined,
): ControlStatus {
  return {
    schemaVersion: CONTROL_SCHEMA_VERSION,
    control: {
      status: "running",
      version,
      endpoint,
    },
    router: {
      enabled: config.enabled,
      // Kept in schema v2 for older menu-bar clients. Fail-open is an
      // invariant now, not a user-configurable switch.
      failOpen: true,
      configPath,
      classifier: {
        enabled: config.classifier.enabled,
        model: config.classifier.model,
      },
    },
    routes: config.routing.routeOrder.flatMap((name) => {
      const profile = config.routes[name];
      return profile ? [{ name, ...profile }] : [];
    }),
    activation: {
      requiresCodexRestart: false,
      message: config.enabled
        ? "自动路由已启用；档位修改会从下一次请求开始生效。"
        : "自动路由已暂停；下一次请求开始原样直通 Codex。",
    },
    ...(latestDecision ? { latestDecision } : {}),
    gateway,
  };
}

export async function readControlStatus(options: {
  configPath?: string;
  endpoint: string;
  version: string;
  gateway: GatewayAdapter;
  threadCatalog?: CodexThreadCatalog;
}): Promise<ControlStatus> {
  const configPath = expandHome(options.configPath ?? configuredConfigPath());
  const config = await loadConfig(configPath);
  const [gateway, latestDecision] = await Promise.all([
    options.gateway.snapshot(config.gateway),
    readLatestDecision(config, options.threadCatalog),
  ]);
  return statusFromConfig(
    config,
    configPath,
    options.endpoint,
    options.version,
    gateway,
    latestDecision,
  );
}

function eventDecision(event: DecisionEvent): LatestDecision {
  return {
    id: event.id,
    timestamp: event.timestamp,
    triggeredAt: event.triggeredAt,
    surface: event.surface,
    ...(event.threadId ? { threadId: event.threadId } : {}),
    intent: event.intent,
    route: event.route,
  };
}

function auditDecision(event: LatestAuditDecision): LatestDecision {
  return {
    timestamp: event.timestamp,
    triggeredAt: event.triggeredAt,
    ...(event.surface ? { surface: event.surface } : {}),
    ...(event.threadId ? { threadId: event.threadId } : {}),
    intent: event.intent,
    route: event.route,
  };
}

function newerDecision(
  audit: LatestAuditDecision | undefined,
  event: DecisionEvent | undefined,
): LatestDecision | undefined {
  const visibleAudit =
    audit?.surface === "desktop" || audit?.surface === "terminal" ? audit : undefined;
  if (!visibleAudit) return event ? eventDecision(event) : undefined;
  if (!event) return auditDecision(visibleAudit);
  const auditTime = Date.parse(visibleAudit.triggeredAt);
  const eventTime = Date.parse(event.triggeredAt);
  // The feed event wins ties because it carries the exact display surface and
  // event cursor. A late completion from an older trigger can never win.
  return eventTime >= auditTime ? eventDecision(event) : auditDecision(visibleAudit);
}

async function enrichDecision(
  config: RouterConfig,
  decision: LatestDecision | undefined,
  threadCatalog: CodexThreadCatalog | undefined,
): Promise<LatestDecision | undefined> {
  if (!decision?.threadId || !threadCatalog) return decision;
  const executable =
    decision.surface === "terminal"
      ? config.codex.cliBinary
      : config.codex.desktopBinary;
  const session = await threadCatalog.read(decision.threadId, executable);
  return session ? { ...decision, session } : decision;
}

async function readLatestDecision(
  config: RouterConfig,
  threadCatalog?: CodexThreadCatalog,
): Promise<LatestDecision | undefined> {
  const [event, audit] = await Promise.all([
    readLatestDecisionEvent(config),
    readLatestAuditDecision(config.logging.auditFile),
  ]);
  return enrichDecision(config, newerDecision(audit, event), threadCatalog);
}

export async function readControlDecision(
  configPath = configuredConfigPath(),
): Promise<LatestDecision | undefined> {
  const config = await loadConfig(expandHome(configPath));
  const event = await readLatestDecisionEvent(config);
  return event ? eventDecision(event) : undefined;
}

export async function readControlDecisions(
  configPath = configuredConfigPath(),
  options: DecisionFeedReadOptions = {},
): Promise<LatestDecision[]> {
  const config = await loadConfig(expandHome(configPath));
  return (await readDecisionEvents(config, options)).map(eventDecision);
}

async function readSource(configPath: string): Promise<string> {
  try {
    return await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return `version = ${CURRENT_CONFIG_VERSION}\n`;
  }
}

const configWriteQueues = new Map<string, Promise<void>>();

async function atomicConfigUpdateOnce(
  path: string,
  transform: (source: string) => string,
): Promise<void> {
  const configPath = expandHome(path);
  const source = await readSource(configPath);
  const updated = transform(source);
  const tempPath = join(
    dirname(configPath),
    `.${basename(configPath)}.tmp-${process.pid}-${Date.now()}`,
  );
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  try {
    await writeFile(tempPath, updated, { encoding: "utf8", mode: 0o600 });
    await loadConfig(tempPath);
    await rename(tempPath, configPath);
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

async function atomicConfigUpdate(
  path: string,
  transform: (source: string) => string,
): Promise<void> {
  const configPath = expandHome(path);
  const previous = configWriteQueues.get(configPath) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => atomicConfigUpdateOnce(configPath, transform));
  configWriteQueues.set(configPath, current);
  try {
    await current;
  } finally {
    if (configWriteQueues.get(configPath) === current) configWriteQueues.delete(configPath);
  }
}

function setTopLevelBoolean(source: string, key: string, value: boolean): string {
  const lines = source.split("\n");
  const tableIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const limit = tableIndex < 0 ? lines.length : tableIndex;
  const pattern = new RegExp(`^(\\s*${key}\\s*=\\s*)(?:true|false)(\\s*(?:#.*)?)$`);
  for (let index = 0; index < limit; index += 1) {
    const line = lines[index];
    if (line !== undefined && pattern.test(line)) {
      lines[index] = line.replace(pattern, `$1${value ? "true" : "false"}$2`);
      return lines.join("\n");
    }
  }
  const insertAt = lines.findIndex((line) => /^\s*version\s*=/.test(line));
  lines.splice(insertAt < 0 ? 0 : insertAt + 1, 0, `${key} = ${value ? "true" : "false"}`);
  return lines.join("\n");
}

export async function setRouterEnabled(
  enabled: boolean,
  path = configuredConfigPath(),
): Promise<void> {
  await atomicConfigUpdate(path, (source) => setTopLevelBoolean(source, "enabled", enabled));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function setRouteSection(source: string, name: string, profile: RouteProfile): string {
  const lines = source.split("\n");
  const header = new RegExp(`^\\s*\\[routes\\.${escapeRegex(name)}\\]\\s*(?:#.*)?$`);
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) throw new ControlInputError(`unknown route: ${name}`);
  const nextHeader = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  const end = nextHeader < 0 ? lines.length : nextHeader;

  const values: Record<keyof RouteProfile, string> = {
    model: JSON.stringify(profile.model.trim()),
    effort: JSON.stringify(profile.effort),
    fast: profile.fast ? "true" : "false",
  };
  let insertion = end;
  for (const key of ["model", "effort", "fast"] as const) {
    const pattern = new RegExp(`^\\s*${key}\\s*=`);
    const index = lines.findIndex((line, candidate) =>
      candidate > start && candidate < insertion && pattern.test(line),
    );
    if (index >= 0) {
      lines[index] = `${key} = ${values[key]}`;
    } else {
      lines.splice(insertion, 0, `${key} = ${values[key]}`);
      insertion += 1;
    }
  }
  return lines.join("\n");
}

export async function setRouteProfile(
  name: string,
  profile: RouteProfile,
  path = configuredConfigPath(),
): Promise<void> {
  const validationError = routeProfileValidationError(profile);
  if (validationError) throw new ControlInputError(validationError);
  const configPath = expandHome(path);
  const config = await loadConfig(configPath);
  if (!config.routes[name] || !config.routing.routeOrder.includes(name)) {
    throw new ControlInputError(`unknown route: ${name}`);
  }
  await atomicConfigUpdate(configPath, (source) => setRouteSection(source, name, profile));
}
