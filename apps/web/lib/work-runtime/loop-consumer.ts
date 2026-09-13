import {sql} from 'drizzle-orm';
import {db} from '@/lib/db/client';
import type {AcceptWorkLoopCommand} from './loop-command';
import {LoopExecutionBusy,type LoopExecutionControl} from './loop-execution';
import {resolveExecutionLease} from './execution-context';

type Input={userId:string;workerId:string;limit?:number;leaseMs?:number;signal?:AbortSignal};
async function execute(command:AcceptWorkLoopCommand,control:LoopExecutionControl){
  if(command.completionMode==='workshop'){
    const {executeWorkshopLoopCommand}=await import('@/lib/workshops/loop-runtime');
    return executeWorkshopLoopCommand(command,control);
  }
  const {executeNativeLoopCommand}=await import('@/lib/loops/harness');
  return executeNativeLoopCommand(command,control);
}

/** A queue read is only a candidate list. The coordinator must claim the Work
 * lease before doing anything, including after a competing worker starts. */
export async function consumeOwnedLoopRuns(input:Input,run=execute){
  if(resolveExecutionLease())throw Error('A producer cannot start a host consumer');
  const limit=input.limit??5,leaseMs=input.leaseMs??60000;
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.userId)||!input.workerId?.trim()||input.workerId.length>256||!Number.isSafeInteger(limit)||limit<1||limit>50||!Number.isSafeInteger(leaseMs)||leaseMs<1000||leaseMs>300000)throw Error('Invalid consumer configuration');
  const results:Array<{runId:string;state:string;detail?:string}>=[];
  if(input.signal?.aborted)return results;
  const candidates=await db.execute(sql`SELECT x.run_id,x.request_json FROM workshop_loop_executions x JOIN workshop_runs r ON r.id=x.run_id JOIN workshops w ON w.id=x.workshop_id JOIN loops p ON p.id=x.loop_id LEFT JOIN workshop_execution_leases l ON l.workshop_id=w.id WHERE w.user_id=${input.userId}::uuid AND p.user_id=w.user_id AND p.workshop_id=w.id AND w.status='active' AND x.active AND ((r.status='queued' AND p.status='active' AND (l.phase IS NULL OR l.phase='idle') AND NOT EXISTS(SELECT 1 FROM workshop_runs other WHERE other.workshop_id=w.id AND other.status IN ('running','cancel_requested','needs_review'))) OR (r.status='running' AND l.phase='running' AND l.run_id=r.id AND l.lease_until<=clock_timestamp())) ORDER BY (r.status='running') DESC,r.created_at,r.id LIMIT ${limit}`);
  for(const candidate of candidates){
    if(input.signal?.aborted)break;
    const runId=String(candidate.run_id),command=candidate.request_json as AcceptWorkLoopCommand;
    let state='error',detail:string|undefined;
    try{
      if(command.userId.toLowerCase()!==input.userId.toLowerCase())throw Error('Loop command owner mismatch');
      await run(command,{workerId:input.workerId,leaseMs,signal:input.signal,acceptedRunId:runId});
      const rows=await db.execute(sql`SELECT status FROM workshop_runs WHERE id=${runId}::uuid`);
      state=String(rows[0]?.status??'unavailable');
    }catch(error){
      state=error instanceof LoopExecutionBusy?error.executionState:'error';
      detail=error instanceof Error?error.message:String(error);
      const rows=await db.execute(sql`SELECT status,error FROM workshop_runs WHERE id=${runId}::uuid`);
      if(rows[0]&&['completed','failed','cancelled','needs_review'].includes(String(rows[0].status))){state=String(rows[0].status);detail=rows[0].error==null?undefined:String(rows[0].error);}
    }
    results.push({runId,state,...(detail?{detail}:{})});
  }
  return results;
}
