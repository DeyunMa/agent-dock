import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readLatestDecisionEvent } from "../../src/island/decision-feed.js";
import { defaultConfig, loadConfig } from "../../src/router/core/config.js";
import {
  COMPLEXITIES,
  EXECUTION_INTENTS,
  SEMANTIC_CATEGORIES,
} from "../../src/router/core/types.js";

const root = new URL("../..", import.meta.url).pathname;
const fakeCodex = new URL("../fixtures/fake-codex.mjs", import.meta.url).pathname;

const jevServer = createServer(async (request, response) => {
  if (request.url !== "/v1/systemone") {
    response.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { state?: { first_user_input?: string } };
  const implementation = body.state?.first_user_input?.includes("实现") ?? false;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({ answers: { route: {type:"choice",choice:implementation ? "deep":"quick",confidence:1,probabilities: {quick:implementation?0:1,balanced:0,deep:implementation?1:0}}, intent:{type:"choice",choice:implementation?"do":"ask",confidence:1,probabilities:{ask:implementation?0:1,do:implementation?1:0,continue:0,control:0,unknown:0}} } }),
  );
});
await new Promise<void>((resolve) =>
  jevServer.listen(0, "127.0.0.1", resolve),
);
test.after(() => jevServer.close());
const jevAddress = jevServer.address();
if (!jevAddress || typeof jevAddress === "string") {
  throw new Error("unable to start fake jev server");
}
const jevPort = jevAddress.port;

async function testConfig(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-test-"));
  const path = join(directory, "router.toml");
  await writeFile(
    path,
    `version = 3
enabled = true
[classifier]
enabled = true
base_url = "https://api.typesafe.ai"
model = "jev-latest"
timeout_ms = 1000
[routing]
state_directory = "${directory}/thread-routes"
[codex]
cli_binary = "${fakeCodex}"
desktop_binary = "${fakeCodex}"
[logging]
audit_file = "${join(directory, "events.jsonl")}"
`,
  );
  return path;
}

async function runNode(args: string[], config: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "./test/fixtures/mock-jev-fetch.mjs", ...args], {
      cwd: root,
      env: { ...process.env, AGENT_DOCK_CONFIG: config, AGENT_DOCK_BACKEND: fakeCodex, TYPESAFE_API_KEY: "test-key", AGENT_DOCK_TEST_JEV_URL: `http://127.0.0.1:${jevPort}` },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`router integration test timed out: ${stderr}`));
    }, 10_000);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`router exited ${code}: ${stderr}`));
    });
    child.stdin.end(input);
  });
}

function firstJsonLine(stdout: string): unknown {
  const [line] = stdout.trim().split("\n");
  return JSON.parse(line ?? "");
}

async function waitForDecision(configPath: string) {
  const config = await loadConfig(configPath);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const event = await readLatestDecisionEvent(config);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("decision event was not published");
}

test("Desktop stdio adapter transparently mutates a real JSONL stream", async () => {
  const config = await testConfig();
  const input = JSON.stringify({
    id: 2,
    method: "turn/start",
    params: {
      threadId: "desktop-test",
      input: [{ type: "text", text: "请实现 Agent Dock 透明代理" }],
      model: "jev-router",
      effort: "low",
      serviceTier: "priority",
    },
  });
  const stdout = await runNode(
    ["--import", "tsx", "src/index.ts", "-c", "features.code_mode_host=true", "app-server"],
    config,
    `${input}\n`,
  );
  const captured = firstJsonLine(stdout) as {
    result: { model: string; effort: string; serviceTier: string | null; input: unknown[] };
  };
  assert.equal(captured.result.model, "gpt-6-astra");
  assert.equal(captured.result.effort, "xhigh");
  assert.equal(captured.result.serviceTier, null);
  assert.deepEqual(captured.result.input, [{ type: "text", text: "请实现 Agent Dock 透明代理" }]);
  const event = await waitForDecision(config);
  assert.deepEqual(
    { surface: event.surface, intent: event.intent, route: event.route },
    { surface: "desktop", intent: "do", route: "deep" },
  );
});

test("CLI adapter creates one local WebSocket proxy per interactive session", async () => {
  const config = await testConfig();
  const stdout = await runNode(["--import", "tsx", "src/index.ts", "cli"], config);
  const captured = firstJsonLine(stdout) as {
    model: string;
    effort: string;
    serviceTier: string | null;
    input: unknown[];
  };
  assert.equal(captured.model, "gpt-5.6-terra");
  assert.equal(captured.effort, "low");
  assert.equal(captured.serviceTier, "priority");
  assert.deepEqual(captured.input, [{ type: "text", text: "请解释什么是幂等性" }]);
  const event = await waitForDecision(config);
  assert.deepEqual(
    { surface: event.surface, intent: event.intent, route: event.route },
    { surface: "terminal", intent: "ask", route: "quick" },
  );
});

test("codex exec publishes its decision before the delegated command exits", async () => {
  const config = await testConfig();
  const child = spawn(
    process.execPath,
    ["--import", "./test/fixtures/mock-jev-fetch.mjs", "--import", "tsx", "src/index.ts", "cli", "exec", "只回复结论"],
    {
      cwd: root,
      env: { ...process.env, AGENT_DOCK_CONFIG: config, TYPESAFE_API_KEY: "test-key", AGENT_DOCK_TEST_JEV_URL: `http://127.0.0.1:${jevPort}` },
      stdio: "ignore",
    },
  );
  const event = await waitForDecision(config);
  assert.equal(child.exitCode, null, "the delegated Codex command should still be running");
  assert.equal(event.surface, "terminal");
  assert.equal(event.threadId, undefined);
  assert.equal((await once(child, "exit"))[0], 0);
});

test("malformed Router config fails open to the original App Server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-dock-broken-config-"));
  const config = join(directory, "router.toml");
  await writeFile(config, "version = [this is invalid TOML");
  const input = JSON.stringify({
    id: 2,
    method: "turn/start",
    params: {
      threadId: "fail-open-test",
      input: [{ type: "text", text: "实现一个复杂功能" }],
      model: "original-model",
      effort: "medium",
      serviceTier: null,
    },
  });
  const stdout = await runNode(
    ["--import", "tsx", "src/index.ts", "app-server"],
    config,
    `${input}\n`,
  );
  const captured = firstJsonLine(stdout) as {
    result: { model: string; effort: string; input: unknown[] };
  };
  assert.equal(captured.result.model, "original-model");
  assert.equal(captured.result.effort, "medium");
  assert.deepEqual(captured.result.input, [{ type: "text", text: "实现一个复杂功能" }]);
});
