import {sql} from 'drizzle-orm';
import type {DrizzleDB} from '@/lib/db/types';
import type {Loop} from '@/lib/db/schema';
import {commandPayloadHash} from './command-payload';
import {inspectLegacyExecutions} from './legacy-execution-review';

/** No credentials cross the preview interface. Hash the complete source so a
 * model/credential/configuration change still invalidates an owner's preview. */
export async function inspectLegacyLoopSource(loop:Loop,store:DrizzleDB){
  if(loop.triggerConfig.type!=='scheduled_job')return null;
  const id=loop.triggerConfig.scheduledJobId;
  if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))return {blockers:['legacy_source_missing'],job:null};
  const rows=await store.execute(sql`SELECT to_jsonb(j) AS source FROM scheduled_jobs j WHERE id=${id}::uuid AND user_id=${loop.userId}::uuid FOR UPDATE`);
  if(!rows[0])return {blockers:['legacy_source_missing'],job:null};
  const raw=rows[0].source as Record<string,any>,config=raw.job_config;
  const executions=await inspectLegacyExecutions(id,store);
  const siblings=await store.execute(sql`SELECT 1 FROM loops WHERE id<>${loop.id}::uuid AND user_id=${loop.userId}::uuid AND trigger_config->>'type'='scheduled_job' AND trigger_config->>'scheduledJobId'=${id} LIMIT 1`);
  return {blockers:[...(executions.some(row=>!row.reviewed)?['legacy_execution_unfinished']:[]),...(siblings[0]?['legacy_source_ambiguous']:[])],job:{
    executions,
    id,name:raw.name,description:raw.description,jobType:raw.job_type,enabled:raw.enabled,
    scheduleType:raw.schedule_type,cronExpression:raw.cron_expression,intervalMinutes:raw.interval_minutes,scheduledAt:raw.scheduled_at,timezone:raw.timezone,
    lastRunAt:raw.last_run_at,nextRunAt:raw.next_run_at,lastStatus:raw.last_status,runCount:raw.run_count,failureCount:raw.failure_count,createdAt:raw.created_at,updatedAt:raw.updated_at,
    hasCustomHandler:Boolean(config?.handler),hasCharacterContext:Boolean(config?.characterId),hasModelOverrides:Boolean(config?.modelConfig),
    snapshotHash:commandPayloadHash(raw),
  }};
}
