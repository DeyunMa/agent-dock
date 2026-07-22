#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h:h}"
router_home="$HOME/.codex/router"
local_bin="$HOME/.local/bin"

cd "$project_dir"
pnpm install --frozen-lockfile
pnpm check
pnpm build

mkdir -p "$router_home" "$local_bin"
chmod 700 "$router_home"
if [[ -f "$router_home/router-rules.json" ]] && \
   ! cmp -s "$project_dir/resources/router-rules.json" "$router_home/router-rules.json"; then
  rules_backup="$router_home/backups/rules-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$rules_backup"
  chmod 700 "$router_home/backups" "$rules_backup"
  cp "$router_home/router-rules.json" "$rules_backup/router-rules.json"
  chmod 600 "$rules_backup/router-rules.json"
fi
cp "$project_dir/resources/router-rules.json" "$router_home/router-rules.json"
if [[ ! -f "$router_home/router.toml" ]]; then
  cp "$project_dir/resources/router.toml.example" "$router_home/router.toml"
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
