import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GatewayConfig } from "../router/core/types.js";
import type { GatewayAdapter, GatewaySnapshot } from "./gateway.js";

const execFileAsync = promisify(execFile);

interface OpenCodexHealth {
  status?: unknown;
  service?: unknown;
  version?: unknown;
}

function codexConfigPath(): string {
  return join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml");
}

function normalizedUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function isOpenCodexRouteUrl(value: string, baseUrl: string): boolean {
  try {
    const candidate = new URL(value);
    const expected = new URL(baseUrl);
    if (candidate.origin !== expected.origin || candidate.search || candidate.hash) return false;
    const root = expected.pathname.replace(/\/+$/, "");
    const path = candidate.pathname.replace(/\/+$/, "");
    return path === `${root}/v1` || path === `${root}/backend-api/codex`;
  } catch {
    return false;
  }
}

async function isCodexRouted(baseUrl: string): Promise<boolean> {
  try {
    const source = await readFile(codexConfigPath(), "utf8");
    const match = /^\s*openai_base_url\s*=\s*["']([^"']+)["']/m.exec(source);
    if (!match?.[1]) return false;
    return isOpenCodexRouteUrl(match[1], baseUrl);
  } catch {
    return false;
  }
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export class LocalOpenCodexGatewayAdapter implements GatewayAdapter {
  private cliPath?: Promise<string | undefined>;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async resolveCli(): Promise<string | undefined> {
    if (!this.cliPath) {
      this.cliPath = (async () => {
        const candidates = [
          process.env.OPENCODEX_CLI_PATH,
          join(homedir(), ".local", "share", "mise", "shims", "ocx"),
          join(homedir(), ".asdf", "shims", "ocx"),
          join(homedir(), ".local", "bin", "ocx"),
          "/opt/homebrew/bin/ocx",
          "/usr/local/bin/ocx",
        ].filter((value): value is string => Boolean(value?.trim()));
        for (const candidate of candidates) {
          if (await executable(candidate)) return candidate;
        }
        return undefined;
      })();
    }
    return this.cliPath;
  }

  private async health(baseUrl: string): Promise<OpenCodexHealth | undefined> {
    try {
      const response = await this.fetchImpl(`${normalizedUrl(baseUrl)}/healthz`, {
        signal: AbortSignal.timeout(750),
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as OpenCodexHealth;
      if (body.service !== "opencodex" || body.status !== "ok") return undefined;
      return body;
    } catch {
      return undefined;
    }
  }

  async snapshot(config: GatewayConfig): Promise<GatewaySnapshot> {
    if (config.kind !== "opencodex") {
      return {
        kind: "native-codex",
        installed: true,
        running: true,
        routed: false,
        managed: false,
        baseUrl: config.baseUrl,
        message: "Codex 正在使用原生连接。",
      };
    }

    const [cli, health, routed] = await Promise.all([
      this.resolveCli(),
      this.health(config.baseUrl),
      isCodexRouted(config.baseUrl),
    ]);
    const installed = Boolean(cli);
    const running = Boolean(health);

    let message: string;
    if (!installed) {
      message = "OpenCodex CLI 未安装。";
    } else if (routed && !running) {
      message = "Gateway 已被选中但当前离线；请先恢复原生连接。";
    } else if (routed) {
      message = "新启动的 Codex 会话将经过 OpenCodex。";
    } else if (running) {
      message = "OpenCodex 待命中，Codex 当前仍走原生连接。";
    } else {
      message = "OpenCodex 已安装但未启动，Codex 当前走原生连接。";
    }

    return {
      kind: "opencodex",
      installed,
      running,
      routed,
      managed: config.managed,
      baseUrl: config.baseUrl,
      ...(typeof health?.version === "string" ? { version: health.version } : {}),
      message,
    };
  }

  private async runCli(args: string[]): Promise<void> {
    const cli = await this.resolveCli();
    if (!cli) throw new Error("OpenCodex CLI 未安装");
    try {
      await execFileAsync(cli, args, {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        env: process.env,
      });
    } catch (error) {
      const details = error as Error & { stderr?: string; stdout?: string };
      throw new Error(
        details.stderr?.trim() || details.stdout?.trim() || details.message,
      );
    }
  }

  private async waitUntilHealthy(baseUrl: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await this.health(baseUrl)) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("OpenCodex 启动后未通过健康检查");
  }

  private async restoreNativeAfterDashboardStartup(baseUrl: string): Promise<void> {
    await this.runCli(["restore"]);
    let stableSince = Date.now();
    const deadline = stableSince + 5_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (await isCodexRouted(baseUrl)) {
        // A newly spawned proxy can finish its own startup sync just after
        // `ocx gui` returns. Restore again and require a stable native window.
        await this.runCli(["restore"]);
        stableSince = Date.now();
        continue;
      }
      if (Date.now() - stableSince >= 1_000) return;
    }
    throw new Error("Dashboard 已打开，但未能稳定恢复原生 Codex 配置");
  }

  async openDashboard(config: GatewayConfig): Promise<void> {
    if (config.kind !== "opencodex") {
      throw new Error("当前 Gateway 不是 OpenCodex");
    }
    const [wasRunning, wasRouted] = await Promise.all([
      this.health(config.baseUrl).then(Boolean),
      isCodexRouted(config.baseUrl),
    ]);

    // Provider/account/key configuration remains owned by OpenCodex. The
    // Router control plane only invokes its dashboard Interface.
    await this.runCli(["gui"]);
    if (!wasRunning) await this.waitUntilHealthy(config.baseUrl);

    // `ocx gui` starts the proxy when needed, and that upstream startup also
    // injects the Codex base URL. Opening configuration must preserve the
    // caller's previous data-path choice.
    if (!wasRouted && !wasRunning) {
      await this.restoreNativeAfterDashboardStartup(config.baseUrl);
    } else if (!wasRouted && await isCodexRouted(config.baseUrl)) {
      await this.runCli(["restore"]);
    }
  }

  async setRouted(routed: boolean, config: GatewayConfig): Promise<void> {
    if (config.kind !== "opencodex" || !config.managed) {
      throw new Error("当前 Gateway 不允许由菜单栏应用管理");
    }
    if (!routed) {
      await this.runCli(["restore"]);
      if (await isCodexRouted(config.baseUrl)) {
        throw new Error("OpenCodex 未能恢复原生 Codex 配置");
      }
      return;
    }

    if (!(await this.health(config.baseUrl))) {
      // `ensure` starts a detached local proxy and performs OpenCodex's own
      // transactional config injection. It never replaces our CODEX_CLI_PATH.
      await this.runCli(["ensure"]);
      await this.waitUntilHealthy(config.baseUrl);
    }
    await this.runCli(["restore", "back"]);
    if (!(await isCodexRouted(config.baseUrl))) {
      throw new Error("OpenCodex 已启动，但 Codex 配置未切换到 Gateway");
    }
  }
}
