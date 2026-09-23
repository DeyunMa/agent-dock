import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "../../scripts/runtime/setup.mjs";
import { deactivate } from "../../scripts/runtime/deactivate.mjs";

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "agent-dock-install-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtime = join(home, "Applications/Agent Dock.app/Contents/Resources/runtime");
  await mkdir(runtime, { recursive: true });
  const app = join(home, "Applications/Codex.app");
  await mkdir(join(app, "Contents/Resources"), { recursive: true });
  await writeFile(join(app, "Contents/Resources/codex"), "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(join(runtime, "package.json"), '{"name":"agent-dock-runtime"}');
  await writeFile(join(runtime, "router.toml.example"), await readFile(new URL("../../resources/router/router.toml.example", import.meta.url)));
  const calls = [];
  return { home, runtime, candidates: [app], calls, run: (...args) => { calls.push(args); return ""; } };
}

test("clean-machine setup links bundled runtime and preserves configuration on relaunch", async (t) => {
  const options = await fixture(t);
  await setup(options);
  assert.equal(await readlink(join(options.home, ".local/bin/agent-dock")), join(options.runtime, "agent-dock"));
  const config = join(options.home, ".agent-dock/router.toml");
  assert.match(await readFile(config, "utf8"), /Codex\.app/);
  await writeFile(config, "existing user configuration");
  await setup(options);
  assert.equal(await readFile(config, "utf8"), "existing user configuration");
  assert.equal(options.calls.filter((call) => call[1][0] === "setenv").length, 2);
});

test("setup refuses unrelated commands before changing activation", async (t) => {
  const options = await fixture(t);
  await mkdir(join(options.home, ".local/bin"), { recursive: true });
  const existing = join(options.home, ".local/bin/codex");
  await writeFile(existing, "unrelated CLI");
  await assert.rejects(setup(options), /不属于 Agent Dock/);
  assert.equal(await readFile(existing, "utf8"), "unrelated CLI");
  assert.equal(options.calls.length, 0);
});

test("deactivation previews then removes only managed entries while preserving data", async (t) => {
  const options = await fixture(t);
  await setup(options);
  const shell = join(options.home, ".zshrc");
  await writeFile(shell, "export KEEP=yes\n# >>> agent-dock >>>\nexport CODEX_CLI_PATH=old\n# <<< agent-dock <<<\nexport ALSO_KEEP=yes\n");
  const config = join(options.home, ".agent-dock/router.toml");
  const original = await readFile(config, "utf8");
  const plan = await deactivate(options);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.links.length, 2);
  assert.match(await readFile(shell, "utf8"), /agent-dock/);
  const commands = [];
  const run = (binary, args) => {
    commands.push([binary, args]);
    if (binary === "/usr/bin/pgrep") throw Object.assign(new Error("not running"), { status: 1 });
    return args[0] === "getenv" ? join(options.home, ".local/bin/agent-dock") : "";
  };
  await deactivate({ ...options, run, confirm: true });
  await assert.rejects(readlink(join(options.home, ".local/bin/agent-dock")), { code: "ENOENT" });
  assert.equal(await readFile(shell, "utf8"), "export KEEP=yes\nexport ALSO_KEEP=yes\n");
  assert.equal(await readFile(config, "utf8"), original);
  assert(commands.some(([binary, args]) => binary === "/bin/launchctl" && args[0] === "unsetenv"));
});
