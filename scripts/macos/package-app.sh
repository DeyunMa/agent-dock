#!/bin/zsh
# Build a relocatable internal macOS archive for this machine's architecture.
# Prerequisites on builder: Node 22+, npm, pnpm, Swift SDK. Recipients need only Codex.
# Output contains no user config or secrets. For an upgrade, quit Agent Dock before
# replacing the app; restart Codex at a suitable break to use the new router.
set -euo pipefail
project_dir="${0:A:h:h:h}"
"$project_dir/scripts/macos/build-app.sh"
version="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).version' "$project_dir/package.json")"
output_dir="$project_dir/apps/macos/AgentDockBar/.build/releases"
mkdir -p "$output_dir"
archive="$output_dir/Agent-Dock-$version-$(uname -m).zip"
ditto -c -k --sequesterRsrc --keepParent "$project_dir/apps/macos/AgentDockBar/.build/agent-dock-app/Agent Dock.app" "$archive"
shasum -a 256 "$archive"
print "$archive"
