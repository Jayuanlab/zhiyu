import type { Loop } from "@/lib/db/schema";
import {db as database} from '@/lib/db/client';
import {sql} from "drizzle-orm";
import {workCommandChildId} from "./child-id";
import type { WorkshopWriteContext } from "@/lib/workshops/service";
import { runDatabaseWorkCommand, runPreparedDatabaseWorkCommand } from "./database-command";
import {runWorkLifecycleCommand} from "./lifecycle-command";
import {WorkCommandConflict} from "./command-ledger";
import { loopVerificationSchema } from "@/lib/loops/spec";
import {
  computeNextLoopRun,
  createLoop,
  loopSpecToCreateLoopInput,
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
  createWorkshopLoopFromTemplate,
  draftWorkshopLoopFromNaturalLanguage,
  rejectWorkshopLoopProposal,
} from "@/lib/workshops/loop-service";
import { runWorkshopLoopOnce,workshopLoopCommand } from "@/lib/workshops/loop-runtime";
import {acceptWorkLoopExecution} from './loop-command';
import {
  appendWorkshopEvent,
  createWorkshop,
  createWorkshopRun,
  deleteWorkshop,
  getWorkshop,
  addWorkshopDirective,
  restoreWorkshopWorkVersion,
  updateWorkshop,
  upsertWorkshopHeartbeat,
} from "@/lib/workshops/service";
import { resolveWorkshopLoopBlockerReviewItem } from "@/lib/workshops/review-items";
import { ensureWorkshopWorkSelfAuditLoop } from "@/lib/workshops/loop-service";
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
  return runWorkLifecycleCommand({ownerId: command.input.userId, type: "createWork", command}, applyCreateWork);
}

