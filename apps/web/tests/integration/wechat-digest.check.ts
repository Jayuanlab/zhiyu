import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { readWechatDigestProjection } from "@/lib/interactions/digest-projection";
import { actOnInteractionTask, taskState, TaskActionConflict } from "@/lib/interactions/task-state";

export async function checkWechatDigest(sql: postgres.Sql) {
  const owner = randomUUID(), other = randomUUID(), allowedEvent = randomUUID(), deniedEvent = randomUUID(), otherEvent = randomUUID();
  await sql`INSERT INTO "User" (id,email) VALUES (${owner},'digest@test.invalid'), (${other},'digest-other@test.invalid')`;
  for (const [id, userId, conversation] of [[allowedEvent,owner,'allowed'],[deniedEvent,owner,'denied'],[otherEvent,other,'other']]) {
    await sql`INSERT INTO interaction_events (id,user_id,platform,source,conversation_id,conversation_name,message_time,dedupe_key,requires_reply,importance)
      VALUES (${id},${userId},'wechat','fixture',${conversation},'fixture','2026-08-03T18:00:00+08:00',${id},true,'high')`;
  }
  await sql`INSERT INTO interaction_tasks (user_id,event_id,title,source_event_ids,metadata)
    SELECT ${owner}::uuid, ${allowedEvent}::uuid, 'fixture-'||n, ${JSON.stringify([allowedEvent])}::jsonb, '{"conversationIds":["allowed"]}'::jsonb FROM generate_series(1,150) n`;
  await sql`INSERT INTO interaction_tasks (user_id,event_id,title,source_event_ids,metadata)
    VALUES (${owner},${deniedEvent},'denied',${JSON.stringify([deniedEvent])}::jsonb,'{"conversationIds":["denied"]}')`;
  await sql`INSERT INTO interaction_notes (user_id,note_type,title,body,source_event_ids)
    SELECT ${owner}::uuid,'summary','noise','fixture',${JSON.stringify([allowedEvent])}::jsonb FROM generate_series(1,150)`;
  await sql`INSERT INTO interaction_notes (user_id,note_type,title,body,source_event_ids,metadata,created_at) VALUES
    (${owner},'risk','risk-1','fixture',${JSON.stringify([allowedEvent])}::jsonb,'{"riskLevel":"high"}','2026-08-04'),
    (${owner},'risk','risk-2','fixture',${JSON.stringify([allowedEvent])}::jsonb,'{"riskLevel":"medium"}','2026-08-04'),
    (${owner},'risk','denied-risk','fixture',${JSON.stringify([deniedEvent])}::jsonb,'{"conversationIds":["allowed"]}','2026-08-04'),
    (${other},'risk','other-risk','fixture',${JSON.stringify([otherEvent])}::jsonb,'{}','2026-08-04')`;
  await sql`INSERT INTO brain_memories (user_id,scope_type,owner_type,owner_id,memory_type,subject,content,evidence_refs)
    VALUES (${owner},'user','chat',${owner},'fact','fixture','candidate',${JSON.stringify([allowedEvent])}::jsonb)`;
  const base = {userId: owner, allowedConversationIds: ['allowed'], since: new Date('2026-08-30T00:00:00Z')};
  const short = await readWechatDigestProjection({...base, limit: 12});
  const large = await readWechatDigestProjection({...base, limit: 100});
  for (const result of [short,large]) {
    assert.equal(result.tasks.total,150); assert.equal(result.risks.total,2); assert.equal(result.replies.total,0);
    assert.equal(result.memories.total,1);
    assert(result.risks.items.every(note => note.title.startsWith('risk-')));
  }
  assert.equal(short.tasks.returned,12); assert.equal(large.tasks.returned,100);
  const second = await readWechatDigestProjection({...base,limit:12,offset:12});
  assert(!second.tasks.items.some(task => short.tasks.items.some(first => first.id === task.id)));
  const noScope = await readWechatDigestProjection({...base,allowedConversationIds:[],limit:12});
  assert.equal(noScope.tasks.total,0); assert.equal(noScope.risks.total,0);
  const task = short.tasks.items[0];
  const originalEvent = await sql`SELECT to_jsonb(e) as value FROM interaction_events e WHERE id=${allowedEvent}`;
  const confirm = {userId:owner,id:task.id,commandId:randomUUID(),expectedVersion:0,action:'confirmEvidence' as const};
  const confirmation = await Promise.all([actOnInteractionTask(confirm),actOnInteractionTask(confirm)]);
  assert.equal(confirmation.filter(result => result.replayed).length,1);
  const afterConfirm = taskState(confirmation[0].task);
  assert.equal(afterConfirm.verificationStatus,'confirmed'); assert.equal(afterConfirm.taskStatus,'open'); assert.equal(afterConfirm.version,1);
  await assert.rejects(() => actOnInteractionTask({...confirm, action:'completeTask'}), TaskActionConflict);
  await assert.rejects(() => actOnInteractionTask({...confirm,userId:other,commandId:randomUUID()}),TaskActionConflict);
  const complete = {...confirm,commandId:randomUUID(),expectedVersion:1,action:'completeTask' as const};
  const done = await actOnInteractionTask(complete);
  assert.equal(taskState(done.task).taskStatus,'done'); assert.equal((done.task.metadata.taskActions as unknown[]).length,2);
  assert.equal((await actOnInteractionTask(complete)).replayed,true);
  await assert.rejects(() => actOnInteractionTask({...confirm,commandId:randomUUID(),action:'correctTime',at:'2026-08-04T18:00:00+08:00'}),TaskActionConflict);
  assert.deepEqual(await sql`SELECT to_jsonb(e) as value FROM interaction_events e WHERE id=${allowedEvent}`, originalEvent);
  await sql`ALTER TABLE interaction_notes RENAME TO unavailable_interaction_notes`;
  try { await assert.rejects(() => readWechatDigestProjection({...base,limit:12})); }
  finally { await sql`ALTER TABLE unavailable_interaction_notes RENAME TO interaction_notes`; }
  return {name:'wechat pagination, scope, task commands and raw evidence preservation',passed:true,
    pendingTasks:150,riskNotes:2,limits:[12,100],sameTotals:true,duplicateConfirmationReplayed:true,confirmationIsNotCompletion:true,rawEvidenceUnchanged:true};
}
