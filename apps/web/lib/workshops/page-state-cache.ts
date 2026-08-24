import "server-only";

type WorkshopPageStateCacheEntry<T> = {
  value: T;
  fetchedAt: number;
  expiresAt: number;
  staleUntil: number;
  refreshing?: Promise<void>;
};

export type WorkshopPageStateCacheHit<T> = {
  value: T;
  hit: boolean;
  stale: boolean;
  refreshing: boolean;
  fetchedAt: number;
  expiresAt: number;
};

const DEFAULT_TTL_MS = 5_000;
const DEFAULT_STALE_TTL_MS = 2 * 60_000;
const pageStateCache = new Map<string, WorkshopPageStateCacheEntry<unknown>>();

function cacheKey(userId: string) {
  return `workshop-page-state:${userId}`;
}

export function workshopPageStateCacheTtlMs() {
  const configured = Number(process.env.WORKSHOP_PAGE_STATE_CACHE_TTL_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_TTL_MS;
}

export function workshopPageStateCacheStaleTtlMs() {
  const configured = Number(process.env.WORKSHOP_PAGE_STATE_CACHE_STALE_TTL_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_STALE_TTL_MS;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function getCachedWorkshopPageState<T>(
  userId: string,
): WorkshopPageStateCacheHit<T> | null {
  const key = cacheKey(userId);
  const entry = pageStateCache.get(key) as
    | WorkshopPageStateCacheEntry<T>
    | undefined;
  if (!entry) return null;

  const now = Date.now();
  if (now > entry.staleUntil) {
    pageStateCache.delete(key);
    return null;
  }

  return {
    value: entry.value,
    hit: true,
    stale: now > entry.expiresAt,
    refreshing: Boolean(entry.refreshing),
    fetchedAt: entry.fetchedAt,
    expiresAt: entry.expiresAt,
  };
}

export function setCachedWorkshopPageState<T>(input: {
  userId: string;
  value: T;
}) {
  const fetchedAt = Date.now();
  const expiresAt = fetchedAt + workshopPageStateCacheTtlMs();
  putCachedWorkshopPageState({
    userId: input.userId,
    value: input.value,
    fetchedAt,
    expiresAt,
    staleUntil: expiresAt + workshopPageStateCacheStaleTtlMs(),
  });
}

export function putCachedWorkshopPageState<T>(input: {
  userId: string;
  value: T;
  fetchedAt: number;
  expiresAt: number;
  staleUntil: number;
}) {
  pageStateCache.set(cacheKey(input.userId), {
    value: input.value,
    fetchedAt: input.fetchedAt,
    expiresAt: input.expiresAt,
    staleUntil: input.staleUntil,
  });
}

export function refreshCachedWorkshopPageState<T>(input: {
  userId: string;
  run: () => Promise<T>;
}) {
  const key = cacheKey(input.userId);
  const entry = pageStateCache.get(key) as
    | WorkshopPageStateCacheEntry<T>
    | undefined;
  if (!entry || entry.refreshing) return false;

  entry.refreshing = input
    .run()
    .then((value) => {
      setCachedWorkshopPageState({ userId: input.userId, value });
    })
    .catch((error) => {
      console.warn(
        `[workshop-page-state-cache] background refresh failed: ${errorMessage(
          error,
        )}`,
      );
    })
    .finally(() => {
      const latest = pageStateCache.get(key);
      if (latest === entry) {
        delete latest.refreshing;
      }
    });
  return true;
}

export function clearWorkshopPageStateCache() {
  pageStateCache.clear();
}
