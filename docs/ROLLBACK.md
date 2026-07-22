# Rollback

本次安装没有删除旧 Hook 源文件，所有入口都可单独回滚。

## 暂时绕过

单次 CLI：

```bash
CODEX_ROUTER_BYPASS=1 /opt/homebrew/bin/codex
```

全局暂停：在菜单栏点击“暂停”，或把 `~/.codex/router/router.toml` 中的 `enabled = true` 改为 `false`。运行中的 Router 会从下一次请求开始直通，无需重启 Desktop。

如果已启用 OpenCodex Gateway，先恢复原生连接：

```bash
ocx restore
```

这会保留 OpenCodex 安装和后台进程，只取消 Codex 的 Gateway 指向。菜单栏中的“恢复原生”执行同一操作；新启动的 Codex 会话生效。

## 恢复旧分类 Hook

迁移前完整配置在：

```text
~/.codex/router/backups/user-prompt-router-20260721-pre-router/hooks.json
```

恢复前先比较当前 `~/.codex/hooks.json`，避免覆盖迁移后新增的其他 Hook。旧源文件仍在 `~/.codex/hooks/user-prompt-router/`。

## 完全停用透明入口

1. 从 `~/.zprofile` 和 `~/.zshrc` 删除 `# >>> codex-router >>>` 到 `# <<< codex-router <<<` 的受管块。
2. 删除仅属于本项目的两个 symlink：`~/.local/bin/codex`、`~/.local/bin/codex-router`。
3. 执行 `launchctl unsetenv CODEX_CLI_PATH`，再重启 Desktop。

Shell 修改前的本机备份在 `~/.codex/router/backups/system-activation-20260721-pre-router/`。不要直接覆盖整个 shell 文件，除非确认安装后没有其他用户改动。
