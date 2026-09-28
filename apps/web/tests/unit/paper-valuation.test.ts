import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enrichPaperAccountValuation,
  paperAccountNeedsValuationRefresh,
} from "@/lib/quant/paper-valuation";
import type { QuantPaperAccount } from "@/lib/quant/types";

const runAStockDataActionMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/workshops/a-stock-data-client", () => ({
  runAStockDataAction: runAStockDataActionMock,
}));

function account(): QuantPaperAccount {
  return {
    id: "paper",
    mode: "paper",
    trading_enabled: true,
    initial_cash: 1_000_000,
    cash: 985_280.9,
    frozen_cash: 0,
    market_value: 14_719.1,
    total_asset: 1_000_000,
    realized_pnl: 0,
    total_pnl: 0,
    total_pnl_pct: 0,
    positions: [
      {
        code: "515980.SH",
        name: "ETF",
        quantity: 10_300,
        available_quantity: 10_300,
        cost_price: 1.017,
        price: 1.017,
        market_value: 10_475.1,
        unrealized_pnl: 0,
        unrealized_pnl_pct: 0,
      },
      {
        code: "002716.SZ",
        name: "Stock",
        quantity: 400,
        available_quantity: 400,
        cost_price: 10.61,
        price: 10.61,
        market_value: 4_244,
        unrealized_pnl: 0,
        unrealized_pnl_pct: 0,
      },
    ],
    open_orders: [],
    recent_orders: [],
    recent_fills: [],
    rules: {},
    updated_at: "2026-09-15T00:00:00.000Z",
  };
}

describe("paper account valuation overlay", () => {
  beforeEach(() => {
    runAStockDataActionMock.mockReset();
  });

  it("detects positions that still use cost price as market price", () => {
    expect(paperAccountNeedsValuationRefresh(account())).toBe(true);
  });

  it("revalues positions from controlled quote data", async () => {
    runAStockDataActionMock.mockResolvedValue({
      ok: true,
      data: {
        "515980": { price: 0.981, name: "ETF" },
        "002716": { price: 9.88, name: "Stock" },
      },
      sources: ["Tencent"],
      fetchedAt: "2026-09-15T00:01:00.000Z",
    });

    const enriched = await enrichPaperAccountValuation(account());

    expect(enriched.positions[0]).toMatchObject({
      code: "515980.SH",
      price: 0.981,
      market_value: 10_104.3,
      unrealized_pnl: -370.8,
    });
    expect(enriched.positions[1]).toMatchObject({
      code: "002716.SZ",
      price: 9.88,
      market_value: 3_952,
      unrealized_pnl: -292,
    });
    expect(enriched.market_value).toBe(14_056.3);
    expect(enriched.total_asset).toBe(999_337.2);
    expect(enriched.total_pnl).toBe(-662.8);
    expect(enriched.total_pnl_pct).toBe(-0.0663);
  });

  it("keeps the account readable when quote refresh fails", async () => {
    runAStockDataActionMock.mockResolvedValue({
      ok: false,
      error: "quote unavailable",
    });

    const enriched = await enrichPaperAccountValuation(account());

    expect(enriched.positions[0].unrealized_pnl).toBe(0);
    expect(enriched.valuation?.warning).toBe("quote unavailable");
  });
});
