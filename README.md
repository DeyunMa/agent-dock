# Agent Dock

一个供个人本机使用的 Agent Dock。当前实现包含 Codex 透明路由器、OpenCodex Gateway 管理和 Island（中转岛）事件流；后续由 Island 将脱敏状态连接到 M4 墨水屏。正常使用方式不变：

- Desktop：照常点击 ChatGPT / Codex 图标。
- CLI：照常输入 `codex`。
- 每段对话仅首次请求调用 Jev API，选择并持久化 `model`、`effort` 和 `fast`；后续沿用，不自动切换。
- Codex 模型菜单会显示 `Jev Router`：选择它才进入自动模式；选择任何真实模型均为手动模式，Agent Dock 原样尊重。
- 首轮决策额外识别 `ask / do / continue / control / unknown`，只用于本地展示与审计，不参与档位选择，也不注入模型上下文。
- 终端和 Desktop 请求在本轮路由决策产生后，由菜单栏 App 在屏幕顶部短暂显示 `[intent] [route]`；不等待 Codex 回答，也不向 Codex TUI 或 Codex Desktop 对话中插入消息。

Router 不修改原始 prompt，不改变权限、sandbox 或工具配置；Jev API、路由状态存储或代理发生错误时原样直通 Codex。

## 默认路由

| Route | Model | Effort | Fast |
| --- | --- | --- | --- |
| `quick`（轻量） | `gpt-5.6-terra` | `low` | `true` |
| `balanced`（标准） | `gpt-5.6-sol` | `high` | `false` |
| `deep`（深入） | `gpt-6-astra` | `xhigh` | `false` |

`fast = true` 在 App Server 协议中写成 `serviceTier = "priority"`；`false` 写成 `null`，恢复默认速度层。

配置文件是 `~/.agent-dock/router.toml`。可以修改：

- `[routes.*]`：三档的模型、推理强度和 Fast。
- `[routing.controls]`：手动升档、拉满和重置首轮选择的完整消息触发词。
- `[classifier]`：Jev 模型、密钥文件、请求超时（默认 2.5 秒）、输入字符预算。
- `[routing.state_directory]`：按 task 持久化的档位快照，不含 prompt 或密钥。

配置热加载只影响新对话；已有对话保留实际模型、effort 和 Fast 的首次快照。开关仍即时生效。

## 工作方式

1. Router 开关、CLI 显式模型、手动控制和明确禁用优先处理。
2. 首次请求将用户输入、三档模型配置及职责描述发到 `https://api.typesafe.ai/v1/systemone`；不发送会话历史。超长输入保留首尾，总字符预算默认 12,000。
3. Jev 一次回答 `route` 和独立展示字段 `intent`；程序验证选项、概率和模型目录后应用选择。
4. `~/.agent-dock/thread-routes/` 保存每段对话的首次选择。原子占位防止多进程重复调用；进程重启、热更新和后续复杂度变化均不自动重新路由。
5. `model/list` 返回前注册 UI 专用的 `jev-router`；发往 Codex 后端前必须还原成真实模型。自动／手动选择与实际 profile 分开保存，虚拟模型 ID 不进入生成请求。
6. 首次超时、认证失败或无效响应时直通，不重试；同一对话随后沿用原模型。恢复/派生已有历史但无本地记录的对话也直通，不补做首轮判断。崩溃留下的占位不会自动重试。
7. 只有用户明确发送“加强一点”“拉满”才手动改变档位；“恢复自动”显式清除当前记录，下一次有效请求重新选择。
8. 只修改 App Server 的 `model / effort / serviceTier` 及 collaboration settings 中对应字段；原始输入、权限、工具和 sandbox 保持不变。

详细设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 可选的 Jev Skill 提示 Hook

`agent-dock user-prompt-submit-hook` 是独立于 Router 的 Codex `UserPromptSubmit` command hook。启用后，它在每次提交用户消息时读取本轮 prompt 和 Codex 本地 Skill 的名称、描述，调用 Jev 独立判断用户是否留下会影响结果的选择，并给 Skill 排序；最多取四个做相关性与关系核对，再通过 `additionalContext` 给 Codex 一条简短提示。Skill 分数不设固定准入阈值，四个是提示长度上限。即使没有合适 Skill，明确未决的选择仍可得到提示。Codex 应依据现有目标和约束判断能否代选；缺少必要偏好时再询问。Hook 不自动加载 Skill、不改原始 prompt、不决定任务完成度，也不改变路由、权限或工具调用。缺密钥、无可用提示、超时或响应无效时静默通过。

