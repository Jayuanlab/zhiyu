import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {upsertBrainMemory,getBrainMemoryById} from '@/lib/brain/repository';
import {reviewBrainMemory} from '@/lib/brain/service';
import type {BrainMemory} from '@/lib/brain/types';
import {claimWorkshopExecution} from '@/lib/work-runtime/execution-lease';
import {withExecutionContext} from '@/lib/work-runtime/execution-context';

export async function checkBrainMemoryReview(client:postgres.Sql){
  const userId=randomUUID(),workshopId=randomUUID(),runId=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},'brain-review@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workshopId},${userId},'brain review','test')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${runId},${workshopId},'queued',NULL)`;
  const memory:BrainMemory={id:randomUUID(),userId,scope:{type:'global'},ownerType:'work',ownerId:workshopId,memoryType:'fact',subject:'review',content:'审核不能覆盖正文',status:'candidate',confidence:80,evidenceRefs:['fixture'],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  await upsertBrainMemory(memory);
  const input={requester:{type:'chat' as const,userId,id:'reviewer'},memoryId:memory.id,decision:'confirmed' as const,reason:'中文审核理由'};
  const read=()=>getBrainMemoryById({userId,memoryId:memory.id});
  const reviews=()=>client`SELECT decision,reason,metadata,evidence_refs FROM brain_memory_reviews WHERE memory_id=${memory.id} ORDER BY created_at,id`;
  await client.unsafe(`CREATE FUNCTION reject_brain_review() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected review failure'; END $$`);
  await client.unsafe('CREATE TRIGGER reject_brain_review BEFORE INSERT ON brain_memory_reviews FOR EACH ROW EXECUTE FUNCTION reject_brain_review()');
  try{await assert.rejects(reviewBrainMemory(input));}
  finally{await client.unsafe('DROP TRIGGER reject_brain_review ON brain_memory_reviews');await client.unsafe('DROP FUNCTION reject_brain_review()');}
  assert.equal((await read())?.status,'candidate');assert.equal((await reviews()).length,0);
  await assert.rejects(reviewBrainMemory({...input,requester:{type:'work',userId,id:randomUUID()}}));
  await assert.rejects(reviewBrainMemory({...input,requester:{type:'chat',userId:randomUUID()}}));
  assert.equal((await reviews()).length,0);
  const first=await reviewBrainMemory(input);assert.equal(first.status,'verified');assert.equal(first.content,memory.content);
  const firstReview=(await reviews())[0];assert.equal(firstReview.reason,input.reason);
  assert.equal(firstReview.metadata.previousStatus,'candidate');assert.equal(firstReview.metadata.nextStatus,'verified');
  assert.deepEqual(firstReview.evidence_refs,['fixture']);
  // Concurrent decisions serialize on the memory row. Each audit describes the
  // immediately preceding committed state, independent of submission order.
  await Promise.all([reviewBrainMemory({...input,decision:'dismissed'}),reviewBrainMemory({...input,decision:'confirmed'})]);
  const history=await reviews();assert.equal(history.length,3);
  const later=history.slice(1);
  const finalStatus=(await read())!.status;
  const transitions=later.map(row=>`${row.metadata.previousStatus}->${row.metadata.nextStatus}`).sort();
  assert.deepEqual(transitions, finalStatus==='verified'
    ? ['deleted->verified','verified->deleted']
    : ['verified->deleted','verified->verified']);
  assert.equal((await read())?.content,memory.content);
  const claim=await claimWorkshopExecution({userId,workshopId,runId,workerId:'review',leaseMs:30000});
  if(claim.state!=='claimed')throw Error('not claimed');
  const scoped=<T>(work:()=>Promise<T>)=>withExecutionContext(claim.lease,work);
  await scoped(()=>reviewBrainMemory(input));
  const event=(await client`SELECT run_id,metadata FROM workshop_events WHERE workshop_id=${workshopId} AND type='brain_memory_written'`)[0];
  assert.equal(event.run_id,runId);assert.equal(event.metadata.status,'verified');assert.equal(event.metadata.memoryId,memory.id);
  const count=(await reviews()).length;
  const counter=(await client`SELECT last_seq FROM workshop_event_counters WHERE workshop_id=${workshopId}`)[0].last_seq;
  await client.unsafe(`CREATE FUNCTION reject_review_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='brain_memory_written' THEN RAISE EXCEPTION 'injected review event failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_review_event BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_review_event()');
  try{await assert.rejects(scoped(()=>reviewBrainMemory({...input,decision:'rejected'})));}
  finally{await client.unsafe('DROP TRIGGER reject_review_event ON workshop_events');await client.unsafe('DROP FUNCTION reject_review_event()');}
  assert.equal((await read())?.status,'verified');assert.equal((await reviews()).length,count);
  await client.unsafe(`CREATE FUNCTION delay_brain_review() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.1); RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER delay_brain_review BEFORE INSERT ON brain_memory_reviews FOR EACH ROW EXECUTE FUNCTION delay_brain_review()');
  try{
    await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()+interval '1 second' WHERE workshop_id=${workshopId}`;
    await assert.rejects(scoped(()=>reviewBrainMemory({...input,decision:'rejected'})),{code:'lease_lost'});
  }finally{await client.unsafe('DROP TRIGGER delay_brain_review ON brain_memory_reviews');await client.unsafe('DROP FUNCTION delay_brain_review()');}
  assert.equal((await read())?.status,'verified');assert.equal((await reviews()).length,count);
  assert.equal((await client`SELECT last_seq FROM workshop_event_counters WHERE workshop_id=${workshopId}`)[0].last_seq,counter);
  return {name:'actual memory review: atomic state/audit/event, owner and grant checks, serialized decisions, content preservation, event fault and expired transaction rollback',passed:true};
}
