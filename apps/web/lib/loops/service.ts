import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import type { DrizzleDB } from '@/lib/db/types';
import {resolveExecutionLease} from '@/lib/work-runtime/execution-context';
import {ExecutionLeaseError} from '@/lib/work-runtime/execution-errors';
import {withLinkedLoopWrite} from '@/lib/work-runtime/loop-execution';
import {withLegacyLoopWrite,supportsLoopMigration} from './legacy-write';
import { deserializeJson, serializeJson } from '@/lib/db/serialization';
import { isWorkHarnessEvolutionEnabled } from '@/lib/harness-evolution/feature-flags';
import type { RunHarnessCaptureContext } from '@/lib/harness-evolution/types';
import {
  loopApprovalRequests,
  loopRuns,
  loops,
  loopStates,
  type InsertLoopApprovalRequest,
  type InsertLoop,
  type InsertLoopRun,
  type InsertLoopState,
  type Loop,
  type LoopApprovalRequest,
  type LoopRun,
  type LoopState,
} from '@/lib/db/schema';
import type {
  CompleteLoopRunInput,
  CreateLoopApprovalRequestInput,
  CreateLoopInput,
  CreateLoopRunInput,
  LoopJson,
  LoopApprovalRequestStatus,
  LoopStateInput,
  LoopStatus,
  ResolveLoopApprovalRequestInput,
  UpdateLoopInput,
} from './types';

const EMPTY_OBJECT: LoopJson = {};

function toDbJson(value: unknown) {
  const data = value === null || value === undefined ? EMPTY_OBJECT : value;
  return serializeJson(
    data as Record<string, unknown> | unknown[] | string | number | boolean,
  ) as Record<string, unknown>;
}

function toDbJsonOrNull(value: unknown | null | undefined) {
  if (value === null || value === undefined) return null;
  return serializeJson(
    value as Record<string, unknown> | unknown[] | string | number | boolean,
  ) as Record<string, unknown>;
}

function toDbArray(value: unknown[] | null | undefined) {
  return serializeJson(value ?? []) as unknown[];
}

function parseJsonObject(value: unknown): LoopJson {
  const parsed = deserializeJson(value as any);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as LoopJson;
  }
  return {};
}

function parseJsonArray(value: unknown): unknown[] {
  const parsed = deserializeJson(value as any);
  return Array.isArray(parsed) ? parsed : [];
}

function normalizeLoop<T extends Loop>(loop: T): T {
  return {
    ...loop,
    triggerConfig: parseJsonObject(loop.triggerConfig),
    contextConfig: parseJsonObject(loop.contextConfig),
    actionPolicy: parseJsonObject(loop.actionPolicy),
    verificationConfig: parseJsonObject(loop.verificationConfig),
    approvalPolicy: parseJsonObject(loop.approvalPolicy),
    retryPolicy: parseJsonObject(loop.retryPolicy),
    escalationPolicy: parseJsonObject(loop.escalationPolicy),
  };
}

function normalizeLoopRun<T extends LoopRun>(run: T): T {
  return {
    ...run,
    triggerReason:
      run.triggerReason === null ? null : parseJsonObject(run.triggerReason),
    inputSnapshot:
      run.inputSnapshot === null ? null : parseJsonObject(run.inputSnapshot),
    verificationResult:
      run.verificationResult === null
        ? null
        : parseJsonObject(run.verificationResult),
  };
}

function normalizeLoopState<T extends LoopState>(state: T): T {
  return {
    ...state,
    openQuestions: parseJsonArray(state.openQuestions),
    stateJson: parseJsonObject(state.stateJson),
  };
}

function normalizeLoopApprovalRequest<T extends LoopApprovalRequest>(
  request: T,
): T {
  return {
    ...request,
    toolInput:
      request.toolInput === null ? null : parseJsonObject(request.toolInput),
    actionPayload:
      request.actionPayload === null
        ? null
        : parseJsonObject(request.actionPayload),
  };
}

