import {sql} from 'drizzle-orm';
import {db} from '@/lib/db/client';
import type {JobExecutionResult} from '@/lib/cron/types';
import type {WorkshopWriteContext} from '@/lib/workshops/service';
import {acceptWorkLoopExecution,type AcceptWorkLoopCommand} from './loop-command';
import {WorkCommandConflict} from './command-ledger';
import {claimWorkshopExecution,finishWorkshopExecution,withExecutionWrite} from './execution-lease';
import {ExecutionLeaseError} from './execution-errors';
import {resolveExecutionLease,withExecutionContext} from './execution-context';
import {withExecutionWriteContext} from './execution-write-context';
import {startExecutionHeartbeat} from './execution-heartbeat';
import {applyRecordedStep} from './recorded-step';
import {decodeCommandResult} from './database-command';
import {canonicalCommandJson} from './command-payload';
import {setLoopScheduleExecutionPhase} from './loop-admission';
import type {WorkRunRuntimeSnapshotAuditSummary} from './runtime-snapshot';
import {MemoryDependencyError,assertMemoryDependenciesCurrentInTransaction} from '@/lib/memory/revision/dependencies';
import { MemoryWriteBusy as BrainMemoryWriteBusy } from "@/lib/memory/kernel/reference-errors";
export type LoopExecutionControl={workerId?:string;leaseMs?:number;signal?:AbortSignal;acceptedRunId?:string};

export async function readLoopExecutionStep<T>(loopId:string,kind:string){
  const lease=resolveExecutionLease();
  if(!lease)throw new ExecutionLeaseError('invalid_lease');
  return withLinkedLoopWrite(loopId,async({db})=>{
    const rows=await db.execute(sql`SELECT result_json FROM workshop_output_steps WHERE run_id=${lease.runId}::uuid AND step_kind=${`loop:${kind}`} AND step_index=0`);
    return rows[0]?{found:true as const,value:decodeCommandResult<T>(rows[0].result_json)}:{found:false as const};
  });
}

export async function applyLoopExecutionStep<T>(loopId:string,kind:string,apply:(context:WorkshopWriteContext)=>Promise<T>){
  const lease=resolveExecutionLease();
  if(!lease)throw new ExecutionLeaseError('invalid_lease');
  return withLinkedLoopWrite(loopId,context=>applyRecordedStep(context,lease,`loop:${kind}`,0,apply));
}

export class LoopExecutionBusy extends Error {
  readonly code='busy';
  readonly status=409;
  constructor(readonly executionState='busy',readonly runtimeSnapshot?:WorkRunRuntimeSnapshotAuditSummary|null){super(`Loop execution unavailable: ${executionState}`);}
}

/** A Loop cannot borrow an unrelated Work execution capability. */
export async function withLinkedLoopWrite<T>(loopId:string,write:(context:WorkshopWriteContext)=>Promise<T>):Promise<T>{
  const lease=resolveExecutionLease();
  if(!lease)throw new ExecutionLeaseError('invalid_lease');
  return withExecutionWrite(lease,async context=>{
    const rows=await context.db.execute(sql`SELECT 1 FROM workshop_loop_executions WHERE run_id=${lease.runId}::uuid AND workshop_id=${lease.workshopId}::uuid AND loop_id=${loopId}::uuid AND active`);
    if(!rows[0])throw new ExecutionLeaseError('invalid_lease');
    return withExecutionWriteContext(lease,context,()=>write(context));
  });
}

/** Admission and claiming precede execution. A captured result is replayed
 * without re-entering the model; the completion transaction releases occupancy. */
