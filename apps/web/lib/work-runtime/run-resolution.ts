import {sql} from 'drizzle-orm';
import {db as database} from '@/lib/db/client';
import {updateWorkshop} from '@/lib/workshops/service';
import {runDatabaseWorkCommand} from './database-command';
import {WorkCommandConflict} from './command-ledger';
import {resolveExecutionLease} from './execution-context';
import {updateLinkedLoopControlState} from './loop-control-state';
import {
  parseWorkRunReviewRuntimeSnapshot,
  summarizeWorkRunReviewRuntimeSnapshot,
  readWorkRunRuntimeSnapshotSummary,
  extractWorkRunRuntimeSnapshotSummary,
  compareWorkRunRuntimeSnapshotSummaries,
  type WorkRunRuntimeSnapshotRef,
} from './runtime-snapshot';
import type {WorkCommandMeta} from './types';
export {
  parseWorkRunReviewRuntimeSnapshot,
  summarizeWorkRunReviewRuntimeSnapshot,
} from './runtime-snapshot';

type Target={userId:string;workId:string;runId:string};
export type WorkRunReviewRuntimeSnapshot=WorkRunRuntimeSnapshotRef;
export type RunResolutionCommand=Target&WorkCommandMeta&{
  expectedLeaseToken:number;
  outcome:'unknown'|'no_effect'|'effects_recorded';
  evidence:string;
  executorStopped?:boolean;
};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function target(input:Target){
  if(![input.userId,input.workId,input.runId].every(id=>typeof id==='string'&&uuid.test(id)))throw new WorkCommandConflict('invalid_command');
  return {...input,userId:input.userId.toLowerCase(),workId:input.workId.toLowerCase(),runId:input.runId.toLowerCase()};
}

export async function listWorkRunReviews(input:{userId:string;workId:string;cursor?:string}){
  if(![input.userId,input.workId,...(input.cursor?[input.cursor]:[])].every(id=>uuid.test(id)))throw new WorkCommandConflict('invalid_command');
  const rows=await database.execute(sql`SELECT w.id,(SELECT jsonb_agg(item) FROM
    (SELECT r.id,r.error,r.created_at FROM workshop_runs r WHERE r.workshop_id=w.id AND r.status='needs_review'
      ${input.cursor?sql`AND r.id>${input.cursor}::uuid`:sql``} ORDER BY r.id LIMIT 21) item) AS runs
    FROM workshops w WHERE w.id=${input.workId}::uuid AND w.user_id=${input.userId}::uuid`);
  if(!rows[0])throw new WorkCommandConflict('not_found');
  const runs=(rows[0].runs??[]) as Array<{id:string;error:string|null;created_at:string}>;
  return {runs:runs.slice(0,20),nextCursor:runs.length>20?runs[19].id:null};
}

/** Observation only. The revision and lease token belong to this snapshot;
 * neither a read nor an unresolved review can release execution authority. */