function buildLoopStateInsert(
  loopId: string,
  input?: Partial<LoopStateInput>,
): InsertLoopState {
  return {
    loopId,
    currentPhase: input?.currentPhase ?? 'idle',
    memorySummary: input?.memorySummary ?? null,
    openQuestions: toDbArray(input?.openQuestions),
    lastObservation: input?.lastObservation ?? null,
    nextAction: input?.nextAction ?? null,
    blockedReason: input?.blockedReason ?? null,
    stateJson: toDbJson(input?.stateJson),
    updatedAt: new Date(),
  } as InsertLoopState;
}

export async function createLoop(input: CreateLoopInput, store: DrizzleDB = db): Promise<Loop> {
  const now = new Date();
  const loopData: InsertLoop = {
    id: crypto.randomUUID(),
    userId: input.userId,
    workshopId: input.workshopId ?? null,
    name: input.name,
    description: input.description ?? null,
    goal: input.goal,
    status: input.status ?? 'active',
    triggerConfig: toDbJson(input.triggerConfig),
    contextConfig: toDbJson(input.contextConfig),
    actionPolicy: toDbJson(input.actionPolicy),
    verificationConfig: toDbJson(input.verificationConfig),
    approvalPolicy: toDbJson(input.approvalPolicy),
    retryPolicy: toDbJson(input.retryPolicy),
    escalationPolicy: toDbJson(input.escalationPolicy),
    createdAt: now,
    updatedAt: now,
  } as InsertLoop;

  const [created] = await store.insert(loops).values(loopData).returning();
  const initialState =
    input.workshopId === undefined
      ? input.initialState
      : {
          ...(input.initialState ?? {}),
          stateJson: {
            ...(input.initialState?.stateJson ?? {}),
            workshopId: input.workshopId,
          },
        };
  await store
    .insert(loopStates)
    .values(buildLoopStateInsert(created.id, initialState));

  return normalizeLoop(created as Loop);
}

export async function getLoop(
  userId: string,
  loopId: string,
  store: DrizzleDB = db,
): Promise<Loop | null> {
  const [loop] = await store
    .select()
    .from(loops)
    .where(and(eq(loops.userId, userId), eq(loops.id, loopId)))
    .limit(1);

  return loop ? normalizeLoop(loop as Loop) : null;
}

export async function listLoops(
  userId: string,
  options: { status?: LoopStatus; limit?: number } = {},
): Promise<Loop[]> {
  const where = options.status
    ? and(eq(loops.userId, userId), eq(loops.status, options.status))
    : eq(loops.userId, userId);

  const rows = await db
    .select()
    .from(loops)
    .where(where)
    .orderBy(desc(loops.updatedAt))
    .limit(options.limit ?? 100);

  return rows.map((loop: Loop) => normalizeLoop(loop));
}

