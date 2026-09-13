import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function checkCancelRunProduction({client,owner,request}){
  const work=randomUUID(),run=randomUUID(),foreign=randomUUID(),foreignWork=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${foreign},'cancel-foreign-http@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'cancel http','test'),(${foreignWork},${foreign},'foreign','test')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status) VALUES (${run},${work},'queued')`;
  const path=`/api/workshops/${work}/runs/${run}/cancel`;
  assert.equal((await request(path,{})).status,400);
  const body={commandId:randomUUID(),reason:'owner test cancellation'};
  const response=await request(path,body);assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.status,'cancelled');
  const replay=await request(path,body);assert.equal(replay.status,200);assert.deepEqual(await replay.json(),result);
  assert.equal((await request(path,{...body,reason:'changed'})).status,409);
  assert.equal((await request(`/api/workshops/${foreignWork}/runs/${run}/cancel`,{commandId:randomUUID()})).status,404);
  const rows=await client`SELECT status,completion_json FROM workshop_runs WHERE id=${run}`;
  assert.equal(rows[0].status,'cancelled');assert.equal(rows[0].completion_json.request.source,'owner_cancel');
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${run} AND type='run_cancelled'`)[0].n,1);
  return {queuedCancellation:true,replay:true,changedIntentConflict:true,foreignOwnerDenied:true};
}