export function executeAcceptedWorkLoop(command:AcceptWorkLoopCommand,execute:(controller:AbortController)=>Promise<JobExecutionResult>,complete?:undefined,control?:LoopExecutionControl):Promise<JobExecutionResult>;
export function executeAcceptedWorkLoop<T>(command:AcceptWorkLoopCommand,execute:(controller:AbortController)=>Promise<JobExecutionResult>,complete:(result:JobExecutionResult)=>Promise<T>,control?:LoopExecutionControl):Promise<T>;
export async function executeAcceptedWorkLoop<T>(command:AcceptWorkLoopCommand,execute:(controller:AbortController)=>Promise<JobExecutionResult>,complete?:(result:JobExecutionResult)=>Promise<T>,control:LoopExecutionControl={}):Promise<JobExecutionResult|T>{
  if(resolveExecutionLease())throw new LoopExecutionBusy();
  if(control.signal?.aborted)throw new ExecutionLeaseError('lease_lost');
  const leaseMs=control.leaseMs??60000;
  if(!Number.isSafeInteger(leaseMs)||leaseMs<1000||leaseMs>300000||(control.workerId!==undefined&&(!control.workerId.trim()||control.workerId.length>256)))throw new ExecutionLeaseError('invalid_lease');
  let accepted;
  if(control.acceptedRunId){
    const rows=await db.execute(sql`SELECT x.request_json FROM workshop_loop_executions x JOIN workshops w ON w.id=x.workshop_id WHERE x.run_id=${control.acceptedRunId}::uuid AND x.workshop_id=${command.workId}::uuid AND x.loop_id=${command.loopId}::uuid AND w.user_id=${command.userId}::uuid`);
    if(!rows[0])throw new ExecutionLeaseError('not_found');
    if(canonicalCommandJson(rows[0].request_json)!==canonicalCommandJson(JSON.parse(JSON.stringify(command)))||(command.completionMode??'native')!==(complete?'workshop':'native'))throw new ExecutionLeaseError('invalid_lease');
    accepted={runId:control.acceptedRunId};
  }else try{accepted=await acceptWorkLoopExecution({...command,completionMode:complete?'workshop':'native'});}catch(error){
    if(error instanceof WorkCommandConflict&&error.code==='target_busy')throw new LoopExecutionBusy();
    throw error;
  }
  const saved=await db.execute(sql`SELECT x.result_json,x.active,r.status FROM workshop_loop_executions x JOIN workshop_runs r ON r.id=x.run_id WHERE x.run_id=${accepted.runId}::uuid`);
  if(saved[0]&&!saved[0].active&&!['completed','failed'].includes(String(saved[0].status)))throw new LoopExecutionBusy(String(saved[0].status));
  if(saved[0]?.result_json&&!saved[0].active){
    if(!complete)return saved[0].result_json as JobExecutionResult;
    const receipt=await db.execute(sql`SELECT result_json FROM workshop_output_steps WHERE run_id=${accepted.runId}::uuid AND step_kind='loop:response' AND step_index=0`);
    if(!receipt[0])throw new ExecutionLeaseError('result_conflict');
    return decodeCommandResult<T>(receipt[0].result_json);
  }
  const claim=await claimWorkshopExecution({userId:command.userId,workshopId:command.workId,runId:accepted.runId,workerId:control.workerId??`loop:${crypto.randomUUID()}`,leaseMs});
  if(claim.state!=='claimed')throw new LoopExecutionBusy(claim.state,claim.runtimeSnapshot);
  const controller=new AbortController();
  const abort=()=>controller.abort(control.signal?.reason);
  control.signal?.addEventListener('abort',abort,{once:true});
  if(control.signal?.aborted)abort();
  try{
  const heartbeat=await startExecutionHeartbeat(claim.lease,controller,leaseMs);
  try{return await withExecutionContext(claim.lease,async()=>{
    try {
    await withLinkedLoopWrite(command.loopId, ({db:store}) => assertMemoryDependenciesCurrentInTransaction(store,{userId:command.userId,entityKind:'loop',entityId:command.loopId}));
    let result=await withLinkedLoopWrite(command.loopId,async context=>{
      const tx=context.db;
      await setLoopScheduleExecutionPhase(context,accepted.runId,'running');
      const rows=await tx.execute(sql`SELECT result_json FROM workshop_loop_executions WHERE run_id=${accepted.runId}::uuid`);
      return rows[0]?.result_json as JobExecutionResult|null;
    });
    if(!result){
      try{
        result=await execute(controller);
      }catch(error){
        if(error instanceof ExecutionLeaseError || error instanceof MemoryDependencyError || error instanceof BrainMemoryWriteBusy)throw error;
        const message=error instanceof Error?error.message:String(error);
        const cause=error instanceof Error && error.cause instanceof Error?error.cause.message:message;
        // Only expose a host reason code here, never arbitrary upstream response text.
        const reasonCode=/^[a-z][a-z0-9_]{0,127}$/.test(cause)?cause:'executor_failed_before_result_capture';
        const failure:JobExecutionResult={status:'error',error:message,duration:0,result:{failedBeforeResultCapture:true,reasonCode}};
        // Normal native completion records its result itself. A thrown executor
        // never reached that transaction: capture the failure before postprocess
        // or finalization so recovery replays it instead of re-entering the model.
        result=await withLinkedLoopWrite(command.loopId,async context=>{
          const rows=await context.db.execute(sql`SELECT result_json FROM workshop_loop_executions WHERE run_id=${accepted.runId}::uuid FOR UPDATE`);
          if(rows[0]?.result_json)return rows[0].result_json as JobExecutionResult;
          await context.db.execute(sql`UPDATE workshop_loop_executions SET result_json=${JSON.stringify(failure)}::jsonb WHERE run_id=${accepted.runId}::uuid`);
          await context.db.execute(sql`UPDATE loop_runs SET status='failed',error=${message},completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=${accepted.runId}::uuid AND loop_id=${command.loopId}::uuid`);
          await context.db.execute(sql`UPDATE loop_states SET current_phase='error',last_observation=${reasonCode},blocked_reason=${message},next_action='Review failed loop run',state_json=state_json||${JSON.stringify({lastLoopRunId:accepted.runId,lastJobStatus:'error',lastVerificationPassed:false,lastOutcomeAction:'block'})}::jsonb,updated_at=clock_timestamp() WHERE loop_id=${command.loopId}::uuid`);
          await context.append({workshopId:command.workId,runId:accepted.runId,loopId:command.loopId,loopRunId:accepted.runId,type:'loop_execution_failure_captured',title:'Loop executor failure recorded',metadata:{reasonCode,failedBeforeResultCapture:true}});
          return failure;
        });
      }
    }
    if(controller.signal.reason instanceof MemoryDependencyError || controller.signal.reason instanceof BrainMemoryWriteBusy)throw controller.signal.reason;
    await withLinkedLoopWrite(command.loopId, ({db:store}) => assertMemoryDependenciesCurrentInTransaction(store,{userId:command.userId,entityKind:'loop',entityId:command.loopId}));
    const response=complete?await complete(result):result;
    if(complete)await applyLoopExecutionStep(command.loopId,'response',async()=>response);
    await withLinkedLoopWrite(command.loopId, ({db:store}) => assertMemoryDependenciesCurrentInTransaction(store,{userId:command.userId,entityKind:'loop',entityId:command.loopId}));
    await heartbeat.stop();
    await finishWorkshopExecution(claim.lease,{status:result.status==='success'?'completed':'failed',summary:result.output??null,error:result.error??null,loopResult:{loopId:command.loopId,result}});
    return response;
    } catch(error) {
      if (!(error instanceof MemoryDependencyError) && !(error instanceof BrainMemoryWriteBusy)) throw error;
      // Preserve any already captured result. A blocked run is quarantined,
      // never completed or silently retried with the replacement memory.
      const blockedResult=await withLinkedLoopWrite(command.loopId,async context=>{
        const rows=await context.db.execute(sql`SELECT result_json FROM workshop_loop_executions WHERE run_id=${accepted.runId}::uuid FOR UPDATE`);
        const result=(rows[0]?.result_json??{status:'error',error:error.message,duration:0,result:{memoryDependencyBlocked:true,reasonCode:error.code}}) as JobExecutionResult;
        if(!rows[0]?.result_json)await context.db.execute(sql`UPDATE workshop_loop_executions SET result_json=${JSON.stringify(result)}::jsonb WHERE run_id=${accepted.runId}::uuid`);
        await context.append({workshopId:command.workId,runId:accepted.runId,loopId:command.loopId,loopRunId:accepted.runId,type:'loop_memory_basis_blocked',title:'Loop 记忆依据待复核',body:error.message,metadata:{reasonCode:error.code,actorId:command.userId}});
        return result;
      });
      await heartbeat.stop();
      await finishWorkshopExecution(claim.lease,{status:'needs_review',summary:error.message,error:error.code,metadata:{memoryDependencyBlocked:true,reasonCode:error.code},loopResult:{loopId:command.loopId,result:blockedResult}});
      throw error;
    }
  });}finally{await heartbeat.stop();}
  }finally{control.signal?.removeEventListener('abort',abort);}
}
