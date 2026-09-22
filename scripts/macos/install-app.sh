#!/bin/zsh
# Build and replace only the installed Agent Dock menu-bar app. Never restarts Codex.
# Run after scripts/local/install.sh. Recovery: rebuild/install a prior checkout.
set -euo pipefail
project_dir="${0:A:h:h:h}"
"$project_dir/scripts/macos/build-app.sh"
app_source="$project_dir/apps/macos/AgentDockBar/.build/agent-dock-app/Agent Dock.app"
app_target="$HOME/Applications/Agent Dock.app"
/usr/bin/pkill -x AgentDockBar || true
/bin/mkdir -p "$HOME/Applications"
/usr/bin/ditto "$app_source" "$app_target"
/usr/bin/open "$app_target"
