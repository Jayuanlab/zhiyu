import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function checkLoopAliasesProduction({client,owner,request}) {
  const work=randomUUID(),loop=randomUUID(),run=randomUUID(),standalone=randomUUID(),stranger=randomUUID(),foreignLoop=randomUUID();
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'alias HTTP','isolated')`;
  await client`INSERT INTO loops(id,user_id,workshop_id,name,goal,verification_config) VALUES (${loop},${owner},${work},'alias','test','{"protected":true,"successCriteria":["original"]}'::jsonb)`;
  await client`INSERT INTO loop_runs(id,loop_id,status) VALUES (${run},${loop},'blocked')`;
  await client`INSERT INTO loop_approval_requests(loop_id,loop_run_id,user_id,action_name) VALUES (${loop},${run},${owner},'fixture')`;
  await client`INSERT INTO "User"(id,email) VALUES (${stranger},'foreign-alias@example.invalid')`;
  await client`INSERT INTO loops(id,user_id,name,goal) VALUES (${foreignLoop},${stranger},'foreign','test'),(${standalone},${owner},'standalone','test')`;
  const checker={modelChecker:{enabled:true},commandId:randomUUID(),expectedVersion:0};
  const first=await request(`/api/loops/${loop}`,checker,'PATCH');assert.equal(first.status,200);
  const original=await first.json();assert.equal(original.loop.verificationConfig.protected,true);
  assert.deepEqual(original.loop.verificationConfig.successCriteria,['original']);
  const next={...checker,modelChecker:{enabled:false},commandId:randomUUID(),expectedVersion:1};
  await client.unsafe(`CREATE FUNCTION reject_alias_http_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.phase='succeeded' THEN RAISE EXCEPTION 'injected HTTP audit failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_alias_http_audit BEFORE INSERT ON work_command_events FOR EACH ROW EXECUTE FUNCTION reject_alias_http_audit()');
  try {
    const failed=await request(`/api/loops/${loop}`,next,'PATCH');assert.equal(failed.status,500);
    const receipt=await request(`/api/workshops/${work}/commands/${next.commandId}`,undefined,'GET');assert.equal(receipt.status,200);assert.equal((await receipt.json()).command.status,'queued');
    assert.equal((await client`SELECT verification_config FROM loops WHERE id=${loop}`)[0].verification_config.modelChecker.enabled,true);
  } finally {await client.unsafe('DROP TRIGGER reject_alias_http_audit ON work_command_events');await client.unsafe('DROP FUNCTION reject_alias_http_audit()');}
  const second=await request(`/api/loops/${loop}`,next,'PATCH');assert.equal(second.status,200);
  const retry=await request(`/api/loops/${loop}`,checker,'PATCH');assert.equal(retry.status,200);assert.deepEqual(await retry.json(),original);
  const stale=await request(`/api/loops/${loop}`,{...checker,commandId:randomUUID()},'PATCH');assert.equal(stale.status,409);assert.equal((await stale.json()).code,'version_conflict');
  const conflict=await request(`/api/loops/${loop}`,{...checker,modelChecker:{enabled:false}},'PATCH');assert.equal(conflict.status,409);assert.equal((await conflict.json()).code,'payload_conflict');
  const archive={commandId:randomUUID(),expectedVersion:2};
  const results=await Promise.all([request(`/api/loops/${loop}`,archive,'DELETE'),request(`/api/loops/${loop}`,archive,'DELETE')]);assert.deepEqual(results.map(r=>r.status),[200,200]);
  const [a,b]=await Promise.all(results.map(r=>r.json()));assert.deepEqual(a,b);assert.equal(a.archived,true);assert.equal(a.loop.status,'archived');
  assert.equal((await client`SELECT count(*)::int AS n FROM loop_runs WHERE id=${run}`)[0].n,1);
  assert.equal((await client`SELECT count(*)::int AS n FROM loop_approval_requests WHERE loop_id=${loop}`)[0].n,1);
  assert.equal((await client`SELECT version FROM work_command_targets WHERE workshop_id=${work}`)[0].version,3);
  const receipt=await request(`/api/workshops/${work}/commands/${archive.commandId}`,undefined,'GET');assert.equal(receipt.status,200);
  assert.equal((await receipt.json()).command.status,'succeeded');
  assert.equal((await request(`/api/loops/${foreignLoop}`,archive,'DELETE')).status,404);
  assert.equal((await request(`/api/loops/${foreignLoop}`,checker,'PATCH')).status,404);
  assert.equal((await client`SELECT count(*)::int AS n FROM loops WHERE id=${foreignLoop}`)[0].n,1);
  const deleted=await request(`/api/loops/${standalone}`,undefined,'DELETE');assert.equal(deleted.status,200);assert.deepEqual(await deleted.json(),{ok:true});
  assert.equal((await client`SELECT count(*)::int AS n FROM loops WHERE id=${standalone}`)[0].n,0);
}
