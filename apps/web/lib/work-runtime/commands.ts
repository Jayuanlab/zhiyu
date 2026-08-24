import type { Loop } from "@/lib/db/schema";
import {
  computeNextLoopRun,
  getLoopInWorkshop,
  getLoopState,
  listLoopRuns,
  listLoopsForWorkshop,
  updateLoop,
  upsertLoopState,
} from "@/lib/loops";
import { serializeWorkshopBoundaryPolicy } from "@/lib/workshops/boundary-policy";
import {
  activateWorkshopLoopProposal,
  createWorkshopLoopFromNaturalLanguage,
  createWorkshopLoopFromTemplate,
  draftWorkshopLoopFromNaturalLanguage,
  rejectWorkshopLoopProposal,
} from "@/lib/workshops/loop-service";
import { runWorkshopLoopOnce } from "@/lib/workshops/loop-runtime";
import {
  appendWorkshopEvent,
  createWorkshop,
  deleteWorkshop,
  getWorkshop,
  addWorkshopDirective,
  restoreWorkshopWorkVersion,
  updateWorkshop,
  upsertWorkshopHeartbeat,
} from "@/lib/workshops/service";
import { resolveWorkshopLoopBlockerReviewItem } from "@/lib/workshops/review-items";
import { ensureWorkshopWorkSelfAuditLoop } from "@/lib/workshops/loop-service";
import { startWorkshopRun } from "@/lib/workshops/runtime";
import type {
  AddWorkDirectiveCommand,
  CreateWorkCommand,
  CreateWorkLoopCommand,
  DeleteWorkCommand,
  RestoreWorkVersionCommand,
  RunWorkLoopCommand,
  StartWorkRunCommand,
  UpdateWorkCommand,
  UpdateWorkLoopCommand,
  UpdateWorkLoopActivationCommand,
  WorkCommandMeta,
  WorkLoopCreatedResult,
  WorkLoopDraftResult,
} from "./types";

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

function externalWriteMode(
  value: unknown,
): "manual_approval" | "loop_approved" {
  return value === "manual_approval" ? "manual_approval" : "loop_approved";
}

function resolveLoopRunMode(input: RunWorkLoopCommand) {
  if (input.dryRun === true || input.mode === "dry_run") return "dry_run" as const;
  return input.mode ?? "native_agent";
}

export async function createWork(command: CreateWorkCommand) {
  const meta = commandMetadata(command);
  const boundaryPolicy = serializeWorkshopBoundaryPolicy(
    command.input.boundaryPolicy ?? {
      mode: command.input.autonomyLevel ?? "draft",
    },
  );
  const workshop = await createWorkshop({
    ...command.input,
    autonomyLevel: boundaryPolicy.mode,
    boundaryPolicy,
    modelConfig: {
      ...(command.input.modelConfig ?? {}),
      createdByCommand: meta,
    },
  });

  await appendWorkshopEvent({
    workshopId: workshop.id,
    type: "work_command_applied",
    title: "Work created",
    body: command.input.mission,
    metadata: {
      command: "createWork",
      ...meta,
    },
  });

  return workshop;
}

export async function updateWork(command: UpdateWorkCommand) {
  const meta = commandMetadata(command);
  await requireWork(command.userId, command.workId);

  const boundaryPolicy =
    command.patch.boundaryPolicy === undefined
      ? undefined
      : serializeWorkshopBoundaryPolicy(command.patch.boundaryPolicy);
  const workshop = await updateWorkshop(command.userId, command.workId, {
    name: command.patch.name,
    mission: command.patch.mission,
    status: command.patch.status,
    autonomyLevel: boundaryPolicy?.mode ?? command.patch.autonomyLevel,
    boundaryPolicy,
    modelConfig: command.patch.modelConfig,
    changeSource: meta.source,
    changeEventId: meta.commandId,
  });

  if (!workshop) {
    throw new Error("Workshop not found");
  }

  const heartbeat =
    command.patch.heartbeat === undefined
      ? undefined
      : await upsertWorkshopHeartbeat(command.workId, command.patch.heartbeat);

  await appendWorkshopEvent({
    workshopId: command.workId,
    type: "work_command_applied",
    title: "Work updated",
    body: meta.reason ?? "Work configuration was updated.",
    metadata: {
      command: "updateWork",
      fields: Object.keys(command.patch).filter((key) => key !== "heartbeat"),
      heartbeatUpdated: command.patch.heartbeat !== undefined,
      ...meta,
    },
  });

  return { workshop, heartbeat };
}

