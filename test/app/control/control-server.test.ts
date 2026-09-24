import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { createControlServer as createServerImpl, type ControlServerOptions } from "../../../src/app/control/server.js";
import { setRouteProfile, setRouterEnabled } from "../../../src/app/control/config-store.js";
import type {
  CodexThreadCatalog,
  CodexThreadSummary,
} from "../../../src/app/control/codex-thread-catalog.js";
import type { GatewayAdapter, GatewaySnapshot } from "../../../src/gateway/gateway.js";
import type { GatewayConfig } from "../../../src/router/core/types.js";
import { defaultConfig } from "../../../src/router/core/config.js";
import { publishHookHint } from "../../../src/hooks/hint-feed.js";

const fakeModels = [{
  id: "provider/model", displayName: "Provider Model", provider: "provider",
  requiresGateway: true, reasoningEfforts: ["high", "xhigh"], serviceTiers: [],
  capabilitiesKnown: true, defaultReasoningEffort: "high",
}];
function createControlServer(options: ControlServerOptions) {
  return createServerImpl({ modelCatalog: { read: async () => ({ source: "desktop", models: fakeModels, message: "test" }) }, ...options });
}

const CONFIG = `version = 3
enabled = false

[routes.quick]
model = "gpt-5.6-luna"
effort = "low"
fast = true

[logging]
audit_file = "/dev/null"
`;

interface FeedEventInput {
  timestamp?: string;
  triggeredAt: string;
  surface: "desktop" | "terminal";
  threadId?: string;
  intent: "ask" | "do" | "continue" | "control" | "unknown";
  route: string;
}

async function writeFeedEvent(directory: string, input: FeedEventInput) {
  const id = randomUUID();
  const event = {
    schemaVersion: 2,
    id,
    timestamp: input.timestamp ?? input.triggeredAt,
    triggeredAt: input.triggeredAt,
    surface: input.surface,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    intent: input.intent,
    route: input.route,
  };
  const feed = join(directory, "decision-feed");
  await mkdir(feed, { recursive: true });
  const sortable = String(Date.parse(input.triggeredAt)).padStart(13, "0");
  await writeFile(join(feed, `${sortable}-${id}.json`), `${JSON.stringify(event)}\n`, {
    mode: 0o600,
  });
  return event;
}

class FakeThreadCatalog implements CodexThreadCatalog {
  constructor(private readonly sessions: Record<string, CodexThreadSummary>) {}

  async read(threadId: string): Promise<CodexThreadSummary | undefined> {
    return this.sessions[threadId];
  }

  async close(): Promise<void> {}
}

test("control API reports routes and atomically toggles the router", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-control-"));
  const configPath = join(directory, "router.toml");
  await writeFile(configPath, CONFIG, { mode: 0o600 });

  const server = createControlServer({
    host: "127.0.0.1",
    port: 0,
    configPath,
    version: "test",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const initial = (await (await fetch(`${baseUrl}/v1/status`)).json()) as {
    router: { enabled: boolean };
    routes: Array<{ name: string; model: string }>;
  };
  assert.equal(initial.router.enabled, false);
  assert.equal(initial.routes[0]?.name, "quick");
  assert.equal(initial.routes[0]?.model, "gpt-5.6-luna");

  const response = await fetch(`${baseUrl}/v1/router/enabled`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(response.status, 200);
  const updated = (await response.json()) as { router: { enabled: boolean } };
  assert.equal(updated.router.enabled, true);
  assert.match(await readFile(configPath, "utf8"), /^enabled = true$/m);
});

test("control API rejects non-boolean enabled values", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-control-"));
  const configPath = join(directory, "router.toml");
  await writeFile(configPath, CONFIG, { mode: 0o600 });
  const server = createControlServer({ host: "127.0.0.1", port: 0, configPath, version: "test" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/router/enabled`, {
    method: "PUT",
    body: JSON.stringify({ enabled: "yes" }),
  });
  assert.equal(response.status, 400);
  assert.match(await readFile(configPath, "utf8"), /^enabled = false$/m);
});

test("control API updates a route profile without rewriting unrelated TOML", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-control-"));
  const configPath = join(directory, "router.toml");
  const source = `${CONFIG}\n[custom]\nkeep = "exactly"\n`;
  await writeFile(configPath, source, { mode: 0o600 });
  const server = createControlServer({ host: "127.0.0.1", port: 0, configPath, version: "test" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/routes/quick`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "provider/model-2", effort: "xhigh", fast: false }),
  });
  assert.equal(response.status, 200);
  const status = (await response.json()) as {
    routes: Array<{ name: string; model: string; effort: string; fast: boolean }>;
  };
  assert.deepEqual(status.routes.find((route) => route.name === "quick"), {
    name: "quick",
    model: "provider/model-2",
    effort: "xhigh",
    fast: false,
  });
  const updated = await readFile(configPath, "utf8");
  assert.match(updated, /\[custom\]\nkeep = "exactly"/);
  assert.match(updated, /\[routes\.quick\]\nmodel = "provider\/model-2"\neffort = "xhigh"\nfast = false/);
});

