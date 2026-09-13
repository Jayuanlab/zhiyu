import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import type postgres from "postgres";
import {addWorkDirective,startWorkRun,deleteWork} from "@/lib/work-runtime/commands";
import {getWorkCommand} from "@/lib/work-runtime/command-ledger";
import {workCommandChildId} from "@/lib/work-runtime/child-id";

export async function checkRunAcceptance(client: postgres.Sql) {
  const owner=randomUUID(),work=randomUUID(),other=randomUUID(),foreignRun=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'run-acceptance@example.invalid')`;
  for(const id of [work,other]) await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${id},${owner},'queue','isolated')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status) VALUES (${foreignRun},${other},'completed')`;
  const start={userId:owner,workId:work,commandId:randomUUID(),expectedVersion:0};
  const [a,b]=await Promise.all([startWorkRun(start),startWorkRun(start)]);
  assert.deepEqual(a,b);assert.equal(a.run.status,'queued');assert.equal(a.run.startedAt,null);assert(a.run.createdAt instanceof Date);
  assert.equal(a.run.id,workCommandChildId(owner,work,start.commandId,'run'));
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_runs WHERE workshop_id=${work}`)[0].n,1);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${work} AND type='run_started'`)[0].n,0);
  await assert.rejects(startWorkRun({...start,triggerReason:{type:'different'}}),/payload_conflict/);
  await assert.rejects(addWorkDirective({userId:owner,workId:work,commandId:randomUUID(),expectedVersion:1,runId:foreignRun,content:'不得越界',triggerRun:false}),/not_found/);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_directives WHERE workshop_id=${work}`)[0].n,0);
  const directive={userId:owner,workId:work,commandId:randomUUID(),expectedVersion:1,content:'检查资料后给出摘要',triggerReason:{type:'forged',directiveId:foreignRun,content:'forged'}};
  await client.unsafe(`CREATE FUNCTION reject_run_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.phase='succeeded' THEN RAISE EXCEPTION 'injected run acceptance failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_run_audit BEFORE INSERT ON work_command_events FOR EACH ROW EXECUTE FUNCTION reject_run_audit()');
  try {
    await assert.rejects(addWorkDirective(directive));
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_directives WHERE workshop_id=${work}`)[0].n,0);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_runs WHERE workshop_id=${work}`)[0].n,1);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${work} AND type='directive_added'`)[0].n,0);
    assert.equal((await getWorkCommand(owner,directive.commandId))?.status,'queued');
  } finally {await client.unsafe('DROP TRIGGER reject_run_audit ON work_command_events');await client.unsafe('DROP FUNCTION reject_run_audit()');}
  const [c,d]=await Promise.all([addWorkDirective(directive),addWorkDirective(directive)]);assert.deepEqual(c,d);
  assert(c.run);assert.equal(c.run.status,'queued');assert.equal(c.run.startedAt,null);assert.equal(c.runError,null);
  assert.equal(c.run.id,workCommandChildId(owner,work,directive.commandId,'run'));
  assert.equal(c.run.triggerReason?.type,'directive');assert.equal(c.run.triggerReason?.directiveId,c.directive.id);assert.equal(c.run.triggerReason?.content,directive.content);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_directives WHERE workshop_id=${work}`)[0].n,1);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_runs WHERE workshop_id=${work}`)[0].n,2);
  const note=await addWorkDirective({userId:owner,workId:work,commandId:randomUUID(),expectedVersion:2,runId:a.run.id,content:'仅记录方向',triggerRun:false});
  assert.equal(note.run,null);assert.equal(note.directive.runId,a.run.id);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_runs WHERE workshop_id=${work}`)[0].n,2);
  await assert.rejects(deleteWork({userId:owner,workId:work,commandId:randomUUID(),expectedVersion:3}),/target_busy/);
  await assert.rejects(startWorkRun({...start,commandId:randomUUID()}),/version_conflict/);
  await client`UPDATE workshops SET status='archived' WHERE id=${work}`;
  await assert.rejects(startWorkRun({userId:owner,workId:work,commandId:randomUUID(),expectedVersion:3}),/target_busy/);
  return {name:'queued run replay/null start, stable child ID, directive+run+event rollback, cross-Work reference refusal, no-run directive and queued deletion guard',passed:true};
}
