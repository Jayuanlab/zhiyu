# 客户体验与页面响应架构改造技术方案

> 最新详细总方案见 [`customer-experience-response-architecture-v4.md`](./customer-experience-response-architecture-v4.md)。本文继续保留为实施主线和历史落地记录，后续代码改造以 V4 的分阶段计划、验收标准和完成定义为准。

## 0. 方案定位

本文用于指导 Zhiyu 当前阶段的客户体验改造，重点解决页面切换卡顿、首屏等待过长、接口冷启动暴露给用户、慢数据阻塞页面、车间页面请求风暴、长期任务状态不够稳定可见等问题。

本方案不是单纯“加缓存”，而是把平台改造成更适合长期控制台产品的形态：

```text
后台持续观测与预热 -> 状态快照服务 -> 页面优先读快照 -> 慢数据异步补齐 -> 事件流局部更新
```

核心原则遵循项目工程控制论口径：

- 先观测，再建模。
- 先闭环，再自动。
- 先边界，再行动。
- 先稳定，再智能。

## 1. 当前问题摘要

### 1.1 用户感知问题

用户看到的问题不是某一个接口慢，而是多个问题叠加：

- 页面切换后白屏或长时间 loading。
- 第一次打开量化页时，全市场数据冷启动会让页面等待 20 秒以上。
- 车间页进入后会并发拉多个接口，用户体感像“整个系统很重”。
- 某些 tab 第一次点击才开始拉重数据，没有旧数据兜底。
- 后台智能体运行、定时任务、SSE 事件会触发多块刷新，页面会突然抖动或变慢。
- 错误和降级没有统一以“这是旧快照 / 正在刷新 / 某个慢源不可用”的方式展示。

### 1.2 已观测到的证据

本次审查实测和日志显示：

- `GET /api/quant/dashboard` 冷请求曾达到约 `25.5s`。
- 同一接口热缓存后约 `33ms - 106ms`。
- `GET /api/quant/paper/account` 热路径约 `58ms - 79ms`，但曾因依赖 dashboard 缓存和路由状态出现更高耗时。
- `GET /workshop` 页面 HTML 请求约 `0.5s - 1.2s`，但进入页面后还会触发多个客户端接口。
- `GET /api/workshops/[id]` 和 `GET /api/workshops/[id]/dashboard` 在 Next 路由冷编译 + DB 冷启动时曾同时达到 `6s - 11s`。
- PostgreSQL 当前量级：
  - `workshops`: 7
  - `workshop_events`: 4700
  - 最大单车间事件数: 2714
  - `interaction_events`: 6005
  - `brain_memories`: 1373

这些数据说明：

- 热路径并不差。
- 体验差主要来自冷启动、缓存过短、请求聚合方式不合理、慢源直接阻塞页面、页面级 loading 粒度太粗。

## 2. 被控对象

本方案的被控对象不是单个接口，而是“用户可感知的交互响应系统”。

### 2.1 页面级被控对象

- `/workshop` 智能体车间控制台。
- `/quant` 量化工作台。
- `/memory` 统一记忆召回页。
- `/loops` Loop 任务页。
- 全局侧边栏、导航、会话状态、用户认证状态。

### 2.2 接口级被控对象

- `/api/quant/dashboard`
- `/api/quant/paper/account`
- `/api/workshops`
- `/api/workshops/[id]`
- `/api/workshops/[id]/dashboard`
- `/api/workshops/[id]/events/stream`
- `/api/workshops/[id]/loops/[loopId]/detail`
- `/api/memory/search`
- `/api/page-state/*`

### 2.3 状态级被控对象

- 量化市场快照。
- 量化模拟盘账户快照。
- 车间摘要快照。
- 车间 dashboard 快照。
- Loop 最近运行摘要。
- 待处理/需确认/异常状态摘要。
- 记忆召回最近结果和召回计划。
- 运行时健康状态。

## 3. 观测输入

### 3.1 技术观测

每个关键请求必须记录：

- route / operation。
- cold or warm。
- cache hit / stale hit / miss。
- DB query time。
- external provider time。
- serialization time。
- response bytes。
- error / warning / fallback。
- requester surface，例如 page load、tab switch、SSE refresh、manual refresh。

现有基础：

- 量化服务已有 `quant_timing` 日志，写入 `tools/quant-service/quant-timing.log`。
- 车间 dashboard 已有 `WorkshopDashboard` 慢日志。
- Next dev 输出能看到 `next.js / proxy / application-code` 分段耗时。

缺口：

- 没有统一的体验指标事件表。
- 前端没有记录首屏可用时间、tab 切换耗时、旧快照展示时间。
- 没有按页面聚合 p50/p95/p99。
- 没有明确区分用户主动刷新和后台静默刷新。

### 3.2 产品观测

每个主页面需要可见：

- 当前展示的是新鲜数据还是旧快照。
- 上次刷新时间。
- 后台是否正在刷新。
- 哪些慢源失败或降级。
- 是否有“可继续使用”的核心数据。
- 是否存在阻塞用户行动的问题。

## 4. 目标体验指标

### 4.1 页面级指标

| 场景 | 当前问题 | 目标 |
| --- | --- | --- |
| 进入 `/workshop` | 多接口并发，冷启动可达数秒 | 1 秒内展示车间列表和上次快照 |
| 切换车间 | 详情和 dashboard 重复拉取 | 300ms 内显示旧快照，后台刷新 |
| 打开车间 tab | 首次点击才拉接口 | 立即显示 tab 框架和旧数据，3 秒内补新数据 |
| 打开 `/quant` | 全市场冷启动阻塞页面 | 1 秒内显示旧市场快照和账户快照 |
| 量化全市场刷新 | 20 秒以上外部数据源 | 后台刷新，不阻塞页面 |
| 记忆召回 | 手动提交后等待不透明 | 展示召回计划、分路进度、局部结果 |

### 4.2 接口级指标

- 页面首屏聚合接口 p95 小于 `500ms`。
- 热缓存读接口 p95 小于 `150ms`。
- 慢外部数据接口不得阻塞主页面首屏。
- 所有超过 `800ms` 的接口必须有结构化耗时日志。
- 所有超过 `3s` 的用户可见操作必须显示阶段进度或旧快照。

### 4.3 稳定性指标

- 冷启动后关键路由预热完成时间小于 `60s`。
- stale 快照可用时，外部慢源失败不导致页面不可用。
- SSE 事件触发后只更新相关局部状态，不触发全页面数据风暴。
- 后台刷新失败必须保留最近可用快照，并展示 warning。

## 5. 目标架构

### 5.1 总体形态

```text
外部数据源 / 数据库 / 智能体运行时 / 用户操作
  -> 观测采集层
  -> 快照构建层
  -> 快照缓存层
  -> 页面状态聚合 API
  -> 前端 stale-first 渲染
  -> 后台刷新 / SSE patch
  -> 用户反馈与操作事件
```

### 5.2 分层说明

#### A. 观测采集层

职责：

- 拉取外部市场数据。
- 查询数据库事件、记忆、任务、账户状态。
- 接收智能体运行事件。
- 记录数据源耗时和失败。

要求：

- 不直接服务页面首屏。
- 允许慢。
- 允许失败。
- 失败必须保留 provider/detail/warning。

#### B. 快照构建层

职责：

- 把原始观测转换成页面可直接消费的结构化状态。
- 聚合出轻量摘要。
- 对慢数据做独立字段降级。

示例：

- `QuantMarketSnapshot`
- `QuantAccountSnapshot`
- `WorkshopSummarySnapshot`
- `WorkshopDashboardSnapshot`
- `LoopSummarySnapshot`
- `MemoryRecallSnapshot`

#### C. 快照缓存层

职责：

- 保存最近可用快照。
- 标记 freshness。
- 支持 stale-first。
- 支持后台刷新写回。

缓存元信息统一：

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

#### D. 页面状态聚合 API

职责：

- 一个页面只需要一个首屏 API。
- 首屏 API 只返回“足够可用”的轻量状态。
- 明细 tab 由独立 API 懒加载。

目标接口：

- `/api/page-state/workshop`
- `/api/page-state/workshop/[id]`
- `/api/page-state/quant`
- `/api/page-state/memory`

#### E. 前端 stale-first 渲染

原则：

- 优先显示上次快照。
- 后台刷新不清空旧 UI。
- 只在没有任何可用快照时显示骨架屏。
- 慢数据有局部 loading，不控制整页 loading。
- 错误以局部 warning 显示，不让页面整体失败。

## 6. 核心改造一：量化工作台

### 6.1 当前问题

`apps/web/app/(chat)/quant/page.tsx` 当前在页面挂载时：

```ts
await Promise.all([
  fetch("/api/quant/dashboard"),
  fetch("/api/quant/paper/account"),
]);
```

问题：

- dashboard 冷启动会拉全市场，可能 20 秒以上。
- paper account 本来很快，却被同一个 loading 绑住。
- 没有旧市场快照兜底。
- 没有页面级“正在后台刷新”提示。

### 6.2 改造目标

- 页面 1 秒内可用。
- 账户、持仓、自选股优先显示。
- 市场温度/成交额/宽度/行业热度使用全市场快照，但必须后台刷新。
- 用户不因全市场冷源等待。

### 6.3 后端改造

新增量化快照模型：

```ts
type QuantPageState = {
  account: QuantPaperAccount | null;
  dashboard: QuantDashboard | null;
  marketSnapshot: QuantMarketOverview | null;
  watchlist: QuantWatchlistItem[];
  meta: SnapshotMeta;
};
```

新增接口：

- `GET /api/page-state/quant`
  - 返回当前可用快照。
  - 如果快照过期，仍返回 stale，并触发后台刷新。
- `POST /api/quant/dashboard/refresh`
  - 手动触发刷新。
  - 返回 job/snapshot 状态，不阻塞等待全市场完成。

量化服务新增：

- `GET /market/snapshot`
- `POST /market/snapshot/refresh`
- `GET /market/snapshot/status`

### 6.4 前端改造

量化页面拆为三个独立数据域：

- `accountState`
- `watchlistState`
- `marketState`

渲染规则：

- `accountState` 可用就先显示资产和持仓。
- `marketState` stale 时显示“上次全市场快照，后台刷新中”。
- `marketState` 缺失时只让市场卡片 loading，不阻塞自选股和账户。
- 全市场刷新失败时，显示 warning，不把市场指标改成自选股指标。

### 6.5 缓存策略

| 数据 | TTL | stale 保留 | 刷新方式 |
| --- | --- | --- | --- |
| paper account | 5s | 1min | 请求时同步刷新 |
| watchlist quotes | 10s | 1min | 请求时同步刷新 |
| market full snapshot | 5min | 30min | 后台预热 + 手动刷新 |
| sector heat | 10min | 60min | 后台刷新 |

### 6.6 验收

- 冷启动打开 `/quant` 不再等待全市场完成。
- 没有 market snapshot 时，账户区仍可在 1 秒内显示。
- 有 stale market snapshot 时，首屏显示旧市场数据并标记 stale。
- 全市场刷新成功后局部更新市场卡片。

## 7. 核心改造二：智能体车间

### 7.1 当前问题

车间页 `workshop-client.tsx` 过大，承担了：

- 列表加载。
- 详情加载。
- dashboard 加载。
- work model 加载。
- sources/memory/outbox/tools/interactions 加载。
- loop detail 加载。
- SSE 事件处理。
- 表单编辑。
- 执行动作。

这导致：

- 页面状态复杂。
- 请求互相触发。
- SSE 事件后容易全量刷新。
- 首屏和 tab 逻辑混在一起。
- 任一慢接口都可能放大用户体感。

### 7.2 首屏状态聚合

新增接口：

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

目标：

- 列表和摘要一次返回。
- 不在首屏返回 80 条事件、30 条记忆、30 条 outbox。
- 不在首屏返回完整 work model。

### 7.3 车间详情拆分

新增接口：

- `GET /api/page-state/workshop/[id]/summary`
- `GET /api/workshops/[id]/events?limit=80`
- `GET /api/workshops/[id]/review-items`
- `GET /api/workshops/[id]/memory-summary`
- `GET /api/workshops/[id]/outbox-summary`
- `GET /api/workshops/[id]/sources-summary`

旧接口 `/api/workshops/[id]` 保留兼容，但不再作为首屏主路径。

### 7.4 前端组件拆分

把 `workshop-client.tsx` 拆为：

```text
WorkshopPageShell
  WorkshopSidebar
  WorkshopHeader
  WorkshopOverviewPanel
  WorkshopLoopsPanel
  WorkshopMemoryPanel
  WorkshopOutboxPanel
  WorkshopSourcesPanel
  WorkshopToolsPanel
  WorkshopBoundaryPanel
```

每个 panel 自己管理：

- 数据 key。
- stale 数据。
- 局部 loading。
- 局部错误。
- 局部刷新。

页面 shell 只管理：

- selectedWorkshopId。
- tab。
- 全局操作状态。
- SSE event patch 分发。

### 7.5 SSE 局部更新

当前 SSE 收到事件后会调用多类 refresh。目标改为：

