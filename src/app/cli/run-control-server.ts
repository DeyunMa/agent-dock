import {
  DEFAULT_CONTROL_HOST,
  DEFAULT_CONTROL_PORT,
  runControlServer,
} from "../control/server.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const inline = args.find((argument) => argument.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

export async function runControlServerCommand(args: string[], version: string): Promise<number> {
  const host = option(args, "--host") ?? DEFAULT_CONTROL_HOST;
  const rawPort = option(args, "--port");
  const port = rawPort === undefined ? DEFAULT_CONTROL_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    process.stderr.write("agent-dock control-server: --port must be between 1 and 65535\n");
    return 2;
  }
  if (host !== "127.0.0.1" && host !== "localhost") {
    process.stderr.write("agent-dock control-server only supports loopback hosts\n");
    return 2;
  }

  await runControlServer({ host, port, version });
  return 0;
}
