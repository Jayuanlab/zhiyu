import "server-only";

import { createHash } from "node:crypto";
import type {
  UnifiedMemorySearchInput,
  UnifiedMemorySearchOutput,
} from "@/lib/memory/unified-search";

type UnifiedMemorySearchCacheEntry = {
  value: UnifiedMemorySearchOutput;
  fetchedAt: number;
  expiresAt: number;
  staleUntil: number;
  refreshing?: Promise<void>;
};

export type UnifiedMemorySearchCacheMeta = {
  hit: boolean;
  stale: boolean;
  refreshing: boolean;
  fetched_at: string;
  expires_at: string;
  warning?: string;
};

export type CachedUnifiedMemorySearchOutput = UnifiedMemorySearchOutput & {
  cache: UnifiedMemorySearchCacheMeta;
};

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_STALE_TTL_MS = 5 * 60_000;
const searchCache = new Map<string, UnifiedMemorySearchCacheEntry>();
let cacheEpoch = 0;

export type UnifiedMemorySearchCacheConsistency = {
  /** Read from the authoritative store, not a process-local invalidation flag. */
  readVersion?: () => Promise<string>;
};

function ttlMs() {
  const configured = Number(process.env.MEMORY_SEARCH_CACHE_TTL_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_TTL_MS;
}

function staleTtlMs() {
  const configured = Number(process.env.MEMORY_SEARCH_CACHE_STALE_TTL_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_STALE_TTL_MS;
}

function hashAuthToken(authToken?: string): string | null {
  if (!authToken) return null;
  return createHash("sha256").update(authToken).digest("hex").slice(0, 16);
}

function sortedValues(values?: string[]): string[] {
  return [...(values ?? [])].sort();
}

function withCacheMeta(
  value: UnifiedMemorySearchOutput,
  meta: UnifiedMemorySearchCacheMeta,
): CachedUnifiedMemorySearchOutput {
  return {
    ...value,
    cache: meta,
  };
}

export function buildUnifiedMemorySearchCacheKey(
  input: UnifiedMemorySearchInput,
): string {
  return JSON.stringify({
    userId: input.userId,
    query: input.query.trim(),
    sources: sortedValues(input.sources),
    limit: input.limit,
    threshold: input.threshold,
    includeArchivedInsights: input.includeArchivedInsights === true,
    botIds: sortedValues(input.botIds),
    documentIds: sortedValues(input.documentIds),
    authTokenHash: hashAuthToken(input.authToken),
  });
}

export async function cachedUnifiedMemorySearch(
  input: UnifiedMemorySearchInput,
  fetcher: () => Promise<UnifiedMemorySearchOutput>,
  consistency: UnifiedMemorySearchCacheConsistency = {},
): Promise<CachedUnifiedMemorySearchOutput> {
  return searchWithVersion(input, fetcher, consistency, 0);
}

async function searchWithVersion(
  input: UnifiedMemorySearchInput,
  fetcher: () => Promise<UnifiedMemorySearchOutput>,
  consistency: UnifiedMemorySearchCacheConsistency,
  attempt: number,
): Promise<CachedUnifiedMemorySearchOutput> {
  const epoch = cacheEpoch;
  const version = await consistency.readVersion?.();
  const key = JSON.stringify([buildUnifiedMemorySearchCacheKey(input), version, epoch]);
  const stillCurrent = async () => epoch === cacheEpoch &&
    (!consistency.readVersion || version === await consistency.readVersion());
  const now = Date.now();
  const entry = searchCache.get(key);

  if (entry && now <= entry.expiresAt) {
    return withCacheMeta(entry.value, {
      hit: true,
      stale: false,
      refreshing: Boolean(entry.refreshing),
      fetched_at: new Date(entry.fetchedAt).toISOString(),
      expires_at: new Date(entry.expiresAt).toISOString(),
    });
  }

  if (entry && now <= entry.staleUntil) {
    refreshInBackground(key, fetcher, stillCurrent);
    return withCacheMeta(entry.value, {
      hit: true,
      stale: true,
      refreshing: true,
      fetched_at: new Date(entry.fetchedAt).toISOString(),
      expires_at: new Date(entry.expiresAt).toISOString(),
      warning: "Unified memory search result is stale; refreshing in background.",
    });
  }

  try {
    const refreshed = await refreshNow(key, fetcher, stillCurrent);
    return withCacheMeta(refreshed.value, {
      hit: false,
      stale: false,
      refreshing: false,
      fetched_at: new Date(refreshed.fetchedAt).toISOString(),
      expires_at: new Date(refreshed.expiresAt).toISOString(),
    });
  } catch (error) {
    if (!(await stillCurrent())) {
      if (attempt < 2) return searchWithVersion(input, fetcher, consistency, attempt + 1);
      throw new Error("Memory changed during search; retry with the current version.");
    }
    if (!entry) throw error;
    return withCacheMeta(entry.value, {
      hit: true,
      stale: true,
      refreshing: false,
      fetched_at: new Date(entry.fetchedAt).toISOString(),
      expires_at: new Date(entry.expiresAt).toISOString(),
      warning: "Unified memory search failed; returning stale discovery results (memory_search_unavailable).",
    });
  }
}

async function refreshNow(
  key: string,
  fetcher: () => Promise<UnifiedMemorySearchOutput>,
  stillCurrent: () => Promise<boolean>,
): Promise<UnifiedMemorySearchCacheEntry> {
  const value = await fetcher();
  if (!(await stillCurrent())) throw new Error("Memory search version changed.");
  const fetchedAt = Date.now();
  const expiresAt = fetchedAt + ttlMs();
  const staleUntil = expiresAt + staleTtlMs();
  const entry: UnifiedMemorySearchCacheEntry = {
    value,
    fetchedAt,
    expiresAt,
    staleUntil,
  };
  searchCache.set(key, entry);
  // Revision stamps create new keys; keep old versions from accumulating.
  if (searchCache.size > 256) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) searchCache.delete(oldest);
  }
  return entry;
}

function refreshInBackground(
  key: string,
  fetcher: () => Promise<UnifiedMemorySearchOutput>,
  stillCurrent: () => Promise<boolean>,
) {
  const entry = searchCache.get(key);
  if (!entry || entry.refreshing) return;

  entry.refreshing = refreshNow(key, fetcher, stillCurrent)
    .then(() => undefined)
    .catch(() => {
      console.warn("[memory-search-cache] background refresh failed", { code: "memory_search_unavailable" });
    })
    .finally(() => {
      const latest = searchCache.get(key);
      if (latest === entry) {
        delete latest.refreshing;
      }
    });
}

export function clearUnifiedMemorySearchCache() {
  cacheEpoch += 1;
  searchCache.clear();
}
