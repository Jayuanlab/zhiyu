import type { QuantPaperAccount } from "./types";
import { runAStockDataAction } from "@/lib/workshops/a-stock-data-client";

type QuoteRecord = {
  price: number;
  name?: string | null;
  observedAt?: string | null;
  qualityStatus?: string | null;
};

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function roundPct(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function normalizedCodeVariants(code: string) {
  const compact = code.trim().toUpperCase();
  const symbol = compact.split(".")[0] ?? compact;
  return [compact, symbol];
}

function numberValue(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function quoteForCode(data: unknown, code: string): QuoteRecord | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  for (const key of normalizedCodeVariants(code)) {
    const value = record[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const quote = value as Record<string, unknown>;
    const price = numberValue(quote.price);
    if (price === null || price <= 0) continue;
    return {
      price,
      name: typeof quote.name === "string" ? quote.name : null,
      observedAt:
        typeof quote.updated_at === "string"
          ? quote.updated_at
          : typeof quote.updatedAt === "string"
            ? quote.updatedAt
            : null,
      qualityStatus: "ready",
    };
  }
  return null;
}

export function paperAccountNeedsValuationRefresh(account: QuantPaperAccount) {
  if (account.positions.length === 0) return false;
  const quoteRecord =
    account.valuation &&
    typeof account.valuation === "object" &&
    !Array.isArray(account.valuation) &&
    "quotes" in account.valuation &&
    account.valuation.quotes &&
    typeof account.valuation.quotes === "object" &&
    !Array.isArray(account.valuation.quotes)
      ? (account.valuation.quotes as Record<string, unknown>)
      : {};
  return account.positions.some((position) => {
    if (!(position.quantity > 0)) return false;
    const variants = normalizedCodeVariants(position.code);
    const hasQuote = variants.some((code) => quoteRecord[code]);
    return (
      !hasQuote ||
      position.unrealized_pnl === 0 ||
      position.price === position.cost_price
    );
  });
}

export async function enrichPaperAccountValuation(
  account: QuantPaperAccount,
): Promise<QuantPaperAccount> {
  if (!paperAccountNeedsValuationRefresh(account)) return account;
  const codes = account.positions
    .filter((position) => position.quantity > 0)
    .map((position) => position.code);
  if (codes.length === 0) return account;

  const result = await runAStockDataAction({
    action: "quote",
    args: { codes },
    timeoutMs: 15_000,
  });
  if (!result.ok) {
    return {
      ...account,
      valuation: {
        ...(account.valuation && typeof account.valuation === "object"
          ? account.valuation
          : {}),
        warning:
          result.error ??
          "Paper account valuation quote refresh failed; using persisted prices.",
        fetchedAt: result.fetchedAt ?? new Date().toISOString(),
      },
    };
  }

  let enrichedCount = 0;
  const quotes: Record<string, QuoteRecord> = {};
  const positions = account.positions.map((position) => {
    const quote = quoteForCode(result.data, position.code);
    if (!quote) return position;
    enrichedCount += 1;
    quotes[position.code] = {
      provider: result.sources?.join(", ") ?? "a-stock-data",
      observedAt: quote.observedAt ?? result.fetchedAt ?? null,
      qualityStatus: quote.qualityStatus ?? "ready",
      price: quote.price,
    } as QuoteRecord;
    const marketValue = roundMoney(position.quantity * quote.price);
    const unrealizedPnl = roundMoney(
      (quote.price - position.cost_price) * position.quantity,
    );
    return {
      ...position,
      name: position.name || quote.name || position.code,
      price: quote.price,
      market_value: marketValue,
      unrealized_pnl: unrealizedPnl,
      unrealized_pnl_pct:
        position.cost_price > 0
          ? roundPct(((quote.price - position.cost_price) / position.cost_price) * 100)
          : 0,
    };
  });
  if (enrichedCount === 0) return account;

  const marketValue = roundMoney(
    positions.reduce((sum, position) => sum + position.market_value, 0),
  );
  const unrealizedPnl = roundMoney(
    positions.reduce((sum, position) => sum + position.unrealized_pnl, 0),
  );
  const totalAsset = roundMoney(account.cash + account.frozen_cash + marketValue);
  const totalPnl = roundMoney(account.realized_pnl + unrealizedPnl);
  const totalPnlPct =
    account.initial_cash > 0 ? roundPct((totalPnl / account.initial_cash) * 100) : 0;

  return {
    ...account,
    positions,
    market_value: marketValue,
    total_asset: totalAsset,
    total_pnl: totalPnl,
    total_pnl_pct: totalPnlPct,
    valuation: {
      ...(account.valuation && typeof account.valuation === "object"
        ? account.valuation
        : {}),
      quotes: {
        ...((account.valuation as { quotes?: Record<string, unknown> } | undefined)
          ?.quotes ?? {}),
        ...quotes,
      },
      warning: null,
      fetchedAt: result.fetchedAt ?? new Date().toISOString(),
      source: "web_position_quote_overlay",
    },
  };
}
