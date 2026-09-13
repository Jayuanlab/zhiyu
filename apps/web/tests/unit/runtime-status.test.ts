import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock('@/lib/runtime/worker-status',()=>({getRuntimeWorkerStatus:vi.fn(async()=>({state:'offline',online:false,modules:[]}))}));

const mocks = vi.hoisted(() => ({
  getLightweightSchedulerStatus: vi.fn(),
  isLocalSchedulerAllowedLight: vi.fn(),
  getIntegrationAccountsByUserId: vi.fn(),
  getRuntimeBootstrapStatus: vi.fn(),
  getCachedRuntimeConnectorCounts: vi.fn(),
  setCachedRuntimeConnectorCounts: vi.fn(),
  getBrainCanonicalStorageStatus: vi.fn(),
}));

vi.mock("@/lib/cron/scheduler-state", () => ({
  getLightweightSchedulerStatus: mocks.getLightweightSchedulerStatus,
  isLocalSchedulerAllowedLight: mocks.isLocalSchedulerAllowedLight,
}));

vi.mock("@/lib/db/integration-queries", () => ({
  getIntegrationAccountsByUserId: mocks.getIntegrationAccountsByUserId,
}));

vi.mock("@/lib/runtime/bootstrap-state", () => ({
  getRuntimeBootstrapStatus: mocks.getRuntimeBootstrapStatus,
}));

vi.mock("@/lib/runtime/status-cache", () => ({
  getCachedRuntimeConnectorCounts: mocks.getCachedRuntimeConnectorCounts,
  setCachedRuntimeConnectorCounts: mocks.setCachedRuntimeConnectorCounts,
}));

vi.mock("@/lib/brain/repository", () => ({
  getBrainCanonicalStorageStatus: mocks.getBrainCanonicalStorageStatus,
}));

import { getRuntimeStatusSnapshot } from "@/lib/runtime/status";

describe("runtime status snapshot", () => {
  it('does not expose the embedded scheduler state of a different owner',async()=>{
    const snapshot=await getRuntimeStatusSnapshot('user-2');
    expect(snapshot.scheduler).toMatchObject({isRunning:false,userId:null,lastTickResult:null,nativeLoops:null,workshopHeartbeats:null});
    expect(snapshot.web.online).toBe(true);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isLocalSchedulerAllowedLight.mockReturnValue(true);
    mocks.getLightweightSchedulerStatus.mockReturnValue({
      isRunning: false,
      checkInterval: 60_000,
      userId: "user-1",
      isProcessing: false,
      lastTickStartedAt: null,
      lastTickCompletedAt: null,
      lastTickStatus: null,
      lastTickError: null,
      lastTickResult: null,
      nativeLoops: { runningLoopIds: [] },
      workshopHeartbeats: { runningWorkshopIds: [] },
    });
    mocks.getCachedRuntimeConnectorCounts.mockReturnValue(null);
    mocks.getIntegrationAccountsByUserId.mockResolvedValue([
      { platform: "wechat", status: "active" },
      { platform: "github", status: "disabled" },
    ]);
    mocks.getRuntimeBootstrapStatus.mockReturnValue({
      lastQueuedAt: null,
      lastCompletedAt: null,
      inFlight: false,
      results: [],
    });
    mocks.getBrainCanonicalStorageStatus.mockResolvedValue({
      checkedAt: "2026-08-21T00:00:00.000Z",
      migrationReady: true,
      status: "ok",
      totalMemories: 12,
      canonicalKindRows: 12,
      canonicalGroupRows: 11,
      canonicalKindCoverage: 1,
      canonicalGroupCoverage: 11 / 12,
      sampleQueryMs: 7,
      warnings: [],
      error: null,
    });
  });

  it("includes Brain canonical storage health for the requesting user", async () => {
    const snapshot = await getRuntimeStatusSnapshot("user-1");

    expect(mocks.getBrainCanonicalStorageStatus).toHaveBeenCalledWith({
      userId: "user-1",
    });
    expect(snapshot.brain.canonicalStorage).toMatchObject({
      migrationReady: true,
      status: "ok",
      totalMemories: 12,
      canonicalKindRows: 12,
      canonicalGroupRows: 11,
      sampleQueryMs: 7,
    });
    expect(snapshot.connectors).toMatchObject({
      totalAccounts: 2,
      activeAccounts: 1,
      accountsByPlatform: { wechat: 1, github: 1 },
      activeByPlatform: { wechat: 1 },
    });
  });

  it("still checks Brain storage when connector counts are served from cache", async () => {
    mocks.getCachedRuntimeConnectorCounts.mockReturnValue({
      totalAccounts: 1,
      activeAccounts: 1,
      accountsByPlatform: { wechat: 1 },
      activeByPlatform: { wechat: 1 },
    });
    mocks.getBrainCanonicalStorageStatus.mockResolvedValue({
      checkedAt: "2026-08-21T00:00:00.000Z",
      migrationReady: false,
      status: "migration_missing",
      totalMemories: 0,
      canonicalKindRows: 0,
      canonicalGroupRows: 0,
      canonicalKindCoverage: 0,
      canonicalGroupCoverage: 0,
      sampleQueryMs: null,
      warnings: ["migration not ready"],
      error: "missing column",
    });

    const snapshot = await getRuntimeStatusSnapshot("user-1");

    expect(mocks.getIntegrationAccountsByUserId).not.toHaveBeenCalled();
    expect(mocks.getBrainCanonicalStorageStatus).toHaveBeenCalledWith({
      userId: "user-1",
    });
    expect(snapshot.brain.canonicalStorage).toMatchObject({
      migrationReady: false,
      status: "migration_missing",
      error: "missing column",
    });
  });
});
