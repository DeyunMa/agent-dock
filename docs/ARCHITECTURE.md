# Architecture

## 设计原则

- Transparent Proxy：用户入口、task、历史、prompt、权限和工具行为保持不变。
- Fail Open：分类、配置、日志、Ollama 失败都不能阻断 Codex。
- Hybrid Decision：确定性护栏优先，本地小模型只处理模糊部分。
- Per Turn：长对话中的每个 `turn/start` 都可得到不同参数。
- Local Only：Ollama 和 CLI 代理仅使用 loopback；无需额外 API key。

```mermaid
flowchart LR
  U["用户正常使用"] --> D["Desktop Adapter<br/>stdio"]
  U --> C["CLI Adapter<br/>temporary WebSocket"]
  D --> P["Protocol Router"]
  C --> P
  P --> E["Router Core"]
  E --> R["版本化加权规则<br/>硬护栏"]
  E --> Q["Ollama Qwen3.5 2B<br/>语义与复杂度"]
  E --> M["TOML Route Mapping"]
  D -. "surface=desktop" .-> V["Decision Feed"]
  C -. "surface=terminal" .-> V
  V --> HUD["菜单栏 App 原生 HUD"]
  P --> A["真实 Codex App Server"]
  A --> N["Native OpenAI"]
  A -. "显式启用" .-> G["OpenCodex Gateway<br/>第三方模型 Adapter"]
  UI["Swift 菜单栏"] --> CTL["Control Module<br/>loopback HTTP"]
  CTL --> T["原子 TOML 配置"]
  CTL --> G
  T -. "文件变化时热加载" .-> E
```

## Module 与 Interface

核心 Module 是 `RouterEngine`，对外只有一个主要 Interface：

```ts
routeTurn(params: TurnStartParams): Promise<RouteDecision>
```

它隐藏规则评分、Ollama 超时、复杂度合并、task sticky state、模型目录校验和审计。协议 Adapter 不理解业务分类，只消费 `RouteDecision`。

`RouteDecision.intent` 是独立的观测字段：`ask / do / continue / control / unknown`。它不会进入档位计算，也不会写入 prompt、additional context 或任何 agent-visible 字段；CLI、菜单栏和本地审计只展示 `[intent] [route]`。

请求来源由 Transport Adapter 显式标记为 `desktop / terminal / management`，不通过进程列表猜测当前前台应用。终端和 Desktop Adapter 在收到本轮 `turn/start` 时先记录 `triggeredAt`，路由决策产生后立即异步写入目录型 `Decision Feed`；每个事件独立原子落盘，包含 cursor、surface、threadId、意图和档位，最多保留 200 条。菜单栏 App 用 `GET /v1/decisions?after=...` 增量轮询并显示原生 HUD，不等待 Codex 回答完成。

Feed 按请求到达时间而不是分类完成时间排序：较早请求即使晚完成，也不能覆盖较新的会话。菜单栏状态需要标题时，Control Module 只拿事件中的精确 `threadId` 调 Codex `thread/read(includeTurns=false)`；标题、preview 和 cwd 不写入 Feed 或审计日志。Feed、元数据查询和 HUD 都是 fail-open 的观测能力，不进入 Router Core、Codex 协议或模型上下文。

`ReloadingRouterEngine` 是 Router Core 前的配置 Adapter。每个 turn 只做本地文件 metadata 比较；文件未变化时不解析 TOML、不访问 Gateway、不进行网络健康检查。文件变化时先完整解析和校验，再替换当前 `RouterEngine`；task sticky state 由独立、有限容量的 `RouterSessionState` 持有，配置替换不会丢失续话状态，且续话会重新解析当前 Route profile。Ollama 配置未变化时复用已预热的分类器；失败由 `ProtocolRouter` 原样直通。

Transport 使用逐 `threadId` 的顺序队列：同一 task 的消息保持顺序，不同 task 和全局 JSON-RPC 控制消息可绕过一个正在等待分类的慢请求。最终写入 App Server 仍经单一写队列串行化，避免字节交叉。

菜单栏的 Control Module 是另一条独立 Interface：

```text
GET  /v1/status
GET  /v1/decision
GET  /v1/decisions?after=:cursor&limit=:n
PUT  /v1/router/enabled
PUT  /v1/routes/:name
PUT  /v1/gateway/routed
POST /v1/gateway/dashboard
```

