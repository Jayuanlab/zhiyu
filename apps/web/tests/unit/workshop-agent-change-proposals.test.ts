import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workshop, WorkshopEvent } from "@/lib/db/schema";

const now = new Date("2026-07-31T00:00:00.000Z");
const workshopRef = vi.hoisted(() => ({ current: null as Workshop | null }));
const eventRef = vi.hoisted(() => ({ current: null as WorkshopEvent | null }));
const events = vi.hoisted(() => [] as WorkshopEvent[]);
const updateWorkshopMock = vi.hoisted(() => vi.fn());
const createWorkVersionMock = vi.hoisted(() => vi.fn());
const upsertReviewItemMock = vi.hoisted(() => vi.fn());
const resolveReviewItemMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/workshops/service", () => ({
  getWorkshop: vi.fn(async (_userId: string, workshopId: string) =>
    workshopRef.current?.id === workshopId ? workshopRef.current : null,
  ),
  getWorkshopEvent: vi.fn(async (_workshopId: string, eventId: string) =>
    eventRef.current?.id === eventId ? eventRef.current : null,
  ),
  listWorkshopEvents: vi.fn(async () => events),
  updateWorkshop: updateWorkshopMock,
  createWorkshopWorkVersionSnapshot: createWorkVersionMock,
  appendWorkshopEvent: vi.fn(async (input: Record<string, unknown>) => {
    const event = {
      id: `event-${events.length + 1}`,
      workshopId: input.workshopId,
      runId: null,
      loopId: null,
      loopRunId: null,
      seq: events.length + 1,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      metadata: input.metadata ?? {},
      visibility: "user",
      createdAt: now,
    } as WorkshopEvent;
    events.push(event);
    return event;
  }),
}));

vi.mock("@/lib/workshops/review-items", () => ({
  upsertWorkshopReviewItemFromProposalEvent: upsertReviewItemMock,
  resolveWorkshopReviewItemBySourceEvent: resolveReviewItemMock,
}));

import {
  proposeWorkshopAgentChange,
  resolveWorkshopAgentChangeProposal,
  summarizeWorkshopAgentChange,
  WorkshopAgentChangeStaleProposalError,
} from "@/lib/workshops/agent-change-proposals";

