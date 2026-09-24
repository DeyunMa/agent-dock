// Install the development build as a user-level Codex hook without replacing other hooks.
// Prerequisite: pnpm build. Effect: one UserPromptSubmit handler in ~/.codex/hooks.json.
// A timestamped backup is kept in ~/.codex/backups; restore it to undo the change.
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const codexHome = process.env.CODEX_HOME?.startsWith("~/")
  ? join(homedir(), process.env.CODEX_HOME.slice(2))
  : process.env.CODEX_HOME ?? join(homedir(), ".codex");
const target = join(codexHome, "hooks.json");
const entry = fileURLToPath(new URL("../../dist/src/index.js", import.meta.url));
const shellQuote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const command = `${shellQuote(process.execPath)} ${shellQuote(entry)} user-prompt-submit-hook`;

await access(entry, constants.R_OK);
const original = await readFile(target, "utf8").catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const config = original ? JSON.parse(original) : { hooks: {} };
if (!config || typeof config !== "object" || Array.isArray(config) || !config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
  throw new Error("Invalid Codex hooks.json; refusing to overwrite it");
}
const existing = config.hooks.UserPromptSubmit ?? [];
if (!Array.isArray(existing)) throw new Error("Invalid UserPromptSubmit hooks; refusing to overwrite them");
if (existing.some((group) => Array.isArray(group?.hooks) && group.hooks.some((hook) => hook?.command === command))) {
  process.stdout.write("Agent Dock global hook is already installed.\n");
  process.exit(0);
}
if (process.argv.includes("--dry-run")) {
  process.stdout.write(`Would append Agent Dock UserPromptSubmit hook to ${target}; existing handlers: ${existing.length}.\n`);
  process.exit(0);
}

const backupDir = join(dirname(target), "backups");
await mkdir(dirname(target), { recursive: true, mode: 0o700 });
if (original) {
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const backup = join(backupDir, `agent-dock-hooks-${new Date().toISOString().replaceAll(":", "-")}.json`);
  await writeFile(backup, original, { flag: "wx", mode: 0o600 });
}
const current = await readFile(target, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
if (current !== original) throw new Error("Codex hooks.json changed during installation; refusing to overwrite it");
const handler = { hooks: [{ type: "command", command, timeout: 8, additionalContextLimit: 1200, statusMessage: "Checking Skill candidates" }] };
config.hooks.UserPromptSubmit = [...existing, handler];
const temporary = `${target}.agent-dock-${process.pid}`;
try {
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, target);
} finally {
  await unlink(temporary).catch(() => undefined);
}
const metadata = await stat(target);
if ((metadata.mode & 0o077) !== 0) throw new Error("Installed hooks.json has unsafe permissions");
process.stdout.write(`Installed Agent Dock UserPromptSubmit hook in ${target}.\n`);
