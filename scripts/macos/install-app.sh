#!/bin/zsh
# Build and replace only the installed Agent Dock menu-bar app. Never restarts Codex.
# Build a standalone bundle; --built installs a bundle already verified by packaging.
# Recovery: deactivate, then install a prior bundle. Never restarts Codex.
set -euo pipefail
project_dir="${0:A:h:h:h}"
if [[ "${1:-}" != "--built" ]]; then
  if [[ $# -gt 0 ]]; then print -u2 "Usage: install-app.sh [--built]"; exit 1; fi
  "$project_dir/scripts/macos/build-app.sh"
fi
app_source="$project_dir/apps/macos/AgentDockBar/.build/agent-dock-app/Agent Dock.app"
codesign --verify --deep --strict "$app_source"
app_target="$HOME/Applications/Agent Dock.app"
/usr/bin/pkill -x AgentDockBar || true
/bin/mkdir -p "$HOME/Applications"
/usr/bin/ditto "$app_source" "$app_target"
/usr/bin/open "$app_target"
