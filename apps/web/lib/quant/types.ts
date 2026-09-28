export interface QuantIndexSnapshot {
  code: string;
  name: string;
  price: number;
  change_pct: number;
  turnover_billion: number;
}

export interface QuantSectorSnapshot {
  name: string;
  change_pct: number;
  signal: string;
}

export interface QuantMarketOverview {
  trade_date: string;
  market_scope?: "full_market" | "watchlist" | "watchlist_fallback";
  market_source?: string;
  market_warning?: string;
  stock_count?: number;
  sector_scope?: "full_market" | "unavailable";
  temperature: number;
  up_count: number;
  down_count: number;
  flat_count: number;
  turnover_billion: number;
  indices: QuantIndexSnapshot[];
  sectors: QuantSectorSnapshot[];
}

export interface QuantWatchlistItem {
  code: string;
  name: string;
  price: number;
  change_pct: number;
  turnover_billion: number;
  pe_ttm: number;
  pb?: number;
  turnover_rate?: number;
  roe: number;
  tags: string[];
  updated_at?: string | null;
  warning?: string;
  pool?: QuantWatchlistPool;
  pool_label?: string;
  watch_status?: QuantWatchlistStatus;
  watch_source?: string;
  watch_reason?: string;
  watch_confidence?: number | null;
  watch_score?: number | null;
  watch_data_quality?: string;
  first_seen_at?: string | null;
  last_reviewed_at?: string | null;
  expires_at?: string | null;
}

export type QuantSignalAction = "observe" | "watch" | "buy_candidate" | "sell_candidate";

export interface QuantSignal {
  id: string;
  strategy: string;
  code: string;
  name: string;
  action: QuantSignalAction;
  strength: number;
  reason: string;
  risk: string;
}

export interface QuantPosition {
  code: string;
  name: string;
  quantity: number;
  cost: number;
  price: number;
  market_value: number;
  pnl_pct: number;
  weight_pct: number;
}

export interface QuantPortfolio {
  mode: "paper" | "live";
  total_value: number;
  cash: number;
  daily_pnl: number;
  daily_pnl_pct: number;
  total_pnl: number;
  total_pnl_pct: number;
  max_drawdown_pct: number;
  positions: QuantPosition[];
  risk: {
    cash_weight_pct: number;
    largest_position_pct: number;
    sector_concentration: string;
    alerts: string[];
  };
}

export interface QuantDailyReport {
  title: string;
  summary: string;
  next_actions: string[];
}

export interface QuantWatchlistConfig {
  codes: string[];
  items?: QuantWatchlistConfigItem[];
  pool_counts?: Record<string, number>;
  source: "file" | "env" | "default" | string;
  path?: string;
  universe_path?: string;
  active_pools?: string[];
  visible_pools?: string[];
  max_active_symbols?: number;
  max_universe_symbols?: number;
  trading_enabled: boolean;
}

export type QuantWatchlistPool =
  | "candidate"
  | "core"
  | "trading"
  | "holding"
  | "archived";

export type QuantWatchlistStatus =
  | "active"
  | "cooling"
  | "protected"
  | "pending_remove"
  | "archived";

export interface QuantWatchlistConfigItem {
  code: string;
  name?: string | null;
  pool: QuantWatchlistPool;
  pool_label?: string;
  status: QuantWatchlistStatus;
  source?: string;
  reason?: string;
  evidence?: Array<Record<string, unknown>>;
  score?: number | null;
  confidence?: number | null;
  data_quality?: string;
  first_seen_at?: string | null;
  last_reviewed_at?: string | null;
  expires_at?: string | null;
  updated_at?: string | null;
}

export interface QuantMarketCandidateEvidence {
  source: string;
  summary: string;
}

export interface QuantMarketCandidate {
  code: string;
  name: string;
  price: number;
  change_pct: number;
  turnover_billion: number;
  turnover_rate?: number;
  pe_ttm?: number;
  pb?: number;
  themes: string[];
  tags: string[];
  score: number;
  scores: {
    theme_fit: number;
    liquidity: number;
    momentum: number;
    quality: number;
    risk: number;
  };
  evidence: QuantMarketCandidateEvidence[];
  risks: string[];
  updated_at?: string | null;
}

export interface QuantMarketCandidatesResponse {
  generated_at: string;
  provider: string;
  data_source_detail?: string;
  theme: string;
  keywords: string[];
  filters: {
    limit: number;
    min_turnover_billion: number;
    exclude_watchlist: boolean;
    exclude_st: boolean;
  };
  concept_sources: Array<Record<string, unknown>>;
  items: QuantMarketCandidate[];
}

export interface QuantNewsItem {
  id: string;
  title: string;
  summary?: string;
  time?: string;
  source?: string;
  url?: string;
  kind: "market" | "stock" | "announcement" | "irm";
  code?: string;
  name?: string;
}

