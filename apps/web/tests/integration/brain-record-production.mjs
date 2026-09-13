import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function checkBrainRecordProduction({client,owner,request}){
  const observation={sourceType:'record_fixture',sourceId:randomUUID(),observedAt:new Date().toISOString(),content:'生产原始观测'};
  const first=await request('/api/brain/observations',observation);assert.equal(first.status,200);
  const original=(await first.json()).observation;
  const retry=await request('/api/brain/observations',{...observation,content:'不应覆盖'});assert.equal(retry.status,200);
  const reused=(await retry.json()).observation;assert.equal(reused.id,original.id);assert.equal(reused.content,observation.content);
  const memoryResponse=await request('/api/brain/memories',{content:'快照来源',status:'candidate'});assert.equal(memoryResponse.status,200);
  const memory=(await memoryResponse.json()).memory;
  const snapshot={scope:{type:'global'},snapshotType:'record_fixture',content:{state:'生产状态'},sourceMemoryIds:[memory.id,memory.id.toUpperCase()]};
  const response=await request('/api/brain/snapshots',snapshot);assert.equal(response.status,200);
  const saved=(await response.json()).snapshot;assert.deepEqual(saved.sourceMemoryIds,[memory.id]);assert.equal(saved.content.state,'生产状态');
  for(const sourceMemoryIds of [[randomUUID()],['invalid-id'],[42]]){
    const denied=await request('/api/brain/snapshots',{...snapshot,sourceMemoryIds});
    assert.equal(denied.status,404);assert.equal((await denied.json()).code,'memory_reference_not_found');
  }
  assert.equal((await client`SELECT count(*)::int AS n FROM brain_state_snapshots WHERE user_id=${owner} AND snapshot_type='record_fixture'`)[0].n,1);
  assert.equal((await client`SELECT count(*)::int AS n FROM brain_observations WHERE user_id=${owner} AND source_type='record_fixture'`)[0].n,1);
  return {immutableObservation:true,snapshotReferenceNormalization:true,invalidReferencesRejected:true};
}
