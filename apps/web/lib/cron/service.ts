/**
 * Scheduled Jobs Service
 * Manages cron jobs in the database
 * Compatible with both PostgreSQL (web) and SQLite (Tauri) modes
 */

import {
  eq,
  and,
  desc,
  asc,
  isNotNull,
  or,
  sql,
  inArray,
} from "drizzle-orm";
import { db } from "../db/index";
import {
  scheduledJobs,
  jobExecutions,
  characters,
  type InsertScheduledJob,
} from "../db/schema";
import type {
  ScheduleConfig,
  JobConfig,
  JobExecutionResult,
  JobExecutionContext,
} from "./types";
import { computeNextRun } from "./scheduler";
import { deserializeJson, serializeJson } from "../db/queries";
import { DEFAULT_JOB_TIMEOUT_MS } from "../env/config/constants";
import {LoopMigrationRequiredError} from '@/lib/loops/execution-boundary';

function legacyIntervalToMinutes(schedule: {
  hours?: number;
  minutes?: number;
}): number {
  return (schedule.hours ?? 0) * 60 + (schedule.minutes ?? 0) || 60;
}

/**
 * List all jobs for a user
 */
export async function listJobs(
  userId: string,
  opts: {
    includeDisabled?: boolean;
    view?: "all" | "active" | "executed";
  } = {},
) {
  const baseConditions = opts.includeDisabled
    ? eq(scheduledJobs.userId, userId)
    : and(eq(scheduledJobs.userId, userId), eq(scheduledJobs.enabled, true));

  let viewConditions = undefined;
  if (opts.view === "active") {
    // Active: recurring jobs OR one-time jobs with a pending next run.
    viewConditions = or(
      eq(scheduledJobs.scheduleType, "cron"),
      eq(scheduledJobs.scheduleType, "interval"),
      eq(scheduledJobs.scheduleType, "interval-hours"),
      eq(scheduledJobs.scheduleType, "interval-minutes"),
      and(
        eq(scheduledJobs.scheduleType, "once"),
        isNotNull(scheduledJobs.nextRunAt),
      ),
    );
  } else if (opts.view === "executed") {
    // Executed: one-time jobs with a terminal lastStatus (success/error), excluding running
    viewConditions = and(
      eq(scheduledJobs.scheduleType, "once"),
      or(
        eq(scheduledJobs.lastStatus, "success"),
        eq(scheduledJobs.lastStatus, "error"),
      ),
    );
  }
  // "all": no additional filter

  const conditions = viewConditions
    ? and(baseConditions, viewConditions)
    : baseConditions;

  const jobs = await db
    .select()
    .from(scheduledJobs)
    .where(conditions)
    .orderBy(asc(scheduledJobs.nextRunAt));

  // Fetch character names for jobs that have characterId in jobConfig
  const characterIds = jobs
    .map((job: typeof scheduledJobs.$inferSelect) => {
      const config =
        typeof job.jobConfig === "string"
          ? JSON.parse(job.jobConfig)
          : job.jobConfig;
      return config?.characterId as string | undefined;
    })
    .filter((id: string | undefined): id is string => Boolean(id));

  let characterNames: Record<string, string> = {};
  if (characterIds.length > 0) {
    const chars = await db
      .select({ id: characters.id, name: characters.name })
      .from(characters)
      .where(inArray(characters.id, characterIds));
    characterNames = Object.fromEntries(
      chars.map((c: { id: string; name: string }) => [c.id, c.name]),
    );
  }

  // Attach characterName to each job
  return jobs.map((job: typeof scheduledJobs.$inferSelect) => {
    const config =
      typeof job.jobConfig === "string"
        ? JSON.parse(job.jobConfig)
        : job.jobConfig;
    const characterId = config?.characterId as string | undefined;
    return {
      ...job,
      characterName: characterId ? (characterNames[characterId] ?? null) : null,
    };
  });
}

/**
 * Get a single job by ID
 */
export async function getJob(userId: string, jobId: string) {
  const jobs = await db
    .select()
    .from(scheduledJobs)
    .where(and(eq(scheduledJobs.userId, userId), eq(scheduledJobs.id, jobId)))
    .limit(1);

  if (!jobs[0]) return null;

  const job = jobs[0];
  // Deserialize jobConfig JSON string (needed for SQLite/Tauri mode)
  if (typeof job.jobConfig === "string") {
    (job as any).jobConfig = deserializeJson(job.jobConfig);
  }

  return job;
}

/**
 * Create a new scheduled job
 */
