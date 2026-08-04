# Agent Dock

一个供个人本机使用的 Agent Dock。当前实现包含 Codex 透明路由器、OpenCodex Gateway 管理和 Island（中转岛）事件流；后续可由 Island 接入 Mac 宠物与墨水屏输出。正常使用方式不变：

- Desktop：照常点击 ChatGPT / Codex 图标。
- CLI：照常输入 `codex`。
- 每个 `turn/start`：自动选择 `model`、`effort` 和 `fast`。
- 每次决策额外识别 `ask / do / continue / control / unknown`，只用于本地展示与审计，不参与档位选择，也不注入模型上下文。
- 终端和 Desktop 请求在本轮路由决策产生后，由菜单栏 App 在屏幕顶部短暂显示 `[intent] [route]`；不等待 Codex 回答，也不向 Codex TUI 或 Codex Desktop 对话中插入消息。

Router 不修改原始 prompt，不改变权限、sandbox 或工具配置；embedding、线性分类头或代理发生错误时原样直通 Codex。

## 默认路由

| Route | Model | Effort | Fast |
| --- | --- | --- | --- |
| `quick` | `gpt-5.6-luna` | `low` | `true` |
| `balanced` | `gpt-5.6-terra` | `max` | `false` |
| `deep` | `gpt-5.6-sol` | `high` | `false` |
| `max` | `gpt-5.6-sol` | `xhigh` | `false` |

`fast = true` 在 App Server 协议中写成 `serviceTier = "priority"`；`false` 写成 `null`，恢复默认速度层。

配置文件是 `~/.agent-dock/router.toml`。可以修改：

- `[routing.category_routes]`：问题类型对应哪个 Route。
- `[routes.*]`：Route 对应的模型、推理强度、是否 Fast。
- `[routing.complexity_routes]`：复杂度是否自动升级。
- `[routing.controls]`：手动升一档、最高档和恢复自动的完整消息触发词。
- `[classifier]`：本地 embedding 模型、运行时线性头目录、超时和保活时间。

运行中的 Router 会在每个新 `turn/start` 前比较配置文件和三个分类头的 metadata；只有它们发生变化时才重新加载。因此 Router 开关、模型、推理强度和 Fast 修改会从下一次请求开始生效，不需要重启 Desktop。

## 工作方式

1. 先处理不可学习的硬控制：Router 开关、CLI 显式模型、手动升档/拉满/恢复自动、明确“不要路由”和内部协议上下文。
2. 正常请求只发送到 loopback Ollama 的 `qwen3-embedding:0.6b`，生成 1,024 维向量；不再调用 2B 生成式模型。
3. 三个本地 multinomial logistic-regression 线性头直接预测 `intent / category / complexity`；仓库发布副本位于 `resources/router/classifier-v1/`，安装后以 owner-only 权限复制到 `~/.agent-dock/classifier-v1/`。
4. `category + complexity` 通过 TOML 确定性映射为 Route；`intent` 仍只用于展示和审计。
5. 分类器冷启动、超时、模型不匹配或产物损坏时不回退到旧语义规则，而是原样直通 Codex；精确续话在已有 task 路由时可沿用 sticky state。
6. 代理只改 App Server 的 `turn/start.params.model / effort / serviceTier`；如果有 `collaborationMode`，同步其 model/effort 设置。

详细设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
四档下一版策略见 [docs/ROUTING-STRATEGY.md](docs/ROUTING-STRATEGY.md)（仅提案，未改变当前行为）。
回滚方式见 [docs/ROLLBACK.md](docs/ROLLBACK.md)。
当前结构、三个功能 Module 与 Island 后续演进见 [docs/MODULE-PLAN.md](docs/MODULE-PLAN.md)（目录已落地；不包含新的 Island / Pet 行为）。
Hook 如何驱动 Island、如何避免宠物高频动作，以及 CodeIsland 可借鉴的边界见
[docs/ISLAND-IMPLEMENTATION.md](docs/ISLAND-IMPLEMENTATION.md)（设计文档，尚未实现）。
M4X 插件版系统的调研、两阶段设备路线与实机到手前的停止点见
[docs/M4X-PLUGIN-INTEGRATION.md](docs/M4X-PLUGIN-INTEGRATION.md)。