export async function getWorkRunReview(input:Target){
  input=target(input);
  const rows=await database.execute(sql`SELECT r.id,r.status,r.error,r.completion_json,
    l.token AS lease_token,l.phase AS lease_phase,w.status AS work_status,coalesce(v.version,0) AS command_version,
    (SELECT jsonb_build_object('evidence',e.body,'createdAt',e.created_at,'metadata',e.metadata) FROM workshop_events e WHERE e.workshop_id=w.id AND e.run_id=r.id AND e.type IN ('run_review_observed','run_review_closed') ORDER BY e.seq DESC LIMIT 1) AS last_review,
    (SELECT jsonb_build_object('eventId',e.id,'createdAt',e.created_at,'runId',e.run_id,'loopId',e.loop_id,'loopRunId',e.loop_run_id,'snapshot',e.metadata->'runtimeRunSnapshot') FROM workshop_events e WHERE e.workshop_id=w.id AND e.run_id=r.id AND e.type='agent_configured' ORDER BY e.seq DESC LIMIT 1) AS runtime_snapshot,
    (SELECT jsonb_agg(item) FROM (SELECT o.id,o.status FROM workshop_outbox o WHERE o.workshop_id=w.id AND
      (o.status IN ('sending','unknown') OR EXISTS(SELECT 1 FROM workshop_outbox_attempts a WHERE a.outbox_id=o.id AND a.status IN ('sending','unknown'))) ORDER BY o.created_at,o.id LIMIT 21) item) AS pending_outbox
    FROM workshop_runs r JOIN workshops w ON w.id=r.workshop_id
    LEFT JOIN workshop_execution_leases l ON l.workshop_id=w.id AND l.run_id=r.id
    LEFT JOIN work_command_targets v ON v.workshop_id=w.id
    WHERE r.id=${input.runId}::uuid AND w.id=${input.workId}::uuid AND w.user_id=${input.userId}::uuid`);
  if(!rows[0])throw new WorkCommandConflict('not_found');
  const row=rows[0],pending=(row.pending_outbox??[]) as Array<{id:string;status:string}>;
  const lastReview=row.last_review??null;
  const runtimeSnapshot=parseWorkRunReviewRuntimeSnapshot(row.runtime_snapshot);
  const runtimeSnapshotSummary=summarizeWorkRunReviewRuntimeSnapshot(runtimeSnapshot);
  const receiptRuntimeSnapshot=
    extractWorkRunRuntimeSnapshotSummary(row.completion_json) ??
    extractWorkRunRuntimeSnapshotSummary(lastReview);
  return {runId:input.runId,status:String(row.status),error:row.error??null,workStatus:String(row.work_status),
    expectedVersion:Number(row.command_version),expectedLeaseToken:row.lease_token==null?null:Number(row.lease_token),
    reviewable:row.status==='needs_review'&&row.lease_phase==='needs_review',
    pendingOutbox:pending.slice(0,20),hasMorePendingOutbox:pending.length>20,lastReview,
    runtimeSnapshot,
    receiptRuntimeSnapshot,
    runtimeSnapshotComparison:compareWorkRunRuntimeSnapshotSummaries(runtimeSnapshotSummary,receiptRuntimeSnapshot),
    resolution:(row.completion_json as Record<string,unknown>|null)?.resolution??null};
}

/** Close an uncertain run, never resume it or assert successful execution.
 * The owner verifies external effects and executor shutdown. Known unresolved
 * outbox attempts must first use their own domain recovery. Closure pauses the
 * Work atomically, so releasing this lease does not silently run its backlog. */
