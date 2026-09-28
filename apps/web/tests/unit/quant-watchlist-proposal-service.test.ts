import { describe, expect, it } from "vitest";
import {
  compactAStockQuoteAsWatchlistItem,
  compactQuantWatchlistItem,
  normalizeQuantWatchlistCode,
  normalizeQuantWatchlistCodes,
  quoteRecordForCode,
} from "@/lib/workshops/quant-watchlist-proposal-service";

describe("quant watchlist proposal service helpers", () => {
  it("normalizes A-share code variants for active watchlist proposals", () => {
    expect(normalizeQuantWatchlistCode(" sz000977 ")).toBe("000977.SZ");
    expect(normalizeQuantWatchlistCode("600519")).toBe("600519.SH");
    expect(normalizeQuantWatchlistCode("300750")).toBe("300750.SZ");
    expect(normalizeQuantWatchlistCode("430047")).toBe("430047.BJ");
    expect(normalizeQuantWatchlistCode("bad")).toBeNull();
  });

  it("deduplicates normalized proposal codes and reports invalid inputs", () => {
    expect(
      normalizeQuantWatchlistCodes(["000977", "SZ000977", "bad", "600519.SH"]),
    ).toEqual({
      codes: ["000977.SZ", "600519.SH"],
      invalid: ["bad"],
    });
  });

  it("compacts dashboard and quote records into watchlist proposal evidence", () => {
    expect(
      compactQuantWatchlistItem({
        code: "000977.SZ",
        name: "浪潮信息",
        price: 50,
        changePct: 1.2,
        turnoverBillion: 3.4,
        peTtm: 20,
        turnoverRate: 2.5,
        tags: ["AI"],
        updatedAt: "2026-09-14T10:00:00Z",
      }),
    ).toEqual({
      code: "000977.SZ",
      name: "浪潮信息",
      price: 50,
      change_pct: 1.2,
      turnover_billion: 3.4,
      pe_ttm: 20,
      turnover_rate: 2.5,
      tags: ["AI"],
      updated_at: "2026-09-14T10:00:00Z",
    });

    expect(
      compactAStockQuoteAsWatchlistItem(
        "000977.SZ",
        { name: "浪潮信息", price: 51, changePct: 2 },
        "2026-09-14T10:01:00Z",
      ),
    ).toMatchObject({
      code: "000977.SZ",
      name: "浪潮信息",
      price: 51,
      change_pct: 2,
      updated_at: "2026-09-14T10:01:00Z",
      source: "a-stock-data",
    });
  });

  it("matches quote records by normalized code or bare symbol", () => {
    expect(
      quoteRecordForCode(
        {
          "000977": { price: 50 },
          "600519.SH": { price: 1800 },
        },
        "000977.SZ",
      ),
    ).toEqual({ price: 50 });
    expect(
      quoteRecordForCode(
        {
          "600519.SH": { price: 1800 },
        },
        "600519.SH",
      ),
    ).toEqual({ price: 1800 });
  });
});
