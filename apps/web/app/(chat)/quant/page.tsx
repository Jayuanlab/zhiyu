"use client";

import type {
  QuantDashboard,
  QuantPageState,
  QuantPaperAccount,
  QuantPaperOrder,
  QuantSignal,
} from "@/lib/quant/types";
import { formatPrice } from "@/lib/quant/price-format";
import { useEffect, useState } from "react";
import { PanelState } from "@/components/workbench/panel-state";
import { WatchlistManager } from "./watchlist-manager";

function formatNumber(value: number, digits = 2): string {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

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
  return new Date(value).toLocaleTimeString("zh-CN", {
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
    return "全市场数据源暂不可用，已自动切换为腾讯行情，当前指数和自选股仍使用实时行情。";
  }
  return dashboard.provider_error;
}

export default function QuantPage() {
  const [dashboard, setDashboard] = useState<QuantDashboard | null>(null);
  const [paperAccount, setPaperAccount] = useState<QuantPaperAccount | null>(
    null,
  );
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [accountLoading, setAccountLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    async function loadAccountDirect() {
      setAccountLoading(true);
      try {
        const response = await fetch("/api/quant/paper/account", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const nextAccount = (await response.json()) as QuantPaperAccount;
        if (cancelled) return;
        setPaperAccount(nextAccount);
      } catch {
        if (cancelled || controller.signal.aborted) return;
      } finally {
        if (!cancelled) setAccountLoading(false);
      }
    }

    async function loadDashboardDirect() {
      setDashboardLoading(true);
      try {
        const response = await fetch("/api/quant/dashboard", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as
            | { error?: string; hint?: string }
            | null;
          throw new Error(
            payload?.error ??
              payload?.hint ??
              `Quant service returned ${response.status}`,
          );
        }
        const nextDashboard = (await response.json()) as QuantDashboard;
        if (cancelled) return;
        setDashboard(nextDashboard);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "量化市场数据暂不可用");
      } finally {
        if (!cancelled) setDashboardLoading(false);
      }
    }

    async function loadQuantPageState() {
      setDashboardLoading(true);
      setAccountLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/page-state/quant", {
          cache: "no-store",
          signal: controller.signal,
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as
            | { error?: string; hint?: string }
            | null;
          throw new Error(
            payload?.error ??
              payload?.hint ??
              `Quant page state returned ${response.status}`,
          );
        }

        const pageState = (await response.json()) as QuantPageState;

        if (cancelled) return;
        setPaperAccount(pageState.account);
        setDashboard(pageState.dashboard);
        setAccountLoading(false);
        setDashboardLoading(!pageState.dashboard);
        if (pageState.meta.warnings.length > 0) {
          setError(pageState.meta.warnings[0] ?? null);
        }
        if (!pageState.dashboard) {
          void loadDashboardDirect();
        }
        if (!pageState.account) {
          void loadAccountDirect();
        }
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "量化服务暂不可用");
        setAccountLoading(false);
        void loadAccountDirect();
        void loadDashboardDirect();
      } finally {
        if (!cancelled) setAccountLoading(false);
      }
    }

    loadQuantPageState();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

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
                    实时行情 · {dataProviderLabel(dashboard.data_provider, dashboard.data_source_detail)}
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
            <a
              href="/quant"
              className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm hover:bg-muted"
            >
              <span className="ri-refresh-line" aria-hidden />
              刷新
            </a>
          </div>
        </header>

        {!dashboard ? (
          <>
            {paperAccount ? (
              <PaperAccountPanel account={paperAccount} />
            ) : (
              <PaperAccountPlaceholder loading={accountLoading} error={error} />
            )}
            <QuantMarketPlaceholder loading={dashboardLoading} error={error} />
          </>
        ) : error && !paperAccount ? (
          <section className="rounded-md border border-border bg-card p-10 text-center">
            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-md bg-amber-50 text-amber-700">
              <span className="ri-server-line text-2xl" aria-hidden />
            </div>
            <h2 className="text-base font-semibold">量化服务未连接</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              请启动量化服务，并确认 QUANT_SERVICE_URL 指向该服务。
            </p>
            <p className="mt-3 text-xs text-muted-foreground">{error}</p>
          </section>
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
          label="市场温度"
          value={`${market.temperature}`}
          detail={`上涨 ${market.up_count} 家 / 下跌 ${market.down_count} 家`}
        />
        <MetricCard
          label="成交额"
          value={formatTurnover(market.turnover_billion)}
          detail={market.trade_date}
        />
        <MetricCard
          label="上涨家数"
          value={`${market.up_count}`}
          detail={`占比 ${formatPercent(upRatio)}`}
          detailClassName="text-red-600"
        />
        <MetricCard
          label="下跌家数"
          value={`${market.down_count}`}
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

        <Panel title="市场宽度">
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
        </div>
        <div className="flex flex-col gap-2 md:items-end">
          <div className="text-xs text-muted-foreground">
            更新时间：{new Date(account.updated_at).toLocaleString("zh-CN")}
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
