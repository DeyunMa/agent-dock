# 四档路由策略提案（讨论稿）

> 状态：仅方案，尚未修改当前 `quick / balanced / deep / max` 的运行逻辑。

## 结论

保留四档作为用户可理解的控制面，但不要继续把“档位”直接等同于“单个模型”。下一版更合适的结构是：

```text
任务分类 + 复杂度
        ↓
用户档位（质量 / 延迟 / 成本预算）
        ↓
候选模型池 + 能力约束
        ↓
选择一个模型交给 Codex
        ↓
Gateway 负责供应商连接、密钥和同模型端点容灾
```

Router 仍然只决定每个 turn 的 `model / effort / serviceTier`，不接管 API key、供应商协议或请求转发。这样能保持 Router 与 OpenCodex 的责任边界。

## 当前四档的主要限制

1. 每档只绑定一个模型，模型上下线或能力变化后需要人工重配。
2. `routeOrder` 把模型能力、推理强度、延迟和价格压成了一条“更强”轴；现实中这些维度并不总是同向。
3. `deep` 与 `max` 目前可以只是同一模型的 effort 差异，无法表达“单模型深思考”与“多模型编排”是两类完全不同的计算方式。
4. `fast` 是一个布尔值，只表达 Codex 的 priority service tier，不能表达“低延迟优先但不一定购买 priority”或预算上限。
5. 当前只有路由决策日志，没有任务结果反馈，因此不能可靠地自动学习哪类任务由哪个模型完成得更好。

## 可借鉴的设计

### OpenRouter：候选池、约束和连续权衡

OpenRouter Auto Beta 的核心不是固定四档，而是先做细粒度任务分类，再按近期真实使用信号排序候选模型，应用 `allowed_models` 与 cost/quality 参数，最后形成主模型与 fallback 列表；同一 session 还会保持 model/provider stickiness。Provider Routing 则单独处理端点顺序、fallback、价格、吞吐、延迟和数据策略。

对本项目最有价值的不是照搬其云端排名数据，而是两个边界：

- Router 选择“哪类模型 / 哪个候选模型”；Gateway 选择“这个模型走哪个 provider endpoint”。
- 用户档位应该表达策略目标，并允许一个受控候选池，而不是永久绑定一个模型 ID。

参考：[OpenRouter Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router)、[OpenRouter Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection)。

### Sakana Fugu：复杂任务才值得进入编排

Sakana Fugu 不是普通的单次模型选择器。官方描述的是一个小型协调模型动态选择多个模型、分配角色、拆分子任务并组合结果；Fugu Mini 偏延迟，Fugu Ultra 偏复杂任务性能。其 TRINITY 研究进一步使用 Thinker / Worker / Verifier 角色进行多轮协调。

这类设计不适合直接放进本地 Router 的每个 turn：它会增加延迟、成本、失败面，也会越过当前“只改路由字段”的透明代理边界。更合理的做法是把 Fugu 一类编排系统视为 `max` 档可选的一个模型端点，由 Gateway 提供；Router 不自己实现多 Agent 编排。

参考：[Sakana Fugu](https://sakana.ai/fugu-beta/)、[TRINITY](https://sakana.ai/trinity/)、[Sakana API 使用说明](https://console.sakana.ai/get-started)。

## 推荐的四档语义

| 档位 | 用户意图 | 默认选择策略 | 建议约束 |
| --- | --- | --- | --- |
| `quick` | 最低等待时间 | 小而快、工具调用可靠的模型 | `low/medium` effort；可启用 Fast；不进入编排模型 |
| `balanced` | 日常默认 | 在质量、延迟和成本之间取稳定解 | 允许 2–3 个候选；优先已有会话模型以复用上下文缓存 |
| `deep` | 单模型高质量推理 | 选择能力匹配任务类型的强模型 | `high/xhigh`；容忍更高延迟；仍保持单模型 turn |
| `max` | 结果优先 | 最强单模型或显式编排端点 | 允许 `max/xhigh`、长超时和高成本；必须由用户或极端复杂度触发 |

关键点：四档名称可以不变，但每档内部应是 `policy + candidates + constraints`。

## 建议的配置形态

以下只是方向示例，不是已承诺的 schema：

```toml
[routes.balanced]
objective = "balanced"
models = ["provider/model-a", "provider/model-b"]
effort = "high"
fast = false
sticky = true

[routes.max]
objective = "quality"
models = ["provider/frontier", "sakana/fugu-ultra"]
effort = "xhigh"
fast = false
allow_orchestrator = true
```

选择器应先过滤 Codex `model/list` 中不可用或不支持 effort 的模型，再按本地静态能力标签选择。没有可靠结果数据前，不建议做“自学习 Router”；否则会把主观猜测包装成自动优化。

## 推荐实施顺序

1. 先补观测：记录候选集、最终选择、模型不可用原因和用户手动改档，不记录 prompt 明文。
2. 再把单模型配置兼容扩展为候选池；旧 `model = "..."` 继续可用。
3. 增加按任务类别的静态能力标签与稳定 fallback，不先引入在线学习。
4. 有足够真实样本后，再评估成本 / 延迟 / 成功率评分。
5. 最后才考虑把 Fugu 一类编排端点放入 `max` 候选池；不在本地 Router 内复制其多 Agent 系统。

## 讨论前需要确定的三个产品选择

1. 四档首先优化的是质量、延迟，还是 API 成本？三者需要明确优先级。
2. `balanced/deep` 是否允许自动跨供应商换模型，还是只在用户选定的模型家族内调整？
3. 长对话是“整段 task 固定模型”，还是只有短续话 sticky、出现新任务信号后允许重选？