export async function updateLoop(
  userId: string,
  loopId: string,
  updates: UpdateLoopInput,
  store: DrizzleDB = db,
): Promise<Loop | null> {
  if(store===db){
    if(resolveExecutionLease())return withLinkedLoopWrite(loopId,({db:tx})=>updateLoop(userId,loopId,updates,tx));
    if(supportsLoopMigration())return withLegacyLoopWrite(loopId,tx=>updateLoop(userId,loopId,updates,tx));
  }
  const updateData: Partial<InsertLoop> = {
    updatedAt: new Date(),
  };

  if (updates.name !== undefined) updateData.name = updates.name;
  if (updates.goal !== undefined) updateData.goal = updates.goal;
  if (updates.description !== undefined) {
    updateData.description = updates.description;
  }
  if (updates.status !== undefined) updateData.status = updates.status;
  if (updates.workshopId !== undefined) {
    updateData.workshopId = updates.workshopId;
  }
  if (updates.triggerConfig !== undefined) {
    updateData.triggerConfig = toDbJson(updates.triggerConfig);
  }
  if (updates.contextConfig !== undefined) {
    updateData.contextConfig = toDbJson(updates.contextConfig);
  }
  if (updates.actionPolicy !== undefined) {
    updateData.actionPolicy = toDbJson(updates.actionPolicy);
  }
  if (updates.verificationConfig !== undefined) {
    updateData.verificationConfig = toDbJson(updates.verificationConfig);
  }
  if (updates.approvalPolicy !== undefined) {
    updateData.approvalPolicy = toDbJson(updates.approvalPolicy);
  }
  if (updates.retryPolicy !== undefined) {
    updateData.retryPolicy = toDbJson(updates.retryPolicy);
  }
  if (updates.escalationPolicy !== undefined) {
    updateData.escalationPolicy = toDbJson(updates.escalationPolicy);
  }

  const [updated] = await store
    .update(loops)
    .set(updateData)
    .where(and(eq(loops.userId, userId), eq(loops.id, loopId)))
    .returning();

  if (!updated) return null;

  if (updates.workshopId !== undefined) {
    const state = await getLoopState(loopId, store);
    await upsertLoopState(loopId, {
      stateJson: {
        ...(state?.stateJson ?? {}),
        workshopId: updates.workshopId,
      },
    }, store);
  }

  return normalizeLoop(updated as Loop);
}

export async function listLoopsForWorkshop(
  input: {
    userId: string;
    workshopId: string;
    status?: LoopStatus;
    limit?: number;
    selfAuditOnly?: boolean;
    names?: string[];
    manifestNames?: string[];
  },
  store: DrizzleDB = db,
): Promise<Loop[]> {
  const conditions = [
    eq(loops.userId, input.userId),
    eq(loops.workshopId, input.workshopId),
  ];
  if (input.status) {
    conditions.push(eq(loops.status, input.status));
  }
  if (input.selfAuditOnly) {
    conditions.push(sql`${loops.status} <> 'archived' AND (${loops.name} = 'Work 自检升级'
      OR position('Work self-audit' in ${loops.goal}) > 0 OR position('Work 模型' in ${loops.goal}) > 0
      OR ${loops.triggerConfig}->'metadata'->>'templateId' = 'work-self-audit')`);
  }
  if (input.names || input.manifestNames) conditions.push(or(
    input.names ? inArray(loops.name, input.names) : undefined,
    input.manifestNames?.length ? sql`EXISTS (SELECT 1 FROM ${loopStates} WHERE ${loopStates.loopId}=${loops.id}
      AND ${inArray(sql`${loopStates.stateJson}->>'manifestLoopName'`, input.manifestNames)})` : undefined,
  )!);

  const rows = await store
    .select()
    .from(loops)
    .where(and(...conditions))
    .orderBy(desc(loops.updatedAt))
    .limit(input.limit ?? 100);

  return rows.map((loop: Loop) => normalizeLoop(loop));
}

export async function getLoopInWorkshop(input: {
  userId: string;
  workshopId: string;
  loopId: string;
}, store: DrizzleDB = db): Promise<Loop | null> {
  const [loop] = await store
    .select()
    .from(loops)
    .where(
      and(
        eq(loops.userId, input.userId),
        eq(loops.workshopId, input.workshopId),
        eq(loops.id, input.loopId),
      ),
    )
    .limit(1);

  return loop ? normalizeLoop(loop as Loop) : null;
}

export async function archiveLoop(
  userId: string,
  loopId: string,
): Promise<Loop | null> {
  return updateLoop(userId, loopId, { status: 'archived' });
}