function workshop(overrides: Partial<Workshop> = {}): Workshop {
  return {
    id: "workshop-1",
    userId: "user-1",
    name: "old agent",
    mission: "old mission",
    status: "active",
    autonomyLevel: "draft",
    boundaryPolicy: { mode: "draft" },
    modelConfig: { allowedTools: ["aStockQuote"] },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Workshop;
}

describe("workshop agent change proposals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    events.length = 0;
    workshopRef.current = workshop();
    eventRef.current = null;
    updateWorkshopMock.mockImplementation(async (_userId, _workshopId, patch) =>
      workshop({ ...patch, updatedAt: now }),
    );
    upsertReviewItemMock.mockResolvedValue(null);
    resolveReviewItemMock.mockResolvedValue(null);
    createWorkVersionMock.mockImplementation(
      async (input: {
        workshop: Workshop;
        version?: string;
        source?: string;
        changeEventId?: string | null;
        patch?: Record<string, unknown>;
        createdBy?: string;
      }) => ({
      id: `version-${events.length}`,
      workshopId: input.workshop.id,
      version: input.version ?? input.workshop.modelConfig?.workVersion,
      source: input.source ?? "manual_update",
      changeEventId: input.changeEventId ?? null,
      snapshot: input.workshop,
      patch: input.patch ?? {},
      createdBy: input.createdBy ?? "system",
      createdAt: now,
      }),
    );
  });

  it("summarizes a narrow workshop configuration diff", () => {
    const summary = summarizeWorkshopAgentChange({
      workshop: workshopRef.current!,
      patch: {
        modelConfig: {
          primarySkills: ["paper-trading-pre-market-plan"],
        },
      },
    });

    expect(summary.changedFields).toEqual(["modelConfig"]);
    expect(summary.riskLevel).toBe("medium");
    expect(summary.patch.modelConfig).toEqual({
      allowedTools: ["aStockQuote"],
      primarySkills: ["paper-trading-pre-market-plan"],
    });
  });

  it("creates and applies an owner-reviewable configuration proposal", async () => {
    const proposal = await proposeWorkshopAgentChange({
      userId: "user-1",
      workshopId: "workshop-1",
      reason: "add market news as a reference input",
      patch: {
        mission: "use market news as a secondary reference",
      },
    });
    eventRef.current = proposal;

    const result = await resolveWorkshopAgentChangeProposal({
      userId: "user-1",
      workshopId: "workshop-1",
      proposalEventId: proposal.id,
      action: "apply",
      reason: "approved",
    });

    expect(proposal.type).toBe("workshop_agent_change_proposed");
    expect(proposal.metadata?.status).toBe("pending_approval");
    expect(proposal.metadata?.requestedPatch).toEqual({
      mission: "use market news as a secondary reference",
    });
    expect(proposal.metadata?.workModelVersion).toBe(now.toISOString());
    expect(updateWorkshopMock).toHaveBeenCalledWith("user-1", "workshop-1", {
      mission: "use market news as a secondary reference",
      modelConfig: {
        allowedTools: ["aStockQuote"],
        workVersion: expect.any(String),
      },
      recordWorkVersion: false,
    });
    expect(result.status).toBe("applied");
    expect(events.at(-1)?.type).toBe("workshop_agent_change_applied");
    expect(events.at(-1)?.metadata?.workVersionBefore).toBe(now.toISOString());
    expect(events.at(-1)?.metadata?.workVersionAfter).toEqual(
      expect.any(String),
    );
    expect(events.at(-1)?.metadata?.proposalEventId).toBe(proposal.id);
    expect(createWorkVersionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workshop: result.workshop,
        source: "agent_change_apply",
        changeEventId: events.at(-1)?.id,
      }),
    );
  });

  it("rejects applying a stale proposal when the Work version changed", async () => {
    const proposal = await proposeWorkshopAgentChange({
      userId: "user-1",
      workshopId: "workshop-1",
      reason: "change mission",
      patch: {
        mission: "new mission",
      },
    });
    eventRef.current = proposal;
    workshopRef.current = workshop({
      mission: "changed by another proposal",
      modelConfig: {
        allowedTools: ["aStockQuote"],
        workVersion: "2026-08-01T00:00:00.000Z",
      },
    });

    await expect(
      resolveWorkshopAgentChangeProposal({
        userId: "user-1",
        workshopId: "workshop-1",
        proposalEventId: proposal.id,
        action: "apply",
      }),
    ).rejects.toThrow(WorkshopAgentChangeStaleProposalError);
    expect(updateWorkshopMock).not.toHaveBeenCalled();
  });

  it("allows rejecting a stale proposal without changing the Work", async () => {
    const proposal = await proposeWorkshopAgentChange({
      userId: "user-1",
      workshopId: "workshop-1",
      reason: "change mission",
      patch: {
        mission: "new mission",
      },
    });
    eventRef.current = proposal;
    workshopRef.current = workshop({
      modelConfig: {
        allowedTools: ["aStockQuote"],
        workVersion: "2026-08-01T00:00:00.000Z",
      },
    });

    const result = await resolveWorkshopAgentChangeProposal({
      userId: "user-1",
      workshopId: "workshop-1",
      proposalEventId: proposal.id,
      action: "reject",
      reason: "not needed",
    });

    expect(result.status).toBe("rejected");
    expect(events.at(-1)?.type).toBe("workshop_agent_change_rejected");
    expect(updateWorkshopMock).not.toHaveBeenCalled();
  });

  it("recreates a stale proposal against the current Work version", async () => {
    const proposal = await proposeWorkshopAgentChange({
      userId: "user-1",
      workshopId: "workshop-1",
      reason: "bind trading skill",
      patch: {
        modelConfig: {
          primarySkills: ["paper-trading-pre-market-plan"],
        },
      },
    });
    eventRef.current = proposal;
    workshopRef.current = workshop({
      modelConfig: {
        allowedTools: ["aStockQuote"],
        deniedTools: ["deleteFile"],
        workVersion: "2026-08-01T00:00:00.000Z",
      },
    });

    const result = await resolveWorkshopAgentChangeProposal({
      userId: "user-1",
      workshopId: "workshop-1",
      proposalEventId: proposal.id,
      action: "recreate",
      reason: "refresh proposal",
    });

    expect(result.status).toBe("recreated");
    if (result.status !== "recreated") {
      throw new Error("expected recreated result");
    }
    expect(result.proposal.type).toBe("workshop_agent_change_proposed");
    expect(result.proposal.metadata?.workModelVersion).toBe(
      "2026-08-01T00:00:00.000Z",
    );
    expect(result.proposal.metadata?.source).toMatchObject({
      action: "recreate_stale_proposal",
      previousProposalEventId: proposal.id,
    });
    expect(result.proposal.metadata?.patch).toMatchObject({
      modelConfig: {
        allowedTools: ["aStockQuote"],
        deniedTools: ["deleteFile"],
        primarySkills: ["paper-trading-pre-market-plan"],
        workVersion: "2026-08-01T00:00:00.000Z",
      },
    });
    expect(result.event.type).toBe("workshop_agent_change_superseded");
    expect(result.event.metadata?.newProposalEventId).toBe(result.proposal.id);
    expect(updateWorkshopMock).not.toHaveBeenCalled();
  });
});
