# 平台客户体验与响应速度改造详细技术方案

## 1. 方案定位

本文面向 Zhiyu 当前平台的客户体验、页面响应速度、接口冷启动、后台数据刷新、智能体上下文治理和统一记忆消费链路，目标是把平台从“页面打开时临时计算所有状态”改造为“后台持续观测、状态快照化、页面 stale-first 渲染、慢源异步刷新、关键动作重新校验”的稳定控制系统。

本方案遵循项目工程原则：

> 先观测，再建模；先闭环，再自动；先边界，再行动；先稳定，再智能。

它不是单纯“加缓存”，而是一次体验架构重构：

```text
外部数据源 / 数据库 / 智能体运行时 / 用户操作
  -> 观测采集
  -> 领域状态建模
  -> 快照构建与持久化
  -> 页面状态聚合 API
  -> 前端 stale-first 渲染
  -> 后台刷新 / SSE 局部 patch
  -> 体验指标与用户反馈闭环
```

## 2. 当前核心问题

### 2.1 用户感知问题

当前体验差不是某一个接口慢，而是多类问题叠加：

- 页面切换后容易出现长时间 loading 或空白。
- 量化工作台第一次打开时，全市场数据冷启动会拖住页面。
- 智能体车间页面进入后会并发拉取列表、详情、dashboard、events、memory、sources、outbox、loops 等多类数据。
- 慢接口失败后，页面缺少“旧快照可用、后台刷新失败、某个 provider 不可用”的清晰表达。
- SSE 或后台任务事件可能触发整页刷新，导致请求风暴和页面抖动。
- 智能体运行时上下文可能混入大量历史、原始消息、旧记忆和重复事件，增加模型调用成本与响应时间。

### 2.2 工程根因

根因可以归纳为六类：

1. **首屏接口过重**
   首屏接口承担了完整 dashboard、长事件流、记忆、资料源、outbox、全市场数据等工作，页面需要等慢源返回。

2. **快慢数据没有分层**
   账户、持仓、自选股快照本来可以快速展示，但被全市场数据、车间 dashboard、历史事件等慢数据拖住。

3. **快照层不足**
   很多页面仍然把事件日志、原始数据源、实时聚合作为页面主数据源，缺少“最近一次可用状态”。

4. **缓存语义不统一**
   SWR、内存缓存、接口 no-store、自定义 cache 分散存在，fresh/stale/refreshing/error 的语义不一致。

5. **后台刷新缺少产品化状态**
   用户看不到 lastSuccessAt、lastError、refreshing、provider warning，导致慢源失败时像系统整体坏了。

6. **智能体上下文没有完全收口到统一记忆平台**
   Workshop memory、Brain memory、interaction events、raw messages、legacy discovery 等多源可能重复进入上下文，导致成本高、响应慢、结果不稳定。

## 3. 被控对象与控制目标

### 3.1 被控对象

本方案的被控对象不是单个接口，而是“用户可感知交互响应系统”，包括：

- `/quant` 量化工作台。
- `/workshop` 智能体车间。
- `/memory` 统一记忆召回页面。
- `/loops` 长期任务页面。
- 全局侧边栏、导航、会话状态、运行状态。
- 智能体运行时上下文构建链路。

### 3.2 控制目标

产品目标：

- 页面切换后 1 秒内有可用内容。
- 慢数据不阻塞快数据。
- 有旧快照时优先展示旧快照，并明确标注刷新状态。
- 单个模块失败不导致整页不可用。
- 用户能看懂当前数据是否新鲜、后台是否刷新、哪个来源失败。
- 智能体只消费和任务相关的 ContextPack，不直接拼接大段历史。

工程目标：

| 场景 | 目标 |
| --- | --- |
| 首屏 page-state 热路径 | p95 < 500ms |
| 热缓存读取 | p95 < 150ms |
| tab 切换 | 300ms 内显示旧数据或局部空状态 |
| 外部慢 provider | 不阻塞首屏 |
| 超过 800ms 的接口 | 必须有结构化耗时日志 |
| 后台刷新失败 | 保留最近成功快照并显示 warning |
| 智能体运行上下文 | 默认通过统一记忆平台生成 ContextPack |

## 4. 目标架构

### 4.1 分层架构

```text
观测采集层
  - 市场数据、账户数据、数据库事件、智能体运行事件、用户操作

领域状态建模层
  - QuantMarketSnapshot
  - QuantAccountSnapshot
  - WorkshopSummarySnapshot
  - WorkshopDashboardSnapshot
  - ReviewItemSnapshot
  - BrainContextPack

快照缓存层
  - 内存 fresh cache
  - stale cache
  - page_state_snapshots 持久化兜底
  - 领域专用 snapshot 表

页面状态聚合层
  - /api/page-state/quant
  - /api/page-state/workshop
  - /api/page-state/workshop/[id]
  - /api/page-state/memory

前端渲染层
  - usePageState
  - keepPreviousData
  - panel 级 loading/error
  - stale-first UI

后台刷新层
  - startup warmup
  - periodic refresh worker
  - request coalescing
  - refresh job status

控制动作层
  - 写动作重新读取最新状态
  - 权限边界与 denied 优先
  - 幂等、审计、可回滚
```