```text
SSE event -> classify event -> patch local state -> mark affected snapshot stale -> background refresh affected panel
```

事件分类：

| event type | 影响面 |
| --- | --- |
| loop_run_started | local loop/dashboard patch |
| loop_run_completed | local loop/dashboard patch when payload is complete; fallback to dashboard refresh |
| outbox_created | outbox panel |
| memory_written | memory panel |
| source_checked | sources panel |
| workshop_agent_change_proposed | review panel |
| watchlist_proposal | review panel, quant related summary |

原则：

- 不因一个事件刷新整个车间详情。
- 不因 outbox 事件刷新 memory。
- 不因 loop 运行刷新 sources。

### 7.6 待审事件查询优化

当前 `listPendingWorkshopReviewEvents` 会按 workshop 取全量事件再应用内过滤。应改为两步：

第一阶段低风险优化：

- 只查询候选 event types：
  - `workshop_agent_change_proposed`
  - `watchlist_proposal`
  - 对应 resolution types
- 限制时间窗口或 limit。
- 通过 metadata 状态先过滤候选。

第二阶段结构化重构：

新增 `workshop_review_items` 表：

```ts
type WorkshopReviewItem = {
  id: string;
  workshopId: string;
  sourceEventId: string;
  kind: "watchlist_proposal" | "agent_change" | "outbox" | "permission";
  status: "pending" | "approved" | "rejected" | "dismissed" | "superseded";
  title: string;
  summary: string | null;
  riskLevel: string | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
};
```

索引：

```sql
create index workshop_review_items_workshop_status_idx
on workshop_review_items(workshop_id, status, created_at desc);
```

这样待审列表不再扫描事件历史。

## 8. 核心改造三：统一页面缓存与数据获取策略

### 8.1 当前状态

项目已经使用：

- SWR。
- 自定义 `cachedQuantRead`。
- `dashboard-cache.ts`。
- `runtime/status-cache.ts`。

问题：

- 缓存散落。
- TTL 偏短。
- stale-first 语义不统一。
- 页面组件大量手写 `useEffect + fetch`。
- 部分接口 `cache: "no-store"`，导致每次切换都重新打接口。

### 8.2 统一客户端数据策略

建立 `apps/web/lib/page-state/client.ts`：

```ts
type PageStateOptions = {
  dedupingInterval?: number;
  refreshInterval?: number;
  keepPreviousData?: boolean;
  revalidateOnFocus?: boolean;
};

function usePageState<T>(key: string | null, fetcher: () => Promise<T>, options?: PageStateOptions) {
  // 基于 SWR 封装统一默认行为
}
```

默认策略：

- `revalidateOnFocus: false`
- `keepPreviousData: true`
- `dedupingInterval: 5000`
- 错误时保留旧数据。
- 返回 `isInitialLoading`、`isRefreshing`、`isStale`。

### 8.3 统一服务端缓存策略

建立 `apps/web/lib/page-state/cache.ts`：

```ts
type PageStateCacheEntry<T> = {
  value: T;
  generatedAt: number;
  fetchedAt: number;
  expiresAt: number;
  staleUntil: number;
  refreshing: boolean;
};
```

提供：

- `getFreshOrStale`
- `setSnapshot`
- `markRefreshing`
- `invalidateSnapshot`
- `refreshInBackground`

### 8.4 stale-first 返回语义

接口不应只有成功/失败，而应返回：

```ts
type PageStateResponse<T> = {
  data: T;
  meta: SnapshotMeta;
};
```

如果刷新失败但有旧快照：

- HTTP 仍返回 200。
- `meta.stale = true`
- `meta.warnings` 包含失败原因。

只有没有任何可用快照时，才返回 503 或页面级错误。

## 9. 核心改造四：后台预热与刷新

### 9.1 启动预热

当前 dev 启动支持 warmup，但默认 disabled。客户体验环境需要默认预热关键路径。

预热内容：

- `/api/auth/session`
- `/api/page-state/workshop`
- `/api/page-state/quant`
- `/api/quant/paper/account`
- `/api/quant/dashboard` 或量化后台 snapshot refresh
- 常用 workshop dashboard。

注意：

- 预热不应阻塞 Web 服务 ready。
- 预热失败只写日志和状态，不影响启动。
- 页面能看到“后台预热中”状态。

### 9.2 周期刷新

新增后台刷新任务：

| 任务 | 周期 | 说明 |
| --- | --- | --- |
| quant-market-snapshot-refresh | 5min | 拉全市场温度、宽度、成交额、行业热度 |
| quant-account-refresh | 5s-15s | 模拟盘账户和持仓 |
| workshop-summary-refresh | 5s-30s | 车间摘要快照 |
| loop-status-refresh | 5s-30s | Loop 状态 |
| memory-recall-quality-refresh | 10min | 记忆召回质量摘要 |

### 9.3 刷新状态可观测

新增统一刷新状态：

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

页面可以显示：

- 上次刷新成功时间。
- 当前是否后台刷新。
- 刷新失败但仍显示旧快照。

## 10. 核心改造五：接口和数据库查询优化

### 10.1 查询原则

- 首屏不查长历史。
- 列表只查摘要。
- 明细按需查。
- 待审/待处理必须结构化状态查询，不从事件日志里临时推导。
- 事件日志用于审计和回放，不作为所有页面状态的实时计算源。

### 10.2 车间相关优化

短期：

- `getWorkshopDetail` 移除首屏不必要的 `memories/outbox/sources` 明细。
- `listPendingWorkshopReviewEvents` 改为只查候选事件类型。
- dashboard cache TTL 从 2s 提升到 5s-15s，并支持 stale。
- dashboard 请求加 request coalescing，同一 workshop 同时只计算一次。

中期：

- 建立 `workshop_summary_snapshots`。
- 建立 `workshop_review_items`。
- 建立 `loop_summary_snapshots`。

长期：

- 事件写入时同步更新摘要快照。
- 页面完全从快照读取，事件仅用于详情和审计。

### 10.3 量化相关优化

短期：

- 全市场市场快照后台刷新。
- 页面不等待全市场冷启动。
- `paper/account` 不再隐式依赖完整 dashboard。

中期：

- `quant_market_snapshots` 持久化。
- `quant_sector_heat_snapshots` 持久化。
- A 股数据源 provider 分层：
  - fast quote provider
  - full market provider
  - sector provider
  - fundamentals provider

长期：

- 建立市场数据本地镜像。
- 将全市场快照刷新放入独立 worker。

### 10.4 记忆相关优化

短期：

- `/memory` 页面召回结果缓存最近查询。
- 展示召回计划生成、各路召回、去重、排序的阶段进度。
- 搜索失败时保留上次结果。

中期：

- 召回请求生成 `recall_request_id`。
- 每路召回写 `brain_context_logs` 或专门 recall trace。
- 页面可以展开每一路耗时和命中数。

长期：

- 统一记忆平台提供召回快照和召回质量反馈。

## 11. 前端交互改造规范

### 11.1 Loading 规则

禁止：

- 一个页面级 `loading` 控制所有模块。
- 慢接口阻塞已可显示数据。
- 每次刷新清空旧数据。

要求：

- 首次没有任何数据时显示骨架屏。
- 有旧数据时显示旧数据 + 局部刷新标识。
- 每个 panel 有独立 loading/error。
- 操作按钮只锁定相关按钮，不锁整个页面。

### 11.2 页面切换规则

- 路由切换前预取目标页面 bundle。
- 鼠标 hover 或导航进入视口时预取 page-state。
- 返回页面时保留上次 tab、滚动位置、选中车间。
- 切换 tab 时先显示 cached panel。

### 11.3 错误展示规则

错误分三类：

- 阻塞错误：没有任何可用数据，页面无法工作。
- 降级错误：某个 provider 不可用，但有旧快照或部分数据。
- 背景错误：后台刷新失败，不影响当前页面操作。

对应展示：

- 阻塞错误显示主错误页。
- 降级错误显示模块 warning。
- 背景错误显示轻提示或刷新状态，不打断用户。

## 12. 可观测性方案

### 12.1 接口日志

新增统一日志事件：

```ts
type ApiTimingLog = {
  event: "api_timing";
  route: string;
  operation: string;
  ms: number;
  cacheHit?: boolean;
  stale?: boolean;
  cold?: boolean;
  userId?: string;
  workshopId?: string;
  status: "ok" | "error" | "degraded";
  warningCount?: number;
};
```

### 12.2 页面体验日志

前端记录：

- route enter time。
- first shell paint。
- first data visible。
- all critical panels ready。
- tab switch latency。
- manual refresh duration。

### 12.3 慢请求阈值

| 类型 | 阈值 |
| --- | --- |
| 页面首屏 API | 500ms |
| tab 数据 API | 800ms |
| 外部 provider | 3000ms |
| 后台刷新 | 10000ms |
| 全市场数据 | 35000ms |

超过阈值必须记录 trace。

## 13. 实施计划

### Phase 1：止血，先改善用户感知

目标：不做大重构，先让页面不被慢接口拖死。

任务：

1. 量化页拆 loading。
2. 量化 dashboard stale-first。
3. 量化全市场 snapshot 启动后后台预热。
4. 车间详情和 dashboard 请求去重。
5. `listPendingWorkshopReviewEvents` 改为候选事件查询。
6. SWR 默认配置统一为 keep previous data。
7. 关键 API 加慢日志。

验收：

- `/quant` 冷启动 1 秒内显示账户和旧市场区域。
- `/workshop` 冷启动 1 秒内显示列表和选中车间 shell。
- 热切换车间不清空旧内容。

### Phase 2：首屏 page-state 化

目标：让主页面只依赖轻量 page-state。

任务：

1. 新增 `/api/page-state/quant`。
2. 新增 `/api/page-state/workshop`。
3. 新增 `/api/page-state/workshop/[id]/summary`。
4. 前端车间页改为 shell + panels。
5. tab 数据懒加载并缓存。

验收：

- `/workshop` 首屏只调用 1 个 page-state 主接口。
- dashboard/memory/outbox/sources 不再随首屏全量加载。
- tab 切换 300ms 内显示旧数据或空状态。

### Phase 3：快照持久化和后台 worker

目标：慢计算离开请求路径。

任务：

1. 新增 `page_state_snapshots` 或领域独立快照表。
2. 新增 `workshop_review_items`。
3. 新增量化市场快照持久化。
4. 后台 worker 周期刷新。
5. 页面读取快照，手动刷新只触发后台任务。

验收：

- 外部数据源慢不会导致页面阻塞。
- Next 路由只做轻量网关。
- 后台刷新失败页面仍可用。

### Phase 4：体验指标闭环

目标：持续知道客户哪里慢。

任务：

1. 接入页面体验日志。
2. 建立性能 dashboard。
3. 每条主路径有 p50/p95/p99。
4. 每个慢源有 provider 级耗时统计。
5. 建立回归测试和性能 smoke。

验收：

- 每次改动能看到主页面耗时变化。
- 慢接口可定位到 DB、provider、Next 编译、应用逻辑或前端渲染。

## 14. 风险与降级

### 14.1 数据新鲜度风险

stale-first 会带来旧数据展示风险。

处理：

- 页面明确标注刷新时间。
- 交易相关动作检查数据新鲜度。
- stale 数据只允许观察，不允许关键控制动作。

### 14.2 后台刷新失败

处理：

- 保留最近成功快照。
- 记录 `lastError`。
- 页面显示局部 warning。
- 连续失败达到阈值时进入“需要处理”。

### 14.3 缓存一致性

处理：

- 写操作后局部 invalidate。
- SSE patch 先更新本地，再标记相关 snapshot stale。
- 关键操作返回最新局部状态。

### 14.4 过度缓存导致状态错乱

处理：

- 每个 snapshot 必须带 `generatedAt`。
- 重要动作读取服务端最新状态校验。
- 快照只用于展示，控制动作使用领域服务二次校验。

## 15. 测试方案

### 15.1 单元测试

- stale cache 返回旧数据。
- refresh 失败保留旧数据。
- review item 查询不扫描全事件。
- quant page state 在 market 缺失时仍返回 account。
- SSE event 分类 patch 正确。

### 15.2 集成测试

- 冷启动打开 `/quant`，市场慢源模拟 30 秒，页面 1 秒内显示账户。
- 冷启动打开 `/workshop`，详情慢源模拟 5 秒，页面 1 秒内显示列表。
- 切换 tab 不清空旧内容。
- 后台刷新失败时 warning 可见。

### 15.3 性能 smoke

新增脚本：

```text
apps/web/scripts/run-ux-performance-smoke.cjs
```

检查：

- `/api/page-state/quant`
- `/api/page-state/workshop`
- `/api/workshops/[id]/dashboard`
- `/api/quant/dashboard`
- `/api/quant/paper/account`

输出：

- cold ms。
- warm ms。
- cache hit。
- stale hit。
- response bytes。

## 16. 推荐优先级

### P0：必须立即做

1. 量化页拆 loading，不让 dashboard 阻塞账户。
2. 量化市场全量数据改后台预热。
3. 车间页首屏轻量化。
4. 待审事件查询去全量扫描。
5. stale-first 缓存基础设施。

