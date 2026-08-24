# 平台客户体验与响应架构详细技术方案

## 1. 方案定位

本文用于指导 Zhiyu 平台下一阶段以“客户体验明显改善”为目标的系统性改造。重点解决页面切换不流畅、首屏等待过长、慢数据源阻塞页面、智能体上下文过长、记忆召回链路不透明、后台任务状态不可见等问题。

本方案不是单点性能优化，也不是简单加缓存。目标是把平台从“用户打开页面时临时计算所有状态”，改造成“后台持续观测、状态快照化、页面 stale-first 渲染、慢源异步刷新、关键动作重新校验、智能体只消费最小充分上下文”的闭环控制系统。

工程原则：

> 先观测，再建模；先闭环，再自动；先边界，再行动；先稳定，再智能。

## 2. 当前问题

### 2.1 用户感知问题

当前客户体验差主要不是某一个接口慢，而是多个问题叠加：

- 页面切换后容易出现长时间 loading 或空白。
- 量化工作台第一次打开时，全市场数据冷启动会拖住页面。
- 智能体车间页面进入后会同时加载列表、详情、dashboard、events、memory、sources、outbox、loops 等数据。
- 慢接口失败后，页面缺少“旧快照可用、后台刷新失败、某个 provider 不可用”的清晰表达。
- SSE 或后台任务事件可能触发整页刷新，造成请求风暴和页面抖动。
- 智能体运行上下文可能混入大量历史、原始消息、旧记忆和重复事件，增加模型调用成本与响应时间。
- 记忆召回结果对用户不够透明，用户看不到召回计划、命中来源、去重原因和为什么进入上下文。

### 2.2 工程根因

根因可以归纳为七类：

| 根因 | 表现 | 影响 |
| --- | --- | --- |
| 首屏接口过重 | 首屏同时承担完整 dashboard、长事件流、记忆、资料源、全市场数据 | 首屏等待时间被最慢源拖住 |
| 快慢数据未分层 | 账户、持仓、自选股快照被全市场数据、车间 dashboard 拖住 | 用户明明可以先看的内容无法先出现 |
| 快照层不足 | 仍把事件日志、原始数据源、实时聚合作为页面主数据源 | 冷启动慢、失败不可恢复 |
| 缓存语义不统一 | SWR、内存缓存、no-store、自定义 cache 分散存在 | fresh/stale/refreshing/error 表达不一致 |
| 后台刷新不可见 | 缺少 lastSuccessAt、lastError、refreshing、provider warning | 用户无法判断是慢、坏、还是旧数据可用 |
| 智能体上下文未完全收口 | workshop memory、brain memory、interaction events、raw messages 多源可能重复进入 prompt | 成本高、响应慢、结果不稳定 |
| 待处理事项事件化 | 需处理项从事件推导，缺少结构化状态表 | 清空、暂不处理、已处理语义不稳定 |

## 3. 被控对象与控制目标

### 3.1 被控对象

本方案的被控对象不是单个接口，而是“用户可感知交互响应系统”，包括：

- `/workshop` 智能体车间。
- `/quant` 量化工作台。
- `/memory` 统一记忆召回页面。
- `/loops` 长期任务页面。
- 全局侧边栏、导航、会话状态、运行状态。
- 智能体运行时上下文构建链路。
- 统一记忆平台召回链路。
- 待处理项、权限边界、审核状态。

### 3.2 控制目标

产品目标：

- 页面切换后 1 秒内出现可用内容。
- 慢数据不阻塞快数据。
- 有旧快照时优先展示旧快照，并明确标注刷新状态。
- 单个模块失败不导致整页不可用。
- 用户能看懂当前数据是否新鲜、后台是否刷新、哪一个来源失败。
- 智能体只消费和任务相关的 ContextPack，不直接拼接大段历史。
- 需处理项必须能在平台上被处理；不能处理但仍显示为需处理，应视为 bug。

工程目标：

