import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const fakeCodex = new URL("./fixtures/fake-codex.mjs", import.meta.url).pathname;
const rules = new URL("../resources/router-rules.json", import.meta.url).pathname;

async function testConfig(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-router-test-"));
  const path = join(directory, "router.toml");
  await writeFile(
    path,
    `version = 1
enabled = true
rules_file = "${rules}"
[ollama]
enabled = false
[codex]
cli_binary = "${fakeCodex}"
desktop_binary = "${fakeCodex}"
[logging]
audit_file = ""
`,
  );
  return path;
}

async function runNode(args: string[], config: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, CODEX_ROUTER_CONFIG: config, CODEX_ROUTER_BACKEND: fakeCodex },
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

test("Desktop stdio adapter transparently mutates a real JSONL stream", async () => {
  const config = await testConfig();
  const input = JSON.stringify({
    id: 2,
    method: "turn/start",
    params: {
      threadId: "desktop-test",
      input: [{ type: "text", text: "设计并实现 Codex Router 透明代理" }],
      model: "original",
      effort: "low",
      serviceTier: "priority",
    },
  });
  const stdout = await runNode(
    ["--import", "tsx", "src/index.ts", "-c", "features.code_mode_host=true", "app-server"],
    config,
    `${input}\n`,
  );
  const captured = JSON.parse(stdout.trim());
  assert.equal(captured.result.model, "gpt-5.6-sol");
  assert.equal(captured.result.effort, "high");
  assert.equal(captured.result.serviceTier, null);
  assert.deepEqual(captured.result.input, [{ type: "text", text: "设计并实现 Codex Router 透明代理" }]);
});

test("CLI adapter creates one local WebSocket proxy per interactive session", async () => {
  const config = await testConfig();
  const stdout = await runNode(["--import", "tsx", "src/index.ts", "cli"], config);
  const captured = JSON.parse(stdout.trim());
  assert.equal(captured.model, "gpt-5.6-luna");
  assert.equal(captured.effort, "low");
  assert.equal(captured.serviceTier, "priority");
  assert.deepEqual(captured.input, [{ type: "text", text: "请解释什么是幂等性" }]);
});

test("malformed Router config fails open to the original App Server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-router-broken-config-"));
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
  const captured = JSON.parse(stdout.trim());
  assert.equal(captured.result.model, "original-model");
  assert.equal(captured.result.effort, "medium");
  assert.deepEqual(captured.result.input, [{ type: "text", text: "实现一个复杂功能" }]);
});
