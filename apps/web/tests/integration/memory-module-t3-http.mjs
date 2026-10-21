import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Only the owned loopback runtime and generated synthetic database. */
export async function checkMemoryModuleT3Http({ client, owner, origin, records, mode }) {
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  const database = (await client`SELECT current_database() AS name`)[0].name;
  assert.match(database, /^zhiyu_test_[a-f0-9]{32}$/);
  assert.equal(new URL(process.env.ZHIYU_TEST_DATABASE_URL).pathname, `/${database}`);
  const request = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(origin + path, { method, headers: { Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90_000) });
    return { status: response.status, value: await response.json() };
  };
  const identity = await request('/api/identity'); assert.equal(identity.status, 200);
  assert.equal(identity.value.actorId, owner); assert.equal(identity.value.mode, 'local_owner');
  const sourceEventId = randomUUID();
  await client`INSERT INTO interaction_events(id,user_id,platform,source,conversation_name,content,message_time,dedupe_key)
    VALUES (${sourceEventId},${owner},'fixture','memory_module_t3_http','Synthetic T3 HTTP event','Synthetic original HTTP event',now(),${randomUUID()})`;
  const submit = async body => { const result = await request('/api/memory/commands', body); assert.equal(result.status, 200, JSON.stringify(result.value));
    assert.equal(result.value.status, 'recorded'); assert.equal(result.value.resultSemantics, 'historical_command_outcome'); return result.value; };
  const read = async ref => { const result = await request('/api/memory/read', { purpose: 'current', ref });
    assert.equal(result.status, 200); assert.equal(result.value.status, 'ok'); assert.deepEqual(result.value.ref, result.value.receipt.ref); return result.value; };
  const role = (result, name) => { const record = result.outcome.records.find(record => record.role === name); assert.ok(record); return record; };
  const raw = await request('/api/memory/commands', { kind: 'observation.append', commandId: randomUUID(), sourceId: randomUUID(),
    observedAt: '2026-10-20T03:00:00Z', content: 'Synthetic T3 original HTTP evidence' });
  assert.equal(raw.status, 200); assert.equal(raw.value.status, 'committed');
  const evidenceRef = `brain-observation:${raw.value.observation.id}`;
  const body = { kind: 'candidate.submit', commandId: randomUUID(), subject: `Synthetic T3 HTTP ${randomUUID()}`,
    content: 'Synthetic T3 candidate HTTP assertion', memoryType: 'insight', evidenceRefs: [evidenceRef] };
  const copies = await Promise.all([submit(body), submit(body)]);
  assert.equal(copies.filter(result => result.replayed).length, 1); assert.deepEqual(copies[0].receipt, copies[1].receipt);
  const source = role(copies[0], 'candidate');
  const conflict = await request('/api/memory/commands', { ...body, content: 'Conflicting public payload' }); assert.equal(conflict.status, 409);
  const forged = await request('/api/memory/commands', { ...body, commandId: randomUUID(), ownerId: randomUUID(), status: 'active' }); assert.equal(forged.status, 400);
  await submit({ kind: 'memory.review', commandId: randomUUID(), memoryId: source.id, expectedVersion: source.revision,
    decision: 'confirmed', reason: 'Synthetic owner compared source', evidenceConfirmed: true });
  const active = await read({ kind: 'memory', id: source.id }); assert.equal(active.record.status, 'verified');
  const { createInteractionTask } = await import('../../lib/interactions/service.ts');
  const task = await createInteractionTask({ userId: owner, commandId: randomUUID(), title: 'Synthetic HTTP dependency task', sourceEventIds: [sourceEventId] });
  const dependencyRef = { kind: 'memory_dependencies', entityKind: 'interaction_task', entityId: task.id };
  const unknown = await read(dependencyRef); assert.equal(unknown.record.verified, false); assert.equal(unknown.record.coverage, 'unknown');
  const bind = async action => { const basis = await read(dependencyRef), current = await read({ kind: 'memory', id: source.id });
    return submit({ kind: 'dependencies.bind', commandId: randomUUID(), action, entityKind: 'interaction_task', entityId: task.id,
      expectedEntityVersion: basis.record.entity.version, expectedDependencyVersion: basis.record.dependencyVersion,
      sources: [{ memoryId: current.record.id, expectedVersion: current.ref.revision }], reason: 'Synthetic exact dependency review', evidenceConfirmed: true }); };
  await bind('register'); assert.equal((await read(dependencyRef)).record.verified, true);
  const reviseBody = { kind: 'memory.revise', commandId: randomUUID(), memoryId: active.record.id, expectedVersion: active.ref.revision,
    operation: 'correct', authority: 'owner_statement', content: 'Synthetic corrected public assertion', reason: 'Synthetic correction', evidenceRefs: [evidenceRef] };
  const corrected = await submit(reviseBody); assert.equal(corrected.outcome.state, 'active');
  const same = await submit(reviseBody); assert.equal(same.replayed, true); assert.deepEqual(same.outcome, corrected.outcome);
  const stale = await read(dependencyRef); assert.equal(stale.record.assessment, 'stale'); assert.equal(stale.record.verified, false);
  const blocked = await request('/api/interactions/wiki', { kind: 'task', id: task.id, action: 'completeTask', commandId: randomUUID(), expectedVersion: 0 }, 'PATCH');
  assert.equal(blocked.status, 409); assert.equal(blocked.value.code, 'memory_dependency_stale');
  await bind('rebind');
  const completed = await request('/api/interactions/wiki', { kind: 'task', id: task.id, action: 'completeTask', commandId: randomUUID(), expectedVersion: 0 }, 'PATCH');
  assert.equal(completed.status, 200); assert.equal(completed.value.task.status, 'done');
  let current = await read({ kind: 'memory', id: source.id }); assert.equal(current.ref.record.id, source.id);
  const proposed = await submit({ kind: 'memory.propose', commandId: randomUUID(), targetMemoryId: current.record.id, expectedVersion: current.ref.revision,
    content: 'Synthetic rejected public proposal', reason: 'Synthetic difference awaiting review', evidenceRefs: [evidenceRef] });
  assert.equal((await read(dependencyRef)).record.assessment, 'stale');
  const rejected = await submit({ kind: 'memory.decide', commandId: randomUUID(), proposalId: role(proposed, 'candidate').id, action: 'reject',
    expectedVersion: role(proposed, 'candidate').revision, expectedBaseVersion: role(proposed, 'base').revision, reason: 'Synthetic owner rejects unverified change' });
  assert.equal(rejected.outcome.state, 'rejected'); assert.equal((await read(dependencyRef)).record.verified, true);
  const explanation = await request(`/api/memory/receipts/${rejected.receipt.id}`); assert.equal(explanation.status, 200);
  assert.equal(explanation.value.status, 'ok'); assert.equal(explanation.value.historical, true);
  assert.ok(!JSON.stringify(explanation.value).includes('Synthetic rejected public proposal'));
  const readExplanation = await request(`/api/memory/receipts/${current.receipt.id}`); assert.equal(readExplanation.value.status, 'ok');
  assert.deepEqual(readExplanation.value.receipt.ref, current.ref);
  const { createOwnerMemoryClient } = await import('../../lib/memory/index.ts');
  const foreignOwner = randomUUID(); await client`INSERT INTO "User"(id,email) VALUES (${foreignOwner},${foreignOwner + '@example.invalid'})`;
  const foreign = await createOwnerMemoryClient(foreignOwner).submit({ ...body, commandId: randomUUID(), subject: `Foreign ${randomUUID()}`, evidenceRefs: [], content: 'FOREIGN_T3_PRIVATE_BODY' });
  assert.equal(foreign.status, 'recorded');
  const foreignId = foreign.outcome.records[0].id;
  const denied = await request('/api/memory/read', { purpose: 'current', ref: { kind: 'memory', id: foreignId } });
  assert.equal(denied.status, 200); assert.equal(denied.value.status, 'not_found'); assert.ok(!JSON.stringify(denied.value).includes('FOREIGN_T3_PRIVATE_BODY'));
  const deniedReceipt = await request(`/api/memory/receipts/${foreign.receipt.id}`); assert.equal(deniedReceipt.value.status, 'not_found');

  current = await read({ kind: 'memory', id: source.id });
  const fault = { ...reviseBody, commandId: randomUUID(), memoryId: current.record.id, expectedVersion: current.ref.revision, content: 'Synthetic receipt rollback HTTP' };
  const counts = async () => (await client`SELECT
    (SELECT count(*)::int FROM brain_memories WHERE user_id=${owner}) AS memories,
    (SELECT count(*)::int FROM brain_observations WHERE user_id=${owner}) AS observations,
    (SELECT count(*)::int FROM brain_memory_reviews WHERE user_id=${owner}) AS reviews,
    (SELECT count(*)::int FROM brain_state_snapshots WHERE user_id=${owner}) AS snapshots,
    (SELECT count(*)::int FROM memory_revision_command_receipts WHERE user_id=${owner}) AS receipts`)[0];
  const before = await counts(), trigger = `reject_t3_http_${randomUUID().replaceAll('-', '')}`;
  await client.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${owner}'::uuid THEN RAISE EXCEPTION 'injected T3 HTTP receipt failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON memory_revision_command_receipts FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  try { const failure = await request('/api/memory/commands', fault); assert.ok(failure.status >= 500); assert.deepEqual(await counts(), before); }
  finally { await client.unsafe(`DROP TRIGGER ${trigger} ON memory_revision_command_receipts`); await client.unsafe(`DROP FUNCTION ${trigger}()`); }
  assert.equal((await read({ kind: 'memory', id: source.id })).ref.revision, current.ref.revision);
  await submit(fault);
  const { checkMemoryModuleT3Browser } = await import('./memory-module-t3-browser.mjs');
  const desktop = await checkMemoryModuleT3Browser({ client, owner, origin, records, mode, request, submit, read, evidenceRef });
  return { name: 'T3 six real public HTTP commands, current reads, receipts and dependency action loop', passed: true, desktop,
    authentication: 'owned_loopback_local_owner_synthetic_identity', databaseScope: 'synthetic_isolated',
    checks: ['all six owner commands', 'concurrent command replay and payload conflict', 'untrusted owner/status fields rejected',
      'exact current memory and dependency receipts', 'stale task gate then explicit rebind and action', 'proposal reject restores eligibility',
      'foreign memory and receipts withheld', 'receipt fault rolls back revision and source-change ledger'],
    limits: ['session login not exercised', 'no existing instance or external action', 'no claim of dependency completeness'] };
}
