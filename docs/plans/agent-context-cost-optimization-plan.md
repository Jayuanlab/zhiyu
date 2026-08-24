# 智能体上下文治理与运行效率优化技术方案

## 1. 背景与纠偏

当前平台的智能体车间、Loop 和 Work Runtime 已具备持续执行能力，但随着历史事件、记忆、数据源、工具和固定规则持续增长，每一轮模型调用都可能携带大量与当前任务无关的信息。

真正急需解决的问题不是“限制成本”，而是“上下文输入不合理”：原始历史、重复记忆、低价值事件、大段数据源正文和过宽工具列表被无差别注入 prompt，导致模型阅读负担变重、响应变慢、判断变散，成本也随之上升。

本方案纠正为以下目标：

- 成本是观测结果，不是任务质量的硬约束。
- 合理上下文的标准是“完成当前目标所需的最小充分观测”，不是越短越好。
- 原始事实必须完整保留；进入 prompt 的只是可解释、可追溯、可按需扩展的投影。
- 对高证据链任务保留 `full` / `audit` 模式，不为了省 token 牺牲目标达成。

本方案继续遵循项目工程原则：

> 先观测，再建模；先闭环，再自动；先边界，再行动；先稳定，再智能。

## 2. 改造目标

主要目标：

- 减少无用信息进入模型上下文，降低模型阅读噪声。
- 把“原始事实存储层”和“prompt 投影层”分开。
- 让每次运行都能看到上下文由哪些段组成、最大段在哪里、工具是否过宽。
- 保留按需读取能力，模型需要原文证据时通过工具读取，而不是默认全塞进 prompt。
- 让 UI 能展示上下文健康度，帮助继续定位冗余来源。

非目标：

- 不做“因为估算费用偏高就停止任务”的硬限制。
- 不把 `cheap` profile 作为全局默认压制复杂任务。
- 不删除、改写或压缩原始事件、原始记忆、外部消息和数据源记录。
- 不因为费用估算降低高证据链任务的上下文深度。

## 3. 控制对象与边界

被控对象：

- Workshop、Loop、Work Runtime 运行前的上下文构造流程。
- 数据源、记忆、事件、指令、工具 schema、固定规则和模型配置进入 prompt 的方式。

观测输入：

- 每次模型调用的 prompt 字符数、估算 token、分段大小、最大上下文段。
- 当前 `contextProfile`、`modelTier`、`toolProfile`、工具数量和运行来源。
- 数据源、记忆、事件、指令、outbox 等各段的选择数量和裁剪结果。

状态存储：

- 原始 facts 仍存放在各自的数据表、事件流和工具可读存储中。
- 每次运行新增 `context_budget_report` 作为上下文观测事件或 trace。
- Dashboard 聚合最近上下文报告，展示上下文规模和热点段。

控制动作：

- 根据任务类型选择 `cheap`、`normal`、`full`、`audit` 上下文 profile。
- 对事件做价值筛选，过滤心跳、普通运行完成、工具大结果和历史 agent 长文本。
- 对数据源默认只注入元信息、摘要、URI、更新时间和质量警告。
- 对记忆默认注入结构化摘要和引用 id，原文通过工具按需读取。
- 对工具使用 `toolProfile` 裁剪，保留显式请求和配置过的工具。

安全边界：

- 原始观测事件、交易记录、外部消息、用户指令和审计事件不被删除或改写。
- 压缩只发生在 prompt 投影层，不改变事实存储层。
- 用户纠错、审核、拒绝、失败、blocked、degraded 等关键信号不能被普通过滤吞掉。
- `denied` 优先于 `allowed`；工具裁剪不能绕过拒绝规则。
- 外部动作、真实资金、发送消息、配置变更仍需审核、事件记录和回滚边界。

## 4. 问题拆解

