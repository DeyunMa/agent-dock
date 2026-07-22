import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import type { RoutingEngine } from "../routing/engine.js";
import { backendEnvironment, forwardSignals } from "./codex-process.js";
import { ProtocolRouter, type ProtocolRouterOptions } from "./protocol-router.js";

export async function runStdioProxy(
  backend: string,
  args: string[],
  engine: RoutingEngine,
  options: ProtocolRouterOptions = {},
): Promise<number> {
  const child = spawn(backend, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: backendEnvironment(),
  });
  const cleanupSignals = forwardSignals(child);
  const protocol = new ProtocolRouter(engine, options);
  engine.warmup();

  child.stderr?.pipe(process.stderr);
  const decoder = new StringDecoder("utf8");
  let serverBuffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    serverBuffer += decoder.write(chunk);
    let newline = serverBuffer.indexOf("\n");
    while (newline >= 0) {
      protocol.observeServerLine(serverBuffer.slice(0, newline).replace(/\r$/, ""));
      serverBuffer = serverBuffer.slice(newline + 1);
      newline = serverBuffer.indexOf("\n");
    }
  });

  const inputTask = (async () => {
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      const transformed = await protocol.transformClientLine(line);
      if (!child.stdin?.writable) break;
      if (!child.stdin.write(`${transformed}\n`)) {
        await new Promise<void>((resolve) => child.stdin?.once("drain", resolve));
      }
    }
    child.stdin?.end();
  })().catch(() => {
    child.stdin?.end();
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.once("error", (error) => {
      process.stderr.write(`[codex-router] app-server failed to start: ${error.message}\n`);
      resolve(127);
    });
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
  cleanupSignals();
  void inputTask;
  return exitCode;
}
