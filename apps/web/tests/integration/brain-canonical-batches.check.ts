import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import type postgres from 'postgres';
import {prepareCanonicalBatch,readCanonicalBatch,controlCanonicalBatch as controlBatch,applyCanonicalBatchPage as applyPage,rollbackCanonicalBatchPage as rollbackPage} from '@/lib/brain/canonical-backfill-batches';

type Operation=Omit<Parameters<typeof applyPage>[0],'commandId'>&{commandId?:string};
const applyCanonicalBatchPage=(input:Operation)=>applyPage({commandId:randomUUID(),...input});
const rollbackCanonicalBatchPage=(input:Operation)=>rollbackPage({commandId:randomUUID(),...input});
const controlCanonicalBatch=async(input:Omit<Parameters<typeof controlBatch>[0],'commandId'|'expectedVersion'>)=>controlBatch({...input,commandId:randomUUID(),expectedVersion:(await readCanonicalBatch(input.userId,input.batchId)).version});

export async function checkCanonicalBatches(client:postgres.Sql,web:string) {
  const userId=randomUUID(),other=randomUUID(),batchId=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},'canonical-batch@example.invalid'),(${other},'canonical-batch-other@example.invalid')`;
  const ids=Array.from({length:4},()=>randomUUID()).sort();
  for(const id of ids)await client`INSERT INTO brain_memories(id,user_id,scope_type,owner_type,owner_id,memory_type,subject,content,created_at,updated_at) VALUES (${id},${userId},'global','chat',${userId},'boundary','批次边界','禁止真实交易','2020-01-01','2020-01-02')`;
  const before=JSON.stringify(await client`SELECT * FROM brain_memories WHERE user_id=${userId} ORDER BY id`);
  const batch=await prepareCanonicalBatch({userId,batchId});const base={userId,batchId,planHash:batch.planHash};
  assert.equal(JSON.stringify(await client`SELECT * FROM brain_memories WHERE user_id=${userId} ORDER BY id`),before);
  assert.equal((await prepareCanonicalBatch({userId,batchId})).planHash,batch.planHash);
  await assert.rejects(prepareCanonicalBatch({userId,batchId,limit:2}));
  await assert.rejects(readCanonicalBatch(other,batchId));await assert.rejects(applyCanonicalBatchPage(base));
  await assert.rejects(controlCanonicalBatch({...base,planHash:'wrong',action:'approve'}));
  await controlCanonicalBatch({...base,action:'pause'});
  await assert.rejects(controlCanonicalBatch({...base,action:'resume'}));
  await controlCanonicalBatch({...base,action:'approve'});
  await controlCanonicalBatch({...base,action:'approve'});
  assert.equal((await client`SELECT count(*)::int AS n FROM brain_backfill_events WHERE batch_id=${batchId} AND kind='approve'`)[0].n,1);
  await client.unsafe(`CREATE FUNCTION reject_backfill_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='applied' THEN RAISE EXCEPTION 'injected backfill audit failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_backfill_audit BEFORE INSERT ON brain_backfill_events FOR EACH ROW EXECUTE FUNCTION reject_backfill_audit()');
  try {await assert.rejects(applyCanonicalBatchPage({...base,limit:2}),(error:unknown)=>{
    let current:unknown=error;
    while(current instanceof Error){if(current.message.includes('injected backfill audit failure'))return true;current=current.cause;}
    return false;
  });}
  finally {await client.unsafe('DROP TRIGGER reject_backfill_audit ON brain_backfill_events');await client.unsafe('DROP FUNCTION reject_backfill_audit()');}
  assert.equal(JSON.stringify(await client`SELECT * FROM brain_memories WHERE user_id=${userId} ORDER BY id`),before);
  assert.equal((await readCanonicalBatch(userId,batchId)).counts.pending,4);
  assert.equal((await client`SELECT count(*)::int AS n FROM brain_backfill_events WHERE batch_id=${batchId} AND kind='checkpoint'`)[0].n,0);
  const firstInput={...base,limit:1,commandId:randomUUID()};
  await client.unsafe(`CREATE FUNCTION reject_backfill_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='command_completed' THEN RAISE EXCEPTION 'injected receipt failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_backfill_receipt BEFORE INSERT ON brain_backfill_events FOR EACH ROW EXECUTE FUNCTION reject_backfill_receipt()');
  try {await assert.rejects(applyCanonicalBatchPage(firstInput));}
  finally {await client.unsafe('DROP TRIGGER reject_backfill_receipt ON brain_backfill_events');await client.unsafe('DROP FUNCTION reject_backfill_receipt()');}
  assert.equal(JSON.stringify(await client`SELECT * FROM brain_memories WHERE user_id=${userId} ORDER BY id`),before);
  assert.equal((await readCanonicalBatch(userId,batchId)).counts.pending,4);
  assert.equal((await client`SELECT count(*)::int AS n FROM brain_backfill_events WHERE batch_id=${batchId} AND (kind IN ('applied','checkpoint') OR (kind='command_completed' AND detail->>'action' IN ('apply','rollback')))`)[0].n,0);
  const first=await applyCanonicalBatchPage(firstInput);assert.equal(first.processed,1);
  assert.deepEqual(await applyCanonicalBatchPage(firstInput),first);
  assert.equal((await readCanonicalBatch(userId,batchId)).counts.applied,1);
  await assert.rejects(applyCanonicalBatchPage({...firstInput,limit:2}),/identity conflict/);
  await assert.rejects(rollbackCanonicalBatchPage(firstInput),/identity conflict/);
  await assert.rejects(applyPage({...base,commandId:''}),/command ID/);
  await controlCanonicalBatch({...base,action:'pause'});assert.equal((await applyCanonicalBatchPage(base)).processed,0);
  await client`UPDATE brain_memories SET content='用户的新纠错' WHERE id=${ids[2]}`;
  await controlCanonicalBatch({...base,action:'resume'});
  // Apply in a separate OS process after the persisted checkpoint.
  const cli=createRequire(import.meta.url).resolve('tsx/cli');
  const cliArgs=[cli,'scripts/backfill-brain-memory.ts','--canonical-apply',`--batch-id=${batchId}`,`--plan-hash=${batch.planHash}`,`--command-id=${randomUUID()}`,'--limit=1'];
  const cliOptions={cwd:web,encoding:'utf8' as const,windowsHide:true,timeout:30000,env:{...process.env,USER_ID:userId}};
  const pauseArgs=[cli,'scripts/backfill-brain-memory.ts','--canonical-pause',`--batch-id=${batchId}`,`--plan-hash=${batch.planHash}`,`--command-id=${randomUUID()}`,`--expected-version=${(await readCanonicalBatch(userId,batchId)).version}`];
  const cliResult=(args:string[])=>JSON.parse(execFileSync(process.execPath,args,cliOptions).split(/\r?\n/).find(line=>line.startsWith('{'))!);
  assert.equal(cliResult(pauseArgs).status,'paused');
  await controlCanonicalBatch({...base,action:'resume'});
  assert.equal(cliResult(pauseArgs).status,'paused');
  assert.equal((await readCanonicalBatch(userId,batchId)).batch.status,'ready');
  const output=execFileSync(process.execPath,cliArgs,cliOptions);
  assert.equal(JSON.parse(output.split(/\r?\n/).find(line=>line.startsWith('{'))!).processed,1);
  const replay=execFileSync(process.execPath,cliArgs,cliOptions);
  assert.equal(JSON.parse(replay.split(/\r?\n/).find(line=>line.startsWith('{'))!).processed,1);
  assert.equal((await readCanonicalBatch(userId,batchId)).counts.applied,2);
  await Promise.all([applyCanonicalBatchPage({...base,limit:1}),applyCanonicalBatchPage({...base,limit:1})]);
  const view=await readCanonicalBatch(userId,batchId);assert.equal(view.batch.status,'partial');assert.equal(view.counts.applied,3);assert.equal(view.counts.conflict,1);
  assert.equal((await applyCanonicalBatchPage(base)).processed,0);
  const rows=await client`SELECT id,canonical_kind,content,status,created_at,updated_at FROM brain_memories WHERE user_id=${userId} ORDER BY id`;
  assert.equal(rows[2].content,'用户的新纠错');assert.equal(rows[2].canonical_kind,null);
  assert.equal(rows[0].canonical_kind,'boundary');assert.equal(rows[0].status,'candidate');assert.equal(new Date(rows[0].updated_at).toISOString(),'2020-01-02T00:00:00.000Z');
  assert.equal((await client`SELECT count(*)::int AS n FROM brain_backfill_events WHERE batch_id=${batchId} AND kind='applied'`)[0].n,3);
  await client`UPDATE brain_memories SET content='回填后用户继续修改' WHERE id=${ids[1]}`;
  const rollbackInput={...base,limit:1,commandId:randomUUID()};
  const rollbackResults=await Promise.all([rollbackCanonicalBatchPage(rollbackInput),rollbackCanonicalBatchPage(rollbackInput)]);
  assert.deepEqual(rollbackResults[0],rollbackResults[1]);
  assert.equal((await readCanonicalBatch(userId,batchId)).counts.rolled_back,1);
  await rollbackCanonicalBatchPage(base);
  assert.equal((await readCanonicalBatch(userId,batchId)).batch.status,'rollback_partial');
  const restored=await client`SELECT id,canonical_kind,content FROM brain_memories WHERE user_id=${userId} ORDER BY id`;
  assert.equal(restored[0].canonical_kind,null);assert.equal(restored[3].canonical_kind,null);
  assert.equal(restored[1].content,'回填后用户继续修改');assert.equal(restored[1].canonical_kind,'boundary');
  assert.equal((await rollbackCanonicalBatchPage(base)).processed,0);
  const audit=await client`SELECT detail FROM brain_backfill_events WHERE batch_id=${batchId}`;
  assert.ok(audit.every(row=>row.detail.actorId===userId));
  const receipts=await client`SELECT detail FROM brain_backfill_events WHERE batch_id=${batchId} AND kind='command_completed'`;
  assert.equal(new Set(receipts.map(row=>row.detail.commandId)).size,receipts.length);
  assert.deepEqual(await applyCanonicalBatchPage(firstInput),first);
  return {name:'canonical batches: frozen plan, approval, atomic pages and receipts, pause, process continuation, idempotent retries, conflicts, concurrency and guarded rollback',passed:true,applied:3,sourceConflicts:1,rollbackConflicts:1,commandReplay:true,receiptFailureRollback:true};
}
