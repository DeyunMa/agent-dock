import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setRouteProfile, setRouterEnabled } from "../src/control/config-store.js";
import { ReloadingRouterEngine } from "../src/routing/reloading-engine.js";

const rulesPath = new URL("../resources/router-rules.json", import.meta.url).pathname;

test("a running Router hot-loads switch and route edits on the next turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-router-reload-"));
  const configPath = join(directory, "router.toml");
  await writeFile(
    configPath,
    `version = 1
enabled = true
rules_file = "${rulesPath}"

[ollama]
enabled = false

[routes.quick]
model = "gpt-5.6-luna"
effort = "low"
fast = true
`,
    { mode: 0o600 },
  );

  const engine = await ReloadingRouterEngine.create(configPath);
  const params = {
    threadId: "reload-test",
    input: [{ type: "text", text: "只回答这个问题即可" }],
  };
  const initial = await engine.routeTurn(params);
  assert.equal(initial.action, "apply");
  assert.equal(initial.profile?.model, "gpt-5.6-luna");

  await setRouteProfile(
    "quick",
    { model: "provider/faster", effort: "medium", fast: false },
    configPath,
  );
  const changed = await engine.routeTurn({ ...params, threadId: "reload-route" });
  assert.equal(changed.action, "apply");
  assert.deepEqual(changed.profile, {
    model: "provider/faster",
    effort: "medium",
    fast: false,
  });

  await setRouterEnabled(false, configPath);
  const disabled = await engine.routeTurn({ ...params, threadId: "reload-disabled" });
  assert.equal(disabled.action, "inherit");
  assert.equal(disabled.reason, "router_disabled");
});
