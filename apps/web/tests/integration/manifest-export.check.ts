import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import YAML from 'yaml';
import {exportWorkshopManifest} from '@/lib/workshops/manifest-export';
import {applyWorkshopManifest,applyWorkshopManifestToExisting,reviewWorkshopManifest} from '@/lib/workshops/manifest';
import {configurationManifest} from './configuration-fixture.mjs';

export async function checkManifestExport(client: postgres.Sql) {
  const owner=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'manifest-export@example.invalid')`;
  const fixture=configurationManifest(`export-${owner}`);
  fixture.manifest.spec.modelConfig.customEditorField={nested:'保留模型配置'};
  const created=await applyWorkshopManifest({userId:owner,manifestYaml:YAML.stringify(fixture.manifest),commandId:randomUUID()});
  const id=created.workshop.id;
  const original=await client`SELECT id,name,goal,trigger_config,context_config,action_policy,verification_config,approval_policy,retry_policy,escalation_policy FROM loops WHERE workshop_id=${id} ORDER BY id`;
  const baseline=await exportWorkshopManifest(owner,id);assert(baseline);assert.equal(baseline.commandVersion,1);
  assert.equal(await exportWorkshopManifest(randomUUID(),id),null);
  const edited=YAML.parse(baseline.manifestYaml);assert.equal(edited.spec.mission,created.workshop.mission);
  assert.deepEqual(edited.spec.control,fixture.manifest.spec.control);
  assert.deepEqual(edited.metadata.labels,fixture.manifest.metadata.labels);
  assert.deepEqual(baseline.warnings,[]);
  assert.deepEqual(edited.spec.modelConfig.customEditorField,{nested:'保留模型配置'});
  assert.deepEqual(edited.spec.loops.map((loop: {name: string})=>loop.name).sort(),['new-target','old-target']);
  edited.metadata.title='只修改标题';
  const command={userId:owner,workshopId:id,manifestYaml:YAML.stringify(edited),expectedVersion:baseline.commandVersion,commandId:randomUUID()};
  const reviewed=await reviewWorkshopManifest({...command,allowExistingWorkshopId:id});
  assert.equal(reviewed.review.ok,true,JSON.stringify(reviewed.review.issues));
  await applyWorkshopManifestToExisting(command);
  assert.deepEqual(await client`SELECT id,name,goal,trigger_config,context_config,action_policy,verification_config,approval_policy,retry_policy,escalation_policy FROM loops WHERE workshop_id=${id} ORDER BY id`,original);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_sources WHERE workshop_id=${id}`)[0].n,2);
  const refreshed=await exportWorkshopManifest(owner,id);assert(refreshed);assert.equal(refreshed.commandVersion,2);
  assert.equal(YAML.parse(refreshed.manifestYaml).metadata.title,'只修改标题');
  assert.equal(YAML.parse(refreshed.manifestYaml).spec.modelConfig.manifestSpec,undefined);
  await assert.rejects(applyWorkshopManifestToExisting({...command,commandId:randomUUID()}),/version_conflict/);
  const legacy=randomUUID();
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${legacy},${owner},'历史车间','历史目标')`;
  const fallback=await exportWorkshopManifest(owner,legacy);assert(fallback);assert.equal(fallback.warnings.length,1);
  assert(fallback.manifestYaml.startsWith('# 历史配置未保存 control'));
  assert.deepEqual(YAML.parse(fallback.manifestYaml).spec.control,{object:'历史车间',objective:'历史目标'});
  let reads=0;
  const outcomes=await Promise.allSettled([
    (async()=>{for(let n=3;n<=12;n++){
      await client.begin(async tx=>{
        await tx`UPDATE workshops SET name=${`paired-${n}`} WHERE id=${id}`;
        await tx`UPDATE loops SET goal=${`paired-${n}`} WHERE workshop_id=${id}`;
        await tx`UPDATE work_command_targets SET version=${n} WHERE workshop_id=${id}`;
      });
      await new Promise(resolve=>setTimeout(resolve,10));
    }})(),
    (async()=>{for(let n=0;n<30;n++){
      const snapshot=await exportWorkshopManifest(owner,id);assert(snapshot);reads++;
      const value=YAML.parse(snapshot.manifestYaml);
      if(snapshot.commandVersion>=3){
        assert.equal(value.metadata.title,`paired-${snapshot.commandVersion}`);
        assert(value.spec.loops.every((loop:{goal:string})=>loop.goal===value.metadata.title));
      } else assert.equal(value.metadata.title,'只修改标题');
    }})(),
  ]);
  for(const result of outcomes)if(result.status==='rejected')throw result.reason;
  return {name:'complete Manifest export: owner scope, stable Loop identities, title-only round trip, stale baseline, legacy warning and concurrent snapshot consistency',passed:true,reads};
}