class FakeGateway implements GatewayAdapter {
  routed = false;
  dashboardOpened = false;

  async snapshot(config: GatewayConfig): Promise<GatewaySnapshot> {
    return {
      kind: "opencodex",
      installed: true,
      running: true,
      routed: this.routed,
      managed: true,
      baseUrl: config.baseUrl,
      version: "test",
      message: this.routed ? "routed" : "native",
    };
  }

  async setRouted(routed: boolean): Promise<void> {
    this.routed = routed;
  }

  async openDashboard(): Promise<void> {
    this.dashboardOpened = true;
  }
}

test("model refresh reads Codex independently of Gateway and preserves route configuration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-control-"));
  const configPath = join(directory, "router.toml");
  await writeFile(configPath, CONFIG, { mode: 0o600 });
  const calls: boolean[] = [];
  const server = createControlServer({
    host: "127.0.0.1", port: 0, configPath, version: "test", gatewayAdapter: new FakeGateway(),
    modelCatalog: { async read(_config, refresh) {
      calls.push(refresh === true);
      return { source: "desktop", models: [{ ...fakeModels[0]!, id: "gpt-6-sol" }], message: "synced" };
    } },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${base}/v1/models/refresh`, { method: "POST" });
  assert.equal(response.status, 200);
  const status = await response.json() as { catalog: { models: { id: string }[] }; gateway: Record<string, unknown> };
  assert.deepEqual(status.catalog.models.map(m => m.id), ["gpt-6-sol"]);
  assert.equal(status.gateway.modelCatalog, undefined);
  assert.deepEqual(calls, [true]);
  const rejected = await fetch(`${base}/v1/models/refresh`, { method: "POST", headers: { origin: "https://untrusted.example" } });
  assert.equal(rejected.status, 403);
  const recursive = await fetch(`${base}/v1/routes/quick`, { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "jev-router", effort: "high", fast: false }) });
  assert.equal(recursive.status, 400);
  assert.equal(await readFile(configPath, "utf8"), CONFIG);
});

test("control API exposes the latest visible intent and route", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-control-"));
  const configPath = join(directory, "router.toml");
  const auditFile = join(directory, "events.jsonl");
  await writeFile(
    configPath,
    CONFIG.replace('audit_file = "/dev/null"', `audit_file = ${JSON.stringify(auditFile)}`),
    { mode: 0o600 },
  );
  await writeFile(
    auditFile,
    `${JSON.stringify({
      timestamp: "2026-07-22T07:19:00.100Z",
      triggered_at: "2026-07-22T07:19:00.000Z",
      surface: "desktop",
      schema_version: 3,
      thread_id: "thread-a",
      intent: "do",
      route: "deep",
    })}\n`,
    { mode: 0o600 },
  );
  const server = createControlServer({
    host: "127.0.0.1",
    port: 0,
    configPath,
    version: "test",
    gatewayAdapter: new FakeGateway(),
    threadCatalog: new FakeThreadCatalog({}),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object");

  const status = (await (
    await fetch(`http://127.0.0.1:${address.port}/v1/status`)
  ).json()) as {
    schemaVersion: number;
    latestDecision?: { intent: string; route: string; threadId?: string };
  };
  assert.equal(status.schemaVersion, 9);
  assert.equal(status.latestDecision?.intent, "do");
  assert.equal(status.latestDecision?.route, "deep");
  assert.equal(status.latestDecision?.threadId, "thread-a");
});

test("control decision endpoint exposes surface-tagged display events", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-control-"));
  const configPath = join(directory, "router.toml");
  const auditFile = join(directory, "events.jsonl");
  await writeFile(
    configPath,
    CONFIG.replace('audit_file = "/dev/null"', `audit_file = ${JSON.stringify(auditFile)}`),
    { mode: 0o600 },
  );
  const event = await writeFeedEvent(directory, {
    triggeredAt: "2026-07-22T07:20:00.000Z",
    surface: "desktop",
    threadId: "thread-display",
    intent: "ask",
    route: "balanced",
  });
  const server = createControlServer({
    host: "127.0.0.1",
    port: 0,
    configPath,
    version: "test",
    gatewayAdapter: new FakeGateway(),
    threadCatalog: new FakeThreadCatalog({}),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/decision`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    schemaVersion: 1,
    latestDecision: {
      id: event.id,
      timestamp: "2026-07-22T07:20:00.000Z",
      triggeredAt: "2026-07-22T07:20:00.000Z",
      surface: "desktop",
      threadId: "thread-display",
      intent: "ask",
      route: "balanced",
    },
  });

  const feed = await fetch(
    `http://127.0.0.1:${address.port}/v1/decisions?after=${event.id}&limit=20`,
  );
  assert.equal(feed.status, 200);
  assert.deepEqual(await feed.json(), { schemaVersion: 2, decisions: [] });
});

