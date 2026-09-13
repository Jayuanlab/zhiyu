import {sql} from 'drizzle-orm';
import {db} from '@/lib/db/client';
import type {DrizzleDB} from '@/lib/db/types';
import {commandPayloadHash} from './command-payload';
import {WorkCommandConflict} from './command-ledger';
import {resolveExecutionLease} from './execution-context';

export async function inspectLegacyExecutions(jobId:string,store:DrizzleDB){
  const rows=(await store.execute(sql`SELECT to_jsonb(e) AS source
    FROM job_executions e
    WHERE e.job_id=${jobId}::uuid AND e.status IN ('queued','pending','running','cancel_requested','needs_review','unknown')
    ORDER BY e.started_at,e.id FOR UPDATE OF e`)) as Array<{source:Record<string,any>}>;
  const reviews=(await store.execute(sql`SELECT execution_id,snapshot_hash,outcome,evidence,reviewed_at FROM legacy_execution_reviews WHERE execution_id IN (SELECT id FROM job_executions WHERE job_id=${jobId}::uuid)`)) as Array<{execution_id:string;snapshot_hash:string;outcome:string;evidence:string;reviewed_at:Date|string}>;
  return rows.map(row=>{
    const source=row.source as Record<string,any>,snapshotHash=commandPayloadHash(source);
    const review=reviews.find(review=>review.execution_id===source.id&&review.snapshot_hash===snapshotHash);
    return {id:source.id,status:source.status,startedAt:source.started_at,completedAt:source.completed_at,
      output:source.output??null,error:source.error??null,snapshotHash,reviewed:!!review,
      review:review?{outcome:review.outcome,evidence:review.evidence,reviewedAt:review.reviewed_at}:null};
  });
}

type ReviewInput={userId:string;loopId:string;executionId:string;commandId:string;expectedSnapshotHash:string;
  controllersStopped:boolean;outcome:'no_effect'|'effects_verified';evidence:string;source?:'owner'};

/** A separate owner attestation closes uncertainty for migration only. It never
 * rewrites the observed execution result or authorizes an automatic retry. */
export async function reviewLegacyExecution(input:ReviewInput){
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if(process.env.TAURI_MODE==='true'||process.env.IS_TAURI==='true'||resolveExecutionLease()||
    (input.source!==undefined&&input.source!=='owner')||! [input.userId,input.loopId,input.executionId].every(value=>typeof value==='string'&&uuid.test(value))||
    typeof input.commandId!=='string'||!input.commandId.trim()||input.commandId.length>256||input.controllersStopped!==true||
    !['no_effect','effects_verified'].includes(input.outcome)||typeof input.evidence!=='string'||!input.evidence.trim()||input.evidence.length>8000||
    typeof input.expectedSnapshotHash!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedSnapshotHash))throw new WorkCommandConflict('invalid_command');
  const command={...input,userId:input.userId.toLowerCase(),loopId:input.loopId.toLowerCase(),executionId:input.executionId.toLowerCase(),evidence:input.evidence.trim(),source:'owner'};
  const payloadHash=commandPayloadHash(command);
  return db.transaction(async tx=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([command.userId,command.commandId])},0))`);
    const loops=await tx.execute(sql`SELECT id,workshop_id,trigger_config FROM loops WHERE id=${command.loopId}::uuid AND user_id=${command.userId}::uuid FOR UPDATE`);
    if(!loops[0])throw new WorkCommandConflict('not_found');
    const previous=await tx.execute(sql`SELECT * FROM legacy_execution_reviews WHERE owner_id=${command.userId}::uuid AND command_id=${command.commandId}`);
    if(previous[0]){
      if(previous[0].payload_hash!==payloadHash)throw new WorkCommandConflict('payload_conflict');
      return {executionId:previous[0].execution_id,reviewedAt:previous[0].reviewed_at,outcome:previous[0].outcome};
    }
    const trigger=loops[0].trigger_config as Record<string,unknown>;
    if(loops[0].workshop_id||trigger.type!=='scheduled_job'||typeof trigger.scheduledJobId!=='string'||!uuid.test(trigger.scheduledJobId))throw new WorkCommandConflict('invalid_command');
    const jobs=await tx.execute(sql`SELECT id FROM scheduled_jobs WHERE id=${trigger.scheduledJobId}::uuid AND user_id=${command.userId}::uuid FOR UPDATE`);
    if(!jobs[0])throw new WorkCommandConflict('not_found');
    const executions=await inspectLegacyExecutions(jobs[0].id as string,tx as DrizzleDB),execution=executions.find(row=>row.id===command.executionId);
    if(!execution)throw new WorkCommandConflict('not_found');
    if(!['needs_review','unknown'].includes(execution.status))throw new WorkCommandConflict('target_busy');
    if(execution.snapshotHash!==command.expectedSnapshotHash)throw new WorkCommandConflict('version_conflict');
    const existing=await tx.execute(sql`SELECT 1 FROM legacy_execution_reviews WHERE execution_id=${command.executionId}::uuid AND snapshot_hash=${execution.snapshotHash}`);
    if(existing[0])throw new WorkCommandConflict('version_conflict');
    const rows=await tx.execute(sql`INSERT INTO legacy_execution_reviews(execution_id,loop_id,owner_id,command_id,payload_hash,snapshot_hash,outcome,evidence,controllers_stopped,source)
      VALUES (${command.executionId}::uuid,${command.loopId}::uuid,${command.userId}::uuid,${command.commandId},${payloadHash},${execution.snapshotHash},${command.outcome},${command.evidence},true,'owner')
      RETURNING execution_id,reviewed_at,outcome`);
    await tx.execute(sql`UPDATE scheduled_jobs SET enabled=false,updated_at=clock_timestamp() WHERE id=${jobs[0].id}::uuid`);
    await tx.execute(sql`UPDATE loops SET status='paused',updated_at=clock_timestamp() WHERE id=${command.loopId}::uuid AND workshop_id IS NULL AND status='active'`);
    return {executionId:rows[0].execution_id,reviewedAt:rows[0].reviewed_at,outcome:rows[0].outcome};
  });
}
