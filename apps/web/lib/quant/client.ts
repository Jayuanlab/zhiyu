import type {
  QuantDashboard,
  QuantFullMarketRefreshStatus,
  QuantMarketCandidatesResponse,
  QuantPaperAccount,
  QuantPaperFill,
  QuantPaperOrder,
  QuantPaperOrderInput,
  QuantWatchlistConfig,
  QuantWatchlistConfigItem,
} from "./types";
import {readPaperAccount,readPaperLedger} from './paper-client';

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
  const response = await fetch(`${getQuantServiceUrl()}/storage/diagnostics`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Quant service returned ${response.status}`);
  }

  return (await response.json()) as QuantStorageDiagnostics;
}

export async function fetchQuantDashboard(): Promise<QuantDashboard> {
  const response = await fetch(`${getQuantServiceUrl()}/dashboard`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Quant service returned ${response.status}`);
  }

  return (await response.json()) as QuantDashboard;
}

export async function fetchQuantFullMarketStatus(): Promise<QuantFullMarketRefreshStatus> {
  const response = await fetch(`${getQuantServiceUrl()}/market/overview/status`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Quant service returned ${response.status}`);
  }

  return (await response.json()) as QuantFullMarketRefreshStatus;
}

export async function refreshQuantFullMarket(): Promise<QuantFullMarketRefreshStatus> {
  const response = await fetch(`${getQuantServiceUrl()}/market/overview/refresh`, {
    method: "POST",
    headers: internalHeaders(),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Quant service returned ${response.status}`);
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
  const response = await fetch(
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
    throw new Error(payload?.detail ?? `Quant service returned ${response.status}`);
  }

  return (await response.json()) as QuantMarketCandidatesResponse;
}

export async function fetchQuantWatchlistConfig(): Promise<QuantWatchlistConfig> {
  const response = await fetch(`${getQuantServiceUrl()}/watchlist/config`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Quant service returned ${response.status}`);
  }

  return (await response.json()) as QuantWatchlistConfig;
}

export async function updateQuantWatchlistConfig(
  codes: string[],
  items?: QuantWatchlistConfigItem[],
): Promise<QuantWatchlistConfig> {
  const response = await fetch(`${getQuantServiceUrl()}/watchlist/config`, {
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
    throw new Error(payload?.detail ?? `Quant service returned ${response.status}`);
  }

  return (await response.json()) as QuantWatchlistConfig;
}

export async function fetchQuantPaperAccount(ownerId:string): Promise<QuantPaperAccount> {
  if(process.env.QUANT_PAPER_ACCOUNT_ID)return readPaperAccount(ownerId);
  const response = await fetch(`${getQuantServiceUrl()}/paper/account/view`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Quant service returned ${response.status}`);
  }

  return {...await response.json(),storage:'legacy_json',migrationRequired:true,trading_enabled:false} as QuantPaperAccount;
}

export async function fetchQuantPaperOrders(
  limit = 100,
  ownerId:string,
): Promise<{ orders: QuantPaperOrder[] }> {
  if(process.env.QUANT_PAPER_ACCOUNT_ID){const {state}=await readPaperLedger(ownerId);return {orders:state.orders.sort((a:any,b:any)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0,Math.max(1,Math.min(500,limit)))};}
  const response = await fetch(`${getQuantServiceUrl()}/paper/orders?limit=${limit}`, {
    headers: internalHeaders(),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Quant service returned ${response.status}`);
  }

  return (await response.json()) as { orders: QuantPaperOrder[] };
}

export async function fetchQuantPaperFills(
  limit = 100,
  ownerId:string,
): Promise<{ fills: QuantPaperFill[] }> {
  if(process.env.QUANT_PAPER_ACCOUNT_ID){const {state}=await readPaperLedger(ownerId);return {fills:state.fills.sort((a:any,b:any)=>String(b.filled_at).localeCompare(String(a.filled_at))).slice(0,Math.max(1,Math.min(500,limit)))};}
  const response = await fetch(`${getQuantServiceUrl()}/paper/fills?limit=${limit}`, {
    headers: internalHeaders(),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Quant service returned ${response.status}`);
  }

  return (await response.json()) as { fills: QuantPaperFill[] };
}

export {submitPaperOrder as placeQuantPaperOrder,cancelPaperOrder as cancelQuantPaperOrder} from './paper-client';
