import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Loop, LoopState, Workshop } from "@/lib/db/schema";

const now = new Date("2026-07-06T00:00:00.000Z");

const workshops = vi.hoisted(() => new Map<string, Workshop>());
const loopRef = vi.hoisted(() => ({ current: null as Loop | null }));
const stateRef = vi.hoisted(() => ({ current: null as LoopState | null }));
const events = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const createLoopMock = vi.hoisted(() => vi.fn());
const createLoopFromTemplateMock = vi.hoisted(() => vi.fn());
const createLoopFromNaturalLanguageMock = vi.hoisted(() => vi.fn());
const draftLoopFromNaturalLanguageMock = vi.hoisted(() => vi.fn());
const loopSpecToCreateLoopInputMock = vi.hoisted(() => vi.fn());
const computeNextLoopRunMock = vi.hoisted(() => vi.fn());
const getLoopInWorkshopMock = vi.hoisted(() => vi.fn());
const getLoopStateMock = vi.hoisted(() => vi.fn());
const listLoopsForWorkshopMock = vi.hoisted(() => vi.fn());
const updateLoopMock = vi.hoisted(() => vi.fn());
const upsertLoopStateMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/work-runtime/database-command", () => ({
  runPreparedDatabaseWorkCommand: async (command: unknown, _type: string, prepare: any, apply: any) =>
    apply(command, await prepare(command), {db: {execute: vi.fn(async () => [{id: "run-1"}])}, append: async (event: Record<string, unknown>) => {events.push(event);return event;}}),
}));

vi.mock("@/lib/loops", () => ({
  computeNextLoopRun: computeNextLoopRunMock,
  createLoop: createLoopMock,
  createLoopFromTemplate: createLoopFromTemplateMock,
  draftLoopFromNaturalLanguage: draftLoopFromNaturalLanguageMock,
  createLoopFromNaturalLanguage: createLoopFromNaturalLanguageMock,
  getLoopInWorkshop: getLoopInWorkshopMock,
  getLoopState: getLoopStateMock,
  listLoopsForWorkshop: listLoopsForWorkshopMock,
  loopSpecToCreateLoopInput: loopSpecToCreateLoopInputMock,
  updateLoop: updateLoopMock,
  upsertLoopState: upsertLoopStateMock,
  WORK_SELF_AUDIT_TEMPLATE_ID: "work-self-audit",
}));

vi.mock("@/lib/workshops/service", () => ({
  getWorkshop: vi.fn(async (userId: string, workshopId: string) => {
    const workshop = workshops.get(workshopId);
    return workshop?.userId === userId ? workshop : null;
  }),
  appendWorkshopEvent: vi.fn(async (input: Record<string, unknown>) => {
    events.push(input);
    return {
      id: `event-${events.length}`,
      seq: events.length,
      createdAt: now,
      ...input,
    };
  }),
}));

import {
  activateWorkshopLoopProposal,
  ensureWorkshopWorkSelfAuditLoop,
  proposeWorkshopLoopFromNaturalLanguage,
  rejectWorkshopLoopProposal,
} from "@/lib/workshops/loop-service";

