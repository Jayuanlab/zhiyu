import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Real HTTP routes on a runner-owned loopback server and synthetic database. */
export async function checkMemoryModuleT1Http({ client, owner, origin }) {
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  const database = (await client`SELECT current_database() AS name`)[0]?.name;
  assert.match(String(database), /^zhiyu_test_[a-f0-9]{32}$/);
  assert.equal(new URL(process.env.ZHIYU_TEST_DATABASE_URL).pathname, `/${database}`);
  const { createOwnerMemoryClient } = await import('../../lib/memory/index.ts');
  const request = async (route, body, headers = {}) => {
    const response = await fetch(origin + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
    return { status: response.status, value: await response.json() };
  };
  const identity = await request('/api/identity');
  assert.equal(identity.status, 200); assert.equal(identity.value.mode, 'local_owner'); assert.equal(identity.value.actorId, owner);
  const content = 'A\u4e2d\u6587\u{1f642}B\nC';
  const command = { kind: 'observation.append', commandId: randomUUID(), sourceId: `http-fixture:${randomUUID()}`,
    observedAt: '2026-10-20T02:03:04.000Z', content, metadata: { fixture: 'memory-module-t1-http' } };
  const copies = await Promise.all([request('/api/memory/commands', command), request('/api/memory/commands', command)]);
  assert.deepEqual(copies.map(result => result.status), [200, 200]);
  assert.equal(copies.filter(result => result.value.replayed).length, 1);
  const saved = copies.find(result => !result.value.replayed)?.value; assert.ok(saved);
  assert.equal(saved.status, 'committed'); assert.equal(saved.observation.userId, owner);
  assert.equal(saved.observation.sourceType, 'manual'); assert.equal(saved.observation.trustLevel, 'raw');
  assert.equal(copies[0].value.receipt.id, copies[1].value.receipt.id);
  const changed = await request('/api/memory/commands', { ...command, content: 'conflicting content' });
  assert.equal(changed.status, 409); assert.equal(changed.value.code, 'memory_command_conflict');

  const window = await request('/api/memory/read', { purpose: 'evidence', ref: saved.ref, range: { start: 1, end: 4 } });
  assert.equal(window.status, 200); assert.equal(window.value.status, 'ok');
  assert.equal(window.value.content, '\u4e2d\u6587\u{1f642}');
  assert.deepEqual(window.value.receipt.actualRange, { start: 1, end: 4, unit: 'unicode_code_points' });
  assert.equal(window.value.receipt.totalLength, 7);
  const explained = await request(`/api/memory/receipts/${window.value.receipt.id}`);
  assert.equal(explained.status, 200); assert.equal(explained.value.status, 'ok');
  assert.deepEqual(explained.value.receipt.actualRange, window.value.receipt.actualRange);
  const operation = await request(`/api/memory/receipts/${saved.receipt.id}`);
  assert.equal(operation.value.status, 'ok'); assert.deepEqual(operation.value.receipt.ref, saved.ref);
  const current = await request('/api/memory/read', { purpose: 'current', ref: saved.ref.record });
  assert.equal(current.status, 200); assert.equal(current.value.content, content);
  const versionMismatch = await request('/api/memory/read', { purpose: 'evidence', ref: { ...saved.ref, revision: `obsrv1:${'0'.repeat(64)}` }, range: { start: 0, end: 1 } });
  assert.equal(versionMismatch.status, 200); assert.equal(versionMismatch.value.status, 'unavailable');
  assert.equal(versionMismatch.value.code, 'version_mismatch'); assert.ok(!JSON.stringify(versionMismatch.value).includes(content));

  const foreignId = randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${foreignId},${foreignId + '@example.invalid'})`;
  const foreign = await createOwnerMemoryClient(foreignId).submit({ ...command, commandId: randomUUID(), sourceId: `foreign:${randomUUID()}`, content: 'FOREIGN_BODY_MUST_STAY_PRIVATE' });
  const foreignRead = await request('/api/memory/read', { purpose: 'evidence', ref: foreign.ref, range: { start: 0, end: 100 } });
  assert.equal(foreignRead.status, 200); assert.equal(foreignRead.value.status, 'not_found');
  assert.ok(!JSON.stringify(foreignRead.value).includes('FOREIGN_BODY_MUST_STAY_PRIVATE'));
  const foreignReceipt = await request(`/api/memory/receipts/${foreign.receipt.id}`);
  assert.equal(foreignReceipt.status, 200); assert.equal(foreignReceipt.value.status, 'not_found');
  for (const extra of [{ userId: foreignId }, { owner: foreignId }, { sourceType: 'system' }, { trustLevel: 'verified' }, { sourceEventId: randomUUID() }, { lease: {} }]) {
    const denied = await request('/api/memory/commands', { ...command, commandId: randomUUID(), sourceId: `invalid:${randomUUID()}`, ...extra });
    assert.equal(denied.status, 400); assert.equal(denied.value.code, 'invalid_memory_request');
  }
  const invalidWindow = await request('/api/memory/read', { purpose: 'evidence', ref: saved.ref, range: { start: 0, end: 8193 } });
  assert.equal(invalidWindow.status, 400); assert.equal(invalidWindow.value.code, 'invalid_memory_request');
  const crossOrigin = await request('/api/memory/commands', { ...command, commandId: randomUUID() }, { Origin: 'https://cross-site.invalid', 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(crossOrigin.status, 403);

  // Legacy response/schema stays compatible while ingestion is now the new module.
  const legacySourceType = `t1_legacy_${randomUUID().slice(0, 8)}`;
  const legacy = await request('/api/brain/observations', { sourceType: legacySourceType, sourceId: randomUUID(),
    observedAt: command.observedAt, content: 'Synthetic compatible observation', trustLevel: 'raw' });
  assert.equal(legacy.status, 200); assert.equal(legacy.value.observation.sourceType, legacySourceType);
  const legacyCurrent = await request('/api/memory/read', { purpose: 'current', ref: { kind: 'observation', id: legacy.value.observation.id } });
  assert.equal(legacyCurrent.status, 200); assert.equal(legacyCurrent.value.content, 'Synthetic compatible observation');
  const legacyList = await request(`/api/brain/observations?sourceTypes=${legacySourceType}&limit=10`);
  assert.equal(legacyList.status, 200); assert.ok(legacyList.value.observations.some(item => item.id === legacy.value.observation.id));

  const count = async table => Number((await client.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`, [owner]))[0].n);
  const before = { observations: await count('brain_observations'), operations: await count('memory_operation_receipts') };
  const suffix = randomUUID().replaceAll('-', ''), trigger = `reject_t1_http_${suffix}`;
  await client.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected T1 HTTP deferred receipt failure'; END $$`);
  await client.unsafe(`CREATE CONSTRAINT TRIGGER ${trigger} AFTER INSERT ON memory_operation_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  const failedCommand = { ...command, commandId: randomUUID(), sourceId: `failure:${randomUUID()}` };
  try {
    const failure = await request('/api/memory/commands', failedCommand);
    assert.equal(failure.status, 503); assert.equal(failure.value.code, 'memory_request_failed');
    assert.ok(!JSON.stringify(failure.value).includes('injected T1'));
    assert.ok(!JSON.stringify(failure.value).includes('postgres'));
  } finally {
    await client.unsafe(`DROP TRIGGER ${trigger} ON memory_operation_receipts`);
    await client.unsafe(`DROP FUNCTION ${trigger}()`);
  }
  assert.equal(await count('brain_observations'), before.observations); assert.equal(await count('memory_operation_receipts'), before.operations);
  const recovered = await request('/api/memory/commands', failedCommand);
  assert.equal(recovered.status, 200); assert.equal(recovered.value.status, 'committed'); assert.equal(recovered.value.replayed, false);
  return { name: 'T1 real owner HTTP commands, fixed-version evidence, receipts and legacy observation compatibility', passed: true,
    authentication: 'owned_loopback_local_owner_synthetic_identity', databaseScope: 'synthetic_isolated',
    checks: ['concurrent idempotent append', 'conflicting command', 'Unicode evidence window and actual receipt', 'exact current read',
      'explicit version mismatch', 'foreign record/receipt withheld', 'privilege fields rejected', 'invalid range rejected',
      'cross-origin write denied', 'legacy observation POST/GET and new exact reader interoperability', 'commit failure rolls back both rows', 'same-command recovery'],
    limits: ['authenticated-session login flow not exercised', 'no existing application server accessed', 'no external action or model provider invoked'] };
}