| 场景 | 目标 |
| --- | --- |
| 首屏 page-state 热路径 | p95 < 500ms |
| 热缓存读取 | p95 < 150ms |
| tab 切换 | 300ms 内显示旧数据或局部空状态 |
| 外部慢 provider | 不阻塞首屏 |
| 超过 800ms 的接口 | 必须有结构化耗时日志 |
| 后台刷新失败 | 保留最近成功快照并显示 warning |
| 智能体上下文 | 默认由统一记忆平台生成 ContextPack |
| 需处理项 | 结构化存储、可关闭、可审计、可回放 |

## 4. 目标架构

### 4.1 总体架构

```text
外部数据源 / 数据库 / 智能体运行时 / 用户操作
  -> 观测采集层
  -> 领域状态建模层
  -> 快照构建与持久化层
  -> 页面状态聚合 API
  -> 前端 stale-first 渲染
  -> 后台刷新 / SSE 局部 patch
  -> 用户反馈 / 控制动作 / 审核
  -> 事件日志与体验指标闭环
```

### 4.2 分层职责

#### A. 观测采集层

职责：

- 拉取外部市场数据、账户数据、资料源、消息源。
- 读取数据库中的车间、Loop、记忆、事件和 outbox。
- 接收智能体运行事件。
- 记录 provider、耗时、错误、降级、数据来源。

要求：

- 允许慢，也允许失败。
- 慢和失败不能直接传导到页面首屏。
- 任何降级都要保留 `provider/detail/warning`。

#### B. 领域状态建模层

职责：

- 把原始观测转成用户可消费的结构化状态。
- 把事件日志转成摘要、计数、最近发现、下一步动作。
- 把记忆候选、历史事实、边界和纠错转成 ContextPack。

典型模型：

- `QuantMarketSnapshot`
- `QuantAccountSnapshot`
- `WorkshopSummarySnapshot`
- `WorkshopDashboardSnapshot`
- `LoopRunSummary`
- `ReviewItemSnapshot`
- `BrainContextPack`
- `MemoryRecallTrace`

#### C. 快照构建与缓存层

职责：

- 保存最近可用快照。
- 标记 freshness。
- 支持 stale-first。
- 支持后台刷新写回。

统一快照元信息：

```ts
type SnapshotMeta = {
  hit: boolean;
  stale: boolean;
  refreshing: boolean;
  generatedAt: string;
  fetchedAt: string;
  expiresAt: string;
  source: string;
  warnings: Array<{
    code: string;
    message: string;
    provider?: string;
    detail?: string;
  }>;
};
```

读取策略：

```text
fresh 可用
  -> 立即返回 fresh

fresh 过期但 stale 可用
  -> 立即返回 stale
  -> 标记 refreshing=true
  -> 后台刷新

没有任何快照
  -> 短超时等待实时构建
  -> 超时后返回局部 pending 或 503

刷新失败
  -> 保留最近成功快照
  -> 写入 warning / lastError
```

#### D. 页面状态聚合 API

每个主页面应该有一个轻量首屏 API：

- `GET /api/page-state/quant`
- `GET /api/page-state/workshop`
- `GET /api/page-state/workshop/[id]/summary`
- `GET /api/page-state/memory`
- `GET /api/page-state/loops`

首屏 API 只返回足够让页面可用的数据：

- 列表摘要。
- 当前选中对象摘要。
- 最近一次成功快照。
- 局部模块刷新状态。
- 必须马上处理的确认项。

首屏 API 不返回：

- 长事件日志。
- 全量记忆。
- 全量 source 明细。
- 完整工作模型。
- 大段工具输出。

#### E. 前端 stale-first 渲染

原则：

- 有旧数据就先显示旧数据。
- 后台刷新时保留旧 UI，只在模块上显示刷新状态。
- 没有任何可用数据时才显示骨架屏。
- 每个 panel 独立 loading/error，不再使用单个页面级 loading 控制所有模块。
- tab 数据懒加载，但切回 tab 时复用上次结果。
- 错误分为阻塞错误、降级错误、后台错误。

## 5. 量化工作台改造方案

### 5.1 问题

