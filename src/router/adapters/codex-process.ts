import { spawn, type ChildProcess } from "node:child_process";

export function backendEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.CODEX_CLI_PATH;
  delete environment.AGENT_DOCK_ENTRYPOINT;
  delete environment.AGENT_DOCK_BYPASS;
  return environment;
}

export function spawnInherited(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: backendEnvironment(),
    });
    const cleanupSignals = forwardSignals(child);
    child.once("error", (error) => {
      cleanupSignals();
      process.stderr.write(`[agent-dock] unable to start Codex: ${error.message}\n`);
      resolve(127);
    });
    child.once("exit", (code, signal) => {
      cleanupSignals();
      resolve(code ?? (signal ? 128 : 1));
    });
  });
}

export function forwardSignals(child: ChildProcess): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => {
      if (!child.killed) child.kill(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}
