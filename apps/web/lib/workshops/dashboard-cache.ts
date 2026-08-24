import "server-only";

import type { WorkshopDashboard } from "./dashboard";

const DEFAULT_DASHBOARD_CACHE_TTL_MS = 10_000;
const DEFAULT_DASHBOARD_CACHE_STALE_TTL_MS = 2 * 60_000;

type DashboardCacheEntry = {
  dashboard: WorkshopDashboard;
  fetchedAt: number;
  expiresAt: number;
  staleUntil: number;
  refreshing?: Promise<WorkshopDashboard | null>;
};

const dashboardCache = new Map<string, DashboardCacheEntry>();

function cacheKey(userId: string, workshopId: string) {
  return `${userId}:${workshopId}`;
}

function dashboardCacheTtlMs() {
  const configured = Number(process.env.WORKSHOP_DASHBOARD_CACHE_TTL_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_DASHBOARD_CACHE_TTL_MS;
}

function dashboardCacheStaleTtlMs() {
  const configured = Number(process.env.WORKSHOP_DASHBOARD_CACHE_STALE_TTL_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_DASHBOARD_CACHE_STALE_TTL_MS;
}

export type WorkshopDashboardCacheHit = {
  dashboard: WorkshopDashboard;
  hit: boolean;
  stale: boolean;
  refreshing: boolean;
  fetchedAt: number;
  expiresAt: number;
};

export function getCachedWorkshopDashboard(input: {
  userId: string;
  workshopId: string;
}): WorkshopDashboardCacheHit | null {
  const entry = dashboardCache.get(cacheKey(input.userId, input.workshopId));
  if (!entry) return null;

  const now = Date.now();
  if (now > entry.staleUntil) {
    dashboardCache.delete(cacheKey(input.userId, input.workshopId));
    return null;
  }

  return {
    dashboard: entry.dashboard,
    hit: true,
    stale: now > entry.expiresAt,
    refreshing: Boolean(entry.refreshing),
    fetchedAt: entry.fetchedAt,
    expiresAt: entry.expiresAt,
  };
}

export function setCachedWorkshopDashboard(input: {
  userId: string;
  workshopId: string;
  dashboard: WorkshopDashboard;
}) {
  const fetchedAt = Date.now();
  const expiresAt = fetchedAt + dashboardCacheTtlMs();
  dashboardCache.set(cacheKey(input.userId, input.workshopId), {
    dashboard: input.dashboard,
    fetchedAt,
    expiresAt,
    staleUntil: expiresAt + dashboardCacheStaleTtlMs(),
  });
}

export function getWorkshopDashboardRefresh(input: {
  userId: string;
  workshopId: string;
}): Promise<WorkshopDashboard | null> | null {
  return (
    dashboardCache.get(cacheKey(input.userId, input.workshopId))?.refreshing ??
    null
  );
}

export function markWorkshopDashboardRefreshing(input: {
  userId: string;
  workshopId: string;
  refreshing: Promise<WorkshopDashboard | null>;
}) {
  const key = cacheKey(input.userId, input.workshopId);
  const existing = dashboardCache.get(key);
  if (!existing) return;
  existing.refreshing = input.refreshing.finally(() => {
    const latest = dashboardCache.get(key);
    if (latest === existing) {
      delete latest.refreshing;
    }
  });
}

export function invalidateWorkshopDashboardCache(workshopId: string) {
  for (const key of dashboardCache.keys()) {
    if (key.endsWith(`:${workshopId}`)) {
      dashboardCache.delete(key);
    }
  }
}

export function clearWorkshopDashboardCache() {
  dashboardCache.clear();
}