### P1：短期做

1. `/api/page-state/workshop`。
2. `/api/page-state/quant`。
3. SSE 局部 patch。
4. 统一 SWR wrapper。
5. 页面体验日志。

### P2：中期做

1. 快照持久化。
2. review items 表。
3. runtime worker 接管慢刷新。
4. 性能 dashboard。

## 17. 最终目标

客户应该感受到：

- 页面切换像普通成熟 SaaS 一样流畅。
- 慢数据不会让整个页面卡死。
- 系统正在做什么、哪里慢、是否用旧数据，都能看懂。
- 智能体车间像一个稳定运行的控制台，而不是每次打开都重新计算世界。

技术上要达到：

```text
请求路径轻量化
状态快照化
慢源后台化
前端 stale-first
事件局部 patch
体验指标闭环
```

## 18. 当前落地记录

### 18.1 已落地的体验止血项

- 已新增 page-state 快照持久化能力，使用 `page_state_snapshots` 保存页面级最近可用状态。
- 已新增 `/api/page-state/quant`，量化首页可以优先读取旧快照，并在 stale 时后台刷新。
- 已新增 `/api/page-state/workshop`，车间首页可以先返回轻量列表与摘要快照，不把 dashboard 全量计算阻塞在首屏。
- 已新增 `/api/page-state/workshop/[id]/summary`，车间详情摘要可以读取持久 page-state 快照，并将事件列表裁剪为有界摘要，避免首屏详情接口携带大段历史。
- 已新增车间 SSE 局部刷新策略，`memory_*`、`outbox_*`、`source_*`、`loop_*`、`workshop_agent_change_*` 等事件只刷新相关 panel，不再默认把已加载的 dashboard/work/sources/memories/outbox 全部刷新。
- 已为 `/api/page-state/workshop/[id]/summary` 增加 `?refresh=1` 强制重建路径：普通进入页面继续 stale-first 读快照，SSE/写后刷新会绕过快照并写回最新 summary，避免用户操作后短时间读到旧状态。
- 已新增统一 `usePageState` 客户端封装，默认保留旧数据，降低页面切换和 tab 切换时的清空感。
- 已新增 quant direct snapshot 兜底，`/api/quant/paper/account` 和 `/api/quant/dashboard` 可以优先返回持久快照，同时后台刷新。
- 已新增量化 page-state 合并保护：当刷新超时或只返回稀疏结果时，不再用空 account/dashboard 覆盖上一份可用快照。
- 已新增 UX smoke 脚本 `apps/web/scripts/run-ux-performance-smoke.cjs`，覆盖 page-state、量化 direct API、memory search 和 workshop dashboard。
- 已将产品区普通导航改为 navigation-first 体验：`(chat)/loading.tsx`、`workshop/loading.tsx`、`workspace/loading.tsx`、`inbox/loading.tsx` 不再渲染阻塞式全屏 skeleton。
- 已将 `/quant` 从整页 `initialLoading` 改为局部加载：模拟盘账户和全市场快照分别显示加载/失败/旧快照状态。
- 已将 `/workshop` 首屏从提前返回 `WorkshopLoadingShell` 改为先渲染车间框架，列表和详情区域自行表达加载中或空态。

### 18.2 本轮验证结果

本轮验证命令：

```text
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web exec vitest run tests/unit/quant-page-state.test.ts tests/unit/quant-cache.test.ts tests/unit/memory-search-cache.test.ts tests/unit/workshop-page-state-cache.test.ts tests/unit/workshop-page-state-warmup.test.ts
pnpm --filter web smoke:ux
```

本轮 smoke 热路径结果：

```text
/api/page-state/quant: 21ms
/api/page-state/workshop: 17ms
/api/quant/paper/account: 28ms
/api/quant/dashboard: 22ms
/api/memory/search: 17ms
/api/workshops/[id]/dashboard: 28ms
```

新增车间详情摘要 page-state 后的 smoke 热路径补充结果：

```text
/api/page-state/workshop/[id]/summary: 239ms, 约 57KB
/api/page-state/workshop/[id]/summary?refresh=1: 155ms, 约 57KB
```

新增 SSE 局部刷新策略后的测试覆盖：

```text
memory_written -> detail + memories
outbox_draft -> detail + outbox
loop_run_completed -> detail + dashboard + selected loop detail
workshop_agent_change_applied -> detail + work + dashboard
agent_text/tool_result/source_checked -> 只写入事件流，不触发详情刷新
```

新增待处理项结构化后的验证：

```text
pnpm --filter web exec vitest run tests/unit/workshop-review-items.test.ts tests/unit/workshop-agent-change-proposals.test.ts tests/unit/watchlist-proposals.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web db:migrate
pnpm --filter web smoke:ux
```

本轮落地内容：

- 已新增 `workshop_review_items` 结构化表，用于保存车间待处理项的主状态。
- 已新增 `apps/web/lib/workshops/review-items.ts`，把 `workshop_agent_change_proposed` 和人工确认型 `watchlist_proposal` 投影为 `pending` review item。
- 已将智能体配置提案创建、应用、驳回、重建接入 review item 写入和关闭。
- 已将自选股提案应用、驳回和幂等已处理路径接入 review item 关闭。
- 已新增 `/api/workshops/[id]/review-items`，支持读取 pending review items，并支持将结构化待处理项更新为 `approved`、`rejected`、`dismissed` 或 `superseded`。
- `listPendingWorkshopReviewEvents` 仍保留旧事件 fallback，但如果同源 review item 已经被 `dismissed/rejected/approved/superseded`，旧 proposal 事件不会再被 fallback 重新带回待处理列表。
- UX smoke 通过；本轮热路径结果中 `/api/page-state/quant` 43ms、`/api/page-state/workshop` 55ms、`/api/quant/paper/account` 43ms、`/api/quant/dashboard` 39ms、`/api/page-state/workshop/[id]/summary` 589ms、`/api/workshops/[id]/dashboard` 73ms。`/api/memory/search` 为 2149ms，仍在 slowApi 阈值内，但后续需要继续优化召回链路。

新增 review tab 结构化接入后的验证：

```text
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web exec vitest run tests/unit/workshop-review-items.test.ts tests/unit/workshop-agent-change-proposals.test.ts tests/unit/watchlist-proposals.test.ts tests/unit/workshop-live-refresh-policy.test.ts
pnpm --filter web smoke:ux
```

本轮落地内容：

- `workshop-client.tsx` 的 review tab 已接入 `/api/workshops/[id]/review-items`。
- review tab 打开时并行加载结构化待处理项和视频草稿，不再只依赖 `detail.events` 前端推导。
- 结构化 review item 加载成功后，以 `workshop_review_items` 为待处理主状态；接口尚未加载时才使用旧事件推导 fallback。
- agent change proposal 和 watchlist proposal 卡片增加“暂不处理”动作，调用 `/api/workshops/[id]/review-items` 写入 `dismissed`，再刷新 review items 和 detail。
- SSE 收到 `workshop_agent_change_*`、`watchlist_proposal*` 事件时，如果当前在 review tab，会刷新结构化 review items。
- 没有可用 source event 的结构化待处理项也会显示为通用 review item，避免后端已判定需要处理但页面无法处理。
- UX smoke 通过；本轮热路径结果中 `/api/page-state/quant` 26ms、`/api/page-state/workshop` 16ms、`/api/quant/paper/account` 33ms、`/api/quant/dashboard` 26ms、`/api/memory/search` 17ms、`/api/page-state/workshop/[id]/summary` 27ms、`/api/workshops/[id]/dashboard` 22ms。

新增 loop blocker 结构化接入后的验证：

```text
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web exec vitest run tests/unit/workshop-review-items.test.ts tests/unit/workshop-dashboard.test.ts tests/unit/work-runtime-commands.test.ts tests/unit/workshop-live-refresh-policy.test.ts
pnpm --filter web smoke:ux
```

本轮落地内容：

- dashboard 刷新会把 `dashboardStatus=blocked/error` 的 Loop 同步为 `workshop_review_items.kind=loop_blocker`。
- Loop blocker review item 使用 `metadata.loopId` 作为收口键，避免同一个 blocked loop 在多次 dashboard 刷新后重复生成。
- 当 Loop 在最新 dashboard 中不再 blocked/error 时，旧 `loop_blocker` 会被标记为 `superseded`。
- `clearWorkLoopBlocker` 命令会把同 Loop 的 pending `loop_blocker` 标记为 `dismissed`，和页面“暂不处理”的业务语义一致。
- workshop 页面 attention 区在结构化 `loop_blocker` 已加载时，不再重复显示 dashboard 派生的同一 blocked loop。
- UX smoke 通过；本轮热路径结果中 `/api/page-state/quant` 36ms、`/api/page-state/workshop` 49ms、`/api/quant/paper/account` 38ms、`/api/quant/dashboard` 32ms、`/api/memory/search` 750ms、`/api/page-state/workshop/[id]/summary` 284ms、`/api/workshops/[id]/dashboard` 71ms。

新增权限边界结构化接入后的验证：

```text
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web exec vitest run tests/unit/workshop-review-items.test.ts tests/unit/workshop-agent-change-proposals.test.ts tests/unit/watchlist-proposals.test.ts tests/unit/work-runtime-resources.test.ts tests/unit/workshop-outbox-autosend.test.ts
pnpm --filter web smoke:ux
```

本轮落地内容：

- `review-items.ts` 已新增 `permission_boundary` 投影能力，把 `status=blocked` 的 outbox 边界失败收口为结构化待处理项。
- outbox 边界失败不再只依赖 `outbox_blocked` 历史事件展示；同一个 `outboxId` 会复用同一个 pending review item，避免多次预览/发送失败生成重复“需要处理”。
- `previewWorkshopOutboxWechat` 和 `sendWorkshopOutboxWechat` 在边界拦截时会写入/更新 `workshop_review_items.kind=permission_boundary`。
- 当用户修改 outbox 收件人、预览通过或发送成功时，同 `outboxId` 的 pending `permission_boundary` 会被标记为 `superseded` 或 `approved`，避免“已经修正/暂不处理后仍挂在需要处理里”。
- 页面已经通过通用 review item 卡片承接该类非 proposal 待处理项，因此后端判定为需要处理的权限边界问题可以在 review tab 中被看见并被“暂不处理”。
- `review-items.ts` 已新增 `service_error` 投影能力，把用户可见的 `tool_error`、`work_outbox_send_failed`、`outbox_auto_send_failed` 收口为结构化待处理项。
- 服务异常使用 `event.type + loop/run scope + toolName/title` 作为收口键，同一个 Loop 内同一工具连续失败会更新同一个 pending review item，避免异常风暴把“需要处理”列表刷屏。
- `appendWorkshopEvent` 会在事件写入后尝试投影服务异常；投影失败只记录 warning，不影响原始事件写入和 SSE 发布。
- `service_error` 同样通过通用 review item 卡片展示和关闭，因此“服务异常”不再只是时间线里的错误文本，而是可被用户处理或暂不处理的结构化状态。
- UX smoke 通过；本轮热路径结果中 `/api/page-state/quant` 46ms、`/api/page-state/workshop` 56ms、`/api/quant/paper/account` 47ms、`/api/quant/dashboard` 43ms、`/api/memory/search` 949ms、`/api/page-state/workshop/[id]/summary` 364ms、`/api/workshops/[id]/dashboard` 133ms。

新增服务异常同类关闭后的验证：

```text
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web exec vitest run tests/unit/workshop-review-items.test.ts tests/unit/workshop-agent-change-proposals.test.ts tests/unit/watchlist-proposals.test.ts tests/unit/work-runtime-resources.test.ts tests/unit/workshop-outbox-autosend.test.ts
pnpm --filter web smoke:ux
```

本轮落地内容：

- `review-items.ts` 已新增 `resolveWorkshopServiceErrorGroupReviewItems`，以某个 pending `service_error` 为锚点，按 `metadata.serviceKey` 关闭同类 pending 服务异常。
- `/api/workshops/[id]/review-items` 已支持 `action=dismiss_group`，并限制为 `dismissed` 语义，避免误用到审批通过/驳回这类强业务动作。
- `workshop-client.tsx` 的通用 review item 卡片在 `kind=service_error` 时显示“关闭同类”，用户可以一次性关闭同一 Loop/运行范围内同一工具的重复异常。
- 该能力不改变原始事件和审计记录，只更新结构化待处理主状态；“暂不处理”仍表示用户已知晓并主动延后/忽略，不要求重跑。
- UX smoke 通过；本轮热路径结果中 `/api/page-state/quant` 38ms、`/api/page-state/workshop` 54ms、`/api/quant/paper/account` 43ms、`/api/quant/dashboard` 41ms、`/api/memory/search` 915ms、`/api/page-state/workshop/[id]/summary` 379ms、`/api/workshops/[id]/dashboard` 62ms。

新增 UX smoke 本地历史报告后的验证：

```text
pnpm --filter web smoke:ux
pnpm --filter web tsc --noEmit --pretty false
```