量化工作台的慢源主要来自全市场数据：

- 市场温度。
- 成交额。
- 市场宽度。
- 行业热度。

这些必须来自全市场，不能用单个自选股池替代。但全市场数据天然慢，因此不能成为页面首屏同步依赖。

### 5.2 目标状态

量化页面拆成三个独立数据域：

- `accountState`：模拟盘账户、持仓、订单、成交。
- `watchlistState`：自选股和快速行情。
- `marketState`：全市场温度、成交额、宽度、行业热度。

展示优先级：

1. 账户和持仓优先展示。
2. 自选股行情优先展示。
3. 全市场快照有旧数据就显示旧数据。
4. 全市场快照缺失时，只让市场模块 loading。
5. 全市场刷新失败时显示 provider warning，不把自选股数据伪装成全市场数据。

### 5.3 接口设计

```text
GET /api/page-state/quant
GET /api/quant/paper/account
GET /api/quant/dashboard
POST /api/quant/dashboard/refresh
GET /api/quant/dashboard/status
```

`/api/page-state/quant` 返回：

```ts
type QuantPageState = {
  account: QuantPaperAccount | null;
  dashboard: QuantDashboard | null;
  marketSnapshot: QuantMarketOverview | null;
  watchlist: QuantWatchlistItem[];
  refresh: {
    market: RefreshJobStatus | null;
    account: RefreshJobStatus | null;
  };
  meta: SnapshotMeta;
};
```

### 5.4 缓存策略

| 数据 | Fresh TTL | Stale 保留 | 刷新方式 |
| --- | --- | --- | --- |
| paper account | 5s-10s | 1min-5min | 请求时短超时刷新 |
| watchlist quotes | 10s | 1min | 请求时短超时刷新 |
| full market snapshot | 5min | 30min-2h | 后台预热 + 手动刷新 |
| sector heat | 10min | 60min-2h | 后台 worker |

### 5.5 安全边界

- stale market snapshot 只能用于展示和分析提示。
- 模拟下单必须重新读取最新账户、持仓、价格、交易日状态。
- 真实券商下单保持禁止，除非未来建立单独真实资金边界。
- 市场 provider 降级必须暴露 `provider/detail/warning`。

### 5.6 验收标准

- `/quant` 冷启动不再等待全市场数据完成。
- 有旧市场快照时 1 秒内展示旧数据并标注 stale。
- `/api/quant/paper/account` 不依赖完整 dashboard。
- 全市场刷新失败时页面仍可操作。

## 6. 智能体车间改造方案

### 6.1 问题

车间页面承担过多职责：

- 车间列表。
- 当前车间详情。
- dashboard。
- events。
- loops。
- memory。
- sources。
- outbox。
- boundary。
- tools。
- SSE。
- 表单和动作。

这导致首屏重、状态复杂、请求互相触发，一个慢接口会放大成整页卡顿。

### 6.2 目标结构

```text
WorkshopPageShell
  WorkshopSidebar
  WorkshopHeader
  WorkshopOverviewPanel
  WorkshopLoopsPanel
  WorkshopReviewPanel
  WorkshopTimelinePanel
  WorkshopMemoryPanel
  WorkshopSourcesPanel
  WorkshopOutboxPanel
  WorkshopBoundaryPanel
  WorkshopToolsPanel
```

Shell 只负责：

- 当前选中 workshop。
- 当前 tab。
- 全局动作状态。
- SSE 事件分发。

Panel 自己负责：

- 数据 key。
- stale 数据。
- 局部 loading。
- 局部 error。
- 局部 refresh。

### 6.3 首屏 page-state

```text
GET /api/page-state/workshop
```

返回：

```ts
type WorkshopPageState = {
  workshops: Array<{
    id: string;
    name: string;
    mission: string;
    status: string;
    updatedAt: string;
    summary: {
      activeLoops: number;
      pendingApprovals: number;
      blockedLoops: number;
      pendingOutbox: number;
      latestEventTitle: string | null;
      nextWorkAt: string | null;
    };
    cache: SnapshotMeta;
  }>;
  selectedWorkshopId: string | null;
  meta: SnapshotMeta;
};
```

