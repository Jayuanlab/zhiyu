import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import type postgres from "postgres";
import {createWorkLoop, ensureWorkSelfAuditLoop} from "@/lib/work-runtime/commands";
import {getWorkCommand} from "@/lib/work-runtime/command-ledger";
import {runPreparedDatabaseWorkCommand} from "@/lib/work-runtime/database-command";

export async function checkLoopCreation(client: postgres.Sql) {
  const owner=randomUUID(), work=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'loop-creation@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'creation','isolated')`;
  const command={userId:owner,workId:work,commandId:randomUUID(),expectedVersion:0,type:'template' as const,templateId:'work-self-audit' as const};
  const [a,b]=await Promise.all([createWorkLoop(command),createWorkLoop(command)]);
  assert.deepEqual(a,b);assert('loop' in a);
  assert.equal((await client`SELECT count(*)::int AS n FROM loops WHERE workshop_id=${work}`)[0].n,1);
  await assert.rejects(createWorkLoop({...command,templateInput:{timezone:'UTC'}}),/payload_conflict/);
  await client`UPDATE loops SET updated_at='2020-01-01' WHERE id=${a.loop.id}`;
  await client`INSERT INTO loops(user_id,workshop_id,name,goal) SELECT ${owner}::uuid,${work}::uuid,'other','unrelated' FROM generate_series(1,301)`;
  const ensured=await ensureWorkSelfAuditLoop({userId:owner,workId:work,commandId:randomUUID(),expectedVersion:1});
  assert.equal(ensured.created,false);assert.equal(ensured.loop.id,a.loop.id);

  const nl={userId:owner,workId:work,commandId:randomUUID(),expectedVersion:2,intent:'每个交易日早上9点检查自选股风险并生成报告',create:true};
  await client.unsafe(`CREATE FUNCTION reject_creation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.phase='succeeded' THEN RAISE EXCEPTION 'injected creation audit failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_creation_audit BEFORE INSERT ON work_command_events FOR EACH ROW EXECUTE FUNCTION reject_creation_audit()');
  try {
    await assert.rejects(createWorkLoop(nl));
    assert.equal((await client`SELECT count(*)::int AS n FROM loops WHERE workshop_id=${work}`)[0].n,302);
    const pending=await getWorkCommand(owner,nl.commandId);assert.equal(pending?.status,'queued');assert(pending?.preparedPayload);assert(pending?.preparedAt);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${work} AND type='loop_created'`)[0].n,1);
  } finally {await client.unsafe('DROP TRIGGER reject_creation_audit ON work_command_events');await client.unsafe('DROP FUNCTION reject_creation_audit()');}
  const before=(await getWorkCommand(owner,nl.commandId))!.preparedPayload;
  const n=await createWorkLoop(nl);assert('loop' in n);assert.deepEqual(await createWorkLoop(nl),n);
  assert.deepEqual((await getWorkCommand(owner,nl.commandId))!.preparedPayload,before);
  assert.equal(n.draft?.planner.parser,'local_rules');
  assert.equal((await client`SELECT count(*)::int AS n FROM loops WHERE workshop_id=${work}`)[0].n,303);
  await assert.rejects(createWorkLoop({...nl,commandId:randomUUID()}),/version_conflict/);

  const preparation={userId:owner,workId:work,commandId:randomUUID(),expectedVersion:3};
  let attempts=0;
  const prepare=async()=>{
    attempts++;
    // No Work row lock may be held while planning.
    await client.begin(async tx=>{await tx`SELECT id FROM workshops WHERE id=${work} FOR UPDATE NOWAIT`;});
    if(attempts===1)throw new Error('planner unavailable');
    return {draft:'保留这个草稿'};
  };
  const apply=async(_command:unknown,draft:{draft:string})=>draft;
  await assert.rejects(runPreparedDatabaseWorkCommand(preparation,'prepared-fixture',prepare,apply),/planner unavailable/);
  assert.equal((await getWorkCommand(owner,preparation.commandId))?.preparationError,'preparation_failed');
  const prepared=await runPreparedDatabaseWorkCommand(preparation,'prepared-fixture',prepare,apply);
  assert.equal(prepared.draft,'保留这个草稿');
  assert.deepEqual(await runPreparedDatabaseWorkCommand(preparation,'prepared-fixture',async()=>{throw Error('must not replan');},apply),prepared);
  assert.equal((await getWorkCommand(owner,preparation.commandId))?.preparationError,null);
  const race={userId:owner,workId:work,commandId:randomUUID(),expectedVersion:4};
  let release!:()=>void, reached=0, applied=0;
  const barrier=new Promise<void>(resolve=>{release=resolve;});
  const racingPrepare=async()=>{const choice=++reached;if(reached===2)release();await barrier;return {draft:`candidate-${choice}`};};
  const racingApply=async(_command:unknown,draft:{draft:string})=>{applied++;return draft;};
  const raced=await Promise.all([runPreparedDatabaseWorkCommand(race,'prepared-race',racingPrepare,racingApply),runPreparedDatabaseWorkCommand(race,'prepared-race',racingPrepare,racingApply)]);
  assert.deepEqual(raced[0],raced[1]);assert.equal(applied,1);assert.equal(reached,2);
  const stale={userId:owner,workId:work,commandId:randomUUID(),expectedVersion:5};
  await assert.rejects(runPreparedDatabaseWorkCommand(stale,'prepared-stale',async()=>{
    await ensureWorkSelfAuditLoop({userId:owner,workId:work,commandId:randomUUID(),expectedVersion:5});
    return {draft:'stale plan'};
  },async()=>{throw Error('stale plan must not apply');}),/version_conflict/);
  assert.equal((await getWorkCommand(owner,stale.commandId))?.status,'failed');
  assert((await getWorkCommand(owner,stale.commandId))?.preparedAt);
  return {name:'template replay, self-audit beyond 301 loops, durable NLP draft/rollback, no replan, planner errors/no lock, competing draft winner and stale plan rejection',passed:true};
}
