import { afterEach, describe, expect, it, vi } from "vitest";

const nativeStatus = vi.hoisted(() => ({ runningLoopIds: ["loop-1"] }));
const runDueNativeLoopsMock = vi.hoisted(() => vi.fn(async () => undefined));
const recoverInterruptedMock = vi.hoisted(() => vi.fn(async () => 0));

vi.mock("@/lib/loops/service", () => ({
  recoverInterruptedLoopRuns: recoverInterruptedMock,
}));

vi.mock("@/lib/knowledge-pipeline/ingestion-runtime", () => ({
  runDueInteractionIngestion: vi.fn(async () => ({ lastStatus: "success" })),
}));

vi.mock("@/lib/cron/service", () => ({
  getDueJobs: vi.fn(async () => []),
  startJobExecution: vi.fn(),
  completeJobExecution: vi.fn(),
  recoverStuckJobs: vi.fn(),
  cleanupStuckJobs: vi.fn(),
}));

vi.mock("@/lib/cron/executor", () => ({
  executeJob: vi.fn(),
}));

vi.mock("@/lib/env/constants", () => ({
  isTauriMode: vi.fn(() => false),
  DEFAULT_AI_MODEL: "test-model",
  AI_PROXY_BASE_URL: "http://localhost.test",
}));

vi.mock("@/lib/auth/token-manager", () => ({
  getCloudAuthToken: vi.fn(() => undefined),
}));

vi.mock("@/lib/db/index", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(async () => []) })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  characters: { status: "status", id: "id" },
  jobExecutions: { status: "status", id: "id", jobId: "jobId" },
  scheduledJobs: { id: "id" },
}));

vi.mock("@/lib/loops", () => ({
  runScheduledJobLoop: vi.fn(),
}));

vi.mock("@/lib/loops/native-scheduler", () => ({
  getNativeLoopSchedulerStatus: vi.fn(() => nativeStatus),
  runDueNativeLoops: runDueNativeLoopsMock,
}));

vi.mock("@/lib/interactions/worker", () => ({
  runPendingInteractionProcessingJobs: vi.fn(async () => undefined),
}));

vi.mock("@/lib/workshops/heartbeat-scheduler", () => ({
  getWorkshopHeartbeatSchedulerStatus: vi.fn(() => ({
    runningWorkshopIds: [],
  })),
  runDueWorkshopHeartbeats: vi.fn(async () => undefined),
}));

vi.mock("@/lib/cron/insight-maintenance", () => ({
  runInsightEmbeddingDreamIfDue: vi.fn(),
  runInsightMaintenanceIfDue: vi.fn(),
  runRawMessageEmbeddingDreamIfDue: vi.fn(),
}));

import {
  getSchedulerStatus,
  setSchedulerUserId,
  startLocalScheduler,
  stopLocalScheduler,
} from "@/lib/cron/local-scheduler";
import {recoverStuckJobs,cleanupStuckJobs} from "@/lib/cron/service";
import {db} from "@/lib/db/index";

describe("local scheduler status", () => {
  afterEach(async () => {
    await stopLocalScheduler();
    setSchedulerUserId(undefined);
    runDueNativeLoopsMock.mockClear();
    recoverInterruptedMock.mockReset().mockResolvedValue(0);
    vi.mocked(recoverStuckJobs).mockClear();
    vi.mocked(cleanupStuckJobs).mockClear();
    vi.mocked(db.select).mockClear();
    vi.mocked(db.update).mockClear();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("includes native loop scheduler visibility", () => {
    expect(getSchedulerStatus()).toMatchObject({
      isRunning: false,
      checkInterval: 60_000,
      nativeLoops: {
        runningLoopIds: ["loop-1"],
      },
    });
  });

  it("starts local web scheduler and checks native loops for the active user", async () => {
    vi.useFakeTimers();
    vi.stubEnv("ENABLE_LOCAL_SCHEDULER", "true");
    setSchedulerUserId("user-1");

    await startLocalScheduler();
    await vi.advanceTimersByTimeAsync(60_000);

    await vi.waitFor(() => {
      expect(runDueNativeLoopsMock).toHaveBeenCalledWith({ userId: "user-1" });
    });
    expect(getSchedulerStatus().isRunning).toBe(true);
    expect(recoverStuckJobs).toHaveBeenCalledWith("user-1");
    expect(cleanupStuckJobs).not.toHaveBeenCalled();
  });

  it("stopping before the initial tick cancels all scans without rewriting executions",async()=>{
    vi.useFakeTimers();vi.stubEnv("ENABLE_LOCAL_SCHEDULER","true");setSchedulerUserId("user-1");
    await startLocalScheduler();await stopLocalScheduler();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runDueNativeLoopsMock).not.toHaveBeenCalled();expect(recoverStuckJobs).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();expect(db.update).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  });
  it("never scans without an explicit owner",async()=>{
    vi.useFakeTimers();vi.stubEnv("ENABLE_LOCAL_SCHEDULER","true");setSchedulerUserId(undefined);
    await startLocalScheduler();await vi.advanceTimersByTimeAsync(60_000);
    expect(recoverStuckJobs).not.toHaveBeenCalled();expect(runDueNativeLoopsMock).not.toHaveBeenCalled();
  });
  it("honors disabled before a pending first scan",async()=>{
    vi.useFakeTimers();vi.stubEnv("ENABLE_LOCAL_SCHEDULER","true");setSchedulerUserId("user-1");
    await startLocalScheduler();vi.stubEnv("ENABLE_LOCAL_SCHEDULER","false");await vi.advanceTimersByTimeAsync(60_000);
    expect(recoverStuckJobs).not.toHaveBeenCalled();expect(runDueNativeLoopsMock).not.toHaveBeenCalled();
  });

  it("allows the local scheduler in Next.js development after desktop removal", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", undefined);
    setSchedulerUserId("user-1");

    await startLocalScheduler();
    await vi.advanceTimersByTimeAsync(60_000);

    await vi.waitFor(() => {
      expect(runDueNativeLoopsMock).toHaveBeenCalledWith({ userId: "user-1" });
    });
    expect(getSchedulerStatus().isRunning).toBe(true);
  });

  it("records recovery failure and recovers on the next tick without external I/O", async () => {
    vi.useFakeTimers();
    vi.stubEnv("ENABLE_LOCAL_SCHEDULER", "true");
    recoverInterruptedMock.mockRejectedValueOnce(new Error("fixture recovery failure"));
    setSchedulerUserId("user-1");
    await startLocalScheduler();
    await vi.advanceTimersByTimeAsync(100);
    const { getLightweightSchedulerStatus } = await import("@/lib/cron/scheduler-state");
    expect(getLightweightSchedulerStatus()).toMatchObject({
      lastTickStatus: "error", lastTickError: "fixture recovery failure", isProcessing: false,
    });
    expect(runDueNativeLoopsMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runDueNativeLoopsMock).toHaveBeenCalledWith({ userId: "user-1" });
    expect(getLightweightSchedulerStatus().lastTickStatus).toBe("success");
    await stopLocalScheduler();
    expect(vi.getTimerCount()).toBe(0);
  });
});
