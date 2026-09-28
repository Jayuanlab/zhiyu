import {sql} from 'drizzle-orm';
import type {DrizzleDB} from '@/lib/db/types';
import {withWorkshopEventTransaction} from '@/lib/workshops/event-write';
import type {WorkshopWriteContext} from '@/lib/workshops/service';
import {ExecutionLeaseError} from './execution-errors';
import {finalizeWorkshopRun,type RunCompletionInput} from './run-completion';
import {currentExecutionWriteContext} from './execution-write-context';
import {updateLinkedLoopControlState} from './loop-control-state';
import {readWorkRunRuntimeSnapshotSummary} from './runtime-snapshot';
import type {WorkRunRuntimeSnapshotAuditSummary} from './runtime-snapshot';
export {ExecutionLeaseError} from './execution-errors';

export type ExecutionLease = {userId:string;workshopId:string;runId:string;workerId:string;token:number};
type Target = Pick<ExecutionLease,'userId'|'workshopId'>;
type LeaseRow = {token:number;run_id:string|null;worker_id:string|null;phase:string;lease_until:Date|null;effect_started:boolean;result_json:unknown;expired:boolean};
type Claim = {state:'claimed';lease:ExecutionLease;leaseUntil:Date;recoveredFromRuntimeSnapshot?:WorkRunRuntimeSnapshotAuditSummary|null} | {state:'busy'|'paused'|'terminal'|'legacy_busy'|'needs_review'|'recovery_required';runId:string;runtimeSnapshot?:WorkRunRuntimeSnapshotAuditSummary|null};
type Outcome = Omit<RunCompletionInput,'userId'|'workshopId'|'runId'|'lease'>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function duration(ms:number){if(!Number.isSafeInteger(ms)||ms<1000||ms>300000)throw new ExecutionLeaseError('invalid_lease');}
function identity(target:Target){if(!uuid.test(target.userId)||!uuid.test(target.workshopId))throw new ExecutionLeaseError('invalid_lease');}
async function lockTarget(tx:DrizzleDB,target:Target){
  identity(target);
  const rows=await tx.execute(sql`SELECT status FROM workshops WHERE id=${target.workshopId}::uuid AND user_id=${target.userId}::uuid FOR UPDATE`);
  if(!rows[0])throw new ExecutionLeaseError('not_found');
  return rows[0];
}
async function readLease(tx:DrizzleDB,target:Target):Promise<LeaseRow|null>{
  const rows=await tx.execute(sql`SELECT *,lease_until<=clock_timestamp() AS expired FROM workshop_execution_leases WHERE workshop_id=${target.workshopId}::uuid FOR UPDATE`);
  return rows[0] as LeaseRow??null;
}
async function run(tx:DrizzleDB,target:Target,runId:string){
  if(!uuid.test(runId))throw new ExecutionLeaseError('invalid_lease');
  const rows=await tx.execute(sql`SELECT * FROM workshop_runs WHERE id=${runId}::uuid AND workshop_id=${target.workshopId}::uuid FOR UPDATE`);
  if(!rows[0])throw new ExecutionLeaseError('not_found');
  return rows[0];
}
function matches(row:LeaseRow|null,lease:ExecutionLease){return row?.token===lease.token&&row.run_id===lease.runId&&row.worker_id===lease.workerId;}
async function runtimeSnapshotForRun(tx:DrizzleDB,input:Target&{runId?:string|null}){
  return input.runId?await readWorkRunRuntimeSnapshotSummary(tx,{workId:input.workshopId,runId:input.runId}):null;
}
async function audit(context:WorkshopWriteContext,lease:ExecutionLease,type:string,metadata:Record<string,unknown>={}){
  await context.append({workshopId:lease.workshopId,runId:lease.runId,type:`execution_${type}`,title:`执行状态：${type}`,metadata:{workerId:lease.workerId,fencingToken:lease.token,...metadata}});
}

/** Claiming is not execution. A worker must guard every database result and
 * persist effect intent before any external action. No automatic recovery is
 * allowed once an effect might have started. DB time is authoritative. */
