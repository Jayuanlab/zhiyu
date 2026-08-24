import { describe, expect, it } from "vitest";
import { mergeQuantPageStateWithPrevious } from "@/lib/quant/page-state";
import type {
  QuantDashboard,
  QuantPageState,
  QuantPaperAccount,
} from "@/lib/quant/types";

function account(id: string): QuantPaperAccount {
  return {
    id,
    mode: "paper",
    trading_enabled: true,
    initial_cash: 100_000,
    cash: 50_000,
    frozen_cash: 0,
    market_value: 50_000,
    total_asset: 100_000,
    realized_pnl: 0,
    total_pnl: 0,
    total_pnl_pct: 0,
    positions: [],
    open_orders: [],
    recent_orders: [],
    recent_fills: [],
    rules: {},
    updated_at: "2026-08-22T00:00:00.000Z",
  };
}

function dashboard(generatedAt: string): QuantDashboard {
  return {
    generated_at: generatedAt,
    service_mode: "live",
    market: {
      trade_date: "2026-08-22",
      temperature: 50,
      up_count: 1,
      down_count: 1,
      flat_count: 0,
      turnover_billion: 100,
      indices: [],
      sectors: [],
    },
    watchlist: [],
    signals: [],
    portfolio: {
      mode: "paper",
      total_value: 100_000,
      cash: 100_000,
      daily_pnl: 0,
      daily_pnl_pct: 0,
      total_pnl: 0,
      total_pnl_pct: 0,
      max_drawdown_pct: 0,
      positions: [],
      risk: {
        cash_weight_pct: 100,
        largest_position_pct: 0,
        sector_concentration: "none",
        alerts: [],
      },
    },
    daily_report: {
      title: "daily",
      summary: "summary",
      next_actions: [],
    },
  };
}

function pageState(input: {
  account: QuantPaperAccount | null;
  dashboard: QuantDashboard | null;
}): QuantPageState {
  return {
    account: input.account,
    dashboard: input.dashboard,
    meta: {
      generated_at: "2026-08-22T00:00:00.000Z",
      account: {
        ok: input.account !== null,
      },
      dashboard: {
        ok: input.dashboard !== null,
      },
      warnings: [],
    },
  };
}

describe("mergeQuantPageStateWithPrevious", () => {
  it("preserves previous account and dashboard when the current refresh is sparse", () => {
    const previous = pageState({
      account: account("paper-account"),
      dashboard: dashboard("2026-08-22T00:00:00.000Z"),
    });
    const current = pageState({
      account: null,
      dashboard: null,
    });

    const merged = mergeQuantPageStateWithPrevious({ current, previous });

    expect(merged.account?.id).toBe("paper-account");
    expect(merged.dashboard?.generated_at).toBe("2026-08-22T00:00:00.000Z");
    expect(merged.meta.account).toMatchObject({
      ok: true,
      stale: true,
      refreshing: true,
    });
    expect(merged.meta.dashboard).toMatchObject({
      ok: true,
      stale: true,
      refreshing: true,
    });
    expect(merged.meta.warnings).toContain(
      "quant account refresh did not finish; using previous account snapshot",
    );
    expect(merged.meta.warnings).toContain(
      "quant dashboard refresh did not finish; using previous dashboard snapshot",
    );
  });

  it("keeps fresh current values when refresh returns complete data", () => {
    const previous = pageState({
      account: account("old-account"),
      dashboard: dashboard("2026-08-22T00:00:00.000Z"),
    });
    const current = pageState({
      account: account("new-account"),
      dashboard: dashboard("2026-08-22T00:01:00.000Z"),
    });

    const merged = mergeQuantPageStateWithPrevious({ current, previous });

    expect(merged.account?.id).toBe("new-account");
    expect(merged.dashboard?.generated_at).toBe("2026-08-22T00:01:00.000Z");
    expect(merged.meta.account.stale).toBeUndefined();
    expect(merged.meta.dashboard.stale).toBeUndefined();
  });
});