export async function deleteLoop(
  userId: string,
  loopId: string,
): Promise<boolean> {
  const [deleted] = await db
    .delete(loops)
    // Workshop history belongs to the Work audit trail. Raw deletion is only
    // available for standalone tasks, including when ownership changes race us.
    .where(and(eq(loops.userId, userId), eq(loops.id, loopId), isNull(loops.workshopId)))
    .returning({ id: loops.id });

  return Boolean(deleted);
}
export async function createLoopRun(
  input: CreateLoopRunInput,
): Promise<LoopRun> {
  const lease=resolveExecutionLease();
  if(lease)return withLinkedLoopWrite(input.loopId,async({db:store})=>{
    const [run]=await store.update(loopRuns).set({status:'running',startedAt:sql`COALESCE(${loopRuns.startedAt},clock_timestamp())`,updatedAt:new Date()})
      .where(and(eq(loopRuns.id,lease.runId),eq(loopRuns.loopId,input.loopId),inArray(loopRuns.status,['queued','running']))).returning();
    if(!run)throw new ExecutionLeaseError('result_conflict');
    return normalizeLoopRun(run as LoopRun);
  });
  const now = new Date();
  let harnessEvolution: RunHarnessCaptureContext | null = null;
  if (isWorkHarnessEvolutionEnabled()) {
    const [loop] = await db
      .select({ userId: loops.userId, workshopId: loops.workshopId })
      .from(loops)
      .where(eq(loops.id, input.loopId))
      .limit(1);
    if (loop?.workshopId) {
      try {
        const { prepareRunHarnessCaptureContext } = await import(
          '@/lib/harness-evolution/capture-service'
        );
        harnessEvolution = await prepareRunHarnessCaptureContext({
          userId: loop.userId,
          workId: loop.workshopId,
        });
      } catch (error) {
        console.warn('[LoopService] Harness snapshot preparation failed', error);
      }
    }
  }
  const runData: InsertLoopRun = {
    id: crypto.randomUUID(),
    loopId: input.loopId,
    status: input.status ?? 'running',
    triggerReason: toDbJsonOrNull(input.triggerReason),
    inputSnapshot: toDbJsonOrNull({
      ...(input.inputSnapshot ?? {}),
      ...(harnessEvolution ? { harnessEvolution } : {}),
    }),
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  } as InsertLoopRun;

  return withLegacyLoopWrite(input.loopId,async tx=>{
    const [created] = await tx.insert(loopRuns).values(runData).returning();
    return normalizeLoopRun(created as LoopRun);
  });
}

export async function completeLoopRun(
  runId: string,
  input: CompleteLoopRunInput,
  store?: DrizzleDB,
): Promise<LoopRun | null> {
  const lease=resolveExecutionLease();
  if(lease&&!store){
    if(lease.runId!==runId)throw new ExecutionLeaseError('invalid_lease');
    return withExecutionLoopRun(runId,context=>completeLoopRun(runId,input,context));
  }
  if(!lease&&!store){
    const linked=await db.execute(sql`SELECT 1 FROM workshop_loop_executions WHERE loop_run_id=${runId}::uuid`);
    if(linked[0])throw new ExecutionLeaseError('invalid_lease');
    const [run]=await db.select({loopId:loopRuns.loopId}).from(loopRuns).where(eq(loopRuns.id,runId)).limit(1);
    if(!run)return null;
    if(supportsLoopMigration()){
      const completed=await withLegacyLoopWrite(run.loopId,tx=>completeLoopRun(runId,input,tx));
      if(completed)await captureCompletedLoopEvidence(completed.id);
      return completed;
    }
  }
  const now = new Date();
  const [updated] = await (store??db)
    .update(loopRuns)
    .set({
      status: input.status,
      completedAt: input.completedAt ?? now,
      outputSummary: input.outputSummary ?? null,
      verificationResult: toDbJsonOrNull(input.verificationResult),
      error: input.error ?? null,
      updatedAt: now,
    } as Partial<InsertLoopRun>)
    .where(eq(loopRuns.id, runId))
    .returning();

  const run = updated ? normalizeLoopRun(updated as LoopRun) : null;
  if (run && !lease && !store) await captureCompletedLoopEvidence(run.id);
  return run;
}

