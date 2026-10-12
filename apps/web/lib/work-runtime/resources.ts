import {
  createBrainMemoryCandidate,
  listBrainMemory,
  writeBrainMemory,
  type BrainMemory,
  type BrainMemoryType,
} from "@/lib/brain";
import { getBrainMemoryCanonicalMetadata } from "@/lib/brain/canonical";
import { shouldReadLegacyMemoryFallback } from "@/lib/brain/mode";
import {
  addWorkshopSource,
  appendWorkshopEvent,
  createOutboxDraft,
  getWorkshop,
  getWorkshopOutboxItem,
  listActiveDirectives,
  listWorkshopEvents,
  listWorkshopMemories,
  listWorkshopOutbox,
  listWorkshopSources,
  updateWorkshopOutboxItem,
} from "@/lib/workshops/service";
import {
  autoSendWorkshopOutboxIfWhitelisted,
  previewWorkshopOutboxWechat,
  sendWorkshopOutboxWechat,
} from "@/lib/workshops/outbox-wechat";
import { resolveWorkshopPermissionBoundaryReviewItem } from "@/lib/workshops/review-items";
import {approveOutboxSend} from './outbox-attempt';
import type {
  AddWorkshopSourceInput,
  CreateWorkshopOutboxDraftInput,
  WorkshopEventVisibility,
  WorkshopJson,
  WorkshopMemoryKind,
  WorkshopMemoryStatus,
  WorkshopOutboxStatus,
  WorkshopSourceType,
} from "@/lib/workshops/types";
import type { WorkCommandMeta } from "./types";

function workshopKindFromBrainMemory(memory: BrainMemory): WorkshopMemoryKind {
  switch (memory.memoryType) {
    case "boundary":
      return "boundary";
    case "preference":
      return "preference";
    case "plan":
      return "watchlist";
    case "insight":
      return "finding";
    default:
      return "finding";
  }
}

function workshopStatusFromBrainMemory(
  memory: BrainMemory,
): WorkshopMemoryStatus {
  switch (memory.status) {
    case "candidate":
      return "candidate";
    case "verified":
      return "verified";
    case "weakened":
      return "weakened";
    case "deleted":
    case "superseded":
      return "dismissed";
    default:
      return "active";
  }
}

function brainMemoryToWorkshopMemory(memory: BrainMemory, workId: string) {
  const canonical = getBrainMemoryCanonicalMetadata(memory);
  return {
    id: memory.id,
    workshopId: workId,
    kind: workshopKindFromBrainMemory(memory),
    content: memory.content,
    confidence: memory.confidence,
    tags: memory.tags ?? [],
    sourceEventIds: memory.evidenceRefs,
    expiresAt: memory.expiresAt ? new Date(memory.expiresAt) : null,
    createdAt: new Date(memory.createdAt),
    updatedAt: new Date(memory.updatedAt),
    status: workshopStatusFromBrainMemory(memory),
    canonical: {
      kind: canonical.canonicalKind,
      groupId: canonical.canonicalGroupId,
      facets: canonical.facets,
      derivedRefs: canonical.derivedRefs,
      admission: memory.metadata?.canonicalAdmission ?? null,
    },
  };
}

function brainMemoryTypeFromWorkshopKind(
  kind: WorkshopMemoryKind,
): BrainMemoryType {
  switch (kind) {
    case "boundary":
      return "boundary";
    case "preference":
      return "preference";
    case "watchlist":
      return "plan";
    case "hypothesis":
    case "finding":
    case "mistake":
    case "source_note":
    case "outbox_summary":
    default:
      return "insight";
  }
}

function brainStatusFromWorkshopStatus(
  status: WorkshopMemoryStatus | undefined,
  evidenceRefs: string[],
) {
  if (status === "candidate") return "candidate";
  if (status === "verified" && evidenceRefs.length > 0) return "verified";
  if (status === "weakened" && evidenceRefs.length > 0) return "weakened";
  if ((status === "active" || status === "confirmed") && evidenceRefs.length > 0) {
    return "active";
  }
  return "candidate";
}

function commandMetadata(meta: WorkCommandMeta) {
  return {
    commandId: meta.commandId ?? crypto.randomUUID(),
    source: meta.source ?? "owner",
    reason: meta.reason ?? null,
  };
}

async function requireWork(userId: string, workId: string) {
  const workshop = await getWorkshop(userId, workId);
  if (!workshop) {
    throw new Error("Workshop not found");
  }
  return workshop;
}

export async function assertWorkAccess(input: {
  userId: string;
  workId: string;
}) {
  return requireWork(input.userId, input.workId);
}

export async function listWorkSources(input: {
  userId: string;
  workId: string;
  limit?: number;
}) {
  await requireWork(input.userId, input.workId);
  return listWorkshopSources(input.workId, input.limit);
}

export async function listWorkDirectives(input: {
  userId: string;
  workId: string;
  limit?: number;
}) {
  await requireWork(input.userId, input.workId);
  return listActiveDirectives(input.workId, input.limit);
}

