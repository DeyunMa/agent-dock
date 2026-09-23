// First launch installs links to the bundled runtime, without source checkout or npm.
// Existing configuration is preserved; only Agent Dock-owned links may be replaced.
import { access, lstat, mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { stringify } from "smol-toml";

async function exists(path) { try { await access(path); return true; } catch { return false; } }
export async function canReplace(path, runtime) {
  try {
    const stat = await lstat(path);
    if (!stat.isSymbolicLink()) return false;
    const target = resolve(dirname(path), await readlink(path));
    if (target === join(runtime, path.endsWith("/codex") ? "codex" : "agent-dock")) return true;
    // Recognize our previous source install by its package identity.
    try { return JSON.parse(await readFile(join(dirname(target), "../package.json"), "utf8")).name === "@mdy/agent-dock"; } catch {}
    try { return JSON.parse(await readFile(join(dirname(target), "package.json"), "utf8")).name === "agent-dock-runtime"; } catch {}
    return false;
  } catch (error) { if (error.code === "ENOENT") return true; throw error; }
}

export async function setup({ home = homedir(), runtime = dirname(fileURLToPath(import.meta.url)), run = execFileSync, candidates } = {}) {
  const data = join(home, ".agent-dock");
  const bin = join(home, ".local/bin");
  if (runtime.includes("/.build/") || runtime.startsWith("/Volumes/") || runtime.includes("/AppTranslocation/")) {
    throw new Error("请先将 Agent Dock.app 复制到 Applications，再打开。");
  }
  candidates ??= ["/Applications/Codex.app", "/Applications/ChatGPT.app", join(home, "Applications/Codex.app"), join(home, "Applications/ChatGPT.app")];
  let desktop;
  for (const app of candidates) {
    const path = join(app, "Contents/Resources/codex");
    try { await access(path, constants.X_OK); desktop = path; break; } catch {}
  }
  if (!desktop) throw new Error("未找到 Codex Desktop。请先安装 Codex，再打开 Agent Dock。");
  for (const name of ["agent-dock", "codex"]) {
    if (!await canReplace(join(bin, name), runtime)) throw new Error(`现有 ${join(bin, name)} 不属于 Agent Dock，请先将该命令移至其他目录。`);
  }
  await mkdir(data, { recursive: true, mode: 0o700 });
  await mkdir(bin, { recursive: true });
  const config = join(data, "router.toml");
  if (!await exists(config)) {
    let cli = desktop;
    for (const path of ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]) {
      try { await access(path, constants.X_OK); cli = path; break; } catch {}
    }
    const { parse } = await import("smol-toml");
    const value = parse(await readFile(join(runtime, "router.toml.example"), "utf8"));
    value.codex = { cli_binary: cli, desktop_binary: desktop };
    await writeFile(config, stringify(value), { mode: 0o600, flag: "wx" });
  }
  // Preserve the first activation environment for exact deactivation later.
  const restore = join(data, "activation-backup.json");
  if (!await exists(restore)) {
    const previous = run("/bin/launchctl", ["getenv", "CODEX_CLI_PATH"], { encoding: "utf8" }).trim();
    await writeFile(restore, JSON.stringify({ previous }), { mode: 0o600, flag: "wx" });
  }
  for (const name of ["agent-dock", "codex"]) {
    const path = join(bin, name);
    const temporary = `${path}.agent-dock-${process.pid}`;
    try {
      await symlink(join(runtime, name), temporary);
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  const block = '# >>> agent-dock >>>\npath=("$HOME/.local/bin" ${path:#$HOME/.local/bin})\ntypeset -U path PATH\nexport CODEX_CLI_PATH="$HOME/.local/bin/agent-dock"\n# <<< agent-dock <<<\n';
  for (const name of [".zprofile", ".zshrc"]) {
    const path = join(home, name);
    let original = "";
    try { original = await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (original.includes(block)) continue;
    const backup = join(data, "backups", `setup-${Date.now()}`);
    await mkdir(backup, { recursive: true, mode: 0o700 });
    await writeFile(join(backup, name), original, { mode: 0o600 });
    const preserved = original.replace(/(?:^|\n)# >>> agent-dock >>>\n[\s\S]*?^# <<< agent-dock <<<\n?/gm, "\n");
    await writeFile(path, `${preserved}\n${block}`);
  }
  run("/bin/launchctl", ["setenv", "CODEX_CLI_PATH", join(bin, "agent-dock")]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await setup(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
