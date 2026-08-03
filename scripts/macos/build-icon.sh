#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h:h:h}"
resources_dir="$project_dir/apps/macos/AgentDockBar/Resources"
source_icon="$resources_dir/AppIconSource.png"
base_icon="$resources_dir/AppIcon.png"
output_icon="$resources_dir/AppIcon.icns"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/agent-dock-icon.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

/usr/bin/swift "$project_dir/scripts/macos/render-icon.swift" "$source_icon" "$base_icon"

iconset="$work_dir/AppIcon.iconset"
mkdir -p "$iconset"

render_size() {
  local pixels="$1"
  local filename="$2"
  /usr/bin/sips -z "$pixels" "$pixels" "$base_icon" --out "$iconset/$filename" >/dev/null
}

render_size 16 icon_16x16.png
render_size 32 icon_16x16@2x.png
render_size 32 icon_32x32.png
render_size 64 icon_32x32@2x.png
render_size 128 icon_128x128.png
render_size 256 icon_128x128@2x.png
render_size 256 icon_256x256.png
render_size 512 icon_256x256@2x.png
render_size 512 icon_512x512.png
render_size 1024 icon_512x512@2x.png

/usr/bin/iconutil -c icns "$iconset" -o "$output_icon"
print "$output_icon"
