import type { Workshop, WorkshopEvent } from "@/lib/db/schema";
import {
  appendWorkshopEvent,
  createWorkshopWorkVersionSnapshot,
  getWorkshop,
  getWorkshopEvent,
  listWorkshopEvents,
  updateWorkshop,
} from "./service";
import {
  resolveWorkshopReviewItemBySourceEvent,
  upsertWorkshopReviewItemFromProposalEvent,
} from "./review-items";
import type { UpdateWorkshopInput, WorkshopJson } from "./types";

export type WorkshopAgentChangeAction = "apply" | "reject" | "recreate";

export type WorkshopAgentChangePatch = {
  name?: string;
  mission?: string;
  status?: "active" | "paused" | "archived";
  autonomyLevel?: "observe" | "draft" | "auto";
  boundaryPolicy?: WorkshopJson;
  modelConfig?: WorkshopJson;
};

export type WorkshopAgentChangeProposalInput = {
  userId: string;
  workshopId: string;
  patch: WorkshopAgentChangePatch;
  reason: string;
  riskLevel?: "low" | "medium" | "high";
  proposedBy?: "chat_agent" | "workshop_agent" | "system";
  source?: WorkshopJson;
};

export class WorkshopAgentChangeStaleProposalError extends Error {
  code = "WORK_VERSION_STALE" as const;

  constructor() {
    super(
      "Proposal is stale because the Work configuration changed after it was created",
    );
    this.name = "WorkshopAgentChangeStaleProposalError";
  }
}

const PATCH_FIELDS = [
  "name",
  "mission",
  "status",
  "autonomyLevel",
  "boundaryPolicy",
  "modelConfig",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeForCompare(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForCompare);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeForCompare(value[key])]),
    );
  }
  return value ?? null;
}

function stableJson(value: unknown) {
  return JSON.stringify(normalizeForCompare(value));
}

function compactWorkshop(workshop: Workshop) {
  return {
    id: workshop.id,
    name: workshop.name,
    mission: workshop.mission,
    status: workshop.status,
    autonomyLevel: workshop.autonomyLevel,
    boundaryPolicy: workshop.boundaryPolicy,
    modelConfig: workshop.modelConfig,
    updatedAt: workshop.updatedAt,
  };
}

function workVersionFromWorkshop(workshop: Workshop) {
  return (
    (isRecord(workshop.modelConfig) &&
      typeof workshop.modelConfig.workVersion === "string" &&
      workshop.modelConfig.workVersion) ||
    (workshop.updatedAt instanceof Date
      ? workshop.updatedAt.toISOString()
      : String(workshop.updatedAt))
  );
}

function mergeJsonObject(
  current: unknown,
  patch: WorkshopJson | undefined,
): WorkshopJson | undefined {
  if (!patch) return undefined;
  return {
    ...((isRecord(current) ? current : {}) as WorkshopJson),
    ...patch,
  };
}

function sanitizePatch(patch: WorkshopAgentChangePatch) {
  const sanitized: WorkshopAgentChangePatch = {};
  if (typeof patch.name === "string" && patch.name.trim()) {
    sanitized.name = patch.name.trim();
  }
  if (typeof patch.mission === "string" && patch.mission.trim()) {
    sanitized.mission = patch.mission.trim();
  }
  if (
    patch.status === "active" ||
    patch.status === "paused" ||
    patch.status === "archived"
  ) {
    sanitized.status = patch.status;
  }
  if (
    patch.autonomyLevel === "observe" ||
    patch.autonomyLevel === "draft" ||
    patch.autonomyLevel === "auto"
  ) {
    sanitized.autonomyLevel = patch.autonomyLevel;
  }
  if (isRecord(patch.boundaryPolicy)) {
    sanitized.boundaryPolicy = patch.boundaryPolicy;
  }
  if (isRecord(patch.modelConfig)) {
    sanitized.modelConfig = patch.modelConfig;
  }
  return sanitized;
}

function resolvePatchAgainstWorkshop(
  workshop: Workshop,
  patch: WorkshopAgentChangePatch,
) {
  return {
    ...patch,
    ...(patch.boundaryPolicy !== undefined
      ? {
          boundaryPolicy: mergeJsonObject(
            workshop.boundaryPolicy,
            patch.boundaryPolicy,
          ),
        }
      : {}),
    ...(patch.modelConfig !== undefined
      ? {
          modelConfig: mergeJsonObject(workshop.modelConfig, patch.modelConfig),
        }
      : {}),
  } satisfies WorkshopAgentChangePatch;
}

function diffWorkshop(workshop: Workshop, patch: WorkshopAgentChangePatch) {
  return PATCH_FIELDS.flatMap((field) => {
    if (!(field in patch)) return [];
    const before = workshop[field];
    const after = patch[field];
    if (stableJson(before) === stableJson(after)) return [];
    return [{ field, before, after }];
  });
}

function inferRiskLevel(patch: WorkshopAgentChangePatch) {
  if (patch.autonomyLevel === "auto" || patch.status === "archived") {
    return "high";
  }
  if (patch.boundaryPolicy !== undefined || patch.modelConfig !== undefined) {
    return "medium";
  }
  return "low";
}

