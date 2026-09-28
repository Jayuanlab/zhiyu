import type { Loop } from "@/lib/db/schema";
import type { UpdateLoopInput } from "@/lib/loops/types";
import { getLoopInWorkshop } from "@/lib/loops";
import { appendWorkshopEvent, getWorkshop } from "./service";
import type { WorkshopEvent } from "@/lib/db/schema";
import { upsertWorkshopReviewItemFromProposalEvent } from "./review-items";

export type WorkshopLoopChangeAction = "update" | "archive";

export type WorkshopLoopChangePatch = Pick<
  UpdateLoopInput,
  | "name"
  | "goal"
  | "description"
  | "status"
  | "triggerConfig"
  | "contextConfig"
  | "actionPolicy"
  | "verificationConfig"
  | "approvalPolicy"
  | "retryPolicy"
  | "escalationPolicy"
>;

export interface ProposeWorkshopLoopChangeInput {
  userId: string;
  workshopId: string;
  loopId: string;
  action: WorkshopLoopChangeAction;
  patch?: WorkshopLoopChangePatch;
  reason: string;
  riskLevel?: "low" | "medium" | "high";
  proposedBy?: "chat_agent" | "workshop_agent" | "owner";
  source?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeStatus(value: unknown) {
  return value === "active" ||
    value === "paused" ||
    value === "archived" ||
    value === "error"
    ? value
    : undefined;
}

export function normalizeWorkshopLoopChangePatch(
  value: unknown,
): WorkshopLoopChangePatch {
  const record = isRecord(value) ? value : {};
  const patch: WorkshopLoopChangePatch = {};
  const name = stringValue(record.name);
  if (name) patch.name = name;
  const goal = stringValue(record.goal);
  if (goal) patch.goal = goal;
  if (typeof record.description === "string") {
    patch.description = record.description.trim() || null;
  }
  const status = normalizeStatus(record.status);
  if (status) patch.status = status;
  const triggerConfig = jsonObject(record.triggerConfig);
  if (triggerConfig) patch.triggerConfig = triggerConfig;
  const contextConfig = jsonObject(record.contextConfig);
  if (contextConfig) patch.contextConfig = contextConfig;
  const actionPolicy = jsonObject(record.actionPolicy);
  if (actionPolicy) patch.actionPolicy = actionPolicy;
  const verificationConfig = jsonObject(record.verificationConfig);
  if (verificationConfig) patch.verificationConfig = verificationConfig;
  const approvalPolicy = jsonObject(record.approvalPolicy);
  if (approvalPolicy) patch.approvalPolicy = approvalPolicy;
  const retryPolicy = jsonObject(record.retryPolicy);
  if (retryPolicy) patch.retryPolicy = retryPolicy;
  const escalationPolicy = jsonObject(record.escalationPolicy);
  if (escalationPolicy) patch.escalationPolicy = escalationPolicy;
  return patch;
}

function patchChangedFields(patch: WorkshopLoopChangePatch) {
  return Object.keys(patch).filter((key) => key !== "workshopId");
}

function summarizeLoop(loop: Loop) {
  return {
    id: loop.id,
    name: loop.name,
    status: loop.status,
    goal: loop.goal,
    triggerConfig: loop.triggerConfig,
  };
}

export async function proposeWorkshopLoopChange(
  input: ProposeWorkshopLoopChangeInput,
): Promise<WorkshopEvent> {
  const workshop = await getWorkshop(input.userId, input.workshopId);
  if (!workshop) throw new Error("Workshop not found");
  const loop = await getLoopInWorkshop({
    userId: input.userId,
    workshopId: input.workshopId,
    loopId: input.loopId,
  });
  if (!loop) throw new Error("Loop not found");

  const reason = input.reason.trim();
  if (reason.length < 6) {
    throw new Error("A Loop change proposal reason of at least 6 characters is required.");
  }
  const normalizedPatch =
    input.action === "archive"
      ? { status: "archived" as const }
      : normalizeWorkshopLoopChangePatch(input.patch);
  const changedFields = patchChangedFields(normalizedPatch);
  if (changedFields.length === 0) {
    throw new Error("A Loop change proposal must include at least one safe field to update.");
  }
  if (
    "workshopId" in normalizedPatch &&
    normalizedPatch.workshopId !== undefined
  ) {
    throw new Error("Loop transfer is not supported by Loop change proposals.");
  }

  const event = await appendWorkshopEvent({
    workshopId: input.workshopId,
    loopId: input.loopId,
    type: "workshop_loop_change_proposed",
    title:
      input.action === "archive"
        ? `Loop archive proposed: ${loop.name}`
        : `Loop change proposed: ${loop.name}`,
    body: reason,
    metadata: {
      kind: "loop_change_proposal",
      status: "pending_owner_review",
      action: input.action,
      loopId: input.loopId,
      loop: summarizeLoop(loop),
      patch: normalizedPatch,
      changedFields,
      reason,
      riskLevel: input.riskLevel ?? (input.action === "archive" ? "medium" : "low"),
      proposedBy: input.proposedBy ?? "chat_agent",
      source: input.source ?? {},
      appliesAutomatically: false,
      requiresOwnerReview: true,
      destructive: input.action === "archive",
    },
  });
  await upsertWorkshopReviewItemFromProposalEvent(event);
  return event;
}