export async function resolveWorkRun(input:RunResolutionCommand){
  if(resolveExecutionLease()||(input.source!==undefined&&input.source!=='owner'))throw new WorkCommandConflict('invalid_command');
  if(!['unknown','no_effect','effects_recorded'].includes(input.outcome)||typeof input.evidence!=='string'||input.evidence.trim().length<10||input.evidence.length>8000||!Number.isSafeInteger(input.expectedLeaseToken)||input.expectedLeaseToken<1||input.expectedLeaseToken>=2147483647||(input.outcome!=='unknown'&&input.executorStopped!==true))throw new WorkCommandConflict('invalid_command');
  const command={...input,...target(input),evidence:input.evidence.trim(),source:'owner' as const};
  return runDatabaseWorkCommand(command,'resolve_work_run',async(persisted,context)=>{
    const {db,append}=context;
    const leases=await db.execute(sql`SELECT * FROM workshop_execution_leases WHERE workshop_id=${persisted.workId}::uuid FOR UPDATE`);
    const runs=await db.execute(sql`SELECT * FROM workshop_runs WHERE id=${persisted.runId}::uuid AND workshop_id=${persisted.workId}::uuid FOR UPDATE`);
    const run=runs[0],lease=leases[0];
    if(!run)throw new WorkCommandConflict('not_found');
    if(run.status!=='needs_review'||lease?.run_id!==persisted.runId||lease.phase!=='needs_review')throw new WorkCommandConflict('target_busy');
    if(lease.token!==persisted.expectedLeaseToken)throw new WorkCommandConflict('version_conflict');
    const runtimeSnapshot=await readWorkRunRuntimeSnapshotSummary(db,{workId:persisted.workId,runId:persisted.runId});
    const observation={actorId:persisted.userId,commandId:persisted.commandId,outcome:persisted.outcome,evidence:persisted.evidence,executorStopped:persisted.executorStopped===true,previousExecution:{workerId:lease.worker_id,token:lease.token},priorError:run.error??null,runtimeSnapshot};
    if(persisted.outcome==='unknown'){
      await append({workshopId:persisted.workId,runId:persisted.runId,type:'run_review_observed',title:'运行结果继续保留待核对',body:persisted.evidence,metadata:observation});
      return {runId:persisted.runId,status:'needs_review' as const,closed:false};
    }
    const unresolved=await db.execute(sql`SELECT 1 FROM workshop_outbox o WHERE o.workshop_id=${persisted.workId}::uuid AND
      (o.status IN ('sending','unknown') OR EXISTS(SELECT 1 FROM workshop_outbox_attempts a WHERE a.outbox_id=o.id AND a.status IN ('sending','unknown'))) LIMIT 1`);
    if(unresolved[0])throw new WorkCommandConflict('unresolved_effect');
    if(persisted.outcome==='no_effect'){
      const sent=await db.execute(sql`SELECT 1 FROM workshop_outbox o WHERE o.run_id=${persisted.runId}::uuid AND
        (o.status='sent' OR EXISTS(SELECT 1 FROM workshop_outbox_attempts a WHERE a.outbox_id=o.id AND a.status='sent')) LIMIT 1`);
      if(sent[0])throw new WorkCommandConflict('payload_conflict');
    }
    const reason='owner_closed_after_review',resolution={...observation,priorCompletion:run.completion_json??null};
    const snapshots=await db.execute(sql`INSERT INTO brain_state_snapshots(user_id,scope_type,scope_id,snapshot_type,content,source_memory_ids,metadata) VALUES (${persisted.userId}::uuid,'workshop',${persisted.workId},'work_state',${JSON.stringify({workshopId:persisted.workId,runId:persisted.runId,status:'cancelled',error:reason,writtenMemoryIds:[]})}::jsonb,'[]'::jsonb,${JSON.stringify(observation)}::jsonb) RETURNING id`);
    const result={status:'cancelled',summary:null,error:reason,consumedDirectiveIds:[],stateSnapshotId:snapshots[0].id};
    const receipt={request:{source:'owner_resolution',commandId:persisted.commandId},execution:{token:lease.token+1,workerId:null},result,resolution};
    await db.execute(sql`UPDATE workshop_runs SET status='cancelled',error=${reason},completed_at=clock_timestamp(),completion_json=${JSON.stringify(receipt)}::jsonb,updated_at=clock_timestamp() WHERE id=${persisted.runId}::uuid`);
    await updateLinkedLoopControlState(context,{workshopId:persisted.workId,runId:persisted.runId,userId:persisted.userId,status:'cancelled',reason,wasRunning:true,execution:{resolutionCommandId:persisted.commandId,previousToken:lease.token}});
    await db.execute(sql`UPDATE workshop_execution_leases SET token=token+1,phase='idle',worker_id=NULL,lease_until=clock_timestamp(),result_json=${JSON.stringify(receipt)}::jsonb,updated_at=clock_timestamp() WHERE workshop_id=${persisted.workId}::uuid`);
    await updateWorkshop(persisted.userId,persisted.workId,{status:'paused',changeSource:'owner'},context);
    await append({workshopId:persisted.workId,runId:persisted.runId,type:'run_review_closed',title:'本轮已核实关闭，车间已暂停',body:persisted.evidence,metadata:{...observation,status:'cancelled',workStatus:'paused',stateSnapshotId:result.stateSnapshotId}});
    return {runId:persisted.runId,status:'cancelled' as const,closed:true,workStatus:'paused' as const};
  });
}
