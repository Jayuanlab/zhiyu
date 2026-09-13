import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {beginOutboxAttempt,settleOutboxAttempt,outboxContentHash} from '@/lib/work-runtime/outbox-attempt';
import {getWorkshopOutboxItem,appendWorkshopEvent} from '@/lib/workshops/service';
import {upsertWorkshopServiceErrorReviewItem} from '@/lib/workshops/review-items';

export async function checkOutboxReviews(client:postgres.Sql){
  const userId=randomUUID(),workId=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},'outbox-reviews@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission,autonomy_level,boundary_policy) VALUES (${workId},${userId},'reviews','test','auto','{"externalMessages":"auto","allowedRecipients":["recipient"],"requireSourcesForOutbox":false,"minConfidenceToSend":0,"minConfidenceToDraft":0}'::jsonb)`;
  async function fixture(){
    const outboxId=randomUUID();await client`INSERT INTO workshop_outbox(id,workshop_id,recipient_name,message,confidence,risk_level) VALUES (${outboxId},${workId},'recipient','test',100,'low')`;
    const outbox=(await getWorkshopOutboxItem(workId,outboxId))!;
    const {attempt}=await beginOutboxAttempt({userId,workId,outboxId,commandId:randomUUID(),expectedContentHash:outboxContentHash(outbox)});
    await settleOutboxAttempt({userId,workId,attemptId:attempt.id,status:'unknown'});
    const event=await appendWorkshopEvent({workshopId:workId,type:'work_outbox_send_failed',title:'Old send failure',metadata:{outboxId}});
    return {outboxId,attemptId:attempt.id,event};
  }
  const first=await fixture(),other=await fixture();
  const firstReview=await upsertWorkshopServiceErrorReviewItem(first.event),otherReview=await upsertWorkshopServiceErrorReviewItem(other.event);
  assert(firstReview&&otherReview);assert.notEqual(firstReview.id,otherReview.id);
  await settleOutboxAttempt({userId,workId,attemptId:first.attemptId,status:'sent',receipt:{sent:true}});
  assert.equal((await client`SELECT status FROM workshop_review_items WHERE id=${firstReview.id}`)[0].status,'superseded');
  assert.equal((await client`SELECT status FROM workshop_review_items WHERE id=${otherReview.id}`)[0].status,'pending');
  const late=await appendWorkshopEvent({workshopId:workId,type:'outbox_auto_send_failed',title:'Late old failure',metadata:{outboxId:first.outboxId}});
  assert.equal(await upsertWorkshopServiceErrorReviewItem(late),null);
  assert.equal(await upsertWorkshopServiceErrorReviewItem(first.event),null);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_review_items WHERE source_event_id=${late.id}`)[0].n,0);
  const unknown=await appendWorkshopEvent({workshopId:workId,type:'work_outbox_send_failed',title:'Historical unknown result',metadata:{outboxId:other.outboxId,result:{attemptStatus:'unknown'}}});
  assert.equal(await upsertWorkshopServiceErrorReviewItem(unknown),null);
  return {name:'outbox reviews: independent message scope, terminal convergence and no lazy resurrection',passed:true};
}