export async function deleteWork(command: DeleteWorkCommand) {
  const meta = commandMetadata(command);
  await requireWork(command.userId, command.workId);
  const workshop = await deleteWorkshop(command.userId, command.workId);
  if (!workshop) {
    throw new Error("Workshop not found");
  }
  return {
    workshop,
    command: meta,
  };
}

export async function startWorkRun(command: StartWorkRunCommand) {
  const meta = commandMetadata(command);
  await requireWork(command.userId, command.workId);
  const run = await startWorkshopRun({
    userId: command.userId,
    workshopId: command.workId,
    triggerReason: {
      ...(command.triggerReason ?? { type: "manual" }),
      command: "startWorkRun",
      commandMeta: meta,
    },
  });
  const workshop = await requireWork(command.userId, command.workId);
  return { run, workshop, command: meta };
}

export async function addWorkDirective(command: AddWorkDirectiveCommand) {
  const meta = commandMetadata(command);
  await requireWork(command.userId, command.workId);
  const content = command.content.trim();
  if (!content) {
    throw new Error("content is required");
  }

  const directive = await addWorkshopDirective({
    workshopId: command.workId,
    runId: command.runId ?? null,
    content,
    priority: command.priority ?? 0,
    scope: command.scope ?? "current_run",
  });

  let run = null;
  let runError: string | null = null;
  if (command.triggerRun !== false) {
    try {
      const result = await startWorkRun({
        userId: command.userId,
        workId: command.workId,
        commandId: meta.commandId,
        source: meta.source,
        reason: meta.reason,
        triggerReason: {
          type: "directive",
          directiveId: directive.id,
          content,
          ...(command.triggerReason ?? {}),
        },
      });
      run = result.run;
    } catch (error) {
      runError =
        error instanceof Error ? error.message : "Failed to start Work run";
    }
  }

  await appendWorkshopEvent({
    workshopId: command.workId,
    runId: directive.runId,
    type: "work_command_applied",
    title: "Directive added through Work Runtime",
    body: content,
    metadata: {
      command: "addWorkDirective",
      directiveId: directive.id,
      triggerRun: command.triggerRun !== false,
      runError,
      ...meta,
    },
  });

  return { directive, run, runError, command: meta };
}

export async function listWorkLoops(input: {
  userId: string;
  workId: string;
  limit?: number;
}): Promise<{ workshop: Awaited<ReturnType<typeof requireWork>>; loops: Loop[] }> {
  const workshop = await requireWork(input.userId, input.workId);
  const loops = await listLoopsForWorkshop({
    userId: input.userId,
    workshopId: input.workId,
    limit: input.limit ?? 200,
  });
  return { workshop, loops };
}

export async function createWorkLoop(
  command: CreateWorkLoopCommand,
): Promise<WorkLoopCreatedResult | WorkLoopDraftResult> {
  const meta = commandMetadata(command);
  const workshop = await requireWork(command.userId, command.workId);
  const type = command.type ?? "natural_language";

  if (type === "template") {
    if (!command.templateId) {
      throw new Error("templateId is required");
    }
    const loop = await createWorkshopLoopFromTemplate({
      userId: command.userId,
      workshopId: command.workId,
      templateId: command.templateId,
      templateInput: command.templateInput ?? {},
    });
    await appendWorkshopEvent({
      workshopId: command.workId,
      loopId: loop.id,
      type: "work_command_applied",
      title: "Loop template created through Work Runtime",
      body: command.templateId,
      metadata: {
        command: "createWorkLoop",
        templateId: command.templateId,
        ...meta,
      },
    });
    return { workshop, loop };
  }

  const intent = command.intent?.trim();
  if (!intent) {
    throw new Error("intent is required");
  }
  const input = {
    userId: command.userId,
    workshopId: command.workId,
    intent,
    timezone: command.timezone,
    externalWriteMode: externalWriteMode(command.externalWriteMode),
  };

  if (command.create === true) {
    const result = await createWorkshopLoopFromNaturalLanguage(input);
    await appendWorkshopEvent({
      workshopId: command.workId,
      loopId: result.loop.id,
      type: "work_command_applied",
      title: "Loop created through Work Runtime",
      body: intent,
      metadata: {
        command: "createWorkLoop",
        ...meta,
      },
    });
    return { workshop, ...result };
  }

  const draft = await draftWorkshopLoopFromNaturalLanguage(input);
  return { workshop, draft };
}