### 6.4 详情拆分

建议接口：

- `GET /api/page-state/workshop/[id]/summary`
- `GET /api/workshops/[id]/events?limit=80`
- `GET /api/workshops/[id]/review-items`
- `GET /api/workshops/[id]/memory-summary`
- `GET /api/workshops/[id]/outbox-summary`
- `GET /api/workshops/[id]/sources-summary`
- `GET /api/workshops/[id]/loops/[loopId]/detail`

旧 `/api/workshops/[id]` 保留兼容，但不再作为首屏主路径。

### 6.5 SSE 局部刷新策略

SSE 事件不应触发全页重拉，而应映射为局部刷新计划：

| 事件类型 | 刷新范围 |
| --- | --- |
| loop run/update | loop panel、dashboard summary |
| memory_written / memory_reviewed | memory panel |
| source_added / source_checked | sources panel |
| outbox draft / sent / failed | outbox panel |
| work updated / agent changed | overview、boundary、tools |
| agent_text / tool_result | timeline 增量追加，不重拉详情 |

原则：

- 800ms debounce 合并刷新。
- 只刷新已经打开过的 panel。
- timeline 使用 append 或小范围 revalidate。
- dashboard 刷新可以异步，不阻塞用户当前操作。

## 7. 待处理项与权限边界改造方案

### 7.1 当前问题

“需处理”目前大量依赖事件推导。例如某个 proposal 事件存在，但后续 applied/rejected/dismissed 事件匹配失败，就会一直显示需要处理。

这会导致：

- 用户点了“暂不处理”，但页面仍显示需要处理。
- 用户选择清空提示，语义不清楚。
- 过期任务、非当前时间段任务仍占据待处理列表。
- 处理状态难以审计。

### 7.2 目标模型

新增结构化状态表：

```ts
type WorkshopReviewItem = {
  id: string;
  workshopId: string;
  sourceEventId: string | null;
  kind:
    | "watchlist_proposal"
    | "agent_change_proposal"
    | "permission_boundary"
    | "service_error"
    | "loop_blocker";
  status:
    | "pending"
    | "approved"
    | "rejected"
    | "dismissed"
    | "superseded";
  title: string;
  summary: string | null;
  riskLevel: "low" | "medium" | "high" | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};
```

### 7.3 清空提示语义

“清空提示”不等于删除历史，也不等于假装问题已修复。它表示用户做出了显式控制动作：

- 我不想处理这个问题。
- 我改了但不想重跑，因为它不是当前时间段任务。
- 我接受这条提示不再阻塞当前页面。

因此应写成：

```text
status = dismissed
resolvedBy = currentUser
resolvedAt = now
resolutionReason = user_dismissed
```

同时保留原始事件，后续审计和回放仍可看到。

### 7.4 验收标准

- 所有“需处理”项都必须有可点击处理动作。
- “暂不处理”后该项不能继续出现在待处理列表。
- 事件推导只作为兼容 fallback，长期以 `workshop_review_items` 为准。
- 处理记录必须可审计、可回放。

## 8. 统一记忆平台与上下文治理方案

### 8.1 问题

当前项目中存在多类记忆和类记忆数据：

- brain memories。
- workshop memories。
- interaction memories。
- raw messages。
- interaction events。
- RAG chunks。
- workshop events。
- loop run summaries。

如果需求方直接拼接这些来源，会产生同一个事件多类记忆、重复召回、上下文过长、成本增加和模型注意力分散。

### 8.2 目标原则

统一记忆平台是状态估计器，不是消息堆积器。

需求方不直接查询底层记忆表。需求方只上报：

- 自己属于什么平台。
- 当前处于什么状态。
- 接下来要做什么事。
- 允许读取的 scope。
- 风险等级和权限边界。

记忆平台负责：

- 理解需求。
- 生成召回参数。
- 多路召回。
- 同源去重。
- 冲突处理。
- 输出 ContextPack。
- 记录 MemoryRecallTrace。

