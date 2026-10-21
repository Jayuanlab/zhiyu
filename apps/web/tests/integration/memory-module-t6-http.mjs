import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function checkMemoryModuleT6Http({ client, owner, origin, records, mode }) {
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  const request = async (url, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(origin + url, { method, headers: { Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180000) });
    return { status: response.status, value: await response.json(), cacheControl: response.headers.get('cache-control') };
  };
  assert.equal((await request('/api/identity')).value.actorId, owner);
  const count = async () => Number((await client`SELECT count(*)::int AS n FROM brain_context_logs WHERE user_id=${owner}`)[0].n);
  const before = await count(), catalog = await request('/api/memory/sources');
  assert.equal(catalog.status, 200); assert.equal(catalog.value.complete, false); assert.match(catalog.cacheControl, /no-store/);
  assert.ok(catalog.value.sources.some(source => source.kind === 'rag-document-metadata'));
  assert.ok(catalog.value.gaps.some(gap => gap.kind === 'unisolated_shell')); assert.equal(await count(), before);
  for (const suffix of ['observations', 'memories', 'candidates', 'snapshots', 'grants', 'memory-updates/policy']) {
    const target = suffix.replace('memory-updates', 'updates');
    const old = await request('/api/brain/' + suffix), canonical = await request('/api/memory/' + target);
    assert.equal(old.status, canonical.status, suffix); assert.deepEqual(old.value, canonical.value, suffix);
  }
  const workId = randomUUID(), foreign = randomUUID(), foreignWork = randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${foreign},${foreign + '@example.invalid'})`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workId},${owner},'T6 source desktop','Synthetic controlled sources'),(${foreignWork},${foreign},'T6 foreign','Owner isolation fixture')`;
  const { appendWorkshopEvent } = await import('../../lib/workshops/service.ts');
  const marker = 'T6_HTTP_SOURCE_' + randomUUID().replaceAll('-', '');
  const body = marker + ' 中文😀'.repeat(2600) + '_END';
  const row = await appendWorkshopEvent({ workshopId: workId, type: 'source_checked', title: 'T6 exact source', body });
  const other = await appendWorkshopEvent({ workshopId: foreignWork, type: 'source_checked', title: 'T6 foreign source', body: 'FOREIGN_SOURCE_MUST_NOT_LEAK' });
  const input = { source: 'workshopEvents', id: row.id };
  const first = await request('/api/memory/sources/read', input); assert.equal(first.status, 200, JSON.stringify(first.value));
  assert.match(first.value.content, new RegExp(marker)); assert.ok(first.value.nextOffset); assert.ok(first.value.actualRange.end <= 8000);
  assert.ok(!/[\uD800-\uDBFF]$/.test(first.value.content)); assert.match(first.value.revision, /^msrc1:/);
  const next = await request('/api/memory/sources/read', { ...input, offset: first.value.nextOffset, expectedHash: first.value.contentHash, expectedRevision: first.value.revision });
  assert.equal(next.status, 200); assert.equal(next.value.actualRange.start, first.value.nextOffset); assert.equal(next.value.nextOffset, null);
  const explained = await request('/api/memory/receipts/' + first.value.receiptId); assert.equal(explained.status, 200); assert.equal(explained.value.type, 'source_use');
  assert.equal(explained.value.coverage.currentSourceAvailability, 'not_revalidated'); assert.ok(!JSON.stringify(explained.value).includes(marker));
  const denied = await request('/api/memory/sources/read', { source: 'workshopEvents', id: other.id });
  assert.equal(denied.status, 404); assert.ok(!JSON.stringify(denied.value).includes('FOREIGN_SOURCE_MUST_NOT_LEAK'));
  const countBeforeConflict = await count();
  await client`UPDATE workshop_events SET metadata='{"syntheticAuthorityChange":true}'::jsonb WHERE id=${row.id}`;
  const conflict = await request('/api/memory/sources/read', { ...input, offset: first.value.nextOffset, expectedHash: first.value.contentHash, expectedRevision: first.value.revision });
  assert.equal(conflict.status, 409); assert.ok(!JSON.stringify(conflict.value).includes(marker)); assert.equal(await count(), countBeforeConflict);
  assert.equal((await request('/api/memory/sources/read', { ...input, userId: foreign })).status, 400);
  assert.equal((await request('/api/memory/sources?limit=1&limit=2')).status, 400);
  assert.equal((await request('/api/memory/observations', { sourceType: 't6', content: 'must not persist', userId: foreign })).status, 400);
  const oversized = await fetch(origin + '/api/memory/sources/read', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, extra: 'x'.repeat(1048576) }) });
  assert.equal(oversized.status, 413);
  const fault = 't6_http_' + randomUUID().replaceAll('-', '');
  async function installFault() {
    await client.unsafe(`CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${owner}'::uuid AND NEW.metadata->>'source'='memory_exact_use_admission' THEN RAISE EXCEPTION 'SYNTHETIC_PRIVATE_SQL_FAULT'; END IF; RETURN NEW; END $$`);
    await client.unsafe(`CREATE TRIGGER ${fault} BEFORE INSERT ON brain_context_logs FOR EACH ROW EXECUTE FUNCTION ${fault}()`);
  }
  async function removeFault() {
    await client.unsafe(`DROP TRIGGER IF EXISTS ${fault} ON brain_context_logs`); await client.unsafe(`DROP FUNCTION IF EXISTS ${fault}()`);
  }
  await installFault();
  try {
    const n = await count(), failed = await request('/api/memory/sources/read', input);
    assert.equal(failed.status, 503); assert.ok(!JSON.stringify(failed.value).includes('SYNTHETIC_PRIVATE_SQL_FAULT')); assert.ok(!JSON.stringify(failed.value).includes(marker)); assert.equal(await count(), n);
  } finally { await removeFault(); }
  const recovered = await request('/api/memory/sources/read', input); assert.equal(recovered.status, 200);
  const { checkMemoryModuleT6Browser } = await import('./memory-module-t6-browser.mjs');
  const desktop = await checkMemoryModuleT6Browser({ client, owner, origin, records, mode, row, marker, installFault, removeFault });
  return { name: 'T6 actual canonical APIs, source evidence and desktop recovery', passed: true, desktop,
    checks: ['Legacy HTTP forwarding equals canonical routes', 'Readonly bounded catalog has no new receipt or source body',
      'Real UTF16 source windows and historical bodyless explanation', 'Foreign ownership, spoofed authority and oversized input fail closed',
      'Actual full-row version conflict rolls back receipt', 'Receipt failure withholds body and private SQL details, retry recovers'] };
}
