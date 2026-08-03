#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h:h:h}"
package_dir="$project_dir/apps/macos/AgentDockBar"
# Keep the development bundle under SwiftPM's hidden build directory. A bundle
# under dist/ is indexed by LaunchServices and appears as a second installed app.
app_dir="$package_dir/.build/agent-dock-app/Agent Dock.app"
contents_dir="$app_dir/Contents"

"$project_dir/scripts/macos/build-icon.sh"
swift build --configuration release --package-path "$package_dir"
bin_dir="$(swift build --configuration release --package-path "$package_dir" --show-bin-path)"

mkdir -p "$contents_dir/MacOS" "$contents_dir/Resources"
cp "$bin_dir/AgentDockBar" "$contents_dir/MacOS/AgentDockBar"
cp "$package_dir/Resources/Info.plist" "$contents_dir/Info.plist"
cp "$package_dir/Resources/AppIcon.icns" "$contents_dir/Resources/AppIcon.icns"
chmod 755 "$contents_dir/MacOS/AgentDockBar"

# Ad-hoc signing is sufficient for local development. Distribution signing and
# notarization remain a later release concern once full Xcode is installed.
codesign --force --sign - "$app_dir"
print "$app_dir"
