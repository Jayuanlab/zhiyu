import {sql} from 'drizzle-orm';
import {withExecutionWrite,withExecutionBusinessWrite,type ExecutionLease} from './execution-lease';
import {ExecutionLeaseError} from './execution-errors';
import {canonicalCommandJson} from './command-payload';
import type {WorkshopWriteContext} from '@/lib/workshops/service';
import {applyRecordedStep} from './recorded-step';

export type OutputStepKind='logEvents'|'memoryCandidates'|'outboxDrafts'|'nextWakeupSuggestion';
export function outputActions(value:unknown):Record<string,unknown>[] {
  return Array.isArray(value)?value.filter((item):item is Record<string,unknown>=>Boolean(item)&&typeof item==='object'&&!Array.isArray(item)):[];
}
/** The callback is database-only and must use this transaction. Receipt and
 * business writes commit together; network calls and nested transactions are forbidden. */
export async function applyOutputStep<T>(lease:ExecutionLease,kind:OutputStepKind,index:number,expected:Record<string,unknown>,apply:(context:WorkshopWriteContext)=>Promise<T>):Promise<T>{
  if(!['logEvents','memoryCandidates','outboxDrafts','nextWakeupSuggestion'].includes(kind)||!Number.isSafeInteger(index)||index<0)throw new ExecutionLeaseError('invalid_lease');
  const fence=kind==='logEvents'?withExecutionWrite:withExecutionBusinessWrite;
  return fence(lease,async context=>{
    const {db}=context;
    const outputs=await db.execute(sql`SELECT result_json FROM workshop_run_outputs WHERE run_id=${lease.runId}::uuid AND workshop_id=${lease.workshopId}::uuid`);
    const result=outputs[0]?.result_json;
    const raw=result?.structured?.[kind];
    const action=outputActions(kind==='nextWakeupSuggestion'?[raw]:raw)[index];
    if(result?.status!=='success'||!action||canonicalCommandJson(action as any)!==canonicalCommandJson(expected as any))throw new ExecutionLeaseError('result_conflict');
    return applyRecordedStep(context,lease,kind,index,apply);
  });
}