export async function createJob(
  userId: string,
  input: {
    name: string;
    description?: string;
    schedule: ScheduleConfig;
    job: JobConfig;
    enabled?: boolean;
    timezone?: string;
  },
) {
  const now = new Date();
  const nextRun = computeNextRun(input.schedule, now);

  const jobData: InsertScheduledJob = {
    id: crypto.randomUUID(),
    userId,
    name: input.name,
    description: input.description ?? null,
    scheduleType: input.schedule.type,
    cronExpression:
      input.schedule.type === "cron" ? input.schedule.expression : null,
    intervalMinutes:
      input.schedule.type === "interval-minutes"
        ? input.schedule.minutes
        : input.schedule.type === "interval-hours"
          ? (input.schedule.hours ?? 1) * 60
          : input.schedule.type === "interval"
            ? legacyIntervalToMinutes(input.schedule)
            : null,
    scheduledAt:
      input.schedule.type === "once"
        ? input.schedule.at instanceof Date
          ? input.schedule.at
          : new Date(input.schedule.at as string)
        : null,
    jobType: input.job.type,
    jobConfig: serializeJson(input.job) as unknown as Record<string, unknown>,
    enabled: input.enabled ?? true,
    timezone: input.timezone || "UTC",
    nextRunAt: nextRun,
    createdAt: now,
    updatedAt: now,
    runCount: 0,
    failureCount: 0,
  };

  const [job] = await db.insert(scheduledJobs).values(jobData).returning();
  return job;
}

/**
 * Update an existing job
 */
export async function updateJob(
  userId: string,
  jobId: string,
  updates: Partial<{
    name: string;
    description: string;
    schedule: ScheduleConfig;
    job: JobConfig;
    enabled: boolean;
    timezone: string;
  }>,
) {
  const job = await getJob(userId, jobId);
  if (!job) {
    throw new Error("Job not found");
  }

  const updateData: Partial<InsertScheduledJob> = {
    updatedAt: new Date(),
  };

  if (updates.name !== undefined) updateData.name = updates.name;
  if (updates.description !== undefined)
    updateData.description = updates.description;
  if (updates.enabled !== undefined) updateData.enabled = updates.enabled;
  if (updates.timezone !== undefined) updateData.timezone = updates.timezone;

  if (updates.schedule) {
    updateData.scheduleType = updates.schedule.type;
    if (updates.schedule.type === "cron") {
      updateData.cronExpression = updates.schedule.expression;
      updateData.intervalMinutes = null; // Clear old interval value when switching to cron
      updateData.scheduledAt = null; // Clear old once time when switching to cron
    } else if (updates.schedule.type === "interval-hours") {
      updateData.intervalMinutes = (updates.schedule.hours ?? 1) * 60;
      updateData.cronExpression = null; // Clear old cron expression when switching to interval
      updateData.scheduledAt = null; // Clear old once time when switching to interval
    } else if (updates.schedule.type === "interval-minutes") {
      updateData.intervalMinutes = updates.schedule.minutes;
      updateData.cronExpression = null; // Clear old cron expression when switching to interval
      updateData.scheduledAt = null; // Clear old once time when switching to interval
    } else if (updates.schedule.type === "interval") {
      updateData.intervalMinutes = legacyIntervalToMinutes(updates.schedule);
      updateData.cronExpression = null; // Clear old cron expression when switching to interval
      updateData.scheduledAt = null; // Clear old once time when switching to interval
    } else if (updates.schedule.type === "once") {
      // Handle both Date object and string (from JSON serialization)
      const atValue = updates.schedule.at;
      updateData.scheduledAt =
        atValue instanceof Date ? atValue : new Date(atValue as string);
      updateData.intervalMinutes = null; // Clear old interval value when switching to once
      updateData.cronExpression = null; // Clear old cron expression when switching to once
    }

    // Recompute next run time
    const nextRun = computeNextRun(updates.schedule, new Date());
    updateData.nextRunAt = nextRun;
    if (updates.schedule.type === "once" && nextRun) {
      updateData.lastStatus = null;
    }
  }

  if (updates.job) {
    updateData.jobConfig = serializeJson(updates.job) as unknown as Record<
      string,
      unknown
    >;
    updateData.jobType = updates.job.type;
  }

  const [updated] = await db
    .update(scheduledJobs)
    .set(updateData)
    .where(and(eq(scheduledJobs.userId, userId), eq(scheduledJobs.id, jobId)))
    .returning();

  return updated;
}

/**
 * Delete a job
 */
export async function deleteJob(userId: string, jobId: string) {
  await db
    .delete(scheduledJobs)
    .where(and(eq(scheduledJobs.userId, userId), eq(scheduledJobs.id, jobId)));
}

/**
 * Enable/disable a job
 */
export async function toggleJob(
  userId: string,
  jobId: string,
  enabled: boolean,
) {
  const updateData: Partial<InsertScheduledJob> = {
    enabled,
    updatedAt: new Date(),
  };

  if (enabled) {
    // Recompute next run when enabling
    const job = await getJob(userId, jobId);
    if (job) {
      let schedule: ScheduleConfig;

      if (job.scheduleType === "cron") {
        const expression = job.cronExpression;
        if (!expression) {
          throw new Error("Cron expression is required for cron jobs");
        }
        schedule = {
          type: "cron",
          expression,
          timezone: job.timezone,
        };
      } else if (
        job.scheduleType === "interval-hours" ||
        job.scheduleType === "interval-minutes" ||
        job.scheduleType === "interval"
      ) {
        // Legacy "interval" is converted to interval-hours or interval-minutes
        const minutes = job.intervalMinutes;
        if (typeof minutes !== "number") {
          throw new Error("Interval minutes is required for interval jobs");
        }
        const hours = minutes % 60 === 0 ? minutes / 60 : undefined;
        schedule = hours
          ? { type: "interval-hours", hours: Math.floor(hours) }
          : { type: "interval-minutes", minutes };
      } else {
        const scheduledAt = job.scheduledAt;
        if (!scheduledAt) {
          throw new Error("Scheduled at is required for once jobs");
        }
        schedule = { type: "once", at: scheduledAt };
      }

      updateData.nextRunAt = computeNextRun(schedule, new Date());
    }
  } else {
    updateData.nextRunAt = null;
  }

  const [updated] = await db
    .update(scheduledJobs)
    .set(updateData)
    .where(and(eq(scheduledJobs.userId, userId), eq(scheduledJobs.id, jobId)))
    .returning();

  return updated;
}

