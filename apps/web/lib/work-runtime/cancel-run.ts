import {writeAuthorizedWorkRunStateSnapshotInTransaction} from "@/lib/memory/continuity/work-run-state";
import {sql} from 'drizzle-orm';
import {runDatabaseWorkCommand} from './database-command';
import {WorkCommandConflict} from './command-ledger';
import {resolveExecutionLease} from './execution-context';
import type {WorkCommandMeta} from './types';
import {updateLinkedLoopControlState} from './loop-control-state';
import {readWorkRunRuntimeSnapshotSummary} from './runtime-snapshot';
import {reconcileChatWorkItemInTransaction} from './chat-work-items';

type CancelRunCommand=WorkCommandMeta&{userId:string;workId:string;runId:string;pauseFuture?:boolean};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Owner cancellation revokes durable execution authority immediately. It
 * cannot undo external effects; those runs remain fenced in needs_review. */
export async function cancelWorkRun(input:CancelRunCommand){
  if(resolveExecutionLease() || (input.source!==undefined&&input.source!=='owner'))throw new WorkCommandConflict('invalid_command');
  if(![input.userId,input.workId,input.runId].every(id=>typeof id==='string'&&uuid.test(id)))throw new WorkCommandConflict('invalid_command');
  const command={...input,userId:input.userId.toLowerCase(),workId:input.workId.toLowerCase(),runId:input.runId.toLowerCase(),source:'owner' as const};
  return runDatabaseWorkCommand(command,'cancel_work_run',async(persisted,{db,append})=>{
    // The command ledger already holds the Work lock. Persist the admission
    // barrier before releasing the running lease, in this same transaction.
    if(persisted.pauseFuture===true){
      const paused=await db.execute(sql`UPDATE workshops SET status='paused',updated_at=clock_timestamp() WHERE id=${persisted.workId}::uuid AND user_id=${persisted.userId}::uuid AND status<>'archived' RETURNING id`);
      if(!paused[0])throw new WorkCommandConflict('target_busy');
      await append({workshopId:persisted.workId,type:'work_admission_paused',title:'后续运行已暂停',metadata:{commandId:persisted.commandId,source:'owner',beforeCancelRunId:persisted.runId,queuedPolicy:'kept_paused'}});
    }
    const leases=await db.execute(sql`SELECT * FROM workshop_execution_leases WHERE workshop_id=${persisted.workId}::uuid FOR UPDATE`);
    const runs=await db.execute(sql`SELECT * FROM workshop_runs WHERE id=${persisted.runId}::uuid AND workshop_id=${persisted.workId}::uuid FOR UPDATE`);
    const run=runs[0];if(!run)throw new WorkCommandConflict('not_found');
    if(!['queued','running'].includes(run.status))return {runId:persisted.runId,status:String(run.status),changed:false,futurePaused:persisted.pauseFuture===true,executorExitVerified:false,effectsUndone:false};
    const lease=leases[0]?.run_id===persisted.runId?leases[0]:undefined;
    if(run.status==='running'&&(!lease||lease.phase!=='running'))throw new WorkCommandConflict('target_busy');
    const status=lease?.effect_started?'needs_review':'cancelled';
    const reason=status==='needs_review'?'owner_cancel_after_effect':'owner_cancelled';
    const execution=lease?{workerId:lease.worker_id,token:lease.token}:null;
    const runtimeSnapshot=await readWorkRunRuntimeSnapshotSummary(db,{workId:persisted.workId,runId:persisted.runId});
    const stateSnapshot=await writeAuthorizedWorkRunStateSnapshotInTransaction(db,{userId:persisted.userId,workshopId:persisted.workId,runId:persisted.runId,content:{workshopId:persisted.workId,runId:persisted.runId,status,error:reason,writtenMemoryIds:[]},metadata:{source:'owner_cancel',actorId:persisted.userId,commandId:persisted.commandId,execution,runtimeSnapshot}});
    const result={status,summary:null,error:reason,consumedDirectiveIds:[],stateSnapshotId:stateSnapshot.id};
    const receipt={request:{source:'owner_cancel',commandId:persisted.commandId},execution,result};
    await db.execute(sql`UPDATE workshop_runs SET status=${status},error=${reason},completed_at=CASE WHEN ${status}='cancelled' THEN clock_timestamp() ELSE NULL END,completion_json=${JSON.stringify(receipt)}::jsonb,updated_at=clock_timestamp() WHERE id=${persisted.runId}::uuid`);
    await reconcileChatWorkItemInTransaction(db,{runId:persisted.runId,status,error:reason});
    await updateLinkedLoopControlState({db,append},{workshopId:persisted.workId,runId:persisted.runId,userId:persisted.userId,status,reason,wasRunning:run.status==='running',commandId:persisted.commandId,execution});
    if(lease)await db.execute(sql`UPDATE workshop_execution_leases SET phase=${status==='needs_review'?'needs_review':'idle'},lease_until=clock_timestamp(),result_json=${JSON.stringify(receipt)}::jsonb,updated_at=clock_timestamp() WHERE workshop_id=${persisted.workId}::uuid`);
    await append({workshopId:persisted.workId,runId:persisted.runId,type:`run_${status}`,title:status==='needs_review'?'停止后执行结果待核对':'本轮运行已取消',body:persisted.reason??null,metadata:{actorId:persisted.userId,source:'owner',commandId:persisted.commandId,reasonCode:reason,execution,stateSnapshotId:result.stateSnapshotId,runtimeSnapshot}});
    return {runId:persisted.runId,status,changed:true,futurePaused:persisted.pauseFuture===true,executorExitVerified:false,effectsUndone:false};
  });
}

/** Owner requested both current and future work to stop; backlog remains paused. */
export function pauseAndCancelWorkRun(input:Omit<CancelRunCommand,'pauseFuture'>){
  return cancelWorkRun({...input,pauseFuture:true});
}
