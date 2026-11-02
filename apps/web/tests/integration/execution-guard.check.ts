import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {claimWorkshopExecution} from '@/lib/work-runtime/execution-lease';
import {createExecutionGuard} from '@/lib/work-runtime/execution-guard';
import {createPiProviderFetch} from '../../../../packages/ai/src/agent/runtime/pi-provider-fetch';

export async function checkExecutionGuard(client:postgres.Sql){
  const userId=randomUUID(),workshopId=randomUUID(),runId=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},'execution-guard@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workshopId},${userId},'guard','test')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${runId},${workshopId},'queued',NULL)`;
  const target={userId,workshopId,runId,workerId:'first',leaseMs:30000};
  const first=await claimWorkshopExecution(target);if(first.state!=='claimed')throw Error('not claimed');
  const controller=new AbortController(),guard=createExecutionGuard(first.lease,controller);
  let dispatched=0;
  const invoke=createPiProviderFetch({signal:controller.signal,beforeRequest:guard,onRejected:error=>controller.abort(error),fetch:async()=>{dispatched++;return new Response('fixture');}});
  await invoke('http://127.0.0.1/fixture');assert.equal(dispatched,1);
  await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE workshop_id=${workshopId}`;
  await assert.rejects(invoke('http://127.0.0.1/fixture'));assert.equal(dispatched,1);assert.equal(controller.signal.aborted,true);
  const next=await claimWorkshopExecution({...target,workerId:'replacement'});if(next.state!=='claimed')throw Error('not reclaimed');
  await assert.rejects(guard(),{code:'lease_lost'});
  const replacement=new AbortController();await createExecutionGuard(next.lease,replacement)();assert.equal(replacement.signal.aborted,false);
  const stale=new AbortController();await assert.rejects(createExecutionGuard(first.lease,stale)(),{code:'lease_lost'});assert.equal(stale.signal.aborted,true);
  const missing=new AbortController();await assert.rejects(createExecutionGuard({...next.lease,userId:randomUUID()},missing)(),{code:'not_found'});assert.equal(missing.signal.aborted,true);
  return {name:'Pi physical dispatch with real PostgreSQL fence: valid check, expiration denies before fetch and aborts, stale workers cannot resume, replacement succeeds',passed:true};
}