### 8.3 召回流程

```text
需求方 RecallRequest
  -> LLM/规则生成 RecallPlan
  -> exact / keyword / vector / graph-lite / pinned boundary 多路召回
  -> sourceEventId / canonicalGroup 去重
  -> freshness / confidence / risk rerank
  -> evidence refs 补充
  -> ContextPack 输出
  -> MemoryRecallTrace 落库
```

### 8.4 ContextPack 结构

```ts
type BrainContextPack = {
  request: RecallRequest;
  plan: RecallPlan;
  selected: ContextMemory[];
  pinned: ContextMemory[];
  rejected: Array<{
    memoryId: string;
    reason: string;
  }>;
  warnings: Array<{
    code: string;
    message: string;
  }>;
  traceId: string;
};
```

### 8.5 去重策略

同一事件可以派生多个候选、摘要、关系和索引，但默认进入 ContextPack 的长期记忆只能有一个 canonical 投影。

去重优先级：

1. `sourceEventId` 相同，保留 canonical memory。
2. `canonicalGroupId` 相同，保留置信度高且最新的版本。
3. 高风险任务强制保留 `boundary` 和最近用户纠错。
4. 原始消息和 RAG chunk 默认作为 evidence ref，不直接塞入 prompt。

### 8.6 上下文预算口径

这里不使用“超预算”作为产品判断。每个任务目标不同，最终目标是更好完成任务，而不是为了省钱硬裁剪上下文。

正确口径是：

- 输入必须相关。
- 输出必须充分。
- 边界必须完整。
- 证据必须可追溯。
- 无关历史不能进入上下文。

因此上下文治理不是成本限制，而是相关性、可靠性和可解释性的控制。

## 9. 数据库与状态存储方案

### 9.1 通用页面快照

```sql
create table page_state_snapshots (
  id uuid primary key,
  user_id uuid not null,
  key text not null,
  value jsonb not null,
  meta jsonb not null,
  generated_at timestamptz not null,
  expires_at timestamptz not null,
  stale_until timestamptz not null,
  unique(user_id, key)
);
```

用途：

- 页面首屏快照。
- 快速恢复。
- stale-first。
- 后台刷新写回。

### 9.2 领域结构化状态

后续逐步补充：

- `workshop_review_items`：待处理项结构化状态。
- `memory_recall_traces`：召回计划、命中、去重、拒绝原因。
- `quant_market_snapshots`：全市场快照。
- `loop_summary_snapshots`：Loop 最近运行摘要。
- `refresh_jobs`：后台刷新任务状态。

## 10. 前端交互方案

### 10.1 页面骨架

每个主页面采用：

```text
PageShell
  Header
  PrimaryList / Sidebar
  SummaryPanel
  Tabs
    LazyPanel
    LazyPanel
    LazyPanel
```

### 10.2 状态表达

统一展示：

- `fresh`：正常。
- `stale`：显示旧快照，后台刷新中。
- `refreshing`：后台刷新。
- `degraded`：部分 provider 失败。
- `blocked`：关键数据缺失，无法继续。

### 10.3 用户动作

用户动作分为三类：

| 动作 | 是否允许使用 stale 快照 | 处理方式 |
| --- | --- | --- |
| 浏览展示 | 可以 | 标注 freshness |
| 分析建议 | 可以，但必须提示 | 附带 source freshness |
| 写动作/交易/发送/删除/配置变更 | 不可以 | 服务端重新读取最新状态并校验 guard |

## 11. 观测与验收方案

### 11.1 必须记录的指标

接口指标：

- route。
- operation。
- cache hit / stale hit / miss。
- DB query time。
- external provider time。
- serialization time。
- response bytes。
- error / warning / fallback。
- requester surface：page load、tab switch、SSE refresh、manual refresh。

体验指标：

- 页面首屏可用时间。
- 旧快照显示时间。
- tab 切换可用时间。
- 用户触发刷新到可见变化时间。
- 局部错误率。
- 后台刷新成功率。

