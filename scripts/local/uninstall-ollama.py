#!/usr/bin/env python3
"""Remove the macOS drag-and-drop Ollama installation and its local data.

Default is dry-run; use --confirm after reviewing inventory. Scope: Ollama apps,
known support/cache/preferences/log/model paths, CLI links into Ollama.app, and
retired Agent Dock runtime classifier copies. Does not touch source training data,
Codex, Gateway, shell profiles or unrelated applications. No credential contents
are read or logged. Models/keys are intentionally deleted, not backed up; recover
by reinstalling Ollama and pulling models. Requires write access to owned paths.
Homebrew installs and external model directories are refused for separate review.
Verification: rerun dry-run, check ollama command absence and no listener on 11434.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument("--confirm", action="store_true")
args = parser.parse_args()
home = Path.home()
if any(Path(p).exists() for p in ["/opt/homebrew/Cellar/ollama", "/opt/homebrew/Caskroom/ollama", "/usr/local/Cellar/ollama", "/usr/local/Caskroom/ollama"]):
    raise SystemExit("Homebrew installation found; use its uninstaller first")
override = os.environ.get("OLLAMA_MODELS") or subprocess.run(["launchctl", "getenv", "OLLAMA_MODELS"], capture_output=True, text=True).stdout.strip()
if override and Path(override).expanduser() != home / ".ollama/models":
    raise SystemExit("External model directory configured; review separately")
apps = [Path("/Applications/Ollama.app"), home / "Applications/Ollama.app"]
targets = apps + [home / p for p in [
    ".ollama", "Library/Application Support/Ollama", "Library/Caches/com.electron.ollama",
    "Library/Caches/ollama", "Library/Preferences/com.electron.ollama.plist",
    "Library/Preferences/com.ollama.ollama.plist", "Library/WebKit/com.electron.ollama",
    "Library/Saved Application State/com.electron.ollama.savedState",
    "Library/HTTPStorages/com.electron.ollama", "Library/HTTPStorages/com.electron.ollama.binarycookies",
    "Library/Logs/Ollama", ".agent-dock/classifier-v1",
]]
for path in [home / ".local/bin/ollama", Path("/usr/local/bin/ollama"), Path("/opt/homebrew/bin/ollama")]:
    if path.is_symlink() and "Ollama.app/Contents/" in os.readlink(path): targets.append(path)
    elif path.exists(): raise SystemExit(f"Unrecognized CLI install, review separately: {path}")
for directory in [home / "Library/LaunchAgents", Path("/Library/LaunchAgents"), Path("/Library/LaunchDaemons")]:
    if directory.exists():
        for path in directory.glob("*ollama*.plist"): targets.append(path)
backup = home / ".agent-dock/backups"
if backup.exists(): targets.extend(p for p in backup.glob("classifier-*") if p.is_dir())
targets = [p for p in targets if p.exists() or p.is_symlink()]
def processes():
    output = subprocess.run(["ps", "-axo", "pid=,comm="], capture_output=True, text=True, check=True).stdout
    found = []
    for line in output.splitlines():
        columns = line.strip().split(None, 1)
        if len(columns) == 2 and any(columns[1].startswith(str(app) + "/Contents/") for app in apps): found.append(int(columns[0]))
    return found
jobs = subprocess.run(["launchctl", "list"], capture_output=True, text=True, check=True).stdout
labels = [line.split()[-1] for line in jobs.splitlines() if line.split() and (line.split()[-1] == "com.ollama.ollama" or line.split()[-1].startswith("application.com.electron.ollama."))]
print(json.dumps({"mode": "remove" if args.confirm else "dry-run", "targets": list(map(str, targets)), "processes": processes(), "launch_jobs": labels}, indent=2), flush=True)
if not args.confirm: raise SystemExit(0)
for label in labels:
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{label}"], capture_output=True)
for pid in processes():
    try: os.kill(pid, signal.SIGTERM)
    except ProcessLookupError: pass
for _ in range(50):
    if not processes(): break
    time.sleep(0.1)
if processes(): raise SystemExit("Ollama processes still running; no files deleted")
for path in targets:
    try:
        if path.is_symlink() or path.is_file(): path.unlink()
        elif path.is_dir(): shutil.rmtree(path)
        print(f"Removed: {path}", flush=True)
    except OSError as error:
        print(f"Not removed ({error.strerror}): {path}", flush=True)
remaining = [str(p) for p in targets if p.exists() or p.is_symlink()]
print(json.dumps({"remaining": remaining, "processes": processes()}))
if remaining: raise SystemExit(1)