export async function addWorkSource(
  input: {
    userId: string;
    workId: string;
    type: WorkshopSourceType;
    name: string;
    uri?: string | null;
    content?: string | null;
    config?: WorkshopJson;
    enabled?: boolean;
  } & WorkCommandMeta,
) {
  const meta = commandMetadata(input);
  await requireWork(input.userId, input.workId);
  const source = await addWorkshopSource({
    workshopId: input.workId,
    type: input.type,
    name: input.name,
    uri: input.uri,
    content: input.content,
    config: {
      ...(input.config ?? {}),
      commandMeta: meta,
    },
    enabled: input.enabled,
  } satisfies AddWorkshopSourceInput);
  return { source, command: meta };
}

export async function listWorkMemories(input: {
  userId: string;
  workId: string;
  limit?: number;
  includeCandidates?: boolean;
  statuses?: WorkshopMemoryStatus[];
}) {
  await requireWork(input.userId, input.workId);
  const brainStatuses =
    input.statuses?.map((status) => {
      switch (status) {
        case "candidate":
          return "candidate" as const;
        case "verified":
          return "verified" as const;
        case "weakened":
          return "weakened" as const;
        case "dismissed":
          return "deleted" as const;
        default:
          return "active" as const;
      }
    }) ??
    (input.includeCandidates
      ? (["candidate", "active", "verified", "weakened"] as const)
      : (["active", "verified", "weakened"] as const));
  const brainMemories = await listBrainMemory({
    userId: input.userId,
    limit: input.limit ?? 50,
    statuses: [...brainStatuses],
    ownerType: "work",
    ownerId: input.workId,
  });
  if (brainMemories.length > 0) {
    return brainMemories.map((memory) =>
      brainMemoryToWorkshopMemory(memory, input.workId),
    );
  }
  if (!shouldReadLegacyMemoryFallback()) return [];
  return listWorkshopMemories(input.workId, {
    limit: input.limit,
    includeCandidates: input.includeCandidates,
    statuses: input.statuses,
  });
}

export async function addWorkMemory(
  input: {
    userId: string;
    workId: string;
    kind: WorkshopMemoryKind;
    content: string;
    confidence?: number;
    tags?: string[];
    sourceEventIds?: string[];
    expiresAt?: Date | null;
    status?: WorkshopMemoryStatus;
  } & WorkCommandMeta,
) {
  const meta = commandMetadata(input);
  const workshop = await requireWork(input.userId, input.workId);
  const evidenceRefs = input.sourceEventIds ?? [];
  const status = brainStatusFromWorkshopStatus(input.status, evidenceRefs);
  const common = {
    requester: {
      type: "chat" as const,
      userId: input.userId,
      id: "work-runtime-command",
    },
    scope: { type: "work" as const, workId: input.workId },
    ownerType: "work" as const,
    ownerId: input.workId,
    memoryType: brainMemoryTypeFromWorkshopKind(input.kind),
    subject: workshop.name,
    content: input.content,
    confidence: input.confidence,
    evidenceRefs,
    tags: [...(input.tags ?? []), `command_source:${meta.source}`],
    expiresAt: input.expiresAt?.toISOString(),
    facets: {
      sourceKind: "work_command",
      domain: "workshop",
      workId: input.workId,
      workshopKind: input.kind,
      commandSource: meta.source,
    },
  };
  const brainMemory =
    status === "candidate"
      ? await createBrainMemoryCandidate(common)
      : await writeBrainMemory({
          ...common,
          status,
        });
  await appendWorkshopEvent({
    workshopId: input.workId,
    type: "memory_written",
    title: "Brain memory written",
    body: input.content,
    metadata: {
      memoryId: brainMemory.id,
      backend: "brain",
      kind: input.kind,
      status: brainMemory.status,
      command: meta,
    },
  });
  return {
    memory: brainMemoryToWorkshopMemory(brainMemory, input.workId),
    command: meta,
  };
}

export async function listWorkOutbox(input: {
  userId: string;
  workId: string;
  limit?: number;
}) {
  await requireWork(input.userId, input.workId);
  return listWorkshopOutbox(input.workId, input.limit, true);
}

export async function createWorkOutboxDraft(
  input: {
    userId: string;
    workId: string;
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
    autoSendIfWhitelisted?: boolean;
  } & WorkCommandMeta,
) {
  const meta = commandMetadata(input);
  const workshop = await requireWork(input.userId, input.workId);
  const outbox = await createOutboxDraft({
    workshopId: input.workId,
    runId: input.runId,
    loopId: input.loopId,
    loopRunId: input.loopRunId,
    channel: input.channel,
    recipientName: input.recipientName,
    message: input.message,
    status: input.status,
    confidence: input.confidence,
    riskLevel: input.riskLevel,
    sourceEventIds: input.sourceEventIds,
    boundaryResult: {
      ...(input.boundaryResult ?? {}),
      commandMeta: meta,
    },
  } satisfies CreateWorkshopOutboxDraftInput);
  const autoSend =
    input.autoSendIfWhitelisted === false
      ? null
      : await autoSendWorkshopOutboxIfWhitelisted({ workshop, outbox });
  return { outbox, autoSend, command: meta };
}