### 4.2 核心原则

- 页面读取快照，慢计算进入后台。
- 首屏只拿“足够可用”的状态，不拿完整历史。
- stale 快照只能用于展示，不能直接用于高风险动作。
- 写动作必须重新读取服务端最新状态并通过 guard。
- SSE 只 patch 受影响模块，不触发整页重拉。
- 统一记忆平台负责生成 ContextPack，调用方只声明需求。

## 5. 统一快照模型

### 5.1 快照元信息

所有 page-state 和关键领域快照统一携带元信息：

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

### 5.2 读取策略

```text
fresh 可用
  -> 立即返回 fresh

fresh 过期但 stale 可用
  -> 立即返回 stale
  -> 标记 refreshing=true
  -> 后台刷新

无任何快照
  -> 短超时等待实时构建
  -> 超时后返回局部 pending 或 503

刷新失败
  -> 保留最近成功快照
  -> 写入 warning / lastError
```

### 5.3 持久化表

通用页面状态快照：

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

后续可以按领域拆分：

- `quant_market_snapshots`
- `quant_account_snapshots`
- `workshop_summary_snapshots`
- `workshop_review_items`
- `loop_summary_snapshots`
- `memory_recall_traces`

## 6. 量化工作台改造方案

### 6.1 问题

量化工作台的慢源主要来自全市场数据：

- 市场温度。
- 成交额。
- 市场宽度。
- 行业热度。

这些必须来自全市场，不能用自选股数据替代。但全市场数据天然较慢，所以不能成为页面首屏同步依赖。

### 6.2 目标状态

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

### 6.3 接口设计

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

### 6.4 缓存策略

| 数据 | Fresh TTL | Stale 保留 | 刷新方式 |
| --- | --- | --- | --- |
| paper account | 5s-10s | 1min-5min | 请求时短超时刷新 |
| watchlist quotes | 10s | 1min | 请求时短超时刷新 |
| full market snapshot | 5min | 30min-2h | 后台预热 + 手动刷新 |
| sector heat | 10min | 60min-2h | 后台 worker |

### 6.5 安全边界

- stale market snapshot 只能用于展示和分析提示。
- 模拟下单必须重新读取最新账户、持仓、价格、交易日状态。
- 真实券商下单保持禁止，除非未来建立单独真实资金边界。
- 市场 provider 降级必须暴露 `provider/detail/warning`。

### 6.6 验收标准

- `/quant` 冷启动不再等待全市场数据完成。
- 有旧市场快照时 1 秒内展示旧数据并标注 stale。
- `/api/quant/paper/account` 不依赖完整 dashboard。
- 全市场刷新失败时页面仍可操作。

## 7. 智能体车间改造方案

### 7.1 问题

车间页面当前承担过多职责：

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

### 7.2 目标结构

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

### 7.3 首屏 page-state

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

首屏不返回：

- 全量 events。
- 全量 memories。
- 全量 sources。
- 全量 outbox。
- 完整 work model。
- 大段工具输出。

### 7.4 详情接口拆分

建议拆成：

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

### 7.5 SSE 局部 patch

```text
SSE event
  -> classify event
  -> patch local state
  -> mark affected snapshot stale
  -> background refresh affected panel
```

| 事件 | 影响模块 |
| --- | --- |
| `loop_run_started` | loops, overview |
| `loop_run_completed` | loops, overview, timeline |
| `loop_run_failed` | loops, overview, timeline |
| `outbox_created` | outbox, review |
| `memory_written` | memory |
| `source_checked` | sources |
| `workshop_agent_change_proposed` | review |
| `watchlist_proposal` | review, quant summary |

禁止：

- outbox 事件刷新 memory。
- loop 事件刷新 sources。
- 任一 SSE 事件触发整页详情重拉。

### 7.6 需要处理项结构化

“需要处理”不能每次从事件日志临时推导，否则会出现用户点了“暂不处理”但页面仍然显示的问题。

建议新增：

```ts
type WorkshopReviewItem = {
  id: string;
  workshopId: string;
  sourceEventId: string | null;
  kind: "watchlist_proposal" | "agent_change" | "outbox" | "permission" | "runtime_error";
  status: "pending" | "approved" | "rejected" | "dismissed" | "superseded";
  title: string;
  summary: string | null;
  riskLevel: string | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
};
```

语义：

- `pending`：确实需要用户处理。
- `dismissed`：用户明确表示暂不处理，不应再出现在 pending。
- `approved/rejected`：用户已决策。
- `superseded`：被新事件替代。

