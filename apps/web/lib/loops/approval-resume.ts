import type { JobExecutionResult } from "@/lib/cron/types";
import type { LoopApprovalRequest } from "@/lib/db/schema";
import type {
  LoopApprovalContinuation,
  LoopApprovalContinuationConsumption,
  LoopJson,
} from "./types";

function asRecord(value: unknown): LoopJson | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as LoopJson)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isContinuation(value: unknown): value is LoopApprovalContinuation {
  const record = asRecord(value);
  return (
    record?.type === "tool_call" &&
    typeof record.approvalRequestId === "string" &&
    typeof record.actionName === "string"
  );
}

export function getApprovalRequestContinuation(
  request: LoopApprovalRequest,
): LoopApprovalContinuation | null {
  const actionPayload = asRecord(request.actionPayload);
  const continuation = actionPayload?.continuation;
  return isContinuation(continuation) ? continuation : null;
}

export function findPendingApprovalContinuation(input: {
  stateJson: LoopJson;
  approvalRequestId: string;
}): LoopApprovalContinuation | null {
  const found = asArray(input.stateJson.pendingApprovalContinuations).find(
    (item) =>
      isContinuation(item) &&
      item.approvalRequestId === input.approvalRequestId,
  );

  return isContinuation(found) ? found : null;
}

export function consumeApprovalContinuationState(input: {
  stateJson: LoopJson;
  continuation: LoopApprovalContinuation;
  consumedBy: string;
  consumedAt?: Date;
  note?: string | null;
}): LoopJson {
  const consumedAt = (input.consumedAt ?? new Date()).toISOString();
  const consumedContinuation: LoopApprovalContinuation = {
    ...input.continuation,
    status: "consumed",
  };
  const consumption: LoopApprovalContinuationConsumption = {
    continuation: consumedContinuation,
    consumedBy: input.consumedBy,
    consumedAt,
    result: "recorded",
    note: input.note ?? null,
  };

  return {
    ...input.stateJson,
    pendingApprovalContinuations: asArray(
      input.stateJson.pendingApprovalContinuations,
    ).filter(
      (item) =>
        !(
          isContinuation(item) &&
          item.approvalRequestId === input.continuation.approvalRequestId
        ),
    ),
    consumedApprovalContinuations: [
      ...asArray(input.stateJson.consumedApprovalContinuations),
      consumption,
    ],
    lastConsumedApprovalRequestId: input.continuation.approvalRequestId,
  };
}

export function buildLoopApprovalResumeResult(input: {
  continuation: LoopApprovalContinuation;
  note?: string | null;
}): JobExecutionResult {
  return {
    status: "success",
    duration: 0,
    output: `Approved continuation recorded for ${input.continuation.actionName}.`,
    result: {
      executionMode: "approval_continuation_resume",
      continuation: input.continuation,
      structuredReport: {
        summary: `Approval continuation recorded for ${input.continuation.actionName}.`,
        subtitle: "No external tool call was executed by this resume step.",
        outcome:
          "The approved continuation was consumed and recorded as a durable approval receipt.",
        reasoningChain: [
          {
            stepType: "input",
            summary: "Loaded approved continuation",
            description: input.continuation.reason ?? input.continuation.actionName,
            sourceType: "system",
            sourceLabel: "Loop approval",
          },
          {
            stepType: "action",
            summary: "Consumed continuation",
            description:
              input.note ??
              "Continuation was marked consumed for a later replay executor.",
            sourceType: "system",
            sourceLabel: "Loop runtime",
          },
        ],
        suggestedActions: [],
      },
    },
  };
}

export {resumeLoopApprovalCommand as resumeLoopApprovalContinuation,replayLoopApprovalCommand as replayLoopApprovalContinuation} from "./approval-command";
