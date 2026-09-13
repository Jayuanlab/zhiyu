import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function checkBrainBackfillHttp({client,owner,origin}){
  const endpoint=origin+'/api/brain/backfill';
  const call=async(body)=>{
    const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',origin},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
    return {status:response.status,body:await response.json()};
  };
  const read=async(id)=>{
    const response=await fetch(endpoint+(id?`?batchId=${id}`:''),{signal:AbortSignal.timeout(60000)});
    return {status:response.status,body:await response.json()};
  };
  const control=async(body)=>call({...body,commandId:randomUUID(),expectedVersion:(await read(body.batchId)).body.version});
  const other=randomUUID(),foreignBatch=randomUUID(),batchId=randomUUID();
  const missingOrigin=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'prepare',batchId}),signal:AbortSignal.timeout(60000)});
  assert.equal(missingOrigin.status,403);
  await client`INSERT INTO "User"(id,email) VALUES (${other},'backfill-http-other@example.invalid')`;
  await client`INSERT INTO brain_backfill_batches(id,user_id,mapping_version,request_hash,plan_hash) VALUES (${foreignBatch},${other},'canonical-columns-v1','foreign','foreign')`;
  for(let n=0;n<3;n++)await client`INSERT INTO brain_memories(id,user_id,scope_type,owner_type,owner_id,memory_type,subject,content) VALUES (${randomUUID()},${owner},'global','chat',${owner},'boundary','HTTP fixture','Keep original boundary')`;
  const before=JSON.stringify(await client`SELECT * FROM brain_memories WHERE user_id=${owner} ORDER BY id`);
  assert.equal((await call({action:'prepare',batchId,userId:other})).status,400);
  assert.equal((await call({action:'prepare',batchId,limit:501})).status,400);
  assert.equal((await read('invalid')).status,400);
  assert.equal((await read(foreignBatch)).status,404);
  assert.equal((await call({action:'prepare',batchId:foreignBatch})).status,404);
  for(const action of ['approve','pause','resume','apply','rollback']){
    assert.equal((await call({action,batchId:foreignBatch,planHash:'0'.repeat(64),commandId:randomUUID(),...(['apply','rollback'].includes(action)?{}:{expectedVersion:'0'})})).status,404);
  }
  const prepared=await call({action:'prepare',batchId});assert.equal(prepared.status,200,JSON.stringify(prepared.body));
  const planHash=prepared.body.planHash,base={batchId,planHash};
  assert.equal(JSON.stringify(await client`SELECT * FROM brain_memories WHERE user_id=${owner} ORDER BY id`),before);
  assert.equal((await read(batchId)).body.counts.pending,3);
  assert.equal((await call({...base,action:'apply',commandId:randomUUID()})).status,409);
  assert.equal((await control({...base,action:'approve',planHash:'0'.repeat(64)})).status,409);
  assert.equal((await control({...base,action:'approve'})).status,200);
  const pause={...base,action:'pause',commandId:randomUUID(),expectedVersion:(await read(batchId)).body.version};
  const pauseResult=await call(pause);assert.equal(pauseResult.status,200);
  assert.deepEqual(await call(pause),pauseResult);
  const stale=await call({...pause,commandId:randomUUID()});assert.equal(stale.status,409);assert.equal(stale.body.code,'version_conflict');
  const conflict=await call({...pause,expectedVersion:(await read(batchId)).body.version});assert.equal(conflict.status,409);assert.equal(conflict.body.code,'command_conflict');
  assert.equal((await control({...base,action:'resume'})).status,200);
  assert.deepEqual(await call(pause),pauseResult);
  assert.equal((await read(batchId)).body.batch.status,'ready');
  const concurrent={...base,action:'pause',expectedVersion:(await read(batchId)).body.version};
  const competing=await Promise.all([call({...concurrent,commandId:randomUUID()}),call({...concurrent,commandId:randomUUID()})]);
  assert.deepEqual(competing.map(result=>result.status).sort(),[200,409]);
  assert.equal((await control({...base,action:'resume'})).status,200);
  const operation={...base,action:'apply',commandId:randomUUID(),limit:1};
  await client.unsafe(`CREATE FUNCTION reject_http_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='command_completed' THEN RAISE EXCEPTION 'private-database-detail'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_http_receipt BEFORE INSERT ON brain_backfill_events FOR EACH ROW EXECUTE FUNCTION reject_http_receipt()');
  try {
    const failed=await call(operation);assert.equal(failed.status,503);assert.equal(failed.body.code,'backfill_unavailable');
    assert.ok(!JSON.stringify(failed.body).includes('private-database-detail'));
    assert.equal((await read(batchId)).body.counts.pending,3);
  } finally {await client.unsafe('DROP TRIGGER reject_http_receipt ON brain_backfill_events');await client.unsafe('DROP FUNCTION reject_http_receipt()');}
  const first=await call(operation);assert.equal(first.status,200);assert.equal(first.body.processed,1);
  assert.deepEqual(await call(operation),first);
  assert.equal((await read(batchId)).body.counts.applied,1);
  assert.equal((await call({...operation,limit:2})).status,409);
  assert.equal((await control({...base,action:'pause'})).status,200);
  assert.equal((await call({...operation,commandId:randomUUID()})).body.processed,0);
  assert.equal((await control({...base,action:'resume'})).status,200);
  assert.equal((await call({...operation,commandId:randomUUID(),limit:100})).body.status,'completed');
  const rollback={...base,action:'rollback',commandId:randomUUID(),limit:100};
  assert.equal((await call(rollback)).body.status,'rolled_back');
  assert.equal((await call(rollback)).body.processed,3);
  assert.equal(JSON.stringify(await client`SELECT * FROM brain_memories WHERE user_id=${owner} ORDER BY id`),before);
  const list=await read();assert.equal(list.status,200);assert.equal(list.body.truncated,false);
  assert.ok(list.body.batches.every(batch=>batch.userId===owner));
  assert.ok(list.body.batches.some(batch=>batch.id===batchId));
  return {missingOriginDenied:true,ownerScopedReads:true,prepareDoesNotModifyMemory:true,approvalRequired:true,planConflict:true,commandReplay:true,pauseResume:true,rollbackRestoresOriginalRows:true,foreignBatch404:true,allForeignMutations404:true,sanitizedFailureAndRetry:true,strictInput:true,controlReplayDoesNotOverwriteNewState:true,staleControlRejected:true,concurrentControlVersionChecked:true};
}
