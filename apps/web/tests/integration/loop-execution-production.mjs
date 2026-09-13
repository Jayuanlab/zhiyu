import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function checkLoopExecutionProduction({client,owner,request,queued=false}){
  const work=randomUUID(),loop=randomUUID(),commandId=randomUUID();
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'loop HTTP fixture','observe')`;
  await client`INSERT INTO loops(id,user_id,workshop_id,name,goal,verification_config) VALUES (${loop},${owner},${work},'HTTP loop','observe','{"modelChecker":{"enabled":false}}'::jsonb)`;
  const url=`/api/workshops/${work}/loops/${loop}/execute`,body={mode:'dry_run',commandId};
  const first=await request(url,body);assert.equal(first.status,200);const saved=await first.json();
  assert(saved.loopRunId);assert.equal(saved.result.status,'success');
  const replay=await request(url,body);assert.equal(replay.status,200);assert.deepEqual(await replay.json(),saved);
  assert.equal((await client`SELECT count(*)::int AS n FROM loop_runs WHERE loop_id=${loop}`)[0].n,1);
  const [link]=await client`SELECT x.active,r.status FROM workshop_loop_executions x JOIN workshop_runs r ON r.id=x.run_id WHERE x.loop_id=${loop}`;
  assert.deepEqual(link,{active:false,status:'completed'});
  const [event]=await client`SELECT run_id,loop_run_id FROM workshop_events WHERE workshop_id=${work} AND type='loop_run_completed'`;
  assert.equal(event.run_id,saved.loopRunId);assert.equal(event.loop_run_id,saved.loopRunId);
  assert.equal((await request(url,{...body,commandId:''})).status,400);
  assert.equal((await request(url,{...body,expectedVersion:999,commandId:randomUUID()})).status,409);

  const retryBody={mode:'dry_run',commandId:randomUUID()};
  await client`CREATE FUNCTION reject_http_loop_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='run_completed' THEN RAISE EXCEPTION 'HTTP completion fault'; END IF; RETURN NEW; END $$`;
  await client`CREATE TRIGGER reject_http_loop_finish BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_http_loop_finish()`;
  try{assert.equal((await request(url,retryBody)).status,500);}
  finally{await client`DROP TRIGGER reject_http_loop_finish ON workshop_events`;await client`DROP FUNCTION reject_http_loop_finish()`;}
  const busy=await request(url,{mode:'dry_run',commandId:randomUUID()});assert.equal(busy.status,409);assert.equal((await busy.json()).code,'busy');
  await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE workshop_id=${work}`;
  const recovered=await request(url,retryBody);assert.equal(recovered.status,200);const recoveredBody=await recovered.json();
  const [counts]=await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${work} AND type='loop_run_completed'`;
  assert.equal(counts.n,2);assert.notEqual(recoveredBody.loopRunId,saved.loopRunId);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${work} AND type='loop_run_failed'`)[0].n,0);
  if(queued){
    const command={mode:'native_agent',wait:false,commandId:randomUUID()};
    const response=await request(url,command);assert.equal(response.status,202);const accepted=await response.json();
    assert.equal(accepted.commandId,command.commandId);assert.equal(accepted.status,'queued');assert(accepted.runId);
    assert.deepEqual(await (await request(url,command)).json(),accepted);
    const [pending]=await client`SELECT status,started_at FROM workshop_runs WHERE id=${accepted.runId}`;
    assert.deepEqual(pending,{status:'queued',started_at:null});
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${accepted.runId} AND type='loop_run_started'`)[0].n,0);
    const cancel=await request(`/api/workshops/${work}/runs/${accepted.runId}/cancel`,{commandId:randomUUID()});assert.equal(cancel.status,200);assert.equal((await cancel.json()).status,'cancelled');
    const [linked]=await client`SELECT x.active,r.status FROM workshop_loop_executions x JOIN loop_runs r ON r.id=x.loop_run_id WHERE x.run_id=${accepted.runId}`;
    assert.deepEqual(linked,{active:false,status:'cancelled'});
    assert.equal((await (await request(url,command)).json()).status,'cancelled');
    const other=randomUUID(),foreignWork=randomUUID(),foreignLoop=randomUUID();
    await client`INSERT INTO "User"(id,email) VALUES (${other},'foreign-loop-http@example.invalid')`;
    await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${foreignWork},${other},'foreign fixture','observe')`;
    await client`INSERT INTO loops(id,user_id,workshop_id,name,goal) VALUES (${foreignLoop},${other},${foreignWork},'foreign loop','observe')`;
    assert.equal((await request(`/api/workshops/${foreignWork}/loops/${foreignLoop}/execute`,{mode:'native_agent',commandId:randomUUID()})).status,404);
  }
  return {replay:true,exactRunIdentity:true,busy:true,invalidCommand:true,staleVersion:true,completionRecovery:true,executedDryRunOnly:true,...(queued?{asyncAdmission:true,linkedCancellation:true,foreignQueueDenied:true}:{})};
}
