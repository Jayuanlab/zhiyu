import { describe, expect, it } from "vitest";
import { mergeDashboardSummary, isOlderProjection } from "@/lib/workshops/projection-view";

describe("dashboard summary convergence", () => {
  const current = {status: "active", counts: {pendingApprovals: 0}, loops: [1, 2], projection: {asOf: "2026-09-06T09:00:00Z"}};
  it("applies newer summary counts and preserves loaded detail lists", () => {
    const next = {...current, counts: {pendingApprovals: 2}, loops: [], projection: {asOf: "2026-09-06T09:01:00Z"}};
    expect(mergeDashboardSummary(current, next)).toMatchObject({counts: {pendingApprovals: 2}, loops: [1, 2]});
  });
  it("does not allow stale or legacy responses to overwrite current facts", () => {
    const stale = {...current, projection: {asOf: "2026-09-06T08:59:00Z"}};
    expect(mergeDashboardSummary(current, stale)).toBe(current);
    expect(isOlderProjection(current, {...current, projection: undefined})).toBe(true);
  });
  it("refreshes the typed conclusion and clears it when the current projection has none", () => {
    const before = {...current, latestConclusion: {id: 'old'}};
    const after = {...current, projection: {asOf: '2026-09-06T09:02:00Z'}, latestConclusion: {id: 'new'} as {id: string} | null};
    expect(mergeDashboardSummary(before, after)?.latestConclusion).toEqual({id: 'new'});
    expect(mergeDashboardSummary(after, {...after, latestConclusion: null})?.latestConclusion).toBeNull();
  });
});