// Evidence readers use a separate connection, so invoke them after the guarded
// legacy write has committed, never while that connection still sees old data.
async function captureCompletedLoopEvidence(runId:string){
  if (isWorkHarnessEvolutionEnabled()) {
    try {
      const { captureCompletedLoopRunEvidence } = await import(
        '@/lib/harness-evolution/capture-service'
      );
      await captureCompletedLoopRunEvidence(runId);
    } catch (error) {
      console.warn('[LoopService] Harness evidence capture failed', error);
    }
  }
}

async function withExecutionLoopRun<T>(runId:string,write:(store:DrizzleDB)=>Promise<T>):Promise<T>{
  const [run]=await db.select({loopId:loopRuns.loopId}).from(loopRuns).where(eq(loopRuns.id,runId)).limit(1);
  if(!run)throw new ExecutionLeaseError('not_found');
  return withLinkedLoopWrite(run.loopId,({db:store})=>write(store));
}

export async function recoverInterruptedLoopRuns(
  input: {
    userId?: string;
    interruptedBefore?: Date;
  } = {},
): Promise<number> {
  const now = new Date();
  const interruptedBefore =
    input.interruptedBefore ?? new Date(now.getTime() - 90 * 60 * 1000);
  const conditions = [
    eq(loopRuns.status, 'running'),
    lt(loopRuns.startedAt, interruptedBefore),
    sql`NOT EXISTS (SELECT 1 FROM workshop_loop_executions x WHERE x.loop_run_id=${loopRuns.id})`,
  ];
  if (input.userId) {
    conditions.push(eq(loops.userId, input.userId));
  }

  const rows = await db
    .select({
      run: loopRuns,
      loop: loops,
    })
    .from(loopRuns)
    .innerJoin(loops, eq(loopRuns.loopId, loops.id))
    .where(and(...conditions))
    .orderBy(desc(loopRuns.startedAt))
    .limit(50);

  let recovered = 0;
  for (const row of rows) {
    const message =
      'Loop run was interrupted before completion, likely by server restart or process shutdown.';
    const updated = await completeLoopRun(row.run.id, {
      status: 'blocked',
      outputSummary: message,
      error: message,
      completedAt: now,
      verificationResult: {
        checker: {
          passed: false,
          feedback: message,
        },
        decision: {
          action: 'block',
          runStatus: 'blocked',
          statePhase: 'error',
          blockedReason: message,
        },
        recovery: {
          kind: 'interrupted_running_loop',
          recoveredAt: now.toISOString(),
          interruptedBefore: interruptedBefore.toISOString(),
        },
      },
    });
    if (!updated) continue;

    const state = await getLoopState(row.loop.id);
    const stateJson = parseJsonObject(state?.stateJson);
    const isCurrentInterruptedRun =
      state?.currentPhase === 'running' || stateJson.lastLoopRunId === row.run.id;
    if (isCurrentInterruptedRun) {
      await upsertLoopState(row.loop.id, {
        currentPhase: 'error',
        lastObservation: `Native loop "${row.loop.name}" was interrupted before completion`,
        nextAction: 'Review interrupted loop run',
        blockedReason: message,
        stateJson: {
          ...stateJson,
          lastLoopRunId: row.run.id,
          lastJobStatus: 'error',
          lastVerificationPassed: false,
          lastCheckerPassed: false,
          lastOutcomeAction: 'block',
          lastInterruptedRunId: row.run.id,
          lastInterruptedAt: now.toISOString(),
          lastInterruptedReason: message,
        },
      });
    }
    recovered += 1;
  }

  if (recovered > 0) {
    console.warn(`[LoopService] Recovered ${recovered} interrupted loop run(s)`);
  }
  return recovered;
}

