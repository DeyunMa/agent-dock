import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "../../../src/router/core/config.js";
import { LocalCodexModelCatalog } from "../../../src/app/control/codex-model-catalog.js";
import { CodexModelObservation, parseCodexModels, publishDesktopModels, readDesktopModels } from "../../../src/router/adapters/codex-model-catalog.js";
import { ProtocolRouter } from "../../../src/router/adapters/protocol-router.js";
import { RouterEngine } from "../../../src/router/core/engine.js";

const row = (id: string) => ({ id, model: id, displayName: id,
  supportedReasoningEfforts: [{ reasoningEffort: "high" }], serviceTiers: [{ id: "priority" }] });

test("Codex parser excludes hidden and virtual entries and retains new model capabilities", () => {
  const result = parseCodexModels({ data: [row("gpt-6-sol"), row("jev-router"), { ...row("private"), hidden: true }, null] });
  assert.deepEqual(result?.map(m => m.id), ["gpt-6-sol"]);
  assert.deepEqual(result?.[0]?.reasoningEfforts, ["high"]);
  assert.deepEqual(result?.[0]?.serviceTiers, ["priority"]);
});

test("only complete current pagination replaces the catalog; failure and hidden queries do not", async () => {
  const snapshots: string[][] = [];
  const observer = new CodexModelObservation(async models => { snapshots.push(models.map(m => m.id)); });
  observer.request("old", {});
  observer.request("1", {});
  await observer.response("old", { data: [row("stale")] });
  await observer.response("1", { data: [row("native")], nextCursor: "page2" });
  assert.deepEqual(snapshots, []);
  observer.request("2", { cursor: "page2" });
  await observer.response("2", { data: [row("provider/model")], nextCursor: null });
  assert.deepEqual(snapshots, [["native", "provider/model"]]);
  observer.request("3", {});
  await observer.response("3", undefined);
  observer.request("4", { includeHidden: true });
  await observer.response("4", { data: [row("hidden")] });
  assert.equal(snapshots.length, 1);
  observer.request("5", {});
  await observer.response("5", { data: [row("native")] });
  assert.deepEqual(snapshots[1], ["native"]);
});

test("desktop RPC publication wins over probe, removes third-party choices on next list, and excludes CLI", async t => {
  const directory = await mkdtemp(join(tmpdir(), "dock-models-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = defaultConfig();
  config.routing.stateDirectory = directory;
  config.codex.desktopBinary = "/does-not-exist";
  const protocol = new ProtocolRouter(new RouterEngine(config), { surface: "desktop" });
  await protocol.transformClientLine(JSON.stringify({ method: "model/list", id: 1 }));
  const forwarded = JSON.parse(await protocol.transformServerLine(JSON.stringify({ id: 1, result: { data: [row("gpt-6-sol"), row("provider/model")] } })));
  assert.equal(forwarded.result.data[0].id, "jev-router");
  const reader = new LocalCodexModelCatalog();
  assert.deepEqual((await reader.read(config)).models.map(m => m.id), ["gpt-6-sol", "provider/model"]);
  const originalRoutes = structuredClone(config.routes);
  await protocol.transformClientLine(JSON.stringify({ method: "model/list", id: 2 }));
  await protocol.transformServerLine(JSON.stringify({ id: 2, result: { data: [row("gpt-6-sol")] } }));
  const cli = new ProtocolRouter(new RouterEngine(config), { surface: "terminal" });
  await cli.transformClientLine(JSON.stringify({ method: "model/list", id: 3 }));
  await cli.transformServerLine(JSON.stringify({ id: 3, result: { data: [row("cli-only")] } }));
  const snapshot = await reader.read(config, true);
  assert.equal(snapshot.source, "desktop");
  assert.deepEqual(snapshot.models.map(m => m.id), ["gpt-6-sol"]);
  assert.deepEqual(config.routes, originalRoutes);
});

test("metadata probe paginates, refreshes after configuration changes, and never starts a turn", async t => {
  const directory = await mkdtemp(join(tmpdir(), "dock-model-probe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mode = join(directory, "model.txt");
  const binary = join(directory, "codex");
  await writeFile(mode, "provider/first");
  await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialized') return;
  if (!['initialize', 'model/list'].includes(m.method)) process.exit(20);
  const result = m.method === 'initialize' ? {} : m.params.cursor
    ? { data: [{id:fs.readFileSync(${JSON.stringify(mode)},'utf8')}], nextCursor:null }
    : { data: [{id:'native'}], nextCursor:'page2' };
  console.log(JSON.stringify({id:m.id,result}));
});
`, { mode: 0o700 });
  const config = defaultConfig();
  config.routing.stateDirectory = directory;
  config.codex.desktopBinary = binary;
  const reader = new LocalCodexModelCatalog();
  const first = await reader.read(config);
  assert.equal(first.source, "codex");
  assert.deepEqual(first.models.map(m => m.id), ["native", "provider/first"]);
  await writeFile(mode, "gpt-6-luna");
  assert.deepEqual((await reader.read(config)).models, first.models);
  assert.deepEqual((await reader.read(config, true)).models.map(m => m.id), ["native", "gpt-6-luna"]);
  await publishDesktopModels(directory, []);
  assert.deepEqual((await reader.read(config, true)).models, []);
  assert.equal((await readDesktopModels(directory))?.source, "desktop");
});

test("probe failure is explicit and does not invent configured or gateway models", async t => {
  const directory = await mkdtemp(join(tmpdir(), "dock-no-models-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = defaultConfig();
  config.routing.stateDirectory = directory;
  config.codex.desktopBinary = "/does-not-exist";
  const snapshot = await new LocalCodexModelCatalog().read(config);
  assert.equal(snapshot.source, "unavailable");
  assert.deepEqual(snapshot.models, []);
});
