import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { isExecutable } from "../routing/config.js";
import type { RouterConfig } from "../routing/types.js";
import { backendEnvironment } from "../transport/codex-process.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function probeOllama(config: RouterConfig): Promise<Check> {
  if (!config.ollama.enabled) return { name: "ollama", ok: true, detail: "disabled by config" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`${config.ollama.baseUrl}/api/tags`, { signal: controller.signal });
    if (!response.ok) return { name: "ollama", ok: false, detail: `HTTP ${response.status}` };
    const payload = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
    const names = (payload.models ?? []).flatMap((model) => [model.name, model.model]).filter(Boolean);
    const available = names.includes(config.ollama.model);
    return {
      name: "ollama",
      ok: available,
      detail: available
        ? `${config.ollama.model} available at ${config.ollama.baseUrl}`
        : `${config.ollama.model} not found`,
    };
  } catch (error) {
    return { name: "ollama", ok: false, detail: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

async function probeModels(binary: string): Promise<{ models: string[]; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["app-server"], {
      stdio: ["pipe", "pipe", "ignore"],
      env: backendEnvironment(),
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ models: [], error: "model/list timed out" });
    }, 5000);
    timer.unref();
    let settled = false;
    const finish = (value: { models: string[]; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin?.end();
      child.kill("SIGTERM");
      resolve(value);
    };
    child.once("error", (error) => finish({ models: [], error: error.message }));
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as {
          id?: number;
          result?: { data?: Array<{ id?: string; model?: string }> };
          error?: unknown;
        };
        if (message.id === 0) {
          child.stdin?.write('{"method":"initialized","params":{}}\n');
          child.stdin?.write('{"method":"model/list","id":1,"params":{}}\n');
        } else if (message.id === 1) {
          if (message.error) return finish({ models: [], error: JSON.stringify(message.error) });
          const models = (message.result?.data ?? [])
            .map((model) => model.id ?? model.model)
            .filter((model): model is string => typeof model === "string");
          finish({ models });
        }
      } catch {
        // Ignore non-JSON diagnostics from the backend.
      }
    });
    child.stdin?.write(
      '{"method":"initialize","id":0,"params":{"clientInfo":{"name":"codex-router-doctor","title":"Codex Router Doctor","version":"0.1.0"}}}\n',
    );
  });
}

export async function doctor(config: RouterConfig): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  checks.push({
    name: "cli_binary",
    ok: await isExecutable(config.codex.cliBinary),
    detail: config.codex.cliBinary,
  });
  checks.push({
    name: "desktop_binary",
    ok: await isExecutable(config.codex.desktopBinary),
    detail: config.codex.desktopBinary,
  });
  checks.push(await probeOllama(config));

  if (checks[0]?.ok) {
    const probe = await probeModels(config.codex.cliBinary);
    const configuredModels = [...new Set(Object.values(config.routes).map((route) => route.model))];
    const missing = configuredModels.filter((model) => !probe.models.includes(model));
    checks.push({
      name: "codex_models",
      ok: !probe.error && missing.length === 0,
      detail: probe.error ?? (missing.length > 0 ? `missing: ${missing.join(", ")}` : configuredModels.join(", ")),
    });
  }
  return { ok: checks.every((check) => check.ok), checks };
}
