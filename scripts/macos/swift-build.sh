#!/bin/zsh
# SDK 26.5 avoids the incomplete SwiftUI macro distribution in this machine's
# CLT 27 SDK. AGENT_DOCK_SWIFT_SDK explicitly selects another installed SDK.
set -euo pipefail
project_dir="${0:A:h:h:h}"
sdk="${AGENT_DOCK_SWIFT_SDK:-/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk}"
if [[ ! -d "$sdk" ]]; then
  print -u2 "SDK missing: $sdk. Set AGENT_DOCK_SWIFT_SDK to an installed compatible SDK."
  exit 1
fi
exec swift build --sdk "$sdk" --package-path "$project_dir/apps/macos/AgentDockBar" "$@"
