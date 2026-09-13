"use client";

import type {
  QuantDashboard,
  QuantPageState,
  QuantPaperAccount,
  QuantPaperOrder,
  QuantSignal,
} from "@/lib/quant/types";
import { formatPrice } from "@/lib/quant/price-format";
import useSWR from "swr";
import { quantQuality, quantRefreshInterval, formatQuantNumber } from "@/lib/quant/quality";
import { PanelState } from "@/components/workbench/panel-state";
import { WatchlistManager } from "./watchlist-manager";
import { PaperMigrationReview } from "./paper-migration-review";

const formatNumber = formatQuantNumber;

function formatMoney(value: number): string {
  return new Intl.NumberFormat("zh-CN", {
    currency: "CNY",
    maximumFractionDigits: 0,
    style: "currency",
    currencyDisplay: "narrowSymbol",
  }).format(value);
}

function formatTurnover(valueInBillion: number): string {
  return `${formatNumber(valueInBillion * 10, 1)}亿`;
}

function formatPercent(value: number): string {
  return `${formatNumber(value)}%`;
}

function formatQuoteTime(value?: string | null): string {
  if (!value) return "未返回";
  if (!Number.isFinite(Date.parse(value))) return "未知时间";
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function changeClass(value: number): string {
  if (value > 0) return "text-red-600";
  if (value < 0) return "text-emerald-600";
  return "text-muted-foreground";
}

function actionLabel(action: QuantSignal["action"]): string {
  const labels: Record<QuantSignal["action"], string> = {
    buy_candidate: "候选买入",
    observe: "观察",
    sell_candidate: "候选卖出",
    watch: "关注",
  };
  return labels[action] ?? action;
}

function watchPoolLabel(pool?: string): string {
  const labels: Record<string, string> = {
    candidate: "候选",
    core: "核心",
    trading: "交易关注",
    holding: "持仓跟踪",
    archived: "归档",
  };
  return pool ? (labels[pool] ?? pool) : "核心";
}

function watchStatusLabel(status?: string): string {
  const labels: Record<string, string> = {
    active: "活跃",
    cooling: "冷却",
    protected: "保护",
    pending_remove: "待移除",
    archived: "归档",
  };
  return status ? (labels[status] ?? status) : "活跃";
}

function dataProviderLabel(provider?: string, detail?: string): string {
  const labels: Record<string, string> = {
    akshare: "AkShare 全市场",
    tencent: "腾讯行情",
  };
  const label = provider ? (labels[provider] ?? provider) : "未知来源";
  if (provider === "akshare" && detail === "sina") {
    return `${label} · 新浪`;
  }
  if (provider === "akshare" && detail === "eastmoney") {
    return `${label} · 东方财富`;
  }
  return label;
}

function providerNotice(dashboard: QuantDashboard): string | null {
  if (!dashboard.provider_error) return null;
  if (dashboard.data_provider === "tencent" && dashboard.provider_error.includes("AkShare")) {
    return "全市场数据源暂不可用，当前使用腾讯来源；请结合报价时间和统计范围阅读。";
  }
  return dashboard.provider_error;
}

export default function QuantPage() {
  const { data, error: requestError, isLoading, isValidating, mutate } = useSWR<QuantPageState>(
    "/api/page-state/quant", async (url: string) => {
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("Quant page state returned " + response.status);
      return response.json();
    }, { refreshInterval: quantRefreshInterval, refreshWhenHidden: false, refreshWhenOffline: false,
      dedupingInterval: 1_000, keepPreviousData: true, errorRetryInterval: 60_000, errorRetryCount: 3 },
  );
  const dashboard = data?.dashboard ?? null;
  const paperAccount = data?.account ?? null;
  const dashboardLoading = isLoading || Boolean(data?.meta.dashboard.pending);
  const accountLoading = isLoading || Boolean(data?.meta.account.refreshing && !paperAccount);
  const quality = quantQuality(dashboard, data?.meta);
  const error = requestError?.message ?? data?.meta.dashboard.error ?? data?.meta.account.error ?? null;

  return (
    <main className="h-full min-h-0 overflow-y-auto bg-[#F8FAF9] text-foreground">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-5 pb-10 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="ri-line-chart-line text-xl" aria-hidden />
                <h1 className="truncate text-2xl font-semibold sm:text-3xl">
                  量化工作台
                </h1>
                {dashboard?.service_mode === "sample" ? (
                  <span className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">
                    样例数据
                  </span>
                ) : null}
                {dashboard?.service_mode === "live" ? (
                  <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
                    行情快照 · {dataProviderLabel(dashboard.data_provider, dashboard.data_source_detail)}
                    {dashboard.cache?.hit ? " · 缓存" : ""}
                  </span>
                ) : null}
                <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
                  不执行交易
                </span>
              </div>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                把指数、市场宽度、行业热度、自选股和策略信号放在同一个个人工作台里。当前只用于研究和提醒，不执行实盘交易。
              </p>
            </div>
            <button
              onClick={() => void mutate()}
              disabled={isValidating}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
            >
              <span className="ri-refresh-line" aria-hidden />
              {isValidating ? "刷新中" : "刷新"}
            </button>
          </div>
        </header>

        <section aria-label="行情数据质量" className="rounded-md border border-border bg-card px-4 py-3 text-sm leading-6">
          <p>统计范围：{({full_market: "全市场", watchlist: "自选股范围参考", sample: "样例", unknown: "未知"})[quality.scope]} · {({ready: "数据已返回", degraded: "数据不完整", stale: "历史缓存", unavailable: "暂不可用"})[quality.qualityStatus]}{quality.refreshing ? " · 后台刷新中" : ""}</p>
          <p>来源：{quality.provider} · 行情观测：{formatQuoteTime(quality.observedAt)} · 抓取：{formatQuoteTime(quality.fetchedAt)}</p>
          {quality.warnings.length ? <p className="text-amber-700">{quality.warnings.join("；")}</p> : null}
          {error ? <p role="alert" className="text-amber-700">刷新未完成：{error}。保留最近可用数据。</p> : null}
        </section>
        {paperAccount?.migrationRequired ? <PaperMigrationReview /> : null}
        {!dashboard ? (
          <>
            {paperAccount ? (
              <PaperAccountPanel account={paperAccount} />
            ) : (
              <PaperAccountPlaceholder loading={accountLoading} error={error} />
            )}
            <QuantMarketPlaceholder loading={dashboardLoading} error={error} />
          </>
        ) : (
          <Dashboard
          dashboard={dashboard}
          paperAccount={paperAccount}
        />
        )}
      </div>
    </main>
  );
}

function PaperAccountPlaceholder({
  loading,
  error,
}: {
  loading: boolean;
  error: string | null;
}) {
  return (
    <PanelState
      state={loading ? "loading" : "error"}
      title={loading ? "模拟盘账户读取中" : "模拟盘账户暂不可用"}
      description="页面已经进入量化工作台，账户、持仓和委托会在接口返回后局部更新。"
      detail={error}
    />
  );
}

function QuantMarketPlaceholder({
  loading,
  error,
}: {
  loading: boolean;
  error: string | null;
}) {
  return (
    <PanelState
      state={loading ? "refreshing" : "error"}
      title={loading ? "全市场快照后台刷新中" : "全市场快照暂不可用"}
      description="模拟盘账户会优先展示；市场温度、成交额、市场宽度和行业热度需要全市场数据，当前不会阻塞页面其它操作。"
      detail={error}
    />
  );
}

function Dashboard({
  dashboard,
  paperAccount,
}: {
  dashboard: QuantDashboard;
  paperAccount: QuantPaperAccount | null;
}) {
  const { market } = dashboard;
  const scope = quantQuality(dashboard).scope;
  const notice = providerNotice(dashboard);
  const totalStocks = Math.max(
    1,
    market.up_count + market.down_count + market.flat_count,
  );
  const upRatio = (market.up_count / totalStocks) * 100;
  const downRatio = (market.down_count / totalStocks) * 100;

  return (
    <>
      {notice ? (
        <section className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
          {notice}
        </section>
      ) : null}

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label={scope === "full_market" ? "全市场温度" : "范围内温度（参考）"}
          value={formatNumber(market.temperature, 0)}
          detail={`上涨 ${formatNumber(market.up_count, 0)} 家 / 下跌 ${formatNumber(market.down_count, 0)} 家`}
        />
        <MetricCard
          label="成交额"
          value={formatTurnover(market.turnover_billion)}
          detail={market.trade_date}
        />
        <MetricCard
          label="上涨家数"
          value={formatNumber(market.up_count, 0)}
          detail={`占比 ${formatPercent(upRatio)}`}
          detailClassName="text-red-600"
        />
        <MetricCard
          label="下跌家数"
          value={formatNumber(market.down_count, 0)}
          detail={`占比 ${formatPercent(downRatio)}，平盘 ${market.flat_count} 家`}
          detailClassName="text-emerald-600"
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <Panel title="主要指数">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {market.indices.map((item) => (
              <div
                key={item.code}
                className="rounded-md border border-border/60 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{item.name}</span>
                  <span className={changeClass(item.change_pct)}>
                    {item.change_pct > 0 ? "+" : ""}
                    {formatNumber(item.change_pct)}%
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{formatPrice(item.price, item.code)}</span>
                  <span>{formatTurnover(item.turnover_billion)}</span>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title={scope === "full_market" ? "全市场宽度" : "范围内涨跌分布（参考）"}>
          <div className="space-y-3">
            <BreadthRow label="上涨" value={market.up_count} ratio={upRatio} className="bg-red-500" />
            <BreadthRow label="下跌" value={market.down_count} ratio={downRatio} className="bg-emerald-500" />
            <BreadthRow
              label="平盘"
              value={market.flat_count}
              ratio={(market.flat_count / totalStocks) * 100}
              className="bg-zinc-400"
            />
          </div>
        </Panel>
      </section>

      <section className="grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
        <Panel title="行业热度">
          <div className="space-y-2">
            {market.sectors.slice(0, 8).map((sector) => (
              <div
                key={sector.name}
                className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2 text-sm"
              >
                <span className="min-w-0 truncate font-medium">{sector.name}</span>
                <span className={changeClass(sector.change_pct)}>
                  {sector.change_pct > 0 ? "+" : ""}
                  {formatNumber(sector.change_pct)}%
                </span>
              </div>
            ))}
            {market.sectors.length === 0 ? (
              <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
                当前数据源暂未返回行业热度。
              </p>
            ) : null}
          </div>
        </Panel>

        <Panel title="策略信号">
          <div className="grid gap-3 lg:grid-cols-3">
            {dashboard.signals.map((signal) => (
              <article
                key={signal.id}
                className="rounded-md border border-border/60 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold">
                      {signal.name}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {signal.code} | {signal.strategy}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs">
                    {actionLabel(signal.action)}
                  </span>
                </div>
                <div className="mt-3">
                  <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                    <span>信号强度</span>
                    <span>{signal.strength}</span>
                  </div>
                  <div className="h-2 rounded-full bg-muted">
                    <div
                      className="h-2 rounded-full bg-primary"
                      style={{ width: `${signal.strength}%` }}
                    />
                  </div>
                </div>
                <p className="mt-3 text-sm leading-6">{signal.reason}</p>
                <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                  {signal.risk}
                </p>
              </article>
            ))}
          </div>
        </Panel>

      </section>

      <section className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <Panel title="自选股行情">
          <WatchlistManager
            initialCodes={dashboard.watchlist.map((item) => item.code)}
          />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="border-b text-xs text-muted-foreground">
                <tr>
                  <th className="py-2 text-left font-medium">股票</th>
                  <th className="py-2 text-left font-medium">池子</th>
                  <th className="py-2 text-right font-medium">最新价</th>
                  <th className="py-2 text-right font-medium">涨跌幅</th>
                  <th className="py-2 text-right font-medium">市盈率</th>
                  <th className="py-2 text-right font-medium">净资产收益率</th>
                  <th className="py-2 text-right font-medium">报价时间</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.watchlist.map((item) => (
                  <tr
                    key={item.code}
                    className="border-b border-border/60 last:border-0"
                  >
                    <td className="py-3">
                      <div className="font-medium">{item.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {item.code}
                      </div>
                    </td>
                    <td className="py-3">
                      <div className="flex flex-wrap gap-1">
                        <span className="rounded-md border border-border bg-muted px-2 py-0.5 text-xs">
                          {watchPoolLabel(item.pool)}
                        </span>
                        <span className="rounded-md border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground">
                          {watchStatusLabel(item.watch_status)}
                        </span>
                      </div>
                    </td>
                    <td className="py-3 text-right">
                      {formatPrice(item.price, item.code)}
                    </td>
                    <td
                      className={`py-3 text-right ${changeClass(
                        item.change_pct,
                      )}`}
                    >
                      {item.change_pct > 0 ? "+" : ""}
                      {formatNumber(item.change_pct)}%
                    </td>
                    <td className="py-3 text-right">
                      {formatNumber(item.pe_ttm, 1)}
                    </td>
                    <td className="py-3 text-right">
                      {formatNumber(item.roe, 1)}%
                    </td>
                    <td className="py-3 text-right text-xs text-muted-foreground">
                      {formatQuoteTime(item.updated_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="每日复盘">
          <p className="text-sm leading-7">{dashboard.daily_report.summary}</p>
          <h3 className="mt-4 text-sm font-semibold">下一步观察</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {dashboard.daily_report.next_actions.map((action) => (
              <li key={action} className="flex gap-2">
                <span className="ri-checkbox-circle-line mt-0.5 text-primary" />
                <span>{action}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </section>

      {paperAccount ? (
        <PaperAccountPanel
          account={paperAccount}
        />
      ) : null}
    </>
  );
}

function BreadthRow({
  label,
  value,
  ratio,
  className,
}: {
  label: string;
  value: number;
  ratio: number;
  className: string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span>
          {value} 家 · {formatPercent(ratio)}
        </span>
      </div>
      <div className="h-2 rounded-full bg-muted">
        <div
          className={`h-2 rounded-full ${className}`}
          style={{ width: `${Math.min(100, Math.max(0, ratio))}%` }}
        />
      </div>
    </div>
  );
}

function orderSideLabel(side: QuantPaperOrder["side"]) {
  return side === "buy" ? "买入" : "卖出";
}

function orderStatusLabel(status: QuantPaperOrder["status"]) {
  const labels: Record<QuantPaperOrder["status"], string> = {
    submitted: "待撮合",
    partially_filled: "部分成交",
    filled: "已成交",
    cancelled: "已撤销",
    rejected: "已拒绝",
  };
  return labels[status] ?? status;
}

function formatOrderStatusNote(statusNote?: string) {
  const normalized = statusNote?.trim();
  if (!normalized) return "";
  if (/^\?{4,}$/.test(normalized)) return "";
  return `；${normalized}`;
}

function PaperAccountPanel({
  account,
}: {
  account: QuantPaperAccount;
}) {
  return (
    <section className="rounded-lg border border-border/60 bg-background p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">智能体模拟盘</h2>
            <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
              初始资金 {formatMoney(account.initial_cash)}
            </span>
            <span className="rounded-md border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              只模拟撮合，不连接券商
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            操盘交易员车间通过受控接口提交限价委托；模拟盘执行现金、仓位、T+1、100 股整数倍和涨跌幅边界。
          </p>
          {account.historicalPerformanceComplete===false?<p className="mt-2 text-sm text-amber-700">此账户包含恢复期初基线，历史现金与损益记录不完整。累计收益仅供账面参考，不代表完整历史绩效。</p>:null}
        </div>
        <div className="flex flex-col gap-2 md:items-end">
          <div className="text-xs text-muted-foreground">
            账户状态变更：{formatQuoteTime(account.stateChangedAt ?? account.updated_at)}
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <MetricCard
          label="总资产"
          value={formatMoney(account.total_asset)}
          detail={`累计 ${formatNumber(account.total_pnl_pct)}%`}
          detailClassName={changeClass(account.total_pnl)}
        />
        <MetricCard
          label="可用现金"
          value={formatMoney(account.cash)}
          detail={`冻结 ${formatMoney(account.frozen_cash)}`}
        />
        <MetricCard
          label="持仓市值"
          value={formatMoney(account.market_value)}
          detail={`${account.positions.length} 只持仓`}
        />
        <MetricCard
          label="已实现盈亏"
          value={formatMoney(account.realized_pnl)}
          detail="来自模拟成交"
          detailClassName={changeClass(account.realized_pnl)}
        />
        <MetricCard
          label="待撮合委托"
          value={`${account.open_orders.length}`}
          detail="非交易时段不成交"
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <div>
          <h3 className="text-sm font-semibold">模拟持仓</h3>
          <div className="mt-2 overflow-x-auto rounded-md border border-border/60">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">股票</th>
                  <th className="px-3 py-2 text-right font-medium">持仓</th>
                  <th className="px-3 py-2 text-right font-medium">可卖</th>
                  <th className="px-3 py-2 text-right font-medium">成本</th>
                  <th className="px-3 py-2 text-right font-medium">现价</th>
                  <th className="px-3 py-2 text-right font-medium">市值</th>
                  <th className="px-3 py-2 text-right font-medium">浮动盈亏</th>
                </tr>
              </thead>
              <tbody>
                {account.positions.map((position) => (
                  <tr
                    key={position.code}
                    className="border-b border-border/60 last:border-0"
                  >
                    <td className="px-3 py-3">
                      <div className="font-medium">{position.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {position.code}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right">
                      {position.quantity}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {position.available_quantity}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {formatPrice(position.cost_price, position.code)}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {formatPrice(position.price, position.code)}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {formatMoney(position.market_value)}
                    </td>
                    <td
                      className={`px-3 py-3 text-right ${changeClass(
                        position.unrealized_pnl,
                      )}`}
                    >
                      {formatMoney(position.unrealized_pnl)} /{" "}
                      {formatNumber(position.unrealized_pnl_pct)}%
                    </td>
                  </tr>
                ))}
                {account.positions.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-3 py-8 text-center text-sm text-muted-foreground"
                    >
                      暂无持仓，等待操盘交易员提交模拟委托。
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold">最近委托</h3>
            <div className="mt-2 space-y-2">
              {account.recent_orders.slice(0, 5).map((order) => (
                <div
                  key={order.id}
                  className="rounded-md border border-border/60 p-3 text-sm"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-medium">{order.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {order.code}
                      </span>
                    </div>
                    <span className="rounded-md bg-muted px-2 py-0.5 text-xs">
                      {orderStatusLabel(order.status)}
                    </span>
                  </div>
                  <div className="mt-2 text-xs leading-5 text-muted-foreground">
                    {orderSideLabel(order.side)} {order.quantity} 股，限价{" "}
                    {formatPrice(order.limit_price, order.code)}
                    {formatOrderStatusNote(order.status_note)}
                  </div>
                  {order.note ? (
                    <div className="mt-2 text-xs leading-5">{order.note}</div>
                  ) : null}
                </div>
              ))}
              {account.recent_orders.length === 0 ? (
                <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
                  暂无委托记录。
                </p>
              ) : null}
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold">最近成交</h3>
            <div className="mt-2 space-y-2">
              {account.recent_fills.slice(0, 4).map((fill) => (
                <div
                  key={fill.id}
                  className="rounded-md border border-border/60 p-3 text-sm"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{fill.name}</span>
                    <span className={changeClass(fill.side === "buy" ? 1 : -1)}>
                      {orderSideLabel(fill.side)}
                    </span>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    {fill.quantity} 股，成交价 {formatPrice(fill.price, fill.code)}，金额{" "}
                    {formatMoney(fill.amount)}
                  </div>
                </div>
              ))}
              {account.recent_fills.length === 0 ? (
                <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
                  暂无成交记录。
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function MetricCard({
  label,
  value,
  detail,
  detailClassName,
}: {
  label: string;
  value: string;
  detail: string;
  detailClassName?: string;
}) {
  return (
    <section className="rounded-lg border border-border/60 bg-background p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
      <p className={`mt-1 text-xs text-muted-foreground ${detailClassName ?? ""}`}>
        {detail}
      </p>
    </section>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border/60 bg-background p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}