export async function claimWorkshopExecution(input:Target&{runId:string;workerId:string;leaseMs:number}):Promise<Claim>{
  duration(input.leaseMs);
  identity(input);if(!uuid.test(input.runId))throw new ExecutionLeaseError('invalid_lease');
  input={...input,userId:input.userId.toLowerCase(),workshopId:input.workshopId.toLowerCase(),runId:input.runId.toLowerCase()};
  if(!input.workerId?.trim()||input.workerId.length>256)throw new ExecutionLeaseError('invalid_lease');
  return withWorkshopEventTransaction(async(tx,append)=>{
    const target=await lockTarget(tx,input),requested=await run(tx,input,input.runId);
    await tx.execute(sql`INSERT INTO workshop_execution_leases(workshop_id) VALUES (${input.workshopId}::uuid) ON CONFLICT DO NOTHING`);
    const current=(await readLease(tx,input))!;
    if(current.phase==='needs_review')return {state:'needs_review',runId:current.run_id!,runtimeSnapshot:await runtimeSnapshotForRun(tx,{...input,runId:current.run_id})};
    if(current.phase==='running'){
      if(!current.expired)return {state:'busy',runId:current.run_id!,runtimeSnapshot:await runtimeSnapshotForRun(tx,{...input,runId:current.run_id})};
      const currentRuntimeSnapshot=await runtimeSnapshotForRun(tx,{...input,runId:current.run_id});
      if(current.effect_started){
        const lost:ExecutionLease={...input,runId:current.run_id!,workerId:current.worker_id!,token:current.token};
        await tx.execute(sql`UPDATE workshop_execution_leases SET phase='needs_review',updated_at=clock_timestamp() WHERE workshop_id=${input.workshopId}::uuid`);
        await tx.execute(sql`UPDATE workshop_runs SET status='needs_review',error='lease_expired_after_effect',updated_at=clock_timestamp() WHERE id=${current.run_id}::uuid AND workshop_id=${input.workshopId}::uuid`);
        await updateLinkedLoopControlState({db:tx,append},{workshopId:input.workshopId,runId:current.run_id!,userId:input.userId,status:'needs_review',reason:'lease_expired_after_effect',wasRunning:true,execution:{workerId:current.worker_id,token:current.token,runtimeSnapshot:currentRuntimeSnapshot}});
        await audit({db:tx,append},lost,'needs_review',{reason:'lease_expired_after_effect',runtimeSnapshot:currentRuntimeSnapshot});
        return {state:'needs_review',runId:current.run_id!,runtimeSnapshot:currentRuntimeSnapshot};
      }
      if(current.run_id!==input.runId)return {state:'recovery_required',runId:current.run_id!,runtimeSnapshot:currentRuntimeSnapshot};
    }
    if(!['queued','running'].includes(String(requested.status)))return {state:'terminal',runId:input.runId,runtimeSnapshot:await runtimeSnapshotForRun(tx,input)};
    if(target.status!=='active')return {state:'paused',runId:input.runId,runtimeSnapshot:await runtimeSnapshotForRun(tx,input)};
    // Candidate discovery is not authority: a Loop may be paused after the
    // consumer reads it. Serialize with Loop configuration writes at claim,
    // without treating pause as cancellation of an already held lease.
    const linked=await tx.execute(sql`SELECT p.status,p.user_id,p.workshop_id,x.active FROM workshop_loop_executions x JOIN loops p ON p.id=x.loop_id WHERE x.run_id=${input.runId}::uuid FOR UPDATE OF p`);
    if(linked[0]){
      if(linked[0].user_id!==input.userId||linked[0].workshop_id!==input.workshopId)throw new ExecutionLeaseError('invalid_lease');
      if(!linked[0].active)return {state:'terminal',runId:input.runId,runtimeSnapshot:await runtimeSnapshotForRun(tx,input)};
      if(linked[0].status!=='active')return {state:'paused',runId:input.runId,runtimeSnapshot:await runtimeSnapshotForRun(tx,input)};
    }
    // Do not adopt legacy detached executors. They have no fencing protocol.
    if(requested.status==='running'&&current.phase!=='running')return {state:'legacy_busy',runId:input.runId,runtimeSnapshot:await runtimeSnapshotForRun(tx,input)};
    const legacy=await tx.execute(sql`SELECT id FROM workshop_runs WHERE workshop_id=${input.workshopId}::uuid AND status='running' AND id<>${input.runId}::uuid LIMIT 1`);
    if(legacy[0]){const legacyRunId=String(legacy[0].id);return {state:'legacy_busy',runId:legacyRunId,runtimeSnapshot:await runtimeSnapshotForRun(tx,{...input,runId:legacyRunId})};}
    if(current.token>=2147483647)throw new ExecutionLeaseError('invalid_lease');
    const rows=await tx.execute(sql`UPDATE workshop_execution_leases SET token=token+1,run_id=${input.runId}::uuid,worker_id=${input.workerId},phase='running',lease_until=clock_timestamp()+${input.leaseMs}*interval '1 millisecond',heartbeat_at=clock_timestamp(),effect_started=false,result_json=NULL,updated_at=clock_timestamp() WHERE workshop_id=${input.workshopId}::uuid RETURNING token,lease_until`);
    const lease:ExecutionLease={userId:input.userId,workshopId:input.workshopId,runId:input.runId,workerId:input.workerId,token:Number(rows[0].token)};
    await tx.execute(sql`UPDATE workshop_runs SET status='running',started_at=COALESCE(started_at,clock_timestamp()),completed_at=NULL,error=NULL,updated_at=clock_timestamp() WHERE id=${input.runId}::uuid`);
    const recoveredFromRuntimeSnapshot=current.phase==='running'?await runtimeSnapshotForRun(tx,input):null;
    await audit({db:tx,append},lease,current.phase==='running'?'recovered':'claimed',{leaseUntil:rows[0].lease_until,runtimeSnapshot:recoveredFromRuntimeSnapshot});
    const time=await tx.execute(sql`SELECT clock_timestamp()<${rows[0].lease_until}::timestamptz AS valid`);
    if(!time[0]?.valid)throw new ExecutionLeaseError('lease_lost');
    return {state:'claimed',lease,leaseUntil:new Date(rows[0].lease_until as string | Date),...(recoveredFromRuntimeSnapshot?{recoveredFromRuntimeSnapshot}:{})};
  });
}