菜单栏弹窗分为 Router（含模型档位）、Hook、Gateway 三个横向切换的模块，一次只显示当前模块。顶部左右箭头切换，齿轮菜单控制哪些模块参与切换；显示偏好保存在本机，并至少保留一个模块。Router 和 Hook 各显示最近五条记录，可在各自区域翻页。Hook 每次有效提交只在本机保存时间、会话/项目标识、候选 Skill 名称及关系、是否产生提示；包括未产生提示的提交，不保存 prompt、Skill 路径或密钥。它显示的是 Hook 的本地输出摘要，不保证 Codex Desktop 把 hook 结果渲染成聊天消息，也不证明 agent 最终使用了 Skill。Router 的原有事件流仍供 HUD 消费，菜单栏只读取其中最近五条。

候选目录覆盖当前仓库从工作目录到仓库根的 `.agents/skills`、`~/.agents/skills` 和 `/etc/codex/skills`；跳过在 Codex 配置中禁用或标记 `allow_implicit_invocation: false` 的 Skill。插件 Skill 和 Codex 内置 Skill 目前不在扫描范围内，因此提示是补充而非完整目录。超过 128 个本地 Skill 时静默通过，避免只检查不完整的目录。

Hook 复用 `[classifier]` 的 Jev 模型、超时、输入上限和密钥文件。`TYPESAFE_API_KEY` 不会从 Agent Dock 传给 Codex 后端，所以由 Agent Dock 启动的 hook 通常从 owner-only `classifier.api_key_file` 读取密钥；单独启动 Codex 且显式设置该环境变量时仍可使用它。与只发送首轮输入的 Router 不同，启用此 hook 后每次用户提交的 prompt（最多 `[classifier].max_chars`，默认 12,000 字符）及本地 Skill 描述都会发往 `api.typesafe.ai`。程序不记录这些明文。

全局启用当前开发构建：先运行 `pnpm build`，再运行 `node scripts/local/install-user-prompt-hook.mjs --dry-run` 检查范围，最后运行 `node scripts/local/install-user-prompt-hook.mjs`。脚本只向用户级 `~/.codex/hooks.json` 追加一个 `UserPromptSubmit` handler，保留其他 hook，并把旧文件备份到 `~/.codex/backups/`。新 handler 使用当前仓库的构建产物；移动或删除仓库后，需要重新安装 hook。正式 App 包含本功能后，可参照 [resources/hooks/user-prompt-submit.hooks.json](resources/hooks/user-prompt-submit.hooks.json) 把此 handler 的命令替换为 `~/.local/bin/agent-dock`，不要再追加第二个 Agent Dock handler。Codex 可能要求信任审核或重启后才启用新 hook。`additionalContext` 属于附加开发者上下文，会影响 Codex 后续决策，但不会改写用户原始消息。

旧四档讨论稿 [docs/ROUTING-STRATEGY.md](docs/ROUTING-STRATEGY.md) 已被当前三档实现取代。
回滚方式见 [docs/ROLLBACK.md](docs/ROLLBACK.md)。
当前结构、三个功能 Module 与 Island 后续演进见 [docs/MODULE-PLAN.md](docs/MODULE-PLAN.md)（Island Core 已落地；M4 实机连接尚未实现）。
Hook 如何驱动 Island、如何合并高频事件并为 M4 生成稳定状态，以及 CodeIsland 可借鉴的边界见
[docs/ISLAND-IMPLEMENTATION.md](docs/ISLAND-IMPLEMENTATION.md)（Hook Input 和 M4 设备连接尚未实现）。
M4X 插件版系统的调研、两阶段设备路线与实机到手前的停止点见
[docs/M4X-PLUGIN-INTEGRATION.md](docs/M4X-PLUGIN-INTEGRATION.md)。

## 本机路径

- 源码：当前 Git clone 所在目录（不依赖固定路径）
- 命令：`~/.local/bin/agent-dock`、`~/.local/bin/codex`
- 配置：`~/.agent-dock/router.toml`
- Jev 密钥：`~/.agent-dock/credentials/jev-api-key`（0600；目录 0700），也可使用 `TYPESAFE_API_KEY`
- 首轮路由记录：`~/.agent-dock/thread-routes/`（无正文，仅模型档位快照）
- 审计日志：`~/.agent-dock/events.jsonl`（当前文件最大 30MB，保留 1 份 `.1` 备份）
- 展示事件流：`~/.agent-dock/decision-feed/`（每次触发一个原子事件，最多保留 200 条；按请求到达时间排序）