function proposalResolution(
  events: WorkshopEvent[],
  proposalEvent: WorkshopEvent,
) {
  return events.find((event) => {
    if (
      event.type !== "workshop_agent_change_applied" &&
      event.type !== "workshop_agent_change_rejected" &&
      event.type !== "workshop_agent_change_superseded"
    ) {
      return false;
    }
    return event.metadata?.proposalEventId === proposalEvent.id;
  });
}

function metadataPatch(metadata: Record<string, unknown>) {
  return sanitizePatch(
    isRecord(metadata.requestedPatch)
      ? (metadata.requestedPatch as WorkshopAgentChangePatch)
      : isRecord(metadata.patch)
        ? (metadata.patch as WorkshopAgentChangePatch)
        : {},
  );
}

export function summarizeWorkshopAgentChange(input: {
  workshop: Workshop;
  patch: WorkshopAgentChangePatch;
}) {
  const sanitizedPatch = resolvePatchAgainstWorkshop(
    input.workshop,
    sanitizePatch(input.patch),
  );
  const diff = diffWorkshop(input.workshop, sanitizedPatch);
  return {
    patch: sanitizedPatch,
    diff,
    changedFields: diff.map((item) => item.field),
    riskLevel: inferRiskLevel(sanitizedPatch),
  };
}

export async function proposeWorkshopAgentChange(
  input: WorkshopAgentChangeProposalInput,
) {
  const workshop = await getWorkshop(input.userId, input.workshopId);
  if (!workshop) {
    throw new Error("Workshop not found");
  }

  const requestedPatch = sanitizePatch(input.patch);
  const summary = summarizeWorkshopAgentChange({
    workshop,
    patch: requestedPatch,
  });
  if (summary.diff.length === 0) {
    throw new Error("No valid workshop configuration changes were proposed");
  }

  const event = await appendWorkshopEvent({
    workshopId: workshop.id,
    type: "workshop_agent_change_proposed",
    title: `智能体修改提案：${summary.changedFields.join("、")}`,
    body: input.reason,
    metadata: {
      kind: "workshop_agent_change_proposal",
      status: "pending_approval",
      proposedBy: input.proposedBy ?? "chat_agent",
      reason: input.reason,
      riskLevel: input.riskLevel ?? summary.riskLevel,
      workModelVersion: workVersionFromWorkshop(workshop),
      before: compactWorkshop(workshop),
      requestedPatch,
      patch: summary.patch,
      diff: summary.diff,
      changedFields: summary.changedFields,
      source: input.source ?? {},
    },
  });
  await upsertWorkshopReviewItemFromProposalEvent(event);
  return event;
}

