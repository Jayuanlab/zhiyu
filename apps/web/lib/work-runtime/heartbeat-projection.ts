import {sql} from 'drizzle-orm';
import {withWorkshopEventTransaction} from '@/lib/workshops/event-write';
import {normalizeWorkshopHeartbeatPolicy} from '@/lib/workshops/heartbeat';
import {workCommandChildId} from './child-id';
import {WorkCommandConflict} from './command-ledger';

/** Project the latest wakeup's Run. A per-Run event under the Work lock makes
 * terminal failure accounting replay-safe across scans and process restarts. */
export async function projectWorkshopHeartbeat(input:{userId:string;workId:string;signal?:AbortSignal}){
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if(![input.userId,input.workId].every(id=>uuid.test(id)))throw new WorkCommandConflict('invalid_command');
  const userId=input.userId.toLowerCase(),workId=input.workId.toLowerCase();
  if(input.signal?.aborted)return;
  return withWorkshopEventTransaction(async(db,append)=>{
    const [work]=await db.execute(sql`SELECT id FROM workshops WHERE id=${workId}::uuid AND user_id=${userId}::uuid FOR UPDATE`);
    if(!work)throw new WorkCommandConflict('not_found');
    const [heartbeat]=await db.execute(sql`SELECT * FROM workshop_heartbeats WHERE workshop_id=${workId}::uuid FOR UPDATE`);
    if(input.signal?.aborted||!heartbeat?.last_wakeup_at)return;
    const scheduledAt=new Date(heartbeat.last_wakeup_at).toISOString(),commandId=`heartbeat:${workId}:${scheduledAt}`;
    const runId=workCommandChildId(userId,workId,commandId,'run');
    const [run]=await db.execute(sql`SELECT status,error,trigger_reason,updated_at FROM workshop_runs WHERE id=${runId}::uuid AND workshop_id=${workId}::uuid`);
    if(!run||run.trigger_reason?.commandId!==commandId||run.trigger_reason?.type!=='heartbeat')return;
    const terminal=['completed','failed','cancelled','interrupted'].includes(run.status);
    if(terminal){
      const [receipt]=await db.execute(sql`SELECT id FROM workshop_events WHERE workshop_id=${workId}::uuid AND run_id=${runId}::uuid AND type='heartbeat_result_applied' LIMIT 1`);
      if(receipt)return {runId,status:run.status,replayed:true};
    }
    const failed=run.status==='failed'||run.status==='interrupted';
    const failures=failed?Number(heartbeat.consecutive_failures)+1:run.status==='completed'?0:Number(heartbeat.consecutive_failures);
    const disable=failed&&failures>=normalizeWorkshopHeartbeatPolicy(heartbeat.heartbeat_policy).maxConsecutiveFailures;
    const phase=heartbeat.scheduler_status==='paused'?'paused':run.status==='queued'?'queued':run.status==='running'?'running':run.status==='cancel_requested'?'stopping':
      run.status==='needs_review'?'needs_review':failed?'error':'idle';
    const error=failed||run.status==='needs_review'?String(run.error??'heartbeat_result_requires_review'):null;
    const observedAt=new Date(run.updated_at).toISOString();
    // Do not resume a pause, enable a disabled controller or remove a new wakeup.
    await db.execute(sql`UPDATE workshop_heartbeats SET scheduler_status=${phase},scheduler_error=${error},consecutive_failures=${failures},
      enabled=CASE WHEN ${disable} THEN false ELSE enabled END,last_heartbeat_at=${observedAt}::timestamptz,updated_at=clock_timestamp()
      WHERE workshop_id=${workId}::uuid AND (scheduler_status IS DISTINCT FROM ${phase} OR scheduler_error IS DISTINCT FROM ${error} OR consecutive_failures<>${failures} OR last_heartbeat_at IS DISTINCT FROM ${observedAt}::timestamptz)`);
    if(terminal)await append({workshopId:workId,runId,type:'heartbeat_result_applied',title:'Workshop heartbeat result synchronized',metadata:{actorId:userId,commandId,status:run.status,consecutiveFailures:failures,disabledByFailurePolicy:disable}});
    return {runId,status:run.status,replayed:false};
  });
}