审计日志是 Codex 会话 JSONL 的轻量路由索引：只保存 `thread_id`、prompt hash、意图、实际档位、原因、分类器状态和延迟；不保存 prompt 明文、category、complexity、cwd、实际 model/effort 或工具记录。完整对话事实仍由 `~/.codex/sessions/` 保存。

1.4 继续使用审计 schema v3；正常分类记录 `classifier_model / classifier_kind / ai_status / ai_latency_ms`，硬控制不写这些可选字段。历史日志无需迁移，也不会被安装脚本改写。

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
- 编辑每个档位的模型、推理强度和 Fast / priority tier；模型切换时按 Codex `model/list` 自动收窄到受支持的 effort，并禁用不支持的 Fast。
- 模型选择与 Codex 返回的可见目录同步，优先使用运行中桌面的实际列表；没有桌面观察时，通过同一 Codex 程序读取当前配置并标注来源。已配置但不在列表中的档位保留并标记不可用。刷新按钮重新同步，不结束当前会话。
- 通过“配置供应商…”调用 `ocx gui` 打开本机 OpenCodex Dashboard；第三方供应商、账号和密钥仍由 OpenCodex 管理；Agent Dock 不把它的目录当作 Codex 的完整目录。
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

菜单栏 App 会按需启动 `agent-dock control-server`；子进程同时监测父 App，异常退出后也会自动回收。开关从下一请求生效，档位修改仅影响新对话。Gateway 切换会修改 Codex 的连接配置，只影响新启动的 Codex 会话：启用时先让 OpenCodex 通过健康检查，再执行 `ocx restore back`；恢复原生时执行 `ocx restore`，OpenCodex 可继续在后台待命。

“配置供应商…”与“启用 Gateway”是两个独立动作。由于上游 `ocx gui` 在代理未运行时会自动启动并注入 Gateway，Control Module 会记住点击前的 routed 状态；如果原来走原生，Dashboard 打开后会稳定执行 `ocx restore`，确保配置动作本身不改变数据路径。

OpenCodex 路由状态同时识别传统 `/v1` 和启用 Codex context relay 后的 `/backend-api/codex` 注入路径；两者都必须与配置的本机 Gateway origin 完全一致。

OpenCodex 的安装、版本、运行和 routed 状态由菜单栏实时检测。1.5.0 内部应用包内置固定版本 OpenCodex；仍采用 ad-hoc 签名，尚无 Developer ID 公证及自动更新。

显式传入 `codex -m ...`、`--oss`、`--local-provider` 或 `--remote` 时，CLI 尊重用户选择并绕过自动路由。

## 安装与升级

### 1.5.0 内部应用包

1.5.0 标记从本地 embedding 分类迁移到 Jev 远程决策服务。应用包包含 Node 24.20.0、OpenCodex 2.59.0（及其 Bun 运行时）和 Agent Dock 代码。接收者不需要源码、Node、npm、pnpm 或 Swift 工具链，但需要安装 Codex Desktop 并配置自己的模型账号。

1. 解压对应架构的 ZIP，将 `Agent Dock.app` 放入 `/Applications` 或 `~/Applications`，再打开。不要从压缩包临时目录、DMG 或构建目录运行。
2. 首次启动自动创建配置和指向应用包的命令入口。已有 `router.toml` 原样保留；不会覆盖不属于 Agent Dock 的 CLI。
3. 在菜单栏打开“Jev 服务设置…”，输入个人 Jev Key，保存后点击“测试连接”。支持替换和删除；保存文件权限 0600、目录 0700。Key 不会从状态接口返回，环境变量密钥只能在原启动环境管理。
4. 点击“配置供应商…”打开随包 OpenCodex Dashboard，配置账号；通过 Gateway 开关选择接入。生成模型账号与 Jev Key 是独立凭据。
5. 在合适的工作间隙重启 Codex，然后选择 `Jev Router`。每次登录后先打开 Agent Dock；退出菜单栏不等于停用已激活的代理。

选择自动路由会将首轮文字（默认最多 12,000 字符，超长时保留首尾）与三档模型配置发送到 `api.typesafe.ai`。测试只发固定模拟请求；可能产生少量费用。没有密钥或分类失败时保持直通，不代表自动分类正常。内部使用应遵守组织允许外发的内容范围。

开发机生成分发 ZIP：`rtk proxy pnpm package:macos`。产物位于 `apps/macos/AgentDockBar/.build/releases/`，按本机架构构建，附控制台 SHA-256。包内不带开发者的 Jev Key、供应商账号、配置或对话。OpenCodex 及依赖的原始许可证随 `runtime/node_modules` 保留。

