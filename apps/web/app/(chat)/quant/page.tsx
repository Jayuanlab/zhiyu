"use client";

import type {
  QuantDashboard,
  QuantNewsItem,
  QuantNewsSnapshot,
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

function signedNumber(value: number, digits = 2): string {
  const formatted = formatNumber(value, digits);
  return value > 0 ? `+${formatted}` : formatted;
}

function signedPercent(value: number, digits = 2): string {
  return `${signedNumber(value, digits)}%`;
}

function ratio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }
  return (numerator / denominator) * 100;
}

function marketRegime(temperature: number): {
  label: string;
  description: string;
  className: string;
} {
  if (temperature >= 70) {
    return {
      label: "偏热",
      description: "市场扩散较强，追高前先看持仓暴露。",
      className: "border-red-200 bg-red-50 text-red-700",
    };
  }
  if (temperature <= 35) {
    return {
      label: "偏冷",
      description: "下跌扩散更明显，优先保护现金和仓位。",
      className: "border-emerald-200 bg-emerald-50 text-emerald-700",
    };
  }
  return {
    label: "中性",
    description: "市场没有给出极端方向，适合等待确认。",
    className: "border-slate-200 bg-slate-50 text-slate-700",
  };
}

function dataQualityLabel(status: ReturnType<typeof quantQuality>["qualityStatus"]): string {
  return ({
    ready: "数据已返回",
    degraded: "数据不完整",
    stale: "历史缓存",
    unavailable: "暂不可用",
  })[status];
}

function scopeLabel(scope: ReturnType<typeof quantQuality>["scope"]): string {
  return ({
    full_market: "全市场",
    watchlist: "自选股范围",
    sample: "样例",
    unknown: "未知范围",
  })[scope];
}

function qualityWarningText(warning: string): string {
  if (warning.includes("Market observation time is unknown")) {
    return "行情观测时间未知";
  }
  if (warning.includes("quant account is still refreshing")) {
    return "模拟账户仍在后台刷新";
  }
  if (warning.includes("quant account refresh did not finish")) {
    return "本次账户刷新未完成，暂用最近账户快照";
  }
  if (warning.includes("quant page-state snapshot is stale")) {
    return "工作台快照偏旧，正在后台刷新";
  }
  if (warning.includes("Quant local snapshot is stale")) {
    return "本地行情快照偏旧，正在后台刷新";
  }
  return warning;
}

function qualityWarnings(warnings: string[]): string[] {
  return Array.from(new Set(warnings.map(qualityWarningText)));
}

function quantErrorText(error: string): string {
  if (error.includes("account refresh is still running")) {
    return "模拟账户仍在后台刷新";
  }
  if (error.includes("dashboard refresh is still running")) {
    return "市场快照仍在后台刷新";
  }
  if (error.includes("refresh timed out")) {
    return "刷新超时";
  }
  return error;
}

function newsKindLabel(kind: QuantNewsItem["kind"]): string {
  return ({
    market: "快讯",
    stock: "个股",
    announcement: "公告",
    irm: "问答",
  })[kind];
}

