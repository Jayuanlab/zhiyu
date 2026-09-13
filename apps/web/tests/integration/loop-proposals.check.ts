import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import type postgres from "postgres";
import {proposeWorkshopLoopFromNaturalLanguage} from "@/lib/workshops/loop-service";
import {getWorkCommand} from "@/lib/work-runtime/command-ledger";
import {workCommandChildId} from "@/lib/work-runtime/child-id";

export async function checkLoopProposals(client: postgres.Sql) {
  const owner=randomUUID(),work=randomUUID(),other=randomUUID(),run=randomUUID(),foreign=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'proposals@example.invalid')`;
  for(const id of [work,other])await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${id},${owner},'proposals','isolated')`;
  await client`INSERT INTO workshop_runs(id,workshop_id) VALUES (${run},${work}),(${foreign},${other})`;
  const input={userId:owner,workshopId:work,runId:run,intent:'每个交易日早上9点检查自选股风险并生成报告',proposalReason:'持续观察',expectedVersion:0};
  const commandId=workCommandChildId(owner,work,run,`loop-proposal:${input.intent}`);
  await client.unsafe(`CREATE FUNCTION reject_proposal_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.phase='succeeded' THEN RAISE EXCEPTION 'injected proposal failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_proposal_audit BEFORE INSERT ON work_command_events FOR EACH ROW EXECUTE FUNCTION reject_proposal_audit()');
  try {
    await assert.rejects(proposeWorkshopLoopFromNaturalLanguage(input));
    assert.equal((await client`SELECT count(*)::int AS n FROM loops WHERE workshop_id=${work}`)[0].n,0);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${work} AND type='loop_proposed'`)[0].n,0);
    assert((await getWorkCommand(owner,commandId))?.preparedPayload);
  } finally {await client.unsafe('DROP TRIGGER reject_proposal_audit ON work_command_events');await client.unsafe('DROP FUNCTION reject_proposal_audit()');}
  const [a,b]=await Promise.all([proposeWorkshopLoopFromNaturalLanguage(input),proposeWorkshopLoopFromNaturalLanguage(input)]);assert.deepEqual(a,b);
  assert.equal(a.loop.status,'paused');assert.equal(a.draft.extracted.externalWriteMode,'manual_approval');
  const state=(await client`SELECT state_json,current_phase FROM loop_states WHERE loop_id=${a.loop.id}`)[0];
  assert.equal(state.current_phase,'approval');assert.equal(state.state_json.requiresOwnerActivation,true);assert.equal(state.state_json.proposedFromRunId,run);
  assert.equal((await client`SELECT count(*)::int AS n FROM loops WHERE workshop_id=${work}`)[0].n,1);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${work} AND type='loop_proposed'`)[0].n,1);
  await assert.rejects(proposeWorkshopLoopFromNaturalLanguage({...input,proposalReason:'不同原因'}),/payload_conflict/);
  await assert.rejects(proposeWorkshopLoopFromNaturalLanguage({...input,runId:foreign,expectedVersion:1}),/not_found/);
  await assert.rejects(proposeWorkshopLoopFromNaturalLanguage({...input,runId:null,expectedVersion:1}),/invalid_command/);
  const loopRun=randomUUID();await client`INSERT INTO loop_runs(id,loop_id,status) VALUES (${loopRun},${a.loop.id},'running')`;
  const fromLoop=await proposeWorkshopLoopFromNaturalLanguage({...input,runId:null,loopRunId:loopRun,expectedVersion:1});
  const source=(await client`SELECT state_json FROM loop_states WHERE loop_id=${fromLoop.loop.id}`)[0].state_json;
  assert.equal(source.proposedFromLoopRunId,loopRun);
  assert.equal((await client`SELECT loop_run_id FROM workshop_events WHERE loop_id=${fromLoop.loop.id} AND type='loop_proposed'`)[0].loop_run_id,loopRun);
  assert.deepEqual(await proposeWorkshopLoopFromNaturalLanguage({...input,runId:null,loopRunId:loopRun,expectedVersion:1}),fromLoop);
  return {name:'proposal draft rollback/replay, stable source command, paused/manual approval boundary, cross-Work refusal and LoopRun provenance',passed:true,environment:process.env.NODE_ENV};
}
