import {sql} from 'drizzle-orm';
import {withWorkshopEventTransaction} from '@/lib/workshops/event-write';
import {canonicalCommandJson} from './command-payload';
import {ExecutionLeaseError} from './execution-errors';
import type {ExecutionLease} from './execution-lease';
import type {JobExecutionResult} from '@/lib/cron/types';
import {updateLinkedLoopControlState} from './loop-control-state';
import {setLoopScheduleExecutionPhase} from './loop-admission';
import {
  extractWorkRunRuntimeSnapshotSummary,
  readWorkRunRuntimeSnapshotSummary,
} from './runtime-snapshot';

export type RunCompletionInput = {
  userId:string;workshopId:string;runId:string;
  status:'completed'|'failed'|'interrupted'|'cancelled'|'needs_review';
  summary?:string|null;error?:string|null;directiveIds?:string[];
  sourceMemoryIds?:string[];
  metadata?:Record<string,unknown>;lease?:ExecutionLease;
  loopResult?:{loopId:string;result:JobExecutionResult};
};
export type RunCompletionResult = {
  status:RunCompletionInput['status'];summary:string|null;error:string|null;consumedDirectiveIds:string[];
  stateSnapshotId?:string;runtimeSnapshot?:unknown;
};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function stripRuntimeSnapshot(value:unknown):unknown{
  if(Array.isArray(value))return value.map(stripRuntimeSnapshot);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value as Record<string,unknown>).filter(([key])=>key!=='runtimeSnapshot').map(([key,item])=>[key,stripRuntimeSnapshot(item)]));
}
function receiptMatches(existing:unknown,next:unknown){
  return canonicalCommandJson(stripRuntimeSnapshot(existing) as any)===canonicalCommandJson(stripRuntimeSnapshot(next) as any);
}
async function replayCompletionResultWithRuntimeSnapshot(
  db: Parameters<typeof readWorkRunRuntimeSnapshotSummary>[0],
  input: {workId:string;runId:string;receipt:{request?:unknown;result:any;resolution?:unknown}},
): Promise<RunCompletionResult> {
  const result = input.receipt.result as RunCompletionResult;
  if (result?.runtimeSnapshot) return result;
  const runtimeSnapshot =
    extractWorkRunRuntimeSnapshotSummary(input.receipt) ??
    await readWorkRunRuntimeSnapshotSummary(db,{workId:input.workId,runId:input.runId});
  return runtimeSnapshot ? {...result,runtimeSnapshot} : result;
}

/** Final state, consumed inputs, receipt and events are one commit. Historical
 * unfenced callers cannot finalize a run owned by an execution lease. */