| 问题 | 现象 | 根因 | 已完成改造 | 下一步 |
| --- | --- | --- | --- | --- |
| 数据源正文默认进入 prompt | sources 可能带入大段正文 | 数据源元信息、摘要、正文未分层 | Workshop prompt 不再默认使用 `source.content`，Loop context 标记 `contentAvailable` | 增加 source digest / source read 按需工具链 |
| 记忆重复注入 | `memoryContext` 与原始 memories 同时出现 | 状态估计层和事实层混在一起 | Loop 不再默认携带 memory 原文；Workshop memory 摘要缩短 | 建立 memory evidence-by-reference |
| 事件历史自我膨胀 | 历史越长 prompt 越重 | recent events 主要按时间截取 | Workshop/Loop 增加 `selectPromptEvents`，过滤低价值事件 | 增加 run_summary / loop_summary 预聚合 |
| 默认读取窗口偏大 | 高频任务也读取大量 sources/events/memories | 缺少任务分档预算 | `normal` 默认上限已下调；Workshop/Loop runtime 读取窗口已收紧 | 基于任务类型自动选择 profile |
| 工具列表过宽 | 模型看到大量无关工具 schema | 工具能力没有按任务暴露 | 增加 `toolProfile`，cheap 只保留核心工具和显式请求工具 | 为每类任务建立工具原因说明 |
| 固定规则长期累积 | 每次都携带一整套规则 | 安全、角色、工具、领域规则未模块化 | 暂未完全解决 | 拆成基础安全规则和按需规则包 |
| 成本叙述偏离主线 | 容易把优化变成费用管控 | 把费用当成控制目标 | 已移除费用驱动的 profile 调整和硬阻断 | 费用只做观测，不做任务目标上限 |

## 5. 目标上下文模型

目标是把每轮输入整理成 `ContextPack`，而不是把历史数据库切片直接拼进 prompt。

```text
ContextPack
  runtimeContext       当前 run、loop、workshop、work 的身份和状态
  missionBoundary      当前目标、denied/allowed、审核要求和控制边界
  selectedSources      数据源摘要、更新时间、质量告警、引用 id
  memoryContext        结构化记忆摘要、置信度、来源 id、更新时间
  recentSignals        经过筛选的失败、纠错、审批、阻塞和关键决策
  activeDirectives     当前有效指令和用户覆盖
  toolProfile          当前可用工具集合和暴露原因
  safetyRules          基础安全规则和按需业务规则
  contextReport        分段字符数、估算 token、最大段、模型和工具 profile
```

关键原则：

- Prompt 是投影，不是事实库。
- 原始事实保留在数据库、事件流和工具可读存储中。
- 模型需要深挖时，通过工具按 source id、memory id、event id 读取。
- `full` / `audit` 用于深度复盘、关键动作和证据链完整场景。

## 6. 已完成改造

### 6.1 上下文观测

已新增 `apps/web/lib/ai/context-budget.ts`：

- 生成 `context_budget_report`。
- 统计 prompt 字符数、估算 token、工具数量、分段大小和最大上下文段。
- 记录 `contextProfile`、`modelTier`、`toolProfile`、运行来源和可选输入价格。
- 该报告只用于观测和复盘，不作为任务硬限制。

Workshop agent run 已写入 `context_budget_report` 事件，并把摘要挂到 `agent_configured` metadata。

Native Loop run 已在 execution trace 中记录 `context_budget_report`；有关联 Workshop 的 Loop 也会写回 Workshop 事件流。

### 6.2 上下文 profile

已新增 `apps/web/lib/ai/context-profile.ts`：

- 支持 `cheap`、`normal`、`full`、`audit`。
- Workshop 默认 `normal`，可通过 `modelConfig.contextProfile` 或 `WORKSHOP_CONTEXT_PROFILE` 覆盖。
- Loop 默认根据 Loop/Workshop 配置解析，可通过 `contextConfig.contextProfile`、`contextConfig.metadata.contextProfile`、Workshop `modelConfig.loopContextProfile` 或 `LOOP_CONTEXT_PROFILE` 覆盖。