本轮落地内容：

- `apps/web/scripts/run-ux-performance-smoke.cjs` 已新增报告输出能力，默认写入 `apps/web/.ux-smoke/`。
- 每次运行会生成 `latest.json`、`latest.md` 和追加 `history.jsonl`，包含 baseUrl、模式、阈值、discovery、warmup、measured hot-path、失败列表和 cache/stale/refreshing/warning 标记。
- `.ux-smoke/` 已加入 `.gitignore`，作为本地观测产物保留，不污染工作树提交。
- smoke 失败时也会先落盘报告，再按原逻辑退出失败，方便后续定位是哪个接口、哪个阈值、哪种缓存状态出问题。
- 本轮生成的人可读报告为 `apps/web/.ux-smoke/latest.md`；最新 measured hot-path 为 `/api/page-state/quant` 36ms、`/api/page-state/workshop` 30ms、`/api/quant/paper/account` 21ms、`/api/quant/dashboard` 28ms、`/api/memory/search` 18ms、`/api/page-state/workshop/[id]/summary` 33ms、`/api/workshops/[id]/dashboard` 27ms。

新增 UX smoke 历史趋势聚合后的验证：

```text
pnpm --filter web smoke:ux
pnpm --filter web tsc --noEmit --pretty false
```

本轮落地内容：

- `latest.json` 已新增 `trends` 字段，从 `history.jsonl` 聚合每个 measured hot-path 检查项的 `samples`、`latestMs`、`p50Ms`、`p95Ms`、`maxMs`、`thresholdMs` 和 `overThreshold`。
- `latest.md` 已新增 `History Trend` 表，可以直接查看每个接口的样本数、最近耗时、p50、p95、最大值和阈值。
- 趋势聚合对少样本稳定可用，只有 1-2 次运行时也会给出当前可解释的分位数；样本增长后自动演进为长期趋势指标。
- 本轮报告样本数为 2；最新趋势中 `/api/page-state/quant` p50=36ms、p95=41ms，`/api/page-state/workshop` p50=30ms、p95=36ms，`/api/memory/search` p50=18ms、p95=20ms，`/api/workshops/[id]/dashboard` p50=25ms、p95=27ms。

新增 UX 性能可视化 dashboard 后的验证：

```text
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
GET /api/ux-performance
GET /ux-performance
```

本轮落地内容：

- 已新增 `apps/web/lib/ux-smoke/report.ts`，集中读取 `.ux-smoke/latest.json` 和 `history.jsonl`，并复用趋势聚合逻辑。
- 已新增 `GET /api/ux-performance`，登录后返回最新 UX smoke 报告、历史样本数、趋势数据和本地报告路径。
- 已新增 `/ux-performance` 页面，作为平台内可视化性能观察台，展示样本数、超阈值数量、最慢 p95、每条热路径的 latest/p50/p95/max/threshold 和 p95 负载条。
- 已在侧边栏新增“性能观察”入口，使用现有 dashboard 图标，不引入新的前端图表依赖。
- 页面只读本地报告，不主动触发 smoke，因此观察 dashboard 本身不会制造额外性能噪声。
- 本轮验证中 `/api/ux-performance` 和 `/ux-performance` 均可访问；`smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 49ms、`/api/page-state/workshop` 96ms、`/api/quant/paper/account` 313ms、`/api/quant/dashboard` 44ms、`/api/memory/search` 801ms、`/api/page-state/workshop/[id]/summary` 327ms、`/api/workshops/[id]/dashboard` 65ms。

新增 UX 性能窗口筛选和 p99 后的验证：

```text
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
GET /api/ux-performance?window=2
GET /ux-performance?window=2
```

本轮落地内容：

- `apps/web/lib/ux-smoke/report.ts` 的趋势聚合已新增 `p99Ms`，并支持 `window` 参数，仅使用最近 N 次 smoke 历史计算趋势。
- `GET /api/ux-performance?window=N` 会返回 `trendWindow`、`trendSampleCount` 和窗口内趋势，便于后续接告警或外部 dashboard。
- `/ux-performance?window=N` 页面已支持最近 10、20、50 次和全量历史切换，并在表格中展示 p99。
- `apps/web/scripts/run-ux-performance-smoke.cjs` 生成的 `latest.json` 和 `latest.md` 也已包含 p99。
- 本轮验证中 `GET /api/ux-performance?window=2` 返回 `trendWindow=2`、`trendSampleCount=2` 且包含 `p99Ms`；`GET /ux-performance?window=2` 可访问并包含窗口说明和 p99 列。
- 最新 smoke 样本数为 4；最新 measured hot-path 为 `/api/page-state/quant` 37ms、`/api/page-state/workshop` 65ms、`/api/quant/paper/account` 42ms、`/api/quant/dashboard` 37ms、`/api/memory/search` 760ms、`/api/page-state/workshop/[id]/summary` 344ms、`/api/workshops/[id]/dashboard` 65ms。

新增页面级前端体验指标后的验证：
```text
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
POST /api/ux-performance/page-events
GET /api/ux-performance?window=2
GET /ux-performance?window=2
```

本轮落地内容：
- 已新增 `apps/web/components/ux-page-metrics-probe.tsx`，在登录后主布局中用轻量客户端探针采集 `route_visible_ms`、`route_duration_ms` 和 `initial_navigation_ms`，采集过程只使用 refs、`requestAnimationFrame`、`sendBeacon`/`fetch keepalive`，不引入页面可见 UI 和额外 React state。
- 已新增 `POST /api/ux-performance/page-events`，对浏览器上报的页面体验事件做白名单、批量大小、路径长度和耗时范围校验，再追加写入 `apps/web/.ux-smoke/page-events.jsonl`。
- 已新增 `apps/web/lib/ux-smoke/page-events.ts`，负责页面体验事件的本地 JSONL 读写和 p50/p95/p99/max 趋势聚合。
- `GET /api/ux-performance` 已返回 `pageMetrics`，把 API hot-path smoke 和真实页面体验事件放在同一个性能观察数据面板中，但仍保持两类指标分开展示。
- `/ux-performance` 已新增 `Page Experience` 区块，展示每个 path + metric 的样本数、latest、p50、p95、p99 和 max，开始补齐原方案中“前端体验指标事件表”的缺口。
- 本轮验证中 `POST /api/ux-performance/page-events` 返回 `accepted=1`；`GET /api/ux-performance?window=2` 返回 `pageMetrics.sampleCount=1`、`pageMetrics.trends.length=1`；`GET /ux-performance?window=2` 可访问并包含 `Page Experience` 和 `Route Visible`。
- `pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 111ms、`/api/page-state/workshop` 237ms、`/api/quant/paper/account` 259ms、`/api/quant/dashboard` 114ms、`/api/memory/search` 1023ms、`/api/page-state/workshop/[id]/summary` 614ms、`/api/page-state/workshop/[id]/summary?refresh=1` 87ms、`/api/workshops/[id]/dashboard` 103ms。

新增 SSE panel-only 刷新收窄后的验证：
```text
pnpm --filter web exec vitest run tests/unit/workshop-live-refresh-policy.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `apps/web/lib/workshops/live-refresh-policy.ts` 已将 `memory_written/memory_reviewed`、`source_added` 和 `outbox_*` 类事件从 `detail=true` 收窄为 `detail=false + panels=[对应 panel]`。这些事件仍会追加到 timeline，但不再默认触发 `/api/page-state/workshop/[id]/summary?refresh=1`。
- `workshop-client.tsx` 的 `refreshLiveDetail` 已按 `plan.detail` 决定是否刷新 summary。对于 panel-only 事件，如果对应 panel 没有打开过，则不发额外请求；如果 panel 已加载，则只刷新该 panel。
- Loop 完成/失败、Work model 变更等会影响概览、下次运行、边界或 dashboard 的事件仍保留 `detail=true`，避免过度收窄导致首屏摘要失真。
- `tests/unit/workshop-live-refresh-policy.test.ts` 已更新并新增 source panel 覆盖，防止 memory/outbox/source 事件未来又退回“顺手刷新 summary”的行为。
- 本轮验证中 `workshop-live-refresh-policy.test.ts` 6 项通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 38ms、`/api/page-state/workshop` 53ms、`/api/quant/paper/account` 38ms、`/api/quant/dashboard` 29ms、`/api/memory/search` 756ms、`/api/page-state/workshop/[id]/summary` 264ms、`/api/page-state/workshop/[id]/summary?refresh=1` 53ms、`/api/workshops/[id]/dashboard` 58ms。

新增 review/attention 局部刷新后的验证：
```text
pnpm --filter web exec vitest run tests/unit/workshop-live-refresh-policy.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `WorkshopLiveRefreshPanel` 已新增 `review`，把结构化待处理项从“靠 detail summary 顺带刷新”提升为独立局部刷新对象。
- `tool_error` 不再作为纯 timeline ignored event，而是进入 `review` panel-only 刷新；这和后端 `service_error` 投影一致，避免用户正在 review/attention 页面时看不到新服务异常。
- `workshop_agent_change_proposed` 改为 `detail=false + panels=["review"]`，配置提案产生时只刷新结构化待处理，不再默认刷新 work/dashboard summary。
- `workshop_agent_change_applied/rejected/superseded` 保留 `detail=true` 和 work/dashboard 刷新，同时追加 `review`，保证配置变更后的概览和待处理状态都能同步。
- `watchlist_proposal*`、`outbox_blocked`、`outbox_auto_send_failed`、`work_outbox_send_failed` 等事件会刷新 `review`；其中 outbox failure 同时刷新已加载的 outbox panel。
- `workshop-client.tsx` 的 live refresh 执行层已支持 `review` panel：当 `reviewItems` 已加载，或当前在 `review/attention` tab 时，SSE 会刷新 `/api/workshops/[id]/review-items`；否则不额外请求。
- 原本 SSE handler 里针对 review tab 的手写 `refreshReviewItems` 分支已删除，避免同一事件通过 live plan 和手写分支重复请求。
- 本轮验证中 `workshop-live-refresh-policy.test.ts` 10 项通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 26ms、`/api/page-state/workshop` 25ms、`/api/quant/paper/account` 25ms、`/api/quant/dashboard` 27ms、`/api/memory/search` 17ms、`/api/page-state/workshop/[id]/summary` 27ms、`/api/page-state/workshop/[id]/summary?refresh=1` 76ms、`/api/workshops/[id]/dashboard` 33ms。

新增 outbox SSE 本地 patch 后的验证：
```text
pnpm --filter web exec vitest run tests/unit/workshop-live-refresh-policy.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `workshop-client.tsx` 已新增 `patchOutboxListFromEvent`，对 `outbox_draft`、`outbox_preview_ready`、`outbox_sent`、`outbox_blocked`、`outbox_auto_send_blocked`、`outbox_auto_send_failed` 和 `work_outbox_send_failed` 做前端本地状态 patch。
- `outbox_draft` 事件可基于 `metadata.outboxId/channel/recipientName/status/confidence/riskLevel` 和事件正文插入一条轻量 outbox 项；后续打开 outbox panel 仍会按原逻辑拉取完整列表。
- 预览、发送、边界阻塞和失败事件只更新已存在 outbox 项的 `status`、`recipientName` 和可展示的 `boundaryResult` 局部信息，不凭不完整事件伪造完整对象。
- SSE handler 在 outbox patch 成功时会从 live refresh plan 中移除 `outbox` panel，避免同一个事件既本地更新又请求 `/api/workshops/[id]/outbox`。
- 该 patch 会同步影响 attention 中由 `detail.outbox` 派生的边界阻塞项：例如已加载的 blocked 草稿被 `outbox_sent` patch 为 sent 后，不再继续作为 outbox attention 显示。
- 本轮验证中 `workshop-live-refresh-policy.test.ts` 10 项通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 32ms、`/api/page-state/workshop` 18ms、`/api/quant/paper/account` 41ms、`/api/quant/dashboard` 33ms、`/api/memory/search` 30ms、`/api/page-state/workshop/[id]/summary` 45ms、`/api/page-state/workshop/[id]/summary?refresh=1` 65ms、`/api/workshops/[id]/dashboard` 25ms。

新增 memory/source SSE 本地 patch 后的验证：
```text
pnpm --filter web exec vitest run tests/unit/workshop-live-refresh-policy.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `workshop-client.tsx` 已新增 `patchMemoryListFromEvent` 和 `patchSourceListFromEvent`，继续推进“timeline 事件先本地应用，再决定是否请求 panel API”的方向。
- `memory_written` 在事件包含 `metadata.memoryId` 时，会基于事件正文和 `kind/confidence/tags/status/sourceEventIds` 插入或更新一条轻量 memory 项；后续打开 memory panel 仍按原逻辑拉取完整列表和召回质量报告。
- `memory_reviewed` 在当前列表已存在对应 memory 时，会本地更新该项 `status`；若列表中没有该 memory，则不伪造对象，保留原 panel 刷新路径。
- `source_added` 在事件包含 `metadata.sourceId` 时，会基于事件正文和 `type/uri` 插入或更新一条轻量 source 项；content 等完整字段仍以后续 sources API 为准。
- SSE handler 会在 memory/source patch 成功时，从 live refresh plan 中移除 `memories` 或 `sources` panel，避免同一事件既本地更新又请求 `/api/workshops/[id]/memories` 或 `/api/workshops/[id]/sources`。
- 这轮 patch 仍保持保守：只有事件里有稳定 id 且能表达最小 UI 状态时才拦截请求；信息不足时继续走 panel API，避免用不完整事件伪造长期状态。
- 本轮验证中 `workshop-live-refresh-policy.test.ts` 10 项通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 43ms、`/api/page-state/workshop` 27ms、`/api/quant/paper/account` 26ms、`/api/quant/dashboard` 31ms、`/api/memory/search` 29ms、`/api/page-state/workshop/[id]/summary` 42ms、`/api/page-state/workshop/[id]/summary?refresh=1` 69ms、`/api/workshops/[id]/dashboard` 27ms。

