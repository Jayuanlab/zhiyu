import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {completeWorkshopRun} from '@/lib/workshops/service';
import {claimWorkshopExecution,finishWorkshopExecution,markExecutionEffect} from '@/lib/work-runtime/execution-lease';

export async function checkRunSnapshot(client:postgres.Sql){
  const userId=randomUUID(),otherUser=randomUUID(),memory=randomUUID(),foreignMemory=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},'snapshot@example.invalid'),(${otherUser},'snapshot-other@example.invalid')`;
  await client`INSERT INTO brain_memories(id,user_id,scope_type,owner_type,owner_id,memory_type,subject,content) VALUES (${memory},${userId},'global','chat',${userId},'fact','fixture','事实'),(${foreignMemory},${otherUser},'global','chat',${otherUser},'fact','foreign','private')`;
  async function fixture(status='running'){
    const workshopId=randomUUID(),runId=randomUUID(),directiveId=randomUUID();
    await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workshopId},${userId},'snapshot','test')`;
    await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at,trigger_reason) VALUES (${runId},${workshopId},${status},NULL,'{"source":"fixture"}'::jsonb)`;
    await client`INSERT INTO workshop_directives(id,workshop_id,run_id,content,scope) VALUES (${directiveId},${workshopId},${runId},'direction','current_run')`;
    return {userId,workshopId,runId,status:'completed' as const,outputSummary:'原子收尾',directiveIds:[directiveId],sourceMemoryIds:[memory],metadata:{toolCallCount:2,durationMs:50}};
  }
  const input=await fixture();
  const snapshots=()=>client`SELECT * FROM brain_state_snapshots WHERE scope_id=${input.workshopId}`;
  await assert.rejects(completeWorkshopRun({...input,sourceMemoryIds:[foreignMemory]}),{code:'invalid_lease'});
  await assert.rejects(completeWorkshopRun({...input,sourceMemoryIds:[randomUUID()]}),{code:'invalid_lease'});
  await client.unsafe(`CREATE FUNCTION reject_completion_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.snapshot_type='work_state' THEN RAISE EXCEPTION 'injected snapshot failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_completion_snapshot BEFORE INSERT ON brain_state_snapshots FOR EACH ROW EXECUTE FUNCTION reject_completion_snapshot()');
  try{await assert.rejects(completeWorkshopRun(input));}
  finally{await client.unsafe('DROP TRIGGER reject_completion_snapshot ON brain_state_snapshots');await client.unsafe('DROP FUNCTION reject_completion_snapshot()');}
  assert.equal((await snapshots()).length,0);
  assert.equal((await client`SELECT status FROM workshop_runs WHERE id=${input.runId}`)[0].status,'running');
  assert.equal((await client`SELECT status FROM workshop_directives WHERE id=${input.directiveIds[0]}`)[0].status,'active');
  await client.unsafe(`CREATE FUNCTION reject_snapshot_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='run_completed' THEN RAISE EXCEPTION 'injected completion event failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_snapshot_event BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_snapshot_event()');
  try{await assert.rejects(completeWorkshopRun(input));}
  finally{await client.unsafe('DROP TRIGGER reject_snapshot_event ON workshop_events');await client.unsafe('DROP FUNCTION reject_snapshot_event()');}
  assert.equal((await snapshots()).length,0);
  const results=await Promise.all([completeWorkshopRun(input),completeWorkshopRun({...input,sourceMemoryIds:[memory.toUpperCase(),memory]})]);
  assert.deepEqual(results[0],results[1]);assert(results[0].stateSnapshotId);
  const rows=await snapshots();assert.equal(rows.length,1);assert.equal(rows[0].id,results[0].stateSnapshotId);
  assert.equal(rows[0].content.outputSummary,'原子收尾');assert.equal(rows[0].content.status,'completed');
  assert.equal(rows[0].content.toolCallCount,2);assert.deepEqual(rows[0].source_memory_ids,[memory]);
  assert.deepEqual(rows[0].metadata.triggerReason,{source:'fixture'});assert.equal(rows[0].metadata.actorId,userId);
  assert.equal((await client`SELECT metadata FROM workshop_events WHERE run_id=${input.runId} AND type='run_completed'`)[0].metadata.stateSnapshotId,rows[0].id);
  await assert.rejects(completeWorkshopRun({...input,sourceMemoryIds:[]}),{code:'result_conflict'});
  const controlled=await fixture('queued');
  const claim=await claimWorkshopExecution({...controlled,workerId:'snapshot',leaseMs:30000});if(claim.state!=='claimed')throw Error('not claimed');
  await markExecutionEffect(claim.lease);
  const pending=await finishWorkshopExecution(claim.lease,{status:'failed',error:'unknown effect',sourceMemoryIds:[memory]});
  assert.equal(pending.status,'needs_review');
  assert(pending.stateSnapshotId);
  assert.equal((await client`SELECT content FROM brain_state_snapshots WHERE id=${pending.stateSnapshotId}`)[0].content.status,'needs_review');
  const slow=await fixture('queued'),slowClaim=await claimWorkshopExecution({...slow,workerId:'slow',leaseMs:30000});if(slowClaim.state!=='claimed')throw Error('not claimed');
  await client.unsafe(`CREATE FUNCTION delay_completion_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.1); RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER delay_completion_snapshot BEFORE INSERT ON brain_state_snapshots FOR EACH ROW EXECUTE FUNCTION delay_completion_snapshot()');
  try{
    await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()+interval '1 second' WHERE workshop_id=${slow.workshopId}`;
    await assert.rejects(finishWorkshopExecution(slowClaim.lease,{status:'completed'}),{code:'lease_lost'});
  }finally{await client.unsafe('DROP TRIGGER delay_completion_snapshot ON brain_state_snapshots');await client.unsafe('DROP FUNCTION delay_completion_snapshot()');}
  assert.equal((await client`SELECT count(*)::int AS n FROM brain_state_snapshots WHERE scope_id=${slow.workshopId}`)[0].n,0);
  assert.equal((await client`SELECT status FROM workshop_runs WHERE id=${slow.runId}`)[0].status,'running');
  const conversationWorkId=randomUUID(),conversationRunId=randomUUID();
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${conversationWorkId},${userId},'conversation','test')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status,trigger_reason) VALUES (${conversationRunId},${conversationWorkId},'running',${JSON.stringify({type:'conversation',content:'Temporary question',parentRunId:null,inputFiles:[]})}::jsonb)`;
  await assert.rejects(completeWorkshopRun({userId,workshopId:conversationWorkId,runId:conversationRunId,status:'completed',outputSummary:'Private reply',sourceMemoryIds:[memory]}),{code:'invalid_lease'});
  const conversationResult=await completeWorkshopRun({userId,workshopId:conversationWorkId,runId:conversationRunId,status:'completed',outputSummary:'Private reply'});
  assert.equal(conversationResult.stateSnapshotId,undefined);
  assert.equal((await client`SELECT count(*)::int AS n FROM brain_state_snapshots WHERE scope_id=${conversationWorkId}`)[0].n,0);
  assert.equal((await client`SELECT output_summary FROM workshop_runs WHERE id=${conversationRunId}`)[0].output_summary,'Private reply');
  return {name:'run snapshot atomic with completion/receipt/event; source ownership; concurrent replay one snapshot; effect uncertainty preserved; conversation reply excludes Brain snapshot; snapshot/event fault and expiry rollback',passed:true};
}
