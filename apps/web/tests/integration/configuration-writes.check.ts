import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {proposeWorkshopAgentChange} from '@/lib/workshops/agent-change-proposals';
import {resolveWorkAgentChangeProposal,updateWork} from '@/lib/work-runtime';
import {applyWorkshopManifestToExisting} from '@/lib/workshops/manifest';
import {configurationManifest} from './configuration-fixture.mjs';
import {getWorkCommand} from '@/lib/work-runtime/command-ledger';

export async function checkConfigurationWrites(client: postgres.Sql) {
  const owner=randomUUID(),work=randomUUID(),importWork=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'config-writes@example.invalid')`;
  for(const id of [work,importWork])await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${id},${owner},'old','old')`;
  const proposal=await proposeWorkshopAgentChange({userId:owner,workshopId:work,patch:{mission:'审查后的新目标'},reason:'来源应保留'});
  const command={userId:owner,workId:work,proposalEventId:proposal.id,action:'apply' as const,commandId:randomUUID(),expectedVersion:0};
  await client.unsafe(`CREATE FUNCTION reject_configuration_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.phase='succeeded' THEN RAISE EXCEPTION 'injected configuration failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_configuration_audit BEFORE INSERT ON work_command_events FOR EACH ROW EXECUTE FUNCTION reject_configuration_audit()');
  try {
    await assert.rejects(resolveWorkAgentChangeProposal(command));
    assert.equal((await client`SELECT mission FROM workshops WHERE id=${work}`)[0].mission,'old');
    assert.equal((await client`SELECT status FROM workshop_review_items WHERE source_event_id=${proposal.id}`)[0].status,'pending');
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_work_versions WHERE workshop_id=${work}`)[0].n,0);
  } finally {await client.unsafe('DROP TRIGGER reject_configuration_audit ON work_command_events');}
  const [a,b]=await Promise.all([resolveWorkAgentChangeProposal(command),resolveWorkAgentChangeProposal(command)]);assert.deepEqual(a,b);
  const review=(await client`SELECT status,metadata FROM workshop_review_items WHERE source_event_id=${proposal.id}`)[0];assert.equal(review.status,'approved');assert.equal(review.metadata.resolvedFromSourceEventId,proposal.id);assert(review.metadata.resolution);
  await client`INSERT INTO workshop_events(workshop_id,seq,type,title) SELECT ${work}::uuid,1000000+n,'unrelated','noise' FROM generate_series(1,301) n`;
  await client`UPDATE workshop_event_counters SET last_seq=1000301 WHERE workshop_id=${work}`;
  await assert.rejects(resolveWorkAgentChangeProposal({...command,commandId:randomUUID(),expectedVersion:1,action:'recreate'}),/proposal_already_resolved/);
  const stale=await proposeWorkshopAgentChange({userId:owner,workshopId:work,patch:{name:'stale name'},reason:'stale'});
  await updateWork({userId:owner,workId:work,commandId:randomUUID(),expectedVersion:1,patch:{mission:'new baseline'}});
  assert.notEqual((await client`SELECT model_config FROM workshops WHERE id=${work}`)[0].model_config.workVersion,stale.metadata?.workModelVersion);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_work_versions WHERE workshop_id=${work}`)[0].n,2);
  await assert.rejects(resolveWorkAgentChangeProposal({...command,proposalEventId:stale.id,commandId:randomUUID(),expectedVersion:2}),/stale|changed/i);
  const recreated=await resolveWorkAgentChangeProposal({...command,proposalEventId:stale.id,commandId:randomUUID(),expectedVersion:2,action:'recreate'});assert.equal(recreated.status,'recreated');

  const fixture=configurationManifest(`isolated-${importWork}`),loop=randomUUID();
  await client`INSERT INTO loops(id,user_id,workshop_id,name,goal,updated_at) VALUES (${loop},${owner},${importWork},'旧目标','old','2020-01-01')`;
  await client`INSERT INTO loops(user_id,workshop_id,name,goal) SELECT ${owner}::uuid,${importWork}::uuid,'unrelated','noise' FROM generate_series(1,301)`;
  await client`INSERT INTO workshop_sources(workshop_id,type,name,created_at) VALUES (${importWork},'manual','old-source','2020-01-01')`;
  await client`INSERT INTO workshop_sources(workshop_id,type,name) SELECT ${importWork}::uuid,'manual','unrelated' FROM generate_series(1,301)`;
  const apply={userId:owner,workshopId:importWork,manifestYaml:fixture.yaml,commandId:randomUUID(),expectedVersion:0};
  await client.unsafe('CREATE TRIGGER reject_configuration_audit BEFORE INSERT ON work_command_events FOR EACH ROW EXECUTE FUNCTION reject_configuration_audit()');
  try {
    await assert.rejects(applyWorkshopManifestToExisting(apply));
    assert.equal((await client`SELECT name FROM workshops WHERE id=${importWork}`)[0].name,'old');
    assert.equal((await client`SELECT goal FROM loops WHERE id=${loop}`)[0].goal,'old');
    assert.equal((await client`SELECT count(*)::int AS n FROM loops WHERE workshop_id=${importWork}`)[0].n,302);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_sources WHERE workshop_id=${importWork}`)[0].n,302);
    assert((await getWorkCommand(owner,apply.commandId))?.preparedPayload);
  } finally {await client.unsafe('DROP TRIGGER reject_configuration_audit ON work_command_events');await client.unsafe('DROP FUNCTION reject_configuration_audit()');}
  const c=await applyWorkshopManifestToExisting(apply);assert.deepEqual(await applyWorkshopManifestToExisting(apply),c);
  assert.equal(c.updated.loops,1);assert.equal(c.created.loops,1);assert.equal(c.created.sources,1);
  assert.equal((await client`SELECT goal FROM loops WHERE id=${loop}`)[0].goal,'更新后的观察目标');
  assert((await client`SELECT state_json FROM loop_states WHERE loop_id=${loop}`)[0].state_json.nextScheduledRunAt);
  assert.equal((await client`SELECT count(*)::int AS n FROM loops WHERE workshop_id=${importWork}`)[0].n,303);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_sources WHERE workshop_id=${importWork}`)[0].n,303);
  return {name:'agent apply/recreate transactions, old resolution beyond 301 events, stale guard, manifest rollback/replay and old Loop/source matching with schedule update',passed:true};
}
