export type WorkshopStatus = "active" | "paused" | "archived";

export type WorkshopAutonomyLevel = "observe" | "draft" | "auto";

export type WorkshopRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "paused"
  | "failed"
  | "interrupted"
  | "needs_review"
  | "cancelled";

export type WorkshopSourceType =
  | "url"
  | "rss"
  | "file"
  | "manual"
  | "knowledge"
  | "connector";

export type WorkshopDirectiveScope = "current_run" | "persistent";

export type WorkshopDirectiveStatus = "active" | "consumed" | "archived";

export type WorkshopMemoryKind =
  | "finding"
  | "hypothesis"
  | "watchlist"
  | "preference"
  | "boundary"
  | "source_note"
  | "mistake"
  | "outbox_summary";

export type WorkshopMemoryStatus =
  | "candidate"
  | "active"
  | "verified"
  | "weakened"
  | "confirmed"
  | "dismissed";

export type WorkshopOutboxStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "sent"
  | "rejected"
  | "blocked"
  | "failed";

export type WorkshopHeartbeatMode = "suggested" | "fixed_interval" | "cron";

export type WorkshopHeartbeatSchedulerStatus =
  | "idle"
  | "reserved"
  | "running"
  | "paused"
  | "error";

export type WorkshopEventVisibility = "user" | "debug";

export type WorkshopJson = Record<string, unknown>;

export interface CreateWorkshopInput {
  userId: string;
  name: string;
  mission: string;
  status?: WorkshopStatus;
  autonomyLevel?: WorkshopAutonomyLevel;
  boundaryPolicy?: WorkshopJson;
  modelConfig?: WorkshopJson;
}

export interface UpdateWorkshopInput {
  name?: string;
  mission?: string;
  status?: WorkshopStatus;
  autonomyLevel?: WorkshopAutonomyLevel;
  boundaryPolicy?: WorkshopJson;
  modelConfig?: WorkshopJson;
  changeSource?: string;
  changeEventId?: string | null;
  recordWorkVersion?: boolean;
}

export interface CreateWorkshopRunInput {
  workshopId: string;
  id?: string;
  status?: "queued" | "running";
  triggerReason?: WorkshopJson;
  ccSessionId?: string | null;
  inputSnapshot?: WorkshopJson;
}

export interface CompleteWorkshopRunInput {
  lease?: import('@/lib/work-runtime/execution-lease').ExecutionLease;
  userId: string;
  workshopId: string;
  runId: string;
  status: "completed" | "failed" | "interrupted" | "cancelled" | "needs_review";
  outputSummary?: string | null;
  error?: string | null;
  directiveIds?: string[];
  sourceMemoryIds?: string[];
  metadata?: WorkshopJson;
}

export interface AppendWorkshopEventInput {
  workshopId: string;
  runId?: string | null;
  loopId?: string | null;
  loopRunId?: string | null;
  type: string;
  title: string;
  body?: string | null;
  metadata?: WorkshopJson;
  visibility?: WorkshopEventVisibility;
}

export interface AddWorkshopSourceInput {
  workshopId: string;
  type: WorkshopSourceType;
  name: string;
  uri?: string | null;
  content?: string | null;
  config?: WorkshopJson;
  enabled?: boolean;
}

export interface AddWorkshopDirectiveInput {
  workshopId: string;
  runId?: string | null;
  content: string;
  priority?: number;
  scope?: WorkshopDirectiveScope;
}

export interface AddWorkshopMemoryInput {
  workshopId: string;
  kind: WorkshopMemoryKind;
  content: string;
  confidence?: number;
  tags?: string[];
  sourceEventIds?: string[];
  expiresAt?: Date | null;
  status?: WorkshopMemoryStatus;
}

export interface CreateWorkshopOutboxDraftInput {
  workshopId: string;
  runId?: string | null;
  loopId?: string | null;
  loopRunId?: string | null;
  channel?: "wechat_desktop";
  recipientName?: string | null;
  message: string;
  status?: WorkshopOutboxStatus;
  confidence?: number;
  riskLevel?: "low" | "medium" | "high";
  sourceEventIds?: string[];
  boundaryResult?: WorkshopJson;
}

export interface WorkshopHeartbeatPolicy extends WorkshopJson {
  minIntervalMinutes?: number;
  maxIntervalMinutes?: number;
  defaultDelayMinutes?: number;
  allowAgentSuggestedWakeup?: boolean;
  missedRunGraceMinutes?: number;
  leaseMinutes?: number;
  maxConsecutiveFailures?: number;
}

export interface UpsertWorkshopHeartbeatInput {
  enabled?: boolean;
  mode?: WorkshopHeartbeatMode;
  nextWakeupAt?: Date | null;
  lastWakeupAt?: Date | null;
  lastHeartbeatAt?: Date | null;
  schedulerStatus?: WorkshopHeartbeatSchedulerStatus;
  schedulerError?: string | null;
  consecutiveFailures?: number;
  leaseUntil?: Date | null;
  heartbeatPolicy?: WorkshopHeartbeatPolicy;
}