export async function updateWorkLoopActivation(
  command: UpdateWorkLoopActivationCommand,
) {
  const meta = commandMetadata(command);
  await requireWork(command.userId, command.workId);
  const loop =
    command.action === "activate"
      ? await activateWorkshopLoopProposal({
          userId: command.userId,
          workshopId: command.workId,
          loopId: command.loopId,
          activatedBy: meta.source === "system" ? "system" : "owner",
        })
      : await rejectWorkshopLoopProposal({
          userId: command.userId,
          workshopId: command.workId,
          loopId: command.loopId,
          reason: command.rejectionReason ?? meta.reason ?? null,
        });

  await appendWorkshopEvent({
    workshopId: command.workId,
    loopId: command.loopId,
    type: "work_command_applied",
    title:
      command.action === "activate"
        ? "Loop proposal activated"
        : "Loop proposal rejected",
    body: meta.reason ?? null,
    metadata: {
      command: "updateWorkLoopActivation",
      action: command.action,
      ...meta,
    },
  });

  return { loop, command: meta };
}

export async function updateWorkLoop(command: UpdateWorkLoopCommand) {
  const meta = commandMetadata(command);
  await requireWork(command.userId, command.workId);
  const existing = await getLoopInWorkshop({
    userId: command.userId,
    workshopId: command.workId,
    loopId: command.loopId,
  });
  if (!existing) {
    throw new Error("Loop not found in workshop");
  }

  const loop = await updateLoop(command.userId, command.loopId, command.patch);
  if (!loop) {
    throw new Error("Loop not found");
  }

  let nextScheduledRunAt: string | null = null;
  if (command.patch.triggerConfig) {
    const updatedAt = new Date();
    const nextRun = computeNextLoopRun({
      triggerConfig: command.patch.triggerConfig,
      from: updatedAt,
    });
    nextScheduledRunAt = nextRun?.toISOString() ?? null;
    const state = await getLoopState(command.loopId);
    const stateJson =
      state?.stateJson &&
      typeof state.stateJson === "object" &&
      !Array.isArray(state.stateJson)
        ? state.stateJson
        : {};
    await upsertLoopState(command.loopId, {
      nextAction: nextRun
        ? `Next scheduled run at ${nextRun.toISOString()}`
        : "Run manually or update the task schedule.",
      blockedReason: null,
      stateJson: {
        ...stateJson,
        workshopId: command.workId,
        lastLoopTaskUpdateIntent: meta.reason,
        lastLoopTaskUpdatedAt: updatedAt.toISOString(),
        nextScheduledRunAt,
        schedulerStatus: "idle",
        schedulerError: undefined,
      },
    });
  }

  await appendWorkshopEvent({
    workshopId: command.workId,
    loopId: command.loopId,
    type: "work_command_applied",
    title: "Loop updated through Work Runtime",
    body: meta.reason ?? loop.name,
    metadata: {
      command: "updateWorkLoop",
      updatedFields: Object.keys(command.patch),
      nextScheduledRunAt,
      ...meta,
    },
  });

  return { loop, nextScheduledRunAt, command: meta };
}