## 本机路径

- 源码：当前 Git clone 所在目录（不依赖固定路径）
- 命令：`~/.local/bin/agent-dock`、`~/.local/bin/codex`
- 配置：`~/.agent-dock/router.toml`
- 发布分类头：`resources/router/classifier-v1/{intent,category,complexity}.json`
- 运行时分类头：`~/.agent-dock/classifier-v1/{intent,category,complexity}.json`
- 审计日志：`~/.agent-dock/events.jsonl`（当前文件最大 30MB，保留 1 份 `.1` 备份）
- 展示事件流：`~/.agent-dock/decision-feed/`（每次触发一个原子事件，最多保留 200 条；按请求到达时间排序）

审计日志是 Codex 会话 JSONL 的轻量路由索引：只保存 `thread_id`、prompt hash、意图、实际档位、原因、分类器状态和延迟；不保存 prompt 明文、category、complexity、cwd、实际 model/effort 或工具记录。完整对话事实仍由 `~/.codex/sessions/` 保存。

1.3 继续使用审计 schema v3；正常分类记录 `classifier_model / classifier_kind / ai_status / ai_latency_ms`，硬控制不写这些可选字段。历史日志无需迁移，也不会被安装脚本改写。

## 管理命令

```bash
agent-dock doctor
agent-dock classify --json "先检查当前仓库，不要修改"
agent-dock control-server
AGENT_DOCK_BYPASS=1 codex
```

## macOS 菜单栏底座

`apps/macos/AgentDockBar` 是同仓库内的原生 SwiftUI + AppKit 菜单栏控制面。它通过只绑定
`127.0.0.1:47831` 的 Control API：

- 即时启用或暂停自动路由；Router 进程保持透明直通，不做启停抖动。
- 编辑每个档位的模型、推理强度和 Fast / priority tier；模型切换时按 OpenCodex catalog 自动收窄到受支持的 effort，并禁用不支持的 Fast。
- 读取 OpenCodex 模型、provider 与能力清单，并在原生 Codex 与 OpenCodex Gateway 之间显式切换；Gateway 未接管时第三方模型会标记为“已配置，当前不可用”。
- 通过“配置供应商…”调用 `ocx gui` 打开本机 OpenCodex Dashboard；供应商、账号、密钥和模型发现仍由 OpenCodex 管理。
- 让 Control Module 校验并原子替换 TOML；Swift App 不直接解析或改写配置文件。
- 显示最近一次实际触发的 Codex 会话标题、Desktop/Terminal 来源和本地时间；会话信息按事件里的精确 `threadId` 从 Codex App Server 只读查询，不复制 prompt 或会话正文。

```bash
pnpm build
pnpm build:macos
pnpm run:macos

# 生成无需完整 Xcode 的本地开发 App bundle
pnpm bundle:macos

# 日常只启动正式安装副本
open "$HOME/Applications/Agent Dock.app"
```

开发 bundle 放在 SwiftPM 的隐藏 `.build` 目录，仅用于安装或打包，不与正式副本同时启动。日常使用的唯一副本位于 `~/Applications/Agent Dock.app`。

菜单栏 App 会按需启动 `agent-dock control-server`；子进程同时监测父 App，异常退出后也会自动回收。Router 与档位修改从下一次请求生效。Gateway 切换会修改 Codex 的连接配置，只影响新启动的 Codex 会话：启用时先让 OpenCodex 通过健康检查，再执行 `ocx restore back`；恢复原生时执行 `ocx restore`，OpenCodex 可继续在后台待命。

“配置供应商…”与“启用 Gateway”是两个独立动作。由于上游 `ocx gui` 在代理未运行时会自动启动并注入 Gateway，Control Module 会记住点击前的 routed 状态；如果原来走原生，Dashboard 打开后会稳定执行 `ocx restore`，确保配置动作本身不改变数据路径。

