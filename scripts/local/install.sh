#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h:h:h}"
agent_dock_home="$HOME/.agent-dock"
local_bin="$HOME/.local/bin"
classifier_source="${AGENT_DOCK_CLASSIFIER_SOURCE:-$project_dir/resources/router/classifier-v1}"
classifier_target="$agent_dock_home/classifier-v1"
config_path="$agent_dock_home/router.toml"

cd "$project_dir"
pnpm install --frozen-lockfile
pnpm check
pnpm build

mkdir -p "$agent_dock_home" "$local_bin"
chmod 700 "$agent_dock_home"
if [[ ! -f "$config_path" ]]; then
  cp "$project_dir/resources/router/router.toml.example" "$config_path"
  chmod 600 "$config_path"
fi

for model_file in intent.json category.json complexity.json; do
  if [[ ! -f "$classifier_source/$model_file" ]]; then
    print -u2 "Missing classifier artifact: $classifier_source/$model_file"
    print -u2 "Restore resources/router/classifier-v1 or set AGENT_DOCK_CLASSIFIER_SOURCE."
    exit 1
  fi
done

classifier_stage="$(mktemp -d "$agent_dock_home/.classifier-v1.XXXXXX")"
trap 'rm -rf "$classifier_stage"' EXIT
chmod 700 "$classifier_stage"
for model_file in intent.json category.json complexity.json; do
  cp "$classifier_source/$model_file" "$classifier_stage/$model_file"
  chmod 600 "$classifier_stage/$model_file"
done
if [[ -d "$classifier_target" ]]; then
  classifier_backup="$agent_dock_home/backups/classifier-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$agent_dock_home/backups"
  chmod 700 "$agent_dock_home/backups"
  mv "$classifier_target" "$classifier_backup"
fi
mv "$classifier_stage" "$classifier_target"
trap - EXIT

if [[ -f "$config_path" ]]; then
  config_backup="$agent_dock_home/backups/config-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$config_backup"
  chmod 700 "$agent_dock_home/backups" "$config_backup"
  cp "$config_path" "$config_backup/router.toml"
  chmod 600 "$config_backup/router.toml"
  AGENT_DOCK_CONFIG="$config_path" node dist/src/index.js migrate-config
fi

install_link() {
  local target="$1"
  local link="$2"
  if [[ -L "$link" && "$(readlink "$link")" == "$target" ]]; then
    return
  fi
  if [[ -e "$link" || -L "$link" ]]; then
    print -u2 "Refusing to overwrite existing path: $link"
    exit 1
  fi
  ln -s "$target" "$link"
}

install_link "$project_dir/bin/agent-dock.js" "$local_bin/agent-dock"
install_link "$project_dir/bin/codex.js" "$local_bin/codex"

activation_backup="$agent_dock_home/backups/install-$(date +%Y%m%d-%H%M%S)"
for shell_file in "$HOME/.zprofile" "$HOME/.zshrc"; do
  if [[ ! -f "$shell_file" ]]; then
    continue
  fi
  mkdir -p "$activation_backup"
  chmod 700 "$agent_dock_home/backups" "$activation_backup"
  cp "$shell_file" "$activation_backup/${shell_file:t}"
  chmod 600 "$activation_backup/${shell_file:t}"
  /usr/bin/perl -0pi -e 's{(?:^|\n)\Q# >>> agent-dock >>>\E\n.*?^\Q# <<< agent-dock <<<\E\n?}{}gms' "$shell_file"
  printf '\n%s\n' \
    '# >>> agent-dock >>>' \
    'path=("$HOME/.local/bin" ${path:#$HOME/.local/bin})' \
    'typeset -U path PATH' \
    'export CODEX_CLI_PATH="$HOME/.local/bin/agent-dock"' \
    '# <<< agent-dock <<<' >> "$shell_file"
done

launchctl setenv CODEX_CLI_PATH "$local_bin/agent-dock"
print "Agent Dock is installed. Open a new shell; restart Desktop once to activate it."