export async function clearWorkLoopBlocker(command: UpdateWorkLoopCommand) {
  const meta = commandMetadata(command);
  await requireWork(command.userId, command.workId);
  const existing = await getLoopInWorkshop({
    userId: command.userId,
    workshopId: command.workId,
    loopId: command.loopId,
  });
  if (!existing) {
    throw new Error("Loop not found in workshop");
  }

  const [state, latestRun] = await Promise.all([
    getLoopState(command.loopId),
    listLoopRuns(command.loopId, { limit: 1 }).then((runs) => runs[0] ?? null),
  ]);
  const stateJson =
    state?.stateJson &&
    typeof state.stateJson === "object" &&
    !Array.isArray(state.stateJson)
      ? state.stateJson
      : {};
  const clearedAt = new Date().toISOString();

  await upsertLoopState(command.loopId, {
    currentPhase:
      state?.currentPhase === "blocked" ||
      state?.currentPhase === "retry_recommended" ||
      state?.currentPhase === "error"
        ? "idle"
        : (state?.currentPhase ?? "idle"),
    blockedReason: null,
    nextAction: "Blocker cleared by owner; rerun when ready.",
    stateJson: {
      ...stateJson,
      workshopId: command.workId,
      blockedClearedLoopRunId:
        latestRun?.status === "blocked" ? latestRun.id : stateJson.blockedClearedLoopRunId,
      blockerClearedAt: clearedAt,
      blockerClearedBy: meta.source,
      blockerClearedReason: meta.reason,
      blockerDismissedLoopRunId:
        latestRun?.id ?? stateJson.blockerDismissedLoopRunId,
      blockerDismissedAt: clearedAt,
      blockerDismissedBy: meta.source,
      blockerDismissedReason: meta.reason,
    },
  });

  await appendWorkshopEvent({
    workshopId: command.workId,
    loopId: command.loopId,
    loopRunId: latestRun?.id ?? null,
    type: "loop_blocker_cleared",
    title: "Loop blocker dismissed",
    body: meta.reason ?? "Owner dismissed the blocker without rerun.",
    metadata: {
      command: "clearWorkLoopBlocker",
      clearedLoopRunId: latestRun?.id ?? null,
      clearedLoopRunStatus: latestRun?.status ?? null,
      ...meta,
    },
  });
  await resolveWorkshopLoopBlockerReviewItem({
    workshopId: command.workId,
    loopId: command.loopId,
    status: "dismissed",
    metadata: {
      command: "clearWorkLoopBlocker",
      reason: meta.reason,
      source: meta.source,
      clearedAt,
      clearedLoopRunId: latestRun?.id ?? null,
    },
  });

  return { loop: existing, latestRun, command: meta };
}

export async function runWorkLoop(command: RunWorkLoopCommand) {
  const meta = commandMetadata(command);
  await requireWork(command.userId, command.workId);
  const mode = resolveLoopRunMode(command);
  return runWorkshopLoopOnce({
    userId: command.userId,
    workshopId: command.workId,
    loopId: command.loopId,
    mode,
    triggeredBy: meta.source === "system" ? "scheduler" : "manual",
    reason: {
      source: "work_runtime",
      dryRun: mode === "dry_run",
      command: "runWorkLoop",
      commandMeta: meta,
    },
    createOutboxDrafts:
      mode === "dry_run" ? false : command.createOutboxDrafts !== false,
  });
}

export async function restoreWorkVersion(command: RestoreWorkVersionCommand) {
  const meta = commandMetadata(command);
  await requireWork(command.userId, command.workId);
  const result = await restoreWorkshopWorkVersion({
    userId: command.userId,
    workshopId: command.workId,
    versionId: command.versionId,
    reason: meta.reason,
  });
  if (!result) {
    throw new Error("Workshop or version not found");
  }
  await appendWorkshopEvent({
    workshopId: command.workId,
    type: "work_command_applied",
    title: "Work version restored",
    body: meta.reason ?? null,
    metadata: {
      command: "restoreWorkVersion",
      versionId: command.versionId,
      ...meta,
    },
  });
  return result;
}

export async function ensureWorkSelfAuditLoop(command: {
  userId: string;
  workId: string;
  timezone?: string;
  cronExpression?: string;
} & WorkCommandMeta) {
  const meta = commandMetadata(command);
  await requireWork(command.userId, command.workId);
  const result = await ensureWorkshopWorkSelfAuditLoop({
    userId: command.userId,
    workshopId: command.workId,
    timezone: command.timezone,
    cronExpression: command.cronExpression,
  });
  await appendWorkshopEvent({
    workshopId: command.workId,
    loopId: result.loop.id,
    type: "work_command_applied",
    title: "Work self-audit loop ensured",
    body: result.created ? "Created self-audit loop." : "Self-audit loop already exists.",
    metadata: {
      command: "ensureWorkSelfAuditLoop",
      created: result.created,
      loopId: result.loop.id,
      ...meta,
    },
  });
  return { ...result, command: meta };
}
