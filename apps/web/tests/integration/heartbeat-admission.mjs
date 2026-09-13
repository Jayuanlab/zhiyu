import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

export async function checkHeartbeatAdmission({client,databaseUrl,web}){
  const owner=randomUUID(),checks=[];
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'heartbeat-admission@example.invalid')`;
  async function fixture(overrides={}){
    const workId=randomUUID(),scheduledAt=new Date(Date.now()-10000).toISOString();
    await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workId},${owner},'heartbeat fixture','isolated')`;
    await client`INSERT INTO workshop_heartbeats(workshop_id,enabled,next_wakeup_at,scheduler_status) VALUES (${workId},true,${scheduledAt}::timestamptz,'idle')`;
    return {userId:owner,workId,scheduledAt,...overrides};
  }
  function dispatch(input){
    return new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,['--import','tsx','--conditions=react-server',path.join(web,'tests/integration/heartbeat-admission-worker.mjs'),JSON.stringify(input)],{
        cwd:web,windowsHide:true,env:{...process.env,NODE_ENV:'test',ZHIYU_TEST_MODE:'integration',ZHIYU_TEST_DATABASE_URL:databaseUrl,POSTGRES_URL:databaseUrl,DATABASE_URL:databaseUrl,IS_TAURI:'false',TAURI_MODE:'false',ENABLE_LOCAL_SCHEDULER:'false',ENABLE_STARTUP_LISTENERS:'false'},stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='';
      const timeout=setTimeout(()=>{child.kill();},15000);
      child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
      child.once('error',error=>{clearTimeout(timeout);reject(error);});
      child.once('exit',code=>{
        clearTimeout(timeout);
        if(code!==0){reject(Error(`Heartbeat child failed: ${stderr}`));return;}
        try{resolve(JSON.parse(stdout.split(/\r?\n/).find(line=>line.startsWith('{'))));}catch(error){reject(error);}
      });
    });
  }
  const f=await fixture();
  const results=await Promise.all([dispatch(f),dispatch(f)]);
  assert.equal(results.filter(r=>r.state==='accepted'&&!r.replayed).length,1);
  assert.equal(results.filter(r=>r.state==='accepted'&&r.replayed).length,1);
  assert.equal(results[0].runId,results[1].runId);
  const [queued]=await client`SELECT status,started_at FROM workshop_runs WHERE workshop_id=${f.workId}`;
  assert.equal(queued.status,'queued');assert.equal(queued.started_at,null);
  const [cursor]=await client`SELECT next_wakeup_at,scheduler_status FROM workshop_heartbeats WHERE workshop_id=${f.workId}`;
  assert.equal(cursor.next_wakeup_at,null);assert.equal(cursor.scheduler_status,'queued');
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${f.workId} AND type='heartbeat_queued'`)[0].n,1);
  assert.equal((await dispatch(f)).replayed,true);
  checks.push({name:'two processes and later retry yield one queued Run, cursor transition and event',passed:true});
  const paused=await fixture();await client`UPDATE workshops SET status='paused' WHERE id=${paused.workId}`;
  assert.equal((await dispatch(paused)).state,'paused');
  const disabled=await fixture();await client`UPDATE workshop_heartbeats SET enabled=false WHERE workshop_id=${disabled.workId}`;
  assert.equal((await dispatch(disabled)).state,'paused');
  const aborted=await fixture();assert.equal((await dispatch({...aborted,aborted:true})).state,'cancelled');
  const busy=await fixture();await client`INSERT INTO workshop_runs(workshop_id,status) VALUES (${busy.workId},'needs_review')`;
  assert.equal((await dispatch(busy)).state,'busy');
  for(const entry of [paused,disabled,aborted,busy])assert.ok((await client`SELECT next_wakeup_at FROM workshop_heartbeats WHERE workshop_id=${entry.workId}`)[0].next_wakeup_at);
  checks.push({name:'paused, disabled, cancelled and unresolved execution preserve the pending wakeup',passed:true});
  const missed=await fixture();
  missed.scheduledAt=new Date(Date.now()-3600000).toISOString();
  await client`UPDATE workshop_heartbeats SET next_wakeup_at=${missed.scheduledAt}::timestamptz WHERE workshop_id=${missed.workId}`;
  assert.equal((await dispatch(missed)).state,'skipped');assert.equal((await dispatch(missed)).state,'stale');
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${missed.workId} AND type='heartbeat_missed'`)[0].n,1);
  checks.push({name:'missed wakeup is consumed once with an audit event',passed:true});
  const foreign=await fixture();
  await assert.rejects(dispatch({...foreign,userId:randomUUID()}),/Heartbeat child failed/);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_runs WHERE workshop_id=${foreign.workId}`)[0].n,0);
  const rollback=await fixture();
  // Fail the final event INSERT, after Run insertion and cursor advancement.
  // Everything must roll back in the same real database transaction.
  await client.unsafe(`CREATE FUNCTION test_reject_heartbeat_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='heartbeat_queued' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER test_reject_heartbeat_event BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION test_reject_heartbeat_event()`);
  try{
    await assert.rejects(dispatch(rollback),/injected audit failure/);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_runs WHERE workshop_id=${rollback.workId}`)[0].n,0);
    assert.ok((await client`SELECT next_wakeup_at FROM workshop_heartbeats WHERE workshop_id=${rollback.workId}`)[0].next_wakeup_at);
  }finally{
    await client.unsafe('DROP TRIGGER test_reject_heartbeat_event ON workshop_events');
    await client.unsafe('DROP FUNCTION test_reject_heartbeat_event()');
  }
  assert.equal((await dispatch(rollback)).state,'accepted');
  checks.push({name:'owner isolation and audit failure roll back admission; unchanged slot retries successfully',passed:true});
  // Only the projection is under test here; durable Run statuses are explicit fixtures.
  await client`UPDATE workshop_runs SET status='running',updated_at=clock_timestamp() WHERE id=${results[0].runId}`;
  await dispatch({...f,project:true});
  assert.equal((await client`SELECT scheduler_status FROM workshop_heartbeats WHERE workshop_id=${f.workId}`)[0].scheduler_status,'running');
  await client`UPDATE workshop_runs SET status='needs_review',updated_at=clock_timestamp() WHERE id=${results[0].runId}`;
  await dispatch({...f,project:true});
  assert.equal((await client`SELECT scheduler_status FROM workshop_heartbeats WHERE workshop_id=${f.workId}`)[0].scheduler_status,'needs_review');
  await client`UPDATE workshop_heartbeats SET scheduler_status='paused',next_wakeup_at=clock_timestamp()+interval '1 hour',heartbeat_policy='{"maxConsecutiveFailures":1}'::jsonb WHERE workshop_id=${f.workId}`;
  await client`UPDATE workshop_runs SET status='failed',error='fixture failure',updated_at=clock_timestamp() WHERE id=${results[0].runId}`;
  await Promise.all([dispatch({...f,project:true}),dispatch({...f,project:true})]);
  const [projected]=await client`SELECT * FROM workshop_heartbeats WHERE workshop_id=${f.workId}`;
  assert.equal(projected.scheduler_status,'paused');assert.equal(projected.consecutive_failures,1);assert.equal(projected.enabled,false);assert.ok(projected.next_wakeup_at);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${f.workId} AND type='heartbeat_result_applied'`)[0].n,1);
  checks.push({name:'running and unknown projection, concurrent terminal replay, failure policy, user pause and next wakeup preserved',passed:true});
  return {name:'durable Heartbeat admission',passed:true,checks};
}
