import type { WorkshopEvent } from "@/lib/db/schema";
import type { WorkshopWriteContext } from "./service";
import { appendWorkshopEvent, getWorkshop } from "./service";
import { upsertWorkshopReviewItemFromProposalEvent } from "./review-items";
import type { WorkshopJson } from "./types";

export type WorkshopInsightChangeAction = "create" | "modify" | "delete";

export type WorkshopInsightChangeProposalInput = {
  userId: string;
  workshopId: string;
  action: WorkshopInsightChangeAction;
  reason: string;
  title?: string;
  targetInsightId?: string;
  requestedChange?: WorkshopJson;
  riskLevel?: "low" | "medium" | "high";
  proposedBy?: "chat_agent" | "workshop_agent" | "system";
  source?: WorkshopJson;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeChange(value: unknown): WorkshopJson {
  return isRecord(value) ? (value as WorkshopJson) : {};
}

function normalizeAction(value: WorkshopInsightChangeAction) {
  if (value === "create" || value === "modify" || value === "delete") {
    return value;
  }
  throw new Error("action must be one of create, modify, or delete.");
}

function inferRiskLevel(action: WorkshopInsightChangeAction) {
  if (action === "delete") return "high" as const;
  if (action === "modify") return "medium" as const;
  return "low" as const;
}

function actionLabel(action: WorkshopInsightChangeAction) {
  if (action === "create") return "创建";
  if (action === "modify") return "修改";
  return "删除";
}

export async function proposeWorkshopInsightChange(
  input: WorkshopInsightChangeProposalInput,
  context?: WorkshopWriteContext,
): Promise<WorkshopEvent> {
  const workshop = await getWorkshop(input.userId, input.workshopId, context?.db);
  if (!workshop) {
    throw new Error("Workshop not found");
  }

  const action = normalizeAction(input.action);
  const reason = sanitizeText(input.reason);
  if (reason.length < 6) {
    throw new Error("A proposal reason of at least 6 characters is required.");
  }

  const targetInsightId = sanitizeText(input.targetInsightId);
  if ((action === "modify" || action === "delete") && !targetInsightId) {
    throw new Error("targetInsightId is required for modify and delete proposals.");
  }

  const requestedChange = sanitizeChange(input.requestedChange);
  const proposedTitle =
    sanitizeText(input.title) ||
    sanitizeText(requestedChange.title) ||
    (targetInsightId ? `Insight ${targetInsightId}` : "New insight");

  const event = await (context?.append ?? appendWorkshopEvent)({
    workshopId: workshop.id,
    type: "workshop_insight_change_proposed",
    title: `Insight ${actionLabel(action)}提案：${proposedTitle}`,
    body: reason,
    metadata: {
      kind: "insight_change_proposal",
      status: "pending_owner_review",
      proposedBy: input.proposedBy ?? "chat_agent",
      action,
      reason,
      proposedTitle,
      targetInsightId: targetInsightId || null,
      requestedChange,
      riskLevel: input.riskLevel ?? inferRiskLevel(action),
      source: input.source ?? {},
      appliesAutomatically: false,
      requiresOwnerReview: true,
    },
  });

  await upsertWorkshopReviewItemFromProposalEvent(event, context?.db);
  return event;
}
