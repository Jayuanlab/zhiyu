import 'server-only';
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {db} from '@/lib/db/client';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const identity=(value:string)=>{if(!uuid.test(value))throw Error('invalid_legacy_reconciliation_identity');return value.toLowerCase();};
type Candidate={id:string;attempts:number;status:string;updated_at:string;event_ids:unknown};
async function candidates(executor:Pick<typeof db,'execute'>,owner:string,lock=false){
  return await executor.execute(sql`SELECT j.id,j.attempts,j.status,j.updated_at::text AS updated_at,j.event_ids
    FROM interaction_processing_jobs j WHERE j.user_id=${owner}::uuid AND j.status IN ('running','applying') AND j.attempts>0
    AND NOT EXISTS(SELECT 1 FROM runtime_interaction_claims c WHERE c.job_id=j.id AND c.attempt=j.attempts)
    ORDER BY j.id LIMIT 101 ${lock?sql`FOR UPDATE OF j`:sql``}`) as unknown as Candidate[];
}
function manifest(owner:string,rows:Candidate[]){
  const value={ownerId:owner,jobs:rows.slice(0,100).map(row=>({id:row.id,attempt:row.attempts,status:row.status,updatedAt:row.updated_at,eventIds:row.event_ids}))};
  return {manifest:value,manifestHash:createHash('sha256').update(JSON.stringify(value)).digest('hex'),hasMore:rows.length>100};
}

/** Local maintenance only: time elapsed does not establish that a legacy process has stopped. */
export async function previewLegacyInteractions(ownerId:string){
  const owner=identity(ownerId);
  return {...manifest(owner,await candidates(db,owner)),requiresOldProcessesStopped:true,reviewPath:'/interaction-reviews'};
}
export async function reconcileLegacyInteractions(input:{ownerId:string;commandId:string;manifestHash:string;confirmedOldProcessesStopped:boolean}){
  const owner=identity(input.ownerId),commandId=identity(input.commandId);
  if(input.confirmedOldProcessesStopped!==true)throw Error('legacy_process_stop_confirmation_required');
  if(!/^[a-f0-9]{64}$/.test(input.manifestHash))throw Error('legacy_manifest_required');
  return db.transaction(async(tx:any)=>{
    // Same lock as host acquisition: do not race a new formal host during maintenance.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'runtime-host:'+owner},0))`);
    const [previous]=await tx.execute(sql`SELECT * FROM interaction_legacy_reconciliations WHERE owner_id=${owner}::uuid AND command_id=${commandId}::uuid`);
    if(previous){
      if(previous.manifest_hash!==input.manifestHash)throw Error('legacy_command_conflict');
      return {receipt:previous,replayed:true,reviewPath:'/interaction-reviews'};
    }
    const live=await tx.execute(sql`SELECT owner_id FROM runtime_owner_leases WHERE owner_id=${owner}::uuid AND lease_until>clock_timestamp() FOR UPDATE`);
    if(live.length)throw Error('legacy_reconciliation_requires_stopped_worker');
    const current=manifest(owner,await candidates(tx,owner,true));
    if(current.manifestHash!==input.manifestHash)throw Error('legacy_manifest_changed');
    if(!current.manifest.jobs.length)throw Error('legacy_manifest_empty');
    for(const job of current.manifest.jobs){
      await tx.execute(sql`UPDATE interaction_processing_jobs SET status='needs_review',last_error='interaction_legacy_result_unknown',updated_at=clock_timestamp()
        WHERE user_id=${owner}::uuid AND id=${job.id}::uuid AND attempts=${job.attempt}`);
      await tx.execute(sql`UPDATE interaction_events e SET processed_status='failed',updated_at=clock_timestamp()
        FROM interaction_processing_jobs j WHERE j.id=${job.id}::uuid AND j.user_id=${owner}::uuid AND e.user_id=j.user_id
        AND j.event_ids ? e.id::text AND e.processed_status='processing'`);
    }
    const [receipt]=await tx.execute(sql`INSERT INTO interaction_legacy_reconciliations(owner_id,command_id,manifest_hash,manifest,confirmed_old_processes_stopped)
      VALUES (${owner}::uuid,${commandId}::uuid,${input.manifestHash},${JSON.stringify(current.manifest)}::jsonb,true) RETURNING *`);
    return {receipt,replayed:false,reviewPath:'/interaction-reviews'};
  });
}
