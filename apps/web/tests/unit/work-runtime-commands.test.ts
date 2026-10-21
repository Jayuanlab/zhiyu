import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workshop } from "@/lib/db/schema";

vi.mock("@/lib/work-runtime/database-command", () => ({
  runDatabaseWorkCommand: vi.fn((command, _type, handler) => handler(command, {db: {}, append: appendWorkshopEventMock})),
}));

const now = new Date("2026-08-03T00:00:00.000Z");
const workshop = vi.hoisted(
  () =>
    ({
      id: "work-1",
      userId: "user-1",
      name: "操盘交易员",
      mission: "管理模拟盘。",
      status: "active",
      autonomyLevel: "draft",
      boundaryPolicy: {},
      modelConfig: {},
      createdAt: new Date("2026-08-03T00:00:00.000Z"),
      updatedAt: new Date("2026-08-03T00:00:00.000Z"),
    }) as Workshop,
);
const getWorkshopMock = vi.hoisted(() => vi.fn());
const updateWorkshopMock = vi.hoisted(() => vi.fn());
const upsertWorkshopHeartbeatMock = vi.hoisted(() => vi.fn());
const appendWorkshopEventMock = vi.hoisted(() => vi.fn());
const runWorkshopLoopOnceMock = vi.hoisted(() => vi.fn());
const getLoopInWorkshopMock = vi.hoisted(() => vi.fn());
const updateLoopMock = vi.hoisted(() => vi.fn());
const computeNextLoopRunMock = vi.hoisted(() => vi.fn());
const getLoopStateMock = vi.hoisted(() => vi.fn());
const upsertLoopStateMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/workshops/boundary-policy", () => ({
  serializeWorkshopBoundaryPolicy: vi.fn((value) => ({
    ...(value && typeof value === "object" ? value : {}),
    mode: "auto",
  })),
}));

vi.mock("@/lib/workshops/service", () => ({
  getWorkshop: getWorkshopMock,
  updateWorkshop: updateWorkshopMock,
  upsertWorkshopHeartbeat: upsertWorkshopHeartbeatMock,
  appendWorkshopEvent: appendWorkshopEventMock,
  createWorkshop: vi.fn(),
  deleteWorkshop: vi.fn(),
  restoreWorkshopWorkVersion: vi.fn(),
}));

vi.mock("@/lib/workshops/loop-runtime", () => ({
  runWorkshopLoopOnce: runWorkshopLoopOnceMock,
}));

vi.mock("@/lib/workshops/runtime", () => ({
  startWorkshopRun: vi.fn(),
}));

vi.mock("@/lib/workshops/loop-service", () => ({
  activateWorkshopLoopProposal: vi.fn(),
  createWorkshopLoopFromNaturalLanguage: vi.fn(),
  createWorkshopLoopFromTemplate: vi.fn(),
  draftWorkshopLoopFromNaturalLanguage: vi.fn(),
  rejectWorkshopLoopProposal: vi.fn(),
}));

vi.mock("@/lib/loops/service", () => ({
  listLoopsForWorkshop: vi.fn(),
}));

vi.mock("@/lib/loops", () => ({
  computeNextLoopRun: computeNextLoopRunMock,
  getLoopInWorkshop: getLoopInWorkshopMock,
  getLoopState: getLoopStateMock,
  listLoopsForWorkshop: vi.fn(),
  updateLoop: updateLoopMock,
  upsertLoopState: upsertLoopStateMock,
}));

import {
  runWorkLoop,
  updateWork,
  updateWorkLoop,
} from "@/lib/work-runtime/commands";

