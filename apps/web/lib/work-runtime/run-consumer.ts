import {and,eq,sql} from 'drizzle-orm';
import {db} from '@/lib/db/client';
import {workshopRuns} from '@/lib/db/schema';
import {getWorkshop} from '@/lib/workshops/service';
import {executeWorkshopRunLifecycle} from '@/lib/workshops/runtime';
import {claimWorkshopExecution} from './execution-lease';
import {resolveExecutionLease} from './execution-context';
import type {WorkRunRuntimeSnapshotAuditSummary} from './runtime-snapshot';

type Input={userId:string;workerId:string;limit?:number;leaseMs?:number;signal?:AbortSignal};
type ConsumerResult={runId:string;state:string;detail?:string;runtimeSnapshot?:WorkRunRuntimeSnapshotAuditSummary|null};
/** One bounded host cycle. Admission and fencing belong to the execution lease;
 * a queue read never grants authority to run. Host scheduling is separate. */
export async function consumeOwnedWorkRuns(input:Input,execute=executeWorkshopRunLifecycle){
  const limit=input.limit??5,leaseMs=input.leaseMs??60000;
  if(resolveExecutionLease())throw Error('A producer cannot start a host consumer');
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.userId)||!input.workerId?.trim()||input.workerId.length>256||!Number.isSafeInteger(limit)||limit<1||limit>50||!Number.isSafeInteger(leaseMs)||leaseMs<1000||leaseMs>300000)throw Error('Invalid consumer configuration');
  const results:Array<ConsumerResult>=[];
  if(input.signal?.aborted)return results;
  const candidates=await db.execute(sql`SELECT r.id,r.workshop_id FROM workshop_runs r JOIN workshops w ON w.id=r.workshop_id LEFT JOIN workshop_execution_leases l ON l.workshop_id=w.id WHERE w.user_id=${input.userId}::uuid AND w.status='active' AND NOT EXISTS(SELECT 1 FROM workshop_loop_executions x WHERE x.run_id=r.id) AND ((r.status='queued' AND (l.phase IS NULL OR l.phase='idle') AND NOT EXISTS(SELECT 1 FROM workshop_runs other WHERE other.workshop_id=w.id AND other.status IN ('running','cancel_requested','needs_review'))) OR (r.status='running' AND l.phase='running' AND l.run_id=r.id AND l.lease_until<=clock_timestamp())) ORDER BY (r.status='running') DESC,r.created_at,r.id LIMIT ${limit}`);
  for(const candidate of candidates){
    if(input.signal?.aborted)break;
    const runId=String(candidate.id),workshopId=String(candidate.workshop_id);
    let state='error',detail:string|undefined;
    const controller=new AbortController();
    const abort=()=>controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort',abort,{once:true});
    try{
      if(input.signal?.aborted){abort();break;}
      const claim=await claimWorkshopExecution({userId:input.userId,workshopId,runId,workerId:input.workerId,leaseMs});
      if(claim.state!=='claimed'){results.push({runId,state:claim.state,runtimeSnapshot:claim.runtimeSnapshot});continue;}
      const workshop=await getWorkshop(input.userId,workshopId);
      const [run]=await db.select().from(workshopRuns).where(and(eq(workshopRuns.id,runId),eq(workshopRuns.workshopId,workshopId))).limit(1);
      if(!workshop||!run)throw Error('Claimed work/run is unavailable');
      await execute({userId:input.userId,workshop,run,triggerReason:run.triggerReason??undefined,executionLease:claim.lease,executionLeaseMs:leaseMs,abortController:controller});
      const [finished]=await db.select({status:workshopRuns.status}).from(workshopRuns).where(eq(workshopRuns.id,runId)).limit(1);
      state=finished?.status??'unavailable';
    }catch(error){detail=error instanceof Error?error.message:String(error);}
    finally{input.signal?.removeEventListener('abort',abort);}
    results.push({runId,state,...(detail?{detail}:{})});
  }
  return results;
}