test("status exposes five hook summaries without a Codex prompt preview", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-hook-status-"));
  const configPath = join(directory, "router.toml");
  const auditFile = join(directory, "events.jsonl");
  await writeFile(
    configPath,
    CONFIG.replace('audit_file = "/dev/null"', `audit_file = ${JSON.stringify(auditFile)}`),
    { mode: 0o600 },
  );
  const config = defaultConfig();
  config.logging.auditFile = auditFile;
  await publishHookHint(config, { cwd: "/workspace/example", sessionId: "thread-hook" },
    "Agent Dock Skill 候选：\n- pdf: /private/pdf/SKILL.md\n请核对 Skill 内容");
  const server = createControlServer({
    host: "127.0.0.1", port: 0, configPath, version: "test",
    gatewayAdapter: new FakeGateway(),
    threadCatalog: new FakeThreadCatalog({
      "thread-hook": { id: "thread-hook", name: "PDF 任务", preview: "private prompt text", cwd: "/workspace/example" },
    }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/status`);
  const body = await response.text();
  assert.doesNotMatch(body, /private prompt text|\/private\/pdf\/SKILL\.md/);
  const status = JSON.parse(body) as { recentHookHints: Array<{ candidateNames: string[]; session?: { name?: string } }> };
  assert.deepEqual(status.recentHookHints[0]?.candidateNames, ["pdf"]);
  assert.equal(status.recentHookHints[0]?.session?.name, "PDF 任务");
});

test("status ignores a late stale feed event when a newer turn is audited", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-control-order-"));
  const configPath = join(directory, "router.toml");
  const auditFile = join(directory, "events.jsonl");
  await writeFile(
    configPath,
    CONFIG.replace('audit_file = "/dev/null"', `audit_file = ${JSON.stringify(auditFile)}`),
    { mode: 0o600 },
  );
  await writeFeedEvent(directory, {
    timestamp: "2026-07-22T07:21:02.000Z",
    triggeredAt: "2026-07-22T07:21:00.000Z",
    surface: "desktop",
    threadId: "older-thread",
    intent: "ask",
    route: "deep",
  });
  await writeFile(
    auditFile,
    `${JSON.stringify({
      timestamp: "2026-07-22T07:21:01.100Z",
      triggered_at: "2026-07-22T07:21:01.000Z",
      surface: "desktop",
      schema_version: 3,
      thread_id: "newer-thread",
      intent: "do",
      route: "native",
    })}\n`,
    { mode: 0o600 },
  );
  const server = createControlServer({
    host: "127.0.0.1",
    port: 0,
    configPath,
    version: "test",
    gatewayAdapter: new FakeGateway(),
    threadCatalog: new FakeThreadCatalog({}),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object");

  const status = (await (
    await fetch(`http://127.0.0.1:${address.port}/v1/status`)
  ).json()) as { latestDecision?: { threadId?: string; route: string } };
  assert.equal(status.latestDecision?.threadId, "newer-thread");
  assert.equal(status.latestDecision?.route, "native");
});