describe("work runtime commands", () => {
  beforeEach(() => {
    getWorkshopMock.mockReset();
    getWorkshopMock.mockResolvedValue(workshop);
    updateWorkshopMock.mockReset();
    updateWorkshopMock.mockResolvedValue({
      ...workshop,
      autonomyLevel: "auto",
      updatedAt: now,
    });
    upsertWorkshopHeartbeatMock.mockReset();
    upsertWorkshopHeartbeatMock.mockResolvedValue({
      workshopId: "work-1",
      enabled: true,
      mode: "cron",
      heartbeatPolicy: {},
      nextWakeupAt: null,
      lastWakeupAt: null,
      lastHeartbeatAt: null,
      schedulerStatus: "idle",
      schedulerError: null,
      consecutiveFailures: 0,
      leaseUntil: null,
      createdAt: now,
      updatedAt: now,
    });
    appendWorkshopEventMock.mockReset();
    appendWorkshopEventMock.mockResolvedValue({ id: "event-1" });
    runWorkshopLoopOnceMock.mockReset();
    runWorkshopLoopOnceMock.mockResolvedValue({
      loop: { id: "loop-1" },
      loopRunId: "loop-run-1",
      result: { status: "success" },
      harness: { mode: "dry_run" },
      outboxDrafts: [],
    });
    getLoopInWorkshopMock.mockReset();
    getLoopInWorkshopMock.mockResolvedValue({
      id: "loop-1",
      userId: "user-1",
      workshopId: "work-1",
      name: "盘中巡检",
      status: "active",
      triggerConfig: { type: "cron", expression: "0 10 * * 1-5" },
      contextConfig: {},
      actionPolicy: {},
      verificationConfig: {},
      approvalPolicy: {},
      retryPolicy: {},
      escalationPolicy: {},
      createdAt: now,
      updatedAt: now,
    });
    updateLoopMock.mockReset();
    updateLoopMock.mockImplementation(async (_userId, _loopId, patch) => ({
      id: "loop-1",
      userId: "user-1",
      workshopId: "work-1",
      name: "盘中巡检",
      status: "active",
      triggerConfig: patch.triggerConfig,
      contextConfig: {},
      actionPolicy: {},
      verificationConfig: {},
      approvalPolicy: {},
      retryPolicy: {},
      escalationPolicy: {},
      createdAt: now,
      updatedAt: now,
    }));
    computeNextLoopRunMock.mockReset();
    computeNextLoopRunMock.mockReturnValue(
      new Date("2026-08-03T02:30:00.000Z"),
    );
    getLoopStateMock.mockReset();
    getLoopStateMock.mockResolvedValue({
      loopId: "loop-1",
      currentPhase: "idle",
      memorySummary: null,
      openQuestions: [],
      lastObservation: null,
      nextAction: null,
      blockedReason: null,
      stateJson: { workshopId: "work-1" },
      updatedAt: now,
    });
    upsertLoopStateMock.mockReset();
    upsertLoopStateMock.mockResolvedValue({});
  });

  it("updates Work through one audited command interface", async () => {
    const result = await updateWork({
      userId: "user-1",
      workId: "work-1",
      commandId: "cmd-1",
      source: "chat_agent",
      reason: "Owner asked the chat agent to tighten autonomy.",
      patch: {
        name: "操盘交易员",
        autonomyLevel: "auto",
        boundaryPolicy: { mode: "auto" },
        heartbeat: {
          enabled: true,
          mode: "cron",
          heartbeatPolicy: { minIntervalMinutes: 30 },
        },
      },
    });

    expect(result.workshop.autonomyLevel).toBe("auto");
    expect(updateWorkshopMock).toHaveBeenCalledWith(
      "user-1",
      "work-1",
      expect.objectContaining({
        name: "操盘交易员",
        autonomyLevel: "auto",
        boundaryPolicy: expect.objectContaining({ mode: "auto" }),
        changeSource: "chat_agent",
      }),
      expect.objectContaining({db: {}, append: appendWorkshopEventMock}),
    );
    expect(upsertWorkshopHeartbeatMock).toHaveBeenCalledWith(
      "work-1",
      expect.objectContaining({
        enabled: true,
        mode: "cron",
      }),
      expect.objectContaining({db: {}, append: appendWorkshopEventMock}),
    );
    expect(appendWorkshopEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "work-1",
        type: "work_command_applied",
        metadata: expect.objectContaining({
          command: "updateWork",
          commandId: "cmd-1",
          source: "chat_agent",
        }),
      }),
    );
  });

  it("runs Loop only through its owning Work", async () => {
    await runWorkLoop({
      userId: "user-1",
      workId: "work-1",
      loopId: "loop-1",
      commandId: "cmd-run",
      source: "owner",
      dryRun: true,
    });

    expect(getWorkshopMock).toHaveBeenCalledWith("user-1", "work-1");
    expect(runWorkshopLoopOnceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        workshopId: "work-1",
        loopId: "loop-1",
        mode: "dry_run",
        triggeredBy: "manual",
        createOutboxDrafts: false,
        reason: expect.objectContaining({
          source: "work_runtime",
          command: "runWorkLoop",
          commandMeta: expect.objectContaining({
            commandId: "cmd-run",
          }),
        }),
      }),
    );
  });

  it("updates a Work-owned Loop in place and refreshes scheduler state", async () => {
    const result = await updateWorkLoop({
      userId: "user-1",
      workId: "work-1",
      loopId: "loop-1",
      commandId: "cmd-loop-update",
      source: "chat_agent",
      reason: "把盘中巡检改到 10:30。",
      patch: {
        triggerConfig: {
          type: "cron",
          expression: "30 10 * * 1-5",
          timezone: "Asia/Shanghai",
        },
      },
    });

    expect(result.nextScheduledRunAt).toBe("2026-08-03T02:30:00.000Z");
    expect(result.receiptSemantics.scheduleUpdate).toEqual({
      status: "recomputed", nextScheduledRunAt: "2026-08-03T02:30:00.000Z",
    });
    expect(getLoopInWorkshopMock).toHaveBeenCalledWith({
      userId: "user-1",
      workshopId: "work-1",
      loopId: "loop-1",
    }, {});
    expect(updateLoopMock).toHaveBeenCalledWith(
      "user-1",
      "loop-1",
      expect.objectContaining({
        triggerConfig: expect.objectContaining({
          expression: "30 10 * * 1-5",
        }),
      }),
      {},
    );
    expect(upsertLoopStateMock).toHaveBeenCalledWith(
      "loop-1",
      expect.objectContaining({
        stateJson: expect.objectContaining({
          workshopId: "work-1",
          nextScheduledRunAt: "2026-08-03T02:30:00.000Z",
          schedulerStatus: "idle",
        }),
      }),
      {},
    );
    expect(appendWorkshopEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "work-1",
        loopId: "loop-1",
        type: "work_command_applied",
        metadata: expect.objectContaining({
          command: "updateWorkLoop",
          commandId: "cmd-loop-update",
          source: "chat_agent",
        }),
      }),
    );
  });

  it.each(["paused", "active", "archived"] as const)(
    "does not turn an uncomputed %s status update into a null schedule fact",
    async status => {
      const priorState = { stateJson: { nextScheduledRunAt: "2026-08-03T03:00:00.000Z", ownerNote: "keep" } };
      getLoopStateMock.mockResolvedValue(priorState);
      updateLoopMock.mockResolvedValue({ id: "loop-1", name: "Loop", status });
      const result = await updateWorkLoop({
        userId: "user-1", workId: "work-1", loopId: "loop-1", source: "owner",
        commandId: `status-${status}`, patch: { status },
      });
      expect(result).not.toHaveProperty("nextScheduledRunAt");
      expect(result.receiptSemantics).toMatchObject({
        scheduleUpdate: { status: "not_recomputed" },
        futureAdmissionObservation: "not_observed_by_this_command",
        inFlightCancellation: "not_requested_by_this_command",
        historyDeletion: "not_requested_by_this_command",
      });
      expect(result.receiptSemantics.scheduleUpdate).not.toHaveProperty("nextScheduledRunAt");
      expect(computeNextLoopRunMock).not.toHaveBeenCalled();
      expect(getLoopStateMock).not.toHaveBeenCalled();
      expect(upsertLoopStateMock).not.toHaveBeenCalled();
      expect(runWorkshopLoopOnceMock).not.toHaveBeenCalled();
      expect(priorState.stateJson.nextScheduledRunAt).toBe("2026-08-03T03:00:00.000Z");
      const event = appendWorkshopEventMock.mock.calls[0][0];
      expect(event.metadata).not.toHaveProperty("nextScheduledRunAt");
      expect(event.metadata.receiptSemantics).toEqual(result.receiptSemantics);
    },
  );

  it("preserves a genuinely recomputed null schedule for a manual trigger", async () => {
    computeNextLoopRunMock.mockReturnValue(null);
    const result = await updateWorkLoop({
      userId: "user-1", workId: "work-1", loopId: "loop-1", source: "owner",
      commandId: "manual-trigger", patch: { triggerConfig: { type: "manual" } },
    });
    expect(result).toHaveProperty("nextScheduledRunAt", null);
    expect(result.receiptSemantics.scheduleUpdate).toEqual({ status: "recomputed", nextScheduledRunAt: null });
    expect(upsertLoopStateMock.mock.calls[0][1].stateJson).toHaveProperty("nextScheduledRunAt", null);
    expect(appendWorkshopEventMock.mock.calls[0][0].metadata).toHaveProperty("nextScheduledRunAt", null);
    expect(result.receiptSemantics.futureAdmissionObservation).toBe("not_observed_by_this_command");
  });

  it("does not write or claim an update for a missing or foreign owned Loop", async () => {
    getLoopInWorkshopMock.mockResolvedValue(null);
    await expect(updateWorkLoop({
      userId: "user-1", workId: "work-1", loopId: "foreign-loop", source: "owner",
      commandId: "foreign-status", patch: { status: "paused" },
    })).rejects.toMatchObject({ code: "not_found" });
    expect(updateLoopMock).not.toHaveBeenCalled();
    expect(upsertLoopStateMock).not.toHaveBeenCalled();
    expect(appendWorkshopEventMock).not.toHaveBeenCalled();
  });

  it("does not emit a successful receipt when the configuration write fails", async () => {
    updateLoopMock.mockRejectedValue(new Error("write unavailable"));
    await expect(updateWorkLoop({
      userId: "user-1", workId: "work-1", loopId: "loop-1", source: "owner",
      commandId: "failed-status", patch: { status: "paused" },
    })).rejects.toThrow("write unavailable");
    expect(upsertLoopStateMock).not.toHaveBeenCalled();
    expect(appendWorkshopEventMock).not.toHaveBeenCalled();
  });

  it('validates an explicit checkpoint contract in the versioned Loop update while preserving all other verification fields', async () => {
    const verificationConfig = { type: 'structured_check', requiredFields: ['summary'], legacyMetadata: { retained: true },
      workingMemoryCheckpoint: { required: true, requireFreshSource: true } };
    const command = { userId: 'user-1', workId: 'work-1', loopId: 'loop-1', commandId: 'enable-checkpoint-v1',
      expectedVersion: 7, source: 'owner' as const, patch: { verificationConfig } };
    const before = structuredClone(command);
    const result = await updateWorkLoop(command);
    expect(updateLoopMock).toHaveBeenCalledExactlyOnceWith('user-1', 'loop-1', { verificationConfig }, {});
    expect(getLoopInWorkshopMock).toHaveBeenCalledWith({ userId: 'user-1', workshopId: 'work-1', loopId: 'loop-1' }, {});
    expect(appendWorkshopEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'work_command_applied',
      metadata: expect.objectContaining({ command: 'updateWorkLoop', commandId: 'enable-checkpoint-v1', updatedFields: ['verificationConfig'] }) }));
    expect(result.receiptSemantics.scheduleUpdate.status).toBe('not_recomputed');
    expect(computeNextLoopRunMock).not.toHaveBeenCalled();
    expect(command).toEqual(before);
  });

  it.each([null, [], 'invalid', { workingMemoryCheckpoint: false }, { workingMemoryCheckpoint: null },
    { workingMemoryCheckpoint: undefined }, { workingMemoryCheckpoint: {} },
    { workingMemoryCheckpoint: { required: false } }, { workingMemoryCheckpoint: { required: 'true' } },
    { workingMemoryCheckpoint: { required: true, requireFreshSource: 'true' } },
    { workingMemoryCheckpoint: { required: true, extra: true } }].map(verificationConfig => ({ verificationConfig })))('rejects invalid checkpoint configuration before any mutation or success audit: %j', ({ verificationConfig }) => {
    return expect(updateWorkLoop({ userId: 'user-1', workId: 'work-1', loopId: 'loop-1', commandId: 'invalid-checkpoint-v1',
      expectedVersion: 7, source: 'owner', patch: { verificationConfig: verificationConfig as unknown as Record<string, unknown> } }))
      .rejects.toMatchObject({ code: 'invalid_command' }).then(() => {
        expect(updateLoopMock).not.toHaveBeenCalled();
        expect(appendWorkshopEventMock).not.toHaveBeenCalled();
      });
  });
});
