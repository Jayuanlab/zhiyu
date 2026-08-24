import "server-only";

type QuantCacheEntry<T> = {
  value: T;
  fetchedAt: number;
  expiresAt: number;
  staleUntil: number;
  refreshing?: Promise<void>;
};

export type QuantCacheMeta = {
  hit: boolean;
  stale: boolean;
  refreshing?: boolean;
  fetched_at: string;
  expires_at: string;
  warning?: string;
};

const DEFAULT_TTL_MS = 10_000;
const DEFAULT_STALE_TTL_MS = 30 * 60_000;
const quantCache = new Map<string, QuantCacheEntry<unknown>>();

function ttlMs() {
  const configured = Number(process.env.QUANT_READ_CACHE_TTL_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_TTL_MS;
}

function staleTtlMs() {
  const configured = Number(process.env.QUANT_READ_CACHE_STALE_TTL_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_STALE_TTL_MS;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function withCacheMeta<T>(value: T, meta: QuantCacheMeta): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const existingCache =
    record.cache && typeof record.cache === "object" && !Array.isArray(record.cache)
      ? (record.cache as Record<string, unknown>)
      : {};

  return {
    ...record,
    cache: {
      ...existingCache,
      ...meta,
    },
  } as T;
}

export async function cachedQuantRead<T>(input: {
  key: string;
  fetcher: () => Promise<T>;
  ttlMs?: number;
  staleTtlMs?: number;
}): Promise<T> {
  const now = Date.now();
  const entry = quantCache.get(input.key) as QuantCacheEntry<T> | undefined;

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
    refreshQuantReadInBackground(input);
    return withCacheMeta(entry.value, {
      hit: true,
      stale: true,
      refreshing: true,
      fetched_at: new Date(entry.fetchedAt).toISOString(),
      expires_at: new Date(entry.expiresAt).toISOString(),
      warning: "Quant local snapshot is stale; refreshing in background.",
    });
  }

  try {
    const { value, fetchedAt, expiresAt } = await refreshQuantRead(input);
    return withCacheMeta(value, {
      hit: false,
      stale: false,
      fetched_at: new Date(fetchedAt).toISOString(),
      expires_at: new Date(expiresAt).toISOString(),
    });
  } catch (error) {
    if (!entry) throw error;
    return withCacheMeta(entry.value, {
      hit: true,
      stale: true,
      refreshing: false,
      fetched_at: new Date(entry.fetchedAt).toISOString(),
      expires_at: new Date(entry.expiresAt).toISOString(),
      warning: `Quant service read failed; returning stale local snapshot. ${errorMessage(
        error,
      )}`,
    });
  }
}

async function refreshQuantRead<T>(input: {
  key: string;
  fetcher: () => Promise<T>;
  ttlMs?: number;
  staleTtlMs?: number;
}): Promise<QuantCacheEntry<T>> {
  const value = await input.fetcher();
  const fetchedAt = Date.now();
  const expiresAt = fetchedAt + (input.ttlMs ?? ttlMs());
  const staleUntil = expiresAt + (input.staleTtlMs ?? staleTtlMs());
  const entry: QuantCacheEntry<T> = { value, fetchedAt, expiresAt, staleUntil };
  quantCache.set(input.key, entry);
  return entry;
}

function refreshQuantReadInBackground<T>(input: {
  key: string;
  fetcher: () => Promise<T>;
  ttlMs?: number;
  staleTtlMs?: number;
}) {
  const entry = quantCache.get(input.key) as QuantCacheEntry<T> | undefined;
  if (!entry || entry.refreshing) return;

  entry.refreshing = refreshQuantRead(input)
    .then(() => undefined)
    .catch((error) => {
      console.warn(
        `[quant-cache] background refresh failed for ${input.key}: ${errorMessage(
          error,
        )}`,
      );
    })
    .finally(() => {
      const latest = quantCache.get(input.key) as QuantCacheEntry<T> | undefined;
      if (latest === entry) {
        delete latest.refreshing;
      }
    });
}

export function invalidateQuantReadCache(keys?: string[]) {
  if (!keys) {
    quantCache.clear();
    return;
  }

  for (const key of keys) {
    quantCache.delete(key);
  }
}
