import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { visibleDecision } from "../router/core/presentation.js";
import {
  EXECUTION_INTENTS,
  type ExecutionIntent,
  type RouteDecision,
  type RouterConfig,
} from "../router/core/types.js";

export const DECISION_SURFACES = ["desktop", "terminal", "management"] as const;
export type DecisionSurface = (typeof DECISION_SURFACES)[number];

const FEED_DIRECTORY_NAME = "decision-feed";
const MAX_FEED_EVENTS = 200;

export interface DecisionEvent {
  schemaVersion: 2;
  id: string;
  /** Time at which the routed decision became available. */
  timestamp: string;
  /** Time at which Router first received this turn/start. */
  triggeredAt: string;
  surface: DecisionSurface;
  threadId?: string;
  intent: ExecutionIntent;
  route: string;
}

export interface DecisionEventContext {
  triggeredAt?: string;
  threadId?: string;
}

export interface DecisionFeedReadOptions {
  afterId?: string;
  limit?: number;
}

export function decisionFeedPath(config: RouterConfig): string | undefined {
  if (!config.logging.auditFile) return undefined;
  return join(dirname(config.logging.auditFile), FEED_DIRECTORY_NAME);
}

function eventFileName(event: DecisionEvent): string {
  const timestamp = Date.parse(event.triggeredAt);
  const sortableTime = Number.isFinite(timestamp) ? timestamp : Date.now();
  return `${String(sortableTime).padStart(13, "0")}-${event.id}.json`;
}

function validEvent(value: unknown): value is DecisionEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<DecisionEvent>;
  return (
    event.schemaVersion === 2 &&
    typeof event.id === "string" &&
    typeof event.timestamp === "string" &&
    Number.isFinite(Date.parse(event.timestamp)) &&
    typeof event.triggeredAt === "string" &&
    Number.isFinite(Date.parse(event.triggeredAt)) &&
    typeof event.surface === "string" &&
    DECISION_SURFACES.includes(event.surface as DecisionSurface) &&
    (event.threadId === undefined || typeof event.threadId === "string") &&
    typeof event.intent === "string" &&
    EXECUTION_INTENTS.includes(event.intent as ExecutionIntent) &&
    typeof event.route === "string" &&
    event.route.length > 0
  );
}

async function eventFiles(path: string): Promise<string[]> {
  try {
    return (await readdir(path))
      .filter((name) => /^\d{13}-[0-9a-f-]+\.json$/i.test(name))
      .sort();
  } catch {
    return [];
  }
}

async function trimFeed(path: string): Promise<void> {
  const files = await eventFiles(path);
  const stale = files.slice(0, Math.max(0, files.length - MAX_FEED_EVENTS));
  await Promise.all(stale.map((name) => unlink(join(path, name)).catch(() => undefined)));
}

export async function publishDecisionEvent(
  config: RouterConfig,
  surface: DecisionSurface,
  decision: RouteDecision,
  context: DecisionEventContext = {},
): Promise<DecisionEvent | undefined> {
  const path = decisionFeedPath(config);
  if (!path) return undefined;
  const visible = visibleDecision(decision);
  const timestamp = new Date().toISOString();
  const event: DecisionEvent = {
    schemaVersion: 2,
    id: randomUUID(),
    timestamp,
    triggeredAt: context.triggeredAt ?? timestamp,
    surface,
    ...(context.threadId ? { threadId: context.threadId } : {}),
    intent: visible.intent,
    route: visible.route,
  };
  const targetPath = join(path, eventFileName(event));
  const temporaryPath = `${targetPath}.tmp-${process.pid}`;
  await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, targetPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  await trimFeed(path).catch(() => undefined);
  return event;
}

async function loadEvents(path: string): Promise<DecisionEvent[]> {
  const files = await eventFiles(path);
  const loaded = await Promise.all(
    files.map(async (name) => {
      try {
        const value = JSON.parse(await readFile(join(path, name), "utf8")) as unknown;
        return validEvent(value) ? value : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return loaded.filter((event): event is DecisionEvent => event !== undefined);
}

export async function readDecisionEvents(
  config: RouterConfig,
  options: DecisionFeedReadOptions = {},
): Promise<DecisionEvent[]> {
  const path = decisionFeedPath(config);
  if (!path) return [];
  const events = await loadEvents(path);
  if (events.length === 0) return [];
  const limit = Math.max(1, Math.min(options.limit ?? 20, 50));
  if (!options.afterId) return events.slice(-1);
  const cursor = events.findIndex((event) => event.id === options.afterId);
  // A cursor can disappear after bounded cleanup. Resynchronize to the newest
  // event instead of replaying the whole retained feed.
  if (cursor < 0) return events.slice(-1);
  return events.slice(cursor + 1, cursor + 1 + limit);
}

export async function readLatestDecisionEvent(
  config: RouterConfig,
): Promise<DecisionEvent | undefined> {
  return (await readDecisionEvents(config, { limit: 1 })).at(-1);
}
