import { sql } from 'drizzle-orm';
import type { WorkshopWriteContext } from '@/lib/workshops/service';
import type { appendWorkshopEvent } from '@/lib/workshops/service';
import { listPendingWorkshopReviewItems, resolveWorkshopReviewItem, resolveWorkshopReviewItemBySourceEvent, resolveWorkshopServiceErrorGroupReviewItems, upsertWorkshopReviewItemFromProposalEvent } from '@/lib/workshops/review-items';
import { runDatabaseWorkCommand } from './database-command';
import { WorkCommandConflict } from './command-ledger';

function reply(body: Record<string, unknown>, options?: {status: number}): Record<string, unknown> {
  if (options && options.status >= 400) throw new WorkCommandConflict(options.status === 404 ? 'not_found' : 'invalid_command');
  return body;
}
function resolutionStatus(value: unknown) {
  if (
    value === "approved" ||
    value === "rejected" ||
    value === "dismissed" ||
    value === "superseded"
  ) {
    return value;
  }
  return null;
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
    : [];
}

function recordList(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function reviewRiskLevel(value: unknown) {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : "medium";
}

function firstGovernanceActionDetail(item: {
  metadata?: Record<string, unknown> | null;
}) {
  const recommendedActions = stringList(item.metadata?.recommendedActions);
  const detail =
    recordList(item.metadata?.governanceActionDetails).find(
      (entry) =>
        typeof entry.label === "string" &&
        recommendedActions.includes(entry.label),
    ) ?? null;
  return {
    governanceAction:
      typeof detail?.label === "string" ? detail.label : null,
    governanceActionDetail: detail,
  };
}

async function confirmMemoryRecallGovernanceAction(input: {
  workshopId: string;
  userId: string;
  pendingItem: {
    id: string;
    kind: string;
    riskLevel?: string | null;
    metadata?: Record<string, unknown> | null;
  };
  governanceAction: string;
  governanceActionDetail?: Record<string, unknown> | null;
  reason: string;
}, context: WorkshopWriteContext) {
  const event = await context.append({
    workshopId: input.workshopId,
    type: "memory_recall_governance_action_confirmed",
    title: "Memory recall governance action confirmed",
    body: input.governanceAction,
    visibility: "user",
    metadata: {
      reviewItemId: input.pendingItem.id,
      issueKind: input.pendingItem.metadata?.issueKind ?? null,
      issueCount: input.pendingItem.metadata?.issueCount ?? null,
      governanceAction: input.governanceAction,
      governanceActionDetail: input.governanceActionDetail ?? null,
      confirmedBy: input.userId,
      source: "workshop_review_items_api",
      automaticPolicyChange: false,
    },
  });
  const proposal = await context.append({
    workshopId: input.workshopId,
    type: "memory_recall_governance_proposed",
    title: "Memory recall governance proposal",
    body: input.governanceAction,
    visibility: "user",
    metadata: {
      kind: "memory_recall_governance_proposal",
      status: "pending_approval",
      proposalId: crypto.randomUUID(),
      sourceReviewItemId: input.pendingItem.id,
      sourceConfirmationEventId: event.id,
      issueKind: input.pendingItem.metadata?.issueKind ?? null,
      issueCount: input.pendingItem.metadata?.issueCount ?? null,
      governanceAction: input.governanceAction,
      governanceActionDetail: input.governanceActionDetail ?? null,
      riskLevel: reviewRiskLevel(input.pendingItem.riskLevel),
      evidenceHints: stringList(input.pendingItem.metadata?.evidenceHints),
      blockedActions: stringList(input.pendingItem.metadata?.blockedActions),
      proposedBy: input.userId,
      source: "workshop_review_items_api",
      automaticPolicyChange: false,
    },
  });
  await upsertWorkshopReviewItemFromProposalEvent(proposal, context.db);

  const item = await resolveWorkshopReviewItem({
    workshopId: input.workshopId,
    itemId: input.pendingItem.id,
    status: "approved",
    metadata: {
      governanceAction: {
        label: input.governanceAction,
        confirmedBy: input.userId,
        confirmedAt: new Date().toISOString(),
        eventId: event.id,
        proposalEventId: proposal.id,
        automaticPolicyChange: false,
      },
      source: "workshop_review_items_api",
      reason: input.reason,
    },
  }, context.db);

  return { item, event, proposal };
}

function governanceProposalResolution(value: unknown) {
  if (value === "approve" || value === "approved") return "approved";
  if (value === "reject" || value === "rejected") return "rejected";
  return null;
}

function changePlanResolution(value: unknown) {
  if (value === "apply" || value === "approve" || value === "approved") {
    return "approved";
  }
  if (value === "reject" || value === "rejected") return "rejected";
  return null;
}

function memoryRecallChangePlanFor(input: {
  planId: string;
  issueKind: unknown;
  governanceAction: string;
  evidenceHints: string[];
  blockedActions: string[];
}) {
  const issueKind =
    typeof input.issueKind === "string" ? input.issueKind : "unknown";
  const common = {
    planId: input.planId,
    issueKind,
    governanceAction: input.governanceAction,
    evidenceHints: input.evidenceHints,
    blockedActions: input.blockedActions,
    executionMode: "dry_run_plan",
    automaticPolicyChange: false,
    requiresOwnerApproval: true,
    rollbackPlan: [
      "No memory mutation has been executed by this plan.",
      "If a later execution is approved, preserve original memory ids, evidence refs, and prior status for rollback.",
    ],
  };

  if (issueKind === "duplicate_canonical_groups") {
    return {
      ...common,
      planKind: "canonical_deduplication_review",
      dryRunSteps: [
        "List candidate canonical groups mentioned by recall traces.",
        "Verify source evidence before proposing any merge.",
        "Create a separate merge proposal with before/after canonical ids.",
      ],
    };
  }
  if (issueKind === "no_evidence_selected") {
    return {
      ...common,
      planKind: "evidence_attachment_review",
      dryRunSteps: [
        "List selected memories with missing evidence references.",
        "Search source observations that can support each memory.",
        "Create a separate evidence attachment or downgrade proposal.",
      ],
    };
  }
  if (issueKind === "freshness") {
    return {
      ...common,
      planKind: "freshness_review",
      dryRunSteps: [
        "List stale memories and source timestamps.",
        "Find replacement source observations or mark candidates for downgrade.",
        "Create a separate supersede/downgrade proposal.",
      ],
    };
  }
  return {
    ...common,
    planKind: "recall_profile_review",
    dryRunSteps: [
      "Group affected feedback and trace reasons by requester.",
      "Identify whether the issue is classification, ranking, evidence, or boundary.",
      "Create a separate recall profile or memory classification proposal.",
    ],
  };
}


export async function resolveWorkReviewItems(command: {userId: string; workId: string; commandId: string; expectedVersion: number; body: Record<string, unknown>}) {
  return runDatabaseWorkCommand(command, 'resolveWorkReviewItems', async (persisted, context) => {
    const {userId, workId: id, body} = persisted;
    // Also serialize against review writers outside the command ledger.
    await context.db.execute(sql`SELECT id FROM workshop_review_items WHERE workshop_id=${id}::uuid ORDER BY id FOR UPDATE`);
    return applyReviewAction(id, userId, body, {
      db: context.db,
      append: input => context.append({...input, metadata: {...input.metadata, commandId: persisted.commandId, actorId: userId}}),
    });
  });
}

async function applyReviewAction(id: string, userId: string, body: Record<string, unknown>, context: WorkshopWriteContext): Promise<Record<string, unknown>> {
    const action = typeof body?.action === "string" ? body.action : null;
    const itemId = typeof body?.itemId === "string" ? body.itemId : null;
    const sourceEventId =
      typeof body?.sourceEventId === "string" ? body.sourceEventId : null;

    if (action === "confirm_memory_recall_governance") {
      const governanceAction =
        typeof body?.governanceAction === "string"
          ? body.governanceAction.trim()
          : "";
      if (!itemId || !governanceAction) {
        return reply(
          {
            error:
              "confirm_memory_recall_governance requires itemId and governanceAction",
          },
          { status: 400 },
        );
      }

      const pendingItems = await listPendingWorkshopReviewItems(id, context.db);
      const pendingItem = pendingItems.find((item) => item.id === itemId);
      if (!pendingItem || pendingItem.kind !== "memory_recall_quality") {
        return reply(
          { error: "Memory recall quality review item not found" },
          { status: 404 },
        );
      }

      const recommendedActions = stringList(
        pendingItem.metadata?.recommendedActions,
      );
      if (!recommendedActions.includes(governanceAction)) {
        return reply(
          { error: "governanceAction must be one of the recommended actions" },
          { status: 400 },
        );
      }
      const governanceActionDetail =
        recordList(pendingItem.metadata?.governanceActionDetails).find(
          (item) => item.label === governanceAction,
        ) ?? null;

      const result = await confirmMemoryRecallGovernanceAction({
        workshopId: id,
        userId: userId,
        pendingItem,
        governanceAction,
        governanceActionDetail,
        reason: "Owner confirmed a memory recall governance action.",
      }, context);

      return reply({ item: result.item, event: result.event });
    }

    if (action === "confirm_memory_recall_governance_batch") {
      if (!itemId) {
        return reply(
          {
            error:
              "confirm_memory_recall_governance_batch requires anchor itemId",
          },
          { status: 400 },
        );
      }

      const limit = Math.max(
        1,
        Math.min(
          5,
          typeof body?.limit === "number" && Number.isFinite(body.limit)
            ? Math.trunc(body.limit)
            : 5,
        ),
      );
      const pendingItems = await listPendingWorkshopReviewItems(id, context.db);
      const anchor = pendingItems.find((item) => item.id === itemId);
      if (!anchor || anchor.kind !== "memory_recall_quality") {
        return reply(
          { error: "Memory recall quality review item not found" },
          { status: 404 },
        );
      }
      const anchorIssueKind =
        typeof anchor.metadata?.issueKind === "string"
          ? anchor.metadata.issueKind
          : null;
      if (!anchorIssueKind) {
        return reply(
          { error: "Anchor review item is missing issueKind" },
          { status: 400 },
        );
      }

      const candidates = pendingItems
        .filter(
          (item) =>
            item.kind === "memory_recall_quality" &&
            item.metadata?.issueKind === anchorIssueKind,
        )
        .map((item) => ({
          item,
          ...firstGovernanceActionDetail(item),
        }))
        .filter(
          (
            entry,
          ): entry is {
            item: typeof pendingItems[number];
            governanceAction: string;
            governanceActionDetail: Record<string, unknown>;
          } =>
            Boolean(entry.governanceAction) &&
            Boolean(entry.governanceActionDetail),
        )
        .slice(0, limit);

      if (candidates.length === 0) {
        return reply(
          { error: "No matching diagnostic governance actions found" },
          { status: 400 },
        );
      }

      const results = [];
      for (const candidate of candidates) {
        results.push(
          await confirmMemoryRecallGovernanceAction({
            workshopId: id,
            userId: userId,
            pendingItem: candidate.item,
            governanceAction: candidate.governanceAction,
            governanceActionDetail: candidate.governanceActionDetail,
            reason:
              "Owner batch-confirmed matching memory recall governance diagnostics.",
          }, context),
        );
      }

      return reply({
        items: results.map((result) => result.item),
        events: results.map((result) => result.event),
        count: results.length,
        issueKind: anchorIssueKind,
        automaticPolicyChange: false,
      });
    }

    if (action === "resolve_memory_recall_governance_proposal") {
      const status = governanceProposalResolution(body?.resolution ?? body?.status);
      if (!itemId || !status) {
        return reply(
          {
            error:
              "resolve_memory_recall_governance_proposal requires itemId and approved/rejected resolution",
          },
          { status: 400 },
        );
      }

      const pendingItems = await listPendingWorkshopReviewItems(id, context.db);
      const pendingItem = pendingItems.find((item) => item.id === itemId);
      if (
        !pendingItem ||
        pendingItem.kind !== "memory_recall_governance_proposal"
      ) {
        return reply(
          { error: "Memory recall governance proposal not found" },
          { status: 404 },
        );
      }

      const metadata = pendingItem.metadata ?? {};
      const governanceAction =
        typeof metadata.governanceAction === "string"
          ? metadata.governanceAction
          : pendingItem.summary ?? pendingItem.title;
      const reason =
        typeof body?.reason === "string" && body.reason.trim()
          ? body.reason.trim()
          : status === "approved"
            ? "Owner approved memory recall governance proposal as audit-only."
            : "Owner rejected memory recall governance proposal.";
      const event = await context.append({
        workshopId: id,
        type:
          status === "approved"
            ? "memory_recall_governance_proposal_approved"
            : "memory_recall_governance_proposal_rejected",
        title:
          status === "approved"
            ? "Memory recall governance proposal approved"
            : "Memory recall governance proposal rejected",
        body: governanceAction,
        visibility: "user",
        metadata: {
          proposalReviewItemId: itemId,
          proposalEventId: pendingItem.sourceEventId,
          proposalId: metadata.proposalId ?? null,
          sourceReviewItemId: metadata.sourceReviewItemId ?? null,
          issueKind: metadata.issueKind ?? null,
          governanceAction,
          governanceActionDetail: metadata.governanceActionDetail ?? null,
          resolution: status,
          resolvedBy: userId,
          reason,
          executionMode: "audit_only",
          automaticPolicyChange: false,
          source: "workshop_review_items_api",
        },
      });
      let changePlan: Awaited<ReturnType<typeof appendWorkshopEvent>> | null =
        null;
      if (status === "approved") {
        const planId = crypto.randomUUID();
        const changePlanPayload = memoryRecallChangePlanFor({
          planId,
          issueKind: metadata.issueKind,
          governanceAction,
          evidenceHints: stringList(metadata.evidenceHints),
          blockedActions: stringList(metadata.blockedActions),
        });
        changePlan = await context.append({
          workshopId: id,
          type: "memory_recall_change_plan_proposed",
          title: "Memory recall change plan proposed",
          body: governanceAction,
          visibility: "user",
          metadata: {
            kind: "memory_recall_change_plan",
            status: "pending_approval",
            riskLevel: pendingItem.riskLevel ?? "medium",
            sourceProposalReviewItemId: itemId,
          sourceProposalEventId: pendingItem.sourceEventId,
          sourceResolutionEventId: event.id,
          proposalId: metadata.proposalId ?? null,
          governanceActionDetail: metadata.governanceActionDetail ?? null,
          proposedBy: userId,
          source: "workshop_review_items_api",
          ...changePlanPayload,
          },
        });
        await upsertWorkshopReviewItemFromProposalEvent(changePlan, context.db);
      }

      const item = await resolveWorkshopReviewItem({
        workshopId: id,
        itemId,
        status,
        metadata: {
          resolutionEventId: event.id,
          resolution: status,
          reason,
          executionMode: "audit_only",
          changePlanEventId: changePlan?.id ?? null,
          automaticPolicyChange: false,
          source: "workshop_review_items_api",
        },
      }, context.db);

      return reply({ item, event, changePlan });
    }

    if (action === "resolve_memory_recall_change_plan") {
      const status = changePlanResolution(body?.resolution ?? body?.status);
      if (!itemId || !status) {
        return reply(
          {
            error:
              "resolve_memory_recall_change_plan requires itemId and approved/rejected resolution",
          },
          { status: 400 },
        );
      }

      const pendingItems = await listPendingWorkshopReviewItems(id, context.db);
      const pendingItem = pendingItems.find((item) => item.id === itemId);
      if (!pendingItem || pendingItem.kind !== "memory_recall_change_plan") {
        return reply(
          { error: "Memory recall change plan not found" },
          { status: 404 },
        );
      }

      const metadata = pendingItem.metadata ?? {};
      const governanceAction =
        typeof metadata.governanceAction === "string"
          ? metadata.governanceAction
          : pendingItem.summary ?? pendingItem.title;
      const reason =
        typeof body?.reason === "string" && body.reason.trim()
          ? body.reason.trim()
          : status === "approved"
            ? "Owner approved dry-run memory recall change plan."
            : "Owner rejected dry-run memory recall change plan.";
      const event = await context.append({
        workshopId: id,
        type:
          status === "approved"
            ? "memory_recall_change_plan_approved"
            : "memory_recall_change_plan_rejected",
        title:
          status === "approved"
            ? "Memory recall change plan approved"
            : "Memory recall change plan rejected",
        body: governanceAction,
        visibility: "user",
        metadata: {
          changePlanReviewItemId: itemId,
          changePlanEventId: pendingItem.sourceEventId,
          planId: metadata.planId ?? null,
          planKind: metadata.planKind ?? null,
          issueKind: metadata.issueKind ?? null,
          governanceAction,
          sourceProposalReviewItemId:
            metadata.sourceProposalReviewItemId ?? null,
          sourceProposalEventId: metadata.sourceProposalEventId ?? null,
          sourceResolutionEventId: metadata.sourceResolutionEventId ?? null,
          dryRunSteps: stringList(metadata.dryRunSteps),
          rollbackPlan: stringList(metadata.rollbackPlan),
          evidenceHints: stringList(metadata.evidenceHints),
          blockedActions: stringList(metadata.blockedActions),
          resolution: status,
          resolvedBy: userId,
          reason,
          executionMode: "dry_run_plan",
          appliedMemoryMutation: false,
          requiresOwnerApproval: true,
          automaticPolicyChange: false,
          source: "workshop_review_items_api",
        },
      });

      const executionPlan =
        status === "approved"
          ? await context.append({
              workshopId: id,
              type: "memory_recall_change_execution_planned",
              title: "Memory recall change execution planned",
              body: "Dry-run execution record created. No memory mutation was executed.",
              visibility: "user",
              metadata: {
                executionId: crypto.randomUUID(),
                changePlanReviewItemId: itemId,
                changePlanEventId: pendingItem.sourceEventId,
                approvalEventId: event.id,
                planId: metadata.planId ?? null,
                planKind: metadata.planKind ?? null,
                issueKind: metadata.issueKind ?? null,
                governanceAction,
                governanceActionDetail:
                  metadata.governanceActionDetail ?? null,
                dryRunSteps: stringList(metadata.dryRunSteps),
                evidenceHints: stringList(metadata.evidenceHints),
                blockedActions: stringList(metadata.blockedActions),
                executionState: "planned",
                executionMode: "dry_run_plan",
                canExecuteAutomatically: false,
                requiresOwnerApproval: true,
                appliedMemoryMutation: false,
                automaticPolicyChange: false,
                source: "workshop_review_items_api",
              },
            })
          : null;

      const rollbackAudit =
        status === "approved"
          ? await context.append({
              workshopId: id,
              type: "memory_recall_change_plan_rollback_audit_recorded",
              title: "Memory recall change plan rollback audit recorded",
              body: "No memory mutation was executed by this dry-run approval.",
              visibility: "user",
              metadata: {
                changePlanReviewItemId: itemId,
                changePlanEventId: pendingItem.sourceEventId,
                resolutionEventId: event.id,
                executionPlanEventId: executionPlan?.id ?? null,
                planId: metadata.planId ?? null,
                planKind: metadata.planKind ?? null,
                rollbackPlan: stringList(metadata.rollbackPlan),
                rollbackRequired: false,
                appliedMemoryMutation: false,
                automaticPolicyChange: false,
                source: "workshop_review_items_api",
              },
            })
          : null;

      const item = await resolveWorkshopReviewItem({
        workshopId: id,
        itemId,
        status,
        metadata: {
          resolutionEventId: event.id,
          executionPlanEventId: executionPlan?.id ?? null,
          rollbackAuditEventId: rollbackAudit?.id ?? null,
          resolution: status,
          reason,
          executionMode: "dry_run_plan",
          appliedMemoryMutation: false,
          requiresOwnerApproval: true,
          automaticPolicyChange: false,
          source: "workshop_review_items_api",
        },
      }, context.db);

      return reply({ item, event, executionPlan, rollbackAudit });
    }

    const status = resolutionStatus(
      body?.status ?? (action === "dismiss_group" ? "dismissed" : action),
    );
    if (!status) {
      return reply(
        {
          error:
            "status/action must be approved, rejected, dismissed, or superseded",
        },
        { status: 400 },
      );
    }

    const reason =
      typeof body?.reason === "string" && body.reason.trim()
        ? body.reason.trim()
        : status === "dismissed"
          ? "Owner dismissed review item without rerun."
          : null;
    const metadata = {
      reason,
      resolvedBy: userId,
      source: "workshop_review_items_api",
    };

    if (action === "dismiss_group") {
      if (!itemId || status !== "dismissed") {
        return reply(
          {
            error:
              "dismiss_group requires itemId and dismissed status/action",
          },
          { status: 400 },
        );
      }

      const items = await resolveWorkshopServiceErrorGroupReviewItems({
        workshopId: id,
        itemId,
        status,
        metadata: {
          ...metadata,
          groupAction: "dismiss_group",
        },
      }, context.db);

      if (items.length === 0) {
        return reply(
          { error: "Review item group not found" },
          { status: 404 },
        );
      }

      return reply({ item: items[0], items });
    }

    if (!itemId && !sourceEventId) throw new WorkCommandConflict('invalid_command');
    const targets = itemId
      ? await context.db.execute(sql`SELECT status FROM workshop_review_items WHERE workshop_id=${id}::uuid AND id=${itemId}::uuid`)
      : await context.db.execute(sql`SELECT status FROM workshop_review_items WHERE workshop_id=${id}::uuid AND source_event_id=${sourceEventId}::uuid`);
    if (!targets[0]) throw new WorkCommandConflict('not_found');
    if (targets[0].status !== 'pending') throw new WorkCommandConflict('proposal_already_resolved');
    const item = itemId
      ? await resolveWorkshopReviewItem({
          workshopId: id,
          itemId,
          status,
          metadata,
        }, context.db)
      : sourceEventId
        ? await resolveWorkshopReviewItemBySourceEvent({
            workshopId: id,
            sourceEventId,
            status,
            metadata,
          }, context.db)
        : null;

    if (!item) {
      return reply(
        { error: "Review item not found" },
        { status: 404 },
      );
    }

    return reply({ item });
}
