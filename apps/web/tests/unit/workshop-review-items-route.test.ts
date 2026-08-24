import { beforeEach, describe, expect, it, vi } from "vitest";

const getWorkshopMock = vi.hoisted(() => vi.fn());
const appendWorkshopEventMock = vi.hoisted(() => vi.fn());
const listPendingWorkshopReviewItemsMock = vi.hoisted(() => vi.fn());
const resolveWorkshopReviewItemMock = vi.hoisted(() => vi.fn());
const resolveWorkshopReviewItemBySourceEventMock = vi.hoisted(() => vi.fn());
const resolveWorkshopServiceErrorGroupReviewItemsMock = vi.hoisted(() =>
  vi.fn(),
);
const upsertWorkshopReviewItemFromProposalEventMock = vi.hoisted(() => vi.fn());

vi.mock("@/app/(auth)/auth", () => ({
  auth: vi.fn(async () => ({
    user: {
      id: "user-1",
      email: "user-1@example.com",
    },
  })),
}));

vi.mock("@/lib/workshops/service", () => ({
  appendWorkshopEvent: appendWorkshopEventMock,
  getWorkshop: getWorkshopMock,
}));

vi.mock("@/lib/workshops/review-items", () => ({
  listPendingWorkshopReviewItems: listPendingWorkshopReviewItemsMock,
  resolveWorkshopReviewItem: resolveWorkshopReviewItemMock,
  resolveWorkshopReviewItemBySourceEvent:
    resolveWorkshopReviewItemBySourceEventMock,
  resolveWorkshopServiceErrorGroupReviewItems:
    resolveWorkshopServiceErrorGroupReviewItemsMock,
  upsertWorkshopReviewItemFromProposalEvent:
    upsertWorkshopReviewItemFromProposalEventMock,
}));

import { PATCH } from "@/app/api/workshops/[id]/review-items/route";

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/workshops/workshop-1/review-items", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const recommendedAction = "Attach source evidence references to selected canonical memories.";
const diagnosticGovernanceAction =
  "Create deduplicated ranking_or_scope governance proposal for loops loop-ranking.";