export interface QuantNewsSnapshot {
  fetched_at: string;
  focus_code?: string;
  sources: string[];
  warnings: string[];
  global: QuantNewsItem[];
  focused: QuantNewsItem[];
}

export type QuantPaperOrderSide = "buy" | "sell";

export type QuantPaperOrderStatus =
  | "submitted"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "rejected";

export interface QuantPaperPosition {
  code: string;
  name: string;
  quantity: number;
  available_quantity: number;
  cost_price: number;
  price: number;
  market_value: number;
  unrealized_pnl: number;
  unrealized_pnl_pct: number;
}

export interface QuantPaperOrder {
  id: string;
  code: string;
  name: string;
  side: QuantPaperOrderSide;
  order_type: "limit";
  quantity: number;
  remaining_quantity: number;
  limit_price: number;
  planned_price?: number | null;
  max_buy_deviation_pct?: number | null;
  status: QuantPaperOrderStatus;
  created_at: string;
  updated_at: string;
  submitted_by: string;
  note?: string;
  strategy?: string;
  reject_reason?: string | null;
  status_note?: string;
  rule_snapshot?: Record<string, unknown>;
}

export interface QuantPaperFill {
  id: string;
  order_id: string;
  code: string;
  name: string;
  side: QuantPaperOrderSide;
  quantity: number;
  price: number;
  amount: number;
  filled_at: string;
  note?: string;
  strategy?: string;
  realized_pnl?: number;
}

export interface QuantPaperAccount {
  storage?: 'legacy_json'|'postgres';
  version?: number;
  migrationRequired?: boolean;
  historicalPerformanceComplete?: boolean;
  matching?: {lastAttemptAt?:string;lastMatchedAt?:string;lastTickId?:string;waiting?:Record<string,string>}|null;
  stateChangedAt?: string;
  id: string;
  mode: "paper";
  trading_enabled: boolean;
  initial_cash: number;
  cash: number;
  frozen_cash: number;
  market_value: number;
  total_asset: number;
  realized_pnl: number;
  total_pnl: number;
  total_pnl_pct: number;
  positions: QuantPaperPosition[];
  open_orders: QuantPaperOrder[];
  recent_orders: QuantPaperOrder[];
  recent_fills: QuantPaperFill[];
  rules: Record<string, unknown>;
  updated_at: string;
  cache?: QuantCacheMeta;
  valuation?: Record<string, unknown> | null;
}

export interface QuantPaperOrderInput {
  tradeThesis?: Record<string,unknown>;
  commandId: string;
  accountId?: string;
  expectedVersion?: number;
  code: string;
  side: QuantPaperOrderSide;
  quantity: number;
  limit_price: number;
  planned_price?: number;
  max_buy_deviation_pct?: number;
  note?: string;
  strategy?: string;
  actor?: string;
}

export interface QuantDashboard {
  quality?: QuantQualityEnvelope;
  generated_at: string;
  service_mode: "sample" | "live";
  data_provider?: string;
  data_scope?: string;
  data_source_detail?: string;
  provider_error?: string;
  watchlist_source?: string;
  cache?: QuantCacheMeta;
  market: QuantMarketOverview;
  watchlist: QuantWatchlistItem[];
  signals: QuantSignal[];
  portfolio: QuantPortfolio;
  daily_report: QuantDailyReport;
}

export interface QuantCacheMeta {
  hit: boolean;
  stale: boolean;
  refreshing?: boolean;
  fetched_at: string;
  expires_at: string;
  warning?: string;
  lastRefreshError?: string;
}

export interface QuantQualityEnvelope {
  schemaVersion: "quant-quality.v1";
  provider: string;
  detail: string | null;
  scope: "full_market" | "watchlist" | "sample" | "unknown";
  observedAt: string | null;
  fetchedAt: string | null;
  generatedAt: string | null;
  expiresAt: string | null;
  refreshing: boolean;
  lastRefreshError: string | null;
  warnings: string[];
  qualityStatus: "ready" | "degraded" | "stale" | "unavailable";
  exchange: string | null;
  quoteSessionDate: string | null;
  calendarVersion: string | null;
}

export interface QuantFullMarketRefreshStatus {
  job: "quant_full_market_overview";
  scope: "full_market";
  source: string;
  in_progress: boolean;
  cached: boolean;
  stale: boolean;
  expires_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
}

export interface QuantPageState {
  account: QuantPaperAccount | null;
  dashboard: QuantDashboard | null;
  meta: {
    generated_at: string;
    account: {
      ok: boolean;
      error?: string;
      stale?: boolean;
      refreshing?: boolean;
    };
    dashboard: {
      ok: boolean;
      pending?: boolean;
      error?: string;
      stale?: boolean;
      refreshing?: boolean;
    };
    warnings: string[];
    cache?: {
      hit: boolean;
      stale: boolean;
      refreshing: boolean;
      fetchedAt: string;
      expiresAt: string;
    };
  };
}
