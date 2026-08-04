# M4X 插件版系统：设备到手前的集成记录

> 状态：**调研完成，实施明确延后至 M4 实机到手后。** 本文不代表已经刷机、安装插件或实现
> `agent-dock-island.m4x`。

## 结论

用户提供的 `crosspoint插件版支持微信读书/` 不是单一阅读插件，而是一套：

```text
原厂 M4 系统
  ↕ 由原厂“升级 / 切换系统”入口切换（具体底层分区机制未验证）
CrossPoint 插件版系统（含 M4X Runtime）
  ├─ 本地阅读器能力
  ├─ 微信读书.m4x
  ├─ 番茄小说.m4x
  └─ 未来：agent-dock-island.m4x
```

因此，第一版 Island 的设备侧首选形态是一个 **M4X 插件应用**，不是重新做一套只有宠物的 M4
固件。阅读、微信读书、番茄小说和 Island 是 CrossPoint 系统内并列的应用；打开 Island 时它充当
桌面摆件，退出后仍可继续阅读。

## 本地证据与已确认事实

本次只读检查的来源是仓库根目录的 `crosspoint插件版支持微信读书/`。该目录是用户提供的外部
固件包，不是 Agent Dock 的运行时依赖，也不应因为本文而自动纳入提交或发布物。

| 证据 | 已确认事实 | 对 Island 的意义 |
| --- | --- | --- |
| 本机包内的 `使用说明.txt` | 要求将 `firmware.bin` 放入 SD 卡根目录、在原厂系统中升级，再从 `apps_inbox/` 安装插件；文中还说明可“切换系统 / 返回原固件”。 | 用户体验上存在原厂系统与 CP 系统的切换路径。底层是否是双分区、双固件或其他启动机制尚未验证。 |
| `firmware.bin` | 二进制字符串包含 `CrossPoint`、`Lua 5.4`、`M4xInstall`、`M4xRuntime` 与 `AppRuntime`。 | 这是带 Lua / M4X 应用运行时的 CP 固件，而不只是一个阅读文件。 |
| `apps_inbox/weread.m4x` 与 `fanqie.m4x` | 两个文件均为有效 ZIP 包，包内有 `manifest.json` 与 Lua 源码；完整性测试无压缩错误。 | `.m4x` 是可安装应用的交付格式。 |
| 两个 `manifest.json` | 都声明 `display`、`input`、`filesystem.appdata`、`network` 权限。 | Island 有显示、输入、本地配对数据与联网所需的最小权限模型。 |
| 插件源码 | 已实际使用 `sys.load`、`sys.millis`、`sys.exit`、`gui.*`、`fs.*`、`net.connectSaved`、`net.request`；入口包含 `init`、`draw`、`onKey`、`onTouch`。 | 可以实现前台 Island 页面、静态墨水屏渲染、本地设置和 Wi-Fi 拉取。 |

`weread.m4x` 和 `fanqie.m4x` 的 SHA-256 已在本机调研时记录并校验；它们只用于识别本次查看的
样本，不构成安全签名或供应链认证。

## 两阶段路线

### 阶段 1：把 M4 变成可扩展阅读器

设备到手后，先用该包声明的受支持路径验证：

1. 备份阅读数据与 SD 卡内容。
2. 确认实机型号、当前系统、恢复方式和该 `firmware.bin` 的兼容性。
3. 用 SD 卡和原厂系统的“升级”入口安装 CP 插件版系统。
4. 连接 Wi-Fi，安装微信读书、番茄小说，并验证阅读、退出、回原系统和数据保留行为。

这一步是设备验证，不是 Agent Dock 开发。说明文件声称“返回原固件不删数据”，但该声明尚未经过
实机验证，因此备份是前置条件。

### 阶段 2：加入 Agent Dock Island

在阶段 1 的 M4X Runtime 上制作并安装：

```text
agent-dock-island.m4x
  ├─ manifest.json
  ├─ main.lua             # init / draw / input 生命周期
  ├─ pairing.lua          # 设备配对与 Token 的 appdata 存储
  ├─ transport.lua        # Wi-Fi 拉取已脱敏的状态快照
  └─ renderer.lua         # 静态宠物帧与刷新冷却
```

Mac 端同时扩展现有 `src/island/` Module。Island Core 继续把 Codex Hook、Router Decision Feed 等输入
归约为一个 `IslandSnapshot`；M4X 插件只是其一个 Output Adapter 的设备侧实现，而不是新的顶层产品
Module。

