import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setRouteProfile, setRouterEnabled } from "../../src/app/control/config-store.js";
import type { AiClassifier } from "../../src/router/core/engine.js";
import { ReloadingRouterEngine } from "../../src/router/core/reloading-engine.js";
import type { AiClassification } from "../../src/router/core/types.js";

class FakeClassifier implements AiClassifier {
  async warmup(): Promise<void> {}

  async classify(prompt: string): Promise<AiClassification> {
    if (prompt === "继续") {
      return {
        status: "ok",
        decision: {
          category: "PASS_CONTEXT",
          complexity: "simple",
          intent: "continue",
          confidence: 0.9,
          reason: "test",
          latencyMs: 1,
        },
      };
    }
    const diagnostic = prompt.includes("500");
    return {
      status: "ok",
      decision: {
        category: diagnostic ? "DIAGNOSE_FIX" : "RESEARCH_EXPLAIN",
        complexity: diagnostic ? "complex" : "simple",
        intent: diagnostic ? "do" : "ask",
        confidence: 0.9,
        reason: "test",
        latencyMs: 1,
      },
    };
  }
}

const classifierFactory = () => new FakeClassifier();

test("a running Router hot-loads switch and route edits on the next turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-reload-"));
  const configPath = join(directory, "router.toml");
  await writeFile(
    configPath,
    `version = 2
enabled = true

[logging]
audit_file = "/dev/null"

[routes.quick]
model = "gpt-5.6-luna"
effort = "low"
fast = true

[routes.deep]
model = "gpt-5.6-sol"
effort = "high"
fast = false
`,
    { mode: 0o600 },
  );

  const engine = await ReloadingRouterEngine.create(configPath, classifierFactory);
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

test("hot reload preserves sticky session state and resolves the updated profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-reload-state-"));
  const configPath = join(directory, "router.toml");
  await writeFile(
    configPath,
    `version = 2
enabled = true

[logging]
audit_file = "/dev/null"

[routes.deep]
model = "gpt-5.6-sol"
effort = "high"
fast = false
`,
    { mode: 0o600 },
  );

  const engine = await ReloadingRouterEngine.create(configPath, classifierFactory);
  const first = await engine.routeTurn({
    threadId: "sticky-reload",
    input: [{ type: "text", text: "页面持续报 500，定位根因并修复后跑回归测试" }],
  });
  assert.equal(first.routeName, "deep");

  await setRouteProfile(
    "deep",
    { model: "provider/deep-v2", effort: "xhigh", fast: false },
    configPath,
  );
  const continued = await engine.routeTurn({
    threadId: "sticky-reload",
    input: [{ type: "text", text: "继续" }],
  });
  assert.equal(continued.reason, "sticky_context");
  assert.equal(continued.routeName, "deep");
  assert.deepEqual(continued.profile, {
    model: "provider/deep-v2",
    effort: "xhigh",
    fast: false,
  });
});
