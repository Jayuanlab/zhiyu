import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import type postgres from 'postgres';
import {cancelWorkRun} from '@/lib/work-runtime/cancel-run';
import {claimWorkshopExecution,withExecutionWrite,markExecutionEffect} from '@/lib/work-runtime/execution-lease';
import {withExecutionContext} from '@/lib/work-runtime/execution-context';
import {startExecutionHeartbeat} from '@/lib/work-runtime/execution-heartbeat';
import {finalizeWorkshopRun} from '@/lib/work-runtime/run-completion';

export async function checkCancelRun(client:postgres.Sql){
  const userId=randomUUID(),other=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},'cancel-owner@example.invalid'),(${other},'cancel-other@example.invalid')`;
  async function fixture(status='queued'){
    const workId=randomUUID(),runId=randomUUID();
    await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workId},${userId},'cancel','test')`;
    await client`INSERT INTO workshop_runs(id,workshop_id,status) VALUES (${runId},${workId},${status})`;
    return {userId,workId,runId,commandId:randomUUID()};
  }
  const queued=await fixture();
  await assert.rejects(cancelWorkRun({...queued,userId:other}),{code:'not_found'});
  const [first,replay]=await Promise.all([cancelWorkRun(queued),cancelWorkRun({...queued,runId:queued.runId.toUpperCase()})]);
  assert.deepEqual(first,replay);assert.equal(first.status,'cancelled');
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE run_id=${queued.runId} AND type='run_cancelled'`)[0].n,1);
  await assert.rejects(cancelWorkRun({...queued,reason:'changed'}),{code:'payload_conflict'});
  assert.equal((await claimWorkshopExecution({userId,workshopId:queued.workId,runId:queued.runId,workerId:'never',leaseMs:1500})).state,'terminal');
  const running=await fixture();
  const claim=await claimWorkshopExecution({userId,workshopId:running.workId,runId:running.runId,workerId:'cancel-worker',leaseMs:3000});
  assert.equal(claim.state,'claimed');if(claim.state!=='claimed')throw Error('claim failed');
  const controller=new AbortController();const heartbeat=await startExecutionHeartbeat(claim.lease,controller,3000);
  try{
    await assert.rejects(withExecutionContext(claim.lease,()=>cancelWorkRun(running)),{code:'invalid_command'});
    assert.equal((await cancelWorkRun(running)).status,'cancelled');
    await assert.rejects(withExecutionWrite(claim.lease,async()=>undefined),{code:'lease_lost'});
    await assert.rejects(finalizeWorkshopRun({userId,workshopId:running.workId,runId:running.runId,lease:claim.lease,status:'completed'}));
    for(let attempt=0;attempt<30&&!controller.signal.aborted;attempt++)await sleep(100);
    assert.equal(controller.signal.aborted,true);
  }finally{await heartbeat.stop();}
  const effect=await fixture();
  const effectClaim=await claimWorkshopExecution({userId,workshopId:effect.workId,runId:effect.runId,workerId:'effect-worker',leaseMs:3000});
  if(effectClaim.state!=='claimed')throw Error('effect claim failed');
  await markExecutionEffect(effectClaim.lease);
  assert.equal((await cancelWorkRun(effect)).status,'needs_review');
  assert.equal((await claimWorkshopExecution({userId,workshopId:effect.workId,runId:effect.runId,workerId:'replacement',leaseMs:3000})).state,'needs_review');
  await assert.rejects(cancelWorkRun(await fixture('running')),{code:'target_busy'});
  const rollback=await fixture();
  await client.unsafe(`CREATE FUNCTION reject_cancel_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='run_cancelled' THEN RAISE EXCEPTION 'cancel event fault'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER reject_cancel_event BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_cancel_event()`);
  await assert.rejects(cancelWorkRun(rollback),(error:unknown)=>error instanceof Error && error.cause instanceof Error && error.cause.message.includes('cancel event fault'));
  assert.equal((await client`SELECT status FROM workshop_runs WHERE id=${rollback.runId}`)[0].status,'queued');
  assert.equal((await client`SELECT count(*)::int AS n FROM brain_state_snapshots WHERE scope_id=${rollback.workId}`)[0].n,0);
  await client.unsafe('DROP TRIGGER reject_cancel_event ON workshop_events');
  assert.equal((await cancelWorkRun(rollback)).status,'cancelled');
  return {name:'owner cancellation: scoped idempotent command, queued/run fencing, heartbeat abort, effect review, legacy refusal and event rollback',passed:true};
}