OpenCodex 的安装、版本、运行和 routed 状态由菜单栏实时检测，不在源码文档中固化本机快照。本地 bundle 使用 ad-hoc 签名；正式分发、自动更新和 notarization 不属于当前底座。

显式传入 `codex -m ...`、`--oss`、`--local-provider` 或 `--remote` 时，CLI 尊重用户选择并绕过自动路由。

## 安装与升级

前置条件是 Node.js 22+、pnpm、Ollama，以及仓库声明的 embedding 模型：

```bash
ollama pull qwen3-embedding:0.6b
./scripts/local/install.sh
pnpm bundle:macos
```

安装脚本直接使用仓库内 `resources/router/classifier-v1/` 的三个已验证线性头，将它们以 owner-only 权限原子复制到 `~/.agent-dock/`，并从新模板创建配置。安装不读取训练工作区、历史会话或审计 JSONL。

本地重新训练并验证新分类头后，可以临时通过 `AGENT_DOCK_CLASSIFIER_SOURCE=/absolute/path` 安装候选产物；只有明确发布的新版本才应替换仓库内的默认 bundle。

## 开发验证

```bash
pnpm install
pnpm check
pnpm build
./scripts/local/install.sh
```

测试覆盖发布分类头及其校验和、embedding 线性头合同、硬护栏、长对话续路由、prompt 不变、配置热加载与 sticky state、乱序展示事件、逐会话并发转发、Control API 原子写入、会话元数据、Gateway Adapter、Desktop stdio 代理和 CLI WebSocket 代理。

## 源码结构

```text
src/
├── router/                         # 一个 Router Module
│   ├── core/                       # 分类、硬控制、配置、档位映射、审计和热加载
│   └── adapters/                   # App Server、stdio/WS、CLI 与 Codex 进程 Adapter
├── gateway/                        # OpenCodex Gateway Interface 与 Adapter
├── island/                         # 中转岛：当前为只读 Decision Feed，后续承接宠物/设备输出
├── app/                            # 共用 composition / 入口层，不是产品功能 Module
│   ├── control/                    # 本地 Control Interface、配置写入与编排
│   └── cli/                        # doctor、CLI 分流与 control-server 命令
└── index.ts                        # 唯一 composition root

apps/macos/AgentDockBar/Sources/AgentDockBar/
├── Models/
├── Services/
├── ViewModels/
└── Views/Components/

tools/training/
├── src/        # 私有数据准备、历史规则基线和可复现实验
├── python/     # CPU 训练与验证
└── work/       # Git ignored 的 prompt、embedding、模型和报告

resources/router/
├── classifier-v1/  # 可安装的已验证分类头与 manifest
└── router.toml.example

scripts/
├── local/install.sh
└── macos/          # bundle、icon 构建脚本

test/
├── router/  gateway/  island/  app/  integration/
└── fixtures/
```

面向产品能力的顶层 Module 只有三个：`router/`、`gateway/`、`island/`。`app/` 与 `index.ts`
是共用编排与入口，不是第四项产品能力；Pet 未来是 `island/` 内的一种输出，而非新的顶层 Module。

## 已知边界

- Desktop 使用 `CODEX_CLI_PATH` 选择 Agent Dock executable。这是当前 Desktop 本地实现支持的入口，但不是公开稳定配置；Desktop 升级后运行 `agent-dock doctor` 和协议 smoke test。
- 交互式 CLI 使用当前 Codex 官方 `--remote` 入口和一个仅绑定 `127.0.0.1` 的临时 WebSocket；每个 CLI 会话一个代理进程，不开放常驻端口。
- `codex exec PROMPT` 可以在启动前路由；从 stdin 才读取 prompt 的 `codex exec -` 保持直通，避免代理吞掉管道输入。
- Router 的 embedding 分类、模型产物、配置重载和审计都保持 fail-open。OpenCodex 一旦被选为网络 Gateway，就是实际数据路径依赖；崩溃时无法在单个已启动会话内无损切回。当前缓解方式是启用前健康检查、明确状态提示，以及一键 `ocx restore` 恢复原生连接。
