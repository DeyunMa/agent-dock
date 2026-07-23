# AGENTS.md

## 仓库定位

- 本仓库实现个人本机使用的 Codex 透明路由器，以及原生 macOS 菜单栏控制面。
- `docs/ARCHITECTURE.md` 是当前已实现架构的合同；`docs/ROUTING-STRATEGY.md` 在状态明确变更前仅是下一版讨论稿；`README.md` 说明用户入口和本机运行方式。

## 开始工作前

- 先检查 `git status --short`，再读取与任务直接相关的源码、测试和上述事实文档。
- 搜索文件和文本优先使用 `rg` / `rg --files`。
- 判断行为时以当前代码和测试为准，不把讨论稿、历史日志或本机运行快照当成已实现事实。

## 代码边界

| 路径 | 职责 |
| --- | --- |
| `src/routing/` | embedding 分类、硬控制、模型档位、审计和热加载 |
| `resources/classifier-v1/` | 随版本发布、可直接安装的三个线性分类头及 manifest |
| `local-training/` | 私有数据准备、训练、历史规则基线和模型验证；`work/` 不属于运行时或发布资源 |
| `src/transport/` | Codex App Server 协议、stdio/WebSocket Adapter 和进程边界 |
| `src/presentation/` | 只读决策事件流；不得阻塞或改变路由数据面 |
| `src/control/` | 本机 Control API、原子配置写入和 Gateway 生命周期 |
| `macos/CodexRouterBar/` | SwiftUI/AppKit 菜单栏、HUD 和控制面 |
| `test/` | 与上述模块对应的合同、并发和回归测试 |

## 必须保持的不变量

- 保持透明代理：不得改写原始 prompt、权限、sandbox 或工具配置；协议修改只限架构文档声明的路由字段。
- `intent` 只用于本地展示和审计，不得影响档位、授权或模型上下文。
- 规则、分类器、审计、事件展示和热加载失败时必须 fail-open；Control Module 离线不得影响 Router 数据面。
- Router 只决定 `model`、`effort` 和 `serviceTier`；供应商、API Key、协议转换及同模型端点容灾属于 Gateway。
- 保持修改最小且聚焦，不回退或覆盖用户的无关改动；不要仅因目录审美进行搬迁。

## 文件与运行边界

- 不直接编辑 `dist/`、SwiftPM `.build/`、已安装的 App bundle 或 `~/.codex/router/` 下的运行数据；修改源码或生成脚本后重新构建。
- `.serena/` 是本地分析工具元数据，不属于项目源码，不得纳入提交。
- 不提交凭据、API Key、会话正文、prompt 明文或其他本机敏感数据。
- `local-training/work/` 始终保持 Git ignored；只允许把明确通过验证的三个线性头提升到 `resources/classifier-v1/`，提升时同步 manifest、README、架构合同和 bundle 回归测试。

## 验证

| 修改范围 | 最低验证 |
| --- | --- |
| TypeScript | `pnpm check`、`pnpm build` |
| 发布分类头或安装脚本 | `pnpm check`、`pnpm build`、`./scripts/install-local.sh`、`codex-router doctor` |
| Swift/macOS | `pnpm build:macos`，并运行受影响的 TypeScript 验证 |
| 文档或规则文件 | `git diff --check`，并复读变更后的合同是否自洽 |

- 提交前运行 `git diff --check`，检查完整 staged diff，并确认没有本机生成物。
- 无法运行某项验证时，明确说明原因和残余风险。

## Git 身份与提交

- 本仓库提交必须使用 repository-local 身份：`DeyunMa <121009814+DeyunMa@users.noreply.github.com>`。
- 提交前确认 `git config --local user.name` 为 `DeyunMa`，`git config --local user.email` 为 `121009814+DeyunMa@users.noreply.github.com`；不得回退到全局 `DeyunMa-1` 身份。
- 只有用户明确要求时才创建 commit 或 push；不要把“修改完成”自动解释为允许推送。
