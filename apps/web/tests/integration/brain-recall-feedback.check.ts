import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { recordRecallFeedback, RecallFeedbackError } from '@/lib/brain/recall-feedback';
import { inspectWorkshopMemoryRecallQuality } from '@/lib/workshops/memory-recall-quality';

export async function checkRecallFeedback(client: postgres.Sql) {
  const owner = randomUUID(), other = randomUUID(), context = randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'feedback-owner@example.invalid'),(${other},'feedback-other@example.invalid')`;
  await client`INSERT INTO brain_context_logs(id,user_id,requester_type,task_intent,selected_memory_ids,omitted,denied)
    VALUES (${context},${owner},'owner','Original query','["selected-source"]'::jsonb,'[{"id":"omitted-source"}]'::jsonb,'[{"id":"denied-source"}]'::jsonb)`;
  const before = (await client`SELECT * FROM brain_context_logs WHERE id=${context}`)[0];
  const input = { userId: owner, feedbackId: randomUUID(), contextLogId: context,
    query: 'Reported query', outcome: 'irrelevant' as const, selectedMemoryIds: ['forged'] };
  const rejectStatus = (status: number) => (error: unknown) => error instanceof RecallFeedbackError && error.status === status;
  await assert.rejects(recordRecallFeedback({ ...input, userId: other }), rejectStatus(404));
  assert.equal((await client`SELECT count(*)::int AS n FROM feedback`)[0].n, 0);
  const results = await Promise.all(Array.from({ length: 4 }, () => recordRecallFeedback(input)));
  assert.ok(results.every(result => result.id === input.feedbackId));
  assert.equal((await client`SELECT count(*)::int AS n FROM feedback`)[0].n, 1);
  const saved = (await client`SELECT * FROM feedback WHERE id=${input.feedbackId}`)[0];
  assert.equal(saved.system_info.associationStatus, 'verified_context');
  assert.equal(saved.system_info.query, 'Original query');
  assert.deepEqual(saved.system_info.selectedMemoryIds, ['selected-source']);
  assert.deepEqual(saved.system_info.omittedMemoryIds, ['omitted-source']);
  assert.deepEqual(saved.system_info.deniedMemoryIds, ['denied-source']);
  assert.equal(saved.system_info.automaticPolicyChange, false);
  await assert.rejects(recordRecallFeedback({ ...input, outcome: 'used' }), rejectStatus(409));
  await assert.rejects(recordRecallFeedback({ ...input, userId: other }), rejectStatus(404));
  assert.deepEqual((await client`SELECT * FROM brain_context_logs WHERE id=${context}`)[0], before);
  await client`DELETE FROM brain_context_logs WHERE id=${context}`;
  assert.deepEqual(await recordRecallFeedback(input), { id: input.feedbackId });
  await assert.rejects(recordRecallFeedback({ ...input, feedbackId: randomUUID() }), rejectStatus(404));
  const unlinked = { ...input, contextLogId: null, feedbackId: randomUUID() };
  await client.unsafe("CREATE FUNCTION reject_feedback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected feedback failure'; END $$");
  await client.unsafe('CREATE TRIGGER reject_feedback BEFORE INSERT ON feedback FOR EACH ROW EXECUTE FUNCTION reject_feedback()');
  try { await assert.rejects(recordRecallFeedback(unlinked)); }
  finally {
    await client.unsafe('DROP TRIGGER reject_feedback ON feedback');
    await client.unsafe('DROP FUNCTION reject_feedback()');
  }
  assert.equal((await client`SELECT count(*)::int AS n FROM feedback`)[0].n, 1);
  await recordRecallFeedback(unlinked);
  const unlinkedRow = (await client`SELECT system_info FROM feedback WHERE id=${unlinked.feedbackId}`)[0].system_info;
  assert.equal(unlinkedRow.associationStatus, 'unlinked');
  assert.deepEqual(unlinkedRow.selectedMemoryIds, []);
  assert.deepEqual((await client`SELECT * FROM feedback WHERE id=${input.feedbackId}`)[0], saved);
  const workshop = randomUUID();
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workshop},${owner},'Feedback evaluation','Isolated fixture')`;
  const report = await inspectWorkshopMemoryRecallQuality({userId:owner,workshopId:workshop,syncReviewItems:false});
  assert.equal(report.feedbackQuality.sampledFeedbackCount,2);
  assert.equal(report.feedbackQuality.verifiedContextCount,1);
  assert.equal(report.feedbackQuality.unlinkedCount,1);
  assert.equal(report.feedbackQuality.verifiedContextOutsideLogSampleCount,1);
  assert.equal(report.feedbackQuality.verifiedAssociationRate,0.5);
  assert.equal(report.verifiedFeedbackOutcomes.irrelevant,1);
  assert.equal(report.feedbackOutcomes.irrelevant,2);
  return { name: 'recall feedback owner linkage and durable retry', passed: true,
    foreignContextRejected: true, forgedAssociationsIgnored: true, concurrentRequests: 4,
    concurrentRecords: 1, changedPayloadRejected: true, deletedContextReplay: true,
    missingContextRejected: true, unlinkedExplicit: true, insertFailureAtomic: true,
    sameIdRetryRecovered: true, originalContextAndFeedbackPreserved: true,
    realReportSeparatesVerifiedAndUnlinked:true,deletedContextNotClaimedPresent:true };
}
