import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkshopDashboard } from "@/lib/workshops/dashboard";
import {
  clearWorkshopDashboardCache,
  getCachedWorkshopDashboard,
  setCachedWorkshopDashboard,
} from "@/lib/workshops/dashboard-cache";

function dashboard(): WorkshopDashboard {
  return {
    workshop: {
      id: "workshop-1",
      userId: "user-1",
      name: "Workshop",
      mission: "Move fast without blocking the page.",
      status: "active",
      autonomyLevel: "draft",
      boundaryPolicy: {},
      modelConfig: {},
      createdAt: new Date("2026-08-22T00:00:00.000Z"),
      updatedAt: new Date("2026-08-22T00:00:00.000Z"),
    },
    status: "active",
    counts: {
      loops: 0,
      activeLoops: 0,
      pendingLoopProposals: 0,
      pendingOutbox: 0,
      pendingApprovals: 0,
      blockedLoops: 0,
      errorLoops: 0,
      sources: 0,
      memories: 0,
      directives: 0,
    },
    nextWork: {
      source: null,
      at: null,
      label: "None",
    },
    contextCost: {
      recentReportCount: 0,
      estimatedInputCostUsd: null,
      avgEstimatedPromptTokens: null,
      latestRuntime: null,
      latestReport: null,
      largestSection: null,
      profileCounts: {},
      runtimeEngineCounts: {},
      modelTierCounts: {},
      toolProfileCounts: {},
      sectionStats: [],
    },
    recentFinding: null,
    latestEvent: null,
    pendingOutbox: [],
    pendingLoopProposals: [],
    blockedLoops: [],
    loops: [],
    recentEvents: [],
    outbox: [],
    memories: [],
    sources: [],
    runs: [],
    heartbeat: null,
  };
}

describe("workshop dashboard cache", () => {
  afterEach(() => {
    clearWorkshopDashboardCache();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("keeps expired dashboards as stale snapshots inside the stale window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.stubEnv("WORKSHOP_DASHBOARD_CACHE_TTL_MS", "100");
    vi.stubEnv("WORKSHOP_DASHBOARD_CACHE_STALE_TTL_MS", "1000");

    setCachedWorkshopDashboard({
      userId: "user-1",
      workshopId: "workshop-1",
      dashboard: dashboard(),
    });

    expect(
      getCachedWorkshopDashboard({
        userId: "user-1",
        workshopId: "workshop-1",
      }),
    ).toMatchObject({
      hit: true,
      stale: false,
      refreshing: false,
    });

    vi.setSystemTime(1_200);

    expect(
      getCachedWorkshopDashboard({
        userId: "user-1",
        workshopId: "workshop-1",
      }),
    ).toMatchObject({
      hit: true,
      stale: true,
      refreshing: false,
    });

    vi.setSystemTime(2_500);

    expect(
      getCachedWorkshopDashboard({
        userId: "user-1",
        workshopId: "workshop-1",
      }),
    ).toBeNull();
  });
});