/** The callback is database-only, in this transaction. Never call a model,
 * network adapter or another transaction from it. It is checked again before
 * commit so a long callback cannot silently commit after expiration. */
export async function withExecutionWrite<T>(lease:ExecutionLease,write:(context:WorkshopWriteContext)=>Promise<T>):Promise<T>{
  const existing=currentExecutionWriteContext(lease);
  if(existing)return withExecutionTransaction(lease,existing,write);
  return withWorkshopEventTransaction(async(tx,append)=>{
    return withExecutionTransaction(lease,{db:tx,append},write);
  });
}
/** Reuse an existing database transaction; callers must propagate errors so
 * the entire transaction rolls back. No network or nested transactions. */
export async function withExecutionTransaction<T>(lease:ExecutionLease,context:WorkshopWriteContext,write:(context:WorkshopWriteContext)=>Promise<T>):Promise<T>{
  const tx=context.db;
  await lockTarget(tx,lease);
  const current=await readLease(tx,lease),ownedRun=await run(tx,lease,lease.runId);
  if(!matches(current,lease)||current!.phase!=='running'||current!.expired||ownedRun.status!=='running')throw new ExecutionLeaseError('lease_lost');
  const result=await write(context);
  const time=await tx.execute(sql`SELECT clock_timestamp()<${current!.lease_until}::timestamptz AS valid`);
  if(!time[0]?.valid)throw new ExecutionLeaseError('lease_lost');
  return result;
}
export async function renewExecutionLease(lease:ExecutionLease,leaseMs:number){
  duration(leaseMs);
  return withExecutionWrite(lease,async({db:tx})=>{
    const rows=await tx.execute(sql`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()+${leaseMs}*interval '1 millisecond',heartbeat_at=clock_timestamp(),updated_at=clock_timestamp() WHERE workshop_id=${lease.workshopId}::uuid RETURNING lease_until`);
    return new Date(rows[0].lease_until as string | Date);
  });
}
export async function markExecutionEffect(lease:ExecutionLease){
  return withExecutionWrite(lease,async(context)=>{
    const rows=await context.db.execute(sql`UPDATE workshop_execution_leases SET effect_started=true,updated_at=clock_timestamp() WHERE workshop_id=${lease.workshopId}::uuid AND effect_started=false RETURNING token`);
    if(rows.length)await audit(context,lease,'effect_intent');
  });
}
export async function finishWorkshopExecution(lease:ExecutionLease,outcome:Outcome){
  return finalizeWorkshopRun({...outcome,userId:lease.userId,workshopId:lease.workshopId,runId:lease.runId,lease});
}
