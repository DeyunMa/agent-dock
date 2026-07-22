import type { RoutingEngine } from "../routing/engine.js";
import { publishDecisionEvent } from "../presentation/decision-events.js";
import {
  extractExecPrompt,
  hasExplicitRoutingArgument,
  hasLocalProvider,
  hasRemoteArgument,
  injectExecRoute,
  topLevelCommand,
} from "../transport/codex-arguments.js";
import { spawnInherited } from "../transport/codex-process.js";
import { runInteractiveProxy } from "../transport/websocket-proxy.js";

const DIRECT_COMMANDS = new Set([
  "review",
  "login",
  "logout",
  "mcp",
  "plugin",
  "mcp-server",
  "app-server",
  "remote-control",
  "app",
  "completion",
  "update",
  "doctor",
  "sandbox",
  "debug",
  "apply",
  "archive",
  "delete",
  "unarchive",
  "cloud",
  "exec-server",
  "features",
  "help",
]);

export async function runCli(args: string[], engine: RoutingEngine): Promise<number> {
  const realCodex = engine.config.codex.cliBinary;
  if (args.some((argument) => ["--help", "-h", "--version", "-V"].includes(argument))) {
    return spawnInherited(realCodex, args);
  }
  if (
    process.env.CODEX_ROUTER_BYPASS === "1" ||
    hasRemoteArgument(args) ||
    hasLocalProvider(args)
  ) {
    return spawnInherited(realCodex, args);
  }

  const command = topLevelCommand(args);
  const explicitRoute = hasExplicitRoutingArgument(args);
  if (explicitRoute && engine.config.routing.respectCliModelFlag) {
    return spawnInherited(realCodex, args);
  }

  if (command === "exec" || command === "e") {
    const prompt = extractExecPrompt(args);
    if (!prompt) return spawnInherited(realCodex, args);
    const triggeredAt = new Date().toISOString();
    const decision = await engine.routeTurn(
      {
        threadId: "cli-exec",
        input: [{ type: "text", text: prompt }],
        cwd: process.cwd(),
      },
      { triggeredAt, surface: "terminal" },
    );
    await publishDecisionEvent(engine.config, "terminal", decision, { triggeredAt }).catch(
      () => undefined,
    );
    const exitCode = await spawnInherited(
      realCodex,
      decision.action === "apply" && decision.profile
        ? injectExecRoute(args, decision.profile)
        : args,
    );
    return exitCode;
  }

  if (command && DIRECT_COMMANDS.has(command)) return spawnInherited(realCodex, args);
  if (command && command !== "resume" && command !== "fork") return spawnInherited(realCodex, args);
  return runInteractiveProxy(realCodex, args, engine);
}
