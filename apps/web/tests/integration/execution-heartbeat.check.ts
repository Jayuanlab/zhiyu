import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import type postgres from 'postgres';
import {claimWorkshopExecution,withExecutionWrite} from '@/lib/work-runtime/execution-lease';
import {startExecutionHeartbeat} from '@/lib/work-runtime/execution-heartbeat';

export async function checkExecutionHeartbeat(client:postgres.Sql){
  const userId=randomUUID(),workshopId=randomUUID(),runId=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},'heartbeat-test@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workshopId},${userId},'lease heartbeat','test')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status) VALUES (${runId},${workshopId},'queued')`;
  const claim=await claimWorkshopExecution({userId,workshopId,runId,workerId:'heartbeat-worker',leaseMs:1500});
  assert.equal(claim.state,'claimed');if(claim.state!=='claimed')throw Error('claim failed');
  const controller=new AbortController();
  const heartbeat=await startExecutionHeartbeat(claim.lease,controller,1500);
  try{
    await sleep(2100);
    await withExecutionWrite(claim.lease,async()=>undefined);
    assert.equal(controller.signal.aborted,false);
    const rows=await client`SELECT heartbeat_at,lease_until FROM workshop_execution_leases WHERE workshop_id=${workshopId}`;
    assert(new Date(rows[0].lease_until).getTime()>claim.leaseUntil.getTime());
    await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE workshop_id=${workshopId}`;
    for(let attempt=0;attempt<30&&!controller.signal.aborted;attempt++)await sleep(100);
    assert.equal(controller.signal.aborted,true);
    await assert.rejects(withExecutionWrite(claim.lease,async()=>undefined),{code:'lease_lost'});
  }finally{await heartbeat.stop();}
  const replacement=await claimWorkshopExecution({userId,workshopId,runId,workerId:'replacement-worker',leaseMs:1500});
  assert.equal(replacement.state,'claimed');if(replacement.state!=='claimed')throw Error('replacement failed');
  assert(replacement.lease.token>claim.lease.token);
  const replacementHeartbeat=await startExecutionHeartbeat(replacement.lease,new AbortController(),1500);
  await replacementHeartbeat.stop();
  const before=await client`SELECT heartbeat_at FROM workshop_execution_leases WHERE workshop_id=${workshopId}`;
  await sleep(1800);
  const after=await client`SELECT heartbeat_at FROM workshop_execution_leases WHERE workshop_id=${workshopId}`;
  assert.deepEqual(after,before);
  await assert.rejects(withExecutionWrite(replacement.lease,async()=>undefined),{code:'lease_lost'});
  return {name:'real lease heartbeat: survives original deadline, aborts on expiration, replacement fencing and joined shutdown without renewal',passed:true};
}