describe("workshop review items route", () => {
  beforeEach(() => {
    getWorkshopMock.mockReset();
    appendWorkshopEventMock.mockReset();
    listPendingWorkshopReviewItemsMock.mockReset();
    resolveWorkshopReviewItemMock.mockReset();
    resolveWorkshopReviewItemBySourceEventMock.mockReset();
    resolveWorkshopServiceErrorGroupReviewItemsMock.mockReset();
    upsertWorkshopReviewItemFromProposalEventMock.mockReset();

    getWorkshopMock.mockResolvedValue({ id: "workshop-1" });
    listPendingWorkshopReviewItemsMock.mockResolvedValue([
      {
        id: "review-item-1",
        workshopId: "workshop-1",
        kind: "memory_recall_quality",
        metadata: {
          issueKind: "no_evidence_selected",
          issueCount: 3,
          recommendedActions: [recommendedAction],
        },
      },
    ]);
    appendWorkshopEventMock
      .mockResolvedValueOnce({ id: "event-1" })
      .mockResolvedValueOnce({ id: "proposal-event-1" });
    resolveWorkshopReviewItemMock.mockResolvedValue({
      id: "review-item-1",
      status: "approved",
    });
  });

  it("confirms a recommended memory recall governance action with audit metadata", async () => {
    const response = await PATCH(
      request({
        itemId: "review-item-1",
        action: "confirm_memory_recall_governance",
        governanceAction: recommendedAction,
      }) as never,
      { params: Promise.resolve({ id: "workshop-1" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.item).toEqual({ id: "review-item-1", status: "approved" });
    expect(appendWorkshopEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "workshop-1",
        type: "memory_recall_governance_action_confirmed",
        body: recommendedAction,
        metadata: expect.objectContaining({
          reviewItemId: "review-item-1",
          issueKind: "no_evidence_selected",
          issueCount: 3,
          governanceAction: recommendedAction,
          automaticPolicyChange: false,
        }),
      }),
    );
    expect(appendWorkshopEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "workshop-1",
        type: "memory_recall_governance_proposed",
        body: recommendedAction,
        metadata: expect.objectContaining({
          kind: "memory_recall_governance_proposal",
          status: "pending_approval",
          sourceReviewItemId: "review-item-1",
          sourceConfirmationEventId: "event-1",
          governanceAction: recommendedAction,
          automaticPolicyChange: false,
        }),
      }),
    );
    expect(upsertWorkshopReviewItemFromProposalEventMock).toHaveBeenCalledWith({
      id: "proposal-event-1",
    });
    expect(resolveWorkshopReviewItemMock).toHaveBeenCalledWith({
      workshopId: "workshop-1",
      itemId: "review-item-1",
      status: "approved",
      metadata: expect.objectContaining({
        governanceAction: expect.objectContaining({
          label: recommendedAction,
          eventId: "event-1",
          proposalEventId: "proposal-event-1",
          automaticPolicyChange: false,
        }),
      }),
    });
  });

  it("carries specific governance action details into memory recall governance proposals", async () => {
    listPendingWorkshopReviewItemsMock.mockResolvedValue([
      {
        id: "review-item-1",
        workshopId: "workshop-1",
        kind: "memory_recall_quality",
        metadata: {
          issueKind: "ranking_or_scope",
          issueCount: 2,
          recommendedActions: [diagnosticGovernanceAction],
          governanceActionDetails: [
            {
              label: diagnosticGovernanceAction,
              actionKind: "dedupe_recall_ranking_scope",
              issueKind: "ranking_or_scope",
              affectedLoops: [
                {
                  loopId: "loop-ranking",
                  feedbackCount: 2,
                  diagnosticScore: 6,
                  topOutcomes: "irrelevant (1), too_broad (1)",
                  topReason: "duplicate_canonical_group (2)",
                },
              ],
              affectedRuns: [],
              automaticPolicyChange: false,
              requiresOwnerApproval: true,
            },
          ],
        },
      },
    ]);
    appendWorkshopEventMock.mockReset();
    appendWorkshopEventMock
      .mockResolvedValueOnce({ id: "event-1" })
      .mockResolvedValueOnce({ id: "proposal-event-1" });
    resolveWorkshopReviewItemMock.mockResolvedValue({
      id: "review-item-1",
      status: "approved",
    });

    const response = await PATCH(
      request({
        itemId: "review-item-1",
        action: "confirm_memory_recall_governance",
        governanceAction: diagnosticGovernanceAction,
      }) as never,
      { params: Promise.resolve({ id: "workshop-1" }) },
    );

    expect(response.status).toBe(200);
    expect(appendWorkshopEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory_recall_governance_action_confirmed",
        metadata: expect.objectContaining({
          governanceAction: diagnosticGovernanceAction,
          governanceActionDetail: expect.objectContaining({
            actionKind: "dedupe_recall_ranking_scope",
            affectedLoops: [
              expect.objectContaining({
                loopId: "loop-ranking",
                diagnosticScore: 6,
              }),
            ],
            automaticPolicyChange: false,
          }),
        }),
      }),
    );
    expect(appendWorkshopEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory_recall_governance_proposed",
        metadata: expect.objectContaining({
          governanceAction: diagnosticGovernanceAction,
          governanceActionDetail: expect.objectContaining({
            actionKind: "dedupe_recall_ranking_scope",
            requiresOwnerApproval: true,
          }),
          automaticPolicyChange: false,
        }),
      }),
    );
  });

  it("batch-confirms matching diagnostic governance actions by issue kind", async () => {
    listPendingWorkshopReviewItemsMock.mockResolvedValue([
      {
        id: "review-item-1",
        workshopId: "workshop-1",
        kind: "memory_recall_quality",
        riskLevel: "medium",
        metadata: {
          issueKind: "ranking_or_scope",
          issueCount: 2,
          recommendedActions: [diagnosticGovernanceAction],
          governanceActionDetails: [
            {
              label: diagnosticGovernanceAction,
              actionKind: "dedupe_recall_ranking_scope",
              issueKind: "ranking_or_scope",
              affectedLoops: [{ loopId: "loop-ranking" }],
              affectedRuns: [],
              automaticPolicyChange: false,
              requiresOwnerApproval: true,
            },
          ],
        },
      },
      {
        id: "review-item-2",
        workshopId: "workshop-1",
        kind: "memory_recall_quality",
        riskLevel: "medium",
        metadata: {
          issueKind: "ranking_or_scope",
          issueCount: 1,
          recommendedActions: [
            "Create deduplicated ranking_or_scope governance proposal for loops loop-other.",
          ],
          governanceActionDetails: [
            {
              label:
                "Create deduplicated ranking_or_scope governance proposal for loops loop-other.",
              actionKind: "dedupe_recall_ranking_scope",
              issueKind: "ranking_or_scope",
              affectedLoops: [{ loopId: "loop-other" }],
              affectedRuns: [],
              automaticPolicyChange: false,
              requiresOwnerApproval: true,
            },
          ],
        },
      },
      {
        id: "review-item-3",
        workshopId: "workshop-1",
        kind: "memory_recall_quality",
        riskLevel: "high",
        metadata: {
          issueKind: "missing_or_too_narrow",
          recommendedActions: [
            "Create deduplicated missing_or_too_narrow governance proposal for loops loop-missing.",
          ],
          governanceActionDetails: [
            {
              label:
                "Create deduplicated missing_or_too_narrow governance proposal for loops loop-missing.",
              actionKind: "dedupe_recall_missing_scope",
              issueKind: "missing_or_too_narrow",
              affectedLoops: [{ loopId: "loop-missing" }],
              affectedRuns: [],
              automaticPolicyChange: false,
              requiresOwnerApproval: true,
            },
          ],
        },
      },
    ]);
    appendWorkshopEventMock.mockReset();
    appendWorkshopEventMock
      .mockResolvedValueOnce({ id: "event-1" })
      .mockResolvedValueOnce({ id: "proposal-event-1" })
      .mockResolvedValueOnce({ id: "event-2" })
      .mockResolvedValueOnce({ id: "proposal-event-2" });
    resolveWorkshopReviewItemMock
      .mockResolvedValueOnce({ id: "review-item-1", status: "approved" })
      .mockResolvedValueOnce({ id: "review-item-2", status: "approved" });

    const response = await PATCH(
      request({
        itemId: "review-item-1",
        action: "confirm_memory_recall_governance_batch",
      }) as never,
      { params: Promise.resolve({ id: "workshop-1" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      count: 2,
      issueKind: "ranking_or_scope",
      automaticPolicyChange: false,
    });
    expect(appendWorkshopEventMock).toHaveBeenCalledTimes(4);
    expect(appendWorkshopEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory_recall_governance_proposed",
        metadata: expect.objectContaining({
          sourceReviewItemId: "review-item-1",
          governanceActionDetail: expect.objectContaining({
            actionKind: "dedupe_recall_ranking_scope",
          }),
          automaticPolicyChange: false,
        }),
      }),
    );
    expect(appendWorkshopEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory_recall_governance_proposed",
        metadata: expect.objectContaining({
          sourceReviewItemId: "review-item-2",
          governanceActionDetail: expect.objectContaining({
            affectedLoops: [{ loopId: "loop-other" }],
          }),
        }),
      }),
    );
    expect(resolveWorkshopReviewItemMock).toHaveBeenCalledTimes(2);
    expect(resolveWorkshopReviewItemMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "review-item-3" }),
    );
  });

  it("rejects governance actions outside the recommended action list", async () => {
    const response = await PATCH(
      request({
        itemId: "review-item-1",
        action: "confirm_memory_recall_governance",
        governanceAction: "Bulk merge every duplicate memory.",
      }) as never,
      { params: Promise.resolve({ id: "workshop-1" }) },
    );

    expect(response.status).toBe(400);
    expect(appendWorkshopEventMock).not.toHaveBeenCalled();
    expect(resolveWorkshopReviewItemMock).not.toHaveBeenCalled();
  });

  it("approves memory recall governance proposals as audit-only resolutions", async () => {
    listPendingWorkshopReviewItemsMock.mockResolvedValue([
      {
        id: "proposal-review-item-1",
        sourceEventId: "proposal-event-1",
        workshopId: "workshop-1",
        kind: "memory_recall_governance_proposal",
        title: "Memory recall governance proposal",
        summary: recommendedAction,
        metadata: {
          proposalId: "proposal-1",
          sourceReviewItemId: "review-item-1",
          issueKind: "no_evidence_selected",
          governanceAction: recommendedAction,
          evidenceHints: ["traceQuality.noEvidenceSelectedCount"],
          blockedActions: [
            "Do not promote unevidenced summaries into long-term canonical memory.",
          ],
        },
      },
    ]);
    appendWorkshopEventMock.mockReset();
    appendWorkshopEventMock
      .mockResolvedValueOnce({ id: "resolution-event-1" })
      .mockResolvedValueOnce({ id: "change-plan-event-1" });
    resolveWorkshopReviewItemMock.mockResolvedValue({
      id: "proposal-review-item-1",
      status: "approved",
    });

    const response = await PATCH(
      request({
        itemId: "proposal-review-item-1",
        action: "resolve_memory_recall_governance_proposal",
        resolution: "approved",
      }) as never,
      { params: Promise.resolve({ id: "workshop-1" }) },
    );

    expect(response.status).toBe(200);
    expect(appendWorkshopEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "workshop-1",
        type: "memory_recall_governance_proposal_approved",
        body: recommendedAction,
        metadata: expect.objectContaining({
          proposalReviewItemId: "proposal-review-item-1",
          proposalEventId: "proposal-event-1",
          proposalId: "proposal-1",
          sourceReviewItemId: "review-item-1",
          issueKind: "no_evidence_selected",
          governanceAction: recommendedAction,
          resolution: "approved",
          executionMode: "audit_only",
          automaticPolicyChange: false,
        }),
      }),
    );
    expect(appendWorkshopEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "workshop-1",
        type: "memory_recall_change_plan_proposed",
        body: recommendedAction,
        metadata: expect.objectContaining({
          kind: "memory_recall_change_plan",
          status: "pending_approval",
          sourceProposalReviewItemId: "proposal-review-item-1",
          sourceProposalEventId: "proposal-event-1",
          sourceResolutionEventId: "resolution-event-1",
          issueKind: "no_evidence_selected",
          governanceAction: recommendedAction,
          planKind: "evidence_attachment_review",
          executionMode: "dry_run_plan",
          automaticPolicyChange: false,
          requiresOwnerApproval: true,
          evidenceHints: ["traceQuality.noEvidenceSelectedCount"],
        }),
      }),
    );
    expect(upsertWorkshopReviewItemFromProposalEventMock).toHaveBeenCalledWith({
      id: "change-plan-event-1",
    });
    expect(resolveWorkshopReviewItemMock).toHaveBeenCalledWith({
      workshopId: "workshop-1",
      itemId: "proposal-review-item-1",
      status: "approved",
      metadata: expect.objectContaining({
        resolutionEventId: "resolution-event-1",
        resolution: "approved",
        executionMode: "audit_only",
        changePlanEventId: "change-plan-event-1",
        automaticPolicyChange: false,
      }),
    });
  });

  it("rejects memory recall governance proposals with an audit event", async () => {
    listPendingWorkshopReviewItemsMock.mockResolvedValue([
      {
        id: "proposal-review-item-1",
        sourceEventId: "proposal-event-1",
        workshopId: "workshop-1",
        kind: "memory_recall_governance_proposal",
        title: "Memory recall governance proposal",
        summary: recommendedAction,
        metadata: {
          proposalId: "proposal-1",
          governanceAction: recommendedAction,
        },
      },
    ]);
    appendWorkshopEventMock.mockReset();
    appendWorkshopEventMock.mockResolvedValue({ id: "resolution-event-1" });
    resolveWorkshopReviewItemMock.mockResolvedValue({
      id: "proposal-review-item-1",
      status: "rejected",
    });

    const response = await PATCH(
      request({
        itemId: "proposal-review-item-1",
        action: "resolve_memory_recall_governance_proposal",
        resolution: "rejected",
        reason: "Need more evidence first.",
      }) as never,
      { params: Promise.resolve({ id: "workshop-1" }) },
    );

    expect(response.status).toBe(200);
    expect(appendWorkshopEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory_recall_governance_proposal_rejected",
        metadata: expect.objectContaining({
          resolution: "rejected",
          reason: "Need more evidence first.",
          executionMode: "audit_only",
          automaticPolicyChange: false,
        }),
      }),
    );
    expect(appendWorkshopEventMock).toHaveBeenCalledTimes(1);
    expect(resolveWorkshopReviewItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "rejected",
      }),
    );
  });

  it("approves memory recall change plans with rollback audit metadata", async () => {
    listPendingWorkshopReviewItemsMock.mockResolvedValue([
      {
        id: "change-plan-review-item-1",
        sourceEventId: "change-plan-event-1",
        workshopId: "workshop-1",
        kind: "memory_recall_change_plan",
        title: "Memory recall change plan proposed",
        summary: recommendedAction,
        metadata: {
          planId: "plan-1",
          planKind: "evidence_attachment_review",
          sourceProposalReviewItemId: "proposal-review-item-1",
          sourceProposalEventId: "proposal-event-1",
          sourceResolutionEventId: "resolution-event-1",
          issueKind: "no_evidence_selected",
          governanceAction: recommendedAction,
          dryRunSteps: ["List selected memories with missing evidence references."],
          rollbackPlan: ["No memory mutation has been executed by this plan."],
          evidenceHints: ["traceQuality.noEvidenceSelectedCount"],
          blockedActions: [
            "Do not promote unevidenced summaries into long-term canonical memory.",
          ],
        },
      },
    ]);
    appendWorkshopEventMock.mockReset();
    appendWorkshopEventMock
      .mockResolvedValueOnce({ id: "change-plan-resolution-event-1" })
      .mockResolvedValueOnce({ id: "execution-plan-event-1" })
      .mockResolvedValueOnce({ id: "rollback-audit-event-1" });
    resolveWorkshopReviewItemMock.mockResolvedValue({
      id: "change-plan-review-item-1",
      status: "approved",
    });

    const response = await PATCH(
      request({
        itemId: "change-plan-review-item-1",
        action: "resolve_memory_recall_change_plan",
        resolution: "approved",
      }) as never,
      { params: Promise.resolve({ id: "workshop-1" }) },
    );

    expect(response.status).toBe(200);
    expect(appendWorkshopEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "workshop-1",
        type: "memory_recall_change_plan_approved",
        body: recommendedAction,
        metadata: expect.objectContaining({
          changePlanReviewItemId: "change-plan-review-item-1",
          changePlanEventId: "change-plan-event-1",
          planId: "plan-1",
          planKind: "evidence_attachment_review",
          issueKind: "no_evidence_selected",
          governanceAction: recommendedAction,
          resolution: "approved",
          executionMode: "dry_run_plan",
          appliedMemoryMutation: false,
          requiresOwnerApproval: true,
          automaticPolicyChange: false,
        }),
      }),
    );
    expect(appendWorkshopEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "workshop-1",
        type: "memory_recall_change_execution_planned",
        metadata: expect.objectContaining({
          changePlanReviewItemId: "change-plan-review-item-1",
          changePlanEventId: "change-plan-event-1",
          approvalEventId: "change-plan-resolution-event-1",
          planId: "plan-1",
          planKind: "evidence_attachment_review",
          issueKind: "no_evidence_selected",
          governanceAction: recommendedAction,
          executionState: "planned",
          executionMode: "dry_run_plan",
          canExecuteAutomatically: false,
          requiresOwnerApproval: true,
          appliedMemoryMutation: false,
          automaticPolicyChange: false,
        }),
      }),
    );
    expect(appendWorkshopEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "workshop-1",
        type: "memory_recall_change_plan_rollback_audit_recorded",
        metadata: expect.objectContaining({
          changePlanReviewItemId: "change-plan-review-item-1",
          changePlanEventId: "change-plan-event-1",
          resolutionEventId: "change-plan-resolution-event-1",
          executionPlanEventId: "execution-plan-event-1",
          rollbackRequired: false,
          appliedMemoryMutation: false,
          automaticPolicyChange: false,
        }),
      }),
    );
    expect(resolveWorkshopReviewItemMock).toHaveBeenCalledWith({
      workshopId: "workshop-1",
      itemId: "change-plan-review-item-1",
      status: "approved",
      metadata: expect.objectContaining({
        resolutionEventId: "change-plan-resolution-event-1",
        executionPlanEventId: "execution-plan-event-1",
        rollbackAuditEventId: "rollback-audit-event-1",
        resolution: "approved",
        executionMode: "dry_run_plan",
        appliedMemoryMutation: false,
        automaticPolicyChange: false,
      }),
    });
    expect(appendWorkshopEventMock).toHaveBeenCalledTimes(3);
  });

  it("rejects memory recall change plans without rollback audit event", async () => {
    listPendingWorkshopReviewItemsMock.mockResolvedValue([
      {
        id: "change-plan-review-item-1",
        sourceEventId: "change-plan-event-1",
        workshopId: "workshop-1",
        kind: "memory_recall_change_plan",
        title: "Memory recall change plan proposed",
        summary: recommendedAction,
        metadata: {
          planId: "plan-1",
          governanceAction: recommendedAction,
        },
      },
    ]);
    appendWorkshopEventMock.mockReset();
    appendWorkshopEventMock.mockResolvedValue({
      id: "change-plan-resolution-event-1",
    });
    resolveWorkshopReviewItemMock.mockResolvedValue({
      id: "change-plan-review-item-1",
      status: "rejected",
    });

    const response = await PATCH(
      request({
        itemId: "change-plan-review-item-1",
        action: "resolve_memory_recall_change_plan",
        resolution: "rejected",
        reason: "Keep the original memory state for now.",
      }) as never,
      { params: Promise.resolve({ id: "workshop-1" }) },
    );

    expect(response.status).toBe(200);
    expect(appendWorkshopEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory_recall_change_plan_rejected",
        metadata: expect.objectContaining({
          resolution: "rejected",
          reason: "Keep the original memory state for now.",
          executionMode: "dry_run_plan",
          appliedMemoryMutation: false,
          automaticPolicyChange: false,
        }),
      }),
    );
    expect(appendWorkshopEventMock).toHaveBeenCalledTimes(1);
    expect(resolveWorkshopReviewItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "rejected",
      }),
    );
  });
});
