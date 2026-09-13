import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {createWork, updateWork, restoreWorkVersion} from '@/lib/work-runtime/commands';
import {proposeWorkshopAgentChange} from '@/lib/workshops/agent-change-proposals';
import {resolveWorkAgentChangeProposal} from '@/lib/work-runtime/reviews';

export async function checkConfigurationIdentity(client: postgres.Sql) {
  const owner=randomUUID(), work=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'configuration-identity@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission,model_config) VALUES (${work},${owner},'identity','old','{"manifestName":"current","workVersion":"2050-01-01T00:00:00.000Z"}'::jsonb)`;
  await assert.rejects(createWork({commandId:randomUUID(),input:{userId:owner,name:'forged',mission:'invalid identity',modelConfig:{manifestName:'forged'}}}),/manifest_identity_reserved/);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshops WHERE user_id=${owner}`)[0].n,1);
  const first=await updateWork({userId:owner,workId:work,commandId:randomUUID(),expectedVersion:0,patch:{modelConfig:{model:'replacement',workVersion:'2100-01-01T00:00:00Z'}}});
  assert.equal(first.workshop.modelConfig?.manifestName,'current');
  assert.equal(first.workshop.modelConfig?.workVersion,'2050-01-01T00:00:00.001Z');
  assert(first.workshop.updatedAt.getTime()<Date.parse(String(first.workshop.modelConfig?.workVersion)));
  await assert.rejects(updateWork({userId:owner,workId:work,commandId:randomUUID(),expectedVersion:1,patch:{modelConfig:{manifestName:'other'}}}),/manifest_identity_reserved/);
  const proposal=await proposeWorkshopAgentChange({userId:owner,workshopId:work,patch:{modelConfig:{manifestName:'from-agent'}},reason:'must not rename identity'});
  await assert.rejects(resolveWorkAgentChangeProposal({userId:owner,workId:work,proposalEventId:proposal.id,action:'apply',commandId:randomUUID(),expectedVersion:1}),/manifest_identity_reserved/);
  assert.equal((await client`SELECT status FROM workshop_review_items WHERE source_event_id=${proposal.id}`)[0].status,'pending');
  const version=(await client`SELECT id FROM workshop_work_versions WHERE workshop_id=${work}`)[0].id;
  // A historical snapshot may precede a legitimate Manifest rename.
  await client`UPDATE workshop_work_versions SET snapshot=jsonb_set(snapshot,'{modelConfig,manifestName}','"old-manifest"'::jsonb) WHERE id=${version}`;
  await restoreWorkVersion({userId:owner,workId:work,versionId:version,commandId:randomUUID(),expectedVersion:1});
  const restored=(await client`SELECT model_config FROM workshops WHERE id=${work}`)[0].model_config;
  assert.equal(restored.manifestName,'current');assert.equal(restored.workVersion,'2050-01-01T00:00:00.002Z');
  const last=await updateWork({userId:owner,workId:work,commandId:randomUUID(),expectedVersion:2,patch:{mission:'后续配置'}});
  assert.equal(last.workshop.modelConfig?.workVersion,'2050-01-01T00:00:00.003Z');
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_work_versions WHERE workshop_id=${work}`)[0].n,3);
  assert.equal((await client`SELECT metadata FROM workshop_events WHERE workshop_id=${work} AND type='workshop_work_version_restored'`)[0].metadata.preservedManifestName,'current');
  return {name:'reserved Manifest identity through creation/update/proposal/restore; logical revisions under clock rollback; physical update time preserved',passed:true};
}
