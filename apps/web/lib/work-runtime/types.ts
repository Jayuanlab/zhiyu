import type {
  Loop,
  Workshop,
  WorkshopHeartbeat,
  WorkshopWorkVersion,
} from "@/lib/db/schema";
import type { LoopRunHarnessMode } from "@/lib/loops/harness";
import type { LoopTemplateId, NaturalLanguageLoopDraft } from "@/lib/loops";
import type { UpdateLoopInput } from "@/lib/loops/types";
import type { WorkshopDashboard, WorkshopDashboardSummary } from "@/lib/workshops/dashboard";
import type { WorkshopWorkModel } from "@/lib/workshops/work-model";
import type {
  CreateWorkshopInput,
  UpdateWorkshopInput,
  WorkshopHeartbeatPolicy,
  WorkshopJson,
} from "@/lib/workshops/types";

export const WORK_RUNTIME_INTERFACE_VERSION = "work-runtime.v2";

export type WorkCommandSource =
  | "owner"
  | "chat_agent"
  | "workshop_agent"
  | "loop_runtime"
  | "system";

export interface WorkCommandMeta {
  commandId?: string;
  expectedVersion?: number;
  source?: WorkCommandSource;
  reason?: string | null;
}

export interface WorkListSnapshot {
  interfaceVersion: typeof WORK_RUNTIME_INTERFACE_VERSION;
  generatedAt: string;
  works: WorkshopDashboardSummary[];
}

export interface WorkSnapshot {
  interfaceVersion: typeof WORK_RUNTIME_INTERFACE_VERSION;
  generatedAt: string;
  workId: string;
  detail: {
    workshop: Workshop;
    heartbeat: WorkshopHeartbeat | null;
    loops: Loop[];
    sources: unknown[];
    memories: unknown[];
    outbox: unknown[];
    runs: unknown[];
    events: unknown[];
  };
  dashboard: WorkshopDashboard | null;
  work: WorkshopWorkModel;
  versions: WorkshopWorkVersion[];
}

export interface WorkSummarySnapshot {
  interfaceVersion: typeof WORK_RUNTIME_INTERFACE_VERSION;
  generatedAt: string;
  workId: string;
  detail: {
    /** Missing on pre-upgrade cached views; never assume zero for editing. */
    commandVersion?: number;
    workshop: Workshop;
    heartbeat: WorkshopHeartbeat | null;
    loops: Loop[];
    sources: unknown[];
    memories: unknown[];
    outbox: unknown[];
    runs: unknown[];
    events: unknown[];
  };
  dashboard: WorkshopDashboard;
}

export interface WorkModelSnapshot {
  interfaceVersion: typeof WORK_RUNTIME_INTERFACE_VERSION;
  generatedAt: string;
  work: WorkshopWorkModel;
  versions: WorkshopWorkVersion[];
}

export interface CreateWorkCommand extends WorkCommandMeta {
  input: CreateWorkshopInput;
}

export interface UpdateWorkCommand extends WorkCommandMeta {
  userId: string;
  workId: string;
  patch: UpdateWorkshopInput & {
    heartbeat?: {
      enabled?: boolean;
      mode?: "suggested" | "fixed_interval" | "cron";
      nextWakeupAt?: Date | null;
      heartbeatPolicy?: WorkshopHeartbeatPolicy;
    };
  };
}

export interface DeleteWorkCommand extends WorkCommandMeta {
  userId: string;
  workId: string;
}

export interface StartWorkRunCommand extends WorkCommandMeta {
  userId: string;
  workId: string;
  triggerReason?: WorkshopJson;
}

export interface AddWorkDirectiveCommand extends WorkCommandMeta {
  userId: string;
  workId: string;
  content: string;
  priority?: number;
  scope?: "current_run" | "persistent";
  runId?: string | null;
  triggerRun?: boolean;
  triggerReason?: WorkshopJson;
}

export interface CreateWorkLoopCommand extends WorkCommandMeta {
  userId: string;
  workId: string;
  type?: "template" | "natural_language";
  templateId?: LoopTemplateId;
  templateInput?: Record<string, unknown>;
  intent?: string;
  timezone?: string;
  externalWriteMode?: "manual_approval" | "loop_approved";
  create?: boolean;
}

export interface WorkLoopDraftResult {
  workshop: Workshop;
  draft: NaturalLanguageLoopDraft;
}

export interface WorkLoopCreatedResult {
  workshop: Workshop;
  loop: Loop;
  draft?: NaturalLanguageLoopDraft;
}

export interface UpdateWorkLoopActivationCommand extends WorkCommandMeta {
  userId: string;
  workId: string;
  loopId: string;
  action: "activate" | "reject";
  rejectionReason?: string | null;
}

export interface UpdateWorkLoopCommand extends WorkCommandMeta {
  userId: string;
  workId: string;
  loopId: string;
  patch: UpdateLoopInput;
}

export interface RunWorkLoopCommand extends WorkCommandMeta {
  userId: string;
  workId: string;
  loopId: string;
  mode?: LoopRunHarnessMode;
  dryRun?: boolean;
  createOutboxDrafts?: boolean;
}

export interface RestoreWorkVersionCommand extends WorkCommandMeta {
  userId: string;
  workId: string;
  versionId: string;
}
