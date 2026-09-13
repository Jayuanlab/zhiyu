import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function checkRunSnapshotProduction({client,owner,request}){
  const {completeWorkshopRun}=await import('../../lib/workshops/service.ts');
  const work=randomUUID(),run=randomUUID();
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'snapshot read','test')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status) VALUES (${run},${work},'running')`;
  const input={userId:owner,workshopId:work,runId:run,status:'completed',outputSummary:'生产读取收尾快照'};
  const result=await completeWorkshopRun(input);
  assert.deepEqual(await completeWorkshopRun(input),result);
  const response=await request('/api/brain/snapshots?snapshotTypes=work_state',undefined,'GET');
  assert.equal(response.status,200);
  const matching=(await response.json()).snapshots.filter(row=>row.id===result.stateSnapshotId);
  assert.equal(matching.length,1);assert.equal(matching[0].content.runId,run);
  assert.equal(matching[0].content.outputSummary,input.outputSummary);assert.equal(matching[0].content.status,'completed');
  assert.equal(matching[0].scope.workshopId,work);
  return {hostCompletionReplay:true,productionSnapshotRead:true};
}
