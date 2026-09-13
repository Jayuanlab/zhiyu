import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {addWorkshopMemory,reviewWorkshopMemory,listWorkshopMemories} from '@/lib/workshops/service';
import {claimWorkshopExecution} from '@/lib/work-runtime/execution-lease';
import {withExecutionContext} from '@/lib/work-runtime/execution-context';

export async function checkLegacyMemory(client:postgres.Sql){
  const userId=randomUUID(),workshopId=randomUUID(),runId=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},'legacy-memory@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workshopId},${userId},'legacy memory','test')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${runId},${workshopId},'queued',NULL)`;
  const input={workshopId,kind:'finding' as const,content:'旧记忆与 Brain 同步',status:'candidate' as const,confidence:60};
  await client.unsafe(`CREATE FUNCTION reject_legacy_memory() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='memory_written' THEN RAISE EXCEPTION 'injected memory event failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_legacy_memory BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_legacy_memory()');
  try{await assert.rejects(addWorkshopMemory(input));}
  finally{await client.unsafe('DROP TRIGGER reject_legacy_memory ON workshop_events');await client.unsafe('DROP FUNCTION reject_legacy_memory()');}
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_memories WHERE workshop_id=${workshopId}`)[0].n,0);
  assert.equal((await client`SELECT count(*)::int AS n FROM brain_memories WHERE owner_id=${workshopId}`)[0].n,0);
  const memory=await addWorkshopMemory(input);
  await reviewWorkshopMemory({workshopId,memoryId:memory.id,status:'confirmed'});
  const previousMode=process.env.BRAIN_MEMORY_MODE;
  process.env.BRAIN_MEMORY_MODE='brain_only';
  try{assert((await listWorkshopMemories(workshopId,{statuses:['confirmed']})).some(row=>row.id===memory.id));}
  finally{if(previousMode===undefined)delete process.env.BRAIN_MEMORY_MODE;else process.env.BRAIN_MEMORY_MODE=previousMode;}
  for(const [status,expected] of [['verified','verified'],['weakened','weakened'],['active','active'],['dismissed','deleted']] as const){
    const reviewed=await reviewWorkshopMemory({workshopId,memoryId:memory.id,status,reason:'明确审核决定'});
    assert(reviewed);assert((await client`SELECT tags FROM workshop_memories WHERE id=${memory.id}`)[0].tags.includes(`memory_status:${status}`));
    const brain=(await client`SELECT status,content FROM brain_memories WHERE id=${memory.id}`)[0];
    assert.equal(brain.status,expected);assert.equal(brain.content,input.content);
  }
  const count=(await client`SELECT count(*)::int AS n FROM brain_memory_reviews WHERE memory_id=${memory.id}`)[0].n;
  await client.unsafe(`CREATE FUNCTION reject_legacy_review() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='memory_reviewed' THEN RAISE EXCEPTION 'injected review event failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_legacy_review BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_legacy_review()');
  try{await assert.rejects(reviewWorkshopMemory({workshopId,memoryId:memory.id,status:'verified'}));}
  finally{await client.unsafe('DROP TRIGGER reject_legacy_review ON workshop_events');await client.unsafe('DROP FUNCTION reject_legacy_review()');}
  assert.equal((await client`SELECT status FROM brain_memories WHERE id=${memory.id}`)[0].status,'deleted');
  assert((await client`SELECT tags FROM workshop_memories WHERE id=${memory.id}`)[0].tags.includes('memory_status:dismissed'));
  assert.equal((await client`SELECT count(*)::int AS n FROM brain_memory_reviews WHERE memory_id=${memory.id}`)[0].n,count);
  // An old row without its mirror is backfilled inside the review transaction.
  const old=randomUUID();await client`INSERT INTO workshop_memories(id,workshop_id,kind,content,confidence,tags) VALUES (${old},${workshopId},'finding','legacy only',60,'["memory_status:candidate"]'::jsonb)`;
  await reviewWorkshopMemory({workshopId,memoryId:old,status:'weakened'});
  assert.equal((await client`SELECT status FROM brain_memories WHERE id=${old}`)[0].status,'weakened');
  const collision=randomUUID(),foreignUser=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${foreignUser},'foreign-mirror@example.invalid')`;
  await client`INSERT INTO workshop_memories(id,workshop_id,kind,content,confidence,tags) VALUES (${collision},${workshopId},'finding','collision',60,'["memory_status:candidate"]'::jsonb)`;
  await client`INSERT INTO brain_memories(id,user_id,scope_type,owner_type,owner_id,memory_type,subject,content) VALUES (${collision},${foreignUser},'global','chat',${foreignUser},'fact','private','private')`;
  await assert.rejects(reviewWorkshopMemory({workshopId,memoryId:collision,status:'verified'}),/identity conflict/);
  assert((await client`SELECT tags FROM workshop_memories WHERE id=${collision}`)[0].tags.includes('memory_status:candidate'));
  assert.equal((await client`SELECT content FROM brain_memories WHERE id=${collision}`)[0].content,'private');
  const claim=await claimWorkshopExecution({userId,workshopId,runId,workerId:'legacy-memory',leaseMs:30000});if(claim.state!=='claimed')throw Error('not claimed');
  const scoped=<T>(work:()=>Promise<T>)=>withExecutionContext(claim.lease,work);
  await scoped(()=>reviewWorkshopMemory({workshopId,memoryId:old,status:'active'}));
  const event=(await client`SELECT run_id,metadata FROM workshop_events WHERE workshop_id=${workshopId} AND type='memory_reviewed' ORDER BY seq DESC LIMIT 1`)[0];
  assert.equal(event.run_id,runId);assert.equal(event.metadata.execution.token,claim.lease.token);
  const reviewCount=(await client`SELECT count(*)::int AS n FROM brain_memory_reviews WHERE memory_id=${old}`)[0].n;
  await client.unsafe(`CREATE FUNCTION delay_legacy_review() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='memory_reviewed' THEN PERFORM pg_sleep(1.1); END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER delay_legacy_review BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION delay_legacy_review()');
  try{
    await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()+interval '1 second' WHERE workshop_id=${workshopId}`;
    await assert.rejects(scoped(()=>reviewWorkshopMemory({workshopId,memoryId:old,status:'verified'})),{code:'lease_lost'});
  }finally{await client.unsafe('DROP TRIGGER delay_legacy_review ON workshop_events');await client.unsafe('DROP FUNCTION delay_legacy_review()');}
  assert.equal((await client`SELECT count(*)::int AS n FROM brain_memory_reviews WHERE memory_id=${old}`)[0].n,reviewCount);
  assert((await client`SELECT tags FROM workshop_memories WHERE id=${old}`)[0].tags.includes('memory_status:active'));
  await assert.rejects(scoped(()=>reviewWorkshopMemory({workshopId,memoryId:old,status:'verified'})),{code:'lease_lost'});
  await assert.rejects(scoped(()=>addWorkshopMemory(input)),{code:'lease_lost'});
  assert.equal((await client`SELECT status FROM brain_memories WHERE id=${old}`)[0].status,'active');
  return {name:'legacy/Brain memory create and review atomic; explicit active/weakened/verified/dismissed mapping; missing mirror backfill; event fault and stale worker rejection',passed:true};
}
