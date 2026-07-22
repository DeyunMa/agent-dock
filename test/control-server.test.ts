import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { createControlServer } from "../src/control/server.js";
import { setRouteProfile, setRouterEnabled } from "../src/control/config-store.js";
import type { GatewayAdapter, GatewaySnapshot } from "../src/control/gateway.js";
import type { GatewayConfig } from "../src/routing/types.js";

const CONFIG = `version = 1
enabled = false

[routes.quick]
model = "gpt-5.6-luna"
effort = "low"
fast = true
`;

test("control API reports routes and atomically toggles the router", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-router-control-"));
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
  const directory = await mkdtemp(join(tmpdir(), "codex-router-control-"));
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
  const directory = await mkdtemp(join(tmpdir(), "codex-router-control-"));
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
      models: ["provider/model"],
      modelCatalog: [
        {
          id: "provider/model",
          displayName: "Provider Model",
          provider: "provider",
          requiresGateway: true,
          reasoningEfforts: ["high", "xhigh"],
          serviceTiers: [],
          capabilitiesKnown: true,
          defaultReasoningEffort: "high",
        },
      ],
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

test("control API delegates Gateway switching through its Adapter", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-router-control-"));
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
    gateway: {
      routed: boolean;
      models: string[];
      modelCatalog: Array<{ id: string; provider: string; reasoningEfforts: string[] }>;
    };
  };
  assert.equal(status.gateway.routed, true);
  assert.deepEqual(status.gateway.models, ["provider/model"]);
  assert.deepEqual(status.gateway.modelCatalog[0], {
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
  const directory = await mkdtemp(join(tmpdir(), "codex-router-control-"));
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
  const directory = await mkdtemp(join(tmpdir(), "codex-router-control-"));
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
  const directory = await mkdtemp(join(tmpdir(), "codex-router-control-"));
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
  const directory = await mkdtemp(join(tmpdir(), "codex-router-control-"));
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
