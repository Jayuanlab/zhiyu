import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import type postgres from "postgres";
import {createWork, deleteWork, updateWork} from "@/lib/work-runtime/commands";
import {getWorkCommand} from "@/lib/work-runtime/command-ledger";
import {listWorkCommandAudit} from "@/lib/work-runtime/command-audit";
import {db} from "@/lib/db/client";
import {sql} from "drizzle-orm";

export async function checkWorkLifecycle(client: postgres.Sql) {
  const owner=randomUUID(), other=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'lifecycle@example.invalid'),(${other},'other-lifecycle@example.invalid')`;
  const input={commandId:randomUUID(),input:{userId:owner,name:"生命周期回测",mission:"isolated lifecycle"}};
  const created=await createWork(input);
  assert.deepEqual(await createWork(input),created);
  assert(created.createdAt instanceof Date);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshops WHERE user_id=${owner}`)[0].n,1);
  // Public cursors are strings, but sorting must still use the numeric sequence.
  await client`UPDATE work_command_events SET seq=CASE WHEN phase='accepted' THEN 999999 ELSE 1000000 END
    WHERE owner_id=${owner} AND command_id=${input.commandId}`;
  assert.deepEqual((await listWorkCommandAudit(owner,input.commandId)).map((r: any)=>r.phase),['accepted','succeeded']);
  await assert.rejects(createWork({...input,input:{...input.input,name:'different'}}),/payload_conflict/);
  await assert.rejects(createWork({...input,commandId:randomUUID(),expectedVersion:2}),/invalid_command/);
  await assert.rejects(deleteWork({userId:other,workId:created.id,commandId:randomUUID()}),/not_found/);
  await assert.rejects(deleteWork({userId:owner,workId:'invalid-id',commandId:randomUUID()}),/invalid_command/);
  const deletion={userId:owner,workId:created.id,commandId:randomUUID(),expectedVersion:1};
  await assert.rejects(deleteWork({...deletion,expectedVersion:0}),/version_conflict/);
  assert.equal(await getWorkCommand(owner,deletion.commandId),null);
  const runId=randomUUID();
  await client`INSERT INTO workshop_runs(id,workshop_id,status) VALUES (${runId},${created.id},'running')`;
  await assert.rejects(deleteWork(deletion),/target_busy/);
  await client`UPDATE workshop_runs SET status='completed' WHERE id=${runId}`;
  // A concurrent Loop run may have acquired its parent FK lock but not committed.
  // Deletion must wait, then re-check active runs, rather than cascade it away.
  const loopId=randomUUID(),loopRunId=randomUUID();
  await client`INSERT INTO loops(id,user_id,workshop_id,name,goal) VALUES (${loopId},${owner},${created.id},'race fixture','test')`;
  let release!:()=>void, inserted!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const ready=new Promise<void>(resolve=>{inserted=resolve;});
  const writer=client.begin(async tx=>{
    await tx`INSERT INTO loop_runs(id,loop_id,status) VALUES (${loopRunId},${loopId},'running')`;
    inserted();await held;
  });
  writer.catch(()=>{});
  await ready;
  const racingDelete=deleteWork(deletion).then(()=>"deleted",error=>error.code);
  try {
    let waiting=false;
    for(let attempt=0;attempt<80;attempt++) {
      const rows=await db.execute(sql`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
        AND query LIKE '%SELECT id FROM loops WHERE workshop_id%'`);
      if(rows.length){waiting=true;break;}
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert(waiting,'delete must wait for the uncommitted Loop parent lock');
  } finally {release();await writer;}
  assert.equal(await racingDelete,'target_busy');
  await client`UPDATE loop_runs SET status='completed' WHERE id=${loopRunId}`;
  // The final audit insert fails AFTER the target was deleted: all cascades roll back.
  await client.unsafe(`CREATE FUNCTION reject_lifecycle_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.phase='succeeded' THEN RAISE EXCEPTION 'injected final audit failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER reject_lifecycle_audit BEFORE INSERT ON work_command_events FOR EACH ROW EXECUTE FUNCTION reject_lifecycle_audit()`);
  const failedCreation={...input,commandId:randomUUID()};
  try {
    await assert.rejects(deleteWork(deletion));
    await assert.rejects(createWork(failedCreation));
    assert.equal(await getWorkCommand(owner,deletion.commandId),null);
    assert.equal(await getWorkCommand(owner,failedCreation.commandId),null);
    assert.equal((await listWorkCommandAudit(owner,deletion.commandId)).length,0);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshops WHERE user_id=${owner}`)[0].n,1);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_runs WHERE id=${runId}`)[0].n,1);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_work_versions WHERE workshop_id=${created.id}`)[0].n,1);
  } finally {
    await client.unsafe('DROP TRIGGER reject_lifecycle_audit ON work_command_events');
    await client.unsafe('DROP FUNCTION reject_lifecycle_audit()');
  }
  const deleted=await deleteWork(deletion);
  assert.deepEqual(await deleteWork(deletion),deleted);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshops WHERE id=${created.id}`)[0].n,0);
  assert.deepEqual(await createWork(input),created); // Replaying creation never resurrects a deleted target.
  assert.equal((await client`SELECT count(*)::int AS n FROM workshops WHERE id=${created.id}`)[0].n,0);
  assert.equal((await getWorkCommand(owner,deletion.commandId))?.status,'succeeded');
  const events=await listWorkCommandAudit(owner,deletion.commandId);
  assert.deepEqual(events.map((r:any)=>r.phase),['accepted','succeeded']);
  assert.equal(events[1].metadata.targetDeleted,true);
  assert.equal((await listWorkCommandAudit(other,deletion.commandId)).length,0);
  await assert.rejects(updateWork({userId:owner,workId:created.id,commandId:randomUUID(),patch:{name:'no resurrection'}}),/not_found/);
  return {name:'create/delete atomic receipt and surviving audit; rollback cascades, busy/version/owner rejection, no resurrection',passed:true};
}