export async function updateWorkOutboxRecipient(
  input: {
    userId: string;
    workId: string;
    outboxId: string;
    recipientName?: string | null;
  } & WorkCommandMeta,
) {
  const meta = commandMetadata(input);
  await requireWork(input.userId, input.workId);
  const outbox = await getWorkshopOutboxItem(input.workId, input.outboxId);
  if (!outbox) {
    throw new Error("Outbox item not found");
  }
  if (outbox.status === "sent") {
    throw new Error("Sent outbox items cannot be edited.");
  }

  const boundaryResult = { ...(outbox.boundaryResult ?? {}) };
  Reflect.deleteProperty(boundaryResult, "wechatPreview");
  const updated = await updateWorkshopOutboxItem(input.workId, input.outboxId, {
    recipientName: input.recipientName ?? null,
    status: "draft",
    boundaryResult: {
      ...boundaryResult,
      recipientUpdatedAt: new Date().toISOString(),
      commandMeta: meta,
    },
  });
  await resolveWorkshopPermissionBoundaryReviewItem({
    workshopId: input.workId,
    outboxId: input.outboxId,
    status: "superseded",
    metadata: {
      reason: "Outbox recipient was edited by owner.",
      recipientName: input.recipientName ?? null,
      command: "updateWorkOutboxRecipient",
      commandMeta: meta,
    },
  });
  return { outbox: updated, command: meta };
}

export async function previewWorkOutbox(input: {
  userId: string;
  workId: string;
  outboxId: string;
}) {
  const workshop = await requireWork(input.userId, input.workId);
  const outbox = await getWorkshopOutboxItem(input.workId, input.outboxId);
  if (!outbox) {
    throw new Error("Outbox item not found");
  }
  return previewWorkshopOutboxWechat({ workshop, outbox, auditActorId: input.userId });
}

export async function sendWorkOutbox(
  input: {
    userId: string;
    workId: string;
    outboxId: string;
    expectedContentHash?: string;
  } & WorkCommandMeta,
) {
  const meta = commandMetadata(input);
  const workshop = await requireWork(input.userId, input.workId);
  const outbox = await getWorkshopOutboxItem(input.workId, input.outboxId);
  if (!outbox) {
    throw new Error("Outbox item not found");
  }
  if (!["pending_approval","approved","sending","unknown","sent"].includes(outbox.status)) {
    throw new Error("Outbox item must be previewed before sending.");
  }
  if(!input.expectedContentHash)throw new Error('Preview the current content before confirming send.');
  if(['pending_approval','approved'].includes(outbox.status))await approveOutboxSend({userId:input.userId,workId:input.workId,outboxId:input.outboxId,expectedContentHash:input.expectedContentHash});
  const result = await sendWorkshopOutboxWechat({ workshop, outbox, auditActorId: input.userId });
  const resultRecord =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {};
  const failureMessage =
    typeof resultRecord.error === "string"
      ? resultRecord.error
      : typeof resultRecord.message === "string"
        ? resultRecord.message
        : "Outbox send failed";
  const unresolved=['sending','unknown'].includes(String(resultRecord.attemptStatus));
  await appendWorkshopEvent({
    workshopId: input.workId,
    type: result.ok ? "work_outbox_send_requested" : unresolved?"work_outbox_send_unknown":"work_outbox_send_failed",
    title: result.ok ? "Outbox send requested" : unresolved?"发送结果待核对":"Outbox send failed",
    body: result.ok ? outbox.message : failureMessage,
    metadata: {
      outboxId: input.outboxId,
      result,
      commandMeta: meta,
    },
  });
  return { ...result, command: meta };
}

export async function listWorkEvents(input: {
  userId: string;
  workId: string;
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
  order?: "asc" | "latest";
  runId?: string;
}) {
  await requireWork(input.userId, input.workId);
  return listWorkshopEvents(input.workId, {
    afterSeq: input.afterSeq,
    beforeSeq: input.beforeSeq,
    limit: input.limit,
    order: input.order,
    runId: input.runId,
  });
}

export async function appendWorkEvent(
  input: {
    userId: string;
    workId: string;
    runId?: string | null;
    loopId?: string | null;
    loopRunId?: string | null;
    type: string;
    title: string;
    body?: string | null;
    metadata?: WorkshopJson;
    visibility?: WorkshopEventVisibility;
  } & WorkCommandMeta,
) {
  const meta = commandMetadata(input);
  await requireWork(input.userId, input.workId);
  const event = await appendWorkshopEvent({
    workshopId: input.workId,
    runId: input.runId,
    loopId: input.loopId,
    loopRunId: input.loopRunId,
    type: input.type,
    title: input.title,
    body: input.body,
    metadata: {
      ...(input.metadata ?? {}),
      commandMeta: meta,
    },
    visibility: input.visibility,
  });
  return { event, command: meta };
}
