import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { isExecutable } from "../../router/core/config.js";
import type { RouterConfig } from "../../router/core/types.js";
import { backendEnvironment } from "../../router/adapters/codex-process.js";
import { VERSION } from "../../version.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function probeClassifier(config: RouterConfig): Promise<Check> {
  if (!config.classifier.enabled) {
    return { name: "classifier", ok: true, detail: "disabled by config" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`${config.classifier.baseUrl}/api/tags`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return { name: "classifier", ok: false, detail: `Ollama HTTP ${response.status}` };
    }
    const payload = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
    const installed = (payload.models ?? []).find(
      (model) =>
        model.name === config.classifier.model ||
        model.model === config.classifier.model,
    ) as { name?: string; model?: string; digest?: string } | undefined;
    const artifacts = ["intent.json", "category.json", "complexity.json"];
    await Promise.all(
      artifacts.map((name) => access(join(config.classifier.modelDirectory, name))),
    );
    const available =
      installed !== undefined &&
      installed.digest === config.classifier.modelDigest;
    return {
      name: "classifier",
      ok: available,
      detail: available
        ? `${config.classifier.model} and three linear heads are ready`
        : `${config.classifier.model} is missing or its digest does not match`,
    };
  } catch (error) {
    return { name: "classifier", ok: false, detail: (error as Error).message };
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
      `${JSON.stringify({
        method: "initialize",
        id: 0,
        params: {
          clientInfo: {
            name: "agent-dock-doctor",
            title: "Agent Dock Doctor",
            version: VERSION,
          },
        },
      })}\n`,
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
  checks.push(await probeClassifier(config));

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
