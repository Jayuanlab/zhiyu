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

const DEFAULT_QUANT_SERVICE_URL = "http://127.0.0.1:8766";

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
    headers: { Accept: "application/json" },
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
      Accept: "application/json",
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

export async function fetchQuantPaperAccount(): Promise<QuantPaperAccount> {
  const response = await fetch(`${getQuantServiceUrl()}/paper/account`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Quant service returned ${response.status}`);
  }

  return (await response.json()) as QuantPaperAccount;
}

export async function fetchQuantPaperOrders(
  limit = 100,
): Promise<{ orders: QuantPaperOrder[] }> {
  const response = await fetch(`${getQuantServiceUrl()}/paper/orders?limit=${limit}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Quant service returned ${response.status}`);
  }

  return (await response.json()) as { orders: QuantPaperOrder[] };
}

export async function fetchQuantPaperFills(
  limit = 100,
): Promise<{ fills: QuantPaperFill[] }> {
  const response = await fetch(`${getQuantServiceUrl()}/paper/fills?limit=${limit}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Quant service returned ${response.status}`);
  }

  return (await response.json()) as { fills: QuantPaperFill[] };
}

export async function placeQuantPaperOrder(input: QuantPaperOrderInput) {
  const response = await fetch(`${getQuantServiceUrl()}/paper/orders`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
    cache: "no-store",
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      detail?: string;
    } | null;
    throw new Error(payload?.detail ?? `Quant service returned ${response.status}`);
  }

  return (await response.json()) as {
    order: QuantPaperOrder;
    account: QuantPaperAccount;
  };
}

export async function cancelQuantPaperOrder(orderId: string) {
  const response = await fetch(
    `${getQuantServiceUrl()}/paper/orders/${encodeURIComponent(orderId)}/cancel`,
    {
      method: "POST",
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

  return (await response.json()) as {
    order: QuantPaperOrder;
    account: QuantPaperAccount;
  };
}
