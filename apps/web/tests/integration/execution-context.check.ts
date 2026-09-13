import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {withExecutionContext,resolveExecutionLease} from '@/lib/work-runtime/execution-context';
import {claimWorkshopExecution} from '@/lib/work-runtime/execution-lease';
import {updateWork} from '@/lib/work-runtime/commands';
import {getWorkCommand} from '@/lib/work-runtime/command-ledger';

export async function checkExecutionContext(client:postgres.Sql){
  const userId=randomUUID();await client`INSERT INTO "User"(id,email) VALUES (${userId},'context@example.invalid')`;
  async function fixture(){
    const workId=randomUUID(),runId=randomUUID();
    await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workId},${userId},'before','test')`;
    await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${runId},${workId},'queued',NULL)`;
    const target={userId,workshopId:workId,runId,workerId:'first',leaseMs:30000};
    const claimed=await claimWorkshopExecution(target);if(claimed.state!=='claimed')throw Error('not claimed');
    return {target,lease:claimed.lease,command:{userId,workId,commandId:randomUUID(),expectedVersion:0,patch:{name:'guarded'}}};
  }
  const a=await fixture(),b=await fixture();
  // Real public Work command: no explicit lease argument at any command caller.
  await Promise.all([a,b].map(item=>withExecutionContext(item.lease,async()=>{
    await new Promise(resolve=>setTimeout(resolve,5));
    return updateWork(item.command);
  })));
  for(const item of [a,b])assert.equal((await client`SELECT name FROM workshops WHERE id=${item.command.workId}`)[0].name,'guarded');
  assert.equal(resolveExecutionLease(),undefined);
  const lost={...a.command,commandId:randomUUID(),expectedVersion:1,patch:{name:'must not write'}};
  await withExecutionContext(a.lease,async()=>{
    await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE workshop_id=${a.command.workId}`;
    await Promise.resolve();
    await assert.rejects(updateWork(lost),{code:'lease_lost'});
  });
  assert.equal((await getWorkCommand(userId,lost.commandId))?.status,'queued');
  assert.equal((await client`SELECT name FROM workshops WHERE id=${a.command.workId}`)[0].name,'guarded');
  const recovered=await claimWorkshopExecution({...a.target,workerId:'replacement'});if(recovered.state!=='claimed')throw Error('not reclaimed');
  await withExecutionContext(recovered.lease,()=>updateWork(lost));
  assert.equal((await getWorkCommand(userId,lost.commandId))?.status,'succeeded');
  const cross={...b.command,commandId:randomUUID(),expectedVersion:1};
  await assert.rejects(withExecutionContext(recovered.lease,()=>updateWork(cross)),{code:'invalid_lease'});
  assert.equal(resolveExecutionLease(),undefined);
  return {name:'async execution capability reaches real updateWork: parallel isolation, late lease loss, stable recovery and cross-Work rejection',passed:true};
}