test("status enriches the exact triggering thread by id", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-control-thread-"));
  const configPath = join(directory, "router.toml");
  const auditFile = join(directory, "events.jsonl");
  await writeFile(
    configPath,
    CONFIG.replace('audit_file = "/dev/null"', `audit_file = ${JSON.stringify(auditFile)}`),
    { mode: 0o600 },
  );
  await writeFeedEvent(directory, {
    triggeredAt: "2026-07-22T07:22:00.000Z",
    surface: "desktop",
    threadId: "thread-exact",
    intent: "ask",
    route: "balanced",
  });
  const threadCatalog = new FakeThreadCatalog({
    "thread-exact": {
      id: "thread-exact",
      name: "Router 时序修复",
      cwd: "/Users/mdy/Code/agent-dock",
      updatedAt: 1_753_170_120,
    },
  });
  const server = createControlServer({
    host: "127.0.0.1",
    port: 0,
    configPath,
    version: "test",
    gatewayAdapter: new FakeGateway(),
    threadCatalog,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object");

  const status = (await (
    await fetch(`http://127.0.0.1:${address.port}/v1/status`)
  ).json()) as { latestDecision?: { session?: CodexThreadSummary } };
  assert.deepEqual(status.latestDecision?.session, {
    id: "thread-exact",
    name: "Router 时序修复",
    cwd: "/Users/mdy/Code/agent-dock",
    updatedAt: 1_753_170_120,
  });
});

test("control API stays available when the optional audit path cannot be read", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-control-"));
  const configPath = join(directory, "router.toml");
  const auditDirectory = join(directory, "events-as-directory");
  await mkdir(auditDirectory);
  await writeFile(
    configPath,
    CONFIG.replace('audit_file = "/dev/null"', `audit_file = ${JSON.stringify(auditDirectory)}`),
    { mode: 0o600 },
  );
  const server = createControlServer({
    host: "127.0.0.1",
    port: 0,
    configPath,
    version: "test",
    gatewayAdapter: new FakeGateway(),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/status`);
  assert.equal(response.status, 200);
  const status = (await response.json()) as { latestDecision?: unknown };
  assert.equal(status.latestDecision, undefined);
});

test("control API delegates Gateway switching through its Adapter", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-control-"));
  const configPath = join(directory, "router.toml");
  await writeFile(configPath, CONFIG, { mode: 0o600 });
  const gateway = new FakeGateway();
  const server = createControlServer({
    host: "127.0.0.1",
    port: 0,
    configPath,
    version: "test",
    gatewayAdapter: gateway,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/gateway/routed`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ routed: true }),
  });
  assert.equal(response.status, 200);
  const status = (await response.json()) as {
    catalog: { models: Array<{ id: string; provider: string; reasoningEfforts: string[] }> };
    gateway: {
      routed: boolean;

    };
  };
  assert.equal(status.gateway.routed, true);
  assert.deepEqual(status.catalog.models.map(m => m.id), ["provider/model"]);
  assert.deepEqual(status.catalog.models[0], {
    id: "provider/model",
    displayName: "Provider Model",
    provider: "provider",
    requiresGateway: true,
    reasoningEfforts: ["high", "xhigh"],
    serviceTiers: [],
    capabilitiesKnown: true,
    defaultReasoningEffort: "high",
  });
});

test("control API rejects unsupported model capability combinations", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-control-"));
  const configPath = join(directory, "router.toml");
  await writeFile(configPath, CONFIG, { mode: 0o600 });
  const server = createControlServer({
    host: "127.0.0.1",
    port: 0,
    configPath,
    version: "test",
    gatewayAdapter: new FakeGateway(),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/routes/quick`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "provider/model", effort: "low", fast: true }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "provider/model does not support reasoning effort low",
  });

  const fastResponse = await fetch(`http://127.0.0.1:${address.port}/v1/routes/quick`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "provider/model", effort: "high", fast: true }),
  });
  assert.equal(fastResponse.status, 400);
  assert.deepEqual(await fastResponse.json(), {
    error: "provider/model does not support Fast",
  });
  assert.match(await readFile(configPath, "utf8"), /^model = "gpt-5\.6-luna"$/m);
});

test("control API delegates provider configuration to the Gateway dashboard", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-control-"));
  const configPath = join(directory, "router.toml");
  await writeFile(configPath, CONFIG, { mode: 0o600 });
  const gateway = new FakeGateway();
  const server = createControlServer({
    host: "127.0.0.1",
    port: 0,
    configPath,
    version: "test",
    gatewayAdapter: gateway,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/gateway/dashboard`, {
    method: "POST",
  });
  assert.equal(response.status, 200);
  assert.equal(gateway.dashboardOpened, true);
  assert.equal(gateway.routed, false);
});

test("control API rejects cross-origin mutations", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-control-"));
  const configPath = join(directory, "router.toml");
  await writeFile(configPath, CONFIG, { mode: 0o600 });
  const gateway = new FakeGateway();
  const server = createControlServer({
    host: "127.0.0.1",
    port: 0,
    configPath,
    version: "test",
    gatewayAdapter: gateway,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/gateway/dashboard`, {
    method: "POST",
    headers: { origin: "https://example.com" },
  });
  assert.equal(response.status, 403);
  assert.equal(gateway.dashboardOpened, false);
});

test("concurrent control writes preserve both the switch and route edit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-control-"));
  const configPath = join(directory, "router.toml");
  await writeFile(configPath, CONFIG, { mode: 0o600 });

  await Promise.all([
    setRouterEnabled(true, configPath),
    setRouteProfile(
      "quick",
      { model: "provider/concurrent", effort: "medium", fast: false },
      configPath,
    ),
  ]);

  const source = await readFile(configPath, "utf8");
  assert.match(source, /^enabled = true$/m);
  assert.match(source, /^model = "provider\/concurrent"$/m);
  assert.match(source, /^effort = "medium"$/m);
});
