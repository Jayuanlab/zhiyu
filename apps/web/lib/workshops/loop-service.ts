import type { Loop } from "@/lib/db/schema";
import {
  createLoop,
  createLoopFromNaturalLanguage,
  createLoopFromTemplate,
  draftLoopFromNaturalLanguage,
  computeNextLoopRun,
  getLoopInWorkshop,
  getLoopState,
  listLoopsForWorkshop,
  loopSpecToCreateLoopInput,
  updateLoop,
  upsertLoopState,
  WORK_SELF_AUDIT_TEMPLATE_ID,
  type LoopTemplateId,
  type LoopTemplateInput,
  type NaturalLanguageLoopDraft,
} from "@/lib/loops";
import { appendWorkshopEvent, getWorkshop } from "./service";
import type {WorkshopWriteContext} from "./service";
import {runPreparedDatabaseWorkCommand} from "@/lib/work-runtime/database-command";
import {workCommandChildId} from "@/lib/work-runtime/child-id";
import {WorkCommandConflict} from "@/lib/work-runtime/command-ledger";
import {sql} from "drizzle-orm";

type TemplateInputOverrides = Partial<
  Omit<LoopTemplateInput, "userId" | "workshopId" | "templateId">
>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isPendingOwnerActivation(stateJson: Record<string, unknown>) {
  const status = stateJson.ownerActivationStatus;
  return (
    stateJson.requiresOwnerActivation === true &&
    (status === undefined || status === "pending")
  );
}

async function assertWorkshopAccess(input: {
  userId: string;
  workshopId: string;
}, context?: WorkshopWriteContext) {
  const workshop = await getWorkshop(input.userId, input.workshopId, context?.db);
  if (!workshop) {
    throw new Error("Workshop not found");
  }
  return workshop;
}

async function appendLoopCreatedEvent(input: {
  workshopId: string;
  loop: Loop;
  source: "template" | "natural_language";
}, context?: WorkshopWriteContext) {
  await (context?.append ?? appendWorkshopEvent)({
    workshopId: input.workshopId,
    loopId: input.loop.id,
    type: "loop_created",
    title: `Task created: ${input.loop.name}`,
    body: input.loop.description ?? input.loop.goal,
    metadata: {
      loopId: input.loop.id,
      source: input.source,
      triggerConfig: input.loop.triggerConfig,
    },
  });
}

export async function createWorkshopLoopFromTemplate(input: {
  userId: string;
  workshopId: string;
  templateId: LoopTemplateId;
  templateInput?: TemplateInputOverrides;
}, context?: WorkshopWriteContext): Promise<Loop> {
  await assertWorkshopAccess(input, context);

  const loop = await createLoopFromTemplate({
    ...(input.templateInput ?? {}),
    userId: input.userId,
    workshopId: input.workshopId,
    templateId: input.templateId,
  } as LoopTemplateInput, context?.db);

  await appendLoopCreatedEvent({
    workshopId: input.workshopId,
    loop,
    source: "template",
  }, context);

  return loop;
}

function isWorkSelfAuditLoop(loop: Loop) {
  const triggerConfig = asRecord(loop.triggerConfig);
  const metadata = asRecord(triggerConfig.metadata);
  return (
    loop.status !== "archived" &&
    (loop.name === "Work 自检升级" ||
      loop.goal.includes("Work self-audit") ||
      loop.goal.includes("Work 模型") ||
      metadata.templateId === WORK_SELF_AUDIT_TEMPLATE_ID)
  );
}

export async function ensureWorkshopWorkSelfAuditLoop(input: {
  userId: string;
  workshopId: string;
  timezone?: string;
  cronExpression?: string;
}, context?: WorkshopWriteContext): Promise<{ loop: Loop; created: boolean }> {
  await assertWorkshopAccess(input, context);
  const existing = (
    await listLoopsForWorkshop({
      userId: input.userId,
      workshopId: input.workshopId,
      limit: 1,
      selfAuditOnly: true,
    }, context?.db)
  ).find(isWorkSelfAuditLoop);

  if (existing) {
    return { loop: existing, created: false };
  }

  const loop = await createWorkshopLoopFromTemplate({
    userId: input.userId,
    workshopId: input.workshopId,
    templateId: WORK_SELF_AUDIT_TEMPLATE_ID,
    templateInput: {
      timezone: input.timezone ?? "Asia/Shanghai",
      cronExpression: input.cronExpression ?? "0 3 * * *",
    },
  }, context);

  await (context?.append ?? appendWorkshopEvent)({
    workshopId: input.workshopId,
    loopId: loop.id,
    type: "work_upgrade_loop_ready",
    title: "Work 自检升级任务已就绪",
    body:
      "车间现在会持续检查 Work 模型、工具边界、Skill、Loop 和版本状态，并在需要时生成可审核改造提案。",
    metadata: {
      loopId: loop.id,
      templateId: WORK_SELF_AUDIT_TEMPLATE_ID,
      triggerConfig: loop.triggerConfig,
    },
  });

  return { loop, created: true };
}