async function applyCreateWork(command: CreateWorkCommand, context: WorkshopWriteContext, workId: string) {
  if (Object.hasOwn(command.input.modelConfig ?? {}, "manifestName")) throw new WorkCommandConflict("manifest_identity_reserved");
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
  }, context, workId);

  await context.append({
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
  return runDatabaseWorkCommand(command, "updateWork", applyUpdateWork);
}

async function applyUpdateWork(command: UpdateWorkCommand, context: WorkshopWriteContext) {
  const meta = commandMetadata(command);

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
  }, context);

  if (!workshop) {
    throw new Error("Workshop not found");
  }

  const heartbeat =
    command.patch.heartbeat === undefined
      ? undefined
      : await upsertWorkshopHeartbeat(command.workId, command.patch.heartbeat, context);

  await context.append({
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
  return runWorkLifecycleCommand({ownerId: command.userId, workId: command.workId, type: "deleteWork", command}, applyDeleteWork);
}

async function applyDeleteWork(command: DeleteWorkCommand, context: WorkshopWriteContext, workId: string) {
  const meta = commandMetadata(command);
  const workshop = await deleteWorkshop(command.userId, workId, context.db);
  if (!workshop) {
    throw new Error("Workshop not found");
  }
  return {
    workshop,
    command: meta,
  };
}

export async function startWorkRun(command: StartWorkRunCommand) {
  return runDatabaseWorkCommand(command, "startWorkRun", applyStartWorkRun);
}

async function applyStartWorkRun(command: StartWorkRunCommand, context: WorkshopWriteContext) {
  const meta = commandMetadata(command);
  const workshop = await getWorkshop(command.userId, command.workId, context.db);
  if (!workshop) throw new WorkCommandConflict("not_found");
  if (workshop.status === "archived") throw new WorkCommandConflict("target_busy");
  const run = await createWorkshopRun({
    id: workCommandChildId(command.userId, command.workId, meta.commandId, "run"),
    workshopId: command.workId,
    status: "queued",
    triggerReason: {
      ...(command.triggerReason ?? { type: "manual" }),
      command: "startWorkRun",
      commandMeta: meta,
    },
    inputSnapshot: {mission: workshop.mission, autonomyLevel: workshop.autonomyLevel, acceptedByCommandId: meta.commandId},
  }, context);
  return { run, workshop, command: meta };
}

export async function addWorkDirective(command: AddWorkDirectiveCommand) {
  if (typeof command.content !== "string" || !command.content.trim()) throw new WorkCommandConflict("invalid_command");
  if (command.priority !== undefined && (!Number.isSafeInteger(command.priority) || command.priority < -2147483648 || command.priority > 2147483647)) throw new WorkCommandConflict("invalid_command");
  if (command.scope !== undefined && command.scope !== "current_run" && command.scope !== "persistent") throw new WorkCommandConflict("invalid_command");
  return runDatabaseWorkCommand(command, "addWorkDirective", applyAddWorkDirective);
}

async function applyAddWorkDirective(command: AddWorkDirectiveCommand, context: WorkshopWriteContext) {
  const meta = commandMetadata(command);
  const content = command.content.trim();
  if (command.runId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(command.runId)) throw new WorkCommandConflict("invalid_command");
    const target = await context.db.execute(sql`SELECT id FROM workshop_runs WHERE id=${command.runId}::uuid AND workshop_id=${command.workId}::uuid`);
    if (!target[0]) throw new WorkCommandConflict("not_found");
  }

  const directive = await addWorkshopDirective({
    workshopId: command.workId,
    runId: command.runId ?? null,
    content,
    priority: command.priority ?? 0,
    scope: command.scope ?? "current_run",
  }, context);

  let run: Awaited<ReturnType<typeof createWorkshopRun>> | null = null;
  if (command.triggerRun !== false) {
      const result = await applyStartWorkRun({
        userId: command.userId,
        workId: command.workId,
        commandId: meta.commandId,
        source: meta.source,
        reason: meta.reason,
        triggerReason: {
          ...(command.triggerReason ?? {}),
          type: "directive",
          directiveId: directive.id,
          content,
        },
      }, context);
      run = result.run;
  }

  await context.append({
    workshopId: command.workId,
    runId: directive.runId,
    type: "work_command_applied",
    title: "Directive added through Work Runtime",
    body: content,
    metadata: {
      command: "addWorkDirective",
      directiveId: directive.id,
      triggerRun: command.triggerRun !== false,
      queuedRunId: run?.id ?? null,
      ...meta,
    },
  });

  return { directive, run, runError: null, command: meta };
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
  const type = command.type ?? "natural_language";
  if (type === "template") {
    if (!command.templateId) throw new WorkCommandConflict("invalid_command");
    return runDatabaseWorkCommand(command, "createWorkLoop", async (persisted, context) => {
      const workshop = await getWorkshop(persisted.userId, persisted.workId, context.db);
      if (!workshop) throw new WorkCommandConflict("not_found");
      const loop = await createWorkshopLoopFromTemplate({
        userId: persisted.userId, workshopId: persisted.workId, templateId: persisted.templateId!, templateInput: persisted.templateInput ?? {},
      }, context);
      await context.append({workshopId: persisted.workId, loopId: loop.id, type: "work_command_applied",
        title: "Loop template created through Work Runtime", body: persisted.templateId,
        metadata: {command: "createWorkLoop", templateId: persisted.templateId, ...commandMetadata(persisted)}});
      return {workshop, loop};
    });
  }
  if (type !== "natural_language") throw new WorkCommandConflict("invalid_command");
  const intent = command.intent?.trim();
  if (!intent) throw new WorkCommandConflict("invalid_command");
  const prepare = (persisted: CreateWorkLoopCommand) => draftWorkshopLoopFromNaturalLanguage({
    userId: persisted.userId, workshopId: persisted.workId, intent: persisted.intent!.trim(),
    timezone: persisted.timezone, externalWriteMode: externalWriteMode(persisted.externalWriteMode),
  });
  if (command.create !== true) {
    const workshop = await requireWork(command.userId, command.workId);
    return {workshop, draft: await prepare(command)};
  }
  return runPreparedDatabaseWorkCommand(command, "createWorkLoop", async persisted => {
    const draft = await prepare(persisted);
    if (draft.extracted.missingFields.length) throw new WorkCommandConflict("invalid_command");
    return draft;
  }, async (persisted, draft, context) => {
    const workshop = await getWorkshop(persisted.userId, persisted.workId, context.db);
    if (!workshop) throw new WorkCommandConflict("not_found");
    const loop = await createLoop(loopSpecToCreateLoopInput({userId: persisted.userId, workshopId: persisted.workId,
      name: draft.name, description: draft.description, spec: draft.spec}), context.db);
    await context.append({workshopId: persisted.workId, loopId: loop.id, type: "loop_created", title: `Task created: ${loop.name}`,
      body: loop.description ?? loop.goal, metadata: {creationSource: "natural_language", draft, ...commandMetadata(persisted)}});
    return {workshop, loop, draft};
  });
}

export async function updateWorkLoopActivation(
  command: UpdateWorkLoopActivationCommand,
) {
  if (command.action !== "activate" && command.action !== "reject") throw new WorkCommandConflict("invalid_command");
  return runDatabaseWorkCommand(command, "updateWorkLoopActivation", applyWorkLoopActivation);
}

