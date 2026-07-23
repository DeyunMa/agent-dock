import { doctor } from "./cli/doctor.js";
import { runCli } from "./cli/run-cli.js";
import { runControlServerCommand } from "./cli/run-control-server.js";
import { publishDecisionEvent } from "./presentation/decision-events.js";
import { defaultConfig } from "./routing/config.js";
import { migrateConfigFile } from "./routing/config-migration.js";
import type { RoutingEngine } from "./routing/engine.js";
import { formatDecisionMarker, visibleDecision } from "./routing/presentation.js";
import { ReloadingRouterEngine } from "./routing/reloading-engine.js";
import { spawnInherited } from "./transport/codex-process.js";
import { runStdioProxy } from "./transport/stdio-proxy.js";
import { VERSION } from "./version.js";

function help(): string {
  return `Codex Router ${VERSION}

Usage:
  codex-router doctor [--json]       Check Codex, Ollama and configured routes
  codex-router classify [--json] TEXT
  codex-router migrate-config        Upgrade the local config to the current schema
  codex-router control-server        Run the loopback control API for the menu bar app
  codex-router cli [CODEX_ARGS...]   Run the transparent CLI adapter
  codex-router app-server ...        Run the Desktop stdio adapter

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
      process.stderr.write("codex-router classify requires prompt text\n");
      return 2;
    }
    const decision = await engine.routeTurn({
      threadId: "router-classify",
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
  const cliEntrypoint = process.env.CODEX_ROUTER_ENTRYPOINT === "codex";
  const appServerInvocation = !cliEntrypoint && args.includes("app-server");
  if (!cliEntrypoint && args[0] === "migrate-config") {
    const changed = await migrateConfigFile();
    process.stdout.write(
      changed
        ? "[codex-router] config migrated to schema v2\n"
        : "[codex-router] no config migration was needed\n",
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
    process.stderr.write(`[codex-router] configuration unavailable; failing open: ${(error as Error).message}\n`);
    const fallback = defaultConfig();
    if (appServerInvocation) {
      return spawnInherited(
        process.env.CODEX_ROUTER_BACKEND ?? fallback.codex.desktopBinary,
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
      process.env.CODEX_ROUTER_BACKEND ?? engine.config.codex.desktopBinary,
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
