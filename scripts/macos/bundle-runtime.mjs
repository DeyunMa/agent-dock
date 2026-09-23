// Build-only: fixed npm lockfile, bundled Node/Bun/OpenCodex; no personal state copied.
import { cp, mkdir, rm, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const project = fileURLToPath(new URL("../../", import.meta.url));
const target = process.argv[2];
if (!target || !target.includes("/.build/agent-dock-app/")) throw new Error("Expected development App bundle output");
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const name of ["package.json", "package-lock.json", "agent-dock", "codex", "ocx", "setup.mjs", "deactivate.mjs"]) {
  await cp(join(project, "scripts/runtime", name), join(target, name));
}
execFileSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: target, stdio: "inherit" });
await cp(join(project, "dist"), join(target, "dist"), { recursive: true });
await cp(join(project, "resources/router/router.toml.example"), join(target, "router.toml.example"));
for (const name of ["agent-dock", "codex", "ocx"]) await chmod(join(target, name), 0o755);
execFileSync(join(target, "node_modules/node/bin/node"), ["--version"], { stdio: "inherit" });
execFileSync(join(target, "ocx"), ["--version"], { stdio: "inherit" });