索引：

```sql
create index workshop_review_items_workshop_status_idx
on workshop_review_items(workshop_id, status, created_at desc);
```

## 8. 统一记忆与上下文治理方案

### 8.1 问题

当前平台存在多类记忆/历史信息：

- Brain memory。
- Workshop memory。
- Interaction events。
- Raw messages。
- Evidence。
- Graph。
- Legacy discovery。
- Tool outputs。

同一事件可能派生多类记录，如果调用方直接多路拼接，就会导致：

- 同源重复进入上下文。
- prompt 过长。
- 成本上升。
- 召回解释困难。
- 高风险任务可能漏召回边界信息。

### 8.2 目标原则

智能体不直接消费底层记忆表，只消费统一记忆平台返回的 `ContextPack`。

调用方只声明：

- 我是谁。
- 我在哪个页面/车间/loop。
- 我当前状态是什么。
- 我要完成什么任务。
- 是否高风险。
- 需要多少上下文预算。
- 是否需要证据。

统一记忆平台负责：

- 理解需求。
- 生成 RecallPlan。
- 多路召回。
- 边界过滤。
- 去重。
- rerank。
- 压缩投影。
- 生成 ContextPack。
- 写入 context log。

### 8.3 Recall Request

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

### 8.4 Recall Plan

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

### 8.5 去重与 canonical 策略

统一记忆平台应保证：

- 同一 source event 可以派生 observation、candidate、graph relation、snapshot。
- 默认进入 ContextPack 的长期记忆只选择 canonical Brain Memory。
- graph、snapshot、legacy memory 只能作为 evidence、derived ref 或 fallback。
- 同一 canonical group 默认只选择最高价值的一条。
- raw message 不直接进入长期上下文，除非作为 evidence 被显式引用。

### 8.6 ContextPack 输出

```ts
type BrainContextPack = {
  selected: ContextItem[];
  pinned: ContextItem[];
  omitted: Array<{
    id: string;
    reason: string;
  }>;
  denied: Array<{
    id: string;
    reason: string;
  }>;
  warnings: string[];
  trace: {
    recallPlanId: string;
    candidateCount: number;
    selectedCount: number;
    deniedCount: number;
    omittedCount: number;
    routeStats: Record<string, number>;
  };
};
```

### 8.7 验收标准

- Workshop/Loop 默认不再直接拼接多套历史数据。
- 每次智能体运行都有 context log。
- context log 能解释选中、拒绝、省略、去重原因。
- 高风险任务优先召回 boundary、commitment、latest state、stale warning。
- `/api/memory/search` 定位为人工探索和 fallback discovery，不作为默认 runtime context。

## 9. 前端体验策略

### 9.1 统一 hook

建立统一 page-state 客户端封装：

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

### 9.2 Loading 规则

禁止：

- 一个页面级 loading 控制所有模块。
- 每次刷新清空旧数据。
- 慢接口阻塞已有数据展示。

要求：

- 没有任何数据时才显示骨架屏。
- 有旧数据时显示旧数据 + 局部刷新状态。
- 每个 panel 有独立 loading/error。
- 操作按钮只锁定相关按钮，不锁整页。

### 9.3 页面切换

- 主导航 hover 或进入视口时预取 page-state。
- 返回页面时保留 tab、选中 workshop、滚动位置。
- tab 切换时先展示 cached panel。
- 慢 tab 懒加载，但不清空页面 shell。

## 10. 后台预热与刷新任务

### 10.1 启动预热

启动后异步预热：

- `/api/auth/session`
- `/api/page-state/workshop`
- `/api/page-state/quant`
- `/api/quant/paper/account`
- 常用 workshop dashboard
- 全市场量化 snapshot refresh

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

### 10.3 Refresh Job 状态

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

### 11.2 前端体验日志

记录：

- route enter time。
- first shell paint。
- first data visible。
- all critical panels ready。
- tab switch latency。
- manual refresh duration。
- stale snapshot visible time。

### 11.3 慢请求阈值

| 类型 | 阈值 |
| --- | --- |
| 页面首屏 API | 500ms |
| tab 数据 API | 800ms |
| 外部 provider | 3000ms |
| 后台刷新 | 10000ms |
| 全市场数据 | 35000ms |

超过阈值必须记录 trace，并能定位到 DB、provider、Next route、应用逻辑或前端渲染。

## 12. 安全边界

### 12.1 stale 数据边界

stale 快照只用于展示，不能直接用于高风险控制动作。

控制动作必须重新读取最新状态并执行：

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
- 删除数据。
- 发送外部消息。
- 修改系统配置。
- 修改智能体权限边界。

量化模拟盘仍是受控实验环境，目标是暴露策略如何在扰动下失效，而不是证明模型会赚钱。

