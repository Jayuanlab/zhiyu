import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {upsertBrainObservation,insertBrainStateSnapshot,insertBrainContextLog,insertBrainMemoryReview} from '@/lib/brain/repository';
import type {BrainContextPack} from '@/lib/brain/context';
import {claimWorkshopExecution} from '@/lib/work-runtime/execution-lease';
import {withExecutionContext} from '@/lib/work-runtime/execution-context';

export async function checkBrainRecordWrites(client:postgres.Sql){
  const userId=randomUUID(),otherUser=randomUUID(),workshopId=randomUUID(),runId=randomUUID(),memoryId=randomUUID(),foreignId=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},'brain-record@example.invalid'),(${otherUser},'brain-record-other@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workshopId},${userId},'brain records','test')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${runId},${workshopId},'queued',NULL)`;
  await client`INSERT INTO brain_memories(id,user_id,scope_type,owner_type,owner_id,memory_type,subject,content) VALUES (${memoryId},${userId},'global','chat',${userId},'fact','fixture','source'),(${foreignId},${otherUser},'global','chat',${otherUser},'fact','private','private')`;
  const observation={userId,sourceType:'fixture',sourceId:'immutable',observedAt:new Date().toISOString(),content:'原始观测不可改写',contentHash:'original'};
  const snapshot={userId,scope:{type:'workshop' as const,workshopId},snapshotType:'fixture',content:{state:'事实'},sourceMemoryIds:[memoryId,memoryId.toUpperCase()]};
  const pack:BrainContextPack={interfaceVersion:'brain-context.v1',selection:{selectedCount:0,deniedCount:0,omittedCount:0,duplicateCanonicalGroupCount:0,selectedCanonicalKinds:{}},items:[],denied:[],omitted:[]};
  const context={requester:{type:'work' as const,userId,id:workshopId},pack,taskIntent:'上下文日志'};
  const review={userId,memoryId,reviewerType:'work' as const,reviewerId:workshopId,decision:'confirmed' as const};
  const claim=await claimWorkshopExecution({userId,workshopId,runId,workerId:'brain-record',leaseMs:30000});if(claim.state!=='claimed')throw Error('not claimed');
  const scoped=<T>(work:()=>Promise<T>)=>withExecutionContext(claim.lease,work);
  const original=await scoped(()=>upsertBrainObservation(observation));
  const reused=await scoped(()=>upsertBrainObservation({...observation,content:'must not overwrite',contentHash:'changed'}));
  assert.equal(reused.id,original.id);assert.equal(reused.content,observation.content);
  const saved=await scoped(()=>insertBrainStateSnapshot(snapshot));assert.deepEqual(saved.sourceMemoryIds,[memoryId]);
  await scoped(()=>insertBrainContextLog(context));await scoped(()=>insertBrainMemoryReview(review));
  const events=await client`SELECT run_id,title,metadata FROM workshop_events WHERE workshop_id=${workshopId} AND type='brain_record_written'`;
  assert.equal(events.length,4);
  assert.deepEqual(events.map(row=>row.metadata.recordType).sort(),['context_log','observation','review','snapshot']);
  for(const event of events){assert.equal(event.run_id,runId);assert.equal(event.title,'Brain 记录写入完成');assert.equal(event.metadata.actorId,userId);assert.equal(event.metadata.execution.token,claim.lease.token);assert(event.metadata.recordId);}
  await assert.rejects(scoped(()=>upsertBrainObservation({...observation,userId:otherUser})),{code:'invalid_lease'});
  await assert.rejects(scoped(()=>insertBrainStateSnapshot({...snapshot,userId:otherUser})),{code:'invalid_lease'});
  await assert.rejects(scoped(()=>insertBrainContextLog({...context,requester:{...context.requester,userId:otherUser}})),{code:'invalid_lease'});
  await assert.rejects(scoped(()=>insertBrainMemoryReview({...review,userId:otherUser})),{code:'invalid_lease'});
  await assert.rejects(insertBrainStateSnapshot({...snapshot,sourceMemoryIds:[foreignId]}),/reference not found/);
  await assert.rejects(insertBrainMemoryReview({...review,memoryId:foreignId}),/not found/);
  const counts=async()=> (await client`SELECT (SELECT count(*)::int FROM brain_observations WHERE user_id=${userId}) AS observations,(SELECT count(*)::int FROM brain_state_snapshots WHERE user_id=${userId}) AS snapshots,(SELECT count(*)::int FROM brain_context_logs WHERE user_id=${userId}) AS contexts,(SELECT count(*)::int FROM brain_memory_reviews WHERE user_id=${userId}) AS reviews`)[0];
  const baseline=await counts();
  const writes:Array<()=>Promise<unknown>>=[()=>upsertBrainObservation({...observation,sourceId:randomUUID()}),()=>insertBrainStateSnapshot(snapshot),()=>insertBrainContextLog(context),()=>insertBrainMemoryReview(review)];
  await client.unsafe(`CREATE FUNCTION reject_brain_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='brain_record_written' THEN RAISE EXCEPTION 'injected record event failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_brain_record BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_brain_record()');
  try{for(const write of writes)await assert.rejects(scoped(write));}
  finally{await client.unsafe('DROP TRIGGER reject_brain_record ON workshop_events');await client.unsafe('DROP FUNCTION reject_brain_record()');}
  assert.deepEqual(await counts(),baseline);
  const counter=(await client`SELECT last_seq FROM workshop_event_counters WHERE workshop_id=${workshopId}`)[0].last_seq;
  await client.unsafe(`CREATE FUNCTION delay_brain_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='brain_record_written' THEN PERFORM pg_sleep(1.1); END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER delay_brain_record BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION delay_brain_record()');
  try{
    await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()+interval '1 second' WHERE workshop_id=${workshopId}`;
    await assert.rejects(scoped(()=>insertBrainContextLog(context)),{code:'lease_lost'});
  }finally{await client.unsafe('DROP TRIGGER delay_brain_record ON workshop_events');await client.unsafe('DROP FUNCTION delay_brain_record()');}
  for(const write of writes)await assert.rejects(scoped(write),{code:'lease_lost'});
  assert.deepEqual(await counts(),baseline);
  assert.equal((await client`SELECT last_seq FROM workshop_event_counters WHERE workshop_id=${workshopId}`)[0].last_seq,counter);
  return {name:'Brain auxiliary writes: immutable observation replay, scoped provenance, source ownership, four event-fault rollbacks, expired context rollback and all stale writes rejected',passed:true};
}
