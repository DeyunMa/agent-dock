import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { migrateConfigSource } from "../src/routing/config-migration.js";
import { parseConfig } from "../src/routing/config.js";
import {
  extractExecPrompt,
  hasExplicitRoutingArgument,
  injectExecRoute,
  topLevelCommand,
} from "../src/transport/codex-arguments.js";

test("example config exposes category, model, effort and fast knobs", async () => {
  const source = await readFile(new URL("../resources/router.toml.example", import.meta.url), "utf8");
  const config = parseConfig(source);
  assert.equal(config.routing.categoryRoutes.AGENT_WORKFLOW, "deep");
  assert.deepEqual(config.routes.quick, {
    model: "gpt-5.6-luna",
    effort: "low",
    fast: true,
  });
  assert.deepEqual(config.routes.balanced, {
    model: "gpt-5.6-terra",
    effort: "max",
    fast: false,
  });
  assert.deepEqual(config.routing.controls, {
    stepUp: ["加强一点", "再加强一点", "提高一档"],
    max: ["最高强度", "拉满"],
    auto: ["恢复自动", "自动路由"],
    fallbackRoute: "deep",
  });
  assert.equal(config.version, 2);
  assert.equal(config.classifier.model, "qwen3-embedding:0.6b");
  assert.equal(config.classifier.timeoutMs, 1600);
});

test("v1 Ollama config migrates to v2 embedding classifier without changing routes", () => {
  const migrated = migrateConfigSource(`version = 1
enabled = false
rules_file = "~/.codex/router/router-rules.json"
fail_open = true

[ollama]
enabled = true
base_url = "http://127.0.0.1:11434"
model = "qwen3.5:2b-q4_K_M"
timeout_ms = 3000
keep_alive = "15m"

[routes.quick]
model = "custom/model"
effort = "low"
fast = false
`);
  const config = parseConfig(migrated);
  assert.equal(config.version, 2);
  assert.equal(config.enabled, false);
  assert.equal(config.classifier.model, "qwen3-embedding:0.6b");
  assert.equal(config.classifier.keepAlive, "15m");
  assert.equal(config.routes.quick?.model, "custom/model");
  assert.doesNotMatch(migrated, /\[ollama\]|rules_file|qwen3\.5:2b/);
});

test("config rejects ambiguous route order and invalid route profiles", () => {
  assert.throws(
    () => parseConfig('version = 1\n[routing]\nroute_order = ["quick", "quick"]\n'),
    /must not contain duplicate routes/,
  );
  assert.throws(
    () => parseConfig('version = 1\n[routes.quick]\neffort = "high\\\" -c unsafe=true"\n'),
    /effort must be a simple value/,
  );
});

test("CLI invocation detection preserves explicit user routing", () => {
  assert.equal(topLevelCommand(["-C", "/tmp/repo", "resume", "--last"]), "resume");
  assert.equal(topLevelCommand(["explain this code"]), undefined);
  assert.equal(hasExplicitRoutingArgument(["-m", "gpt-5.6-sol"]), true);
  assert.equal(hasExplicitRoutingArgument(["-c", 'model_reasoning_effort="xhigh"']), true);
  assert.equal(hasExplicitRoutingArgument(["--search"]), false);
});

test("exec prompt receives launch-time route flags", () => {
  const args = ["exec", "--json", "fix the bug"];
  assert.equal(extractExecPrompt(args), "fix the bug");
  assert.deepEqual(
    injectExecRoute(args, { model: "gpt-5.6-luna", effort: "low", fast: true }),
    [
      "exec",
      "-m",
      "gpt-5.6-luna",
      "-c",
      'model_reasoning_effort="low"',
      "-c",
      'service_tier="priority"',
      "--json",
      "fix the bug",
    ],
  );
});
