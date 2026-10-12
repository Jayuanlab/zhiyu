import type {
  Loop,
  LoopApprovalRequest,
  LoopRun,
  LoopState,
  ScheduledJob,
} from "@/lib/db/schema";
import type { JobExecutionContext, JobExecutionResult } from "@/lib/cron/types";
import type { BrainRequester } from "@/lib/brain/types";

export type LoopStatus = "active" | "paused" | "archived" | "error";

export type LoopRunStatus =
  | "queued"
  | "running"
  | "cancelled"
  | "needs_review"
  | "success"
  | "failed"
  | "blocked"
  | "needs_approval";

export type LoopJson = Record<string, unknown>;

export type LoopApprovalRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "superseded";

export interface CreateLoopInput {
  userId: string;
  workshopId?: string | null;
  name: string;
  goal: string;
  description?: string | null;
  status?: LoopStatus;
  triggerConfig?: LoopJson;
  contextConfig?: LoopJson;
  actionPolicy?: LoopJson;
  verificationConfig?: LoopJson;
  approvalPolicy?: LoopJson;
  retryPolicy?: LoopJson;
  escalationPolicy?: LoopJson;
  initialState?: Partial<LoopStateInput>;
  memoryDependencies?: Array<{ memoryId: string; expectedVersion: string }>;
  memoryRequester?: BrainRequester;
}

export interface UpdateLoopInput {
  workshopId?: string | null;
  name?: string;
  goal?: string;
  description?: string | null;
  status?: LoopStatus;
  triggerConfig?: LoopJson;
  contextConfig?: LoopJson;
  actionPolicy?: LoopJson;
  verificationConfig?: LoopJson;
  approvalPolicy?: LoopJson;
  retryPolicy?: LoopJson;
  escalationPolicy?: LoopJson;
}

export interface CreateLoopRunInput {
  loopId: string;
  status?: LoopRunStatus;
  triggerReason?: LoopJson | null;
  inputSnapshot?: LoopJson | null;
}

export interface CompleteLoopRunInput {
  status: Exclude<LoopRunStatus, "running" | "queued">;
  outputSummary?: string | null;
  verificationResult?: LoopJson | null;
  error?: string | null;
  completedAt?: Date;
}

export interface CreateLoopApprovalRequestInput {
  loopId: string;
  loopRunId: string;
  userId: string;
  status?: LoopApprovalRequestStatus;
  source?: "tool_gate" | "approval";
  actionName: string;
  capability?: string | null;
  reason?: string | null;
  message?: string | null;
  toolInput?: LoopJson | null;
  actionPayload?: LoopJson | null;
}

export interface ResolveLoopApprovalRequestInput {
  status: Exclude<LoopApprovalRequestStatus, "pending">;
  resolvedBy: string;
  resolutionNote?: string | null;
  actionPayload?: LoopJson | null;
}

export interface LoopApprovalContinuation {
  type: "tool_call";
  status: "ready" | "not_resumable" | "consumed";
  approvalRequestId: string;
  loopId: string;
  loopRunId: string;
  actionName: string;
  capability: string | null;
  toolUseID: string | null;
  toolInput: LoopJson | null;
  approvedBy: string;
  approvedAt: string;
  resumeMode: "manual_review" | "agent_replay";
  reason: string | null;
}

export interface LoopApprovalContinuationConsumption {
  continuation: LoopApprovalContinuation;
  consumedBy: string;
  consumedAt: string;
  result: "recorded" | "skipped";
  note: string | null;
}

export interface LoopApprovalReplayPlan {
  status: "ready" | "blocked";
  approvalRequestId: string;
  actionName: string;
  idempotencyKey: string;
  confirmationRequired: boolean;
  confirmationToken: string | null;
  reason: string | null;
}

export interface LoopApprovalReplayResult {
  status: "success" | "blocked" | "failed";
  approvalRequestId: string;
  actionName: string;
  idempotencyKey: string;
  outputSummary: string;
  adapterResult?: LoopJson | null;
  reason?: string | null;
}

export interface LoopStateInput {
  currentPhase: string;
  memorySummary: string | null;
  openQuestions: unknown[];
  lastObservation: string | null;
  nextAction: string | null;
  blockedReason: string | null;
  stateJson: LoopJson;
}

export type NormalizedLoop = Loop;
export type NormalizedLoopRun = LoopRun;
export type NormalizedLoopState = LoopState;
export type NormalizedLoopApprovalRequest = LoopApprovalRequest;

export interface RunLoopTriggerContext {
  userId: string;
  triggeredBy: "scheduler" | "manual" | "api";
  reason?: LoopJson;
  inputSnapshot?: LoopJson;
  executionId?: string;
}

export interface RunScheduledJobLoopInput {
  job: ScheduledJob;
  context: JobExecutionContext;
  jobConfigStr: string;
  jobDescription?: string;
  execute: () => Promise<JobExecutionResult>;
}

export interface RunNativeLoopInput {
  userId: string;
  loopId: string;
  commandId?: string;
  expectedVersion?: number;
  triggeredBy: "scheduler" | "manual" | "api";
  reason?: LoopJson;
  execute?: (context: {
    abortController?: AbortController;
    loop: Loop;
    previousState: LoopState | null;
    loopRun: LoopRun;
    attemptContext?: {
      attemptNumber: number;
      maxAttempts: number;
      previousFeedback?: string | null;
      previousResult?: LoopJson | null;
    };
  }) => Promise<JobExecutionResult>;
}
