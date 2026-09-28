import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkRunRuntimeSnapshotAuditSummary } from "@/lib/work-runtime/runtime-snapshot";

const dbMock = vi.hoisted(() => ({
  execute: vi.fn(),
}));
const claimWorkshopExecutionMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({
  db: dbMock,
}));

vi.mock("@/lib/work-runtime/execution-lease", () => ({
  claimWorkshopExecution: claimWorkshopExecutionMock,
}));

vi.mock("@/lib/work-runtime/execution-context", () => ({
  resolveExecutionLease: vi.fn(() => null),
}));

vi.mock("@/lib/workshops/service", () => ({
  getWorkshop: vi.fn(),
}));

const summary: WorkRunRuntimeSnapshotAuditSummary = {
  eventId: "event-1",
  createdAt: "2026-09-14T00:00:00.000Z",
  runId: "run-1",
  loopId: null,
  loopRunId: null,
  engine: "pi",
  adapter: "pi-agent-core",
  model: "fixture-model",
  modelTier: "standard",
  runtimeHash: "r".repeat(64),
  policyHash: "p".repeat(64),
  allowedToolCount: 2,
};

describe("work runtime consumers preserve runtime snapshot observations", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    dbMock.execute.mockReset();
    claimWorkshopExecutionMock.mockReset();
  });

  it("returns claim runtime snapshots from the Work run consumer", async () => {
    dbMock.execute.mockResolvedValueOnce([
      { id: "run-1", workshop_id: "workshop-1" },
    ]);
    claimWorkshopExecutionMock.mockResolvedValueOnce({
      state: "busy",
      runId: "run-1",
      runtimeSnapshot: summary,
    });
    const { consumeOwnedWorkRuns } = await import(
      "@/lib/work-runtime/run-consumer"
    );

    await expect(
      consumeOwnedWorkRuns({
        userId: "00000000-0000-4000-8000-000000000001",
        workerId: "worker",
      }),
    ).resolves.toEqual([
      {
        runId: "run-1",
        state: "busy",
        runtimeSnapshot: summary,
      },
    ]);
  });

  it("returns busy runtime snapshots from the Loop run consumer", async () => {
    dbMock.execute
      .mockResolvedValueOnce([
        {
          run_id: "run-1",
          request_json: {
            userId: "00000000-0000-4000-8000-000000000001",
            workId: "workshop-1",
            loopId: "loop-1",
          },
        },
      ])
      .mockResolvedValueOnce([]);
    const { consumeOwnedLoopRuns } = await import(
      "@/lib/work-runtime/loop-consumer"
    );
    const { LoopExecutionBusy } = await import(
      "@/lib/work-runtime/loop-execution"
    );

    await expect(
      consumeOwnedLoopRuns(
        {
          userId: "00000000-0000-4000-8000-000000000001",
          workerId: "worker",
        },
        async () => {
          throw new LoopExecutionBusy("recovery_required", summary);
        },
      ),
    ).resolves.toEqual([
      {
        runId: "run-1",
        state: "recovery_required",
        detail: "Loop execution unavailable: recovery_required",
        runtimeSnapshot: summary,
      },
    ]);
  });
});
