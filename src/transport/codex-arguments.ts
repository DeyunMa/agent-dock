const TOP_LEVEL_COMMANDS = new Set([
  "exec",
  "e",
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
  "resume",
  "archive",
  "delete",
  "unarchive",
  "fork",
  "cloud",
  "exec-server",
  "features",
  "help",
]);

const OPTIONS_WITH_VALUE = new Set([
  "-c",
  "--config",
  "-m",
  "--model",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-C",
  "--cd",
  "--add-dir",
  "-a",
  "--ask-for-approval",
  "--local-provider",
  "--remote",
  "--remote-auth-token-env",
  "--output-schema",
  "--color",
  "-o",
  "--output-last-message",
]);

function isAttachedOption(argument: string): boolean {
  return argument.startsWith("--") && argument.includes("=");
}

export function commandIndex(args: string[]): number | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (OPTIONS_WITH_VALUE.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-") || isAttachedOption(argument)) continue;
    return TOP_LEVEL_COMMANDS.has(argument) ? index : undefined;
  }
  return undefined;
}

export function topLevelCommand(args: string[]): string | undefined {
  const index = commandIndex(args);
  return index === undefined ? undefined : args[index];
}

export function hasRemoteArgument(args: string[]): boolean {
  return args.some((argument) => argument === "--remote" || argument.startsWith("--remote="));
}

export function hasLocalProvider(args: string[]): boolean {
  return args.some(
    (argument) =>
      argument === "--oss" ||
      argument === "--local-provider" ||
      argument.startsWith("--local-provider="),
  );
}

export function hasExplicitRoutingArgument(args: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (argument === "-m" || argument === "--model" || argument.startsWith("--model=")) return true;
    if (argument === "-c" || argument === "--config") {
      const value = args[index + 1] ?? "";
      if (/^(?:model|model_reasoning_effort|service_tier)=/.test(value)) return true;
      index += 1;
      continue;
    }
    if (/^--config=(?:model|model_reasoning_effort|service_tier)=/.test(argument)) return true;
  }
  return false;
}

export function extractExecPrompt(args: string[]): string | undefined {
  const index = commandIndex(args);
  if (index === undefined || (args[index] !== "exec" && args[index] !== "e")) return undefined;
  const tail = args.slice(index + 1);
  for (let cursor = 0; cursor < tail.length; cursor += 1) {
    const argument = tail[cursor];
    if (!argument) continue;
    if (OPTIONS_WITH_VALUE.has(argument)) {
      cursor += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    if (argument === "resume" || argument === "review" || argument === "help") return undefined;
    return argument;
  }
  return undefined;
}

export function injectExecRoute(
  args: string[],
  profile: { model: string; effort: string; fast: boolean },
): string[] {
  const index = commandIndex(args);
  if (index === undefined) return args;
  const routeArgs = ["-m", profile.model, "-c", `model_reasoning_effort=\"${profile.effort}\"`];
  if (profile.fast) routeArgs.push("-c", 'service_tier="priority"');
  return [...args.slice(0, index + 1), ...routeArgs, ...args.slice(index + 1)];
}
