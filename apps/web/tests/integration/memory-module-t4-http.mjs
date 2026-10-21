import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Actual owner HTTP routes, only inside the runner's generated DB/runtime. */
export async function checkMemoryModuleT4Http({ client, owner, origin, records, mode }) {
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  const { seedMemoryModuleT4Fixture } = await import('./memory-module-t4.check.ts');
  const fixture = await seedMemoryModuleT4Fixture(client, owner);
  const request = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(origin + path, { method, headers: { Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90_000) });
    return { status: response.status, value: await response.json() };
  };
  const identity = await request('/api/identity'); assert.equal(identity.status, 200); assert.equal(identity.value.actorId, owner);
  const read = async body => { const result = await request('/api/memory/read', body); assert.equal(result.status, 200, JSON.stringify(result.value)); return result.value; };
  const discovery = await read({ purpose: 'discover', query: fixture.marker, limit: 2 });
  assert.equal(discovery.purpose, 'discover'); assert.equal(discovery.items.length, 2); assert.ok(discovery.nextCursor);
  const next = await read({ purpose: 'discover', query: fixture.marker, limit: 2, cursor: discovery.nextCursor });
  assert.ok(next.items.every(item => !discovery.items.some(old => old.id === item.id)));
  assert.ok(discovery.items.every(item => item.useSemantics === 'discovery_only' && item.ref.revision));
  const compatibilityRequest = { purpose: 'discover', query: fixture.marker, sources: ['memory'], limit: 50, threshold: 0 };
  const compatibility = await request('/api/memory/search', compatibilityRequest); assert.equal(compatibility.status, 200);
  assert.equal(compatibility.value.purpose, 'discover'); assert.equal(compatibility.value.contextTrace, undefined); assert.equal(compatibility.value.receipt.purpose, 'discover');
  assert.ok(compatibility.value.results.every(item => item.metadata.source !== 'brain_memory'
    || item.metadata.applicabilityUse === 'discovery_only' && item.metadata.revisionVersion && item.metadata.readReceipt.id === compatibility.value.receipt.id));
  for (const extra of [{ requester: { type: 'system' } }, { workId: fixture.otherWorkId }, { accessMode: 'owner_override' }, { grant: true }])
    assert.equal((await request('/api/memory/read', { purpose: 'discover', query: fixture.marker, ...extra })).status, 400);
  const mismatchedCursor = await request('/api/memory/read', { purpose: 'discover', query: fixture.marker + ' changed', limit: 2, cursor: discovery.nextCursor });
  assert.equal(mismatchedCursor.status, 400);
  const recallRequest = { purpose: 'recall', taskIntent: fixture.marker, maxTokens: 8192,
    currentRefs: [{ kind: 'interaction_task', id: fixture.taskId }] };
  const recall = await read(recallRequest); assert.ok(['ok', 'empty'].includes(recall.status));
  assert.equal(recall.pack.interfaceVersion, 'memory-context.v1'); assert.ok(recall.pack.currentStates.length > 0);
  assert.ok(recall.pack.interpretations.length > 0); assert.ok(recall.pack.constraints.length > 0); assert.ok(recall.pack.historicalEvidence.length > 0);
  assert.ok(recall.pack.budget.usedUpperBound <= recall.pack.budget.maxTokens);
  for (const name of ['candidate', 'expired', 'foreign']) assert.ok(!JSON.stringify(recall.pack).includes(fixture.bodies[name]));
  const explained = await request(`/api/memory/receipts/${recall.receipt.id}`); assert.equal(explained.value.status, 'ok');
  assert.equal(explained.value.receipt.contextLogId, recall.pack.contextLogId);
  assert.ok(!JSON.stringify(explained.value).includes(fixture.bodies.global));
  const start = Array.from(fixture.marker + ' ').length;
  const evidence = await read({ purpose: 'evidence', ref: fixture.raw.ref, range: { start, end: start + 4 } });
  assert.equal(evidence.content, 'A\u{1f600}\u4e2dB'); assert.equal(evidence.receipt.actualRange.unit, 'unicode_code_points');
  const foreignEvidence = await read({ purpose: 'evidence', ref: fixture.foreignRaw.ref, range: { start: 0, end: 20 } });
  assert.equal(foreignEvidence.status, 'not_found'); assert.ok(!JSON.stringify(foreignEvidence).includes('FOREIGN_RAW_EVIDENCE'));
  const feedbackBody = { feedbackId: randomUUID(), contextLogId: recall.pack.contextLogId, query: 'Synthetic submitted query', outcome: 'used', sources: ['memory'] };
  const feedbackCopies = await Promise.all([request('/api/memory/recall-feedback', feedbackBody), request('/api/memory/recall-feedback', feedbackBody)]);
  assert.ok(feedbackCopies.every(result => result.status === 201)); assert.equal(feedbackCopies[0].value.feedbackId, feedbackBody.feedbackId);
  assert.equal(Number((await client`SELECT count(*)::int AS n FROM feedback WHERE id=${feedbackBody.feedbackId} AND user_id=${owner}`)[0].n), 1);
  const storedFeedback = (await client`SELECT system_info FROM feedback WHERE id=${feedbackBody.feedbackId}`)[0].system_info;
  assert.equal(storedFeedback.contextLogId, recall.pack.contextLogId); assert.equal(storedFeedback.associationStatus, 'verified_context'); assert.equal(storedFeedback.query, fixture.marker);
  assert.equal((await request('/api/memory/recall-feedback', { ...feedbackBody, outcome: 'irrelevant' })).status, 409);
  const foreignContext = randomUUID();
  await client`INSERT INTO brain_context_logs(id,user_id,requester_type,task_intent) VALUES (${foreignContext},${fixture.foreignOwner},'chat','FOREIGN_T4_TRACE')`;
  assert.equal((await request('/api/memory/recall-feedback', { ...feedbackBody, feedbackId: randomUUID(), contextLogId: foreignContext })).status, 404);
  const beforeCurrent = await read({ purpose: 'current', ref: { kind: 'memory', id: fixture.ids.global } });
  const correctedBody = `${fixture.marker} OWNER_T4_HTTP_CORRECTED`;
  const revised = await request('/api/memory/commands', { kind: 'memory.revise', commandId: randomUUID(), memoryId: beforeCurrent.record.id,
    expectedVersion: beforeCurrent.ref.revision, operation: 'correct', authority: 'owner_statement', content: correctedBody,
    reason: 'Synthetic same-query HTTP correction', evidenceRefs: [fixture.evidenceRef] });
  assert.equal(revised.status, 200); assert.equal(revised.value.status, 'recorded');
  const after = await read(recallRequest); assert.ok(!JSON.stringify(after.pack).includes(fixture.bodies.global)); assert.ok(JSON.stringify(after.pack).includes(correctedBody));
  const refreshedCompatibility = await request('/api/memory/search', compatibilityRequest); assert.equal(refreshedCompatibility.status, 200);
  assert.ok(!JSON.stringify(refreshedCompatibility.value).includes(fixture.bodies.global)); assert.ok(JSON.stringify(refreshedCompatibility.value).includes(correctedBody));
  const qualityPath = `/api/workshops/${fixture.workId}/memory-recall-quality`;
  const reviewCount = async () => Number((await client`SELECT count(*)::int AS n FROM workshop_review_items WHERE workshop_id=${fixture.workId}`)[0].n);
  const eventsCount = async () => Number((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${fixture.workId}`)[0].n);
  const beforeQuality = { reviews: await reviewCount(), events: await eventsCount() };
  const report = await request(qualityPath); assert.equal(report.status, 200); assert.equal(report.value.reviewItemSync.status, 'skipped');
  assert.equal(report.value.scope.kind, 'user_memory_recall_sample'); assert.equal(report.value.auditGuardrails.noContextLogMeans, 'unobserved');
  assert.deepEqual({ reviews: await reviewCount(), events: await eventsCount() }, beforeQuality);
  for (const body of Object.values(fixture.bodies)) assert.ok(!JSON.stringify(report.value).includes(body));
  assert.equal((await request(qualityPath, { action: 'sync_review_items', userId: fixture.foreignOwner })).status, 400);
  const synchronized = await request(qualityPath, { action: 'sync_review_items' }); assert.equal(synchronized.status, 200); assert.equal(synchronized.value.reviewItemSync.status, 'synced');
  const receiptCount = async () => Number((await client`SELECT count(*)::int AS n FROM memory_query_read_receipts WHERE user_id=${owner}`)[0].n);
  const beforeFault = await receiptCount(), trigger = `reject_t4_http_${randomUUID().replaceAll('-', '')}`;
  await client.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${owner}'::uuid THEN RAISE EXCEPTION 'injected T4 HTTP query receipt failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON memory_query_read_receipts FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  try {
    for (const body of [{ purpose: 'discover', query: fixture.marker }, recallRequest]) {
      const failed = await request('/api/memory/read', body); assert.ok(failed.status >= 500); assert.ok(!failed.value.pack); assert.ok(!failed.value.items);
      assert.equal(await receiptCount(), beforeFault);
    }
    const failedCompatibility = await request('/api/memory/search', compatibilityRequest); assert.equal(failedCompatibility.status, 503);
    assert.ok(!failedCompatibility.value.results); assert.equal(await receiptCount(), beforeFault);
  } finally { await client.unsafe(`DROP TRIGGER ${trigger} ON memory_query_read_receipts`); await client.unsafe(`DROP FUNCTION ${trigger}()`); }
  await read(recallRequest);
  const feedbackTrigger = `reject_t4_feedback_${randomUUID().replaceAll('-', '')}`, retryBody = { ...feedbackBody, feedbackId: randomUUID() };
  await client.unsafe(`CREATE FUNCTION ${feedbackTrigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${owner}'::uuid AND NEW.id='${retryBody.feedbackId}'::uuid THEN RAISE EXCEPTION 'injected T4 feedback receipt failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${feedbackTrigger} BEFORE INSERT ON feedback FOR EACH ROW EXECUTE FUNCTION ${feedbackTrigger}()`);
  try { assert.equal((await request('/api/memory/recall-feedback', retryBody)).status, 503); assert.equal(Number((await client`SELECT count(*)::int AS n FROM feedback WHERE id=${retryBody.feedbackId}`)[0].n), 0); }
  finally { await client.unsafe(`DROP TRIGGER ${feedbackTrigger} ON feedback`); await client.unsafe(`DROP FUNCTION ${feedbackTrigger}()`); }
  assert.equal((await request('/api/memory/recall-feedback', retryBody)).status, 201);
  const { checkMemoryModuleT4Browser } = await import('./memory-module-t4-browser.mjs');
  const desktop = await checkMemoryModuleT4Browser({ client, owner, origin, records, mode, fixture, request });
  return { name: 'T4 real discovery/recall/evidence/feedback/quality HTTP loop', passed: true, desktop,
    databaseScope: 'synthetic_isolated', authentication: 'owned_loopback_local_owner_synthetic_identity',
    checks: ['discovery pagination and query-bound cursors', 'public authority fields rejected', 'five groups and original fixed evidence',
      'durable final context feedback and foreign isolation', 'same-query correction freshness', 'quality GET readonly and explicit maintenance POST',
      'query receipt failure does not return a body', 'feedback failure and same-ID retry'],
    limits: ['session login not exercised', 'no model or external source invoked', 'quality is a bounded sample, not accuracy proof'] };
}
