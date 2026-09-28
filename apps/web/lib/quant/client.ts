import type {
  QuantDashboard,
  QuantFullMarketRefreshStatus,
  QuantMarketCandidatesResponse,
  QuantNewsItem,
  QuantNewsSnapshot,
  QuantPaperAccount,
  QuantPaperFill,
  QuantPaperOrder,
  QuantPaperOrderInput,
  QuantWatchlistConfig,
  QuantWatchlistConfigItem,
} from "./types";
import {readPaperAccount,readPaperLedger} from './paper-client';
import { enrichPaperAccountValuation } from "./paper-valuation";
import { runAStockDataAction } from "@/lib/workshops/a-stock-data-client";
import { quantRequest } from "./embedded-transport";

const DEFAULT_QUANT_SERVICE_URL = "http://127.0.0.1:8766";

function internalHeaders() {
  const token = process.env.QUANT_INTERNAL_TOKEN;
  if (!token) throw new Error("Quant internal credential is not configured");
  return { Accept: "application/json", Authorization: `Bearer ${token}` };
}

export function getQuantServiceUrl(): string {
  return (
    process.env.QUANT_SERVICE_URL?.replace(/\/$/, "") ??
    DEFAULT_QUANT_SERVICE_URL
  );
}

export type QuantStorageDiagnostics = {
  service: string;
  provider: string;
  paper_trading_enabled: boolean;
  files: Record<
    string,
    {
      path: string;
      exists: boolean;
      is_file?: boolean;
      size_bytes?: number | null;
      modified_at?: string;
    }
  >;
  counts: {
    watchlist_codes: number;
    orders: number;
    fills: number;
    positions: number;
  };
};

export async function fetchQuantStorageDiagnostics(): Promise<QuantStorageDiagnostics> {
  const response = await quantRequest(`${getQuantServiceUrl()}/storage/diagnostics`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Quant module returned ${response.status}`);
  }

  return (await response.json()) as QuantStorageDiagnostics;
}

export async function fetchQuantDashboard(): Promise<QuantDashboard> {
  const response = await quantRequest(`${getQuantServiceUrl()}/dashboard`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Quant module returned ${response.status}`);
  }

  return (await response.json()) as QuantDashboard;
}

export async function fetchQuantFullMarketStatus(): Promise<QuantFullMarketRefreshStatus> {
  const response = await quantRequest(`${getQuantServiceUrl()}/market/overview/status`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Quant module returned ${response.status}`);
  }

  return (await response.json()) as QuantFullMarketRefreshStatus;
}

export async function refreshQuantFullMarket(): Promise<QuantFullMarketRefreshStatus> {
  const response = await quantRequest(`${getQuantServiceUrl()}/market/overview/refresh`, {
    method: "POST",
    headers: internalHeaders(),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Quant module returned ${response.status}`);
  }

  return (await response.json()) as QuantFullMarketRefreshStatus;
}

export async function fetchQuantMarketCandidates(input?: {
  theme?: string;
  limit?: number;
  minTurnoverBillion?: number;
  excludeWatchlist?: boolean;
  excludeSt?: boolean;
}): Promise<QuantMarketCandidatesResponse> {
  const params = new URLSearchParams();
  if (input?.theme) params.set("theme", input.theme);
  if (input?.limit) params.set("limit", String(input.limit));
  if (input?.minTurnoverBillion !== undefined) {
    params.set("min_turnover_billion", String(input.minTurnoverBillion));
  }
  if (input?.excludeWatchlist !== undefined) {
    params.set("exclude_watchlist", String(input.excludeWatchlist));
  }
  if (input?.excludeSt !== undefined) {
    params.set("exclude_st", String(input.excludeSt));
  }

  const query = params.toString();
  const response = await quantRequest(
    `${getQuantServiceUrl()}/market/candidates${query ? `?${query}` : ""}`,
    {
      headers: { Accept: "application/json" },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      detail?: string;
    } | null;
    throw new Error(payload?.detail ?? `Quant module returned ${response.status}`);
  }

  return (await response.json()) as QuantMarketCandidatesResponse;
}

