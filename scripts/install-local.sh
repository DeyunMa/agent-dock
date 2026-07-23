#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h:h}"
router_home="$HOME/.codex/router"
local_bin="$HOME/.local/bin"
classifier_source="${CODEX_ROUTER_CLASSIFIER_SOURCE:-$project_dir/resources/classifier-v1}"
classifier_target="$router_home/classifier-v1"

cd "$project_dir"
pnpm install --frozen-lockfile
pnpm check
pnpm build

mkdir -p "$router_home" "$local_bin"
chmod 700 "$router_home"
if [[ ! -f "$router_home/router.toml" ]]; then
  cp "$project_dir/resources/router.toml.example" "$router_home/router.toml"
fi

for model_file in intent.json category.json complexity.json; do
  if [[ ! -f "$classifier_source/$model_file" ]]; then
    print -u2 "Missing classifier artifact: $classifier_source/$model_file"
    print -u2 "Restore resources/classifier-v1 or set CODEX_ROUTER_CLASSIFIER_SOURCE."
    exit 1
  fi
done

classifier_stage="$(mktemp -d "$router_home/.classifier-v1.XXXXXX")"
trap 'rm -rf "$classifier_stage"' EXIT
chmod 700 "$classifier_stage"
for model_file in intent.json category.json complexity.json; do
  cp "$classifier_source/$model_file" "$classifier_stage/$model_file"
  chmod 600 "$classifier_stage/$model_file"
done
if [[ -d "$classifier_target" ]]; then
  classifier_backup="$router_home/backups/classifier-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$router_home/backups"
  chmod 700 "$router_home/backups"
  mv "$classifier_target" "$classifier_backup"
fi
mv "$classifier_stage" "$classifier_target"
trap - EXIT

if [[ -f "$router_home/router.toml" ]]; then
  config_backup="$router_home/backups/config-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$config_backup"
  chmod 700 "$router_home/backups" "$config_backup"
  cp "$router_home/router.toml" "$config_backup/router.toml"
  chmod 600 "$config_backup/router.toml"
  CODEX_ROUTER_CONFIG="$router_home/router.toml" node dist/src/index.js migrate-config
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

install_link "$project_dir/bin/codex-router.js" "$local_bin/codex-router"
install_link "$project_dir/bin/codex.js" "$local_bin/codex"

activation_backup="$router_home/backups/install-$(date +%Y%m%d-%H%M%S)"
for shell_file in "$HOME/.zprofile" "$HOME/.zshrc"; do
  if [[ ! -f "$shell_file" ]] || grep -q '^# >>> codex-router >>>$' "$shell_file"; then
    continue
  fi
  mkdir -p "$activation_backup"
  chmod 700 "$router_home/backups" "$activation_backup"
  cp "$shell_file" "$activation_backup/${shell_file:t}"
  chmod 600 "$activation_backup/${shell_file:t}"
  printf '\n%s\n' \
    '# >>> codex-router >>>' \
    'path=("$HOME/.local/bin" ${path:#$HOME/.local/bin})' \
    'typeset -U path PATH' \
    'export CODEX_CLI_PATH="$HOME/.local/bin/codex-router"' \
    '# <<< codex-router <<<' >> "$shell_file"
done

launchctl setenv CODEX_CLI_PATH "$local_bin/codex-router"
print "Codex Router is installed. Open a new shell; restart Desktop once to activate it."
