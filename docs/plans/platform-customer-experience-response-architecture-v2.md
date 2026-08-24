# 平台客户体验与响应架构改造技术方案 V2

## 1. 方案定位

本文面向 Zhiyu 当前平台的客户体验问题，目标不是单点优化某个接口，而是从架构层把平台改造成“快速可见、后台补新、状态可解释、智能体上下文可控”的闭环系统。

当前用户感受到的“页面切换不流畅、接口慢、智能体成本高、数据抓取慢、错误提示无法处理”，本质上不是一个性能点，而是四类问题叠加：

1. 页面首屏依赖过重，慢数据源会拖住整页。
2. 缓存和快照语义分散，旧数据可用但没有被稳定复用。
3. 智能体上下文没有彻底收口，历史、记忆、事件、原始消息存在重复进入模型的风险。
4. 运行状态和异常没有产品化为可处理、可关闭、可追溯的结构化状态。

本方案遵循项目工程原则：

> 先观测，再建模；先闭环，再自动；先边界，再行动；先稳定，再智能。

## 2. 当前核心问题

### 2.1 用户体验问题

用户侧主要表现为：

- 页面切换后长时间 loading，缺少“先展示旧快照、后台刷新”的体验。
- 量化页面容易被全市场数据冷启动拖住，账户、持仓、自选股这类快速数据不能优先展示。
- 智能体车间页面承载过多职责，列表、详情、事件、记忆、资料源、outbox、loop、dashboard、SSE 刷新混在一个大页面里。
- 服务异常、权限边界、任务阻塞等“需要处理”项曾经依赖事件推导，导致用户点了“暂不处理”后仍可能出现。
- 统一记忆页面效果已经逐步成形，但智能体和车间运行链路还需要全面切到 Brain ContextPack。
- 性能观测已经有 smoke 和 dashboard，但还缺少真实页面级前端体验指标。

### 2.2 工程根因

| 根因 | 表现 | 后果 |
| --- | --- | --- |
| 首屏 API 过重 | 页面打开时拉 dashboard、长事件流、完整记忆、慢外部数据 | 慢源拖住整页 |
| 快慢数据未分层 | 账户、持仓、自选股和全市场数据放在同一加载路径 | 本来能先看的内容被阻塞 |
| 快照语义不统一 | 内存缓存、SWR、自定义 cache、no-store 混用 | stale/fresh/refreshing 表达不一致 |
| 后台刷新不可见 | 缺少 lastSuccessAt、lastError、refreshing、provider warning | 用户不知道是慢、坏、还是旧数据可用 |
| 智能体上下文入口分散 | Brain memory、workshop memory、interaction memory、raw message 多路拼接 | 成本高、响应慢、重复召回 |
| 事件和状态混用 | 从历史事件临时推导当前需要处理项 | 清空、忽略、已处理语义不稳定 |
| 大组件承担过多职责 | workshop-client 同时管理数据、SSE、表单和动作 | 重渲染范围大，局部失败放大为整页体验差 |

## 3. 被控对象与控制目标

### 3.1 被控对象

本方案控制的不是单个接口，而是“用户可感知响应系统”，包括：

- `/quant` 量化工作台。
- `/workshop` 智能体车间。
- `/memory` 统一记忆召回。
- `/loops` 长期任务。
- 全局侧边栏和导航。
- 智能体运行上下文构建链路。
- 后台刷新、SSE、review items、服务异常、权限边界。

### 3.2 产品目标

- 页面切换后 1 秒内出现可用内容。
- 慢数据源不阻塞快数据。
- 有旧快照时先展示旧快照，并明确标注刷新状态。
- 单个模块失败不导致整页不可用。
- 用户能看懂当前数据是否新鲜、后台是否刷新、哪个 provider 失败。
- 智能体只消费当前任务需要的最小充分 ContextPack，不再直接拼大段历史。
- 平台提出“需要处理”的事项必须能在页面处理；不能处理但仍展示为需要处理，应视为 bug。

### 3.3 工程指标

| 场景 | 目标 |
| --- | --- |
| 首屏 page-state API | p95 < 500ms |
| 热缓存读取 | p95 < 150ms |
| tab 切换 | 300ms 内展示旧数据或局部空态 |
| 外部慢 provider | 不阻塞首屏 |
| 超过 800ms 的用户可见 API | 必须记录结构化耗时 |
| 后台刷新失败 | 保留最近成功快照，并展示 warning |
| 智能体运行上下文 | 默认通过统一记忆平台生成 ContextPack |
| 需要处理项 | 结构化存储、可关闭、可审计、可回放 |

