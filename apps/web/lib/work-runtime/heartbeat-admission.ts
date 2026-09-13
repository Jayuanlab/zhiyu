import {sql} from 'drizzle-orm';
import {withWorkshopEventTransaction} from '@/lib/workshops/event-write';
import {normalizeWorkshopHeartbeatPolicy} from '@/lib/workshops/heartbeat';
import {resolveExecutionLease} from './execution-context';
import {workCommandChildId} from './child-id';
import {WorkCommandConflict} from './command-ledger';

/** A wakeup is admitted together with its durable Run and cursor transition.
 * Execution belongs exclusively to the leased Work consumer. */
export async function admitWorkshopHeartbeat(input:{userId:string;workId:string;scheduledAt:string;signal?:AbortSignal}){
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if(resolveExecutionLease()||![input.userId,input.workId].every(id=>uuid.test(id))||!Number.isFinite(Date.parse(input.scheduledAt)))
    throw new WorkCommandConflict('invalid_command');
  const userId=input.userId.toLowerCase(),workId=input.workId.toLowerCase(),scheduledAt=new Date(input.scheduledAt).toISOString();
  const commandId=`heartbeat:${workId}:${scheduledAt}`,runId=workCommandChildId(userId,workId,commandId,'run');
  if(input.signal?.aborted)return {state:'cancelled' as const};
  return withWorkshopEventTransaction(async(db,append)=>{
    const [work]=await db.execute(sql`SELECT * FROM workshops WHERE id=${workId}::uuid AND user_id=${userId}::uuid FOR UPDATE`);
    if(!work)throw new WorkCommandConflict('not_found');
    const [heartbeat]=await db.execute(sql`SELECT *,clock_timestamp() AS now FROM workshop_heartbeats WHERE workshop_id=${workId}::uuid FOR UPDATE`);
    // A stop during a lock wait must not admit another action when the lock returns.
    if(input.signal?.aborted)return {state:'cancelled' as const};
    const [prior]=await db.execute(sql`SELECT id,status,trigger_reason FROM workshop_runs WHERE id=${runId}::uuid AND workshop_id=${workId}::uuid`);
    if(prior){
      if(prior.trigger_reason?.commandId!==commandId||prior.trigger_reason?.type!=='heartbeat')throw new WorkCommandConflict('payload_conflict');
      return {state:'accepted' as const,runId,replayed:true};
    }
    if(!heartbeat||work.status!=='active'||!heartbeat.enabled||heartbeat.scheduler_status==='paused')return {state:'paused' as const};
    const now=new Date(heartbeat.now),next=heartbeat.next_wakeup_at?new Date(heartbeat.next_wakeup_at):null;
    if(!next||next.toISOString()!==scheduledAt||next>now)return {state:'stale' as const};
    // Existing executions, including unknown effects, must settle before another wakeup.
    const [busy]=await db.execute(sql`SELECT 1 FROM workshop_runs WHERE workshop_id=${workId}::uuid AND status IN ('queued','running','cancel_requested','needs_review')
      UNION ALL SELECT 1 FROM workshop_execution_leases WHERE workshop_id=${workId}::uuid AND phase IN ('running','needs_review') LIMIT 1`);
    if(busy||(heartbeat.lease_until&&new Date(heartbeat.lease_until)>now))return {state:'busy' as const};
    const policy=normalizeWorkshopHeartbeatPolicy(heartbeat.heartbeat_policy);
    if(policy.missedRunGraceMinutes>0&&now.getTime()-next.getTime()>policy.missedRunGraceMinutes*60000){
      await db.execute(sql`UPDATE workshop_heartbeats SET next_wakeup_at=NULL,scheduler_status='idle',scheduler_error=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE workshop_id=${workId}::uuid`);
      await append({workshopId:workId,type:'heartbeat_missed',title:'Missed workshop heartbeat skipped',metadata:{actorId:userId,commandId,scheduledAt,policy}});
      return {state:'skipped' as const};
    }
    const trigger={type:'heartbeat',commandId,scheduledAt,source:'system'};
    const snapshot={mission:work.mission,autonomyLevel:work.autonomy_level,acceptedByCommandId:commandId};
    await db.execute(sql`INSERT INTO workshop_runs(id,workshop_id,status,trigger_reason,input_snapshot,started_at)
      VALUES (${runId}::uuid,${workId}::uuid,'queued',${JSON.stringify(trigger)}::jsonb,${JSON.stringify(snapshot)}::jsonb,NULL)`);
    await db.execute(sql`UPDATE workshop_heartbeats SET next_wakeup_at=NULL,last_wakeup_at=${scheduledAt}::timestamptz,
      scheduler_status='queued',scheduler_error=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE workshop_id=${workId}::uuid`);
    await append({workshopId:workId,runId,type:'heartbeat_queued',title:'Workshop heartbeat queued',metadata:{actorId:userId,commandId,scheduledAt}});
    return {state:'accepted' as const,runId,replayed:false};
  });
}