async function recreateWorkshopAgentChangeProposal(input: {
  userId: string;
  workshopId: string;
  proposalEvent: WorkshopEvent;
  workshop: Workshop;
  metadata: Record<string, unknown>;
  reason?: string | null;
}) {
  const requestedPatch = metadataPatch(input.metadata);
  const reason =
    input.reason ??
    [
      "基于当前 Work 版本重新生成配置变更提案。",
      typeof input.proposalEvent.body === "string" &&
      input.proposalEvent.body.trim()
        ? `原提案理由：${input.proposalEvent.body}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
  const recreated = await proposeWorkshopAgentChange({
    userId: input.userId,
    workshopId: input.workshopId,
    patch: requestedPatch,
    reason,
    riskLevel:
      input.metadata.riskLevel === "low" ||
      input.metadata.riskLevel === "medium" ||
      input.metadata.riskLevel === "high"
        ? input.metadata.riskLevel
        : undefined,
    proposedBy:
      input.metadata.proposedBy === "chat_agent" ||
      input.metadata.proposedBy === "workshop_agent" ||
      input.metadata.proposedBy === "system"
        ? input.metadata.proposedBy
        : "chat_agent",
    source: {
      ...(isRecord(input.metadata.source) ? input.metadata.source : {}),
      surface: "workshop_review_tab",
      action: "recreate_stale_proposal",
      previousProposalEventId: input.proposalEvent.id,
      previousWorkModelVersion:
        typeof input.metadata.workModelVersion === "string"
          ? input.metadata.workModelVersion
          : null,
    },
  });
  const event = await appendWorkshopEvent({
    workshopId: input.workshopId,
    type: "workshop_agent_change_superseded",
    title: "智能体修改提案已重建",
    body: input.reason ?? "旧提案已基于当前 Work 版本重新生成。",
    metadata: {
      kind: "workshop_agent_change_resolution",
      action: "recreate",
      proposalEventId: input.proposalEvent.id,
      newProposalEventId: recreated.id,
      reason: input.reason ?? null,
      workVersionBefore:
        typeof input.metadata.workModelVersion === "string"
          ? input.metadata.workModelVersion
          : null,
      workVersionAfter: workVersionFromWorkshop(input.workshop),
    },
  });
  await resolveWorkshopReviewItemBySourceEvent({
    workshopId: input.workshopId,
    sourceEventId: input.proposalEvent.id,
    status: "superseded",
    metadata: {
      resolutionEventId: event.id,
      newProposalEventId: recreated.id,
      reason: input.reason ?? null,
    },
  });
  return {
    status: "recreated" as const,
    event,
    proposal: recreated,
    workshop: input.workshop,
  };
}

export async function resolveWorkshopAgentChangeProposal(input: {
  userId: string;
  workshopId: string;
  proposalEventId: string;
  action: WorkshopAgentChangeAction;
  reason?: string | null;
}) {
  const [workshop, proposalEvent] = await Promise.all([
    getWorkshop(input.userId, input.workshopId),
    getWorkshopEvent(input.workshopId, input.proposalEventId),
  ]);
  if (!workshop || !proposalEvent) {
    throw new Error("Workshop or proposal not found");
  }
  if (proposalEvent.type !== "workshop_agent_change_proposed") {
    throw new Error("Event is not a workshop agent change proposal");
  }

  const recentEvents = await listWorkshopEvents(input.workshopId, {
    limit: 200,
    order: "latest",
  });
  if (proposalResolution(recentEvents, proposalEvent)) {
    throw new Error("Proposal has already been resolved");
  }

  const metadata = isRecord(proposalEvent.metadata) ? proposalEvent.metadata : {};

  if (input.action === "recreate") {
    return recreateWorkshopAgentChangeProposal({
      userId: input.userId,
      workshopId: input.workshopId,
      proposalEvent,
      workshop,
      metadata,
      reason: input.reason,
    });
  }

  if (input.action === "reject") {
    const event = await appendWorkshopEvent({
      workshopId: input.workshopId,
      type: "workshop_agent_change_rejected",
      title: "智能体修改提案已驳回",
      body: input.reason ?? "主人驳回该智能体配置变更。",
      metadata: {
        kind: "workshop_agent_change_resolution",
        action: "reject",
        proposalEventId: proposalEvent.id,
        reason: input.reason ?? null,
      },
    });
    await resolveWorkshopReviewItemBySourceEvent({
      workshopId: input.workshopId,
      sourceEventId: proposalEvent.id,
      status: "rejected",
      metadata: {
        resolutionEventId: event.id,
        reason: input.reason ?? null,
      },
    });
    return { status: "rejected" as const, event, workshop };
  }

  const expectedWorkModelVersion =
    typeof metadata.workModelVersion === "string"
      ? metadata.workModelVersion
      : null;
  const currentWorkModelVersion = workVersionFromWorkshop(workshop);
  if (
    expectedWorkModelVersion &&
    expectedWorkModelVersion !== currentWorkModelVersion
  ) {
    throw new WorkshopAgentChangeStaleProposalError();
  }
  const patch = sanitizePatch(
    isRecord(metadata.patch)
      ? (metadata.patch as WorkshopAgentChangePatch)
      : {},
  );
  const summary = summarizeWorkshopAgentChange({ workshop, patch });

  if (summary.diff.length === 0) {
    throw new Error(
      "Proposal is no longer applicable because target fields already match",
    );
  }

  const appliedAt = new Date().toISOString();
  const patchWithVersion = {
    ...summary.patch,
    modelConfig: {
      ...((isRecord(workshop.modelConfig)
        ? workshop.modelConfig
        : {}) as WorkshopJson),
      ...((isRecord(summary.patch.modelConfig)
        ? summary.patch.modelConfig
        : {}) as WorkshopJson),
      workVersion: appliedAt,
    },
  } satisfies WorkshopAgentChangePatch;
  const updated = await updateWorkshop(input.userId, input.workshopId, {
    ...patchWithVersion,
    recordWorkVersion: false,
  } satisfies UpdateWorkshopInput);
  if (!updated) {
    throw new Error("Failed to apply workshop agent change proposal");
  }

  const event = await appendWorkshopEvent({
    workshopId: input.workshopId,
    type: "workshop_agent_change_applied",
    title: "智能体修改提案已应用",
    body: input.reason ?? "主人确认并应用该智能体配置变更。",
    metadata: {
      kind: "workshop_agent_change_resolution",
      action: "apply",
      proposalEventId: proposalEvent.id,
      reason: input.reason ?? null,
      workVersionBefore: workVersionFromWorkshop(workshop),
      workVersionAfter: appliedAt,
      patch: patchWithVersion,
      diff: summary.diff,
      before: compactWorkshop(workshop),
      after: compactWorkshop(updated),
    },
  });
  await createWorkshopWorkVersionSnapshot({
    workshop: updated,
    version: appliedAt,
    source: "agent_change_apply",
    changeEventId: event.id,
    patch: patchWithVersion,
    createdBy: "user",
  });
  await resolveWorkshopReviewItemBySourceEvent({
    workshopId: input.workshopId,
    sourceEventId: proposalEvent.id,
    status: "approved",
    metadata: {
      resolutionEventId: event.id,
      reason: input.reason ?? null,
      workVersionAfter: appliedAt,
    },
  });

  return { status: "applied" as const, event, workshop: updated };
}