function textValue(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function newsId(kind: QuantNewsItem["kind"], item: Record<string, unknown>, index: number) {
  return [
    kind,
    textValue(item.url),
    textValue(item.title),
    textValue(item.time) ?? textValue(item.date) ?? textValue(item.askTime),
    index,
  ].filter(Boolean).join(":");
}

function compactNewsText(value: unknown, maxLength = 140): string | undefined {
  const text = textValue(value)?.replace(/\s+/g, " ");
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

export async function fetchQuantNews(input?: {
  code?: string;
  pageSize?: number;
}): Promise<QuantNewsSnapshot> {
  const pageSize = Math.max(1, Math.min(20, input?.pageSize ?? 8));
  const result = await runAStockDataAction({
    action: "news_filings",
    args: {
      pageSize,
      ...(input?.code ? { code: input.code } : {}),
    },
    timeoutMs: 15_000,
  });

  if (!result.ok) {
    throw new Error(result.error ?? "A股资讯暂不可用");
  }

  const data = result.data && typeof result.data === "object"
    ? result.data as Record<string, unknown>
    : {};
  const global = rows(data.globalNews).map((item, index): QuantNewsItem => ({
    id: newsId("market", item, index),
    kind: "market",
    title: textValue(item.title) ?? "未命名资讯",
    summary: compactNewsText(item.summary),
    time: textValue(item.time),
  }));
  const stockNews = rows(data.stockNews).map((item, index): QuantNewsItem => ({
    id: newsId("stock", item, index),
    kind: "stock",
    code: input?.code,
    title: textValue(item.title) ?? "未命名个股资讯",
    summary: compactNewsText(item.content),
    time: textValue(item.time),
    source: textValue(item.source),
    url: textValue(item.url),
  }));
  const announcements = rows(data.announcements).map((item, index): QuantNewsItem => ({
    id: newsId("announcement", item, index),
    kind: "announcement",
    code: input?.code,
    title: textValue(item.title) ?? "未命名公告",
    summary: textValue(item.type),
    time: textValue(item.date),
    url: textValue(item.url),
  }));
  const investorRelations = rows(data.investorRelations).map((item, index): QuantNewsItem => ({
    id: newsId("irm", item, index),
    kind: "irm",
    code: textValue(item.code) ?? input?.code,
    name: textValue(item.company),
    title: compactNewsText(item.question, 80) ?? "投资者问答",
    summary: compactNewsText(item.answer) ?? "等待公司回复",
    time: textValue(item.askTime),
    source: textValue(item.answerer),
  }));

  return {
    fetched_at: result.fetchedAt ?? new Date().toISOString(),
    focus_code: input?.code,
    sources: result.sources ?? [],
    warnings: result.warnings ?? [],
    global,
    focused: [...stockNews, ...announcements, ...investorRelations].slice(0, pageSize),
  };
}

export async function fetchQuantWatchlistConfig(): Promise<QuantWatchlistConfig> {
  const response = await quantRequest(`${getQuantServiceUrl()}/watchlist/config`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Quant module returned ${response.status}`);
  }

  return (await response.json()) as QuantWatchlistConfig;
}

export async function updateQuantWatchlistConfig(
  codes: string[],
  items?: QuantWatchlistConfigItem[],
): Promise<QuantWatchlistConfig> {
  const response = await quantRequest(`${getQuantServiceUrl()}/watchlist/config`, {
    method: "PUT",
    headers: {
      ...internalHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ codes, items }),
    cache: "no-store",
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      detail?: string;
    } | null;
    throw new Error(payload?.detail ?? `Quant module returned ${response.status}`);
  }

  return (await response.json()) as QuantWatchlistConfig;
}

export async function fetchQuantPaperAccount(ownerId:string): Promise<QuantPaperAccount> {
  if(process.env.QUANT_PAPER_ACCOUNT_ID)return enrichPaperAccountValuation(await readPaperAccount(ownerId));
  const response = await quantRequest(`${getQuantServiceUrl()}/paper/account/view`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Quant module returned ${response.status}`);
  }

  return enrichPaperAccountValuation({...await response.json(),storage:'legacy_json',migrationRequired:true,trading_enabled:false} as QuantPaperAccount);
}

export async function fetchQuantPaperOrders(
  limit = 100,
  ownerId:string,
): Promise<{ orders: QuantPaperOrder[] }> {
  if(process.env.QUANT_PAPER_ACCOUNT_ID){const {state}=await readPaperLedger(ownerId);return {orders:state.orders.sort((a:any,b:any)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0,Math.max(1,Math.min(500,limit)))};}
  const response = await quantRequest(`${getQuantServiceUrl()}/paper/orders?limit=${limit}`, {
    headers: internalHeaders(),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Quant module returned ${response.status}`);
  }

  return (await response.json()) as { orders: QuantPaperOrder[] };
}

export async function fetchQuantPaperFills(
  limit = 100,
  ownerId:string,
): Promise<{ fills: QuantPaperFill[] }> {
  if(process.env.QUANT_PAPER_ACCOUNT_ID){const {state}=await readPaperLedger(ownerId);return {fills:state.fills.sort((a:any,b:any)=>String(b.filled_at).localeCompare(String(a.filled_at))).slice(0,Math.max(1,Math.min(500,limit)))};}
  const response = await quantRequest(`${getQuantServiceUrl()}/paper/fills?limit=${limit}`, {
    headers: internalHeaders(),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Quant module returned ${response.status}`);
  }

  return (await response.json()) as { fills: QuantPaperFill[] };
}

export {submitPaperOrder as placeQuantPaperOrder,cancelPaperOrder as cancelQuantPaperOrder} from './paper-client';
