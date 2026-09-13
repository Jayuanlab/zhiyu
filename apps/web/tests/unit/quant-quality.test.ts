import { describe, expect, it } from "vitest";
import { formatQuantNumber, quantQuality, quantRefreshInterval } from "@/lib/quant/quality";
import type { QuantDashboard, QuantPageState } from "@/lib/quant/types";

const dashboard = { service_mode: "live", generated_at: "2026-09-06T09:00:00Z", market: {market_scope: "watchlist_fallback", temperature: 100} } as QuantDashboard;
describe("quant quality projection", () => {
  it("does not promote one-symbol statistics or newly cached data to full/fresh observations", () => {
    expect(quantQuality({...dashboard, cache: {hit: true, stale: false, fetched_at: "2026-09-06T09:00:00Z", expires_at: "2026-09-06T10:00:00Z"}})).toMatchObject({scope: "watchlist", observedAt: null, qualityStatus: "degraded"});
  });
  it("keeps Friday observations and account change times distinct from Sunday retrieval", () => {
    const source = {...dashboard, quality: {...quantQuality(dashboard), scope: "full_market", observedAt: "2026-09-04T15:00:00+08:00", fetchedAt: "2026-09-06T09:00:00Z", expiresAt: "2026-09-06T10:00:00Z", warnings: [], quoteSessionDate: "2026-09-04"}} as QuantDashboard;
    const result = quantQuality(source, undefined, Date.parse("2026-09-06T09:01:00Z"));
    expect(result).toMatchObject({qualityStatus: "ready", observedAt: "2026-09-04T15:00:00+08:00", quoteSessionDate: "2026-09-04"});
    expect(quantQuality(source, undefined, Date.parse("2026-09-03T09:00:00Z")).qualityStatus).toBe("degraded");
  });
  it("keeps stale data visibly degraded on refresh failures", () => {
    const state: QuantPageState = {account: null, dashboard, meta: {dashboard: {ok: true, stale: true, error: "offline"}, account: {ok: true}, warnings: [], generated_at: "now"}};
    expect(quantQuality(dashboard, state.meta)).toMatchObject({qualityStatus: "stale", lastRefreshError: "offline"});
    expect(quantRefreshInterval(state)).toBe(60_000);
    expect(quantRefreshInterval({...state, meta: {...state.meta, dashboard: {ok: false, pending: true, refreshing: true}}})).toBe(2_000);
  });
  it("preserves valid zero and displays unknown values separately", () => {
    expect(formatQuantNumber(0, 0)).toBe("0");
    for (const value of [undefined, null, NaN, Infinity]) expect(formatQuantNumber(value)).toBe("—");
  });
});
