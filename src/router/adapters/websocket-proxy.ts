import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { WebSocket, WebSocketServer } from "ws";
import { publishDecisionEvent } from "../../island/decision-feed.js";
import type { RoutingEngine } from "../core/engine.js";
import { ClientLineDispatcher } from "./client-line-dispatcher.js";
import { backendEnvironment, forwardSignals } from "./codex-process.js";
import { ProtocolRouter } from "./protocol-router.js";

export interface InteractiveProxyOptions {
  manualModelOverride?: boolean;
}

function remoteArgs(args: string[], address: string): string[] {
  const command = args[0];
  if (command === "resume" || command === "fork") {
    return [command, "--remote", address, ...args.slice(1)];
  }
  return ["--remote", address, ...args];
}

export async function runInteractiveProxy(
  realCodex: string,
  args: string[],
  engine: RoutingEngine,
  options: InteractiveProxyOptions = {},
): Promise<number> {
  const protocol = new ProtocolRouter(engine, {
    manualModelOverride: options.manualModelOverride ?? false,
    surface: "terminal",
    onDecision: async ({ decision, threadId, triggeredAt }) => {
      await publishDecisionEvent(engine.config, "terminal", decision, {
        triggeredAt,
        ...(threadId ? { threadId } : {}),
      }).catch(() => undefined);
    },
  });
  const backend = spawn(realCodex, ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: backendEnvironment(),
  });
  const cleanupBackendSignals = forwardSignals(backend);
  let client: WebSocket | undefined;
  let dispatcher: ClientLineDispatcher | undefined;
  let backendError = "";
  backend.stderr?.on("data", (chunk: Buffer) => {
    backendError = `${backendError}${chunk.toString("utf8")}`.slice(-8000);
  });

  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unable to bind router websocket");
  const remoteAddress = `ws://127.0.0.1:${address.port}`;

  server.on("connection", (socket) => {
    if (client && client.readyState === WebSocket.OPEN) {
      socket.close(1013, "Agent Dock accepts one client per session");
      return;
    }
    client = socket;
    dispatcher = new ClientLineDispatcher(
      (line) => protocol.transformClientLine(line),
      async (line) => {
        if (!backend.stdin?.writable) return;
        if (!backend.stdin.write(`${line}\n`)) {
          await new Promise<void>((resolve) => backend.stdin?.once("drain", resolve));
        }
      },
    );
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      dispatcher?.dispatch(data.toString());
    });
    socket.once("close", () => {
      void dispatcher?.drain().finally(() => backend.stdin?.end());
    });
  });

  const backendLines = createInterface({ input: backend.stdout!, crlfDelay: Infinity });
  const backendTask = (async () => {
    for await (const line of backendLines) {
      protocol.observeServerLine(line);
      if (client?.readyState === WebSocket.OPEN) client.send(line);
    }
  })();

  engine.warmup();
  const frontend = spawn(realCodex, remoteArgs(args, remoteAddress), {
    stdio: "inherit",
    env: backendEnvironment(),
  });
  const cleanupFrontendSignals = forwardSignals(frontend);
  const code = await new Promise<number>((resolve) => {
    frontend.once("error", (error) => {
      process.stderr.write(`[agent-dock] Codex CLI failed to start: ${error.message}\n`);
      resolve(127);
    });
    frontend.once("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 128 : 1)));
  });

  client?.close();
  server.close();
  if (!backend.killed) backend.kill("SIGTERM");
  await Promise.race([backendTask, new Promise((resolve) => setTimeout(resolve, 500))]);
  cleanupFrontendSignals();
  cleanupBackendSignals();
  if (code !== 0 && backendError) {
    process.stderr.write(`[agent-dock] app-server diagnostic:\n${backendError}\n`);
  }
  return code;
}