function workshop(overrides: Partial<Workshop> = {}): Workshop {
  return {
    id: "workshop-1",
    userId: "user-1",
    name: "Workshop",
    mission: "Watch market signals",
    status: "active",
    autonomyLevel: "draft",
    boundaryPolicy: {},
    modelConfig: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Workshop;
}

function loop(overrides: Partial<Loop> = {}): Loop {
  return {
    id: "loop-1",
    userId: "user-1",
    workshopId: "workshop-1",
    name: "Daily signal monitor",
    description: "Review signals every morning.",
    goal: "Prepare a morning market signal brief.",
    status: "active",
    triggerConfig: { type: "cron", expression: "0 9 * * *" },
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

function loopState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    loopId: "loop-1",
    currentPhase: "approval",
    memorySummary: null,
    openQuestions: [],
    lastObservation: "Workshop agent proposed this task.",
    nextAction: "Owner should review and activate this task if useful.",
    blockedReason: "Awaiting owner activation before scheduling.",
    stateJson: {
      workshopId: "workshop-1",
      requiresOwnerActivation: true,
      ownerActivationStatus: "pending",
    },
    updatedAt: now,
    ...overrides,
  } as LoopState;
}

const draft = {
  name: "Daily signal monitor",
  description: "Review signals every morning.",
  spec: {},
  planner: {
    agent: "natural-language-planner",
    model: "test",
    parser: "local_rules",
  },
  extracted: {
    scheduleLabel: "Every day at 09:00",
    timezone: "Asia/Shanghai",
    externalWriteMode: "manual_approval",
    missingFields: [],
  },
};

describe("workshop loop service", () => {
  beforeEach(() => {
    workshops.clear();
    workshops.set("workshop-1", workshop());
    loopRef.current = loop();
    stateRef.current = loopState();
    events.length = 0;
    createLoopFromNaturalLanguageMock.mockReset();
    createLoopFromTemplateMock.mockReset();
    createLoopFromTemplateMock.mockImplementation(async (input) =>
      loop({
        id: "work-self-audit-loop",
        name: "Work 自检升级",
        goal: "Run a closed-loop Work self-audit.",
        triggerConfig: { type: "cron", expression: "0 3 * * *" },
        ...input,
      }),
    );
    listLoopsForWorkshopMock.mockReset();
    listLoopsForWorkshopMock.mockResolvedValue([]);
    draftLoopFromNaturalLanguageMock.mockReset();
    draftLoopFromNaturalLanguageMock.mockResolvedValue(draft);
    loopSpecToCreateLoopInputMock.mockReset();
    loopSpecToCreateLoopInputMock.mockReturnValue({
      userId: "user-1",
      workshopId: "workshop-1",
      name: "Daily signal monitor",
      description: "Review signals every morning.",
      goal: "Prepare a morning market signal brief.",
      status: "active",
      triggerConfig: { type: "cron", expression: "0 9 * * *" },
      contextConfig: {},
      actionPolicy: {},
      verificationConfig: {},
      approvalPolicy: {},
      retryPolicy: {},
      escalationPolicy: {},
      initialState: {
        currentPhase: "idle",
        stateJson: {
          existing: true,
          workshopId: "workshop-1",
        },
      },
    });
    createLoopMock.mockReset();
    createLoopMock.mockImplementation(async (input) => ({
      ...loopRef.current,
      ...input,
      updatedAt: now,
    }));
    computeNextLoopRunMock.mockReset();
    computeNextLoopRunMock.mockReturnValue(
      new Date("2026-07-06T01:00:00.000Z"),
    );
    getLoopInWorkshopMock.mockReset();
    getLoopInWorkshopMock.mockImplementation(async () => loopRef.current);
    getLoopStateMock.mockReset();
    getLoopStateMock.mockImplementation(async () => stateRef.current);
    updateLoopMock.mockReset();
    updateLoopMock.mockImplementation(async (_userId, _loopId, updates) => ({
      ...loopRef.current,
      ...updates,
      updatedAt: now,
    }));
    upsertLoopStateMock.mockReset();
    upsertLoopStateMock.mockImplementation(async (_loopId, input) => ({
      ...stateRef.current,
      ...input,
      stateJson: {
        ...((stateRef.current?.stateJson as Record<string, unknown>) ?? {}),
        ...((input.stateJson as Record<string, unknown>) ?? {}),
      },
      updatedAt: now,
    }));
  });

  it("creates workshop agent loop proposals as paused tasks awaiting owner activation", async () => {
    const result = await proposeWorkshopLoopFromNaturalLanguage({
      userId: "user-1",
      workshopId: "workshop-1",
      runId: "run-1",
      intent:
        "Every weekday at 09:00, review market signals and draft a brief if there is a material change.",
      timezone: "Asia/Shanghai",
      proposalReason: "The owner asked for continuous monitoring.",
    });

    expect(result.loop.status).toBe("paused");
    expect(draftLoopFromNaturalLanguageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        workshopId: "workshop-1",
        timezone: "Asia/Shanghai",
        externalWriteMode: "manual_approval",
      }),
    );
    expect(createLoopFromNaturalLanguageMock).not.toHaveBeenCalled();
    expect(createLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "paused",
        initialState: expect.objectContaining({
          currentPhase: "approval",
          stateJson: expect.objectContaining({
            existing: true,
            workshopId: "workshop-1",
            proposedBy: "workshop_agent",
            proposedFromRunId: "run-1",
            proposalReason: "The owner asked for continuous monitoring.",
            requiresOwnerActivation: true,
            ownerActivationStatus: "pending",
          }),
        }),
      }),
      expect.objectContaining({execute: expect.any(Function)}),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      workshopId: "workshop-1",
      runId: "run-1",
      loopId: "loop-1",
      type: "loop_proposed",
      metadata: {
        loopId: "loop-1",
        source: "workshop_agent",
        status: "paused",
        requiresOwnerActivation: true,
        proposalReason: "The owner asked for continuous monitoring.",
      },
    });
  });

  it("ensures the Work self-audit loop without creating duplicates", async () => {
    const created = await ensureWorkshopWorkSelfAuditLoop({
      userId: "user-1",
      workshopId: "workshop-1",
    });

    expect(created.created).toBe(true);
    expect(createLoopFromTemplateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        workshopId: "workshop-1",
        templateId: "work-self-audit",
        timezone: "Asia/Shanghai",
      }),
      undefined,
    );
    expect(events.at(-1)).toMatchObject({
      type: "work_upgrade_loop_ready",
      loopId: "work-self-audit-loop",
    });

    listLoopsForWorkshopMock.mockResolvedValue([
      loop({
        id: "existing-loop",
        name: "Work 自检升级",
        status: "active",
      }),
    ]);
    const existing = await ensureWorkshopWorkSelfAuditLoop({
      userId: "user-1",
      workshopId: "workshop-1",
    });

    expect(existing.created).toBe(false);
    expect(existing.loop.id).toBe("existing-loop");
    expect(createLoopFromTemplateMock).toHaveBeenCalledTimes(1);
  });

  it("rejects proposals for workshops the user cannot access", async () => {
    await expect(
      proposeWorkshopLoopFromNaturalLanguage({
        userId: "user-2",
        workshopId: "workshop-1",
        intent: "Check something every hour.",
      }),
    ).rejects.toThrow("Workshop not found");

    expect(createLoopFromNaturalLanguageMock).not.toHaveBeenCalled();
    expect(createLoopMock).not.toHaveBeenCalled();
  });

  it("activates pending loop proposals and initializes scheduler state", async () => {
    const result = await activateWorkshopLoopProposal({
      userId: "user-1",
      workshopId: "workshop-1",
      loopId: "loop-1",
    });

    expect(result.status).toBe("active");
    expect(updateLoopMock).toHaveBeenCalledWith("user-1", "loop-1", {
      status: "active",
    }, undefined);
    expect(upsertLoopStateMock).toHaveBeenCalledWith(
      "loop-1",
      expect.objectContaining({
        currentPhase: "idle",
        blockedReason: null,
        stateJson: expect.objectContaining({
          requiresOwnerActivation: false,
          ownerActivationStatus: "activated",
          ownerActivatedBy: "owner",
          nextScheduledRunAt: "2026-07-06T01:00:00.000Z",
          schedulerStatus: "idle",
        }),
      }),
      undefined,
    );
    expect(events.at(-1)).toMatchObject({
      type: "loop_activated",
      loopId: "loop-1",
    });
  });

  it("rejects pending loop proposals by archiving them", async () => {
    const result = await rejectWorkshopLoopProposal({
      userId: "user-1",
      workshopId: "workshop-1",
      loopId: "loop-1",
      reason: "Too broad",
    });

    expect(result.status).toBe("archived");
    expect(updateLoopMock).toHaveBeenCalledWith("user-1", "loop-1", {
      status: "archived",
    }, undefined);
    expect(upsertLoopStateMock).toHaveBeenCalledWith(
      "loop-1",
      expect.objectContaining({
        currentPhase: "rejected",
        blockedReason: "Too broad",
        stateJson: expect.objectContaining({
          requiresOwnerActivation: false,
          ownerActivationStatus: "rejected",
            ownerRejectionReason: "Too broad",
        }),
      }),
      undefined,
    );
    expect(events.at(-1)).toMatchObject({
      type: "loop_rejected",
      loopId: "loop-1",
    });
  });

  it("does not fabricate an activation when the database update finds no Loop", async () => {
    updateLoopMock.mockResolvedValueOnce(null);
    await expect(activateWorkshopLoopProposal({userId: "user-1", workshopId: "workshop-1", loopId: "loop-1"})).rejects.toMatchObject({code:"not_found"});
    expect(upsertLoopStateMock).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });
});