新增 loop/dashboard SSE 本地 patch 后的验证：
```text
pnpm --filter web exec vitest run tests/unit/workshop-live-refresh-policy.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `workshop-client.tsx` 已新增 `patchWorkshopDashboardFromEvent`、`patchLoopDetailFromEvent` 和相关 loop run patch helper，对 `loop_run_started`、`loop_run_completed`、`loop_run_failed` 事件做保守的前端本地状态更新。
- `loop_run_started` 事件会在已有 dashboard 或当前 loop detail 已加载时，本地更新该 Loop 的 `latestRun.status=running`，不触发 summary/dashboard 重拉；`workshop-live-refresh-policy.test.ts` 已新增用例锁住该事件的本地化策略。
- `loop_run_completed` 会基于 `loopId`、`loopRunId`、`metadata.status/duration/summary` 和事件正文更新 dashboard loop、selected loop detail、latestEvent、blocked/error 计数，并在本地 patch 成功时从 live refresh plan 中移除 `dashboard` 和已 patch 的 `loopDetail`，进一步减少同一 SSE 事件造成的 panel API 重拉。
- `loop_run_failed` 虽然也会本地更新 dashboard 和 loop detail 的错误状态，但不会移除服务端刷新；原因是 dashboard 刷新链路还承担 `loop_blocker` review item 投影，失败事件必须继续保证结构化待处理项不丢。
- SSE handler 现在对 outbox、memory、source、dashboard、loopDetail 都采用“先本地 patch，再决定是否保留 API refresh”的模式；信息不足或状态有审计副作用时仍回到服务端主状态，避免用不完整事件伪造长期状态。
- 本轮验证中 `workshop-live-refresh-policy.test.ts` 11 项通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 36ms、`/api/page-state/workshop` 21ms、`/api/quant/paper/account` 44ms、`/api/quant/dashboard` 43ms、`/api/memory/search` 29ms、`/api/page-state/workshop/[id]/summary` 43ms、`/api/page-state/workshop/[id]/summary?refresh=1` 58ms、`/api/workshops/[id]/dashboard` 26ms。

新增上下文体检 section 聚合与 dashboard 可视化后的验证：
```text
pnpm --filter web exec vitest run tests/unit/workshop-dashboard.test.ts tests/unit/workshop-dashboard-cache.test.ts tests/unit/workshop-summary-page-state.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `summarizeWorkshopContextCost` 已从只展示平均 prompt tokens 和最大 section，扩展为按 `context_budget_report.metadata.sections` 聚合每个 section 的 `latestChars`、`latestEstimatedTokens`、`latestPromptShare`、`avgEstimatedTokens`、`maxEstimatedTokens` 和 `overBudgetCount`。
- `WorkshopDashboard.contextCost.sectionStats` 现在可以直接告诉页面最近一次 agent prompt 中 `sources`、`memories`、`memoryContext`、`directives`、`events`、`outbox` 等来源各占多少上下文，从而定位“上下文过长到底肥在哪一段”。
- 车间 dashboard 已新增“上下文体检”区块，不新增接口请求，直接消费 dashboard 返回的 `contextCost`：展示最近一次 prompt token 估算、profile、平均 tokens、最大来源和前 4 个 section 占比/超限次数。
- 这轮改造没有把成本作为硬限制，只把上下文输入结构变成可观测状态，符合“合理上下文不应被成本限制，但必须知道无用信息从哪里进入”的方向。
- 本轮验证中 dashboard 相关 3 个测试文件共 11 项通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 63ms、`/api/page-state/workshop` 84ms、`/api/quant/paper/account` 50ms、`/api/quant/dashboard` 50ms、`/api/memory/search` 942ms、`/api/page-state/workshop/[id]/summary` 303ms、`/api/page-state/workshop/[id]/summary?refresh=1` 51ms、`/api/workshops/[id]/dashboard` 66ms。

新增单次 run/loop ContextPack trace 下钻后的验证：
```text
pnpm --filter web exec vitest run tests/unit/brain-context-pack.test.ts tests/unit/workshop-loop-detail.test.ts tests/unit/loop-context-window.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `brain/context.ts` 已新增 `summarizeBrainContextPackForTrace`，把完整 Brain ContextPack 转成轻量可审计投影：`selection`、选中记忆的 subject/preview/score/reasons/evidenceRefCount/canonicalKind/canonicalGroupId，以及 omitted/denied 原因和 warnings。
- Workshop executor 与 Loop native executor 在写 `memoryRecall` 事件元数据时，已附带 `contextPack` trace summary；这不是把完整记忆全文重新塞进事件，而是保留足够解释“为什么进上下文/为什么没进上下文”的轻量证据。
- `getWorkshopLoopDetail` 已透传 `memoryRecall.contextPack`，Loop 详情页可以在单次运行层面看到 Brain 召回选中的记忆、canonical 分组、命中原因、omitted 原因和 denied 原因。
- `LoopMemoryRecallPanel` 和 timeline 中的 `MemoryRecallEventCard` 已新增 `BrainContextTraceDetails` 下钻视图，用户不用翻数据库或原始事件，就能看到每次智能体运行到底消费了哪些长期记忆。
- 本轮验证中 Brain/Loop 相关 3 个测试文件共 22 项通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 53ms、`/api/page-state/workshop` 81ms、`/api/quant/paper/account` 56ms、`/api/quant/dashboard` 44ms、`/api/memory/search` 878ms、`/api/page-state/workshop/[id]/summary` 362ms、`/api/page-state/workshop/[id]/summary?refresh=1` 75ms、`/api/workshops/[id]/dashboard` 151ms。

新增 ContextPack trace 聚合进召回质量报告后的验证：
```text
pnpm --filter web exec vitest run tests/unit/brain-recall-quality.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `buildBrainRecallQualityReport` 已新增 `traceQuality`，把单次 `brain-context-trace.v1` 聚合成长期质量指标：trace 数、selected/omitted/denied 数、无证据选中数、warning 数、选中 memoryType/canonicalKind、selected/omitted/denied 的主要原因和高频 omitted/denied memory id。
- `inspectWorkshopMemoryRecallQuality` 现在会从同一批 workshop events 中提取 `metadata.memoryRecall.contextPack`，与 context logs 和 feedback events 一起返回，不新增页面请求，也不暴露记忆正文。
- 车间 memory panel 的 `Recall quality` 卡片已展示 ContextPack trace 聚合摘要，让用户能从长期视角看到“哪些记忆经常被省略/拒绝/无证据选中”，而不只看单次运行明细。
- 这轮改造继续遵循“不要用成本硬限制上下文”的方向：质量报告用于定位分类、去重、证据和权限问题，帮助减少无用上下文进入 prompt。
- 本轮验证中 `brain-recall-quality.test.ts` 3 项通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 51ms、`/api/page-state/workshop` 71ms、`/api/quant/paper/account` 57ms、`/api/quant/dashboard` 61ms、`/api/memory/search` 855ms、`/api/page-state/workshop/[id]/summary` 391ms、`/api/page-state/workshop/[id]/summary?refresh=1` 83ms、`/api/workshops/[id]/dashboard` 82ms。

新增 requester 级 ContextPack trace 质量拆分后的验证：
```text
pnpm --filter web exec vitest run tests/unit/brain-recall-quality.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `buildBrainRecallTraceQualityByRequester` 已新增 requester 级聚合，按 `requesterType/requesterId` 分组统计 trace 数、selected/omitted/denied、无证据选中数、warning 数和主要原因，并用 `issueScore` 把问题较重的调用方排在前面。
- `inspectWorkshopMemoryRecallQuality` 抽取 workshop event 中的 `memoryRecall.contextPack` 时，会附带 `requesterType=work` 和 `requesterId=workshopId`，不改历史事件结构，也不重写旧 trace。
- `Recall quality` 卡片已新增 requester 摘要，用户能看到是哪一个 Work/调用方更常出现 duplicate、denied、no evidence 或 warning，而不是只看到全局总数。
- 本轮继续保持隐私和上下文卫生：质量报告只统计 id、kind、reason 和 count，不把 memory 正文、contentPreview 或 prompt 内容放入长期报告。
- 本轮验证中 `brain-recall-quality.test.ts` 4 项通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 36ms、`/api/page-state/workshop` 54ms、`/api/quant/paper/account` 40ms、`/api/quant/dashboard` 35ms、`/api/memory/search` 986ms、`/api/page-state/workshop/[id]/summary` 301ms、`/api/page-state/workshop/[id]/summary?refresh=1` 52ms、`/api/workshops/[id]/dashboard` 58ms。

新增统一记忆搜索默认 Brain-only 快路径后的验证：
```text
pnpm --filter web exec vitest run tests/unit/unified-memory-search.test.ts tests/unit/memory-search-cache.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `/api/memory/search` 的默认来源已从 `memory + insights + knowledge + interactions + graph` 收窄为 `memory`，符合统一记忆收口方向：默认只走 Brain canonical long-term memory，不再让 legacy discovery 和 evidence source 拖住普通召回。
- `memory` 源内部已新增 `includeLegacyMemory` 开关。默认 `false` 时只搜 Brain memory；显式传 `includeLegacyMemory=true` 时才启用 raw message semantic fallback。这样 raw messages 继续保留 evidence/fallback 能力，但不会默认进入召回热路径。
- 统一记忆页面默认只勾选 Brain，并新增“包含 raw message 语义兜底”开关；用户需要扩大到 Insights、Knowledge、Interactions、Graph 时仍可手动选择。
- `memory-search-cache` 的 cache key 已纳入 `includeLegacyMemory`，避免 Brain-only 结果和 legacy fallback 结果互相污染。
- 新增测试锁住两个关键语义：默认 memory search 不触发 raw legacy embedding；canonical/legacy memory mode 缓存隔离。
- 本轮 smoke 验证中 `/api/memory/search` measured hot-path 从上一轮 `986ms` 降到 `86ms`，并且不再返回 legacy semantic source 的不可用 warnings；最新 measured hot-path 为 `/api/page-state/quant` 53ms、`/api/page-state/workshop` 66ms、`/api/quant/paper/account` 87ms、`/api/quant/dashboard` 55ms、`/api/memory/search` 86ms、`/api/page-state/workshop/[id]/summary` 570ms、`/api/page-state/workshop/[id]/summary?refresh=1` 366ms、`/api/workshops/[id]/dashboard` 22ms。

