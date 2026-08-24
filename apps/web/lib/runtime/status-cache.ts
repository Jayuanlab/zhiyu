import 'server-only';

export interface CachedRuntimeConnectorCounts {
  totalAccounts: number;
  activeAccounts: number;
  accountsByPlatform: Record<string, number>;
  activeByPlatform: Record<string, number>;
}

interface RuntimeConnectorCountsCacheEntry {
  expiresAt: number;
  value: CachedRuntimeConnectorCounts;
}

const DEFAULT_RUNTIME_CONNECTOR_CACHE_TTL_MS = 2_000;
const connectorCountsCache = new Map<string, RuntimeConnectorCountsCacheEntry>();

function getTtlMs(): number {
  const configured = Number(process.env.RUNTIME_CONNECTOR_CACHE_TTL_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_RUNTIME_CONNECTOR_CACHE_TTL_MS;
}

export function getCachedRuntimeConnectorCounts(
  userId: string,
): CachedRuntimeConnectorCounts | null {
  const entry = connectorCountsCache.get(userId);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    connectorCountsCache.delete(userId);
    return null;
  }

  return entry.value;
}

export function setCachedRuntimeConnectorCounts(
  userId: string,
  value: CachedRuntimeConnectorCounts,
): void {
  const ttlMs = getTtlMs();
  if (ttlMs === 0) return;

  connectorCountsCache.set(userId, {
    expiresAt: Date.now() + ttlMs,
    value,
  });
}

export function invalidateRuntimeConnectorCountsCache(userId?: string): void {
  if (userId) {
    connectorCountsCache.delete(userId);
    return;
  }

  connectorCountsCache.clear();
}
