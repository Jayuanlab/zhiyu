import { describe, expect, it } from "vitest";
import {
  summarySnapshotToPageState,
  withWorkshopSummaryCacheMeta,
  workshopSummaryPageStateKey,
} from "@/lib/workshops/summary-page-state";
import type { WorkSummarySnapshot } from "@/lib/work-runtime/types";

const workshop = {
  id: "workshop-1",
  userId: "user-1",
  name: "Workshop",
  mission: "Mission",
  status: "active",
  autonomyLevel: "supervised",
  boundaryPolicy: {},
  modelConfig: {},
  createdAt: new Date("2026-08-22T00:00:00.000Z"),
  updatedAt: new Date("2026-08-22T00:00:00.000Z"),
};

function snapshot(): WorkSummarySnapshot {
  const events = Array.from({ length: 35 }, (_, index) => ({
    id: `event-${index}`,
    workshopId: "workshop-1",
    type: "observation",
    title: `Event ${index}`,
    body: "x".repeat(2_000),
    metadata: {
      large: "y".repeat(2_000),
    },
    seq: index,
    runId: null,
    loopId: null,
    loopRunId: null,
    visibility: "public",
    createdAt: new Date("2026-08-22T00:00:00.000Z"),
  }));

  return {
    interfaceVersion: "work-runtime.v2",
    generatedAt: "2026-08-22T00:00:01.000Z",
    workId: "workshop-1",
    detail: {
      workshop: workshop as WorkSummarySnapshot["detail"]["workshop"],
      heartbeat: null,
      loops: [],
      sources: [],
      memories: [],
      outbox: [],
      runs: [],
      events,
    },
    dashboard: {
      workshop: workshop as WorkSummarySnapshot["dashboard"]["workshop"],
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
        label: "none",
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
      recentEvents: events,
      outbox: [],
      memories: [],
      sources: [],
      runs: [],
      heartbeat: null,
    },
  };
}

describe("workshop summary page-state", () => {
  it.each([0, 1, 20, 100, 101])("keeps the latest event in a %i-event timeline", (count) => {
    const input = snapshot();
    const seed = input.detail.events[0] as Record<string, unknown>;
    input.detail.events = Array.from({length: count}, (_, index) => ({...seed, id: `event-${index}`, seq: index + 1, type: index === count - 1 ? "loop_run_completed" : "observation"}));
    const state = summarySnapshotToPageState(input);
    expect(state.events).toHaveLength(Math.min(count, 20));
    expect(state.eventWindow.lastSeq).toBe(count || null);
    expect(state.eventWindow.hasMore).toBe(count > 20);
    if (count) expect(state.events.at(-1)).toMatchObject({seq: count, type: "loop_run_completed"});
  });
  it("uses stable per-workshop snapshot keys", () => {
    expect(workshopSummaryPageStateKey("abc")).toBe("workshop:abc:summary:v5");
  });

  it("keeps the legacy summary response shape with page-state metadata", () => {
    const state = summarySnapshotToPageState(snapshot());

    expect(state.workshop.id).toBe("workshop-1");
    expect(state.dashboard.status).toBe("active");
    expect(state.interfaceVersion).toBe("work-runtime.v2");
    expect(state.generatedAt).toBe("2026-08-22T00:00:01.000Z");
    expect(state.events).toHaveLength(20);
    expect(state.eventWindow).toEqual({ firstSeq: 15, lastSeq: 34, hasMore: true });
    expect((state.events[0] as { body?: string }).body?.length).toBeLessThan(
      400,
    );
    expect(
      Object.keys((state.events[0] as { metadata: Record<string, unknown> }).metadata),
    ).not.toContain("large");
    expect(state.dashboard.recentEvents).toHaveLength(20);
    expect(state.meta).toMatchObject({
      hit: false,
      stale: false,
      refreshing: false,
    });
  });

  it("marks persisted stale snapshots as cache hits and refreshing", () => {
    const state = summarySnapshotToPageState(snapshot());
    const withMeta = withWorkshopSummaryCacheMeta({
      value: state,
      stale: true,
      refreshing: true,
      generatedAt: new Date("2026-08-22T00:00:00.000Z"),
      expiresAt: new Date("2026-08-22T00:00:10.000Z"),
    });

    expect(withMeta.meta.cache).toMatchObject({
      hit: true,
      stale: true,
      refreshing: true,
      fetchedAt: "2026-08-22T00:00:00.000Z",
      expiresAt: "2026-08-22T00:00:10.000Z",
    });
    expect(withMeta.meta.warnings).toContain(
      "workshop summary page-state snapshot is stale; refreshing in background",
    );
  });
});
