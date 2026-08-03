# Agent Dock 模块结构与后续演进

> 状态：**当前工作区已完成 Router、Gateway、Island 的物理目录整理，尚未提交或推送；没有改变既有运行行为。**
>
> 本文记录现在的仓库结构与后续 Island 演进。已实现的运行合同仍以
> [ARCHITECTURE.md](./ARCHITECTURE.md) 为准。

## 结论

面向产品能力，Agent Dock 只有三个顶层 **Module**，每项能力各占一个顶层目录：

1. `src/router/`：为 Codex Desktop / CLI 的每个回合选择路由参数。
2. `src/gateway/`：管理 OpenCodex Gateway 的状态、切换与模型能力。
3. `src/island/`：中转 Agent 的只读事件，并在后续将状态发布到 Mac 宠物或墨水屏。

这里的 **Island（中转岛）不是 Pet**。Pet 只是 Island 的一个未来输出形态；Island 同时负责
事件输入、状态收敛、去重/限流和设备 Adapter，因此未来不会再创建独立的 `src/pet/` 顶层
Module。

`src/app/` 与 `src/index.ts` 是共用的本机编排和入口；它们不承载第四项产品
能力。

```mermaid
flowchart LR
  Desktop["Codex Desktop / CLI"] --> Router["Router Module\nsrc/router/"]
  Router --> Codex["Codex App Server"]
  Router -. "异步、只读事件" .-> Island["Island Module\nsrc/island/"]

  Shell["Agent Dock Bar\napps/macos/"] --> Control["Control\nsrc/app/control/"]
  Control --> Router
  Control --> Gateway["Gateway Module\nsrc/gateway/"]
  Control --> Island

  Island -. "后续输出" .-> Pet["Mac Pet"]
  Island -. "后续 Wi-Fi Adapter" .-> Eink["M4 墨水屏"]
```

## 当前仓库结构

```text
apps/
  macos/AgentDockBar/             # 共用 macOS 菜单栏 App Shell
bin/                              # npm 可执行入口
docs/                             # 运行合同、策略、回滚与本文件
resources/
  router/                         # Router 默认配置与发布分类头
scripts/
  local/                          # 本机安装脚本
  macos/                          # App bundle 与图标构建脚本
src/
  router/                         # 功能 1：Router
    core/                         # 分类、配置、审计、热加载、路由判断
    adapters/                     # Desktop stdio、CLI WebSocket、Codex 协议/进程
  gateway/                        # 功能 2：Gateway
  island/                         # 功能 3：Island；当前实现 Decision Feed
  app/                            # 共用 composition / 入口层，不是产品能力 Module
    control/                      # 本机 Control Interface 与配置写入
    cli/                          # 共用命令入口
  index.ts                        # composition root
test/
  router/ gateway/ island/ app/ integration/
tools/
  training/                       # 离线训练与验证工具；work/ Git ignored
```

根目录中的 `apps/`、`resources/`、`scripts/`、`test/`、`tools/` 只按运行位置和用途分类；
产品能力的归属始终以 `src/router/`、`src/gateway/`、`src/island/` 为准。

## 当前三个 Module

### Router Module — `src/router/`

Router 对调用者的主 **Interface** 是：

```ts
routeTurn(params: TurnStartParams): Promise<RouteDecision>
```

`core/` 和 `adapters/` 是同一个 Module 内的 Implementation 分层，不是两项能力：

- `core/` 负责路由判断、配置、分类器、审计、热加载和协议无关类型；
- `adapters/` 负责接住 Desktop / CLI 的不同协议，并只写入允许修改的路由字段。

Router 的不变量不变：不改写 prompt、权限、sandbox 或工具配置；分类、审计、Island 事件写入和
热加载失败都 fail-open。

### Gateway Module — `src/gateway/`

Gateway 封装 OpenCodex 的探测、启动、路径切换、恢复和模型能力发现。它的已有 **Interface** 为：

```ts
snapshot(config): Promise<GatewaySnapshot>
setRouted(routed, config): Promise<void>
openDashboard(config): Promise<void>
```

Gateway 不修改 Router 的路由判断；供应商、账号、密钥和 provider-specific 配置仍由 OpenCodex
持有。Gateway 未启用或故障时，不阻塞原生 Router。

### Island Module — `src/island/`

当前 Island 的 Implementation 是目录型 Decision Feed：Router 异步发布经过本地展示筛选的决策，
Control 与菜单栏只读获取。它不读取或保存 prompt、工具历史或会话正文，也不能反向阻塞 Router。

未来 Island 在不改变 Router / Gateway Interface 的前提下扩展为：

```text
src/island/
  decision-feed.ts       # 已实现：Router 决策的只读事件中转
  core/                  # 后续：Island 状态机、去重、刷新冷却
  inputs/                # 后续：Decision Feed、Codex Hooks Adapter
  outputs/               # 后续：Mac Pet、M4 Wi-Fi / 墨水屏 Adapter
```

Pet 是 `outputs/` 的一个渲染目标：它把 Island 状态显示成角色行为。M4 是另一个输出 Adapter：
它只接收已收敛的状态快照，不直接订阅 Codex 请求，也不要求 Router 等待设备刷新。

## 共用层与失败隔离

| 位置 | 角色 | 不能承担的职责 |
| --- | --- | --- |
| `src/app/control/` | loopback HTTP Interface、配置原子写入、组合各 Module 状态 | 不重新实现 Router、Gateway 或 Island 规则 |
| `src/app/cli/`、`src/index.ts` | 命令和进程入口 | 不持有产品业务状态 |
| `apps/macos/AgentDockBar/` | 共用菜单栏 UI / HUD | 不直接读写配置、不会实现设备协议 |

- Island 异常、Mac 宠物异常、设备离线或 Hooks 失败：Router 继续透明工作。
- Control 进程离线：Router 继续按本地配置工作；菜单栏显示离线状态。
- Gateway 只在用户显式启用且健康时进入数据路径；未选择时不影响原生 Codex。

## 后续顺序

1. [x] 整理仓库层级、`src/` 目录与测试目录；提取 Router、Gateway、Island 三个顶层 Module。
2. [ ] 为 Island 增加独立状态快照、优先级、去重和墨水屏刷新冷却；先只消费现有 Decision Feed。
3. [ ] 增加 Mac Pet 输出，用于调试 Island 状态和动画节流。
4. [ ] 设备到手后确认协议和刷新能力，再增加 M4 Wi-Fi / 墨水屏输出 Adapter。

第 2–4 步都不得把 Pet 或设备故障接入 Router 的同步数据路径。

## 本轮确认项

- [ ] 认可三个功能 Module 的名字：`router`、`gateway`、`island`。
- [ ] 认可 Pet 是 Island 的输出，不创建独立 `src/pet/` 顶层目录。
- [ ] 认可 `app/control` / `app/cli` 是共用编排与入口，而非第四项功能。
- [ ] 确认将当前重命名、目录整理和本文档一起提交并推送；不包含 Island 新行为或设备实现。
