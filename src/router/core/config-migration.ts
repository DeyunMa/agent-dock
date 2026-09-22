import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse, stringify } from "smol-toml";
import {
  CURRENT_CONFIG_VERSION,
  configuredConfigPath,
  defaultConfig,
  expandHome,
  parseConfig,
} from "./config.js";

type Table = Record<string, unknown>;

function table(value: unknown): Table {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Table)
    : {};
}

export function migrateConfigSource(source: string): string {
  const raw = table(parse(source));
  const defaults = defaultConfig();
  if (raw.version === CURRENT_CONFIG_VERSION) { parseConfig(source); return source; }
  if (raw.version !== undefined && raw.version !== 1 && raw.version !== 2) throw new Error("Unsupported config version");
  const previous = table(raw.classifier);
  raw.version = CURRENT_CONFIG_VERSION;
  raw.classifier = {
    enabled: previous.enabled ?? true,
    base_url: defaults.classifier.baseUrl,
    model: defaults.classifier.model,
    api_key_file: "~/.agent-dock/credentials/jev-api-key",
    timeout_ms: defaults.classifier.timeoutMs,
    max_chars: defaults.classifier.maxChars,
  };
  const routes = table(raw.routes);
  raw.routes = { quick: routes.quick ?? defaults.routes.quick, balanced: routes.balanced ?? defaults.routes.balanced, deep: routes.max ?? routes.deep ?? defaults.routes.deep };
  const routing = table(raw.routing);
  raw.routing = { respect_cli_model_flag: routing.respect_cli_model_flag ?? true, state_directory: "~/.agent-dock/thread-routes", route_order: ["quick", "balanced", "deep"], controls: { step_up: defaults.routing.controls.stepUp, max: defaults.routing.controls.max, auto: defaults.routing.controls.auto, fallback_route: "deep" } };
  delete raw.ollama;
  delete raw.rules_file;
  delete raw.fail_open;
  const migrated = `${stringify(raw).trim()}\n`;
  parseConfig(migrated);
  return migrated;
}

export async function migrateConfigFile(
  path = configuredConfigPath(),
): Promise<boolean> {
  const configPath = expandHome(path);
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
  const migrated = migrateConfigSource(source);
  if (migrated === source) return false;
  const temporary = `${configPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, migrated, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, configPath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return true;
}