## 4. 目标架构

### 4.1 总体链路

```text
外部数据源 / 数据库 / 智能体运行时 / 用户操作
  -> 观测采集层
  -> 领域状态建模层
  -> 快照构建与持久化层
  -> 页面状态聚合 API
  -> 前端 stale-first 渲染
  -> 后台刷新 / SSE 局部 patch
  -> 用户处理 / 审核 / 纠错
  -> 事件与体验指标闭环
```

### 4.2 分层职责

#### 观测采集层

职责：

- 拉取市场数据、账户数据、资料源、消息源。
- 读取车间、Loop、记忆、事件、outbox、review item。
- 接收智能体运行事件。
- 记录 provider、耗时、错误、降级、数据来源。

要求：

- 允许慢，也允许失败。
- 慢和失败不能直接传导到页面首屏。
- 降级必须保留 `provider/detail/warning`。

#### 领域状态建模层

职责：

- 把原始观测转成页面可消费的结构化状态。
- 把事件流转成摘要、计数、最近发现、下一步动作。
- 把记忆、历史事实、边界和纠错转成 ContextPack。

典型模型：

- `QuantAccountSnapshot`
- `QuantMarketSnapshot`
- `WorkshopSummarySnapshot`
- `WorkshopDashboardSnapshot`
- `WorkshopReviewItem`
- `LoopRunSummary`
- `BrainContextPack`
- `MemoryRecallTrace`

#### 快照构建与缓存层

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

#### 页面状态聚合 API

每个主页面应该有一个轻量首屏 API：

```text
GET /api/page-state/quant
GET /api/page-state/workshop
GET /api/page-state/workshop/[id]/summary
GET /api/page-state/memory
GET /api/page-state/loops
```

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

#### 前端 stale-first 渲染

原则：

- 有旧数据就先显示旧数据。
- 后台刷新时保留旧 UI，只在模块上显示刷新状态。
- 没有任何可用数据时才显示骨架屏。
- 每个 panel 独立 loading/error。
- tab 数据懒加载，但切回 tab 时复用上次结果。
- 错误分为阻塞错误、降级错误、后台错误。

## 5. 量化工作台改造方案

### 5.1 当前问题

量化工作台的慢源主要来自全市场数据：

- 市场温度。
- 成交额。
- 市场宽度。
- 行业热度。

这些数据必须来自全市场，不能用单个自选股池替代。但全市场数据天然慢，因此不能成为页面首屏同步依赖。

### 5.2 目标结构

量化页面拆成三个独立数据域：

- `accountState`：模拟盘账户、持仓、订单、成交。
- `watchlistState`：自选股和快速行情。
- `marketState`：全市场温度、成交额、宽度、行业热度。

展示优先级：

1. 账户和持仓优先展示。
2. 自选股行情优先展示。
3. 全市场快照有旧数据就展示旧数据。
4. 全市场快照缺失时，只让市场模块 loading。
5. 全市场刷新失败时展示 provider warning，不把自选股数据伪装成全市场数据。

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

## 6. 智能体车间改造方案

### 6.1 当前问题

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

这会导致首屏重、状态复杂、请求互相触发，一个慢接口放大成整页卡顿。

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

```text
GET /api/page-state/workshop/[id]/summary
GET /api/workshops/[id]/events?limit=80
GET /api/workshops/[id]/review-items
GET /api/workshops/[id]/memory-summary
GET /api/workshops/[id]/outbox-summary
GET /api/workshops/[id]/sources-summary
GET /api/workshops/[id]/loops/[loopId]/detail
```

旧 `/api/workshops/[id]` 保留兼容，但不再作为首屏主路径。

### 6.5 SSE 局部刷新

SSE 事件不应触发全页重拉，而应映射为局部刷新计划：

| 事件类型 | 刷新范围 |
| --- | --- |
| loop run/update | loops panel、dashboard summary |
| memory_written / memory_reviewed | memory panel |
| source_added / source_checked | sources panel |
| outbox draft / sent / failed | outbox panel、review panel |
| work updated / agent changed | overview、boundary、tools |
| agent_text / tool_result | timeline 增量追加 |

原则：

- 800ms debounce 合并刷新。
- 只刷新已经打开过的 panel。
- timeline 使用 append 或小范围 revalidate。
- dashboard 刷新异步进行，不阻塞用户当前操作。

## 7. 需要处理项与权限边界方案

### 7.1 问题

“需要处理”不能依赖事件日志临时推导。用户点了“暂不处理”，语义应该是：

- 我知道这个问题。
- 我现在不处理。
- 它不应该继续阻塞当前页面。
- 原始事件仍然保留，后续可审计和回放。

