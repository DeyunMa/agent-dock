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
  const legacyOllama = table(raw.ollama);
  const existing = table(raw.classifier);
  raw.version = CURRENT_CONFIG_VERSION;
  raw.classifier = {
    enabled:
      typeof existing.enabled === "boolean"
        ? existing.enabled
        : typeof legacyOllama.enabled === "boolean"
          ? legacyOllama.enabled
          : defaults.classifier.enabled,
    base_url:
      typeof existing.base_url === "string"
        ? existing.base_url
        : typeof legacyOllama.base_url === "string"
          ? legacyOllama.base_url
          : defaults.classifier.baseUrl,
    model:
      typeof existing.model === "string"
        ? existing.model
        : defaults.classifier.model,
    model_digest:
      typeof existing.model_digest === "string"
        ? existing.model_digest
        : defaults.classifier.modelDigest,
    model_directory:
      typeof existing.model_directory === "string"
        ? existing.model_directory
        : "~/.agent-dock/classifier-v1",
    timeout_ms:
      typeof existing.timeout_ms === "number"
        ? existing.timeout_ms
        : defaults.classifier.timeoutMs,
    keep_alive:
      typeof existing.keep_alive === "string"
        ? existing.keep_alive
        : typeof legacyOllama.keep_alive === "string"
          ? legacyOllama.keep_alive
          : defaults.classifier.keepAlive,
  };
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
