import type { QuantDashboard, QuantPageState, QuantQualityEnvelope } from "./types";

function timestamp(value: unknown): string | null {
  return typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}

/** Cache timestamps never substitute for source observations. */
export function quantQuality(dashboard: QuantDashboard | null, meta?: QuantPageState["meta"], now = Date.now()): QuantQualityEnvelope {
  const source = dashboard?.quality;
  const market = dashboard?.market;
  const scope = dashboard?.service_mode === "sample" ? "sample" :
    source?.scope ?? (market?.market_scope === "full_market" ? "full_market" :
      ["watchlist", "watchlist_fallback"].includes(market?.market_scope ?? "") ? "watchlist" : "unknown");
  const observedAt = timestamp(source?.observedAt);
  const expiresAt = timestamp(source?.expiresAt);
  const warnings = [...(source?.warnings ?? []), ...(meta?.warnings ?? [])];
  if (market?.market_warning) warnings.push(market.market_warning);
  if (dashboard?.provider_error) warnings.push(dashboard.provider_error);
  if (scope !== "full_market") warnings.push(scope === "watchlist" ? "仅自选股范围参考，不代表全市场" : "统计范围未覆盖完整市场");
  if (!observedAt) warnings.push("行情观测时间未知");
  if (observedAt && Date.parse(observedAt) > now + 60_000) warnings.push("行情时间超前，请检查数据源时钟");
  const lastRefreshError = meta?.dashboard.error ?? dashboard?.cache?.lastRefreshError ?? source?.lastRefreshError ?? null;
  if (lastRefreshError) warnings.push(lastRefreshError);
  const stale = meta?.dashboard.stale || meta?.cache?.stale || dashboard?.cache?.stale || (expiresAt !== null && Date.parse(expiresAt) < now);
  return {
    schemaVersion: "quant-quality.v1", provider: source?.provider ?? market?.market_source ?? dashboard?.data_provider ?? "unknown",
    detail: source?.detail ?? dashboard?.data_source_detail ?? null, scope, observedAt,
    fetchedAt: timestamp(source?.fetchedAt), generatedAt: timestamp(source?.generatedAt ?? dashboard?.generated_at), expiresAt,
    refreshing: Boolean(meta?.dashboard.pending || meta?.dashboard.refreshing || meta?.cache?.refreshing || dashboard?.cache?.refreshing || source?.refreshing),
    lastRefreshError, warnings: [...new Set(warnings)],
    qualityStatus: !dashboard ? "unavailable" : stale ? "stale" : warnings.length ? "degraded" : "ready",
    exchange: source?.exchange ?? null, quoteSessionDate: source?.quoteSessionDate ?? null, calendarVersion: source?.calendarVersion ?? null,
  };
}

export function quantRefreshInterval(state?: QuantPageState): number {
  if (!state) return 2_000;
  const quality = quantQuality(state.dashboard, state.meta);
  if (quality.lastRefreshError && !state.meta.dashboard.pending) return 60_000;
  return quality.refreshing || !state.dashboard ? 2_000 : 15_000;
}

export function formatQuantNumber(value: unknown, digits = 2): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value)
    : "—";
}
