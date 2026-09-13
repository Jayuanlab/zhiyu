import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {updateWorkLoop, updateWorkLoopModelChecker} from '@/lib/work-runtime/commands';
import {deleteLoop} from '@/lib/loops/service';
import {getWorkCommand} from '@/lib/work-runtime/command-ledger';

export async function checkLoopAliases(client: postgres.Sql) {
  const owner=randomUUID(),work=randomUUID(),loop=randomUUID(),standalone=randomUUID(),run=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'loop-aliases@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'aliases','isolated')`;
  await client`INSERT INTO loops(id,user_id,workshop_id,name,goal,verification_config) VALUES (${loop},${owner},${work},'owned','test','{"protected":true,"successCriteria":["保留标准"]}'::jsonb)`;
  await client`INSERT INTO loops(id,user_id,name,goal) VALUES (${standalone},${owner},'standalone','test')`;
  await client`INSERT INTO loop_runs(id,loop_id,status) VALUES (${run},${loop},'blocked')`;
  await client`INSERT INTO loop_approval_requests(loop_id,loop_run_id,user_id,action_name) VALUES (${loop},${run},${owner},'fixture')`;
  assert.equal(await deleteLoop(owner,loop),false);
  assert.equal(await deleteLoop(owner,standalone),true);
  const command={userId:owner,workId:work,loopId:loop,commandId:randomUUID(),expectedVersion:0,modelChecker:{enabled:true}};
  const [a,b]=await Promise.all([updateWorkLoopModelChecker(command),updateWorkLoopModelChecker(command)]);
  assert.deepEqual(a,b);assert.equal(a.loop.verificationConfig.protected,true);assert.deepEqual(a.loop.verificationConfig.successCriteria,['保留标准']);
  const second={...command,commandId:randomUUID(),expectedVersion:1,modelChecker:{enabled:false}};
  await client.unsafe(`CREATE FUNCTION reject_alias_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.phase='succeeded' THEN RAISE EXCEPTION 'injected alias audit failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_alias_audit BEFORE INSERT ON work_command_events FOR EACH ROW EXECUTE FUNCTION reject_alias_audit()');
  try {
    await assert.rejects(updateWorkLoopModelChecker(second));
    assert.equal((await getWorkCommand(owner,second.commandId))?.status,'queued');
    assert.equal((await client`SELECT verification_config FROM loops WHERE id=${loop}`)[0].verification_config.modelChecker.enabled,true);
  } finally {await client.unsafe('DROP TRIGGER reject_alias_audit ON work_command_events');await client.unsafe('DROP FUNCTION reject_alias_audit()');}
  await updateWorkLoopModelChecker(second);
  assert.deepEqual(await updateWorkLoopModelChecker(command),a);
  await assert.rejects(updateWorkLoopModelChecker({...command,commandId:randomUUID()}),/version_conflict/);
  const archive={userId:owner,workId:work,loopId:loop,commandId:randomUUID(),expectedVersion:2,patch:{status:'archived' as const}};
  const archived=await updateWorkLoop(archive);assert.equal(archived.loop.status,'archived');assert.deepEqual(await updateWorkLoop(archive),archived);
  assert.equal((await client`SELECT count(*)::int AS n FROM loop_runs WHERE id=${run}`)[0].n,1);
  assert.equal((await client`SELECT count(*)::int AS n FROM loop_approval_requests WHERE loop_id=${loop}`)[0].n,1);
  assert.equal((await client`SELECT version FROM work_command_targets WHERE workshop_id=${work}`)[0].version,3);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${work} AND type='work_command_applied' AND metadata->>'command'='updateWorkLoop'`)[0].n,3);
  return {name:'loop aliases: protected history, checker intent replay, atomic merge, rollback, stale version and archive',passed:true};
}