它是配置写入和 Gateway 生命周期的唯一 owner。`LocalOpenCodexGatewayAdapter` 负责 OpenCodex 健康检查、模型发现、`ocx restore / restore back` 和 Dashboard 唤起；这些操作不会进入 Router Core 的 per-turn Interface。

`GET /v1/status` 的 Gateway snapshot 同时保留兼容用的模型 ID 数组，并提供标准化 `modelCatalog`：provider、是否依赖 Gateway、支持的 reasoning effort、默认 effort 与 service tier。Control Module 在写入 Route 前再次校验这些能力；Swift UI 只负责展示和选择，不维护 provider-specific 能力表。

供应商、账号、密钥和 provider-specific 配置不属于 Router Module。菜单栏只跨过 Dashboard Seam 调用 `ocx gui`，不读取或复制 OpenCodex 的 provider schema。因为上游命令在冷启动时会顺带注入 Codex，Adapter 会保存并恢复调用前的 routed 状态，使“配置 Gateway”与“启用 Gateway”保持正交。

两个外部 Seam：

- Desktop Seam：`CODEX_CLI_PATH` -> `codex-router ... app-server ...` -> bundled Codex stdio。
- CLI Seam：`~/.local/bin/codex` -> 临时 loopback WebSocket -> system Codex App Server stdio。

## 决策优先级

1. Router disabled、CLI 显式模型、本地 provider 或显式 remote：直通。
2. 明确关闭 Router：直通，且不使用 sticky route。
3. Router/Hook/Agent 双信号硬规则：`AGENT_WORKFLOW`。
4. 版本化加权规则集。
5. Qwen 输出；只有规则 abstain 时才允许它决定 category。
6. 确定性复杂度与 Qwen 复杂度合并。Qwen 只能上调一级，不能单独选择 `extreme/max`。
7. category Route 和 complexity Route 取配置顺序中较强者。
8. 服务端模型目录不支持该 model/effort 时直通。

## 协议不变量

仅处理 `method === "turn/start"` 的 JSONL / WebSocket text message。除以下字段外保持消息不变：

```text
params.model
params.effort
params.serviceTier
params.collaborationMode.settings.model
params.collaborationMode.settings.reasoning_effort
```

`params.input` 不做删除、拼接、重写或注入。其他 JSON-RPC 请求和服务端响应原样转发。

## 生命周期

- Desktop：随 Desktop 的 App Server 子进程启动/退出。
- CLI：每个交互会话启动一个 Router、一个本机临时 WS listener 和一个 App Server；会话退出全部回收。
- Ollama：Homebrew service 共享；Router 启动时后台预热，保活 30 分钟。
- 首次冷启动：不让首轮排队等待模型，直接使用规则结果；预热完成后后续 turn 启用 AI。
- 配置：Control Module 原子替换 TOML；运行中的 Router 在下一次 turn 热加载。
- Gateway：默认保持原生 Codex。只有用户显式启用且 OpenCodex 健康时才切换；Gateway 配置变化需要重开 Codex 会话。

## Fail-open 的边界

Router Core 对规则、Ollama、审计和热加载错误均 fail-open，原始 JSON-RPC 消息会字节级直通。Control Module 离线也不影响数据面。

OpenCodex 被启用后位于 Codex 与上游 provider 之间，属于真正的数据面依赖，因此不能承诺 Gateway 崩溃时当前会话完全无感。当前 Interface 通过启用前健康检查、状态轮询和显式“恢复原生”降低风险，但不把这个风险伪装成 Router fail-open。

## 审计日志

`~/.codex/router/events.jsonl` 是全局 Router 的轻量决策索引，不是第二份会话记录。它通过 `thread_id + prompt_hash + triggered_at + timestamp` 与 Codex 的完整会话 JSONL 关联，只记录来源、意图、实际 Route、Fast、原因和耗时。

Prompt 明文、cwd、实际 model/effort、回答和工具调用仍由 Codex 会话记录管理；category 与 complexity 仅服务于当前 Router 内部计算。这些字段均不写入审计索引或模型上下文。分类器失败时只记录状态和延迟，便于定位超时；意图结果不参与授权或模型档位计算。

日志单文件最大 30MB，超过后将当前文件滚动为 `events.jsonl.1`，只保留这一份历史备份。
