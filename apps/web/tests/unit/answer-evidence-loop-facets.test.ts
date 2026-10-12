import { describe, expect, it } from "vitest";
import { projectLoopRuntimeFacets, requestedLoopRuntimeFacets } from "@/lib/ai/runtime/answer-evidence-loop-facets";

const observedAt = "2026-10-03T08:00:00.000Z";
function runtime() {
  return { observationScope: "linked_execution_and_matching_lease", observedAt, maximumHeartbeatAgeMs: 120_000,
    linkedExecution: { leaseMatchesRun: true, leasePhase: "running", leaseUntil: "2026-10-03T07:59:50.000Z",
      leaseUnexpired: false, heartbeatAt: "2026-10-03T07:59:56.000Z", heartbeatAgeMs: 4_000, heartbeatFresh: true } };
}
const facts = (value: unknown) => Object.fromEntries(projectLoopRuntimeFacets(value).map(fact => [fact.key, fact]));

describe("Loop requested observation facets", () => {
  it.each(["租约和心跳", "lease and heartbeat", "leaseUntil and heartbeatFresh", "leases and heartbeats"])("selects only the requested observation families: %s", question => {
    expect(requestedLoopRuntimeFacets(question)).toHaveLength(8);
  });
  it("does not add detail requirements to a broad runtime question", () => {
    expect(requestedLoopRuntimeFacets("当前执行器是否正在运行？")).toEqual([]);
    expect(requestedLoopRuntimeFacets("current executor running?")).toEqual([]);
    expect(requestedLoopRuntimeFacets("请核对当前租约状态")).toHaveLength(4);
    expect(requestedLoopRuntimeFacets("check current heartbeat age")).toHaveLength(4);
  });
  it("preserves a read-time expired lease alongside a fresh single heartbeat", () => {
    const result = facts(runtime());
    expect(result.lease_unexpired).toMatchObject({ state: "observed", value: false });
    expect(result.heartbeat_fresh).toMatchObject({ state: "observed", value: true });
    expect(result.heartbeat_age_ms.value).toBe(4_000);
  });
  it.each(["absent_mapping", "missing_link", "unknown_scope"])("does not turn %s into observed lease absence", variant => {
    const value: any = runtime();
    if (variant === "absent_mapping") value.observationScope = "active_linked_execution_mapping_only";
    if (variant === "missing_link") value.linkedExecution = null;
    if (variant === "unknown_scope") delete value.observationScope;
    const result = facts(value);
    expect(result.lease_matches_run.state).toBe("unknown");
    expect(result.lease_unexpired.state).toBe("unknown");
    expect(result.heartbeat_at.state).toBe("unknown");
  });
  it.each(["missing_until", "wrong_flag", "string_flag"])("does not infer lease expiry from %s", variant => {
    const value: any = runtime();
    if (variant === "missing_until") value.linkedExecution.leaseUntil = null;
    if (variant === "wrong_flag") value.linkedExecution.leaseUnexpired = true;
    if (variant === "string_flag") value.linkedExecution.leaseUnexpired = "false";
    expect(facts(value).lease_unexpired.state).toBe("unknown");
  });
  it.each(["future_time", "wrong_age", "wrong_freshness", "missing_threshold"])("requires trustworthy single-heartbeat classification for %s", variant => {
    const value: any = runtime();
    if (variant === "future_time") value.linkedExecution.heartbeatAt = "2026-10-03T08:00:01.000Z";
    if (variant === "wrong_age") value.linkedExecution.heartbeatAgeMs = 0;
    if (variant === "wrong_freshness") value.linkedExecution.heartbeatFresh = false;
    if (variant === "missing_threshold") delete value.maximumHeartbeatAgeMs;
    expect(facts(value).heartbeat_fresh.state).toBe("unknown");
  });
  it("uses the reader's explicit freshness threshold at the inclusive boundary", () => {
    const value = runtime();
    value.linkedExecution.heartbeatAt = "2026-10-03T07:58:00.000Z";
    value.linkedExecution.heartbeatAgeMs = 120_000;
    expect(facts(value).heartbeat_fresh).toMatchObject({ state: "observed", value: true });
    value.linkedExecution.heartbeatAt = "2026-10-03T07:57:59.999Z";
    value.linkedExecution.heartbeatAgeMs = 120_001;
    value.linkedExecution.heartbeatFresh = false;
    expect(facts(value).heartbeat_fresh).toMatchObject({ state: "observed", value: false });
  });
});
