import {withWorkshopEventTransaction} from '@/lib/workshops/event-write';
import type {WorkshopWriteContext} from '@/lib/workshops/service';
import {resolveExecutionLease} from './execution-context';
import {withExecutionTransaction,withExecutionBusinessTransaction,type ExecutionLease} from './execution-lease';
import {ExecutionLeaseError} from './execution-errors';
import {sql} from 'drizzle-orm';
import {currentExecutionWriteContext} from './execution-write-context';
import {rethrowBrainMemoryWriteError} from '@/lib/brain/write-guard';

type Scope={workshopId:string;runId?:string|null;business?:boolean};
function assertScope(scope:Scope,lease:ExecutionLease){
  if(scope.workshopId!==lease.workshopId || (scope.runId!=null && scope.runId!==lease.runId))throw new ExecutionLeaseError('invalid_lease');
}

/** Database-only state and event write. The ambient capability comes from the
 * host, never the input payload. Derived projections may consume committed
 * events later; they must not be performed inside this transaction. */
export async function withWorkshopControlWrite<T>(scope:Scope,write:(context:WorkshopWriteContext)=>Promise<T>):Promise<T>{
  const lease=resolveExecutionLease();
  const existing=lease?currentExecutionWriteContext(lease):undefined;
  try {
    if(existing)return await withWorkshopControlTransaction(scope,existing,write);
    return await withWorkshopEventTransaction((db,append)=>withWorkshopControlTransaction(scope,{db,append},write));
  } catch(error) { if(lease)return rethrowBrainMemoryWriteError(error); throw error; }
}

/** Same scope and lease checks inside an existing database-only transaction. */
export async function withWorkshopControlTransaction<T>(scope:Scope,context:WorkshopWriteContext,write:(context:WorkshopWriteContext)=>Promise<T>):Promise<T>{
  const lease=resolveExecutionLease();
  const {db,append}=context;
  if(!lease){
    // Serialize with claim/finalization before deciding that this is a legacy
    // run. Completion receipts keep that decision valid after lease rollover.
    const assertLegacy = async (target:Scope) => {
      if(target.workshopId!==scope.workshopId)throw new ExecutionLeaseError('invalid_lease');
      if(!target.runId)return;
      await db.execute(sql`SELECT id FROM workshops WHERE id=${target.workshopId}::uuid FOR UPDATE`);
      const rows=await db.execute(sql`SELECT r.id,r.completion_json->'execution'->>'workerId' AS completed_worker,l.run_id AS leased_run,l.token
        FROM workshop_runs r LEFT JOIN workshop_execution_leases l ON l.workshop_id=r.workshop_id
        WHERE r.id=${target.runId}::uuid AND r.workshop_id=${target.workshopId}::uuid`);
      if(!rows[0])throw new ExecutionLeaseError('not_found');
      if(rows[0].completed_worker!=null || (rows[0].leased_run===target.runId.toLowerCase() && Number(rows[0].token)>0))throw new ExecutionLeaseError('lease_lost');
    };
    await assertLegacy(scope);
    return write({db,append:async event=>{await assertLegacy(event);return append(event);}});
  }
  assertScope(scope,lease);
  const fence=scope.business?withExecutionBusinessTransaction:withExecutionTransaction;
  return fence(lease,context,context=>write({db:context.db,append:async event=>{
    assertScope(event,lease);
    return context.append({...event,runId:event.runId??lease.runId,metadata:{...event.metadata,actorId:lease.userId,execution:{runId:lease.runId,workerId:lease.workerId,token:lease.token}}});
  }}));
}
