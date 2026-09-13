import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {sql} from 'drizzle-orm';
import {withWorkshopControlWrite} from '@/lib/work-runtime/workshop-write';
import {appendWorkshopEvent,createOutboxDraft,getWorkshop} from '@/lib/workshops/service';
import {claimWorkshopExecution,finishWorkshopExecution} from '@/lib/work-runtime/execution-lease';
import {withExecutionContext} from '@/lib/work-runtime/execution-context';
import {previewWorkOutbox} from '@/lib/work-runtime/resources';
import {autoSendWorkshopOutboxIfWhitelisted,previewWorkshopOutboxWechat} from '@/lib/workshops/outbox-wechat';

export async function checkLegacyRunWrites(client:postgres.Sql){
  const userId=randomUUID(),workshopId=randomUUID(),runId=randomUUID(),legacyRun=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},'legacy-run-write@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission,boundary_policy) VALUES (${workshopId},${userId},'legacy writes','test','{"externalMessages":"blocked"}'::jsonb)`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${runId},${workshopId},'queued',NULL),(${legacyRun},${workshopId},'completed',NULL)`;
  const target={userId,workshopId,runId,workerId:'controlled',leaseMs:30000};
  const claim=await claimWorkshopExecution(target);if(claim.state!=='claimed')throw Error('not claimed');
  const scoped=<T>(work:()=>Promise<T>)=>withExecutionContext(claim.lease,work);
  const event={workshopId,runId,type:'legacy_write_fixture',title:'must reject'};
  const deny=async()=>{
    await assert.rejects(appendWorkshopEvent(event),{code:'lease_lost'});
    await assert.rejects(createOutboxDraft({workshopId,runId,message:'must reject'}),{code:'lease_lost'});
  };
  await deny();
  const draft=await scoped(()=>createOutboxDraft({workshopId,runId,message:'主人仍可审核的草稿',recipientName:'blocked',confidence:90}));
  const workshop=(await getWorkshop(userId,workshopId))!;
  await assert.rejects(autoSendWorkshopOutboxIfWhitelisted({workshop,outbox:draft}),{code:'lease_lost'});
  await assert.rejects(scoped(()=>previewWorkshopOutboxWechat({workshop,outbox:draft,auditActorId:userId})),{code:'invalid_lease'});
  await finishWorkshopExecution(claim.lease,{status:'completed'});await deny();
  const nextRun=randomUUID();await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${nextRun},${workshopId},'queued',NULL)`;
  assert.equal((await claimWorkshopExecution({...target,runId:nextRun,workerId:'next'})).state,'claimed');
  await deny();
  const ownerReview=await previewWorkOutbox({userId,workId:workshopId,outboxId:draft.id});
  assert.equal(ownerReview.ok,false); // Explicit blocked policy: no external preview call.
  const audit=(await client`SELECT run_id,metadata FROM workshop_events WHERE workshop_id=${workshopId} AND type='outbox_blocked'`)[0];
  assert.equal(audit.run_id,null);assert.equal(audit.metadata.sourceRunId,runId);assert.equal(audit.metadata.actorId,userId);
  assert.equal(audit.metadata.source,'owner_outbox_action');
  await assert.rejects(previewWorkOutbox({userId:randomUUID(),workId:workshopId,outboxId:draft.id}));
  await appendWorkshopEvent({...event,runId:legacyRun,title:'actual legacy run remains supported'});
  await assert.rejects(appendWorkshopEvent({...event,runId:randomUUID()}),{code:'not_found'});
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${workshopId} AND type='legacy_write_fixture'`)[0].n,1);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_outbox WHERE workshop_id=${workshopId}`)[0].n,1);
  const raceWork=randomUUID(),raceRun=randomUUID();
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${raceWork},${userId},'claim race','test')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${raceRun},${raceWork},'queued',NULL)`;
  let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
  const beforeClaim=withWorkshopControlWrite({workshopId:raceWork,runId:raceRun},async context=>{
    entered();await context.db.execute(sql`SELECT pg_sleep(0.2)`);
    return context.append({workshopId:raceWork,runId:raceRun,type:'before_claim',title:'legacy write before claim'});
  });
  await ready;
  const raced=await Promise.all([beforeClaim,claimWorkshopExecution({...target,workshopId:raceWork,runId:raceRun})]);
  assert.equal(raced[1].state,'claimed');
  assert.deepEqual((await client`SELECT type FROM workshop_events WHERE workshop_id=${raceWork} ORDER BY seq`).map(row=>row.type),['before_claim','execution_claimed']);
  return {name:'unfenced run writes denied during claim/after completion/after rollover; owner outbox review uses separate audited source; actual legacy run remains supported',passed:true};
}