新增统一记忆搜索 source-level 状态后的验证：
```text
pnpm --filter web exec vitest run tests/unit/unified-memory-search.test.ts tests/unit/memory-search-cache.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `UnifiedMemorySearchOutput` 已新增 `sourceStatuses`，每个 source 返回 `status`、`elapsedMs`、`resultCount`、`warningCount` 和 `semantics`，把显式 legacy sources 的慢源状态从全局 warning 下沉到每一路召回。
- `searchUnifiedMemory` 已按 source 包装执行任务，不再把所有 warning 混成一个共享副作用；Brain、Insights、Knowledge、Interactions、Graph 的正常、降级和不可用状态都能单独统计。
- 状态语义为：无 warning 是 `ok`；有 warning 但仍有结果是 `degraded`；有 warning 且无结果是 `unavailable`。这能区分“Brain 有结果但 raw message 兜底失败”和“某个 legacy source 完全不可用”。
- `/memory` 页面已展示每个 source 的状态、耗时、结果数、warning 数和语义标签，用户能直接看到是哪一路召回慢或失败，而不是只看到统一召回失败。
- `memory-search-cache` 测试输出契约已同步 `sourceStatuses`；统一搜索测试新增 ok/unavailable/degraded 断言。
- 本轮验证中统一记忆搜索相关 2 个测试文件共 18 项通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 44ms、`/api/page-state/workshop` 56ms、`/api/quant/paper/account` 40ms、`/api/quant/dashboard` 36ms、`/api/memory/search` 72ms、`/api/page-state/workshop/[id]/summary` 304ms、`/api/page-state/workshop/[id]/summary?refresh=1` 99ms、`/api/workshops/[id]/dashboard` 29ms。

新增统一记忆搜索单 source 局部重试后的验证：
```text
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `/memory` 页面已在每个 source 状态卡片中新增“重试”动作。用户可以只重试 Brain、Insights、Knowledge、Interactions 或 Graph 中某一路，不必重新跑完整统一召回。
- 单 source 重试会保留当前页面已有结果，只替换被重试 source 的结果、warning 和 status；其它 source 的结果不被清空，符合“慢源局部失败不拖垮整体页面”的体验原则。
- 重试期间只给对应 source 按钮显示局部 loading，不进入整页 loading，也不清空召回结果。
- 合并结果会重新按 similarity 排序，并同步更新顶部结果数，避免局部重试后出现计数和列表不一致。
- 本轮验证中 `pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 20ms、`/api/page-state/workshop` 15ms、`/api/quant/paper/account` 19ms、`/api/quant/dashboard` 21ms、`/api/memory/search` 17ms、`/api/page-state/workshop/[id]/summary` 25ms、`/api/page-state/workshop/[id]/summary?refresh=1` 42ms、`/api/workshops/[id]/dashboard` 21ms。

新增统一记忆搜索单 source 结果过滤后的验证：
```text
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `/memory` 页面结果区已新增前端 source 过滤条，支持查看“全部”或只看 Brain、Insights、Knowledge、Interactions、Graph 中某一路结果。
- 过滤只使用当前召回结果，不新增接口请求，也不影响 `/api/memory/search` 默认 Brain-only 快路径。
- 每个过滤项展示当前 source 的结果数；单 source 局部重试后，过滤计数和顶部结果数会跟随最新合并结果更新。
- 当某个 source 没有结果时，页面展示局部空状态，不把它解释成统一召回整体失败。
- 本轮验证中 `pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 22ms、`/api/page-state/workshop` 15ms、`/api/quant/paper/account` 19ms、`/api/quant/dashboard` 23ms、`/api/memory/search` 15ms、`/api/page-state/workshop/[id]/summary` 24ms、`/api/page-state/workshop/[id]/summary?refresh=1` 47ms、`/api/workshops/[id]/dashboard` 21ms。

新增统一记忆搜索分源折叠后的验证：
```text
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `/memory` 页面在“全部”结果视图下已按 source 分组展示召回结果，每个分组都有独立折叠/展开控制。
- 切换到单 source 过滤时仍保持简单列表，避免用户查看某一路结果时多一层无意义分组。
- 分组头展示 source label、结果数和 source 状态；结果卡片抽成 `SearchResultArticle`，减少重复渲染逻辑。
- 分组容器不再做成 card，避免卡片套卡片；结果项仍作为独立可扫描卡片展示。
- 本轮验证中 `pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 32ms、`/api/page-state/workshop` 16ms、`/api/quant/paper/account` 34ms、`/api/quant/dashboard` 26ms、`/api/memory/search` 23ms、`/api/page-state/workshop/[id]/summary` 33ms、`/api/page-state/workshop/[id]/summary?refresh=1` 88ms、`/api/workshops/[id]/dashboard` 23ms。

新增统一记忆搜索 Brain ContextPack trace 下钻后的验证：
```text
pnpm --filter web exec vitest run tests/unit/unified-memory-search.test.ts tests/unit/memory-search-cache.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `/api/memory/search` 已在 Brain memory 搜索路径返回可选 `contextTrace`，复用现有 `summarizeBrainContextPackForTrace`，不新造解释模型。
- `contextTrace` 展示 Brain ContextPack 的 `selected/omitted/denied` 计数、重复 canonical 分组数、selected canonical kind 分布、evidence 数、warnings，以及 selected/omitted/denied 的轻量下钻信息。
- `/memory` 页面新增 `BrainTracePanel`，在 source 状态之后展示 Brain ContextPack trace 摘要和可展开明细，用户能看到 Brain 这一路为什么选中、省略或拒绝记忆。
- trace 仍是有界摘要：selected 内容使用 `contentPreview`，omitted/denied 只展示 id 和 reason，不把完整长期记忆正文额外展开为大段页面 payload。
- 新增单测锁住统一搜索返回 Brain trace 摘要；本轮统一记忆相关 18 项单测通过。
- 本轮验证中 `pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 39ms、`/api/page-state/workshop` 51ms、`/api/quant/paper/account` 40ms、`/api/quant/dashboard` 36ms、`/api/memory/search` 68ms、`/api/page-state/workshop/[id]/summary` 244ms、`/api/page-state/workshop/[id]/summary?refresh=1` 55ms、`/api/workshops/[id]/dashboard` 21ms。`/api/memory/search` 响应体因携带 trace 摘要约为 9KB，但仍低于热路径阈值。

新增统一记忆召回反馈入口后的验证：
```text
pnpm --filter web exec vitest run tests/unit/memory-recall-feedback-route.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- 已新增 `POST /api/memory/recall-feedback`，用于统一记忆人工召回页提交 append-only 召回反馈。
- 反馈复用现有 `feedback` 表，写入 `source=memory_recall` 和 `systemInfo.kind=memory_recall_feedback`，包含 query、outcome、contextLogId、selected/omitted/denied memory ids、sources 和 `automaticPolicyChange=false`。
- `/memory` 的 `BrainTracePanel` 已新增反馈按钮：有用、无关、过期、缺记忆、范围错、缺边界。点击后只写反馈观察，不自动修改记忆、权限、召回 profile 或 prompt。
- API 对 outcome、query、reason、memoryIds 做有界校验，避免反馈入口变成任意大文本或策略修改入口。
- 新增 `memory-recall-feedback-route.test.ts`，覆盖合法反馈写入和非法 outcome 拒绝。
- 本轮验证中反馈 route 2 项单测通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 44ms、`/api/page-state/workshop` 63ms、`/api/quant/paper/account` 45ms、`/api/quant/dashboard` 45ms、`/api/memory/search` 64ms、`/api/page-state/workshop/[id]/summary` 641ms、`/api/page-state/workshop/[id]/summary?refresh=1` 366ms、`/api/workshops/[id]/dashboard` 40ms。

新增平台级 recall feedback 纳入召回质量报告后的验证：
```text
pnpm --filter web exec vitest run tests/unit/workshop-memory-recall-quality.test.ts tests/unit/memory-recall-feedback-route.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- 已新增 `listMemoryRecallFeedback`，从现有 `feedback` 表按 `source=memory_recall`、`userId` 和时间窗口读取统一记忆召回页反馈。
- `inspectWorkshopMemoryRecallQuality` 已把 workshop event 中的反馈和 `/memory` 页提交的平台级反馈合并，再统一交给 `buildBrainRecallQualityReport` 聚合；因此 `feedbackOutcomes`、observability assessment 和召回质量判断会同时消费车间内反馈与人工召回页反馈。
- 质量报告的 `coverage` 已拆分 `workshopFeedbackEvents` 与 `platformFeedbackEvents`，避免把“反馈来源覆盖”误读成单一车间事件覆盖。
- 平台级反馈解析兼容 `systemInfo` 为对象或 JSON 字符串两种存储形态，降低 SQLite/Postgres 差异导致的漏聚合风险。
- 新增 `workshop-memory-recall-quality.test.ts`，锁住平台级 recall feedback 能进入长期质量报告的行为；`memory-recall-feedback-route.test.ts` 已改为 ASCII-only Unicode escape，避免 Windows 终端编码污染测试语义。
- 本轮验证中召回质量与反馈 route 相关 2 个测试文件共 3 项单测通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 70ms、`/api/page-state/workshop` 164ms、`/api/quant/paper/account` 94ms、`/api/quant/dashboard` 93ms、`/api/memory/search` 105ms、`/api/page-state/workshop/[id]/summary` 543ms、`/api/page-state/workshop/[id]/summary?refresh=1` 185ms、`/api/workshops/[id]/dashboard` 39ms。

新增召回质量问题进入 review item 闭环后的验证：
```text
pnpm --filter web exec vitest run tests/unit/workshop-review-items.test.ts tests/unit/workshop-memory-recall-quality.test.ts tests/unit/memory-recall-feedback-route.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `workshop_review_items.kind` 已扩展出 `memory_recall_quality`，把记忆召回质量问题纳入现有“需要处理”闭环，而不是另起一套待办系统。
- 已新增 `buildWorkshopReviewItemsFromMemoryRecallQuality`，把报告中的 missing/too_narrow/missed_boundary、irrelevant/too_broad/wrong_scope、stale/stale_state、no-evidence selected、trace warnings、duplicate canonical groups 映射为有限的治理问题。
- 已新增 `syncWorkshopMemoryRecallQualityReviewItems`，按 `metadata.issueKind` 幂等 upsert pending item；最新报告不再出现的问题会被 `superseded`，避免旧问题长期占据主计数。
- `/api/workshops/[id]/memory-recall-quality` 已在生成质量报告时开启同步，返回体包含 `reviewItemSync`，同步失败不会让质量报告不可用，但会显式暴露失败状态。
- 这些待处理项只记录 `automaticPolicyChange=false` 的观测和治理建议，不自动修改记忆、权限、recall profile 或 prompt。
- 本轮验证中 3 个相关测试文件共 12 项单测通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 83ms、`/api/page-state/workshop` 95ms、`/api/quant/paper/account` 80ms、`/api/quant/dashboard` 74ms、`/api/memory/search` 158ms、`/api/page-state/workshop/[id]/summary` 620ms、`/api/page-state/workshop/[id]/summary?refresh=1` 267ms、`/api/workshops/[id]/dashboard` 56ms。

新增召回质量治理动作建议可见化后的验证：
```text
pnpm --filter web exec vitest run tests/unit/workshop-review-items.test.ts tests/unit/workshop-memory-recall-quality.test.ts tests/unit/memory-recall-feedback-route.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `memory_recall_quality` review item 的 metadata 已新增 `recommendedActions`、`evidenceHints` 和 `blockedActions`，把“该怎么处理、看哪些证据、哪些动作不能做”结构化写入待处理项。
- 每类召回质量问题都有不同治理建议：缺召回优先检查 requester intent、recall profile、boundary 和 evidence；排序/范围错误优先看分类、去重和 requester 参数；过期优先看 source freshness 和替换规则；无证据选中优先补 evidence refs 或降级记忆；重复 canonical group 优先人工确认后合并/链接。
- 页面通用 review item 列表已对 `memory_recall_quality` 展示 issue kind、信号数、`no automatic policy change`、推荐动作、证据线索和 guardrails。
- 页面仍不提供自动修复按钮；“暂不处理”逻辑保持不变，治理动作只是可见建议，不会自动修改记忆、权限、recall profile 或 prompt。
- 本轮验证中 3 个相关测试文件共 12 项单测通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 42ms、`/api/page-state/workshop` 65ms、`/api/quant/paper/account` 69ms、`/api/quant/dashboard` 45ms、`/api/memory/search` 89ms、`/api/page-state/workshop/[id]/summary` 376ms、`/api/page-state/workshop/[id]/summary?refresh=1` 89ms、`/api/workshops/[id]/dashboard` 30ms。

新增召回质量治理动作确认闭环后的验证：
```text
pnpm --filter web exec vitest run tests/unit/workshop-review-items-route.test.ts tests/unit/workshop-review-items.test.ts tests/unit/workshop-memory-recall-quality.test.ts tests/unit/memory-recall-feedback-route.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `PATCH /api/workshops/[id]/review-items` 已新增 `confirm_memory_recall_governance` 动作，仅允许确认该 `memory_recall_quality` item 的 `recommendedActions` 中已声明的动作。
- 确认动作会写入 `memory_recall_governance_action_confirmed` workshop event，记录 reviewItemId、issueKind、issueCount、governanceAction、confirmedBy 和 `automaticPolicyChange=false`。
- 确认动作会把该 review item 标为 `approved`，并在 metadata 中保留原始 issue/advice/evidence 信息，同时追加 `governanceAction` 和 resolution 审计信息。
- `resolveWorkshopReviewItem` 已改为保留原 metadata 再追加 resolution，避免“处理后丢失原始问题证据”。
- 页面已在 `memory_recall_quality` 的每条推荐动作旁提供 `Confirm` 按钮；点击后只记录确认和关闭待处理项，不自动修改记忆、权限、recall profile 或 prompt。
- 本轮验证中 4 个相关测试文件共 14 项单测通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 38ms、`/api/page-state/workshop` 53ms、`/api/quant/paper/account` 40ms、`/api/quant/dashboard` 35ms、`/api/memory/search` 68ms、`/api/page-state/workshop/[id]/summary` 252ms、`/api/page-state/workshop/[id]/summary?refresh=1` 75ms、`/api/workshops/[id]/dashboard` 20ms。