当前重点是把 `normal` 收紧为日常任务的合理默认，而不是靠费用估算自动改变任务深度：

```text
normal.promptMaxChars = 16000
normal.loopStateMaxChars = 14000
normal.workshopContextMaxChars = 10000
normal.sourceLimit = 10
normal.memoryRefLimit = 18
normal.directiveLimit = 12
normal.eventLimit = 12
normal.outboxLimit = 5
```

`full` / `audit` 保留较大窗口，用于深度分析、复盘、高风险动作和证据链完整任务。

### 6.3 数据源投影

已调整 `apps/web/lib/workshops/context-window.ts` 和 `apps/web/lib/loops/context-window.ts`：

- Workshop prompt 默认不再把 `source.content` 当作展示文本。
- Loop 注入的 Workshop context 中，source 正文不再进入 prompt，只保留 `contentAvailable`。
- prompt 重点展示 source 类型、名称、URI、更新时间和可追溯信息。

下一步应增加稳定的 source 摘要表或 `sourceDigest`，让模型看到“摘要 + id + 质量状态”，需要原文时再调用读取工具。

### 6.4 记忆投影

已调整 `apps/web/lib/workshops/memory-context.ts` 和 `apps/web/lib/loops/context-window.ts`：

- Loop 注入的 Workshop context 默认不再携带原始 memory 正文。
- memory 只保留 id、kind、confidence、tags、sourceEventIds 和 `contentAvailable`。
- Workshop memory 摘要长度下调：单条 memory 从 900 字符压到 420 字符。
- 默认 core state 从 6 条降到 4 条。
- 默认 task relevant memories 从 12 条降到 8 条。
- risk boundaries / recent lessons 从 8 条降到 5 条。
- evidence refs 从 30 条降到 16 条。
- task intent 摘要从 1200 字符降到 700 字符。

这一步把记忆系统拉回“状态估计器”，避免把历史消息堆积当成智能。

### 6.5 事件选择

已在 Workshop 和 Loop context window 中增加事件选择逻辑：

- 过滤 `context_budget_report` 回流，避免观测事件再次污染 prompt。
- 过滤普通 `run_started`、`run_completed`、`tool_result`、大段 `agent_text`。
- 保留用户纠错、失败、blocked、degraded、审核、拒绝、关键决策和与当前任务相关的信号。

下一步应生成 `run_summary` / `loop_summary`，让旧事件被结构化摘要覆盖，而不是依赖 recent events 长期承载历史。

### 6.6 运行读取窗口

已收紧默认运行加载量：

- Workshop agent 默认读取 sources 20、memories 30、events 50、outbox 10。
- Loop 附带 Workshop context 默认读取 sources 20、memories 30、directives 25、events 40。
- prompt 内最终进入数量再由 `contextProfile` 控制。

这保持了“后台可观测事实足够，进入 prompt 的投影更短”的分层。

### 6.7 工具 profile

已新增 `apps/web/lib/workshops/tool-profile.ts`：

- `normal`、`full`、`audit` 保持原有工具能力，降低行为风险。
- `cheap` 默认只暴露观察、记忆、行情和当前任务显式请求的工具。
- 显式配置工具、action policy 中允许或需要审核的工具、verification required sources 会被保留。
- Workshop MCP 工具会自动补齐 `mcp__workshop-tools__*` alias。
- 仍交给现有 denied 过滤和 harness 特例处理。

这一步减少工具 schema 噪声，同时避免把任务明确需要的工具裁掉。

### 6.8 模型 tier

已新增 `apps/web/lib/ai/model-policy.ts`：

