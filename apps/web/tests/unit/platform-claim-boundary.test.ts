import { describe, expect, it } from "vitest";
import { buildPlatformClaimBoundary } from "@/lib/ai/platform-claim-boundary";

describe("platform claim boundary", () => {
  it("separates an empty later-run window from current runtime and repair claims", () => {
    const boundary = buildPlatformClaimBoundary([
      { source: "loopStates", id: "loop-1", fields: { currentPhase: "error", updatedAt: "2026-09-19T02:02:18Z" } },
      { source: "workshops", id: "work-1", fields: { status: "active" }, fieldAvailability: { name: "present_unread" } } as any,
    ], { status: "read", observedAt: "2026-09-23T00:00:00Z", runs: [], coverage: { hasMore: false } });
    expect(boundary.laterRuns).toMatchObject({ status: "none_observed_at_read_time", observedAt: "2026-09-23T00:00:00Z" });
    expect(boundary.currentExecutor).toMatchObject({ status: "not_observed", lastPersistedStates: [{ lastPersistedPhase: "error" }] });
    expect(boundary.repair.status).toBe("not_established_by_timeline_or_persisted_state");
    expect(boundary.unreadFields).toEqual(["workshops:work-1:name"]);
    expect(boundary.actionExecution.status).toBe("not_established_by_permission_decisions");
  });
  it("does not equate an incomplete timeline page with no later runs", () => {
    const boundary = buildPlatformClaimBoundary([], { status: "read", runs: [], coverage: { hasMore: true } });
    expect(boundary.laterRuns.status).toBe("none_in_this_page_more_unread");
  });
  it("limits a fresh lease claim to its observation time", () => {
    const boundary = buildPlatformClaimBoundary([], undefined, {
      status: "active_lease_recent_heartbeat", provider: "workshop_execution_leases",
      loopId: "loop-1", observedAt: "2026-09-23T12:00:00Z", maximumHeartbeatAgeMs: 120000,
      linkedExecution: null, warning: "Recent lease only",
    });
    expect(boundary.currentExecutor).toMatchObject({ status: "active_lease_recent_heartbeat",
      observedAt: "2026-09-23T12:00:00Z" });
    expect(boundary.currentExecutor.instruction).toContain("not claim the process remains alive now");
  });
});
