import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {beginOutboxAttempt,settleOutboxAttempt,outboxContentHash,approveOutboxSend} from '@/lib/work-runtime/outbox-attempt';
import {getWorkshopOutboxItem,updateWorkshopOutboxItem,getWorkshop} from '@/lib/workshops/service';
import {sendWorkshopOutboxWechat} from '@/lib/workshops/outbox-wechat';
import {dispatchOutboxAttempt,reconcileOutboxAttempt,type OutboxSendAdapter} from '@/lib/work-runtime/outbox-dispatch';

export async function checkOutboxAttempt(client:postgres.Sql){
  const userId=randomUUID(),workId=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},'attempt@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission,autonomy_level,boundary_policy) VALUES (${workId},${userId},'attempt','test','auto',${JSON.stringify({externalMessages:'auto',allowedRecipients:['recipient'],requireSourcesForOutbox:false,minConfidenceToSend:0,minConfidenceToDraft:0})}::jsonb)`;
  async function fixture(){
    const id=randomUUID();await client`INSERT INTO workshop_outbox(id,workshop_id,recipient_name,message,confidence,risk_level) VALUES (${id},${workId},'recipient','test message',100,'low')`;
    const outbox=await getWorkshopOutboxItem(workId,id);assert(outbox);
    return {userId,workId,outboxId:id,commandId:randomUUID(),expectedContentHash:outboxContentHash(outbox)};
  }
  const input=await fixture();
  const sendFlow=await fixture();let actualSends=0;
  const flowProvider:OutboxSendAdapter={
    preview:async payload=>({ok:true,requiresConfirmation:true,confirmToken:'fake',expiresInSeconds:300,preview:{...payload,messageHash:'fake'}}),
    send:async()=>{actualSends++;throw Error('send response lost');},
    status:async()=>({ok:true,status:'sent',result:{ok:true,sentAt:1}}),
  };
  const flowInput={workshop:(await getWorkshop(userId,workId))!,outbox:(await getWorkshopOutboxItem(workId,sendFlow.outboxId))!,auditActorId:userId,provider:flowProvider};
  assert.equal((await sendWorkshopOutboxWechat(flowInput)).ok,false);
  assert.equal((await getWorkshopOutboxItem(workId,sendFlow.outboxId))?.status,'unknown');
  assert.equal((await sendWorkshopOutboxWechat({...flowInput,outbox:(await getWorkshopOutboxItem(workId,sendFlow.outboxId))!})).ok,true);
  assert.equal(actualSends,1);
  const dispatchInput=await fixture();let sendCount=0;let sentCommand='';
  const fake:OutboxSendAdapter={
    preview:async payload=>({ok:true,requiresConfirmation:true,confirmToken:'fake',expiresInSeconds:300,preview:{...payload,messageHash:'fake'}}),
    send:async payload=>{sendCount++;sentCommand=payload.commandId!;throw Error('response lost after fake send');},
    status:async commandId=>{assert.equal(commandId,sentCommand);return {ok:true,status:'sent',result:{ok:true,sentAt:1,recipientName:'recipient',messageHash:'fake'}};},
  };
  assert.equal((await dispatchOutboxAttempt(dispatchInput,fake)).status,'unknown');
  assert.equal(sendCount,1);
  assert.equal((await dispatchOutboxAttempt(dispatchInput,fake)).status,'sent');
  assert.equal((await dispatchOutboxAttempt(dispatchInput,fake)).status,'sent');
  assert.equal(sendCount,1);
  const unconfirmed=await fixture();
  assert.equal((await dispatchOutboxAttempt(unconfirmed,{...fake,status:async()=>({ok:true,status:'not_found'})})).status,'unknown');
  const beforeRecovery=sendCount;
  assert.equal((await dispatchOutboxAttempt(unconfirmed,{...fake,status:async()=>({ok:true,status:'not_found'})})).status,'unknown');
  assert.equal(sendCount,beforeRecovery);
  const observed=await fixture();
  const observedAttempt=await beginOutboxAttempt(observed);
  let queries=0;
  const queryOnly:Pick<OutboxSendAdapter,'status'>={status:async()=>{queries++;return {ok:true,status:'sent',result:{sent:true,backend:'fake-window'}};}};
  await client`UPDATE workshops SET boundary_policy='{"externalMessages":"blocked"}'::jsonb WHERE id=${workId}`;
  assert.equal((await reconcileOutboxAttempt(observed,queryOnly)).status,'sent');
  assert.equal((await reconcileOutboxAttempt(observed,queryOnly)).id,observedAttempt.attempt.id);
  assert.equal(queries,1);
  await assert.rejects(reconcileOutboxAttempt({...observed,userId:randomUUID()},queryOnly),{code:'not_found'});
  assert.equal(queries,1);
  await client`UPDATE workshops SET boundary_policy=${JSON.stringify({externalMessages:'auto',allowedRecipients:['recipient'],requireSourcesForOutbox:false,minConfidenceToSend:0,minConfidenceToDraft:0})}::jsonb WHERE id=${workId}`;
  const inconsistent=await fixture();
  await beginOutboxAttempt(inconsistent);
  assert.equal((await reconcileOutboxAttempt(inconsistent,{status:async()=>({ok:true,status:'sent',result:{ok:false,sent:true}})})).status,'unknown');
  const other=randomUUID();await client`INSERT INTO "User"(id,email) VALUES (${other},'attempt-other@example.invalid')`;
  await assert.rejects(beginOutboxAttempt({...input,userId:other}),{code:'not_found'});
  const results=await Promise.all([beginOutboxAttempt(input),beginOutboxAttempt(input)]);
  assert.equal(results.filter(r=>r.dispatch).length,1);
  assert.equal(results[0].attempt.id,results[1].attempt.id);
  await assert.rejects(beginOutboxAttempt({...input,commandId:randomUUID()}),{code:'target_busy'});
  await assert.rejects(beginOutboxAttempt({...input,expectedContentHash:'changed'}),{code:'payload_conflict'});
  const attemptId=results[0].attempt.id;
  await assert.rejects(settleOutboxAttempt({userId:other,workId,attemptId,status:'sent',receipt:{sent:true}}),{code:'not_found'});
  await settleOutboxAttempt({userId,workId,attemptId,status:'unknown',failurePhase:'response_lost'});
  assert.equal((await beginOutboxAttempt(input)).attempt.status,'unknown');
  await assert.rejects(updateWorkshopOutboxItem(workId,input.outboxId,{status:'draft'}),{code:'target_busy'});
  await assert.rejects(beginOutboxAttempt({...input,commandId:randomUUID()}),{code:'target_busy'});
  await settleOutboxAttempt({userId,workId,attemptId,status:'sent',receipt:{provider:'fake',sent:true}});
  await settleOutboxAttempt({userId,workId,attemptId,status:'unknown'});
  assert.equal((await getWorkshopOutboxItem(workId,input.outboxId))?.status,'sent');
  const stale=await fixture();
  await client`UPDATE workshop_outbox SET message='changed' WHERE id=${stale.outboxId}`;
  await assert.rejects(beginOutboxAttempt(stale),{code:'payload_conflict'});
  const rollback=await fixture();
  await client.unsafe(`CREATE FUNCTION reject_attempt_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='outbox_sending' THEN RAISE EXCEPTION 'attempt event fault'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_attempt_event BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_attempt_event()');
  await assert.rejects(beginOutboxAttempt(rollback));
  assert.equal((await getWorkshopOutboxItem(workId,rollback.outboxId))?.status,'draft');
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_outbox_attempts WHERE outbox_id=${rollback.outboxId}`)[0].n,0);
  await client.unsafe('DROP TRIGGER reject_attempt_event ON workshop_events');
  const pending=await beginOutboxAttempt(rollback);
  await client.unsafe(`CREATE FUNCTION reject_sent_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='outbox_sent' THEN RAISE EXCEPTION 'sent event fault'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_sent_event BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_sent_event()');
  await assert.rejects(settleOutboxAttempt({userId,workId,attemptId:pending.attempt.id,status:'sent',receipt:{sent:true}}));
  assert.equal((await beginOutboxAttempt(rollback)).attempt.status,'sending');
  assert.equal((await getWorkshopOutboxItem(workId,rollback.outboxId))?.status,'sending');
  await client.unsafe('DROP TRIGGER reject_sent_event ON workshop_events');
  const approval=await fixture();
  await client`UPDATE workshops SET autonomy_level='review' WHERE id=${workId}`;
  await client`UPDATE workshop_outbox SET status='approved' WHERE id=${approval.outboxId}`;
  await assert.rejects(beginOutboxAttempt(approval),{code:'invalid_command'});
  await assert.rejects(approveOutboxSend({...approval,userId:other}),{code:'not_found'});
  const reviewed=await approveOutboxSend(approval);
  assert.deepEqual(await approveOutboxSend(approval),reviewed);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${workId} AND type='outbox_approved' AND metadata->>'outboxId'=${approval.outboxId}`)[0].n,1);
  await updateWorkshopOutboxItem(workId,approval.outboxId,{recipientName:'changed recipient'});
  const modified=await getWorkshopOutboxItem(workId,approval.outboxId);assert(modified);
  assert.equal(modified.status,'pending_approval');
  assert.equal(modified.boundaryResult.sendApproval,undefined);
  await updateWorkshopOutboxItem(workId,approval.outboxId,{recipientName:'recipient',boundaryResult:{sendApproval:reviewed},status:'approved'});
  assert.equal((await getWorkshopOutboxItem(workId,approval.outboxId))?.boundaryResult.sendApproval,undefined);
  await approveOutboxSend(approval);
  assert.equal((await beginOutboxAttempt(approval)).dispatch,true);
  const policyChanged=await fixture();await approveOutboxSend(policyChanged);
  await client`UPDATE workshops SET boundary_policy=boundary_policy||'{"maxMessageLength":4000}'::jsonb WHERE id=${workId}`;
  await assert.rejects(beginOutboxAttempt(policyChanged),{code:'invalid_command'});
  const denied=await fixture();
  await client`UPDATE workshops SET boundary_policy='{"externalMessages":"blocked"}'::jsonb WHERE id=${workId}`;
  await assert.rejects(beginOutboxAttempt(denied),{code:'invalid_command'});
  await assert.rejects(approveOutboxSend(denied),{code:'invalid_command'});
  return {name:'durable outbox attempts: single dispatch winner, unknown blocks resend, sent never downgraded, stale content/policy rejection and event rollback',passed:true};
}
