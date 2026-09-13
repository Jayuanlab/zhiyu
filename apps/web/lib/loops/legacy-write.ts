import {sql} from 'drizzle-orm';
import {db} from '@/lib/db/client';
import type {DrizzleDB} from '@/lib/db/types';
import {ExecutionLeaseError} from '@/lib/work-runtime/execution-errors';
export const supportsLoopMigration=()=>process.env.TAURI_MODE!=='true'&&process.env.IS_TAURI!=='true';

/** Serialize legacy writes with migration. A cached standalone executor must
 * not mutate the newly adopted controller after the owner has migrated it. */
export async function withLegacyLoopWrite<T>(loopId:string,write:(store:DrizzleDB)=>Promise<T>):Promise<T>{
  if(!supportsLoopMigration())return write(db);
  return db.transaction(async tx=>{
    await tx.execute(sql`SELECT id FROM loops WHERE id=${loopId}::uuid FOR UPDATE`);
    const migrated=await tx.execute(sql`SELECT 1 FROM loop_runtime_migrations WHERE loop_id=${loopId}::uuid`);
    if(migrated[0])throw new ExecutionLeaseError('invalid_lease');
    return write(tx as DrizzleDB);
  });
}
