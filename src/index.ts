import { doctor } from "./app/cli/doctor.js";
import { runCli } from "./app/cli/run-cli.js";
import { runControlServerCommand } from "./app/cli/run-control-server.js";
import { publishDecisionEvent } from "./island/decision-feed.js";
import { defaultConfig } from "./router/core/config.js";
import { migrateConfigFile } from "./router/core/config-migration.js";
import type { RoutingEngine } from "./router/core/engine.js";
import { formatDecisionMarker, visibleDecision } from "./router/core/presentation.js";
import { ReloadingRouterEngine } from "./router/core/reloading-engine.js";
import { spawnInherited } from "./router/adapters/codex-process.js";
import { runStdioProxy } from "./router/adapters/stdio-proxy.js";
import { VERSION } from "./version.js";

function help(): string {
  return `Agent Dock ${VERSION}

Usage:
  agent-dock doctor [--json]       Check Codex, Jev API and configured routes
  agent-dock classify [--json] TEXT
  agent-dock migrate-config        Upgrade the local config to the current schema
  agent-dock control-server        Run the loopback control API for the menu bar app
  agent-dock cli [CODEX_ARGS...]   Run the transparent CLI adapter
  agent-dock app-server ...        Run the Desktop stdio adapter

Normal use does not require these commands: open Codex Desktop normally or type codex.`;
}

async function createEngine(): Promise<RoutingEngine> {
  return ReloadingRouterEngine.create();
}

async function runManagement(args: string[], engine: RoutingEngine): Promise<number | undefined> {
  const command = args[0];
  if (command === "--version" || command === "-V" || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === "--help" || command === "-h" || command === "help" || !command) {
    process.stdout.write(`${help()}\n`);
    return 0;
  }
  if (command === "doctor" || command === "status") {
    const result = await doctor(engine.config);
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      for (const check of result.checks) {
        process.stdout.write(`${check.ok ? "OK" : "FAIL"}  ${check.name}: ${check.detail}\n`);
      }
    }
    return result.ok ? 0 : 1;
  }
  if (command === "classify") {
    const prompt = args.filter((argument, index) => index > 0 && argument !== "--json").join(" ");
    if (!prompt) {
      process.stderr.write("agent-dock classify requires prompt text\n");
      return 2;
    }
    const decision = await engine.routeTurn({
      input: [{ type: "text", text: prompt }],
      cwd: process.cwd(),
    });
    process.stdout.write(
      args.includes("--json")
        ? `${JSON.stringify(visibleDecision(decision), null, 2)}\n`
        : `${formatDecisionMarker(decision)}\n`,
    );
    return 0;
  }
  return undefined;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const cliEntrypoint = process.env.AGENT_DOCK_ENTRYPOINT === "codex";
  const appServerInvocation = !cliEntrypoint && args.includes("app-server");
  if (!cliEntrypoint && args[0] === "migrate-config") {
    const changed = await migrateConfigFile();
    process.stdout.write(
      changed
        ? "[agent-dock] config migrated to schema v3\n"
        : "[agent-dock] no config migration was needed\n",
    );
    return 0;
  }
  if (!cliEntrypoint && args[0] === "control-server") {
    return runControlServerCommand(args.slice(1), VERSION);
  }
  let engine: RoutingEngine;
  try {
    engine = await createEngine();
  } catch (error) {
    process.stderr.write(`[agent-dock] configuration unavailable; failing open: ${(error as Error).message}\n`);
    const fallback = defaultConfig();
    if (appServerInvocation) {
      return spawnInherited(
        process.env.AGENT_DOCK_BACKEND ?? fallback.codex.desktopBinary,
        args,
      );
    }
    if (cliEntrypoint || args[0] === "cli") {
      return spawnInherited(fallback.codex.cliBinary, cliEntrypoint ? args : args.slice(1));
    }
    return 1;
  }

  if (cliEntrypoint) return runCli(args, engine);
  if (args[0] === "cli") return runCli(args.slice(1), engine);
  if (appServerInvocation) {
    return runStdioProxy(
      process.env.AGENT_DOCK_BACKEND ?? engine.config.codex.desktopBinary,
      args,
      engine,
      {
        surface: "desktop",
        onDecision: async ({ decision, threadId, triggeredAt }) => {
          await publishDecisionEvent(engine.config, "desktop", decision, {
            triggeredAt,
            ...(threadId ? { threadId } : {}),
          });
        },
      },
    );
  }
  return (await runManagement(args, engine)) ?? 2;
}

process.exitCode = await main();
