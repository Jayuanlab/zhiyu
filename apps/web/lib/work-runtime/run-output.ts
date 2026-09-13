import {sql} from 'drizzle-orm';
import {withExecutionWrite,type ExecutionLease} from './execution-lease';
import {ExecutionLeaseError} from './execution-errors';
import {canonicalCommandJson} from './command-payload';
import type {WorkshopExecutionResult} from '@/lib/workshops/executor';

export type CapturedRunOutput={result:WorkshopExecutionResult;directiveIds:string[]};
/** Immutable observation checkpoint. It is not an application receipt and must
 * not by itself authorize retrying structured actions or external effects. */
export async function captureRunOutput(lease:ExecutionLease,input:CapturedRunOutput):Promise<CapturedRunOutput>{
  const value=JSON.parse(JSON.stringify({...input,directiveIds:[...new Set(input.directiveIds.map(id=>id.toLowerCase()))].sort()})) as CapturedRunOutput;
  return withExecutionWrite(lease,async({db,append})=>{
    const existing=await db.execute(sql`SELECT result_json,directive_ids FROM workshop_run_outputs WHERE run_id=${lease.runId}::uuid`);
    if(existing[0]){
      if(canonicalCommandJson(existing[0].result_json)!==canonicalCommandJson(value.result as any)||canonicalCommandJson(existing[0].directive_ids)!==canonicalCommandJson(value.directiveIds))throw new ExecutionLeaseError('result_conflict');
      return {result:existing[0].result_json,directiveIds:existing[0].directive_ids} as CapturedRunOutput;
    }
    if(value.directiveIds.length){
      const directives=await db.execute(sql`SELECT id FROM workshop_directives WHERE id=ANY(${sql.param(value.directiveIds)}::uuid[]) AND workshop_id=${lease.workshopId}::uuid AND scope='current_run' AND status='active' AND (run_id IS NULL OR run_id=${lease.runId}::uuid) FOR SHARE`);
      if(directives.length!==value.directiveIds.length)throw new ExecutionLeaseError('invalid_lease');
    }
    await db.execute(sql`INSERT INTO workshop_run_outputs(run_id,workshop_id,result_json,directive_ids,worker_id,fencing_token) VALUES (${lease.runId}::uuid,${lease.workshopId}::uuid,${JSON.stringify(value.result)}::jsonb,${JSON.stringify(value.directiveIds)}::jsonb,${lease.workerId},${lease.token})`);
    await append({workshopId:lease.workshopId,runId:lease.runId,type:'run_output_captured',title:'本轮模型结果已保存',metadata:{actorId:lease.userId,workerId:lease.workerId,fencingToken:lease.token,status:value.result.status,directiveIds:value.directiveIds}});
    return value;
  });
}

export async function readCapturedRunOutput(lease:ExecutionLease):Promise<CapturedRunOutput|null>{
  return withExecutionWrite(lease,async({db})=>{
    const rows=await db.execute(sql`SELECT result_json,directive_ids FROM workshop_run_outputs WHERE run_id=${lease.runId}::uuid AND workshop_id=${lease.workshopId}::uuid`);
    return rows[0]?{result:rows[0].result_json,directiveIds:rows[0].directive_ids} as CapturedRunOutput:null;
  });
}