### 7.2 目标模型

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

“清空提示”或“暂不处理”不等于删除历史，也不等于假装问题已修复。它表示用户做出显式控制动作：

```text
status = dismissed
resolvedBy = currentUser
resolvedAt = now
resolutionReason = user_dismissed
```

验收标准：

- 所有“需要处理”项必须有可点击处理动作。
- “暂不处理”后该项不能继续出现在 pending 列表。
- 事件推导只作为兼容 fallback，长期以 `workshop_review_items` 为准。
- 处理记录必须可审计、可回放。

## 8. 统一记忆平台与上下文治理方案

### 8.1 当前问题

项目中存在多类记忆和类记忆数据：

- Brain memories。
- Workshop memories。
- Interaction memories。
- Raw messages。
- Interaction events。
- RAG chunks。
- Workshop events。
- Loop run summaries。

同一事件可能产生多类记忆。如果需求方直接拼接这些来源，会产生重复召回、上下文过长、成本增加和模型注意力分散。

### 8.2 目标原则

统一记忆平台是状态估计器，不是消息堆积器。

需求方不直接查询底层记忆表，只上报：

- 自己属于什么平台。
- 当前处于什么状态。
- 接下来要做什么事。
- 允许读取的 scope。
- 风险等级和权限边界。

记忆平台负责：

- 理解需求。
- 使用大模型生成 RecallPlan。
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

### 8.4 RecallRequest

```ts
type MemoryRecallRequest = {
  requester: {
    surface: "workshop" | "loop" | "chat" | "quant" | "memory_page";
    userId: string;
    workshopId?: string;
    loopId?: string;
  };
  task: {
    intent: string;
    currentState?: string;
    actionRisk: "low" | "medium" | "high";
    needsEvidence: boolean;
  };
  constraints: {
    maxItems: number;
    maxTokens: number;
    freshness?: "latest" | "stable" | "historical";
    allowedKinds?: string[];
    deniedKinds?: string[];
  };
};
```

### 8.5 RecallPlan

RecallPlan 可以由大模型根据 request 自动生成，但必须有确定性 fallback。

```ts
type MemoryRecallPlan = {
  routes: Array<{
    route:
      | "brain_memory"
      | "knowledge_store"
      | "memory_graph"
      | "evidence_read"
      | "legacy_discovery";
    query: string;
    scopes: string[];
    memoryKinds: string[];
    entityHints: string[];
    freshness: "latest" | "stable" | "historical";
    limit: number;
    reason: string;
  }>;
  rerank: {
    pinKinds: string[];
    suppressKinds: string[];
    diversityBy: "canonicalGroupId" | "sourceEventId" | "kind";
  };
};
```

### 8.6 ContextPack

