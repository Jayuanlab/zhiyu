import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type postgres from 'postgres';
import {claimWorkshopExecution,renewExecutionLease,markExecutionEffect,finishWorkshopExecution,withExecutionWrite} from '@/lib/work-runtime/execution-lease';

export async function checkExecutionLeases(client:postgres.Sql){
  const userId=randomUUID(),workshopId=randomUUID(),runId=randomUUID(),second=randomUUID();
  const runtimeSnapshot=(runtimeHash:string)=>({
    schemaVersion:'agent-runtime-run-snapshot.v1',
    engine:'pi',
    adapter:'pi-agent-core',
    adapterVersion:'0.85.1',
    selectionSource:'config',
    piProtocol:'openai-responses',
    model:'fixture-model',
    modelTier:'standard',
    modelSource:'user',
    promptHash:'p'.repeat(64),
    allowedToolsHash:'t'.repeat(64),
    policyHash:'c'.repeat(64),
    runtimeHash,
    allowedToolCount:2,
  });
  const recordRuntimeSnapshot=async(work:string,run:string,runtimeHash:string)=>{
    const snapshot=runtimeSnapshot(runtimeHash);
    await client`INSERT INTO workshop_runtime_snapshots(workshop_id,run_id,engine,adapter,model,model_tier,runtime_hash,policy_hash,allowed_tool_count,snapshot_json)
      VALUES (${work},${run},${snapshot.engine},${snapshot.adapter},${snapshot.model},${snapshot.modelTier},${snapshot.runtimeHash},${snapshot.policyHash},${snapshot.allowedToolCount},${JSON.stringify(snapshot)}::jsonb)`;
  };
  await client`INSERT INTO "User"(id,email) VALUES (${userId},'lease@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workshopId},${userId},'lease','isolated')`;
  for(const id of [runId,second])await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${id},${workshopId},'queued',NULL)`;
  const input={userId,workshopId,runId,workerId:'worker-a',leaseMs:30000};
  await assert.rejects(claimWorkshopExecution({...input,userId:randomUUID()}),{code:'not_found'});
  const first=await claimWorkshopExecution(input);assert.equal(first.state,'claimed');if(first.state!=='claimed')throw Error('not claimed');
  await recordRuntimeSnapshot(workshopId,runId,'a'.repeat(64));
  assert.equal(first.lease.token,1);
  const busy=await claimWorkshopExecution({...input,runId:second,workerId:'worker-b'});assert.equal(busy.state,'busy');if(busy.state!=='busy')throw Error('not busy');assert.equal(busy.runtimeSnapshot?.runtimeHash,'a'.repeat(64));
  const renewed=await renewExecutionLease(first.lease,60000);assert(new Date(renewed)>new Date(first.leaseUntil));
  await client`UPDATE workshop_execution_leases SET lease_until=now()-interval '1 second' WHERE workshop_id=${workshopId}`;
  await assert.rejects(withExecutionWrite(first.lease,async()=>{throw Error('must not enter');}),{code:'lease_lost'});
  const recoveryRequired=await claimWorkshopExecution({...input,runId:second});assert.equal(recoveryRequired.state,'recovery_required');if(recoveryRequired.state!=='recovery_required')throw Error('not recovery_required');assert.equal(recoveryRequired.runtimeSnapshot?.runtimeHash,'a'.repeat(64));
  const recovered=await claimWorkshopExecution({...input,workerId:'worker-b'});assert.equal(recovered.state,'claimed');if(recovered.state!=='claimed')throw Error('not recovered');
  assert.equal(recovered.lease.token,2);
  assert.equal(recovered.recoveredFromRuntimeSnapshot?.runtimeHash,'a'.repeat(64));
  const recoveredEvent=(await client`SELECT metadata FROM workshop_events WHERE workshop_id=${workshopId} AND type='execution_recovered' ORDER BY seq DESC LIMIT 1`)[0].metadata;
  assert.equal(recoveredEvent.runtimeSnapshot.runtimeHash,'a'.repeat(64));
  await assert.rejects(renewExecutionLease(first.lease,60000),{code:'lease_lost'});
  await assert.rejects(finishWorkshopExecution(first.lease,{status:'completed'}),{code:'lease_lost'});
  const done=await finishWorkshopExecution(recovered.lease,{status:'completed',summary:'恢复后完成'});
  assert.deepEqual(await finishWorkshopExecution(recovered.lease,{status:'completed',summary:'恢复后完成'}),done);
  await assert.rejects(finishWorkshopExecution(recovered.lease,{status:'completed',summary:'改写结果'}),{code:'result_conflict'});
  const next=await claimWorkshopExecution({...input,runId:second});assert.equal(next.state,'claimed');if(next.state!=='claimed')throw Error('not claimed');
  assert.equal(next.lease.token,3);
  await recordRuntimeSnapshot(workshopId,second,'b'.repeat(64));
  await markExecutionEffect(next.lease);await markExecutionEffect(next.lease);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${workshopId} AND type='execution_effect_intent'`)[0].n,1);
  await client`UPDATE workshop_execution_leases SET lease_until=now()-interval '1 second' WHERE workshop_id=${workshopId}`;
  const quarantined=await claimWorkshopExecution({...input,runId:second,workerId:'worker-c'});assert.equal(quarantined.state,'needs_review');if(quarantined.state!=='needs_review')throw Error('not needs_review');assert.equal(quarantined.runtimeSnapshot?.runtimeHash,'b'.repeat(64));
  const stillReview=await claimWorkshopExecution({...input,runId:second,workerId:'worker-c'});assert.equal(stillReview.state,'needs_review');if(stillReview.state!=='needs_review')throw Error('not needs_review');assert.equal(stillReview.runtimeSnapshot?.runtimeHash,'b'.repeat(64));
  await assert.rejects(withExecutionWrite(next.lease,async()=>null),{code:'lease_lost'});
  assert.equal((await client`SELECT status FROM workshop_runs WHERE id=${second}`)[0].status,'needs_review');
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${workshopId} AND type='execution_needs_review'`)[0].n,1);
  const needsReviewEvent=(await client`SELECT metadata FROM workshop_events WHERE workshop_id=${workshopId} AND type='execution_needs_review' ORDER BY seq DESC LIMIT 1`)[0].metadata;
  assert.equal(needsReviewEvent.runtimeSnapshot.runtimeHash,'b'.repeat(64));

  async function fixture(){
    const work=randomUUID(),id=randomUUID();await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${userId},'before','isolated')`;
    await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${id},${work},'queued',NULL)`;
    return {...input,workshopId:work,runId:id};
  }
  const rollback=await fixture();
  await client.unsafe(`CREATE FUNCTION reject_execution_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='execution_claimed' THEN RAISE EXCEPTION 'injected execution event failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_execution_event BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_execution_event()');
  try{await assert.rejects(claimWorkshopExecution(rollback));assert.equal((await client`SELECT status FROM workshop_runs WHERE id=${rollback.runId}`)[0].status,'queued');assert.equal((await client`SELECT count(*)::int AS n FROM workshop_execution_leases WHERE workshop_id=${rollback.workshopId}`)[0].n,0);}
  finally{await client.unsafe('DROP TRIGGER reject_execution_event ON workshop_events');await client.unsafe('DROP FUNCTION reject_execution_event()');}
  const short=await claimWorkshopExecution({...rollback,leaseMs:1000});if(short.state!=='claimed')throw Error('not claimed');
  let entered=false;
  await assert.rejects(withExecutionWrite(short.lease,async context=>{
    entered=true;
    await context.db.execute(sql`UPDATE workshops SET name='uncommitted' WHERE id=${rollback.workshopId}::uuid`);
    await context.db.execute(sql`SELECT pg_sleep(1.1)`);
  }),{code:'lease_lost'});
  assert.equal(entered,true);
  assert.equal((await client`SELECT name FROM workshops WHERE id=${rollback.workshopId}`)[0].name,'before');
  const auditFixture=await fixture(),auditClaim=await claimWorkshopExecution(auditFixture);if(auditClaim.state!=='claimed')throw Error('not claimed');
  await client.unsafe(`CREATE FUNCTION reject_execution_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type IN ('execution_effect_intent','execution_completed') THEN RAISE EXCEPTION 'injected execution result failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_execution_result BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_execution_result()');
  try{
    await assert.rejects(markExecutionEffect(auditClaim.lease));
    assert.equal((await client`SELECT effect_started FROM workshop_execution_leases WHERE workshop_id=${auditFixture.workshopId}`)[0].effect_started,false);
    await assert.rejects(finishWorkshopExecution(auditClaim.lease,{status:'completed'}));
    assert.equal((await client`SELECT status FROM workshop_runs WHERE id=${auditFixture.runId}`)[0].status,'running');
    assert.equal((await client`SELECT result_json FROM workshop_execution_leases WHERE workshop_id=${auditFixture.workshopId}`)[0].result_json,null);
  }finally{await client.unsafe('DROP TRIGGER reject_execution_result ON workshop_events');await client.unsafe('DROP FUNCTION reject_execution_result()');}
  assert.equal((await finishWorkshopExecution(auditClaim.lease,{status:'completed'})).status,'completed');
  const effectFailure=await fixture(),failureClaim=await claimWorkshopExecution(effectFailure);if(failureClaim.state!=='claimed')throw Error('not claimed');
  await markExecutionEffect(failureClaim.lease);
  const unknown=await finishWorkshopExecution(failureClaim.lease,{status:'failed',error:'response lost'});assert.equal(unknown.status,'needs_review');
  assert.deepEqual(await finishWorkshopExecution(failureClaim.lease,{status:'failed',error:'response lost'}),unknown);
  const paused=await fixture();await client`UPDATE workshops SET status='paused' WHERE id=${paused.workshopId}`;
  assert.equal((await claimWorkshopExecution(paused)).state,'paused');
  const legacy=await fixture();await client`UPDATE workshop_runs SET status='running' WHERE id=${legacy.runId}`;
  assert.equal((await claimWorkshopExecution(legacy)).state,'legacy_busy');
  return {name:'execution leases: owner, exclusive claim, monotonic fencing, heartbeat, expiration rollback, effect quarantine, terminal replay, pause and legacy guard',passed:true};
}