- 支持 `cheap`、`standard`、`review`、`audit`、`vision`。
- Workshop 可通过 `modelConfig.modelTier` 或 `WORKSHOP_MODEL_TIER` 覆盖。
- Loop 可通过 `contextConfig.modelTier`、`contextConfig.metadata.modelTier`、Workshop `modelConfig.loopModelTier` 或 `LOOP_MODEL_TIER` 覆盖。
- 支持 tier 环境变量，例如 `LLM_CHEAP_MODEL`、`LLM_CHEAP_BASE_URL`、`LLM_CHEAP_API_KEY`。

当前定位：模型 tier 是运行配置和任务适配能力，不是费用驱动的任务降档器。高证据链任务应优先保证目标达成。

### 6.9 Dashboard 可观测性

已调整 `apps/web/lib/workshops/dashboard.ts`、`apps/web/lib/work-runtime/queries.ts` 和 `apps/web/app/(chat)/workshop/workshop-client.tsx`：

- Dashboard 聚合最近 `context_budget_report`。
- 展示平均 prompt tokens、估算输入成本、最新 profile、model tier、tool profile 和最大上下文段。
- 页面顶部卡片改为 `Context size`，避免把主线表达成单纯成本控制。

## 7. 当前行为约定

当前实现遵循这些约定：

- `context_budget_report` 是观测信号，不是运行闸门。
- 不存在费用估算自动调整 `contextProfile`。
- `contextProfile` 表示任务上下文深度，不表示花费上限。
- `toolProfile` 只在 `cheap` 下主动收窄；显式请求或配置过的工具会被保留。
- `modelTier` 是可配置路由，不应替代任务目标判断。
- 原始 facts 不被裁剪，只裁剪进入 prompt 的投影。

## 8. 后续改造计划

### Phase A：规则模块化

目标：减少固定规则长期膨胀。

实施内容：

- 拆分基础安全规则、角色规则、工具规则、领域规则和任务规则。
- 基础安全规则常驻。
- 角色和领域规则按 Workshop 类型注入。
- 工具规则按实际暴露工具注入。
- 高风险 action 才注入审核和证据链增强规则。

验收标准：

- 每次 prompt 能解释注入了哪些规则包。
- `denied` 优先规则始终常驻。
- 普通观察任务不携带交易、消息发送、配置变更等无关长规则。

### Phase B：数据源摘要与按需读取

目标：把数据源从“大正文注入”改为“摘要索引 + 原文按需”。

实施内容：

- 为 source 增加可缓存的 `sourceDigest`。
- digest 包含 title、provider、updatedAt、freshness、qualityWarning、summary、schema hint。
- 大网页、大 JSON、大表格默认不进 prompt。
- 增加按 source id 读取原文、分页、字段抽样和 provider 诊断的工具路径。

验收标准：

- 默认 prompt 不包含大段 source 正文。
- 深度分析任务仍能读取原文证据。
- stale、provider 失败、字段缺失会显式显示。

### Phase C：事件摘要层

目标：让长期运行不靠 recent events 承载全部历史。

实施内容：

- 每轮 run 完成后生成短 `run_summary`。
- Loop 定期生成 `loop_summary`，覆盖旧运行细节。
- Workshop 定期生成状态摘要，记录当前目标、未解决阻塞、最近用户纠错和关键决策。
- 旧事件仍可通过工具查询。

验收标准：

- 历史增长不会线性推高 prompt。
- 用户纠错、失败、审核、blocked 仍被保留或进入摘要。
- 摘要带 source event ids，可回溯原始证据。

### Phase D：记忆证据引用化

目标：让记忆默认成为状态估计，而不是正文仓库。

实施内容：

- 默认 prompt 只携带 memory id、summary、confidence、updatedAt、sourceEventIds。
- 高风险动作前强制读取相关 memory 原始证据。
- 冲突记忆进入 `degraded` 或 `request_review`，不静默选择。

验收标准：

- memory 原文不会在普通 Loop 中反复注入。
- 需要证据时能按 id 读取。
- 记忆冲突能被 UI 和事件流看见。

### Phase E：上下文检查器 UI

