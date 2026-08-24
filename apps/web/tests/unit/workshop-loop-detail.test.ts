import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Loop,
  LoopApprovalRequest,
  LoopRun,
  LoopState,
  WorkshopEvent,
  WorkshopOutboxItem,
} from "@/lib/db/schema";

const now = new Date("2026-07-06T00:00:00.000Z");
const later = new Date("2026-07-06T00:05:00.000Z");

const getLoopInWorkshopMock = vi.hoisted(() => vi.fn());
const getLoopStateMock = vi.hoisted(() => vi.fn());
const listLoopApprovalRequestsMock = vi.hoisted(() => vi.fn());
const listLoopRunsMock = vi.hoisted(() => vi.fn());
const listWorkshopEventsMock = vi.hoisted(() => vi.fn());
const listWorkshopOutboxMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/loops/service", () => ({
  getLoopInWorkshop: getLoopInWorkshopMock,
  getLoopState: getLoopStateMock,
  listLoopApprovalRequests: listLoopApprovalRequestsMock,
  listLoopRuns: listLoopRunsMock,
}));

vi.mock("@/lib/workshops/service", () => ({
  listWorkshopEvents: listWorkshopEventsMock,
  listWorkshopOutbox: listWorkshopOutboxMock,
}));

import {
  getWorkshopLoopDetail,
  selectWorkshopLoopEvents,
  selectWorkshopLoopOutbox,
} from "@/lib/workshops/loop-detail";