async function applyWorkLoopActivation(command: UpdateWorkLoopActivationCommand, context: WorkshopWriteContext) {
  const meta = commandMetadata(command);
  const loop =
    command.action === "activate"
      ? await activateWorkshopLoopProposal({
          userId: command.userId,
          workshopId: command.workId,
          loopId: command.loopId,
          activatedBy: meta.source === "system" ? "system" : "owner",
        }, context)
      : await rejectWorkshopLoopProposal({
          userId: command.userId,
          workshopId: command.workId,
          loopId: command.loopId,
          reason: command.rejectionReason ?? meta.reason ?? null,
        }, context);

  await context.append({
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
  return runDatabaseWorkCommand(command, "updateWorkLoop", applyUpdateWorkLoop);
}

/** Persist only the requested checker change; merge the other verification
 * fields after the Work lock, so retries never rebuild their payload from a
 * newer Loop and concurrent configuration changes are not overwritten. */
export async function updateWorkLoopModelChecker(command: WorkCommandMeta & {
  userId: string;
  workId: string;
  loopId: string;
  modelChecker: {enabled: boolean; provider?: string; model?: string; maxInputChars?: number};
}) {
  return runDatabaseWorkCommand(command, "updateWorkLoopModelChecker", async (persisted, context) => {
    const existing = await getLoopInWorkshop({userId: persisted.userId, workshopId: persisted.workId, loopId: persisted.loopId}, context.db);
    if (!existing) throw new WorkCommandConflict("not_found");
    const parsed = loopVerificationSchema.safeParse({...existing.verificationConfig, modelChecker: persisted.modelChecker});
    if (!parsed.success) throw new WorkCommandConflict("invalid_command");
    return applyUpdateWorkLoop({...persisted, patch: {verificationConfig: parsed.data}}, context);
  });
}

/** Internal transaction participant, also used by atomic manifest application. */
export async function applyUpdateWorkLoop(command: UpdateWorkLoopCommand, context: WorkshopWriteContext) {
  const meta = commandMetadata(command);
  if (command.patch.workshopId !== undefined && command.patch.workshopId !== command.workId) throw new Error("Loop transfer requires a separate owner-reviewed command");
  const existing = await getLoopInWorkshop({
    userId: command.userId,
    workshopId: command.workId,
    loopId: command.loopId,
  }, context.db);
  if (!existing) {
    throw new WorkCommandConflict("not_found");
  }

  const loop = await updateLoop(command.userId, command.loopId, command.patch, context.db);
  if (!loop) {
    throw new WorkCommandConflict("not_found");
  }

  let nextScheduledRunAt: string | null = null;
  if (command.patch.triggerConfig) {
    const updatedAt = new Date();
    const nextRun = computeNextLoopRun({
      triggerConfig: command.patch.triggerConfig,
      from: updatedAt,
    });
    nextScheduledRunAt = nextRun?.toISOString() ?? null;
    const state = await getLoopState(command.loopId, context.db);
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
    }, context.db);
  }

  await context.append({
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
  return runDatabaseWorkCommand(command, "clearWorkLoopBlocker", applyClearWorkLoopBlocker);
}

async function applyClearWorkLoopBlocker(command: UpdateWorkLoopCommand, context: WorkshopWriteContext) {
  const meta = commandMetadata(command);
  const existing = await getLoopInWorkshop({
    userId: command.userId,
    workshopId: command.workId,
    loopId: command.loopId,
  }, context.db);
  if (!existing) {
    throw new WorkCommandConflict("not_found");
  }

  const [state, latestRun] = await Promise.all([
    getLoopState(command.loopId, context.db),
    listLoopRuns(command.loopId, { limit: 1 }, context.db).then((runs) => runs[0] ?? null),
  ]);
  if (state?.currentPhase === "running" || latestRun?.status === "running") throw new WorkCommandConflict("target_busy");
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
  }, context.db);

  await context.append({
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
      commandSource: meta.source,
      clearedAt,
      clearedLoopRunId: latestRun?.id ?? null,
    },
  }, context.db);

  return { loop: existing, latestRun, command: meta };
}

function workLoopInput(command:RunWorkLoopCommand):Parameters<typeof runWorkshopLoopOnce>[0]{
  const meta = commandMetadata(command);
  const mode = resolveLoopRunMode(command);
  return {
    commandId:command.commandId,
    expectedVersion:command.expectedVersion,
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
  };
}

export async function enqueueWorkLoop(command:RunWorkLoopCommand){
  const accepted=await acceptWorkLoopExecution(workshopLoopCommand(workLoopInput(command)));
  const rows=await database.execute(sql`SELECT r.status FROM workshop_runs r JOIN workshops w ON w.id=r.workshop_id WHERE r.id=${accepted.runId}::uuid AND w.user_id=${command.userId}::uuid`);
  return {...accepted,status:String(rows[0]?.status??'unavailable')};
}

export async function runWorkLoop(command: RunWorkLoopCommand) {
  await requireWork(command.userId, command.workId);
  return runWorkshopLoopOnce(workLoopInput(command));
}

export async function restoreWorkVersion(command: RestoreWorkVersionCommand) {
  return runDatabaseWorkCommand(command, "restoreWorkVersion", applyRestoreWorkVersion);
}

async function applyRestoreWorkVersion(command: RestoreWorkVersionCommand, context: WorkshopWriteContext) {
  const meta = commandMetadata(command);
  const result = await restoreWorkshopWorkVersion({
    userId: command.userId,
    workshopId: command.workId,
    versionId: command.versionId,
    reason: meta.reason,
  }, context);
  if (!result) {
    throw new WorkCommandConflict("not_found");
  }
  await context.append({
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
  return runDatabaseWorkCommand(command, "ensureWorkSelfAuditLoop", applyEnsureWorkSelfAuditLoop);
}

async function applyEnsureWorkSelfAuditLoop(command: Parameters<typeof ensureWorkSelfAuditLoop>[0], context: WorkshopWriteContext) {
  const meta = commandMetadata(command);
  const result = await ensureWorkshopWorkSelfAuditLoop({
    userId: command.userId,
    workshopId: command.workId,
    timezone: command.timezone,
    cronExpression: command.cronExpression,
  }, context);
  await context.append({
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