/**
 * Get jobs due to run for a specific user
 * Read-only observation; recovery is an explicit owner-scoped operation.
 */
export async function getDueJobs(now: Date = new Date(), userId?: string) {
  const conditions = userId
    ? and(eq(scheduledJobs.enabled, true), eq(scheduledJobs.userId, userId))
    : eq(scheduledJobs.enabled, true);

  const jobs = await db
    .select()
    .from(scheduledJobs)
    .where(conditions)
    .orderBy(asc(scheduledJobs.nextRunAt));

  return jobs.filter(
    (job: { nextRunAt: Date | null; lastStatus: string | null }) =>
      job.nextRunAt && job.nextRunAt <= now && !["running","needs_review","unknown","cancel_requested"].includes(job.lastStatus??""),
  );
}

/** Retired writer: only Work commands may create or finish executions. */
export async function startJobExecution(_context: JobExecutionContext): Promise<never> {
  throw new LoopMigrationRequiredError();
}

export async function completeJobExecution(
  _context: JobExecutionContext,
  _result: JobExecutionResult,
): Promise<never> {
  throw new LoopMigrationRequiredError();
}

/**
 * Get execution history for a job
 */
export async function getJobExecutions(
  jobId: string,
  options?: { limit?: number; offset?: number },
) {
  const { limit = 10, offset = 0 } = options ?? {};
  const [executions, [{ count }]] = await Promise.all([
    db
      .select()
      .from(jobExecutions)
      .where(eq(jobExecutions.jobId, jobId))
      .orderBy(desc(jobExecutions.startedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(jobExecutions)
      .where(eq(jobExecutions.jobId, jobId)),
  ]);
  return { executions, total: count };
}

/** Legacy runs have no renewable lease. Age is uncertainty, never proof of
 * failure or permission to rerun. Keep history and quarantine for owner review. */
export async function recoverStuckJobs(userId?:string):Promise<number>{
  if(!userId)return 0;
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(userId))throw new Error("Invalid scheduler owner");
  if(process.env.TAURI_MODE==="true"||process.env.IS_TAURI==="true")throw new Error("Legacy recovery requires PostgreSQL");
  return db.transaction(async tx=>{
    const jobs=await tx.execute(sql`SELECT j.id FROM scheduled_jobs j
      WHERE j.user_id=${userId}::uuid
      AND NOT EXISTS(SELECT 1 FROM loop_runtime_migrations m WHERE m.legacy_job_id=j.id)
      AND EXISTS(SELECT 1 FROM job_executions e WHERE e.job_id=j.id AND e.status='running'
        AND e.started_at<clock_timestamp()-(${DEFAULT_JOB_TIMEOUT_MS}::double precision*interval '1 millisecond'))
      ORDER BY j.id LIMIT 100 FOR UPDATE OF j SKIP LOCKED`);
    let count=0;
    for(const job of jobs){
      const changed=await tx.execute(sql`UPDATE job_executions SET status='needs_review',
        error=concat_ws(E'\\n',NULLIF(error,''),'Legacy execution timed out; outcome unknown. Owner review required.'),
        result=(CASE WHEN jsonb_typeof(result)='object' THEN result ELSE jsonb_build_object('legacyResult',result) END)
          ||jsonb_build_object('recoveryObservation',jsonb_build_object('source','legacy_scheduler','ownerId',${userId}::text,'fromStatus','running','toStatus','needs_review','observedAt',clock_timestamp(),'reason','lease_unavailable'))
        WHERE job_id=${job.id}::uuid AND status='running'
          AND started_at<clock_timestamp()-(${DEFAULT_JOB_TIMEOUT_MS}::double precision*interval '1 millisecond')
        RETURNING id`);
      if(changed.length){
        await tx.execute(sql`UPDATE scheduled_jobs SET last_status='needs_review',last_error='Legacy execution outcome unknown; owner review required',updated_at=clock_timestamp() WHERE id=${job.id}::uuid AND user_id=${userId}::uuid`);
        count+=changed.length;
      }
    }
    return count;
  });
}

/** Compatibility entry: never delete uncertain execution history. */
export async function cleanupStuckJobs(userId?:string):Promise<number>{
  return recoverStuckJobs(userId);
}