export async function createLoopApprovalRequest(
  input: CreateLoopApprovalRequestInput,
  store?:DrizzleDB,
): Promise<LoopApprovalRequest> {
  const lease=resolveExecutionLease();
  if(lease&&!store){
    if(input.loopRunId!==lease.runId||input.userId!==lease.userId)throw new ExecutionLeaseError('invalid_lease');
    return withLinkedLoopWrite(input.loopId,({db:tx})=>createLoopApprovalRequest(input,tx));
  }
  if(!store&&supportsLoopMigration())return withLegacyLoopWrite(input.loopId,tx=>createLoopApprovalRequest(input,tx));
  const now = new Date();
  const requestData: InsertLoopApprovalRequest = {
    id: crypto.randomUUID(),
    loopId: input.loopId,
    loopRunId: input.loopRunId,
    userId: input.userId,
    status: input.status ?? 'pending',
    source: input.source ?? 'tool_gate',
    actionName: input.actionName,
    capability: input.capability ?? null,
    reason: input.reason ?? null,
    message: input.message ?? null,
    toolInput: toDbJsonOrNull(input.toolInput),
    actionPayload: toDbJsonOrNull(input.actionPayload),
    createdAt: now,
    updatedAt: now,
  } as InsertLoopApprovalRequest;

  const [created] = await (store??db)
    .insert(loopApprovalRequests)
    .values(requestData)
    .returning();

  return normalizeLoopApprovalRequest(created as LoopApprovalRequest);
}

export async function listLoopApprovalRequests(
  userId: string,
  options: {
    status?: LoopApprovalRequestStatus;
    loopId?: string;
    limit?: number;
  } = {},
): Promise<LoopApprovalRequest[]> {
  const conditions = [eq(loopApprovalRequests.userId, userId)];
  if (options.status) {
    conditions.push(eq(loopApprovalRequests.status, options.status));
  }
  if (options.loopId) {
    conditions.push(eq(loopApprovalRequests.loopId, options.loopId));
  }

  const rows = await db
    .select()
    .from(loopApprovalRequests)
    .where(and(...conditions))
    .orderBy(desc(loopApprovalRequests.createdAt))
    .limit(options.limit ?? 100);

  return rows.map((request: LoopApprovalRequest) =>
    normalizeLoopApprovalRequest(request),
  );
}

export async function getLoopApprovalRequest(
  userId: string,
  requestId: string,
  store: DrizzleDB = db,
): Promise<LoopApprovalRequest | null> {
  const [request] = await store
    .select()
    .from(loopApprovalRequests)
    .where(
      and(
        eq(loopApprovalRequests.userId, userId),
        eq(loopApprovalRequests.id, requestId),
      ),
    )
    .limit(1);

  return request
    ? normalizeLoopApprovalRequest(request as LoopApprovalRequest)
    : null;
}

export async function resolveLoopApprovalRequest(
  userId: string,
  requestId: string,
  input: ResolveLoopApprovalRequestInput,
  store: DrizzleDB = db,
): Promise<LoopApprovalRequest | null> {
  const now = new Date();
  const [updated] = await store
    .update(loopApprovalRequests)
    .set({
      status: input.status,
      resolvedBy: input.resolvedBy,
      resolvedAt: now,
      resolutionNote: input.resolutionNote ?? null,
      actionPayload:
        input.actionPayload === undefined
          ? undefined
          : toDbJsonOrNull(input.actionPayload),
      updatedAt: now,
    } as Partial<InsertLoopApprovalRequest>)
    .where(
      and(
        eq(loopApprovalRequests.userId, userId),
        eq(loopApprovalRequests.id, requestId),
      ),
    )
    .returning();

  return updated
    ? normalizeLoopApprovalRequest(updated as LoopApprovalRequest)
    : null;
}

export async function updateLoopApprovalRequestPayload(
  userId: string,
  requestId: string,
  actionPayload: LoopJson | null,
  store: DrizzleDB = db,
): Promise<LoopApprovalRequest | null> {
  const [updated] = await store
    .update(loopApprovalRequests)
    .set({
      actionPayload: toDbJsonOrNull(actionPayload),
      updatedAt: new Date(),
    } as Partial<InsertLoopApprovalRequest>)
    .where(
      and(
        eq(loopApprovalRequests.userId, userId),
        eq(loopApprovalRequests.id, requestId),
      ),
    )
    .returning();

  return updated
    ? normalizeLoopApprovalRequest(updated as LoopApprovalRequest)
    : null;
}

