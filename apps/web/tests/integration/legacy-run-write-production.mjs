import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function checkLegacyRunWriteProduction({client,owner,request}){
  const work=randomUUID(),run=randomUUID(),outbox=randomUUID();
  await client`INSERT INTO workshops(id,user_id,name,mission,boundary_policy) VALUES (${work},${owner},'owner review','test','{"externalMessages":"blocked"}'::jsonb)`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status,completion_json) VALUES (${run},${work},'completed','{"execution":{"workerId":"previous","token":1}}'::jsonb)`;
  await client`INSERT INTO workshop_outbox(id,workshop_id,run_id,message,recipient_name) VALUES (${outbox},${work},${run},'blocked fixture','blocked')`;
  const rejected=await request(`/api/workshops/${work}/outbox`,{runId:run,message:'must not create',auditActorId:owner});
  assert.equal(rejected.status,409);const rejection=await rejected.json();assert.equal(rejection.error,'lease_lost');assert.equal(rejection.code,'lease_lost');
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_outbox WHERE workshop_id=${work}`)[0].n,1);
  const reviewed=await request(`/api/workshops/${work}/outbox/${outbox}/preview`,{auditActorId:randomUUID()});
  assert.equal(reviewed.status,200);assert.equal((await reviewed.json()).ok,false);
  const audit=(await client`SELECT run_id,metadata FROM workshop_events WHERE workshop_id=${work} AND type='outbox_blocked'`)[0];
  assert.equal(audit.run_id,null);assert.equal(audit.metadata.sourceRunId,run);assert.equal(audit.metadata.actorId,owner);
  return {deniedLateDraft:true,ownerReviewAudited:true,externalPreviewBlocked:true};
}
