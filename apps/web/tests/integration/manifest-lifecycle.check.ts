import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import YAML from 'yaml';
import {configurationManifest} from './configuration-fixture.mjs';
import {applyWorkshopManifest, applyWorkshopManifestToExisting, reviewWorkshopManifest} from '@/lib/workshops/manifest';
import {getWorkCommand} from '@/lib/work-runtime/command-ledger';

export async function checkManifestLifecycle(client: postgres.Sql) {
  const owner=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'manifest-lifecycle@example.invalid')`;
  const fixture=configurationManifest(`manifest-${owner}`);
  const command={userId:owner,manifestYaml:fixture.yaml,commandId:randomUUID(),expectedVersion:0};
  await client.unsafe(`CREATE FUNCTION reject_manifest_creation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.phase='succeeded' THEN RAISE EXCEPTION 'injected manifest creation failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_manifest_creation BEFORE INSERT ON work_command_events FOR EACH ROW EXECUTE FUNCTION reject_manifest_creation()');
  try {
    await assert.rejects(applyWorkshopManifest(command),error => error instanceof Error && error.cause instanceof Error && error.cause.message.includes('injected manifest creation failure'));
    assert.equal((await client`SELECT count(*)::int AS n FROM workshops WHERE user_id=${owner}`)[0].n,0);
    assert.equal((await client`SELECT count(*)::int AS n FROM loops WHERE user_id=${owner}`)[0].n,0);
    assert.equal(await getWorkCommand(owner,command.commandId),null);
    assert.equal((await client`SELECT count(*)::int AS n FROM work_command_events WHERE owner_id=${owner}`)[0].n,0);
  } finally {
    await client.unsafe('DROP TRIGGER reject_manifest_creation ON work_command_events');
    await client.unsafe('DROP FUNCTION reject_manifest_creation()');
  }
  const [a,b]=await Promise.all([applyWorkshopManifest(command),applyWorkshopManifest(command)]);
  assert.deepEqual(a,b);assert.equal(a.created.loops,2);assert.equal(a.created.sources,2);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshops WHERE user_id=${owner}`)[0].n,1);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${a.workshop.id} AND type='workshop_manifest_applied'`)[0].n,1);
  await assert.rejects(applyWorkshopManifest({...command,manifestYaml:fixture.yaml+'\n# different intent'}),/payload_conflict/);
  const old=(await client`SELECT id FROM loops WHERE workshop_id=${a.workshop.id} AND name='旧目标'`)[0].id;
  // Stable identity remains usable even after unrelated records push it beyond page 1.
  await client`INSERT INTO loops(user_id,workshop_id,name,goal) SELECT ${owner}::uuid,${a.workshop.id}::uuid,'unrelated','noise' FROM generate_series(1,301)`;
  fixture.manifest.spec.loops[0].title='改名后的观察任务';
  const update={userId:owner,workshopId:a.workshop.id,manifestYaml:YAML.stringify(fixture.manifest),commandId:randomUUID(),expectedVersion:1};
  const changed=await applyWorkshopManifestToExisting(update);
  assert.equal(changed.updated.loops,2);assert.equal(changed.created.loops,0);
  assert.equal((await client`SELECT name FROM loops WHERE id=${old}`)[0].name,'改名后的观察任务');
  assert.equal((await client`SELECT state_json FROM loop_states WHERE loop_id=${old}`)[0].state_json.manifestLoopName,'old-target');
  assert.equal((await client`SELECT count(*)::int AS n FROM loops WHERE workshop_id=${a.workshop.id}`)[0].n,303);
  const alias=randomUUID();
  await client`INSERT INTO loops(id,user_id,workshop_id,name,goal) VALUES (${alias},${owner},${a.workshop.id},'old-target','do not overwrite')`;
  await assert.rejects(applyWorkshopManifestToExisting({...update,commandId:randomUUID(),expectedVersion:2}),/ambiguous_target/);
  assert.equal((await client`SELECT goal FROM loops WHERE id=${alias}`)[0].goal,'do not overwrite');
  assert.equal((await client`SELECT version FROM work_command_targets WHERE workshop_id=${a.workshop.id}`)[0].version,2);
  const duplicate=structuredClone(fixture.manifest);duplicate.spec.loops[1].name=duplicate.spec.loops[0].name;
  assert.equal((await reviewWorkshopManifest({userId:owner,manifestYaml:YAML.stringify(duplicate),existingWorkshops:[]})).review.ok,false);
  const race=configurationManifest(`race-${owner}`);
  const outcomes=await Promise.allSettled([applyWorkshopManifest({...command,commandId:randomUUID(),manifestYaml:race.yaml}),applyWorkshopManifest({...command,commandId:randomUUID(),manifestYaml:race.yaml})]);
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
  const loser=outcomes.find(result=>result.status==='rejected');
  assert(loser?.status==='rejected');assert.equal(loser.reason.code,'manifest_conflict',JSON.stringify({message:loser.reason.message,cause:loser.reason.cause?.message,causeCode:loser.reason.cause?.code}));
  assert.equal((await client`SELECT count(*)::int AS n FROM workshops WHERE user_id=${owner} AND model_config->>'manifestName'=${race.manifest.metadata.name}`)[0].n,1);
  // A committed creation receipt survives target edits and skips duplicate-name validation.
  assert.deepEqual(await applyWorkshopManifest(command),a);
  return {name:'Manifest creation audit rollback, concurrent replay, namespace race, title rename with stable identity, alias ambiguity and duplicate input rejection',passed:true};
}