function formatNewsTime(value?: string): string {
  if (!value) return "未知时间";
  if (!Number.isFinite(Date.parse(value))) return value;
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
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
  const readableWarnings = qualityWarnings(quality.warnings);
  const error = requestError?.message ?? data?.meta.dashboard.error ?? data?.meta.account.error ?? null;

  return (
    <main className="h-full min-h-0 overflow-y-auto bg-[#eef2ef] text-slate-950">
      <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-5 px-4 py-5 pb-10 sm:px-6 lg:px-8">
        <header className="overflow-hidden rounded-[28px] border border-slate-900/10 bg-[#101418] text-white shadow-sm">
          <div className="grid gap-6 p-5 lg:grid-cols-[1.2fr_0.8fr] lg:p-7">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs uppercase tracking-[0.28em] text-white/70">
                  Quant desk
                </span>
                {dashboard?.service_mode === "sample" ? (
                  <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs text-white/75">
                    样例数据
                  </span>
                ) : null}
                {dashboard?.service_mode === "live" ? (
                  <span className="rounded-full border border-emerald-300/30 bg-emerald-300/10 px-3 py-1 text-xs text-emerald-100">
                    {dataProviderLabel(dashboard.data_provider, dashboard.data_source_detail)}
                    {dashboard.cache?.hit ? " · 缓存" : ""}
                  </span>
                ) : null}
                <span className="rounded-full border border-amber-300/30 bg-amber-300/10 px-3 py-1 text-xs text-amber-100">
                  模拟盘 · 不连接券商
                </span>
              </div>
              <h1 className="mt-5 max-w-4xl text-3xl font-semibold tracking-[-0.04em] text-white sm:text-5xl">
                量化工作台
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-white/70">
                一个给智能体模拟盘使用的市场看台：先看市场环境，再看账户暴露，最后处理自选股、信号、委托和成交。
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
              <HeaderStatus
                label="行情范围"
                value={scopeLabel(quality.scope)}
                detail={`${dataQualityLabel(quality.qualityStatus)}${quality.refreshing ? " · 后台刷新" : ""}`}
              />
              <HeaderStatus
                label="行情观测"
                value={formatQuoteTime(quality.observedAt)}
                detail={`抓取 ${formatQuoteTime(quality.fetchedAt)}`}
              />
              <button
                onClick={() => void mutate()}
                disabled={isValidating}
                className="inline-flex min-h-14 items-center justify-center gap-2 rounded-2xl border border-white/15 bg-white px-4 text-sm font-medium text-slate-950 transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="ri-refresh-line" aria-hidden />
                {isValidating ? "刷新中" : "刷新工作台"}
              </button>
            </div>
          </div>
        </header>

        <section aria-label="行情数据质量" className="rounded-2xl border border-slate-900/10 bg-white/80 px-4 py-3 text-sm leading-6 text-slate-600 shadow-sm">
          <p>
            来源：{quality.provider} · 统计范围：{scopeLabel(quality.scope)} · 状态：{dataQualityLabel(quality.qualityStatus)}
            {quality.refreshing ? " · 后台刷新中" : ""}
          </p>
          {readableWarnings.length ? <p className="text-amber-700">{readableWarnings.join("；")}</p> : null}
          {error ? <p role="alert" className="text-amber-700">刷新未完成：{quantErrorText(error)}。保留最近可用数据。</p> : null}
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
  const flatRatio = (market.flat_count / totalStocks) * 100;
  const regime = marketRegime(market.temperature);
  const buySignals = dashboard.signals.filter((signal) => signal.action === "buy_candidate");
  const sellSignals = dashboard.signals.filter((signal) => signal.action === "sell_candidate");
  const holdingCodes = new Set((paperAccount?.positions ?? []).map((position) => position.code));
  const watchlistMovers = [...dashboard.watchlist]
    .sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct))
    .slice(0, 5);
  const positionPnl = paperAccount?.positions.reduce(
    (sum, position) => sum + position.unrealized_pnl,
    0,
  ) ?? 0;
  const investedRatio = paperAccount
    ? ratio(paperAccount.market_value, paperAccount.total_asset)
    : 0;
  const newsFocusCode = paperAccount?.positions[0]?.code ?? dashboard.watchlist[0]?.code;

  return (
    <>
      {notice ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
          {notice}
        </section>
      ) : null}

      <section className="grid gap-4 2xl:grid-cols-[minmax(0,1.35fr)_minmax(380px,0.65fr)]">
        <div className="min-w-0 space-y-4">
          <section className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
            <div className="min-w-0 rounded-[28px] border border-slate-900/10 bg-white p-5 shadow-sm">
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.22em] text-slate-400">
                    Account exposure
                  </p>
                  <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em]">
                    智能体模拟盘
                  </h2>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
                    操盘交易员车间只能通过受控接口提交模拟委托。这里显示账户净值、仓位、未实现盈亏和待撮合风险，不连接券商。
                  </p>
                  {paperAccount?.historicalPerformanceComplete === false ? (
                    <p className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-800">
                      此账户包含恢复期初基线，历史现金与损益记录不完整。累计收益仅供账面参考。
                    </p>
                  ) : null}
                </div>
                <div className="rounded-2xl border border-slate-900/10 bg-slate-50 px-4 py-3 text-sm text-slate-500">
                  <div>状态变更</div>
                  <div className="mt-1 font-medium text-slate-900">
                    {paperAccount ? formatQuoteTime(paperAccount.stateChangedAt ?? paperAccount.updated_at) : "账户读取中"}
                  </div>
                </div>
              </div>

              {paperAccount ? (
                <>
                  <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <MetricCard
                      label="总资产"
                      value={formatMoney(paperAccount.total_asset)}
                      detail={`累计 ${signedPercent(paperAccount.total_pnl_pct)}`}
                      detailClassName={changeClass(paperAccount.total_pnl)}
                    />
                    <MetricCard
                      label="持仓浮盈亏"
                      value={formatMoney(positionPnl)}
                      detail={`${paperAccount.positions.length} 只持仓 · 仓位 ${formatPercent(investedRatio)}`}
                      detailClassName={changeClass(positionPnl)}
                    />
                    <MetricCard
                      label="可用现金"
                      value={formatMoney(paperAccount.cash)}
                      detail={`冻结 ${formatMoney(paperAccount.frozen_cash)}`}
                    />
                    <MetricCard
                      label="待撮合委托"
                      value={`${paperAccount.open_orders.length}`}
                      detail="非交易时段不成交"
                    />
                  </div>
                  <ExposureBar investedRatio={investedRatio} cashRatio={ratio(paperAccount.cash, paperAccount.total_asset)} />
                  <PositionTable account={paperAccount} />
                </>
              ) : (
                <div className="mt-5">
                  <PaperAccountPlaceholder loading={false} error={null} />
                </div>
              )}
            </div>

            <Panel title="今日控制摘要" eyebrow="Control brief">
              <div className="space-y-3">
                <BriefRow
                  label="市场温度"
                  value={`${formatNumber(market.temperature, 0)} · ${regime.label}`}
                  detail={regime.description}
                  badgeClassName={regime.className}
                />
                <BriefRow
                  label="市场宽度"
                  value={`涨 ${formatPercent(upRatio)} / 跌 ${formatPercent(downRatio)}`}
                  detail={`${formatNumber(market.up_count, 0)} 家上涨，${formatNumber(market.down_count, 0)} 家下跌`}
                />
                <BriefRow
                  label="信号队列"
                  value={`${buySignals.length} 买入候选 / ${sellSignals.length} 卖出候选`}
                  detail={`${dashboard.signals.length} 条策略信号等待车间判断`}
                />
                <BriefRow
                  label="账户暴露"
                  value={paperAccount ? `仓位 ${formatPercent(investedRatio)}` : "账户读取中"}
                  detail={paperAccount ? `现金 ${formatMoney(paperAccount.cash)}，持仓市值 ${formatMoney(paperAccount.market_value)}` : "账户返回后自动补齐"}
                />
              </div>
            </Panel>
          </section>

          <section className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
            <Panel title="主要指数" eyebrow="Market tape">
              <div className="grid gap-2 sm:grid-cols-2">
                {market.indices.map((item) => (
                  <IndexTile key={item.code} item={item} />
                ))}
              </div>
            </Panel>

            <Panel title={scope === "full_market" ? "全市场宽度" : "范围内涨跌分布"} eyebrow="Breadth">
              <div className="space-y-4">
                <div className="overflow-hidden rounded-2xl border border-slate-900/10 bg-slate-50">
                  <div className="flex h-4">
                    <div className="bg-red-500" style={{ width: `${Math.min(100, Math.max(0, upRatio))}%` }} />
                    <div className="bg-slate-300" style={{ width: `${Math.min(100, Math.max(0, flatRatio))}%` }} />
                    <div className="bg-emerald-500" style={{ width: `${Math.min(100, Math.max(0, downRatio))}%` }} />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <BreadthPill label="上涨" value={market.up_count} ratio={upRatio} className="text-red-600" />
                  <BreadthPill label="平盘" value={market.flat_count} ratio={flatRatio} className="text-slate-500" />
                  <BreadthPill label="下跌" value={market.down_count} ratio={downRatio} className="text-emerald-600" />
                </div>
              </div>
            </Panel>
          </section>

          <Panel title="自选股行情" eyebrow="Watchlist">
          <WatchlistManager
            initialCodes={dashboard.watchlist.map((item) => item.code)}
          />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-sm">
              <thead className="border-b border-slate-900/10 text-xs text-slate-400">
                <tr>
                  <th className="py-2 text-left font-medium">股票</th>
                  <th className="py-2 text-left font-medium">状态</th>
                  <th className="py-2 text-right font-medium">最新价</th>
                  <th className="py-2 text-right font-medium">涨跌幅</th>
                  <th className="py-2 text-right font-medium">估值</th>
                  <th className="py-2 text-right font-medium">质量</th>
                  <th className="py-2 text-right font-medium">报价时间</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.watchlist.map((item) => (
                  <tr
                    key={item.code}
                    className="border-b border-slate-900/5 last:border-0"
                  >
                    <td className="py-3">
                      <div className="flex items-center gap-2 font-medium">
                        {item.name}
                        {holdingCodes.has(item.code) ? (
                          <span className="rounded-full bg-slate-900 px-2 py-0.5 text-[10px] font-medium text-white">
                            持仓
                          </span>
                        ) : null}
                      </div>
                      <div className="text-xs text-slate-400">
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
                      PE {formatNumber(item.pe_ttm, 1)}
                    </td>
                    <td className="py-3 text-right">
                      ROE {formatNumber(item.roe, 1)}%
                    </td>
                    <td className="py-3 text-right text-xs text-slate-400">
                      {formatQuoteTime(item.updated_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        </div>

        <aside className="space-y-4">
          <Panel title="市场雷达" eyebrow="Heat board">
            <div className="grid grid-cols-[120px_1fr] gap-4">
              <div className="flex aspect-square items-center justify-center rounded-full border border-slate-900/10 bg-[conic-gradient(from_180deg,#10b981_0deg,#d1d5db_130deg,#ef4444_260deg,#ef4444_360deg)] p-2">
                <div className="flex size-full flex-col items-center justify-center rounded-full bg-white text-center">
                  <div className="text-3xl font-semibold tracking-[-0.04em]">
                    {formatNumber(market.temperature, 0)}
                  </div>
                  <div className="text-xs text-slate-500">{regime.label}</div>
                </div>
              </div>
              <div className="min-w-0 space-y-2">
                <div className={`inline-flex rounded-full border px-3 py-1 text-xs font-medium ${regime.className}`}>
                  {scope === "full_market" ? "全市场观测" : "范围参考"}
                </div>
                <p className="text-sm leading-6 text-slate-600">
                  {regime.description} 今日成交额 {formatTurnover(market.turnover_billion)}，交易日 {market.trade_date}。
                </p>
              </div>
            </div>
          </Panel>

          <QuantNewsPanel focusCode={newsFocusCode} />

          <Panel title="行业热度" eyebrow="Sectors">
            <div className="space-y-2">
              {market.sectors.slice(0, 8).map((sector) => (
                <SectorRow key={sector.name} sector={sector} />
              ))}
              {market.sectors.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-slate-300 p-4 text-sm text-slate-500">
                  当前数据源暂未返回行业热度。
                </p>
              ) : null}
            </div>
          </Panel>

          <Panel title="策略信号" eyebrow="Signals">
            <div className="space-y-3">
              {dashboard.signals.map((signal) => (
                <SignalCard key={signal.id} signal={signal} holding={holdingCodes.has(signal.code)} />
              ))}
              {dashboard.signals.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-slate-300 p-4 text-sm text-slate-500">
                  暂无策略信号。
                </p>
              ) : null}
            </div>
          </Panel>

          <Panel title="自选异动" eyebrow="Movers">
            <div className="space-y-2">
              {watchlistMovers.map((item) => (
                <div key={item.code} className="flex items-center justify-between gap-3 rounded-2xl border border-slate-900/10 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{item.name}</div>
                    <div className="text-xs text-slate-400">{item.code}</div>
                  </div>
                  <div className={`text-right font-medium ${changeClass(item.change_pct)}`}>
                    {signedPercent(item.change_pct)}
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="每日复盘" eyebrow="Review">
            <p className="text-sm leading-7 text-slate-600">{dashboard.daily_report.summary}</p>
            <h3 className="mt-4 text-sm font-semibold">下一步观察</h3>
            <ul className="mt-2 space-y-2 text-sm text-slate-600">
              {dashboard.daily_report.next_actions.map((action) => (
                <li key={action} className="flex gap-2">
                  <span className="ri-checkbox-circle-line mt-0.5 text-slate-900" />
                  <span>{action}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </aside>
      </section>
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

function HeaderStatus({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3">
      <div className="text-xs text-white/45">{label}</div>
      <div className="mt-1 truncate text-sm font-medium text-white">{value}</div>
      <div className="mt-1 truncate text-xs text-white/45">{detail}</div>
    </div>
  );
}

function ExposureBar({
  investedRatio,
  cashRatio,
}: {
  investedRatio: number;
  cashRatio: number;
}) {
  const invested = Math.min(100, Math.max(0, investedRatio));
  const cash = Math.min(100, Math.max(0, cashRatio));
  return (
    <div className="mt-5 rounded-2xl border border-slate-900/10 bg-slate-50 p-4">
      <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
        <span>账户暴露</span>
        <span>持仓 {formatPercent(invested)} · 现金 {formatPercent(cash)}</span>
      </div>
      <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-slate-200">
        <div className="bg-slate-950" style={{ width: `${invested}%` }} />
        <div className="bg-slate-400" style={{ width: `${cash}%` }} />
      </div>
    </div>
  );
}

function PositionTable({ account }: { account: QuantPaperAccount }) {
  return (
    <div className="mt-5">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">模拟持仓</h3>
        <span className="text-xs text-slate-400">按当前行情重估</span>
      </div>
      <div className="overflow-x-auto rounded-2xl border border-slate-900/10">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="border-b border-slate-900/10 bg-slate-50 text-xs text-slate-400">
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
                className="border-b border-slate-900/5 last:border-0"
              >
                <td className="px-3 py-3">
                  <div className="font-medium">{position.name}</div>
                  <div className="text-xs text-slate-400">{position.code}</div>
                </td>
                <td className="px-3 py-3 text-right">{position.quantity}</td>
                <td className="px-3 py-3 text-right">{position.available_quantity}</td>
                <td className="px-3 py-3 text-right">{formatPrice(position.cost_price, position.code)}</td>
                <td className="px-3 py-3 text-right">{formatPrice(position.price, position.code)}</td>
                <td className="px-3 py-3 text-right">{formatMoney(position.market_value)}</td>
                <td className={`px-3 py-3 text-right font-medium ${changeClass(position.unrealized_pnl)}`}>
                  {formatMoney(position.unrealized_pnl)} / {signedPercent(position.unrealized_pnl_pct)}
                </td>
              </tr>
            ))}
            {account.positions.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-3 py-8 text-center text-sm text-slate-500"
                >
                  暂无持仓，等待操盘交易员提交模拟委托。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BriefRow({
  label,
  value,
  detail,
  badgeClassName,
}: {
  label: string;
  value: string;
  detail: string;
  badgeClassName?: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-900/10 bg-white px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-slate-400">{label}</span>
        {badgeClassName ? (
          <span className={`rounded-full border px-2 py-0.5 text-xs ${badgeClassName}`}>
            {value}
          </span>
        ) : (
          <span className="text-sm font-medium text-slate-900">{value}</span>
        )}
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-500">{detail}</p>
    </div>
  );
}

function IndexTile({ item }: { item: QuantDashboard["market"]["indices"][number] }) {
  return (
    <div className="rounded-2xl border border-slate-900/10 bg-slate-50 px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{item.name}</span>
        <span className={`text-sm font-medium ${changeClass(item.change_pct)}`}>
          {signedPercent(item.change_pct)}
        </span>
      </div>
      <div className="mt-3 flex items-end justify-between gap-3 text-xs text-slate-500">
        <span className="font-mono text-base text-slate-950">{formatPrice(item.price, item.code)}</span>
        <span>{formatTurnover(item.turnover_billion)}</span>
      </div>
    </div>
  );
}

function BreadthPill({
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
    <div className="rounded-2xl border border-slate-900/10 bg-slate-50 px-3 py-3">
      <div className="text-xs text-slate-400">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${className}`}>{formatNumber(value, 0)}</div>
      <div className="mt-1 text-xs text-slate-500">{formatPercent(ratio)}</div>
    </div>
  );
}

function SectorRow({ sector }: { sector: QuantDashboard["market"]["sectors"][number] }) {
  const width = Math.min(100, Math.max(6, Math.abs(sector.change_pct) * 18));
  return (
    <div className="rounded-2xl border border-slate-900/10 px-3 py-2">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="min-w-0 truncate font-medium">{sector.name}</span>
        <span className={changeClass(sector.change_pct)}>
          {signedPercent(sector.change_pct)}
        </span>
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-slate-100">
        <div
          className={sector.change_pct >= 0 ? "h-1.5 rounded-full bg-red-500" : "h-1.5 rounded-full bg-emerald-500"}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

function QuantNewsPanel({ focusCode }: { focusCode?: string }) {
  const params = new URLSearchParams({ pageSize: "8" });
  if (focusCode) params.set("code", focusCode);
  const { data, error, isLoading, isValidating, mutate } = useSWR<QuantNewsSnapshot>(
    `/api/quant/news?${params.toString()}`,
    async (url: string) => {
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error("量化资讯暂不可用");
      return response.json();
    },
    {
      refreshInterval: 5 * 60_000,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      dedupingInterval: 30_000,
      keepPreviousData: true,
      errorRetryInterval: 60_000,
      errorRetryCount: 2,
    },
  );
  const global = data?.global ?? [];
  const focused = data?.focused ?? [];

  return (
    <Panel title="最新资讯" eyebrow="News feed">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs leading-5 text-slate-500">
          东方财富快讯{focusCode ? ` · 关注 ${focusCode}` : ""}。资讯只作为市场观察输入。
        </p>
        <button
          type="button"
          onClick={() => void mutate()}
          disabled={isValidating}
          className="shrink-0 rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          {isValidating ? "刷新中" : "刷新"}
        </button>
      </div>
      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((item) => (
            <div key={item} className="h-16 animate-pulse rounded-2xl bg-slate-100" />
          ))}
        </div>
      ) : error ? (
        <p className="rounded-2xl border border-dashed border-slate-300 p-4 text-sm text-slate-500">
          资讯源暂时没有返回，市场和账户数据仍可继续使用。
        </p>
      ) : (
        <div className="space-y-4">
          <NewsList title="市场快讯" items={global.slice(0, 4)} />
          {focused.length ? (
            <NewsList title="关注标的" items={focused.slice(0, 4)} />
          ) : null}
          <div className="border-t border-slate-900/10 pt-3 text-xs leading-5 text-slate-400">
            <div>更新：{formatNewsTime(data?.fetched_at)}</div>
            {data?.warnings?.length ? (
              <div className="text-amber-700">部分资讯源未返回，已展示可用内容。</div>
            ) : null}
          </div>
        </div>
      )}
    </Panel>
  );
}

function NewsList({
  title,
  items,
}: {
  title: string;
  items: QuantNewsItem[];
}) {
  if (!items.length) {
    return (
      <div>
        <h3 className="text-xs font-medium text-slate-400">{title}</h3>
        <p className="mt-2 rounded-2xl border border-dashed border-slate-300 p-3 text-sm text-slate-500">
          暂无可展示资讯。
        </p>
      </div>
    );
  }
  return (
    <div>
      <h3 className="text-xs font-medium text-slate-400">{title}</h3>
      <div className="mt-2 space-y-2">
        {items.map((item) => (
          <NewsItemCard key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}

function NewsItemCard({ item }: { item: QuantNewsItem }) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">
          {newsKindLabel(item.kind)}
        </span>
        <span className="shrink-0 text-[10px] text-slate-400">
          {formatNewsTime(item.time)}
        </span>
      </div>
      <h4 className="mt-2 text-sm font-medium leading-5 text-slate-950">
        {item.title}
      </h4>
      {item.summary ? (
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">
          {item.summary}
        </p>
      ) : null}
      {item.source ? (
        <p className="mt-2 text-[10px] text-slate-400">{item.source}</p>
      ) : null}
    </>
  );

  if (item.url) {
    return (
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer"
        className="block rounded-2xl border border-slate-900/10 p-3 transition hover:border-slate-900/20 hover:bg-slate-50"
      >
        {body}
      </a>
    );
  }

  return (
    <article className="rounded-2xl border border-slate-900/10 p-3">
      {body}
    </article>
  );
}

function SignalCard({
  signal,
  holding,
}: {
  signal: QuantSignal;
  holding: boolean;
}) {
  return (
    <article className="rounded-2xl border border-slate-900/10 bg-white p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{signal.name}</h3>
          <p className="text-xs text-slate-400">
            {signal.code} · {signal.strategy}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          {holding ? (
            <span className="rounded-full bg-slate-900 px-2 py-0.5 text-[10px] text-white">
              持仓
            </span>
          ) : null}
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
            {actionLabel(signal.action)}
          </span>
        </div>
      </div>
      <div className="mt-3">
        <div className="mb-1 flex justify-between text-xs text-slate-400">
          <span>强度</span>
          <span>{signal.strength}</span>
        </div>
        <div className="h-2 rounded-full bg-slate-100">
          <div
            className="h-2 rounded-full bg-slate-950"
            style={{ width: `${Math.min(100, Math.max(0, signal.strength))}%` }}
          />
        </div>
      </div>
      <p className="mt-3 text-sm leading-6 text-slate-600">{signal.reason}</p>
      <p className="mt-2 rounded-2xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
        {signal.risk}
      </p>
    </article>
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
    <section className="rounded-[28px] border border-slate-900/10 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">智能体模拟盘</h2>
            <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
              初始资金 {formatMoney(account.initial_cash)}
            </span>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-500">
              只模拟撮合，不连接券商
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            操盘交易员车间通过受控接口提交限价委托；模拟盘执行现金、仓位、T+1、100 股整数倍和涨跌幅边界。
          </p>
          {account.historicalPerformanceComplete===false?<p className="mt-2 text-sm text-amber-700">此账户包含恢复期初基线，历史现金与损益记录不完整。累计收益仅供账面参考，不代表完整历史绩效。</p>:null}
        </div>
        <div className="flex flex-col gap-2 md:items-end">
          <div className="text-xs text-slate-500">
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
          <div className="mt-2 overflow-x-auto rounded-2xl border border-slate-900/10">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b border-slate-900/10 bg-slate-50 text-xs text-slate-400">
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
                    className="border-b border-slate-900/5 last:border-0"
                  >
                    <td className="px-3 py-3">
                      <div className="font-medium">{position.name}</div>
                      <div className="text-xs text-slate-400">
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
                      className="px-3 py-8 text-center text-sm text-slate-500"
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
                  className="rounded-2xl border border-slate-900/10 p-3 text-sm"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-medium">{order.name}</span>
                      <span className="ml-2 text-xs text-slate-400">
                        {order.code}
                      </span>
                    </div>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                      {orderStatusLabel(order.status)}
                    </span>
                  </div>
                  <div className="mt-2 text-xs leading-5 text-slate-500">
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
                <p className="rounded-2xl border border-dashed border-slate-300 p-4 text-sm text-slate-500">
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
                  className="rounded-2xl border border-slate-900/10 p-3 text-sm"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{fill.name}</span>
                    <span className={changeClass(fill.side === "buy" ? 1 : -1)}>
                      {orderSideLabel(fill.side)}
                    </span>
                  </div>
                  <div className="mt-2 text-xs text-slate-500">
                    {fill.quantity} 股，成交价 {formatPrice(fill.price, fill.code)}，金额{" "}
                    {formatMoney(fill.amount)}
                  </div>
                </div>
              ))}
              {account.recent_fills.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-slate-300 p-4 text-sm text-slate-500">
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
    <section className="rounded-2xl border border-slate-900/10 bg-slate-50 p-4">
      <p className="text-sm text-slate-500">{label}</p>
      <div className="mt-2 text-2xl font-semibold tracking-[-0.03em]">{value}</div>
      <p className={`mt-1 text-xs text-slate-500 ${detailClassName ?? ""}`}>
        {detail}
      </p>
    </section>
  );
}

function Panel({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 self-start rounded-[24px] border border-slate-900/10 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {eyebrow ? (
          <span className="text-[10px] font-medium uppercase tracking-[0.22em] text-slate-300">
            {eyebrow}
          </span>
        ) : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}