新增召回质量治理确认生成可审核提案后的验证：
```text
pnpm --filter web exec vitest run tests/unit/workshop-review-items-route.test.ts tests/unit/workshop-review-items.test.ts tests/unit/workshop-memory-recall-quality.test.ts tests/unit/memory-recall-feedback-route.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- 确认 `memory_recall_quality` 的推荐动作后，系统除写入 `memory_recall_governance_action_confirmed` 审计事件外，还会生成 `memory_recall_governance_proposed` 事件。
- 新增 `memory_recall_governance_proposal` review item kind，`buildWorkshopReviewItemFromProposalEvent` 会把 `memory_recall_governance_proposed` 投影成新的 pending 审核事项。
- 该提案事件携带 proposalId、sourceReviewItemId、sourceConfirmationEventId、issueKind、issueCount、governanceAction、evidenceHints、blockedActions 和 `automaticPolicyChange=false`。
- 这一步仍不执行记忆合并、降级、刷新或权限变更，只把“用户确认的治理方向”升级成可审核提案，后续再补 apply/reject 与回滚审计。
- 本轮验证中 4 个相关测试文件共 15 项单测通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 36ms、`/api/page-state/workshop` 54ms、`/api/quant/paper/account` 41ms、`/api/quant/dashboard` 40ms、`/api/memory/search` 64ms、`/api/page-state/workshop/[id]/summary` 328ms、`/api/page-state/workshop/[id]/summary?refresh=1` 66ms、`/api/workshops/[id]/dashboard` 27ms。

新增召回质量治理提案 approve/reject 审计决议后的验证：
```text
pnpm --filter web exec vitest run tests/unit/workshop-review-items-route.test.ts tests/unit/workshop-review-items.test.ts tests/unit/workshop-memory-recall-quality.test.ts tests/unit/memory-recall-feedback-route.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `PATCH /api/workshops/[id]/review-items` 已新增 `resolve_memory_recall_governance_proposal` 动作，支持对 `memory_recall_governance_proposal` 做 approved/rejected 决议。
- approved 会写入 `memory_recall_governance_proposal_approved` 事件，rejected 会写入 `memory_recall_governance_proposal_rejected` 事件；两者都记录 proposalReviewItemId、proposalEventId、proposalId、sourceReviewItemId、issueKind、governanceAction、reason、resolvedBy、`executionMode=audit_only` 和 `automaticPolicyChange=false`。
- 该决议会把治理提案 review item 标为 `approved` 或 `rejected`，并把 resolutionEventId、resolution、reason、executionMode 等写回 metadata。
- 页面已在 `memory_recall_governance_proposal` 项上提供 `Approve audit` 与 `Reject` 按钮；Approve 仍只代表审核通过并记录事件，不代表底层记忆已经被合并、降级、刷新或改权限。
- 本轮验证中 4 个相关测试文件共 17 项单测通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 37ms、`/api/page-state/workshop` 18ms、`/api/quant/paper/account` 32ms、`/api/quant/dashboard` 27ms、`/api/memory/search` 19ms、`/api/page-state/workshop/[id]/summary` 36ms、`/api/page-state/workshop/[id]/summary?refresh=1` 108ms、`/api/workshops/[id]/dashboard` 21ms。

新增 approved 治理提案生成 dry-run change plan 后的验证：
```text
pnpm --filter web exec vitest run tests/unit/workshop-review-items-route.test.ts tests/unit/workshop-review-items.test.ts tests/unit/workshop-memory-recall-quality.test.ts tests/unit/memory-recall-feedback-route.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- approved 的 `memory_recall_governance_proposal` 现在会继续生成 `memory_recall_change_plan_proposed` 事件；rejected 不生成 change plan。
- 新增 `memory_recall_change_plan` review item kind，`buildWorkshopReviewItemFromProposalEvent` 会把 change plan 事件投影成新的 pending 审核项。
- change plan metadata 携带 planId、planKind、sourceProposalReviewItemId、sourceProposalEventId、sourceResolutionEventId、issueKind、governanceAction、dryRunSteps、rollbackPlan、evidenceHints、blockedActions、`executionMode=dry_run_plan`、`requiresOwnerApproval=true` 和 `automaticPolicyChange=false`。
- 当前支持的 planKind 包括 `evidence_attachment_review`、`canonical_deduplication_review`、`freshness_review` 与 `recall_profile_review`；它们只是可审核计划，不会执行底层记忆合并、降级、刷新、证据挂接或权限变更。
- 本轮验证中 4 个相关测试文件共 18 项单测通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 38ms、`/api/page-state/workshop` 49ms、`/api/quant/paper/account` 41ms、`/api/quant/dashboard` 31ms、`/api/memory/search` 73ms、`/api/page-state/workshop/[id]/summary` 272ms、`/api/page-state/workshop/[id]/summary?refresh=1` 819ms、`/api/workshops/[id]/dashboard` 31ms。

新增 dry-run change plan approve/reject 与回滚审计后的验证：
```text
pnpm --filter web exec vitest run tests/unit/workshop-review-items-route.test.ts tests/unit/workshop-review-items.test.ts tests/unit/workshop-memory-recall-quality.test.ts tests/unit/memory-recall-feedback-route.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `/api/workshops/[id]/review-items` 新增 `resolve_memory_recall_change_plan`，支持对 `memory_recall_change_plan` 做 approved/rejected 决议。
- approved 会写入 `memory_recall_change_plan_approved` 事件，并继续写入 `memory_recall_change_plan_rollback_audit_recorded`；该回滚审计明确 `appliedMemoryMutation=false`、`rollbackRequired=false`，说明本轮仍只批准 dry-run 计划，不执行真实记忆改写。
- rejected 会写入 `memory_recall_change_plan_rejected`，不会额外生成 rollback audit，避免没有执行动作时制造无意义事件。
- `memory_recall_change_plan` review item 投影已保留 planKind、sourceResolutionEventId、dryRunSteps、rollbackPlan、evidenceHints、blockedActions、`requiresOwnerApproval=true` 和 `automaticPolicyChange=false`。
- 车间页面的“需要处理”卡片已展示 dry-run steps、rollback audit、evidence hints 和 guardrails，并提供 `Approve plan` / `Reject plan`，让用户可以在平台上处理该待办。
- 本轮验证中 4 个相关测试文件共 20 项单测通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 43ms、`/api/page-state/workshop` 55ms、`/api/quant/paper/account` 56ms、`/api/quant/dashboard` 47ms、`/api/memory/search` 78ms、`/api/page-state/workshop/[id]/summary` 389ms、`/api/page-state/workshop/[id]/summary?refresh=1` 130ms、`/api/workshops/[id]/dashboard` 27ms。

新增召回质量 loop/run 维度趋势拆分后的验证：
```text
pnpm --filter web exec vitest run tests/unit/brain-recall-quality.test.ts tests/unit/workshop-memory-recall-quality.test.ts tests/unit/workshop-review-items-route.test.ts tests/unit/workshop-review-items.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `buildBrainRecallQualityReport` 新增 `traceQualityByLoop` 与 `traceQualityByRun`，沿用 ContextPack trace 的 selected/omitted/denied/noEvidence/warning 统计和 issueScore 排序。
- `contextPackTraceFromEvent` 会从 workshop event 提取 `workshopId`、`loopId`、`runId`、`loopRunId`，让召回质量报告能定位“哪条 loop / 哪次 run”在产生坏召回。
- 车间 Recall quality 卡片已展示 top loops 与 top runs，只展示 score、trace 数、noEvidence 数和首要原因，不展示记忆正文。
- 本轮验证中 4 个相关测试文件共 24 项单测通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 40ms、`/api/page-state/workshop` 124ms、`/api/quant/paper/account` 397ms、`/api/quant/dashboard` 416ms、`/api/memory/search` 30ms、`/api/page-state/workshop/[id]/summary` 99ms、`/api/page-state/workshop/[id]/summary?refresh=1` 84ms、`/api/workshops/[id]/dashboard` 24ms。

新增 feedback outcome 与 trace reason 关联诊断后的验证：
```text
pnpm --filter web exec vitest run tests/unit/brain-recall-quality.test.ts tests/unit/workshop-memory-recall-quality.test.ts tests/unit/workshop-review-items-route.test.ts tests/unit/workshop-review-items.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `BrainRecallTraceQualityInput` 新增 `contextLogId`，`contextPackTraceFromEvent` 会从 `memoryRecall.contextLogId` 或事件 metadata 中提取该字段。
- `buildBrainRecallQualityReport` 新增 `feedbackTraceDiagnosticsByLoop` 与 `feedbackTraceDiagnosticsByRun`，只用 `contextLogId` 精确匹配 feedback 和 ContextPack trace；无法匹配的 feedback 仍进入全局 `feedbackOutcomes`，但不会被误归因到某个 loop/run。
- 诊断聚合会输出 `feedbackCount`、`diagnosticScore`、`feedbackOutcomes` 和匹配 trace 的质量摘要，用于判断某个 loop/run 是“太宽、太窄、无关、遗漏、过期、边界错误”中的哪类问题。
- 车间 Recall quality 卡片已展示 `feedback x loops` 与 `feedback x runs`，只展示 outcome 分布、诊断分、反馈数和首要 trace reason，不展示记忆正文。
- 本轮验证中 4 个相关测试文件共 26 项单测通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 52ms、`/api/page-state/workshop` 86ms、`/api/quant/paper/account` 50ms、`/api/quant/dashboard` 38ms、`/api/memory/search` 16ms、`/api/page-state/workshop/[id]/summary` 37ms、`/api/page-state/workshop/[id]/summary?refresh=1` 69ms、`/api/workshops/[id]/dashboard` 24ms。

新增 feedback+trace 诊断进入治理待办后的验证：
```text
pnpm --filter web exec vitest run tests/unit/workshop-review-items.test.ts tests/unit/brain-recall-quality.test.ts tests/unit/workshop-memory-recall-quality.test.ts tests/unit/workshop-review-items-route.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `memory_recall_quality` review item metadata 新增 `feedbackTraceDiagnostics`，把匹配到的 top loops/runs、diagnosticScore、feedbackCount、topOutcomes、topReason、noEvidenceSelectedCount 和 warningCount 收进待处理项。
- `buildWorkshopReviewItemsFromMemoryRecallQuality` 会按 issueKind 过滤相关诊断：例如 `missing_or_too_narrow` 只吸收 missing/too_narrow/missed_boundary 或 denied reason，`ranking_or_scope` 吸收 irrelevant/too_broad/wrong_scope/incorrect/conflicting，`duplicate_canonical_groups` 吸收 duplicate_canonical_group reason。
- 当存在 loop/run 诊断时，推荐动作前置“先为受影响 loop/run 形成去重治理提案”，并把 `feedbackTraceDiagnosticsByLoop`、`feedbackTraceDiagnosticsByRun`、`contextLogId` 加入 evidence hints。
- 车间“需要处理”中的 Memory recall quality 详情已展示 `Feedback diagnostics`，让用户能看到该待办对应的具体 loop/run 证据。
- 本轮仍只生成可审核治理线索，不执行真实记忆合并、证据挂接、权限放宽或 prompt 改写。
- 本轮验证中 4 个相关测试文件共 26 项单测通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 42ms、`/api/page-state/workshop` 61ms、`/api/quant/paper/account` 48ms、`/api/quant/dashboard` 39ms、`/api/memory/search` 17ms、`/api/page-state/workshop/[id]/summary` 37ms、`/api/page-state/workshop/[id]/summary?refresh=1` 62ms、`/api/workshops/[id]/dashboard` 22ms。

新增具体诊断治理动作进入提案链路后的验证：
```text
pnpm --filter web exec vitest run tests/unit/workshop-review-items.test.ts tests/unit/workshop-review-items-route.test.ts tests/unit/brain-recall-quality.test.ts tests/unit/workshop-memory-recall-quality.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `buildWorkshopReviewItemsFromMemoryRecallQuality` 会基于 `feedbackTraceDiagnostics` 自动生成带 scope 的具体治理动作，例如 `Create deduplicated ranking_or_scope governance proposal for loops loop-ranking.`。
- 具体动作会写入 `governanceActionDetails`，包含 actionKind、issueKind、affectedLoops、affectedRuns、`requiresOwnerApproval=true` 和 `automaticPolicyChange=false`。
- `confirm_memory_recall_governance` 在用户确认具体动作时，会把 `governanceActionDetail` 写入 `memory_recall_governance_action_confirmed` 和 `memory_recall_governance_proposed` 事件。
- 治理提案 approve 后，`governanceActionDetail` 会继续传递到 approved 事件和 `memory_recall_change_plan_proposed`，为后续 dry-run 计划和真实执行层保留具体 loop/run 诊断上下文。
- 本轮仍不执行真实记忆变更，只让“诊断线索 -> 具体治理动作 -> pending 治理提案 -> dry-run plan”这条链路携带足够上下文。
- 本轮验证中 4 个相关测试文件共 27 项单测通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 39ms、`/api/page-state/workshop` 64ms、`/api/quant/paper/account` 48ms、`/api/quant/dashboard` 37ms、`/api/memory/search` 70ms、`/api/page-state/workshop/[id]/summary` 333ms、`/api/page-state/workshop/[id]/summary?refresh=1` 89ms、`/api/workshops/[id]/dashboard` 41ms。

新增一键确认首个诊断治理动作后的验证：
```text
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web exec vitest run tests/unit/workshop-review-items.test.ts tests/unit/workshop-review-items-route.test.ts tests/unit/brain-recall-quality.test.ts tests/unit/workshop-memory-recall-quality.test.ts
pnpm --filter web smoke:ux
```

