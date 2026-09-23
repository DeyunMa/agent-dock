// Dry-run by default. --confirm restores native Codex and removes only owned links
// and shell blocks. Keeps the app, provider accounts, Jev key and all task data.
// Quit Agent Dock first; launching it again activates it again.
import { readFile, readlink, unlink, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { canReplace } from "./setup.mjs";

export async function deactivate({ home = homedir(), runtime = dirname(fileURLToPath(import.meta.url)), run = execFileSync, confirm = false } = {}) {
  const data = join(home, ".agent-dock");
  const bin = join(home, ".local/bin");
  const paths = [];
  for (const name of ["agent-dock", "codex"]) {
    const path = join(bin, name);
    try { await readlink(path); if (await canReplace(path, runtime)) paths.push(path); } catch {}
  }
  const shells = [];
  for (const name of [".zprofile", ".zshrc"]) {
    const path = join(home, name);
    try {
      const original = await readFile(path, "utf8");
      const updated = original.replace(/(?:^|\n)# >>> agent-dock >>>\n[\s\S]*?^# <<< agent-dock <<<\n?/gm, "\n");
      if (original !== updated) shells.push({ path, original, updated });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (!confirm) return { dryRun: true, links: paths, shellBlocks: shells.map(x => x.path), preservesCredentialsAndData: true };
  try { run("/usr/bin/pgrep", ["-x", "AgentDockBar"], { stdio: "ignore" }); throw new Error("请先退出 Agent Dock 菜单栏应用，再停用。"); }
  catch (error) { if (error.status !== 1) throw error; }
  const backup = join(data, "backups", `deactivate-${Date.now()}`);
  await mkdir(backup, { recursive: true, mode: 0o700 });
  let config = "";
  try { config = await readFile(join(home, ".codex/config.toml"), "utf8"); } catch {}
  if (/^\s*openai_base_url\s*=\s*["']http:\/\/(?:127\.0\.0\.1|localhost):10100\/(?:v1|backend-api\/codex)["']/m.test(config)) {
    run(join(runtime, "ocx"), ["restore"], { stdio: "inherit" });
  }
  for (const { path, original, updated } of shells) {
    await writeFile(join(backup, path.split("/").at(-1)), original, { mode: 0o600 });
    await writeFile(path, updated);
  }
  const active = run("/bin/launchctl", ["getenv", "CODEX_CLI_PATH"], { encoding: "utf8" }).trim();
  if (active === join(bin, "agent-dock") || active === join(runtime, "agent-dock")) {
    let previous = "";
    try { previous = JSON.parse(await readFile(join(data, "activation-backup.json"), "utf8")).previous ?? ""; } catch {}
    // A previous Agent Dock entry would become a broken path after deactivation.
    if (previous === active || previous === join(bin, "agent-dock") || previous.includes("Agent Dock.app/")) previous = "";
    if (previous) run("/bin/launchctl", ["setenv", "CODEX_CLI_PATH", previous]);
    else run("/bin/launchctl", ["unsetenv", "CODEX_CLI_PATH"]);
  }
  for (const path of paths) await unlink(path);
  return { deactivated: true, restartCodex: true, preservesCredentialsAndData: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await deactivate({ confirm: process.argv.includes("--confirm") }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
