import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function checkWakeupSuggestionProduction({client,owner,request}){
  const {getWorkshop}=await import('../../lib/workshops/service.ts');
  const {scheduleWorkshopWakeupFromSuggestion}=await import('../../lib/workshops/heartbeat.ts');
  const work=randomUUID(),run=randomUUID();
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'wakeup read','test')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status) VALUES (${run},${work},'running')`;
  await client`INSERT INTO workshop_heartbeats(workshop_id,enabled,mode,scheduler_status,scheduler_error,lease_until) VALUES (${work},true,'suggested','running','preserved',clock_timestamp()+interval '1 hour')`;
  const input={workshop:await getWorkshop(owner,work),runId:run,suggestion:{delayMinutes:30,reason:'生产唤醒计划'}};
  const result=await scheduleWorkshopWakeupFromSuggestion(input);
  assert(result);assert.equal(result.schedulerStatus,'running');assert.equal(result.schedulerError,'preserved');
  await client`UPDATE workshop_heartbeats SET enabled=false WHERE workshop_id=${work}`;
  assert.deepEqual(await scheduleWorkshopWakeupFromSuggestion(input),result);
  const next=randomUUID();await client`INSERT INTO workshop_runs(id,workshop_id,status) VALUES (${next},${work},'running')`;
  assert.equal(await scheduleWorkshopWakeupFromSuggestion({...input,runId:next}),null);
  const response=await request(`/api/workshops/${work}`,undefined,'GET');assert.equal(response.status,200);
  const detail=await response.json();assert.equal(detail.heartbeat.enabled,false);
  assert.equal(detail.heartbeat.nextWakeupAt,result.nextWakeupAt.toISOString());
  assert.equal(detail.heartbeat.schedulerStatus,'running');assert.equal(detail.heartbeat.leaseUntil,result.leaseUntil.toISOString());
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${run} AND type='heartbeat_scheduled'`)[0].n,1);
  assert.equal((await client`SELECT metadata FROM workshop_events WHERE run_id=${next} AND type='heartbeat_skipped'`)[0].metadata.reasonCode,'disabled');
  return {stableReceipt:true,ownerDisablePreserved:true,productionHeartbeatRead:true};
}
