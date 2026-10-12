import { describe, expect, it } from "vitest";
import type { PlatformMetricFact } from "@/lib/ai/runtime/platform-answer-contract";
import { derivePlatformProcessingJobBoundaries } from "@/lib/ai/runtime/platform-processing-job-boundaries";
import { INTERACTION_PROCESSING_JOB_CLAIM_POLICY_VERSION, INTERACTION_PROCESSING_JOB_CLAIMABLE_STATUSES } from "@/lib/interactions/processing-job-policy";

const at = "2026-10-02T06:01:46.768Z";
function metric(groups: NonNullable<PlatformMetricFact["groups"]> = [{ value: "completed", count: 2180 }, { value: "running", count: 2 }], extra: Partial<PlatformMetricFact> = {}): PlatformMetricFact {
  return { kind: "metric", source: "interaction_processing_jobs.status", total: groups.reduce((sum, group) => sum + group.count, 0),
    groups, proofId: "a".repeat(64), observation: { kind: "snapshot", observedAt: at }, observedAt: at, scope: "owner_stored_status", ...extra };
}
const derive = (metrics: PlatformMetricFact[]) => derivePlatformProcessingJobBoundaries({ metrics, contextState: "eligible" });

describe("source-bound processing-job boundaries", () => {
  it("proves the necessary candidate set empty without schedule or attempts fields", () => {
    const result = derive([metric()]);
    expect(result.runnable).toEqual({ state: "supported", count: 0, reason: "fixed_service_necessary_status_empty" });
    expect(result.binding).toMatchObject({ source: "interaction_processing_jobs.status", observedAt: at, proofId: "a".repeat(64),
      policyVersion: INTERACTION_PROCESSING_JOB_CLAIM_POLICY_VERSION, necessaryStatuses: INTERACTION_PROCESSING_JOB_CLAIMABLE_STATUSES });
    expect(result.waiting.state).toBe("conditional");
    if (result.waiting.state === "conditional") {
      expect(result.waiting.branches.map(branch => [branch.status, branch.count])).toEqual([["pending", 0], ["resume_pending", 0], ["needs_review", 0]]);
      expect(result.waiting.branches.every(branch => branch.countReason === "absent_group_in_complete_query")).toBe(true);
    }
  });
  it("accepts explicitly zero necessary groups and an entirely empty complete owner population", () => {
    expect(derive([metric(INTERACTION_PROCESSING_JOB_CLAIMABLE_STATUSES.map(value => ({ value, count: 0 })))]).runnable.state).toBe("supported");
    expect(derive([metric([])]).runnable).toMatchObject({ state: "supported", count: 0 });
  });
  it.each(INTERACTION_PROCESSING_JOB_CLAIMABLE_STATUSES)("never derives a positive or zero runnable count from nonzero %s alone", status => {
    const result = derive([metric([{ value: status, count: 1 }])]);
    expect(result.runnable).toEqual({ state: "unknown", reason: "runnable_schedule_and_attempts_required" });
    expect(result.runnable).not.toHaveProperty("count");
  });
  it("keeps feature-specific waiting branches separate and never renames running", () => {
    const result = derive([metric([{ value: "pending", count: 4 }, { value: "resume_pending", count: 2 }, { value: "needs_review", count: 3 }, { value: "running", count: 8 }])]);
    expect(result.waiting.state).toBe("conditional");
    if (result.waiting.state === "conditional") {
      expect(result.waiting.reason).toBe("waiting_has_multiple_feature_definitions");
      expect(result.waiting.branches.map(branch => [branch.status, branch.count])).toEqual([["pending", 4], ["resume_pending", 2], ["needs_review", 3]]);
      expect(result.waiting).not.toHaveProperty("count");
      expect(result.waiting.branches.every(branch => branch.countReason === "observed_group")).toBe(true);
    }
  });
  it("retains NULL and future varchar states without treating the column as a closed enum", () => {
    const input = metric([{ value: null, count: 2 }, { value: "future_waiting_state", count: 7 }, { value: "running", count: 1 }]);
    const before = JSON.stringify(input), result = derive([input]);
    expect(result.binding?.rawGroups).toEqual(input.groups);
    expect(JSON.stringify(input)).toBe(before);
    expect(result.runnable).toMatchObject({ state: "supported", count: 0 });
    expect(result.waiting).not.toHaveProperty("count");
  });
  it.each(["denied", "unavailable", "snapshot_mismatch"] as const)("does not grant a zero fact when context is %s", contextState => {
    const result = derivePlatformProcessingJobBoundaries({ metrics: [metric()], contextState });
    expect(result.runnable.state).toBe(contextState === "denied" ? "denied" : "unknown");
    expect(result.waiting.state).toBe(contextState === "denied" ? "denied" : "unknown");
    expect(result.binding).toBeUndefined();
  });
  it("requires a validated complete metric rather than a missing source or draft label", () => {
    expect(derive([]).runnable.state).toBe("unknown");
    expect(derive([metric([], { source: "interaction_events.processed_status" })]).runnable.state).toBe("unknown");
    expect(derive([metric([], { scope: "owner_exact_record" as never })]).runnable.state).toBe("unknown");
    expect(derive([metric([], { proofId: "" })]).runnable.state).toBe("unknown");
    expect(derive([metric([], { groups: undefined })]).runnable.state).toBe("unknown");
  });
  it.each([
    metric([{ value: "completed", count: 1 }], { total: 2 }),
    metric([{ value: "pending", count: -1 }]),
    metric([{ value: "pending", count: 0 }, { value: "pending", count: 0 }]),
    metric([{ value: "running", count: 0.5 }]),
    metric([], { observation: { kind: "snapshot", observedAt: "2026-10-02T07:00:00.000Z" } }),
    metric([], { observedAt: "unknown", observation: { kind: "snapshot", observedAt: "unknown" } }),
  ])("rejects malformed, incomplete, duplicate or time-mismatched groups", invalid => {
    expect(derive([invalid]).runnable.state).toBe("unknown");
  });
  it("refuses same-time conflicting proofs and accepts identical repeated delivery", () => {
    expect(derive([metric(), metric([], { proofId: "b".repeat(64) })]).runnable.state).toBe("unknown");
    expect(derive([metric(), metric()]).runnable.state).toBe("supported");
  });
  it("refuses same proofId attached to divergent same-time content", () => {
    expect(derive([metric(), metric([{ value: "pending", count: 1 }])]).runnable.state).toBe("unknown");
  });
  it("uses the newest eligible observation and does not merge different instants", () => {
    const later = "2026-10-02T06:02:46.768Z";
    const result = derive([metric(), metric([{ value: "pending", count: 1 }], { observedAt: later, observation: { kind: "snapshot", observedAt: later } })]);
    expect(result.runnable.state).toBe("unknown");
    expect(result.binding?.observedAt).toBe(later);
  });
});
