import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {insertBrainMemory,upsertBrainMemory,getBrainMemoryById} from '@/lib/brain/repository';
import type {BrainMemory} from '@/lib/brain/types';
import {claimWorkshopExecution} from '@/lib/work-runtime/execution-lease';
import {withExecutionContext} from '@/lib/work-runtime/execution-context';

export async function checkBrainMemoryWrites(client:postgres.Sql){
  const userId=randomUUID(),otherUser=randomUUID(),workshopId=randomUUID(),runId=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},'brain-write@example.invalid'),(${otherUser},'brain-other@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workshopId},${userId},'brain writes','test')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${runId},${workshopId},'queued',NULL)`;
  const memory:BrainMemory={id:randomUUID(),userId,scope:{type:'global'},ownerType:'work',ownerId:workshopId,memoryType:'fact',subject:'fixture',content:'原始记忆',status:'candidate',confidence:80,evidenceRefs:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  await upsertBrainMemory(memory);
  for(const change of [{userId:otherUser},{scope:{type:'workshop' as const,workshopId}},{ownerType:'chat' as const},{ownerId:randomUUID()}]){
    await assert.rejects(upsertBrainMemory({...memory,...change,content:'must not replace'}),{code:'memory_identity_conflict'});
  }
  assert.equal((await getBrainMemoryById({userId,memoryId:memory.id}))?.content,'原始记忆');
  assert.equal((await upsertBrainMemory({...memory,content:'同一归属可更新'})).content,'同一归属可更新');
  const scopedMemory={...memory,id:randomUUID(),scope:{type:'workshop' as const,workshopId}};
  await insertBrainMemory(scopedMemory);
  await assert.rejects(upsertBrainMemory({...scopedMemory,scope:{type:'workshop',workshopId:randomUUID()}}),{code:'memory_identity_conflict'});
  const racedId=randomUUID();
  const raced=await Promise.allSettled([upsertBrainMemory({...memory,id:racedId}),upsertBrainMemory({...memory,id:racedId,userId:otherUser})]);
  assert.equal(raced.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(raced.filter(result=>result.status==='rejected' && result.reason.code==='memory_identity_conflict').length,1);

  const claim=await claimWorkshopExecution({userId,workshopId,runId,workerId:'brain',leaseMs:30000});
  if(claim.state!=='claimed')throw Error('not claimed');
  const scoped=<T>(work:()=>Promise<T>)=>withExecutionContext(claim.lease,work);
  await scoped(()=>upsertBrainMemory({...memory,content:'受控记忆'}));
  const added={...memory,id:randomUUID()};await scoped(()=>insertBrainMemory(added));
  const events=await client`SELECT run_id,title,metadata FROM workshop_events WHERE workshop_id=${workshopId} AND type='brain_memory_written' ORDER BY seq`;
  assert.equal(events.length,2);assert.equal(events[0].title,'记忆写入完成');
  assert.equal(events[0].run_id,runId);assert.equal(events[0].metadata.actorId,userId);
  assert.equal(events[0].metadata.execution.token,claim.lease.token);
  assert.equal(events[0].metadata.memoryId,memory.id);
  await assert.rejects(scoped(()=>upsertBrainMemory({...memory,id:randomUUID(),userId:otherUser})),{code:'invalid_lease'});
  const counter=(await client`SELECT last_seq FROM workshop_event_counters WHERE workshop_id=${workshopId}`)[0].last_seq;
  await client.unsafe(`CREATE FUNCTION reject_brain_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='brain_memory_written' THEN RAISE EXCEPTION 'injected brain event failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_brain_write BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_brain_write()');
  const rejectedId=randomUUID();
  try{
    await assert.rejects(scoped(()=>upsertBrainMemory({...memory,content:'must rollback'})));
    await assert.rejects(scoped(()=>insertBrainMemory({...memory,id:rejectedId})));
  }finally{await client.unsafe('DROP TRIGGER reject_brain_write ON workshop_events');await client.unsafe('DROP FUNCTION reject_brain_write()');}
  assert.equal((await getBrainMemoryById({userId,memoryId:memory.id}))?.content,'受控记忆');
  assert.equal(await getBrainMemoryById({userId,memoryId:rejectedId}),null);
  await client.unsafe(`CREATE FUNCTION delay_brain_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='brain_memory_written' THEN PERFORM pg_sleep(1.1); END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER delay_brain_write BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION delay_brain_write()');
  try{
    await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()+interval '1 second' WHERE workshop_id=${workshopId}`;
    await assert.rejects(scoped(()=>upsertBrainMemory({...memory,content:'expired write'})),{code:'lease_lost'});
  }finally{await client.unsafe('DROP TRIGGER delay_brain_write ON workshop_events');await client.unsafe('DROP FUNCTION delay_brain_write()');}
  assert.equal((await getBrainMemoryById({userId,memoryId:memory.id}))?.content,'受控记忆');
  await assert.rejects(scoped(()=>insertBrainMemory({...memory,id:randomUUID()})),{code:'lease_lost'});
  assert.equal((await client`SELECT last_seq FROM workshop_event_counters WHERE workshop_id=${workshopId}`)[0].last_seq,counter);
  return {name:'brain memory immutable identity/concurrent ownership collision; scoped insert/update audit; foreign user denied; event failure and lease expiry rollback',passed:true};
}
