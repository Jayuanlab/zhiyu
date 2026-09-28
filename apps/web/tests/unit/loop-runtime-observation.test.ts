import { describe, expect, it } from "vitest";
import { readLoopRuntimeObservationForOwner } from "@/lib/ai/loop-runtime-observation";

const userId = "11111111-1111-4111-8111-111111111111";
const loopId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const loopRunId = "44444444-4444-4444-8444-444444444444";
const observedAt = "2026-09-23T12:00:00.000Z";
const active = { run_id: runId, loop_run_id: loopRunId, work_run_status: "running",
  lease_run_id: runId, lease_phase: "running", lease_until: "2026-09-23T12:00:30.000Z",
  heartbeat_at: "2026-09-23T11:59:45.000Z" };

describe("owner-scoped Loop runtime observation", () => {
  it("checks owner before reading execution", async () => {
    let read = false;
    const result = await readLoopRuntimeObservationForOwner({ userId, loopId }, {
      ownsLoop: async () => false,
      readActiveExecution: async () => { read = true; return { observedAt, row: active }; },
    });
    expect(result.status).toBe("loop_not_found_in_scope");
    expect(read).toBe(false);
  });
  it("does not expose a missing-row result after ownership changes during the read", async () => {
    const result = await readLoopRuntimeObservationForOwner({ userId, loopId }, {
      ownsLoop: async () => true,
      readActiveExecution: async () => ({ observedAt, row: null, stillOwned: false }),
    });
    expect(result.status).toBe("loop_not_found_in_scope");
    expect(JSON.stringify(result)).not.toContain(loopId);
  });
  it("reports only a bounded recent lease observation and omits executor secrets", async () => {
    const result = await readLoopRuntimeObservationForOwner({ userId, loopId }, {
      ownsLoop: async () => true,
      readActiveExecution: async () => ({ observedAt, row: { ...active, token: 49, worker_id: "private-worker" },
        loopConfig: { status: "active", updatedAt: "2026-09-19T00:00:00Z" } }),
    });
    expect(result.status).toBe("active_lease_recent_heartbeat");
    expect(result.linkedExecution).toMatchObject({ leaseMatchesRun: true, heartbeatAgeMs: 15_000 });
    expect(result.loopConfiguration).toMatchObject({ status: "active",
      temporalScope: "configuration_at_database_read_time_not_executor_activity" });
    expect(JSON.stringify(result)).not.toMatch(/private-worker|token/);
  });
  it.each([
    ["stale heartbeat", { heartbeat_at: "2026-09-23T11:55:00.000Z" }],
    ["expired lease", { lease_until: "2026-09-23T11:59:59.000Z" }],
    ["mismatched run", { lease_run_id: loopRunId }],
    ["completed work run", { work_run_status: "completed" }],
    ["future heartbeat", { heartbeat_at: "2026-09-23T12:00:01.000Z" }],
  ])("does not call %s live", async (_label, changed) => {
    const result = await readLoopRuntimeObservationForOwner({ userId, loopId }, {
      ownsLoop: async () => true,
      readActiveExecution: async () => ({ observedAt, row: { ...active, ...changed } }),
    });
    expect(result.status).toBe("not_currently_verified");
  });
  it("keeps absence distinct from proof of stopped execution", async () => {
    const result = await readLoopRuntimeObservationForOwner({ userId, loopId }, {
      ownsLoop: async () => true,
      readActiveExecution: async () => ({ observedAt, row: null,
        loopConfig: { status: "active", updatedAt: "2026-09-19T00:00:00Z" } }),
    });
    expect(result.status).toBe("no_active_linked_execution_observed");
    expect(result.loopConfiguration?.status).toBe("active");
    expect(result.warning).toContain("does not prove");
  });
});
