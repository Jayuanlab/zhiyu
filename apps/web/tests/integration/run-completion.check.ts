import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {completeWorkshopRun} from '@/lib/workshops/service';
import {claimWorkshopExecution,finishWorkshopExecution,markExecutionEffect} from '@/lib/work-runtime/execution-lease';
import {deleteWork} from '@/lib/work-runtime/commands';

export async function checkRunCompletion(client:postgres.Sql){
  const userId=randomUUID();await client`INSERT INTO "User"(id,email) VALUES (${userId},'completion@example.invalid')`;
  async function fixture(status='running'){
    const workshopId=randomUUID(),runId=randomUUID(),directiveId=randomUUID();
    await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workshopId},${userId},'completion','test')`;
    await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${runId},${workshopId},${status},${status==='queued'?null:new Date().toISOString()})`;
    await client`INSERT INTO workshop_directives(id,workshop_id,run_id,content,scope) VALUES (${directiveId},${workshopId},${runId},'本轮方向','current_run')`;
    return {userId,workshopId,runId,directiveId,directiveIds:[directiveId],status:'completed' as const,outputSummary:'已核对'};
  }
  const input=await fixture(),other=await fixture(),unused=randomUUID(),persistent=randomUUID();
  await client`INSERT INTO workshop_directives(id,workshop_id,content,scope) VALUES (${unused},${input.workshopId},'未处理旧方向','current_run'),(${persistent},${input.workshopId},'长期方向','persistent')`;
  const anotherRun=randomUUID(),anotherDirective=randomUUID(),selectedExtra=randomUUID();
  await client`INSERT INTO workshop_runs(id,workshop_id,status) VALUES (${anotherRun},${input.workshopId},'completed')`;
  await client`INSERT INTO workshop_directives(id,workshop_id,run_id,content,scope) VALUES (${anotherDirective},${input.workshopId},${anotherRun},'另一项运行的方向','current_run'),(${selectedExtra},${input.workshopId},${input.runId},'本轮第二个方向','current_run')`;
  input.directiveIds.push(selectedExtra);input.directiveIds.sort();
  for(const id of [other.directiveId,persistent,anotherDirective])await assert.rejects(completeWorkshopRun({...input,directiveIds:[id]}),{code:'invalid_lease'});
  await assert.rejects(completeWorkshopRun({...input,userId:randomUUID()}),{code:'not_found'});
  await client.unsafe(`CREATE FUNCTION reject_run_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='run_completed' THEN RAISE EXCEPTION 'injected completion failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_run_completion BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_run_completion()');
  try{
    await assert.rejects(completeWorkshopRun(input));
    const row=(await client`SELECT status,completion_json FROM workshop_runs WHERE id=${input.runId}`)[0];assert.equal(row.status,'running');assert.equal(row.completion_json,null);
    assert.equal((await client`SELECT status FROM workshop_directives WHERE id=${input.directiveId}`)[0].status,'active');
  }finally{await client.unsafe('DROP TRIGGER reject_run_completion ON workshop_events');await client.unsafe('DROP FUNCTION reject_run_completion()');}
  const result=await completeWorkshopRun({...input,directiveIds:[...input.directiveIds,input.directiveIds[0].toUpperCase()]});assert.equal(result.status,'completed');assert.deepEqual(result.consumedDirectiveIds,input.directiveIds);
  assert.deepEqual(await completeWorkshopRun(input),result);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${input.runId} AND type='run_completed'`)[0].n,1);
  assert.equal((await client`SELECT status FROM workshop_directives WHERE id=${unused}`)[0].status,'active');
  assert.equal((await client`SELECT status FROM workshop_directives WHERE id=${persistent}`)[0].status,'active');
  assert.equal((await client`SELECT status FROM workshop_directives WHERE id=${anotherDirective}`)[0].status,'active');
  await assert.rejects(completeWorkshopRun({...input,status:'failed'}),{code:'result_conflict'});
  await assert.rejects(completeWorkshopRun({...input,directiveIds:[unused]}),{code:'result_conflict'});
  const failure=await completeWorkshopRun({...other,status:'failed',error:'executor failure'});assert.deepEqual(failure.consumedDirectiveIds,[]);
  assert.equal((await client`SELECT status FROM workshop_directives WHERE id=${other.directiveId}`)[0].status,'active');
  const controlled=await fixture('queued');
  const claimed=await claimWorkshopExecution({...controlled,userId:userId.toUpperCase(),workshopId:controlled.workshopId.toUpperCase(),runId:controlled.runId.toUpperCase(),workerId:'first',leaseMs:30000});if(claimed.state!=='claimed')throw Error('not claimed');
  await assert.rejects(completeWorkshopRun(controlled),{code:'lease_lost'});
  const finished=await finishWorkshopExecution(claimed.lease,{status:'completed',directiveIds:controlled.directiveIds,summary:'leased result'});
  assert.deepEqual(finished.consumedDirectiveIds,controlled.directiveIds);
  const next=randomUUID();await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${next},${controlled.workshopId},'queued',NULL)`;
  const nextClaim=await claimWorkshopExecution({...controlled,runId:next,workerId:'second',leaseMs:30000});assert.equal(nextClaim.state,'claimed');
  assert.deepEqual(await finishWorkshopExecution(claimed.lease,{status:'completed',directiveIds:controlled.directiveIds,summary:'leased result'}),finished);
  assert.equal((await client`SELECT run_id FROM workshop_execution_leases WHERE workshop_id=${controlled.workshopId}`)[0].run_id,next);
  const uncertain=await fixture('queued'),claim=await claimWorkshopExecution({...uncertain,workerId:'effect',leaseMs:30000});if(claim.state!=='claimed')throw Error('not claimed');
  await markExecutionEffect(claim.lease);
  const pending=await finishWorkshopExecution(claim.lease,{status:'failed',error:'unknown effect',directiveIds:uncertain.directiveIds});assert.equal(pending.status,'needs_review');assert.deepEqual(pending.consumedDirectiveIds,[]);
  assert.equal((await client`SELECT status FROM workshop_directives WHERE id=${uncertain.directiveId}`)[0].status,'active');
  await assert.rejects(deleteWork({userId,workId:uncertain.workshopId,commandId:randomUUID(),expectedVersion:0}),{code:'target_busy'});
  return {name:'atomic run finalization: scoped selected inputs, failure preserves directives, rollback/replay, fenced bypass rejection, old receipt recovery and unknown deletion guard',passed:true};
}
