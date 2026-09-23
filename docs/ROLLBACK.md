# Rollback

Agent Dock 的入口、配置与 OpenCodex Gateway 都可分别停用或回滚。

## 暂时绕过

单次 CLI：

```bash
AGENT_DOCK_BYPASS=1 /opt/homebrew/bin/codex
```

全局暂停：在菜单栏点击“暂停”，或把 `~/.agent-dock/router.toml` 中的 `enabled = true` 改为 `false`。运行中的 Router 会从下一次请求开始直通，无需重启 Desktop。

如果已启用 OpenCodex Gateway，先恢复原生连接：

```bash
ocx restore
```

这会保留 OpenCodex 安装和后台进程，只取消 Codex 的 Gateway 指向。菜单栏中的“恢复原生”执行同一操作；新启动的 Codex 会话生效。

## 完全停用透明入口

1.5.0 应用包包含停用脚本，默认只预览，退出 Agent Dock 后加 `--confirm` 才执行：

```bash
runtime="$HOME/Applications/Agent Dock.app/Contents/Resources/runtime"
"$runtime/node_modules/node/bin/node" "$runtime/deactivate.mjs"
"$runtime/node_modules/node/bin/node" "$runtime/deactivate.mjs" --confirm
```

安装在 `/Applications` 时相应修改 `runtime`。脚本撤销属于本应用的命令链接、旧版 shell 受管块和 Desktop 激活变量；标准本机 OpenCodex 连接先执行 `ocx restore`。保留 Jev Key、供应商配置和所有任务数据；不会结束 Codex 任务。完成后重启 Codex。再次打开 Agent Dock 会重新激活它；永久卸载可以在停用后移走 App。

如果自定义了 OpenCodex 端口或 Codex 配置目录，应先在菜单栏恢复原生连接，再停用。出现不属于 Agent Dock 的入口时脚本不删除它。

旧源码安装也可以手动恢复：

1. 从 `~/.zprofile` 和 `~/.zshrc` 删除 `# >>> agent-dock >>>` 到 `# <<< agent-dock <<<` 的受管块。
2. 删除仅属于本项目的两个 symlink：`~/.local/bin/codex`、`~/.local/bin/agent-dock`。
3. 执行 `launchctl unsetenv CODEX_CLI_PATH`，再重启 Desktop。

Shell 修改前的本机备份在 `~/.agent-dock/backups/`。不要直接覆盖整个 shell 文件，除非确认安装后没有其他用户改动。