### 12.3 记忆边界

- 原始消息不是长期记忆。
- Graph 不是事实源。
- Snapshot 不替代 Brain Memory。
- Unified Search 不是默认 runtime ContextPack。
- 高风险任务必须优先召回 boundary 和 evidence。

## 13. 实施计划

### Phase 1：止血

目标：页面不再被慢接口拖死。

任务：

1. 量化页面拆 loading，dashboard 不阻塞 account。
2. quant cache 支持 stale-first 和后台刷新。
3. 新增 `/api/page-state/quant`。
4. Workshop dashboard 请求去重。
5. 新增 `/api/page-state/workshop`。
6. 需要处理项先改成候选事件查询，避免全量扫描。
7. 关键 API 加耗时日志。

验收：

- `/quant` 冷启动 1 秒内显示账户或旧快照。
- `/workshop` 首屏 1 秒内显示车间列表和 shell。
- 热路径接口 p95 < 500ms。

### Phase 2：page-state 化

目标：主页面首屏只依赖轻量 page-state。

任务：

1. 新增 `/api/page-state/workshop/[id]/summary`。
2. Workshop 前端拆成 shell + panels。
3. tab 数据懒加载并缓存。
4. 统一 SWR wrapper。
5. 页面切换预取 page-state。
6. SSE 改成局部 patch。

验收：

- `/workshop` 首屏不拉全量 events/memory/outbox/source。
- tab 切换不清空旧数据。
- SSE 只刷新相关模块。

### Phase 3：快照持久化与后台 worker

目标：慢计算完全离开请求主路径。

任务：

1. page state snapshot 持久化。
2. quant market snapshot 持久化。
3. workshop review items 结构化。
4. 后台 worker 周期刷新。
5. 手动刷新只触发 job，不同步等待慢源完成。

验收：

- 外部 provider 失败不导致主页面不可用。
- 后台刷新失败保留最近成功快照。
- 用户能看到 lastSuccessAt、lastError、refreshing。

### Phase 4：统一记忆 ContextPack 全面接入

目标：降低上下文冗余，提升智能体稳定性和成本效率。

任务：

1. Workshop/Loop 默认通过 Brain Recall 获取 ContextPack。
2. RecallPlan 由大模型理解任务生成，确定性 fallback 兜底。
3. context log 覆盖所有智能体运行。
4. legacy memory/raw message 只作 evidence/fallback。
5. UI 展示 selected/denied/omitted/deduped。

验收：

- 智能体运行不再默认拼接大段历史。
- 每次运行能解释用了哪些记忆、为什么用、为什么拒绝。
- 同源重复记忆不会同时进入 ContextPack。

### Phase 5：体验指标闭环

目标：持续知道哪里慢、为什么慢、改完是否变好。

任务：

1. 前端体验日志。
2. API timing 聚合。
3. 性能 smoke 脚本。
4. 体验 dashboard。
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
- ContextPack 去重只保留 canonical group 最高分项。

### 14.2 集成测试

- 模拟全市场 provider 30 秒超时，`/quant` 仍在 1 秒内可用。
- 模拟 workshop dashboard 慢查询，`/workshop` 仍显示列表和 shell。
- 模拟后台刷新失败，页面展示旧快照和 warning。
- 模拟智能体高风险任务，必须召回 boundary 并记录 context log。

### 14.3 性能 smoke

脚本：

```text
apps/web/scripts/run-ux-performance-smoke.cjs
```

检查：

- `/api/page-state/quant`
- `/api/page-state/workshop`
- `/api/workshops/[id]/dashboard`
- `/api/quant/dashboard`
- `/api/quant/paper/account`
- `/api/memory/search`

输出：

- cold ms。
- warm ms。
- cache hit。
- stale hit。
- response bytes。
- warning count。

## 15. 当前优先级

P0：

1. 量化页面和接口 stale-first。
2. `/api/page-state/quant`。
3. `/api/page-state/workshop`。
4. Workshop 首屏轻量化。
5. 需要处理项结构化。
6. 统一 SWR wrapper。
7. 性能 smoke。

P1：

1. Workshop shell + panels。
2. SSE 局部 patch。
3. 后台预热状态。
4. page-state 持久化策略完善。
5. direct quant APIs stale fallback。

P2：

1. quant market snapshot 独立表。
2. 后台 worker。
3. review items 表。
4. ContextPack 全面替换旧上下文拼接。
5. 体验 dashboard。

## 16. 最终验收口径

用户应感受到：

- 页面切换像成熟 SaaS 一样流畅。
- 慢数据不再拖死整页。
- 系统刷新、降级、失败时能说明状态。
- 智能体不是每次重新计算整个世界，而是消费稳定、可解释、可审计的 ContextPack。
- 成本下降不是靠限制任务，而是靠减少无用上下文、重复召回和重复计算。

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