export async function draftWorkshopLoopFromNaturalLanguage(input: {
  userId: string;
  workshopId: string;
  intent: string;
  timezone?: string;
  externalWriteMode?: "manual_approval" | "loop_approved";
}): Promise<NaturalLanguageLoopDraft> {
  await assertWorkshopAccess(input);
  return draftLoopFromNaturalLanguage({
    userId: input.userId,
    workshopId: input.workshopId,
    intent: input.intent,
    timezone: input.timezone,
    externalWriteMode: input.externalWriteMode,
  });
}

export async function createWorkshopLoopFromNaturalLanguage(input: {
  userId: string;
  workshopId: string;
  intent: string;
  timezone?: string;
  externalWriteMode?: "manual_approval" | "loop_approved";
}): Promise<{ loop: Loop; draft: NaturalLanguageLoopDraft }> {
  await assertWorkshopAccess(input);

  const result = await createLoopFromNaturalLanguage({
    userId: input.userId,
    workshopId: input.workshopId,
    intent: input.intent,
    timezone: input.timezone,
    externalWriteMode: input.externalWriteMode,
  });

  await appendLoopCreatedEvent({
    workshopId: input.workshopId,
    loop: result.loop,
    source: "natural_language",
  });

  return result;
}

export async function proposeWorkshopLoopFromNaturalLanguage(input: {
  userId: string;
  workshopId: string;
  intent: string;
  timezone?: string;
  proposedBy?: "workshop_agent" | "user";
  runId?: string | null;
  loopRunId?: string | null;
  commandId?: string;
  expectedVersion?: number;
  proposalReason?: string | null;
}): Promise<{ loop: Loop; draft: NaturalLanguageLoopDraft }> {
  await assertWorkshopAccess(input);
  const scope = input.runId ?? input.loopRunId;
  if (!input.commandId && !scope) throw new WorkCommandConflict("invalid_command");
  const command = {...input, workId: input.workshopId,
    commandId: input.commandId ?? workCommandChildId(input.userId, input.workshopId, scope!, `loop-proposal:${input.intent.trim()}`),
    source: input.proposedBy === "user" ? "owner" as const : "workshop_agent" as const};
  return runPreparedDatabaseWorkCommand(command, "proposeWorkLoop", async persisted => {
    const draft = await draftLoopFromNaturalLanguage({
      userId: persisted.userId, workshopId: persisted.workId, intent: persisted.intent,
      timezone: persisted.timezone, externalWriteMode: "manual_approval",
    });
    if (draft.extracted.missingFields.length) throw new WorkCommandConflict("invalid_command");
    return draft;
  }, async (persisted, draft, context) => {
    if (persisted.runId) {
      const rows = await context.db.execute(sql`SELECT id FROM workshop_runs WHERE id=${persisted.runId}::uuid AND workshop_id=${persisted.workId}::uuid`);
      if (!rows[0]) throw new WorkCommandConflict("not_found");
    }
    if (persisted.loopRunId) {
      const rows = await context.db.execute(sql`SELECT r.id FROM loop_runs r JOIN loops l ON l.id=r.loop_id
        WHERE r.id=${persisted.loopRunId}::uuid AND l.workshop_id=${persisted.workId}::uuid AND l.user_id=${persisted.userId}::uuid`);
      if (!rows[0]) throw new WorkCommandConflict("not_found");
    }
    return createWorkshopLoopProposalFromDraft(persisted, draft, context);
  });
}

async function createWorkshopLoopProposalFromDraft(input: Parameters<typeof proposeWorkshopLoopFromNaturalLanguage>[0], draft: NaturalLanguageLoopDraft, context: WorkshopWriteContext) {
  /* Draft was prepared outside the transaction and saved in the command ledger. */
  const createInput = loopSpecToCreateLoopInput({
    userId: input.userId,
    workshopId: input.workshopId,
    name: draft.name,
    description: draft.description,
    spec: draft.spec,
  });
  const loop = await createLoop({
    ...createInput,
    status: "paused",
    initialState: {
      ...(createInput.initialState ?? {}),
      currentPhase: "approval",
      lastObservation: "Workshop agent proposed this task.",
      nextAction: "Owner should review and activate this task if useful.",
      blockedReason: "Awaiting owner activation before scheduling.",
      stateJson: {
        ...(createInput.initialState?.stateJson ?? {}),
        workshopId: input.workshopId,
        proposedBy: input.proposedBy ?? "workshop_agent",
        proposedFromRunId: input.runId ?? null,
        proposedFromLoopRunId: input.loopRunId ?? null,
        proposalReason: input.proposalReason ?? null,
        requiresOwnerActivation: true,
        ownerActivationStatus: "pending",
      },
    },
  }, context.db);

  await context.append({
    workshopId: input.workshopId,
    runId: input.runId ?? null,
    loopRunId: input.loopRunId ?? null,
    loopId: loop.id,
    type: "loop_proposed",
    title: `Task proposed: ${loop.name}`,
    body: loop.description ?? loop.goal,
    metadata: {
      loopId: loop.id,
      source: input.proposedBy ?? "workshop_agent",
      triggerConfig: loop.triggerConfig,
      status: "paused",
      requiresOwnerActivation: true,
      proposalReason: input.proposalReason ?? null,
      commandId: input.commandId,
      draft,
    },
  });

  return { loop, draft };
}