智能体指标：

- RecallRequest 类型。
- RecallPlan 生成耗时。
- 候选数量。
- 去重数量。
- selected/pinned/rejected 数量。
- ContextPack token 估算。
- 模型调用耗时。

### 11.2 本地验收脚本

继续维护：

```text
pnpm --filter web smoke:ux
```

验收范围：

- `/api/page-state/quant`
- `/api/page-state/workshop`
- `/api/page-state/workshop/[id]/summary`
- `/api/quant/paper/account`
- `/api/quant/dashboard`
- `/api/memory/search`
- `/api/workshops/[id]/dashboard`

### 11.3 验收门槛

- 热路径全部通过阈值。
- 慢源失败不导致主页面不可用。
- 页面快照能跨刷新复用。
- SSE 事件只触发局部刷新。
- 待处理项可以被处理、忽略、审计。
- 记忆召回能展示 plan、结果、去重和 trace。

## 12. 分阶段实施计划

### 阶段一：首屏快照与慢源拆离

目标：

- 建立 `page_state_snapshots`。
- 量化页面通过 `/api/page-state/quant` 首屏可用。
- 车间列表通过 `/api/page-state/workshop` 首屏可用。
- 直接接口优先返回持久化快照，后台刷新。

验收：

- `/quant` 和 `/workshop` 首屏不再被全市场或 dashboard 冷启动拖住。
- smoke 脚本覆盖关键 API。

### 阶段二：车间详情拆分与 SSE 局部刷新

目标：

- 增加 `/api/page-state/workshop/[id]/summary`。
- 车间详情从全量事件和全量记忆中拆出摘要。
- SSE 映射为局部 refresh plan。

验收：

- 切换车间 300ms 内有旧快照或摘要。
- SSE 不触发全页请求风暴。

### 阶段三：待处理项结构化

目标：

- 增加 `workshop_review_items`。
- proposal、权限边界、服务异常转成结构化 review item。
- “暂不处理/清空提示”写入 dismissed 状态。

验收：

- 用户处理后不再重复出现。
- 事件推导只作为 fallback。

### 阶段四：统一记忆召回切换

目标：

- 智能体和车间默认从 Brain Memory Platform 获取 ContextPack。
- 需求方上报平台、状态、动作、scope、风险。
- 记忆平台生成 RecallPlan，并记录 MemoryRecallTrace。

验收：

- 不再由调用方直接拼接多套历史。
- 同一事件只进入一个 canonical long-term memory 投影。
- 页面能解释召回过程。

### 阶段五：前端模块化与体验指标闭环

目标：

- 重构大页面为 shell + panel。
- 建立统一 `usePageState`。
- 增加体验指标采集和本地 smoke 阈值。

验收：

- 页面切换流畅。
- 局部失败不影响整页。
- 性能回归能在本地脚本中发现。

## 13. 风险与降级

| 风险 | 降级方案 |
| --- | --- |
| 快照过旧 | 显示 stale 标记，并限制写动作 |
| 后台刷新失败 | 保留最近成功快照，显示 warning |
| 外部 provider 慢 | 首屏不等待，后台刷新 |
| 记忆召回 LLM 失败 | 使用规则 RecallPlan 降级 |
| 去重误杀重要记忆 | pinned boundary、用户纠错、审计结论强制保留 |
| 结构化 review item 与旧事件不一致 | 结构化为准，事件作为 evidence |

## 14. 当前优先级

第一优先级：

- 完成待处理项结构化，修复“暂不处理后仍显示需处理”的体验 bug。
- 把智能体和车间的上下文入口切到统一记忆平台 ContextPack。
- 继续扩大 page-state 覆盖，减少首屏直连慢接口。

第二优先级：

- 前端大页面拆分为 panel。
- 统一错误、降级和刷新状态 UI。
- 建立 memory recall trace 可视化。

第三优先级：

- 建立长期体验指标面板。
- 增加后台预热调度。
- 优化全市场数据 provider 和本地缓存策略。