目标：让用户能看懂“为什么这轮上下文这么大”。

实施内容：

- 展示每轮上下文分段大小排行。
- 展示选入/排除的 sources、memories、events、directives。
- 展示工具 profile 和被保留工具原因。
- 展示 profile 来源：默认、环境变量、Workshop 配置、Loop 配置或任务覆盖。

验收标准：

- 用户能定位最大上下文来源。
- 用户能发现无用数据源、过期记忆和噪声事件。
- 后续优化可以基于真实运行数据闭环。

## 9. 测试计划

单元测试：

- `selectPromptEvents` 保留用户纠错、失败、审核、blocked、degraded。
- `selectPromptEvents` 不让 `context_budget_report`、普通心跳和大段工具结果回流。
- source prompt 默认不包含 `source.content`。
- Loop Workshop context 默认不包含 memory 原文。
- `cheap` tool profile 保留显式配置和当前任务请求的工具。
- `normal` profile 的分段上限按配置生效。

集成测试：

- 高频 Loop 在较短上下文下仍能完成观察、摘要和状态更新。
- 深度复盘或高风险任务能切到 `full` / `audit` 并读取证据。
- 缺少证据时进入 blocked 或 request review，不编造。
- Dashboard 能正确展示最近 `context_budget_report` 聚合。

回归测试：

- Workshop dashboard、Loop runner、Work Runtime 不因上下文缩减丢失运行状态。
- 旧事件、旧记忆和 source 原文仍可通过工具检索。
- denied 过滤、action policy 和审核边界不受工具 profile 影响。

当前已验收：

- `pnpm --filter web tsc` 已通过。

## 10. 配置说明

上下文 profile：

```env
WORKSHOP_CONTEXT_PROFILE=normal
LOOP_CONTEXT_PROFILE=cheap
CONTEXT_PROFILE_NORMAL_PROMPT_MAX_CHARS=16000
CONTEXT_PROFILE_NORMAL_LOOP_STATE_MAX_CHARS=14000
CONTEXT_PROFILE_NORMAL_WORKSHOP_CONTEXT_MAX_CHARS=10000
```

模型 tier：

```env
WORKSHOP_MODEL_TIER=standard
LOOP_MODEL_TIER=cheap
LLM_CHEAP_MODEL=
LLM_CHEAP_BASE_URL=
LLM_CHEAP_API_KEY=
```

配置原则：

- 不要为了省钱给复杂任务强行套 `cheap`。
- `cheap` 适合高频观察、轻量摘要、状态巡检。
- `normal` 适合普通车间执行。
- `full` 适合深度分析、复盘、复杂规划。
- `audit` 适合外部动作、交易、配置变更、记忆重写和发布审核。

## 11. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 裁剪过度导致缺少证据 | 保留 `full` / `audit`，并提供按 id 读取原文工具 |
| 事件过滤漏掉关键纠错 | 用户纠错、失败、blocked、审核、拒绝进入强保留集合 |
| 工具 profile 裁掉任务需要的工具 | 显式配置、action policy、verification required sources 永远保留 |
| 成本指标误导优化方向 | 文档和 UI 使用 `Context size`，成本只作观测 |
| 摘要错误影响判断 | 摘要必须带 source ids，可回溯原始 facts |
| 数据源陈旧被误用 | freshness、provider、warning、lastFetchStatus 必须显式暴露 |

## 12. 优先级建议

下一步优先做：

1. 规则模块化，减少每轮固定规则噪声。
2. Source digest 与按需读取，把数据源正文彻底移出默认 prompt。
3. Run / Loop summary，让长期历史不再线性膨胀。
4. 上下文检查器 UI，让每轮选入和排除的原因可见。
5. 补齐事件选择、工具 profile、source 投影和 memory 投影测试。

这个顺序把主线放在“输入治理”上：先减少无关信息进入模型，再用观测闭环判断下一轮该压哪一段。