async function getPendingWorkshopLoopProposal(input: {
  userId: string;
  workshopId: string;
  loopId: string;
}, context?: WorkshopWriteContext) {
  if (!await getWorkshop(input.userId, input.workshopId, context?.db)) throw new WorkCommandConflict("not_found");

  const [loop, state] = await Promise.all([
    getLoopInWorkshop(input, context?.db),
    getLoopState(input.loopId, context?.db),
  ]);

  if (!loop) {
    throw new WorkCommandConflict("not_found");
  }

  const stateJson = asRecord(state?.stateJson);
  if (!isPendingOwnerActivation(stateJson)) {
    throw new WorkCommandConflict(
      stateJson.ownerActivationStatus === "activated" || stateJson.ownerActivationStatus === "rejected"
        ? "proposal_already_resolved" : "invalid_proposal",
    );
  }

  return { loop, state, stateJson };
}

export async function activateWorkshopLoopProposal(input: {
  userId: string;
  workshopId: string;
  loopId: string;
  activatedBy?: "owner" | "system";
}, context?: WorkshopWriteContext): Promise<Loop> {
  const { loop, state, stateJson } = await getPendingWorkshopLoopProposal(input, context);
  const now = new Date();
  const nextRun = computeNextLoopRun({
    triggerConfig: loop.triggerConfig,
    from: now,
  });
  const activatedLoop =
    await updateLoop(input.userId, input.loopId, {
      status: "active",
    }, context?.db);
  if (!activatedLoop) throw new WorkCommandConflict("not_found");

  await upsertLoopState(input.loopId, {
    currentPhase: state?.currentPhase === "approval" ? "idle" : state?.currentPhase ?? "idle",
    nextAction: nextRun
      ? `Next scheduled run at ${nextRun.toISOString()}`
      : "Run manually or update the task schedule.",
    blockedReason: null,
    stateJson: {
      ...stateJson,
      requiresOwnerActivation: false,
      ownerActivationStatus: "activated",
      ownerActivatedAt: now.toISOString(),
      ownerActivatedBy: input.activatedBy ?? "owner",
      nextScheduledRunAt:
        nextRun?.toISOString() ??
        (typeof stateJson.nextScheduledRunAt === "string"
          ? stateJson.nextScheduledRunAt
          : undefined),
      schedulerStatus:
        nextRun !== null
          ? "idle"
          : typeof stateJson.schedulerStatus === "string"
            ? stateJson.schedulerStatus
            : undefined,
      schedulerError: undefined,
    },
  }, context?.db);

  await (context?.append ?? appendWorkshopEvent)({
    workshopId: input.workshopId,
    loopId: input.loopId,
    type: "loop_activated",
    title: `Task activated: ${activatedLoop.name}`,
    body: nextRun
      ? `Next scheduled run: ${nextRun.toISOString()}`
      : "Task activated without a native schedule; it can be run manually.",
    metadata: {
      loopId: input.loopId,
      nextScheduledRunAt: nextRun?.toISOString() ?? null,
      activatedBy: input.activatedBy ?? "owner",
    },
  });

  return activatedLoop;
}

export async function rejectWorkshopLoopProposal(input: {
  userId: string;
  workshopId: string;
  loopId: string;
  reason?: string | null;
}, context?: WorkshopWriteContext): Promise<Loop> {
  const { loop, stateJson } = await getPendingWorkshopLoopProposal(input, context);
  const now = new Date();
  const rejectedLoop =
    await updateLoop(input.userId, input.loopId, {
      status: "archived",
    }, context?.db);
  if (!rejectedLoop) throw new WorkCommandConflict("not_found");

  await upsertLoopState(input.loopId, {
    currentPhase: "rejected",
    nextAction: null,
    blockedReason: input.reason ?? "Owner rejected this task proposal.",
    stateJson: {
      ...stateJson,
      requiresOwnerActivation: false,
      ownerActivationStatus: "rejected",
      ownerRejectedAt: now.toISOString(),
      ownerRejectionReason: input.reason ?? null,
      nextScheduledRunAt: undefined,
      schedulerStatus: undefined,
      schedulerError: undefined,
    },
  }, context?.db);

  await (context?.append ?? appendWorkshopEvent)({
    workshopId: input.workshopId,
    loopId: input.loopId,
    type: "loop_rejected",
    title: `Task rejected: ${rejectedLoop.name}`,
    body: input.reason ?? "Owner rejected this task proposal.",
    metadata: {
      loopId: input.loopId,
      reason: input.reason ?? null,
    },
  });

  return rejectedLoop;
}
