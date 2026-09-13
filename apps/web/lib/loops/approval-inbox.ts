import type { Loop, LoopApprovalRequest, LoopRun } from "@/lib/db/schema";
import {
  listLoopApprovalRequests,
  listLoopRuns,
  listLoops,
} from "./service";

export type LoopApprovalInboxItemStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "superseded"
  | "consumed"
  | "denied";

export interface LoopApprovalInboxItem {
  id: string;
  loopId: string;
  loopName: string;
  runId: string;
  status: LoopApprovalInboxItemStatus;
  actionName: string;
  capability: string | null;
  reason: string | null;
  message: string | null;
  source: "tool_gate" | "approval";
  startedAt: Date | null;
  completedAt: Date | null;
  resolvedAt?: Date | null;
  continuationStatus?: "ready" | "not_resumable" | "consumed" | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function itemStatus(decision: string | unknown): LoopApprovalInboxItemStatus | null {
  if (decision === "require_approval") return "pending";
  if (decision === "deny") return "denied";
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function requestStatus(
  status: string,
): Exclude<LoopApprovalInboxItemStatus, "denied"> {
  if (status === "approved" || status === "rejected" || status === "superseded") {
    return status;
  }
  return "pending";
}

export function mapLoopApprovalRequestToInboxItem(input: {
  request: LoopApprovalRequest;
  loopName: string;
}): LoopApprovalInboxItem {
  const actionPayload = asRecord(input.request.actionPayload);
  const continuation = asRecord(actionPayload.continuation);
  const continuationStatus =
    continuation.status === "ready" ||
    continuation.status === "not_resumable" ||
    continuation.status === "consumed"
      ? continuation.status
      : null;

  return {
    id: input.request.id,
    loopId: input.request.loopId,
    loopName: input.loopName,
    runId: input.request.loopRunId,
    status: requestStatus(input.request.status),
    actionName: input.request.actionName,
    capability: input.request.capability,
    reason: input.request.reason,
    message: input.request.message,
    source:
      input.request.source === "approval" ? "approval" : "tool_gate",
    startedAt: input.request.createdAt,
    completedAt: input.request.resolvedAt,
    resolvedAt: input.request.resolvedAt,
    continuationStatus,
  };
}

export function summarizeLoopApprovalInboxItems(input: {
  loop: Pick<Loop, "id" | "name">;
  run: LoopRun;
}): LoopApprovalInboxItem[] {
  const verification = asRecord(input.run.verificationResult);
  const approval = asRecord(verification.approval);
  const toolGate = asRecord(verification.toolGate);
  const items: LoopApprovalInboxItem[] = [];

  asArray(toolGate.decisions).forEach((rawDecision, index) => {
    const decision = asRecord(rawDecision);
    const status = itemStatus(decision.decision);
    if (!status) return;

    items.push({
      id: `${input.run.id}:tool_gate:${index}`,
      loopId: input.loop.id,
      loopName: input.loop.name,
      runId: input.run.id,
      status,
      actionName: stringOrNull(decision.actionName) ?? "Unknown action",
      capability: stringOrNull(decision.capability),
      reason: stringOrNull(decision.reason),
      message: stringOrNull(decision.message),
      source: "tool_gate",
      startedAt: input.run.startedAt,
      completedAt: input.run.completedAt,
    });
  });

  asArray(approval.decisions).forEach((rawDecision, index) => {
    const decision = asRecord(rawDecision);
    const status = itemStatus(decision.decision);
    if (!status) return;

    const duplicate = items.some(
      (item) =>
        item.actionName === decision.actionName && item.status === status,
    );
    if (duplicate) return;

    items.push({
      id: `${input.run.id}:approval:${index}`,
      loopId: input.loop.id,
      loopName: input.loop.name,
      runId: input.run.id,
      status,
      actionName: stringOrNull(decision.actionName) ?? "Unknown action",
      capability: stringOrNull(decision.capability),
      reason: stringOrNull(decision.reason),
      message: null,
      source: "approval",
      startedAt: input.run.startedAt,
      completedAt: input.run.completedAt,
    });
  });

  return items;
}

export async function listLoopApprovalInbox(
  userId: string,
  options: { limit?: number } = {},
): Promise<{
  items: LoopApprovalInboxItem[];
  counts: Record<LoopApprovalInboxItemStatus, number>;
}> {
  const loops = await listLoops(userId, { limit: 200 });
  const loopNameById = new Map(loops.map((loop) => [loop.id, loop.name]));
  const requests = await listLoopApprovalRequests(userId, {
    limit: options.limit ?? 100,
  });
  const items: LoopApprovalInboxItem[] = [];

  items.push(
    ...requests.map((request) =>
      mapLoopApprovalRequestToInboxItem({
        request,
        loopName: loopNameById.get(request.loopId) ?? "Unknown loop",
      }),
    ),
  );

  for (const loop of loops) {
    const runs = await listLoopRuns(loop.id, { limit: 25 });
    for (const run of runs) {
      const legacyItems = summarizeLoopApprovalInboxItems({ loop, run });
      items.push(
        ...legacyItems.filter(
          (legacyItem) =>
            legacyItem.status === "denied" ||
            !items.some(
              (item) =>
                item.runId === legacyItem.runId &&
                item.actionName === legacyItem.actionName &&
                item.status === legacyItem.status,
            ),
        ),
      );
    }
  }

  const sortedItems = items
    .sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0))
    .slice(0, options.limit ?? 100);

  return {
    items: sortedItems,
    counts: {
      pending: sortedItems.filter((item) => item.status === "pending").length,
      approved: sortedItems.filter((item) => item.status === "approved").length,
      rejected: sortedItems.filter((item) => item.status === "rejected").length,
      superseded: sortedItems.filter((item) => item.status === "superseded")
        .length,
      consumed: sortedItems.filter(
        (item) => item.continuationStatus === "consumed",
      ).length,
      denied: sortedItems.filter((item) => item.status === "denied").length,
    },
  };
}