function loop(overrides: Partial<Loop> = {}): Loop {
  return {
    id: "loop-1",
    userId: "user-1",
    workshopId: "workshop-1",
    name: "Daily monitor",
    description: "Track signals",
    goal: "Prepare a daily brief",
    status: "active",
    triggerConfig: { type: "manual" },
    contextConfig: {},
    actionPolicy: {},
    verificationConfig: {},
    approvalPolicy: {},
    retryPolicy: {},
    escalationPolicy: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Loop;
}

function state(overrides: Partial<LoopState> = {}): LoopState {
  return {
    loopId: "loop-1",
    currentPhase: "idle",
    memorySummary: null,
    openQuestions: [],
    lastObservation: null,
    nextAction: null,
    blockedReason: null,
    stateJson: {},
    updatedAt: now,
    ...overrides,
  } as LoopState;
}

function run(overrides: Partial<LoopRun> = {}): LoopRun {
  return {
    id: "loop-run-1",
    loopId: "loop-1",
    status: "completed",
    triggerReason: {},
    startedAt: now,
    completedAt: later,
    inputSnapshot: {},
    outputSummary: "Done",
    verificationResult: { passed: true },
    error: null,
    createdAt: now,
    updatedAt: later,
    ...overrides,
  } as LoopRun;
}

function event(overrides: Partial<WorkshopEvent> = {}): WorkshopEvent {
  return {
    id: "event-1",
    workshopId: "workshop-1",
    runId: null,
    loopId: "loop-1",
    loopRunId: "loop-run-1",
    seq: 1,
    type: "loop_run_completed",
    title: "Loop finished",
    body: "Done",
    metadata: {},
    visibility: "user",
    createdAt: now,
    ...overrides,
  } as WorkshopEvent;
}

function outbox(
  overrides: Partial<WorkshopOutboxItem> = {},
): WorkshopOutboxItem {
  return {
    id: "outbox-1",
    workshopId: "workshop-1",
    runId: null,
    channel: "wechat_desktop",
    recipientName: "File Transfer",
    message: "Please review this draft.",
    status: "draft",
    confidence: 80,
    riskLevel: "low",
    sourceEventIds: [],
    boundaryResult: {},
    sentAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as WorkshopOutboxItem;
}

function approval(
  overrides: Partial<LoopApprovalRequest> = {},
): LoopApprovalRequest {
  return {
    id: "approval-1",
    loopId: "loop-1",
    loopRunId: "loop-run-1",
    userId: "user-1",
    status: "pending",
    source: "tool_gate",
    actionName: "send_message",
    capability: "external_write",
    reason: "Needs owner approval",
    message: null,
    toolInput: {},
    actionPayload: {},
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as LoopApprovalRequest;
}

describe("workshop loop detail", () => {
  beforeEach(() => {
    getLoopInWorkshopMock.mockReset();
    getLoopStateMock.mockReset();
    listLoopApprovalRequestsMock.mockReset();
    listLoopRunsMock.mockReset();
    listWorkshopEventsMock.mockReset();
    listWorkshopOutboxMock.mockReset();
  });

  it("selects loop events by loop id, metadata loop id, and loop run id", () => {
    const selected = selectWorkshopLoopEvents({
      loopId: "loop-1",
      loopRunIds: new Set(["loop-run-1"]),
      events: [
        event({ id: "other", loopId: "loop-2", loopRunId: null }),
        event({
          id: "metadata-loop",
          loopId: null,
          loopRunId: null,
          metadata: { loopId: "loop-1" },
          seq: 2,
        }),
        event({
          id: "run-linked",
          loopId: null,
          loopRunId: "loop-run-1",
          seq: 3,
        }),
      ],
    });

    expect(selected.map((item) => item.id)).toEqual([
      "run-linked",
      "metadata-loop",
    ]);
  });

  it("links outbox items through loop events and source event ids", () => {
    const loopEvents = [
      event({ id: "event-1", metadata: { outboxId: "outbox-1" } }),
      event({ id: "event-2", seq: 2 }),
    ];

    const selected = selectWorkshopLoopOutbox({
      loopEvents,
      outbox: [
        outbox({ id: "outbox-1" }),
        outbox({
          id: "outbox-2",
          sourceEventIds: ["event-2"],
          createdAt: later,
        }),
        outbox({ id: "other", sourceEventIds: ["other-event"] }),
      ],
    });

    expect(selected.map((item) => item.id)).toEqual(["outbox-2", "outbox-1"]);
  });

  it("loads a workshop-scoped loop detail with approvals and linked outbox", async () => {
    getLoopInWorkshopMock.mockResolvedValue(loop());
    getLoopStateMock.mockResolvedValue(state());
    listLoopRunsMock.mockResolvedValue([run()]);
    listLoopApprovalRequestsMock.mockResolvedValue([approval()]);
    listWorkshopEventsMock.mockResolvedValue([
      event({
        metadata: {
          outboxId: "outbox-1",
          memoryRecall: {
            backend: "brain",
            contextLogId: "ctx-1",
            recallPlan: {
              routes: [{ route: "brain_memory", purpose: "canonical" }],
            },
            explanation: {
              selectedCount: 2,
              deniedCount: 0,
            },
            contextPack: {
              interfaceVersion: "brain-context-trace.v1",
              selected: [
                {
                  id: "memory-1",
                  subject: "Risk boundary",
                  reasons: ["type:boundary"],
                },
              ],
              omitted: [{ id: "memory-2", reason: "duplicate_canonical_group" }],
              denied: [],
            },
          },
        },
      }),
      event({ id: "other", loopId: "loop-2", loopRunId: null }),
    ]);
    listWorkshopOutboxMock.mockResolvedValue([outbox()]);

    const detail = await getWorkshopLoopDetail({
      userId: "user-1",
      workshopId: "workshop-1",
      loopId: "loop-1",
    });

    expect(getLoopInWorkshopMock).toHaveBeenCalledWith({
      userId: "user-1",
      workshopId: "workshop-1",
      loopId: "loop-1",
    });
    expect(listLoopApprovalRequestsMock).toHaveBeenCalledWith("user-1", {
      loopId: "loop-1",
      limit: 100,
    });
    expect(detail?.loop.runs).toHaveLength(1);
    expect(detail?.approvalRequests).toHaveLength(1);
    expect(detail?.events.map((item) => item.id)).toEqual(["event-1"]);
    expect(detail?.memoryRecall).toEqual([
      expect.objectContaining({
        eventId: "event-1",
        backend: "brain",
        contextLogId: "ctx-1",
        explanation: expect.objectContaining({ selectedCount: 2 }),
        contextPack: expect.objectContaining({
          selected: [
            expect.objectContaining({
              id: "memory-1",
              subject: "Risk boundary",
            }),
          ],
          omitted: [
            { id: "memory-2", reason: "duplicate_canonical_group" },
          ],
        }),
      }),
    ]);
    expect(detail?.outbox.map((item) => item.id)).toEqual(["outbox-1"]);
  });

  it("returns null when the loop is not in the requested workshop", async () => {
    getLoopInWorkshopMock.mockResolvedValue(null);

    await expect(
      getWorkshopLoopDetail({
        userId: "user-1",
        workshopId: "workshop-1",
        loopId: "missing-loop",
      }),
    ).resolves.toBeNull();

    expect(listLoopRunsMock).not.toHaveBeenCalled();
  });
});
