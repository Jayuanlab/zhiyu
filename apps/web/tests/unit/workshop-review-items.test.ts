import { describe, expect, it } from "vitest";
import type { WorkshopEvent, WorkshopOutboxItem } from "@/lib/db/schema";
import {
  buildWorkshopReviewItemsFromMemoryRecallQuality,
  buildWorkshopReviewItemFromOutboxBoundary,
  buildWorkshopReviewItemFromLoopBlocker,
  buildWorkshopReviewItemFromProposalEvent,
  buildWorkshopReviewItemFromServiceErrorEvent,
} from "@/lib/workshops/review-items";
import type { LoopDashboardSummary } from "@/lib/loops/dashboard";

const now = new Date("2026-08-22T09:30:00.000Z");

function event(overrides: Partial<WorkshopEvent>): WorkshopEvent {
  return {
    id: "event-1",
    workshopId: "workshop-1",
    runId: null,
    loopId: null,
    loopRunId: null,
    seq: 1,
    type: "watchlist_proposal",
    title: "自选股调整提案",
    body: "需要确认是否加入候选股。",
    metadata: {},
    visibility: "user",
    createdAt: now,
    ...overrides,
  } as WorkshopEvent;
}

function outbox(overrides: Partial<WorkshopOutboxItem> = {}): WorkshopOutboxItem {
  return {
    id: "outbox-1",
    workshopId: "workshop-1",
    runId: null,
    channel: "wechat_desktop",
    recipientName: "文件传输助手",
    message: "请发送盘中交易巡检结论。",
    status: "blocked",
    confidence: 80,
    riskLevel: "medium",
    sourceEventIds: [],
    boundaryResult: {
      loopId: "loop-1",
      boundary: {
        status: "blocked",
        allowed: false,
        requiresApproval: true,
        violations: ["External messages are blocked for this Workshop."],
        warnings: ["Financial messages should include sources."],
      },
    },
    sentAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as WorkshopOutboxItem;
}

describe("workshop review items", () => {
  it("projects a pending workshop agent change proposal", () => {
    const item = buildWorkshopReviewItemFromProposalEvent(
      event({
        type: "workshop_agent_change_proposed",
        title: "智能体修改提案：modelConfig",
        metadata: {
          kind: "workshop_agent_change_proposal",
          status: "pending_approval",
          riskLevel: "high",
          changedFields: ["modelConfig"],
          proposedBy: "chat_agent",
        },
      }),
    );

    expect(item).toMatchObject({
      workshopId: "workshop-1",
      sourceEventId: "event-1",
      kind: "agent_change_proposal",
      status: "pending",
      riskLevel: "high",
      metadata: {
        changedFields: ["modelConfig"],
        proposedBy: "chat_agent",
      },
    });
  });

  it("projects pending Insight change proposals into review items", () => {
    const item = buildWorkshopReviewItemFromProposalEvent(
      event({
        id: "insight-proposal-event-1",
        type: "workshop_insight_change_proposed",
        title: "Insight 创建提案：Prepare client demo",
        body: "Capture the current conversation as an owner-reviewed Insight.",
        metadata: {
          kind: "insight_change_proposal",
          status: "pending_owner_review",
          action: "create",
          proposedTitle: "Prepare client demo",
          proposedBy: "chat_agent",
          reason: "Capture durable task context.",
          riskLevel: "low",
          requestedChange: {
            title: "Prepare client demo",
            description: "Prepare scenario-based product demo.",
          },
          source: {
            surface: "web_chat_pi",
          },
        },
      }),
    );

    expect(item).toMatchObject({
      workshopId: "workshop-1",
      sourceEventId: "insight-proposal-event-1",
      kind: "insight_change_proposal",
      status: "pending",
      riskLevel: "low",
      metadata: {
        proposalKind: "insight_change_proposal",
        action: "create",
        targetInsightId: null,
        proposedBy: "chat_agent",
        appliesAutomatically: false,
        requiresOwnerReview: true,
        requestedChange: {
          title: "Prepare client demo",
        },
      },
    });
  });

  it("projects pending Loop change proposals into review items", () => {
    const item = buildWorkshopReviewItemFromProposalEvent(
      event({
        id: "loop-change-event-1",
        loopId: "loop-1",
        type: "workshop_loop_change_proposed",
        title: "Loop change proposed: Daily market scan",
        body: "Move the trading-day scan to 10:30.",
        metadata: {
          kind: "loop_change_proposal",
          status: "pending_owner_review",
          action: "update",
          loopId: "loop-1",
          changedFields: ["triggerConfig"],
          patch: {
            triggerConfig: {
              type: "cron",
              expression: "30 10 * * 1-5",
              timezone: "Asia/Shanghai",
            },
          },
          proposedBy: "chat_agent",
          riskLevel: "medium",
          reason: "Owner should review schedule change.",
          source: {
            surface: "web_chat_pi",
          },
          destructive: false,
        },
      }),
    );

    expect(item).toMatchObject({
      workshopId: "workshop-1",
      sourceEventId: "loop-change-event-1",
      kind: "loop_change_proposal",
      status: "pending",
      riskLevel: "medium",
      metadata: {
        action: "update",
        loopId: "loop-1",
        changedFields: ["triggerConfig"],
        patch: {
          triggerConfig: {
            expression: "30 10 * * 1-5",
          },
        },
        proposedBy: "chat_agent",
        requiresOwnerReview: true,
      },
    });
  });

  it("projects only approval-required watchlist proposals", () => {
    const item = buildWorkshopReviewItemFromProposalEvent(
      event({
        metadata: {
          kind: "watchlist_change_proposal",
          status: "pending_approval",
          approvalRequired: true,
          proposalId: "wp-1",
          before: ["600519.SH"],
          after: ["600519.SH", "000977.SZ"],
          add: ["000977.SZ"],
          remove: [],
        },
      }),
    );

    expect(item).toMatchObject({
      kind: "watchlist_proposal",
      status: "pending",
      riskLevel: "medium",
      metadata: {
        proposalId: "wp-1",
        add: ["000977.SZ"],
      },
    });

    expect(
      buildWorkshopReviewItemFromProposalEvent(
        event({
          metadata: {
            kind: "watchlist_change_proposal",
            status: "pending_approval",
            approvalRequired: false,
          },
        }),
      ),
    ).toBeNull();
  });

  it("projects blocked loops into review items", () => {
    const item = buildWorkshopReviewItemFromLoopBlocker({
      workshopId: "workshop-1",
      loop: {
        id: "loop-1",
        name: "盘中巡检",
        description: null,
        goal: "Inspect intraday paper trading signals.",
        status: "active",
        dashboardStatus: "blocked",
        triggerConfig: {},
        currentPhase: "blocked",
        nextAction: "Owner should decide whether to rerun.",
        blockedReason: "Model checker failed.",
        lastObservation: null,
        stateJson: {},
        nextScheduledRunAt: null,
        lastScheduledRunAt: null,
        schedulerStatus: null,
        spaceSummary: {
          triggerLabel: "manual",
          contextLabel: "default",
          deliveryLabel: null,
          plannerAgent: "default",
          executorAgent: "default",
          verifierAgent: "default",
          harness: "default",
          externalWriteMode: "none",
          permissionLabel: "manual",
        },
        latestRun: null,
        createdAt: now,
        updatedAt: now,
      } as LoopDashboardSummary,
    });

    expect(item).toMatchObject({
      workshopId: "workshop-1",
      sourceEventId: null,
      kind: "loop_blocker",
      status: "pending",
      title: "盘中巡检",
      riskLevel: "medium",
      metadata: {
        loopId: "loop-1",
        dashboardStatus: "blocked",
        currentPhase: "blocked",
      },
    });
    expect(item?.summary).toContain("Model checker failed.");
  });

  it("projects blocked outbox boundary failures into review items", () => {
    const item = buildWorkshopReviewItemFromOutboxBoundary({
      workshopId: "workshop-1",
      outbox: outbox(),
      sourceEventId: "event-outbox-blocked",
    });

    expect(item).toMatchObject({
      workshopId: "workshop-1",
      sourceEventId: "event-outbox-blocked",
      kind: "permission_boundary",
      status: "pending",
      riskLevel: "medium",
      metadata: {
        outboxId: "outbox-1",
        channel: "wechat_desktop",
        recipientName: "文件传输助手",
        violations: ["External messages are blocked for this Workshop."],
        loopId: "loop-1",
      },
    });
    expect(item?.summary).toContain("External messages are blocked");
  });

  it("does not project non-blocked outbox items as boundary review items", () => {
    expect(
      buildWorkshopReviewItemFromOutboxBoundary({
        workshopId: "workshop-1",
        outbox: outbox({ status: "draft" }),
      }),
    ).toBeNull();
  });

  it("projects user-visible tool errors into service-error review items", () => {
    const item = buildWorkshopReviewItemFromServiceErrorEvent(
      event({
        id: "event-tool-error",
        type: "tool_error",
        title: "Tool returned error",
        body: "Provider timed out after 3000ms.",
        loopId: "loop-1",
        loopRunId: "loop-run-1",
        metadata: {
          toolName: "quantMarketSnapshot",
          error: "Provider timed out after 3000ms.",
        },
        visibility: "user",
      }),
    );

    expect(item).toMatchObject({
      workshopId: "workshop-1",
      sourceEventId: "event-tool-error",
      kind: "service_error",
      status: "pending",
      title: "Service error: quantMarketSnapshot",
      riskLevel: "medium",
      metadata: {
        sourceEventType: "tool_error",
        toolName: "quantMarketSnapshot",
        loopId: "loop-1",
        loopRunId: "loop-run-1",
        error: "Provider timed out after 3000ms.",
      },
    });
    expect(item?.metadata.serviceKey).toContain("quantMarketSnapshot");
  });

  it("does not project debug tool errors as owner review items", () => {
    expect(
      buildWorkshopReviewItemFromServiceErrorEvent(
        event({
          type: "tool_error",
          visibility: "debug",
          metadata: { toolName: "debugTool" },
        }),
      ),
    ).toBeNull();
  });

  it("projects memory recall quality patterns into review items", () => {
    const items = buildWorkshopReviewItemsFromMemoryRecallQuality({
      workshopId: "workshop-1",
      report: {
        summary: {
          duplicateCanonicalGroupCount: 2,
        },
        feedbackOutcomes: {
          missing: 1,
          irrelevant: 2,
          stale: 1,
        },
        feedbackTraceDiagnosticsByLoop: [
          {
            workshopId: "workshop-1",
            loopId: "loop-ranking",
            feedbackCount: 2,
            diagnosticScore: 6,
            feedbackOutcomes: { too_broad: 1, irrelevant: 1 },
            traceQuality: {
              noEvidenceSelectedCount: 1,
              warningCount: 0,
              topOmittedReasons: [
                { value: "duplicate_canonical_group", count: 2 },
              ],
              topDeniedReasons: [],
              topSelectedReasons: [{ value: "semantic_match", count: 3 }],
            },
          },
          {
            workshopId: "workshop-1",
            loopId: "loop-missing",
            feedbackCount: 1,
            diagnosticScore: 5,
            feedbackOutcomes: { missing: 1 },
            traceQuality: {
              noEvidenceSelectedCount: 0,
              warningCount: 0,
              topOmittedReasons: [],
              topDeniedReasons: [{ value: "scope_denied", count: 1 }],
              topSelectedReasons: [],
            },
          },
        ],
        feedbackTraceDiagnosticsByRun: [
          {
            workshopId: "workshop-1",
            loopId: "loop-ranking",
            loopRunId: "loop-run-ranking",
            feedbackCount: 2,
            diagnosticScore: 6,
            feedbackOutcomes: { too_broad: 1, irrelevant: 1 },
            traceQuality: {
              noEvidenceSelectedCount: 1,
              warningCount: 0,
              topOmittedReasons: [
                { value: "duplicate_canonical_group", count: 2 },
              ],
              topDeniedReasons: [],
              topSelectedReasons: [{ value: "semantic_match", count: 3 }],
            },
          },
        ],
        traceQuality: {
          noEvidenceSelectedCount: 3,
          warningCount: 1,
          topOmittedReasons: [{ value: "duplicate_canonical_group", count: 2 }],
          topDeniedReasons: [{ value: "permission_denied", count: 1 }],
        },
        period: {
          days: 7,
          since: "2026-08-15T00:00:00.000Z",
          generatedAt: "2026-08-22T00:00:00.000Z",
        },
        scope: {
          kind: "user_memory_recall_sample",
          reportWorkshopId: "workshop-1",
          includesOtherWorkshops: true,
        },
      },
    });

    expect(items.map((item) => item.metadata.issueKind)).toEqual([
      "missing_or_too_narrow",
      "ranking_or_scope",
      "freshness",
      "no_evidence_selected",
      "trace_warnings",
      "duplicate_canonical_groups",
    ]);
    expect(items[0]).toMatchObject({
      kind: "memory_recall_quality",
      riskLevel: "high",
      metadata: {
        issueCount: 1,
        periodDays: 7,
        periodSince: "2026-08-15T00:00:00.000Z",
        generatedAt: "2026-08-22T00:00:00.000Z",
        observationScope: {
          kind: "user_memory_recall_sample",
          reportWorkshopId: "workshop-1",
          includesOtherWorkshops: true,
        },
        automaticPolicyChange: false,
      },
    });
    expect(items[0].metadata.recommendedActions).toContain(
      "Review requester intent and recall profile scope.",
    );
    expect(items[0].metadata.recommendedActions).toContain(
      "Create deduplicated missing_or_too_narrow governance proposal for loops loop-missing.",
    );
    expect(items[0].metadata.blockedActions).toContain(
      "Do not widen access policy from filtered counts alone.",
    );
    expect(items[0].metadata.feedbackTraceDiagnostics).toMatchObject({
      loops: [
        {
          loopId: "loop-missing",
          feedbackCount: 1,
          diagnosticScore: 5,
          topOutcomes: "missing (1)",
          topReason: "scope_denied (1)",
        },
      ],
    });
    expect(items[0].metadata.governanceActionDetails).toMatchObject([
      {
        label:
          "Create deduplicated missing_or_too_narrow governance proposal for loops loop-missing.",
        actionKind: "dedupe_recall_missing_scope",
        issueKind: "missing_or_too_narrow",
        automaticPolicyChange: false,
        requiresOwnerApproval: true,
      },
    ]);
    expect(items[1].metadata.feedbackTraceDiagnostics).toMatchObject({
      loops: [
        {
          loopId: "loop-ranking",
          feedbackCount: 2,
          diagnosticScore: 6,
          topOutcomes: "irrelevant (1), too_broad (1)",
          topReason: "duplicate_canonical_group (2)",
        },
      ],
      runs: [
        {
          loopId: "loop-ranking",
          runId: "loop-run-ranking",
          feedbackCount: 2,
        },
      ],
    });
    expect(items[3].metadata.evidenceHints).toContain(
      "traceQuality.noEvidenceSelectedCount",
    );
  });

  it("projects memory recall governance proposals into review items", () => {
    const item = buildWorkshopReviewItemFromProposalEvent(
      event({
        id: "proposal-event-1",
        type: "memory_recall_governance_proposed",
        title: "Memory recall governance proposal",
        body: "Attach source evidence references to selected canonical memories.",
        metadata: {
          kind: "memory_recall_governance_proposal",
          status: "pending_approval",
          proposalId: "proposal-1",
          sourceReviewItemId: "review-item-1",
          issueKind: "no_evidence_selected",
          governanceAction:
            "Attach source evidence references to selected canonical memories.",
          riskLevel: "medium",
          automaticPolicyChange: false,
        },
      }),
    );

    expect(item).toMatchObject({
      workshopId: "workshop-1",
      sourceEventId: "proposal-event-1",
      kind: "memory_recall_governance_proposal",
      status: "pending",
      riskLevel: "medium",
      metadata: {
        proposalKind: "memory_recall_governance_proposal",
        proposalId: "proposal-1",
        sourceReviewItemId: "review-item-1",
        issueKind: "no_evidence_selected",
        automaticPolicyChange: false,
      },
    });
  });

  it("projects memory recall change plans into review items", () => {
    const item = buildWorkshopReviewItemFromProposalEvent(
      event({
        id: "change-plan-event-1",
        type: "memory_recall_change_plan_proposed",
        title: "Memory recall change plan proposed",
        body: "Attach source evidence references to selected canonical memories.",
        metadata: {
          kind: "memory_recall_change_plan",
          status: "pending_approval",
          planId: "plan-1",
          planKind: "evidence_attachment_review",
          sourceProposalEventId: "proposal-event-1",
          sourceProposalReviewItemId: "proposal-review-item-1",
          sourceResolutionEventId: "resolution-event-1",
          issueKind: "no_evidence_selected",
          governanceAction:
            "Attach source evidence references to selected canonical memories.",
          dryRunSteps: [
            "List selected memories with missing evidence references.",
          ],
          rollbackPlan: [
            "No memory mutation has been executed by this plan.",
          ],
          evidenceHints: ["traceQuality.noEvidenceSelectedCount"],
          blockedActions: [
            "Do not promote unevidenced summaries into long-term canonical memory.",
          ],
          riskLevel: "medium",
          executionMode: "dry_run_plan",
          automaticPolicyChange: false,
        },
      }),
    );

    expect(item).toMatchObject({
      workshopId: "workshop-1",
      sourceEventId: "change-plan-event-1",
      kind: "memory_recall_change_plan",
      status: "pending",
      riskLevel: "medium",
      metadata: {
        proposalKind: "memory_recall_change_plan",
        planId: "plan-1",
        planKind: "evidence_attachment_review",
        sourceProposalEventId: "proposal-event-1",
        sourceProposalReviewItemId: "proposal-review-item-1",
        sourceResolutionEventId: "resolution-event-1",
        issueKind: "no_evidence_selected",
        dryRunSteps: [
          "List selected memories with missing evidence references.",
        ],
        rollbackPlan: [
          "No memory mutation has been executed by this plan.",
        ],
        evidenceHints: ["traceQuality.noEvidenceSelectedCount"],
        blockedActions: [
          "Do not promote unevidenced summaries into long-term canonical memory.",
        ],
        executionMode: "dry_run_plan",
        requiresOwnerApproval: true,
        automaticPolicyChange: false,
      },
    });
  });
});
