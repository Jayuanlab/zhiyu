import {sql} from 'drizzle-orm';
import type {ExecutionLease} from './execution-lease';
import {ExecutionLeaseError} from './execution-errors';
import {encodeCommandResult,decodeCommandResult} from './database-command';
import type {WorkshopWriteContext} from '@/lib/workshops/service';
import {withExecutionWriteContext} from './execution-write-context';

/** Internal transaction primitive. Caller must validate the current lease and
 * immutable observation before invoking this database-only step. */
export async function applyRecordedStep<T>(context:WorkshopWriteContext,lease:ExecutionLease,kind:string,index:number,apply:(context:WorkshopWriteContext)=>Promise<T>):Promise<T>{
  const {db}=context;
  const previous=await db.execute(sql`SELECT result_json FROM workshop_output_steps WHERE run_id=${lease.runId}::uuid AND step_kind=${kind} AND step_index=${index}`);
  if(previous[0])return decodeCommandResult<T>(previous[0].result_json);
  const stepContext:WorkshopWriteContext={db,append:event=>{
    if(event.workshopId!==lease.workshopId||(event.runId!=null&&event.runId!==lease.runId))throw new ExecutionLeaseError('invalid_lease');
    return context.append({...event,runId:lease.runId,metadata:{...event.metadata,actorId:lease.userId,execution:{runId:lease.runId,workerId:lease.workerId,token:lease.token},outputStep:{kind,index}}});
  }};
  const value=await withExecutionWriteContext(lease,stepContext,()=>apply(stepContext));
  const encoded=encodeCommandResult(value);
  await db.execute(sql`INSERT INTO workshop_output_steps(run_id,step_kind,step_index,result_json,worker_id,fencing_token) VALUES (${lease.runId}::uuid,${kind},${index},${JSON.stringify(encoded)}::jsonb,${lease.workerId},${lease.token})`);
  return decodeCommandResult<T>(encoded);
}