export async function listLoopRuns(
  loopId: string,
  options: { limit?: number } = {},
  store: DrizzleDB = db,
): Promise<LoopRun[]> {
  const rows = await store
    .select()
    .from(loopRuns)
    .where(eq(loopRuns.loopId, loopId))
    .orderBy(desc(loopRuns.startedAt))
    .limit(options.limit ?? 50);

  return rows.map((run: LoopRun) => normalizeLoopRun(run));
}

export async function listLatestLoopRunsByLoopId(
  loopIds: string[],
): Promise<Map<string, LoopRun>> {
  if (loopIds.length === 0) return new Map();

  const rows = await db
    .select()
    .from(loopRuns)
    .where(
      and(
        inArray(loopRuns.loopId, loopIds),
        sql`${loopRuns.startedAt} = (
          select max(latest_loop_runs.started_at)
          from loop_runs latest_loop_runs
          where latest_loop_runs.loop_id = ${loopRuns.loopId}
        )`,
      ),
    )
    .orderBy(desc(loopRuns.startedAt), desc(loopRuns.createdAt), desc(loopRuns.id));

  const latestRuns = new Map<string, LoopRun>();
  for (const row of rows as LoopRun[]) {
    if (latestRuns.has(row.loopId)) continue;
    latestRuns.set(row.loopId, normalizeLoopRun(row));
    if (latestRuns.size === loopIds.length) break;
  }

  return latestRuns;
}

export async function getLoopState(loopId: string, store: DrizzleDB = db): Promise<LoopState | null> {
  const [state] = await store
    .select()
    .from(loopStates)
    .where(eq(loopStates.loopId, loopId))
    .limit(1);

  return state ? normalizeLoopState(state as LoopState) : null;
}

export async function listLoopStatesByLoopId(
  loopIds: string[],
  store: DrizzleDB = db,
): Promise<Map<string, LoopState>> {
  if (loopIds.length === 0) return new Map();

  const rows = await store
    .select()
    .from(loopStates)
    .where(inArray(loopStates.loopId, loopIds));

  return new Map(
    (rows as LoopState[]).map((state) => [
      state.loopId,
      normalizeLoopState(state),
    ]),
  );
}

export async function upsertLoopState(
  loopId: string,
  input: Partial<LoopStateInput>,
  store: DrizzleDB = db,
): Promise<LoopState> {
  if(resolveExecutionLease()&&store===db)return withLinkedLoopWrite(loopId,({db:tx})=>upsertLoopState(loopId,input,tx));
  if(store===db&&supportsLoopMigration())return withLegacyLoopWrite(loopId,tx=>upsertLoopState(loopId,input,tx));
  const existing = await getLoopState(loopId, store);
  const now = new Date();

  if (!existing) {
    const [created] = await store
      .insert(loopStates)
      .values(buildLoopStateInsert(loopId, input))
      .returning();
    return normalizeLoopState(created as LoopState);
  }

  const updateData: Partial<InsertLoopState> = {
    updatedAt: now,
  };

  if (input.currentPhase !== undefined) {
    updateData.currentPhase = input.currentPhase;
  }
  if (input.memorySummary !== undefined) {
    updateData.memorySummary = input.memorySummary;
  }
  if (input.openQuestions !== undefined) {
    updateData.openQuestions = toDbArray(input.openQuestions);
  }
  if (input.lastObservation !== undefined) {
    updateData.lastObservation = input.lastObservation;
  }
  if (input.nextAction !== undefined) {
    updateData.nextAction = input.nextAction;
  }
  if (input.blockedReason !== undefined) {
    updateData.blockedReason = input.blockedReason;
  }
  if (input.stateJson !== undefined) {
    updateData.stateJson = toDbJson(input.stateJson);
  }

  const [updated] = await store
    .update(loopStates)
    .set(updateData)
    .where(eq(loopStates.loopId, loopId))
    .returning();

  return normalizeLoopState(updated as LoopState);
}
