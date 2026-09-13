import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import { db, withDatabaseTransaction } from "@/lib/db/client";
import {
  interactionProcessingJobs,
  interactionEvents,
  type InsertInteractionProcessingJob,
  type InteractionProcessingJob,
} from "@/lib/db/schema";
import { deserializeJson, serializeJson } from "@/lib/db/serialization";
import type { InteractionProcessingMode } from "@/lib/knowledge-pipeline/source-policy-runtime";
import {lockInteractionSourcePolicies} from '@/lib/knowledge-pipeline/source-policies';

async function projectJobEvents(tx:Pick<typeof db,'update'>,job:InteractionProcessingJob,status:'processing'|'seen'|'failed') {
  const ids=normalizeEventIds(job.eventIds);
  if(!ids.length)return;
  await tx.update(interactionEvents).set({processedStatus:status,updatedAt:new Date()})
    .where(and(eq(interactionEvents.userId,job.userId),inArray(interactionEvents.id,ids)));
}

function normalizeEventIds(value: unknown): string[] {
  const parsed = deserializeJson(value as never);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

export function normalizeInteractionProcessingJob(
  job: InteractionProcessingJob,
): InteractionProcessingJob {
  return {
    ...job,
    eventIds: normalizeEventIds(job.eventIds),
  };
}

export async function createInteractionProcessingJob(input: {
  userId: string;
  eventIds: string[];
  processingMode: InteractionProcessingMode;
  priority?: number;
  scheduledAt?: Date;
}) {
  const now = new Date();
  const eventIds = [...new Set(input.eventIds.map((id) => id.trim()))].filter(
    Boolean,
  );
  const values: InsertInteractionProcessingJob = {
    id: randomUUID(),
    userId: input.userId,
    eventId: eventIds[0] ?? null,
    threadId: null,
    eventIds: serializeJson(eventIds) as string[],
    processingMode: input.processingMode,
    jobType: "summarize_thread",
    status: "pending",
    priority: input.priority ?? 0,
    attempts: 0,
    lastError: null,
    scheduledAt: input.scheduledAt ?? now,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  } as InsertInteractionProcessingJob;
  const [created] = await db
    .insert(interactionProcessingJobs)
    .values(values)
    .returning();
  return normalizeInteractionProcessingJob(
    created as InteractionProcessingJob,
  );
}

export async function claimInteractionProcessingJob(input: {
  userId: string;
  jobId: string;
  now?: Date;
  maxAttempts?: number;
  runtimeInstanceId?: string;
}) {
  const now = input.now ?? new Date();
  const claim = async (executor: Pick<typeof db, 'update'>) => {
  const [claimed] = await executor
    .update(interactionProcessingJobs)
    .set({
      status: "running",
      attempts: sql`${interactionProcessingJobs.attempts} + 1`,
      lastError: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(interactionProcessingJobs.userId, input.userId),
        eq(interactionProcessingJobs.id, input.jobId),
        inArray(interactionProcessingJobs.status, ["pending", "failed", "resume_pending"]),
        lte(interactionProcessingJobs.scheduledAt, now),
        or(eq(interactionProcessingJobs.status,'resume_pending'),lt(interactionProcessingJobs.attempts, input.maxAttempts ?? 3)),
      ),
    )
    .returning();
  return claimed
    ? normalizeInteractionProcessingJob(claimed as InteractionProcessingJob)
    : null;
  };
  return db.transaction(async(tx:any)=>{
    if(input.runtimeInstanceId){
    const rows=await tx.execute(sql`SELECT l.instance_id FROM runtime_owner_leases l JOIN runtime_instances i ON i.id=l.instance_id
      WHERE l.owner_id=${input.userId}::uuid AND l.instance_id=${input.runtimeInstanceId}::uuid
      AND l.lease_until>clock_timestamp() AND i.phase='running' AND i.desired_status='running' FOR SHARE OF l`);
    if(!rows.length)return null;
    }
    const claimed=await claim(tx);
    if(claimed){
    await projectJobEvents(tx,claimed,'processing');
    if(input.runtimeInstanceId)await tx.execute(sql`INSERT INTO runtime_interaction_claims(job_id,attempt,owner_id,instance_id)
      VALUES (${claimed.id}::uuid,${claimed.attempts},${input.userId}::uuid,${input.runtimeInstanceId}::uuid)`);
    }
    return claimed;
  });
}

/** A dead owner does not prove that derived writes failed; hold for reconciliation, never replay. */
export async function recoverInterruptedInteractionJobs(userId:string) {
  const rows=await db.execute(sql`WITH held AS (
    UPDATE interaction_processing_jobs j SET status='needs_review',last_error='interaction_host_lost_result_unknown',updated_at=clock_timestamp()
    FROM runtime_interaction_claims c WHERE j.id=c.job_id AND j.attempts=c.attempt AND j.user_id=c.owner_id
      AND c.owner_id=${userId}::uuid AND j.status IN ('running','applying')
      AND NOT EXISTS (SELECT 1 FROM runtime_owner_leases l JOIN runtime_instances i ON i.id=l.instance_id
        WHERE l.owner_id=c.owner_id AND l.instance_id=c.instance_id AND l.lease_until>clock_timestamp() AND i.phase NOT IN ('stopped','lost'))
    RETURNING j.id,j.attempts,j.user_id,j.event_ids
  ), receipts AS (
    UPDATE runtime_interaction_claims c SET recovered_at=clock_timestamp() FROM held
    WHERE c.job_id=held.id AND c.attempt=held.attempts RETURNING c.job_id
  ), projected AS (
    UPDATE interaction_events e SET processed_status='failed',updated_at=clock_timestamp() FROM held
    WHERE e.user_id=held.user_id AND held.event_ids ? e.id::text AND e.processed_status='processing' RETURNING e.id
  ) SELECT job_id FROM receipts`);
  return rows.length;
}

export async function completeInteractionProcessingJob(input: {
  userId: string;
  jobId: string;
  attempt: number;
  runtimeInstanceId?: string;
}) {
  const now = new Date();
  return db.transaction(async(tx:any)=>{
  const [completed] = await tx
    .update(interactionProcessingJobs)
    .set({
      status: "completed",
      lastError: null,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(interactionProcessingJobs.userId, input.userId),
        eq(interactionProcessingJobs.id, input.jobId),
        inArray(interactionProcessingJobs.status, ["running", "applying"]),
        eq(interactionProcessingJobs.attempts, input.attempt),
        interactionHostFence(input),
      ),
    )
    .returning();
  if(completed)await projectJobEvents(tx,completed,'seen');
  return completed
    ? normalizeInteractionProcessingJob(completed as InteractionProcessingJob)
    : null;
  });
}

export async function failInteractionProcessingJob(input: {
  userId: string;
  jobId: string;
  attempt: number;
  error: unknown;
  retryAt?: Date | null;
}) {
  const now = new Date();
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  return db.transaction(async(tx:any)=>{
  const [failed] = await tx
    .update(interactionProcessingJobs)
    .set({
      status: sql`CASE WHEN ${interactionProcessingJobs.status} = 'applying' OR EXISTS(SELECT 1 FROM interaction_processing_plans p WHERE p.job_id=${interactionProcessingJobs.id} AND p.owner_id=${interactionProcessingJobs.userId}) THEN 'needs_review' ELSE 'failed' END`,
      lastError: message.slice(0, 4000),
      scheduledAt: input.retryAt ?? now,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(interactionProcessingJobs.userId, input.userId),
        eq(interactionProcessingJobs.id, input.jobId),
        inArray(interactionProcessingJobs.status, ["running", "applying"]),
        eq(interactionProcessingJobs.attempts, input.attempt),
      ),
    )
    .returning();
  if(failed)await projectJobEvents(tx,failed,'failed');
  return failed
    ? normalizeInteractionProcessingJob(failed as InteractionProcessingJob)
    : null;
  });
}

/** Durable boundary before the first derived write. Unknown partial results must not auto-replay. */
type ProcessingAttempt = {userId:string;jobId:string;attempt:number;runtimeInstanceId?:string};
/** Derived records and completion commit together; raw observations are outside this scope. */
export async function applyInteractionProcessingWrites<T>(input:ProcessingAttempt,work:()=>Promise<T>):Promise<T> {
  return withDatabaseTransaction(async()=>{
    await lockInteractionSourcePolicies(input.userId);
    // Holding the job row also serializes crash reconciliation and owner review.
    const rows=await db.update(interactionProcessingJobs).set({status:'applying'})
      .where(and(eq(interactionProcessingJobs.id,input.jobId),eq(interactionProcessingJobs.userId,input.userId),
        eq(interactionProcessingJobs.attempts,input.attempt),eq(interactionProcessingJobs.status,'applying')))
      .returning({id:interactionProcessingJobs.id});
    if(!rows.length)throw Error('interaction_processing_attempt_lost');
    await assertInteractionProcessingWrites(input);
    const result=await work();
    const completed=await completeInteractionProcessingJob(input);
    if(!completed)throw Error('interaction_processing_attempt_lost');
    return result;
  });
}
function interactionHostFence(input:ProcessingAttempt) {
  if(!input.runtimeInstanceId)return undefined;
  return sql`EXISTS (SELECT 1 FROM runtime_interaction_claims c JOIN runtime_owner_leases l ON l.owner_id=c.owner_id AND l.instance_id=c.instance_id
    JOIN runtime_instances i ON i.id=l.instance_id WHERE c.job_id=${input.jobId}::uuid AND c.attempt=${input.attempt}
    AND c.owner_id=${input.userId}::uuid AND c.instance_id=${input.runtimeInstanceId}::uuid
    AND l.lease_until>clock_timestamp() AND i.phase NOT IN ('stopped','lost'))`;
}
export async function assertInteractionProcessingWrites(input:ProcessingAttempt) {
  const [current]=await db.select({id:interactionProcessingJobs.id}).from(interactionProcessingJobs)
    .where(and(eq(interactionProcessingJobs.userId,input.userId),eq(interactionProcessingJobs.id,input.jobId),
      eq(interactionProcessingJobs.attempts,input.attempt),eq(interactionProcessingJobs.status,'applying'),interactionHostFence(input))).limit(1);
  if(!current)throw Error('interaction_processing_attempt_lost');
}
export async function beginInteractionProcessingWrites(input: ProcessingAttempt) {
  const [claimed] = await db.update(interactionProcessingJobs)
    .set({status:'applying',updatedAt:new Date()})
    .where(and(eq(interactionProcessingJobs.userId,input.userId),eq(interactionProcessingJobs.id,input.jobId),
      eq(interactionProcessingJobs.attempts,input.attempt),eq(interactionProcessingJobs.status,'running'),interactionHostFence(input))).returning();
  if(!claimed)throw Error('interaction_processing_attempt_lost');
}

export async function countInteractionProcessingReviews(userId:string) {
  const [result]=await db.select({count:sql<number>`count(*)`}).from(interactionProcessingJobs)
    .where(and(eq(interactionProcessingJobs.userId,userId),eq(interactionProcessingJobs.status,'needs_review')));
  return Number(result?.count??0);
}

export async function listRunnableInteractionProcessingJobs(input: {
  userId: string;
  now?: Date;
  limit?: number;
  maxAttempts?: number;
}) {
  const rows = await db
    .select()
    .from(interactionProcessingJobs)
    .where(
      and(
        eq(interactionProcessingJobs.userId, input.userId),
        inArray(interactionProcessingJobs.status, ["pending", "failed", "resume_pending"]),
        lte(interactionProcessingJobs.scheduledAt, input.now ?? new Date()),
        or(eq(interactionProcessingJobs.status,'resume_pending'),lt(interactionProcessingJobs.attempts, input.maxAttempts ?? 3)),
      ),
    )
    .orderBy(
      asc(interactionProcessingJobs.priority),
      asc(interactionProcessingJobs.scheduledAt),
    )
    .limit(Math.min(Math.max(input.limit ?? 20, 1), 100));
  return (rows as InteractionProcessingJob[]).map(
    normalizeInteractionProcessingJob,
  );
}