```ts
type BrainContextPack = {
  request: MemoryRecallRequest;
  plan: MemoryRecallPlan;
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

### 8.7 去重策略

同一事件可以派生候选、摘要、关系和索引，但默认进入 ContextPack 的长期记忆只能有一个 canonical 投影。

去重优先级：

1. `sourceEventId` 相同，保留 canonical memory。
2. `canonicalGroupId` 相同，保留置信度高且最新的版本。
3. 高风险任务强制保留 `boundary` 和最近用户纠错。
4. 原始消息和 RAG chunk 默认作为 evidence ref，不直接塞入 prompt。

### 8.8 上下文治理口径

这里不使用“超预算”作为产品判断。每个任务目标不同，最终目标是更好完成任务，而不是为了省钱硬裁剪上下文。

正确口径是：

- 输入必须相关。
- 输出必须充分。
- 边界必须完整。
- 证据必须可追溯。
- 无关历史不能进入上下文。

因此上下文治理不是成本限制，而是相关性、可靠性和可解释性的控制。

## 9. 前端体验方案

### 9.1 统一数据获取

建立统一 `usePageState`：

```ts
type PageStateOptions = {
  dedupingInterval?: number;
  refreshInterval?: number;
  keepPreviousData?: boolean;
  revalidateOnFocus?: boolean;
};
```

默认策略：

- `keepPreviousData: true`
- `revalidateOnFocus: false`
- `dedupingInterval: 5000`
- 错误时保留旧数据。
- 返回 `isInitialLoading`、`isRefreshing`、`isStale`。

### 9.2 页面切换优化

- 主导航 hover 或进入视口时预取 page-state。
- 返回页面时保留 tab、选中 workshop、滚动位置。
- tab 切换时先展示 cached panel。
- 慢 tab 懒加载，但不清空页面 shell。
- 按钮只锁定相关动作，不锁定整页。

### 9.3 大页面拆分策略

对 `workshop-client.tsx` 这类大组件，按“深模块”原则拆分：

- Shell 接口小，只负责布局和分发。
- Panel 内部实现深，自己处理数据、错误、刷新。
- 数据层抽象统一，避免每个 panel 手写 `useEffect + fetch`。
- SSE 只影响相关 panel，不穿透到整个页面状态。

## 10. 后台预热与刷新任务

### 10.1 启动预热

启动后异步预热：

- `/api/auth/session`
- `/api/page-state/workshop`
- `/api/page-state/quant`
- `/api/quant/paper/account`
- 常用 workshop dashboard。
- 全市场量化 snapshot refresh。

要求：

- 不阻塞 Web ready。
- 预热失败只写状态和日志。
- 页面能看到后台预热中或最近预热失败。

### 10.2 周期刷新

| 任务 | 周期 | 说明 |
| --- | --- | --- |
| `quant-market-snapshot-refresh` | 5min | 全市场温度、宽度、成交额、行业热度 |
| `quant-account-refresh` | 5s-15s | 模拟盘账户和持仓 |
| `workshop-summary-refresh` | 5s-30s | 车间摘要快照 |
| `loop-status-refresh` | 5s-30s | Loop 运行摘要 |
| `memory-recall-quality-refresh` | 10min | 召回质量统计 |

### 10.3 RefreshJob 状态

```ts
type RefreshJobStatus = {
  key: string;
  status: "idle" | "running" | "success" | "failed";
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  durationMs: number | null;
};
```

## 11. 可观测性方案

### 11.1 API timing

```ts
type ApiTimingLog = {
  event: "api_timing";
  route: string;
  operation: string;
  ms: number;
  cacheHit?: boolean;
  stale?: boolean;
  refreshing?: boolean;
  cold?: boolean;
  status: "ok" | "error" | "degraded";
  warningCount?: number;
  userId?: string;
  workshopId?: string;
};
```

### 11.2 前端体验指标

记录：

- route enter time。
- first shell paint。
- first data visible。
- stale snapshot visible time。
- tab switch latency。
- manual refresh duration。
- critical panels ready。
- route leave duration。

### 11.3 UX 性能面板

当前已有方向：

- smoke 脚本输出 `latest.json`、`latest.md`、`history.jsonl`。
- `/api/ux-performance` 返回趋势数据。
- `/ux-performance` 展示 p50/p95/p99/max/threshold。

下一步补齐：

- 页面级真实用户指标写入 `.ux-smoke/page-events.jsonl` 或正式指标表。
- 在 `/ux-performance` 聚合 route visible、tab latency、manual refresh latency。
- 建立告警规则：连续 N 次 p95 超阈值才报警，避免单次抖动。

## 12. 安全边界

### 12.1 stale 数据边界

stale 快照只能用于展示，不能直接用于高风险控制动作。

控制动作必须重新读取服务端最新状态并执行：

- 权限校验。
- 工具白名单校验。
- denied 优先校验。
- 数据新鲜度校验。
- 幂等校验。
- 审计事件写入。

### 12.2 交易和外部动作边界

默认禁止或强确认：

- 真实券商下单。
- 真实资金操作。
- 删除不可恢复数据。
- 发送外部消息。
- 修改系统配置。
- 修改智能体权限边界。

量化模拟盘仍然是受控实验环境，目标是暴露策略如何在扰动下失效，而不是证明模型会赚钱。

### 12.3 记忆边界

- 原始消息不是长期记忆。
- Graph 不是事实源。
- Snapshot 不替代 Brain Memory。
- Unified Search 是人工探索和 fallback discovery，不是默认 runtime ContextPack。
- 高风险任务必须优先召回 boundary、evidence、latest state。

## 13. 分阶段实施计划

### Phase 1：止血

目标：页面不再被慢接口拖死。

任务：

1. 量化页面拆 loading，dashboard 不阻塞 account。
2. quant cache 支持 stale-first 和后台刷新。
3. 新增或完善 `/api/page-state/quant`。
4. Workshop 首屏轻量化。
5. 新增或完善 `/api/page-state/workshop`。
6. 需要处理项结构化为 `workshop_review_items`。
7. 关键 API 加耗时日志。

验收：

- `/quant` 冷启动 1 秒内显示账户或旧快照。
- `/workshop` 首屏 1 秒内显示车间列表和 shell。
- 热路径接口 p95 < 500ms。

### Phase 2：page-state 化

目标：主页面首屏只依赖轻量 page-state。

任务：

1. 完善 `/api/page-state/workshop/[id]/summary`。
2. Workshop 前端拆成 shell + panels。
3. tab 数据懒加载并缓存。
4. 统一 `usePageState`。
5. 页面切换预取 page-state。
6. SSE 改成局部 patch。

验收：

- `/workshop` 首屏不拉全量 events/memory/outbox/source。
- tab 切换不清空旧数据。
- SSE 只刷新相关模块。

### Phase 3：后台刷新与快照持久化

目标：慢计算完全离开请求主路径。

任务：

1. page-state snapshot 持久化。
2. quant market snapshot 持久化。
3. refresh job 状态持久化。
4. 后台 worker 周期刷新。
5. 手动刷新只触发 job，不同步等待慢源完成。

验收：

- 外部 provider 失败不导致主页面不可用。
- 后台刷新失败保留最近成功快照。
- 用户能看到 lastSuccessAt、lastError、refreshing。

### Phase 4：统一记忆 ContextPack 全面接入

目标：降低无效上下文，提升智能体稳定性。

任务：

1. Workshop/Loop 默认通过 Brain Recall 获取 ContextPack。
2. RecallPlan 由大模型理解任务生成，并有确定性 fallback。
3. context log 覆盖所有智能体运行。
4. legacy memory/raw message 只作 evidence/fallback。
5. UI 展示 selected、pinned、rejected、deduped、warnings。

验收：

- 智能体运行不再默认拼接大段历史。
- 每次运行能解释用了哪些记忆、为什么用、为什么拒绝。
- 同源重复记忆不会同时进入 ContextPack。

### Phase 5：体验指标闭环

目标：持续知道哪里慢、为什么慢、改完是否变好。

任务：

1. 前端体验日志。
2. API timing 聚合。
3. smoke 历史趋势。
4. `/ux-performance` 扩展页面级指标。
5. 回归阈值和 CI 检查。

验收：

- 每次改造能对比 p50/p95/p99。
- 慢请求能定位到具体层。
- 页面体验退化能被自动发现。

## 14. 测试方案

### 14.1 单元测试

- stale cache 返回旧数据并触发后台刷新。
- refresh 失败时保留旧快照。
- quant page-state 在 market 缺失时仍返回 account。
- review item dismissed 后不再出现在 pending。
- SSE event 分类只影响指定 panel。
- ContextPack 去重只保留 canonical group 最高价值项。

### 14.2 集成测试

- 模拟全市场 provider 30 秒超时，`/quant` 仍在 1 秒内可用。
- 模拟 workshop dashboard 慢查询，`/workshop` 仍显示列表和 shell。
- 模拟后台刷新失败，页面展示旧快照和 warning。
- 模拟智能体高风险任务，必须召回 boundary 并记录 context log。

### 14.3 性能 smoke

继续维护：

```text
pnpm --filter web smoke:ux
```

覆盖：

- `/api/page-state/quant`
- `/api/page-state/workshop`
- `/api/page-state/workshop/[id]/summary`
- `/api/quant/paper/account`
- `/api/quant/dashboard`
- `/api/memory/search`
- `/api/workshops/[id]/dashboard`
- `/api/ux-performance`

## 15. 当前优先级

P0：

1. 继续把智能体和车间运行上下文切到统一记忆 ContextPack。
2. 继续拆 `workshop-client.tsx`，优先拆 review、timeline、memory、outbox panel。
3. 补页面级前端体验指标，接入 `/ux-performance`。
4. 完善 service_error 的重试、同类聚合和原因解释。

P1：

1. 建立后台刷新 job 状态面板。
2. 量化全市场 snapshot 持久化和预热策略强化。
3. SSE 更多事件改为本地 patch，减少 summary 重拉。
4. 统一 panel 级错误、stale、refreshing 展示。

P2：

1. CI 接入 UX smoke 阈值。
2. 建立长期性能趋势和告警。
3. 进一步优化模型路由，但不以牺牲任务完成质量为代价。

## 16. 最终验收口径

用户应该感受到：

- 页面切换像成熟 SaaS 一样流畅。
- 慢数据不再拖死整页。
- 系统刷新、降级、失败时能说明状态。
- 需要处理项真的能在页面处理。
- 智能体不是每次重新计算整个世界，而是消费稳定、可解释、可审计的 ContextPack。
- 成本下降不是靠限制任务，而是靠减少无关上下文、重复召回和重复计算。

技术上应达到：

```text
请求路径轻量化
状态快照化
慢源后台化
前端 stale-first
事件局部 patch
记忆 ContextPack 化
体验指标闭环
```