export async function finalizeWorkshopRun(input:RunCompletionInput):Promise<RunCompletionResult>{
  const directiveIds=[...new Set((input.directiveIds??[]).map(id=>id.toLowerCase()))].sort();
  const sourceMemoryIds=[...new Set((input.sourceMemoryIds??[]).map(id=>id.toLowerCase()))].sort();
  if(![input.userId,input.workshopId,input.runId,...directiveIds,...sourceMemoryIds].every(id=>uuid.test(id))||!['completed','failed','interrupted','cancelled','needs_review'].includes(input.status))throw new ExecutionLeaseError('invalid_lease');
  input={...input,userId:input.userId.toLowerCase(),workshopId:input.workshopId.toLowerCase(),runId:input.runId.toLowerCase()};
  const request=JSON.parse(JSON.stringify({status:input.status,summary:input.summary??null,error:input.error??null,directiveIds,metadata:input.metadata??{},...(input.sourceMemoryIds===undefined?{}:{sourceMemoryIds}),...(input.loopResult?{loopResult:input.loopResult}:{})}));
  const execution=input.lease?{token:input.lease.token,workerId:input.lease.workerId}:null;
  if(input.lease&&[input.lease.userId!==input.userId,input.lease.workshopId!==input.workshopId,input.lease.runId!==input.runId].some(Boolean))throw new ExecutionLeaseError('invalid_lease');
  return withWorkshopEventTransaction(async(tx,append)=>{
    const work=await tx.execute(sql`SELECT id FROM workshops WHERE id=${input.workshopId}::uuid AND user_id=${input.userId}::uuid FOR UPDATE`);
    if(!work[0])throw new ExecutionLeaseError('not_found');
    const leases=await tx.execute(sql`SELECT *,lease_until<=clock_timestamp() AS expired FROM workshop_execution_leases WHERE workshop_id=${input.workshopId}::uuid FOR UPDATE`);
    const lease=leases[0];
    const runs=await tx.execute(sql`SELECT * FROM workshop_runs WHERE id=${input.runId}::uuid AND workshop_id=${input.workshopId}::uuid FOR UPDATE`);
    const run=runs[0];if(!run)throw new ExecutionLeaseError('not_found');
    const conversationRun=Boolean(run.trigger_reason&&typeof run.trigger_reason==='object'&&!Array.isArray(run.trigger_reason)&&run.trigger_reason.type==='conversation');
    if(conversationRun&&sourceMemoryIds.length)throw new ExecutionLeaseError('invalid_lease');
    if(run.completion_json){
      const receipt=run.completion_json as {request:any;execution:unknown;result:any;resolution?:unknown};
      if(canonicalCommandJson(receipt.execution as any)!==canonicalCommandJson(execution))throw new ExecutionLeaseError('lease_lost');
      if(!receiptMatches(receipt.request,request))throw new ExecutionLeaseError('result_conflict');
      return replayCompletionResultWithRuntimeSnapshot(tx,{workId:input.workshopId,runId:input.runId,receipt});
    }
    if(input.lease){
      if(!lease||lease.run_id!==input.runId||lease.worker_id!==input.lease.workerId||lease.token!==input.lease.token||lease.phase!=='running'||lease.expired)throw new ExecutionLeaseError('lease_lost');
    }else if(lease?.run_id===input.runId&&Number(lease.token)>0){throw new ExecutionLeaseError('lease_lost');}
    if(run.status!=='running')throw new ExecutionLeaseError('result_conflict');
    const linked=await tx.execute(sql`SELECT 1 FROM workshop_loop_executions WHERE run_id=${input.runId}::uuid`);
    if(linked[0]&&!input.loopResult)throw new ExecutionLeaseError('invalid_lease');
    if(sourceMemoryIds.length){
      const memories=await tx.execute(sql`SELECT id FROM brain_memories WHERE id=ANY(${sql.param(sourceMemoryIds)}::uuid[]) AND user_id=${input.userId}::uuid FOR SHARE`);
      if(memories.length!==sourceMemoryIds.length)throw new ExecutionLeaseError('invalid_lease');
    }
    if(directiveIds.length){
      const valid=await tx.execute(sql`SELECT id FROM workshop_directives WHERE id=ANY(${sql.param(directiveIds)}::uuid[]) AND workshop_id=${input.workshopId}::uuid AND scope='current_run' AND status='active' AND (run_id IS NULL OR run_id=${input.runId}::uuid) FOR UPDATE`);
      if(valid.length!==directiveIds.length)throw new ExecutionLeaseError('invalid_lease');
    }
    const runtimeSnapshot=await readWorkRunRuntimeSnapshotSummary(tx,{workId:input.workshopId,runId:input.runId});
    const status=input.lease&&lease?.effect_started&&input.status!=='completed'?'needs_review':input.status;
    if(input.loopResult){
      if(!input.lease||!uuid.test(input.loopResult.loopId))throw new ExecutionLeaseError('invalid_lease');
      const links=await tx.execute(sql`SELECT result_json FROM workshop_loop_executions WHERE run_id=${input.runId}::uuid AND workshop_id=${input.workshopId}::uuid AND loop_id=${input.loopResult.loopId}::uuid AND active FOR UPDATE`);
      // Compare the same JSON representation that was captured. Executor
      // results can have optional undefined fields, which JSON omits.
      if(!links[0]||canonicalCommandJson(links[0].result_json as any)!==canonicalCommandJson(request.loopResult.result))throw new ExecutionLeaseError('result_conflict');
      await tx.execute(sql`UPDATE workshop_loop_executions SET active=${status==='needs_review'} WHERE run_id=${input.runId}::uuid`);
      await setLoopScheduleExecutionPhase({db:tx,append},input.runId,status==='needs_review'?'needs_review':'idle');
      if(status==='needs_review')await updateLinkedLoopControlState({db:tx,append},{workshopId:input.workshopId,runId:input.runId,userId:input.userId,status,reason:input.error??'execution_result_requires_review',wasRunning:true,execution});
    }
    const consumedDirectiveIds=status==='completed'?directiveIds:[];
    if(consumedDirectiveIds.length){
      await tx.execute(sql`UPDATE workshop_directives SET status='consumed',run_id=${input.runId}::uuid WHERE id=ANY(${sql.param(consumedDirectiveIds)}::uuid[]) AND workshop_id=${input.workshopId}::uuid`);
    }
    const requestWithSnapshot={...request,metadata:{...request.metadata,runtimeSnapshot}};
    const result:RunCompletionResult={status,summary:request.summary,error:request.error,consumedDirectiveIds};
    if(runtimeSnapshot)result.runtimeSnapshot=runtimeSnapshot;
    if(!conversationRun){
      const snapshotContent={workshopId:input.workshopId,runId:input.runId,status,outputSummary:result.summary,error:result.error,toolCallCount:request.metadata.toolCallCount??null,durationMs:request.metadata.durationMs??null,writtenMemoryIds:sourceMemoryIds};
      const snapshotMetadata={triggerReason:run.trigger_reason??{},source:'run_completion',actorId:input.userId,execution,runtimeSnapshot};
      const snapshots=await tx.execute(sql`INSERT INTO brain_state_snapshots(user_id,scope_type,scope_id,snapshot_type,content,source_memory_ids,metadata) VALUES (${input.userId}::uuid,'workshop',${input.workshopId},'work_state',${JSON.stringify(snapshotContent)}::jsonb,${JSON.stringify(sourceMemoryIds)}::jsonb,${JSON.stringify(snapshotMetadata)}::jsonb) RETURNING id`);
      result.stateSnapshotId=snapshots[0].id;
    }
    await tx.execute(sql`UPDATE workshop_runs SET status=${status},output_summary=${result.summary},error=${result.error},completed_at=CASE WHEN ${status}='needs_review' THEN NULL ELSE clock_timestamp() END,completion_json=${JSON.stringify({request:requestWithSnapshot,execution,result})}::jsonb,updated_at=clock_timestamp() WHERE id=${input.runId}::uuid`);
    await append({workshopId:input.workshopId,runId:input.runId,type:`run_${status}`,title:status==='completed'?'本轮车间工作完成':status==='needs_review'?'本轮执行结果待核对':'本轮车间工作未完成',body:result.summary??result.error,
      metadata:{...request.metadata,actorId:input.userId,execution,consumedDirectiveIds,stateSnapshotId:result.stateSnapshotId,runtimeSnapshot}});
    if(input.lease){
      await tx.execute(sql`UPDATE workshop_execution_leases SET phase=${status==='needs_review'?'needs_review':'idle'},result_json=${JSON.stringify({requested:requestWithSnapshot,result})}::jsonb,updated_at=clock_timestamp() WHERE workshop_id=${input.workshopId}::uuid`);
      await append({workshopId:input.workshopId,runId:input.runId,type:`execution_${status}`,title:`执行状态：${status}`,metadata:{actorId:input.userId,workerId:input.lease.workerId,fencingToken:input.lease.token,result,runtimeSnapshot}});
      const time=await tx.execute(sql`SELECT clock_timestamp()<${lease.lease_until}::timestamptz AS valid`);
      if(!time[0]?.valid)throw new ExecutionLeaseError('lease_lost');
    }
    return result;
  });
}
