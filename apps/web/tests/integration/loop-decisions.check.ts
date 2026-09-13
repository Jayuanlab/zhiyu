import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import type postgres from "postgres";
import {updateWorkLoopActivation,clearWorkLoopBlocker} from "@/lib/work-runtime/commands";
import {getWorkCommand} from "@/lib/work-runtime/command-ledger";

export async function checkLoopDecisions(client: postgres.Sql) {
  const owner=randomUUID(),work=randomUUID(),loop=randomUUID(),rejected=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'loop-decisions@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'decisions','isolated')`;
  for(const id of [loop,rejected]) {
    await client`INSERT INTO loops(id,user_id,workshop_id,name,goal,status,trigger_config) VALUES (${id},${owner},${work},'proposal','test','paused',${JSON.stringify({type:'cron',expression:'0 9 * * 1-5',timezone:'Asia/Shanghai'})}::jsonb)`;
    await client`INSERT INTO loop_states(loop_id,current_phase,state_json) VALUES (${id},'approval',${JSON.stringify({requiresOwnerActivation:true,ownerActivationStatus:'pending'})}::jsonb)`;
  }
  const activation={userId:owner,workId:work,loopId:loop,action:'activate' as const,commandId:randomUUID(),expectedVersion:0};
  const a=await updateWorkLoopActivation(activation);assert.equal(a.loop.status,'active');assert.deepEqual(await updateWorkLoopActivation(activation),a);
  const state=(await client`SELECT state_json,current_phase FROM loop_states WHERE loop_id=${loop}`)[0];
  assert.equal(state.current_phase,'idle');assert.equal(state.state_json.requiresOwnerActivation,false);assert(state.state_json.nextScheduledRunAt);
  const reject={...activation,loopId:rejected,action:'reject' as const,commandId:randomUUID(),expectedVersion:1,rejectionReason:'范围过大'};
  const r=await updateWorkLoopActivation(reject);assert.equal(r.loop.status,'archived');assert.deepEqual(await updateWorkLoopActivation(reject),r);
  const rs=(await client`SELECT state_json FROM loop_states WHERE loop_id=${rejected}`)[0].state_json;
  assert.equal(rs.ownerRejectionReason,'范围过大');assert.equal(rs.nextScheduledRunAt,undefined);
  await assert.rejects(updateWorkLoopActivation({...reject,commandId:randomUUID(),expectedVersion:0}),/version_conflict/);
  const run=randomUUID();await client`INSERT INTO loop_runs(id,loop_id,status) VALUES (${run},${loop},'blocked')`;
  await client`UPDATE loop_states SET current_phase='blocked',blocked_reason='fixture blocker' WHERE loop_id=${loop}`;
  await client`INSERT INTO workshop_review_items(workshop_id,kind,status,title,created_at,metadata)
    SELECT ${work}::uuid,'service_error','pending','unrelated',now(), '{}'::jsonb FROM generate_series(1,301)`;
  for(let n=0;n<2;n++) await client`INSERT INTO workshop_review_items(workshop_id,kind,status,title,created_at,metadata)
    VALUES (${work},'loop_blocker','pending','old blocker','2020-01-01',${JSON.stringify({loopId:loop,source:'preserve',n})}::jsonb)`;
  const clear={userId:owner,workId:work,loopId:loop,commandId:randomUUID(),expectedVersion:2,patch:{},reason:'已核对'};
  await client.unsafe(`CREATE FUNCTION reject_decision_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.phase='succeeded' THEN RAISE EXCEPTION 'injected decision audit failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_decision_audit BEFORE INSERT ON work_command_events FOR EACH ROW EXECUTE FUNCTION reject_decision_audit()');
  try {
    await assert.rejects(clearWorkLoopBlocker(clear));
    assert.equal((await client`SELECT current_phase FROM loop_states WHERE loop_id=${loop}`)[0].current_phase,'blocked');
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_review_items WHERE workshop_id=${work} AND kind='loop_blocker' AND status='pending'`)[0].n,2);
    assert.equal((await getWorkCommand(owner,clear.commandId))?.status,'queued');
  } finally {await client.unsafe('DROP TRIGGER reject_decision_audit ON work_command_events');await client.unsafe('DROP FUNCTION reject_decision_audit()');}
  const c=await clearWorkLoopBlocker(clear);assert.deepEqual(await clearWorkLoopBlocker(clear),c);
  const reviews=await client`SELECT status,metadata FROM workshop_review_items WHERE workshop_id=${work} AND kind='loop_blocker'`;
  assert(reviews.every(row=>row.status==='dismissed' && row.metadata.source==='preserve' && row.metadata.commandSource==='owner' && row.metadata.reason==='已核对'));
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_review_items WHERE workshop_id=${work} AND status='pending'`)[0].n,301);
  assert.equal((await client`SELECT current_phase FROM loop_states WHERE loop_id=${loop}`)[0].current_phase,'idle');
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${work} AND type='loop_blocker_cleared'`)[0].n,1);
  await client`UPDATE loop_runs SET status='running' WHERE id=${run}`;
  await assert.rejects(clearWorkLoopBlocker({...clear,commandId:randomUUID(),expectedVersion:3}),/target_busy/);
  return {name:'activation/rejection replay; state/schedule/review/event rollback; resolve all old blockers beyond 301 unrelated items; running guard',passed:true};
}