## 推荐的通信模型：Wi-Fi 拉取

现有插件已证明的是 **Wi-Fi 客户端 HTTP 请求**：`net.connectSaved` 接入保存的网络，`net.request`
发起 GET / POST。没有从样本中确认下列能力：监听入站端口、注册 CrossPoint Web Server 路由、常驻后台
任务、WebSocket 或插件层 BLE 接口。

因此第一版采用这个 Interface：

```text
M4X Island 插件（前台）
  ── GET，带配对 Token ──> Mac 的独立 Island 设备端点
  <── 小型 IslandSnapshot ──
  → 仅在可见状态变化时刷新电子纸
```

- M4 主动拉取，避免假设插件可以运行网络服务器。
- 初始轮询间隔、Wi-Fi 重连和电子纸刷新冷却留给实机测量；不在没有设备时承诺具体秒数。
- Mac 端必须是单独、显式启用且已配对的设备 Interface；**不能**把现有只绑定 `127.0.0.1` 的
  Control Module 直接暴露到局域网。
- 设备包只包含 `state / changedAt / expiresAt` 等展示状态；不包含 prompt、回答、命令、工具输入输出、
  transcript、cwd 或密钥。

BLE 不是第一版依赖：样本展示的是 Wi-Fi 访问能力，而非 BLE 插件 Interface。未来若实机发现原生
BLE Adapter 且它能提供更好的离线配网或直连体验，可作为第二个 Adapter；Island Core 的 Interface
无需改变。

## Island Module 的接口取舍

Island 保持一个深 Module：调用者只产生事件或读取状态，复杂的去重、优先级、冷却和设备细节留在
Implementation 内。

```ts
accept(event: IslandEvent): Promise<void>;
snapshot(): IslandSnapshot;
```

M4X 路线新增的 **Seam** 位于 `IslandSnapshot` 与设备展示之间：

```text
Island Core
  → M4X Wi-Fi Output Adapter
  → 设备专属、拉取式 DeviceSnapshot
  → agent-dock-island.m4x
```

这个 Adapter 负责配对、Token 校验、设备离线、轮询、缓存和过期处理；Router、Gateway、Codex Hook 和
其他输出都不需要知道 M4 的插件格式或网络细节。这种 Interface 能让未来的 Mac Pet、M4X 插件和其他
设备共享同一 Island 状态机，并保持 Locality。

## 已知限制与到手后验证清单

| 项目 | 当前结论 | 实机必须验证 |
| --- | --- | --- |
| 系统切换 | 说明文件描述原厂 / CP 系统切换。 | 实际恢复路径、是否影响用户数据、是否可逆。 |
| 插件安装 | M4X 包和运行时证据充分。 | 该固件版本是否与实机 M4 匹配，安装是否成功。 |
| Wi-Fi | 插件可连接已保存网络并发出 HTTP 请求。 | Mac 与设备同网时的发现、断线重连、功耗与稳定性。 |
| 后台运行 | 未确认。 | Island 退出、锁屏、休眠、阅读时是否仍会执行。第一版按“前台摆件应用”设计。 |
| 入站 HTTP / WebSocket | 未确认。 | 不作为第一版前提。 |
| BLE | 未观察到插件层 BLE Interface。 | 仅在后续需要配网或无 Wi-Fi 直连时评估。 |
| 电子纸刷新 | 样本代码刻意避免重复刷新相同画面。 | 实测全刷 / 局刷、残影、刷新冷却与续航。 |
| 包安全性 | 提供了二进制、Lua 插件和说明，但没有构建来源或可验证签名。 | 刷机前备份、确认来源、评估是否在可接受信任范围内。 |

## 实施前的停止点

在以下条件全部满足前，不开始设备端代码或刷机：

- M4 已到手，并确认它是与包匹配的型号；
- 用户数据已备份，且恢复原系统的步骤已实际确认；
- CP 系统、微信读书和番茄小说插件在实机上正常工作；
- 已确认 M4X Runtime 的版本、前台生命周期和 Wi-Fi 行为；
- 用户明确同意对设备进行升级或刷机。

在此之前，Agent Dock 只保留文档与与设备无关的 Island 设计；不向设备写入文件、不调用刷机工具，也不把
任何设备故障接入 Router 的同步数据路径。
