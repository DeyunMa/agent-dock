# Architecture

当前实现版本：`1.4.0`，配置 schema v3。

## 设计原则

- Transparent Proxy：不改用户 prompt、权限、sandbox 或工具配置，只改路由字段。
- First Turn Only：每段对话仅首次有效用户请求自动选档，随后持久化沿用。
- Three Tiers：quick（Terra/low/Fast）、balanced（Sol/high）、deep（Astra/xhigh）。
- Jev API：只向官方 HTTPS endpoint 发送首次输入、候选模型配置及职责描述。
- Virtual Model：在 App Server `model/list` 响应中注册 `jev-router`（显示名 `Jev Router`）。它只表示用户选择自动模式，不是可调用的生成模型。
- Fail Open：分类器、状态存储、配置与观察系统异常不能阻断 Codex。
- Gateway 仍管理生成模型的供应商和认证；Jev 决策 API 凭据由 Router 专用凭据文件负责。

## 决策流程

1. Router disabled / CLI 显式模型直通；完整消息手动控制优先处理。
2. 内部协议上下文、空输入与明确禁用使用硬护栏。
3. 读取 `thread-routes/<sha256(threadId)>.json`；存在则直接复用实际 profile，不调用 Jev。
4. 恢复或派生已有历史的对话，无本地记录时保留当前 profile，不补做自动选档。
5. 原子 hard-link 占位（已完整写入的 inode）确保多进程只允许一次首轮调用；其他进程有界等待结果。同 task 在进程内串行，不同 task 独立。
6. Jev 一次返回两个 Choice：route（三档）、intent（只观察）。明确描述每档任务职责，模型名不作为推测能力的依据。输入是待分类数据，不能覆盖分类规则。
7. 用户选择真实模型时请求原样直通；选择 `jev-router` 时，协议 Adapter 在转发前替换为已固定或新选出的真实 profile，并在返回给 UI 时恢复虚拟显示名。
8. 验证 schema、合法选项、概率范围及分布、模型目录后持久化实际模型/effort/Fast，再修改协议字段。
9. 请求默认 2500ms 超时，不重试；首轮失败持久化当前 profile 或直通标记，后续不再次请求。不按未经校准的 confidence 阈值猜测升级。

## 状态与隐私

状态不含 prompt 或密钥。目录 0700、文件 0600，task ID 哈希为文件名，写入原子替换。记录没有 LRU 淘汰，避免旧 task 再被当作首轮；随 task 保留。遗留 pending 占位有界等待后直通，不自动重新申请；用户可明确“恢复自动”重置。

Jev key 从 `TYPESAFE_API_KEY` 或 owner-only `classifier.api_key_file` 读取，每次首轮读取以支持轮换。重定向拒绝，endpoint 固定为 `https://api.typesafe.ai`，错误不记录响应正文、密钥或用户文本。环境 key 不传给 Codex 子进程。

最多发送默认 12,000 字符；长输入保留首尾。原始转发输入不截断。之后的用户消息不会再发送 Jev。后续 HUD 的 intent 只能显示显式续话或 unknown，不能伪装为再次分类的结果。

## 手动控制与热加载

“加强一点”和“拉满”是用户显式改变档位的例外；“恢复自动”删除当前记录，允许下一有效请求重新选档。档位修改只影响新 task，现有 task 保存完整 profile，不跟随同名配置变化。Router 开关即时生效。

`ReloadingRouterEngine` 只检查 TOML metadata；classifier 或 routes 改变时重建 JevClassifier。warmup 是无网络的空操作。已退役线性头移至 `tools/training/resources/classifier-v1/`，历史训练工具使用独立的 v2 合同，生产不导入它们。

## Transport 与协议不变量

Desktop 和 CLI Adapter 都把来源显式标记为 `desktop / terminal / management`，不通过进程列表猜测前台应用。同一 `threadId` 的消息保持顺序，不同 task 不会被一个慢 Jev 请求串行阻塞。

数据面路由只改 `turn/start` 的以下字段：

```text
params.model
params.effort
params.serviceTier
params.collaborationMode.settings.model
params.collaborationMode.settings.reasoning_effort
```

`params.input` 不做删除、拼接、重写或注入。控制面另外拦截 `model/list`、线程启动/恢复响应以及 model 配置读写，用于显示虚拟模型并持久化自动／手动模式；虚拟 ID 必须在真实 App Server 边界前还原。

## Island 与 Control Module

Router Adapter 在本轮决策产生后立即异步写入 `src/island/` 持有的目录型 Decision Feed；菜单栏 App 通过 `GET /v1/decisions?after=...` 增量读取并显示原生 HUD，不等待 Codex 回答。Island 另有已实现、尚未接入常驻运行时的状态 Core 与 Decision Feed Input；未来仅由 M4 连接异步消费其状态快照。

Control Module 是配置写入与本机 HTTP 编排入口；Gateway Module 自己封装 OpenCodex 生命周期：

```text
GET  /v1/status
GET  /v1/decision
GET  /v1/decisions?after=:cursor&limit=:n
PUT  /v1/router/enabled
PUT  /v1/routes/:name
PUT  /v1/gateway/routed
POST /v1/gateway/dashboard
```

供应商、账号、API Key 和 provider-specific 配置属于 OpenCodex。菜单栏只通过 Dashboard seam 调用 `ocx gui`，不读取或复制 Gateway 配置。

## 生命周期和 fail-open

- Desktop：随 Codex App Server 子进程启动/退出。
- CLI：每个交互会话启动一个 Router、一个临时 loopback WebSocket 和一个 Codex App Server。
- Jev：启动不发请求、不计费；只有首轮发送一次请求，默认 2.5 秒超时，无重试。
- 配置：Control Module 原子替换 TOML；下一次 turn 热加载。
- Gateway：只有用户显式启用且 OpenCodex 健康时才切换。

Router Core 对 Jev API、路由状态、审计、展示和热加载错误均 fail-open。OpenCodex 被启用后则是真正的数据面依赖，不能承诺其崩溃时当前会话无损切回。

## 审计日志

`~/.agent-dock/events.jsonl` 是轻量决策索引，不是第二份会话记录。schema v3 只记录来源、`thread_id`、prompt hash、意图、实际 Route、Fast、原因、分类器状态和耗时。

Prompt 明文、cwd、实际 model/effort、回答和工具调用仍由 Codex 会话 JSONL 管理；category 与 complexity 不进入审计或模型上下文。1.4 使用 `classifier_kind = "jev_api"`，不改变历史事件的可读性，也不要求迁移旧 JSONL。
