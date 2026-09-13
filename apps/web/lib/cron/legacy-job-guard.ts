import {sql} from 'drizzle-orm';
import {db} from '@/lib/db/client';
import {ExecutionLeaseError} from '@/lib/work-runtime/execution-errors';

/** The legacy execution must already be durably registered. Migration takes the
 * same job lock and refuses that unfinished execution before retiring the job. */
export async function assertLegacyJobExecutionAllowed(input:{userId:string;jobId:string;executionId:string}){
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if(![input.userId,input.jobId,input.executionId].every(value=>typeof value==='string'&&uuid.test(value)))throw new ExecutionLeaseError('invalid_lease');
  if(process.env.TAURI_MODE==='true'||process.env.IS_TAURI==='true')throw new ExecutionLeaseError('invalid_lease');
  await db.transaction(async tx=>{
    const job=await tx.execute(sql`SELECT id FROM scheduled_jobs WHERE id=${input.jobId}::uuid AND user_id=${input.userId}::uuid AND enabled FOR UPDATE`);
    if(!job[0])throw new ExecutionLeaseError('invalid_lease');
    const run=await tx.execute(sql`SELECT 1 FROM job_executions WHERE id=${input.executionId}::uuid AND job_id=${input.jobId}::uuid AND status='running' AND NOT EXISTS(SELECT 1 FROM loop_runtime_migrations WHERE legacy_job_id=${input.jobId}::uuid)`);
    if(!run[0])throw new ExecutionLeaseError('invalid_lease');
  });
}