升级时先退出 Agent Dock，替换 App 再打开；保留用户配置。Codex 任务结束后重启以加载新代码。完整停用说明见 [docs/ROLLBACK.md](docs/ROLLBACK.md)。签名、公证和跨机器安装验收仍是扩大分发前的工作。

### 源码开发安装

前置条件为 Node.js 22+、pnpm 和可用 Jev API key。不需要 Ollama 或本地模型。

```bash
rtk proxy python3 scripts/local/set-jev-key.py  # 隐藏输入，不写命令历史
rtk proxy ./scripts/local/install.sh
rtk proxy zsh scripts/macos/install-app.sh
rtk proxy agent-dock doctor
```

安装脚本备份旧 TOML，再迁移到 v3：保留 quick/balanced，将旧 max 合并为 deep，移除本地 embedding 配置。不会安装历史分类头、读取训练数据或更改 Codex 历史。代码升级后需重启 Codex Desktop 一次以加载新版代理；安装不会中断正在运行的 Codex。

`doctor` 会发送一条固定的模拟请求验证 API；`classify` 每次作为独立诊断请求。密钥文件不进入仓库、日志或模型输入，也不会传给 Codex 子进程。

卸载旧 Ollama（会删除其全部模型、应用数据和本机身份文件）：

```bash
rtk proxy python3 scripts/local/uninstall-ollama.py            # dry-run
rtk proxy python3 scripts/local/uninstall-ollama.py --confirm  # 确认范围后执行
```

## 开发验证

```bash
pnpm install
pnpm check
pnpm build
./scripts/local/install.sh
```

测试覆盖 Jev 请求与失败、首轮持久化、跨进程去重、恢复会话、硬护栏、prompt 不变、配置热加载与固定档位、乱序展示事件、逐会话并发转发、Control API 原子写入、会话元数据、Gateway Adapter、Desktop stdio 代理和 CLI WebSocket 代理。

## 源码结构

```text
src/
├── router/                         # 一个 Router Module
│   ├── core/                       # 分类、硬控制、配置、档位映射、审计和热加载
│   └── adapters/                   # App Server、stdio/WS、CLI 与 Codex 进程 Adapter
├── gateway/                        # OpenCodex Gateway Interface 与 Adapter
├── island/                         # 中转岛：状态 Core；后续只连接 M4 墨水屏
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
├── src/        # 历史离线实验（不进入 Router 运行时）
├── resources/classifier-v1/  # 已退役分类头档案
├── python/     # CPU 训练与验证
└── work/       # Git ignored 的 prompt、embedding、模型和报告

resources/router/
└── router.toml.example

scripts/
├── local/install.sh
└── macos/          # bundle、icon 构建脚本

test/
├── router/  gateway/  island/  app/  integration/
└── fixtures/
```

面向产品能力的顶层 Module 只有三个：`router/`、`gateway/`、`island/`。`app/` 与 `index.ts`
是共用编排与入口，不是第四项产品能力；Island 只负责 M4 连接，不创建或控制本地 Mac / Codex 宠物。

## 已知边界

- Desktop 使用 `CODEX_CLI_PATH` 选择 Agent Dock executable。这是当前 Desktop 本地实现支持的入口，但不是公开稳定配置；Desktop 升级后运行 `agent-dock doctor` 和协议 smoke test。
- 交互式 CLI 使用当前 Codex 官方 `--remote` 入口和一个仅绑定 `127.0.0.1` 的临时 WebSocket；每个 CLI 会话一个代理进程，不开放常驻端口。
- `codex exec PROMPT` 可以在启动前路由；从 stdin 才读取 prompt 的 `codex exec -` 保持直通，避免代理吞掉管道输入。
- Router 的 Jev API、状态存储、配置重载和审计都保持 fail-open。OpenCodex 一旦被选为网络 Gateway，就是实际数据路径依赖；崩溃时无法在单个已启动会话内无损切回。当前缓解方式是启用前健康检查、明确状态提示，以及一键 `ocx restore` 恢复原生连接。

macOS 构建使用 `scripts/macos/swift-build.sh`，默认选择本机 macOS 26.5 SDK，避开 CLT 27 缺失 SwiftUI 宏插件的问题；可通过 `AGENT_DOCK_SWIFT_SDK` 显式指定其他完整 SDK，不修改全局 Xcode 选择。

Jev 提问合同参考官方 [Patterns](https://docs.typesafe.ai/patterns) 和 [Confidence](https://docs.typesafe.ai/confidence)：使用有明确职责的有限 Choice，将 route 与观察性 intent 一次独立提问；confidence 只记录，不在缺少校准数据时当作准确率或另设重试门槛。