本轮落地内容：
- Memory recall quality 待办详情新增 `Top diagnostic action` 和 `Confirm top`。
- `Confirm top` 只确认当前待办中首个带 scope 的诊断治理动作，复用 `confirm_memory_recall_governance`，因此仍走已有审计事件、pending 治理提案和后续 dry-run plan 链路。
- 这一步是“一键审核”的第一阶段，不做跨待办批量确认，不绕过 owner approval，也不执行真实记忆变更。
- 本轮验证中 4 个相关测试文件共 27 项单测通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 35ms、`/api/page-state/workshop` 60ms、`/api/quant/paper/account` 48ms、`/api/quant/dashboard` 37ms、`/api/memory/search` 75ms、`/api/page-state/workshop/[id]/summary` 318ms、`/api/page-state/workshop/[id]/summary?refresh=1` 42ms、`/api/workshops/[id]/dashboard` 25ms。

新增跨待办批量确认同类诊断动作后的验证：
```text
pnpm --filter web exec vitest run tests/unit/workshop-review-items-route.test.ts tests/unit/workshop-review-items.test.ts tests/unit/brain-recall-quality.test.ts tests/unit/workshop-memory-recall-quality.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `/api/workshops/[id]/review-items` 新增 `confirm_memory_recall_governance_batch`，以当前 `memory_recall_quality` 待办为 anchor，只批量确认相同 issueKind、且存在具体 `governanceActionDetails` 的 pending 待办。
- 批量确认默认最多处理 5 个待办，并复用单项 `confirm_memory_recall_governance` 的事件链路：每个待办都会写 `memory_recall_governance_action_confirmed`、`memory_recall_governance_proposed`，并把原 review item 标为 approved。
- 页面新增 `Confirm same kind`，仅在待办存在 `Top diagnostic action` 时显示；它不会批量 approve 治理提案，也不会生成 change plan 之外的真实记忆变更。
- 本轮 smoke 第一次运行时本地服务短暂出现 `fetch failed`，端口和 HTTP 探测恢复为 200 后重跑通过；以重跑样本作为验收记录。
- 本轮验证中 4 个相关测试文件共 28 项单测通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 重跑通过，最新 measured hot-path 为 `/api/page-state/quant` 66ms、`/api/page-state/workshop` 98ms、`/api/quant/paper/account` 72ms、`/api/quant/dashboard` 49ms、`/api/memory/search` 32ms、`/api/page-state/workshop/[id]/summary` 256ms、`/api/page-state/workshop/[id]/summary?refresh=1` 81ms、`/api/workshops/[id]/dashboard` 26ms。

新增 dry-run change execution planned 事件后的验证：
```text
pnpm --filter web exec vitest run tests/unit/workshop-review-items-route.test.ts tests/unit/workshop-review-items.test.ts tests/unit/brain-recall-quality.test.ts tests/unit/workshop-memory-recall-quality.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `resolve_memory_recall_change_plan` 在 approved 时会新增 `memory_recall_change_execution_planned` 事件，位于 approval event 与 rollback audit event 之间。
- execution planned metadata 包含 executionId、changePlanReviewItemId、changePlanEventId、approvalEventId、planId、planKind、issueKind、governanceAction、governanceActionDetail、dryRunSteps、evidenceHints、blockedActions、`executionState=planned`、`executionMode=dry_run_plan`、`canExecuteAutomatically=false`、`requiresOwnerApproval=true`、`appliedMemoryMutation=false` 和 `automaticPolicyChange=false`。
- rollback audit 会记录 executionPlanEventId，review item resolution metadata 也会记录 executionPlanEventId，形成 approval -> execution planned -> rollback audit 的审计链。
- rejected change plan 仍只写 rejected 事件，不生成 execution planned 或 rollback audit。
- 这一步只是“真实执行层前置记录”，不执行真实记忆合并、证据挂接、权限变更或 prompt 改写。
- 本轮验证中 4 个相关测试文件共 28 项单测通过；`pnpm --filter web tsc --noEmit --pretty false` 通过；`pnpm --filter web smoke:ux` 通过，最新 measured hot-path 为 `/api/page-state/quant` 33ms、`/api/page-state/workshop` 30ms、`/api/quant/paper/account` 34ms、`/api/quant/dashboard` 34ms、`/api/memory/search` 32ms、`/api/page-state/workshop/[id]/summary` 47ms、`/api/page-state/workshop/[id]/summary?refresh=1` 63ms、`/api/workshops/[id]/dashboard` 34ms。

新增统一记忆来源语义说明与动态 resultKind 后的验证：
```text
pnpm --filter web exec vitest run tests/unit/unified-memory-search.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

本轮落地内容：
- `/memory` 页面新增“记忆来源语义”说明区，明确 Brain canonical 是长期记忆主事实入口，legacy discovery 用于发现与兜底，evidence source 只表示资料或原始证据，derived index 只表示关系索引，fallback evidence 表示降级证据。
- `/api/memory/search` 的 `resultKind` 不再固定为 `legacy_discovery`，而是按请求来源动态返回 `canonical_context`、`mixed_context`、`legacy_discovery` 或 `empty`；默认 Brain-only 路径会明确标记为 `canonical_context`。
- `/memory` 召回结果顶部展示本次返回的 `resultKind`，让用户能区分本次召回是 Brain canonical、Brain + evidence，还是 legacy/evidence。
- `searchUnifiedMemory` 单测新增/更新断言，锁定默认 Brain-only 不会被误标为 legacy discovery，Brain + 其他来源时才是 mixed context。
- 本轮验证通过：`unified-memory-search.test.ts` 14 项单测通过，`pnpm --filter web tsc --noEmit --pretty false` 通过，`pnpm --filter web smoke:ux` 通过。最新 measured hot-path 为 `/api/page-state/quant` 53ms、`/api/page-state/workshop` 71ms、`/api/quant/paper/account` 68ms、`/api/quant/dashboard` 54ms、`/api/memory/search` 74ms、`/api/page-state/workshop/[id]/summary` 426ms、`/api/page-state/workshop/[id]/summary?refresh=1` 76ms、`/api/workshops/[id]/dashboard` 26ms。

### 18.3 仍需继续推进

- `workshop-client.tsx` 已切换详情摘要到 `/api/page-state/workshop/[id]/summary`，但仍需继续拆成 shell + panels，降低单组件状态复杂度和重渲染范围。
- SSE 已有事件到 panel 的局部刷新策略，memory/source/outbox/review 类事件已收窄为 panel-only 或独立 panel 刷新，outbox/memory/source 的稳定 id 事件已开始本地 patch；loop/dashboard 已覆盖 `loop_run_started` 和成功完成类事件的本地 patch，失败事件因仍需服务端投影 `loop_blocker` review item 而保留刷新。后续需要继续把更多无审计副作用、事件 payload 足够完整的 dashboard/work 事件转成本地 patch。
- 上下文体检已能在车间 dashboard 中展示 section 级 token 来源和超限次数，单次 run/loop detail 也已能展示 Brain ContextPack selected/omitted/denied 与 canonical 分组明细，并已把 ContextPack trace 汇总进 recall quality 报告和 requester/loop/run 级质量拆分。重复、过期、无证据、高风险缺 boundary 等模式已开始进入 `memory_recall_quality` review item，页面已展示推荐治理动作、证据线索和禁止动作，并已支持对推荐动作做确认式审计记录、生成 pending 治理提案、对治理提案做 approve/reject 审计决议、把 approved 提案升级成 pending dry-run change plan，以及对 change plan 做 approve/reject、execution planned 和回滚审计。feedback outcome 已能通过 contextLogId 与 trace reason 关联到 loop/run 诊断，并进入待处理项作为去重治理线索；具体治理动作会携带 affected loop/run 诊断进入治理提案和 dry-run plan，页面已支持 `Confirm top` 和同 issueKind 的 `Confirm same kind` 批量确认。后续还需要设计安全可回滚的真实记忆执行器。
- 统一记忆搜索默认路径已切为 Brain-only，`/api/memory/search` 热路径已降到 100ms 级；显式 legacy sources 已有 source-level 状态、耗时、结果数、warning 数、单 source 局部重试、单 source 结果过滤和分源折叠；Brain 路径已返回 ContextPack trace 摘要并在页面展示，人工召回页已能提交 append-only 召回反馈，平台级 recall feedback 已接入长期召回质量聚合，并能同步成带治理动作建议、确认式审计动作、pending 治理提案、audit-only 决议、dry-run change plan、计划决议和回滚审计的 `memory_recall_quality`/`memory_recall_governance_proposal`/`memory_recall_change_plan` 待处理项；`/memory` 页面也已解释 canonical memory、legacy discovery、evidence source、derived index 和 fallback evidence 的区别，并通过动态 `resultKind` 标记本次召回语义。后续需要继续把反馈 outcome、trace reason 与 requester/loop/run 维度结合后的治理链路推进到安全可回滚的真实记忆执行器。
- 写后刷新已支持强制重建 summary，review tab 已优先使用 `/api/workshops/[id]/review-items`，后续还要继续补更多 panel 的 invalidate/refresh 语义。
- `workshop_review_items` 已覆盖配置提案、自选股提案、loop blocker、权限边界和服务异常，并接入页面；服务异常已支持同类批量关闭，后续要继续补一键重试和异常原因聚合。
- 体验指标已从一次性 smoke 输出升级为本地历史报告，并已接入 `/ux-performance` 可视化 dashboard，支持 p50/p95/p99/max 与最近 N 次窗口筛选；但该能力当前对产品主流程价值有限，后续不再作为前台产品线推进，保留为内部验收和诊断工具。

### 18.4 后续按工作包推进

为避免目标继续混杂成黑盒，后续实现按 `customer-experience-response-architecture-v5.md` 中的工作包推进。每轮开始前必须声明本轮属于哪个工作包，结束时说明完成了哪一小步、验证命令和剩余风险。

| 工作包 | 名称 | 当前状态 | 下一步建议 |
| --- | --- | --- | --- |
| WP1 | Workshop 冷路径预热与快照刷新 | 未完成 | 优先处理 `/api/page-state/workshop/[id]/summary` 首次构建偏慢 |
| WP2 | Refresh Job / Status 统一 | 未完成 | 建立统一 running/success/failed/lastError/status 模型 |
| WP3 | Workshop Shell + Panels 拆分 | 未完成 | 从 Review 或 Memory panel 开始拆出局部状态 |
| WP4 | 真实记忆执行器 | 未完成 | 先设计 execution lock、pre-change snapshot、rollback audit 和幂等接口 |
| WP5 | 量化全市场慢源后台化 | 核心完成 | full market refresh 已接入后台 job/status；后续可把状态露出到 `/quant` 市场卡片 |
| WP6 | UX tab/action 级指标 | 暂停 | 从产品前台移除，仅保留 smoke/API 作为内部验收工具 |

执行约束：

- 一次默认只推进一个 WP。
- 跨 WP 改动必须说明原因。
- 不把“记忆执行器”“车间拆分”“量化后台化”“内部 UX 验收工具”混在同一次无边界修改里。
- 文档落地记录必须带 WP 编号。

### 18.5 WP3 落地记录：收缩车间上下文展示

本轮按 WP3 的前端体验边界，只调整智能体车间 dashboard 的上下文展示，不改上下文生成、记忆召回、review item、量化和后台任务。

落地内容：

- `/workshop` dashboard 中原“上下文体检”大卡片已收缩为“当前上下文”小卡片。
- 页面只展示当前智能体车间最近一次 context report 的 estimated prompt tokens。
- 已移除首页展示中的最大来源、section 明细、占比条和超限次数，避免上下文体检占据过多空间。
- 详细上下文诊断仍保留在后端 dashboard 数据和质量报告链路中，后续需要时可放到独立详情或调试面板，而不是占用车间首页。

验证：

```text
pnpm --filter web exec vitest run tests/unit/workshop-dashboard.test.ts
pnpm --filter web tsc --noEmit --pretty false
pnpm --filter web smoke:ux
```

结果：定向单测 7 项通过，TypeScript 通过，UX smoke 通过；最新 measured hot-path 中 `/api/page-state/workshop` 89ms、`/api/page-state/workshop/[id]/summary` 32ms、`/api/workshops/[id]/dashboard` 35ms。

### 18.6 WP6 调整记录：性能观察降级为内部工具

本轮根据产品判断，性能观察线当前不再作为前台产品能力推进。

落地内容：

- 已从侧边栏移除“性能观察”入口，用户主导航不再展示 `/ux-performance`。
- 保留 `smoke:ux`、`/api/ux-performance` 和 `/ux-performance` 页面作为内部验收/诊断能力，避免破坏现有回归验证链路。
- WP6 状态从“部分完成/继续扩展 tab/action 指标”调整为“暂停/内部工具”。

后续规则：

- 不再优先投入 tab/action 级指标、长期告警和正式指标持久化。
- 只有当某个具体体验问题需要证据定位时，才临时使用或增强该内部工具。
