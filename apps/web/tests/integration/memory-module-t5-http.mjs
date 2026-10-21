import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

export async function checkMemoryModuleT5Http({ client, owner, origin, records, mode }) {
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  const request = async (url, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(origin + url, { method, headers: { Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
    return { status: response.status, value: await response.json() };
  };
  const upload = async (bytes, name, commandId, extra = {}) => {
    const body = new FormData(); body.append('file', new Blob([bytes], { type: 'text/plain' }), name);
    body.append('commandId', commandId); body.append('createRecord', 'true');
    for (const [key, value] of Object.entries(extra)) body.append(key, String(value));
    const response = await fetch(origin + '/api/files/upload', { method: 'POST', headers: { Origin: origin }, body, signal: AbortSignal.timeout(120000) });
    return { status: response.status, value: await response.json() };
  };
  assert.equal((await request('/api/identity')).value.actorId, owner);
  const bytes = Buffer.from('T5 HTTP 中文 A😀中B\nfixed private source\n'), name = 'T5-HTTP-中文.txt', commandId = randomUUID();
  const saved = await upload(bytes, name, commandId); assert.equal(saved.status, 200, JSON.stringify(saved.value));
  assert.equal(saved.value.artifact.state, 'active'); assert.equal(saved.value.indexStatus, 'not_requested');
  const repeated = await upload(bytes, name, commandId); assert.equal(repeated.status, 200); assert.equal(repeated.value.artifact.id, saved.value.artifact.id);
  assert.equal((await upload(Buffer.from('changed'), name, commandId)).status, 409);
  const current = await request('/api/memory/read', { purpose: 'current', ref: { kind: 'artifact', id: saved.value.artifact.id } });
  assert.equal(current.status, 200); assert.equal(current.value.receipt.purpose, 'current');
  assert.equal(current.value.receipt.actualRange.end, 0);
  const evidence = await request('/api/memory/read', { purpose: 'evidence', ref: saved.value.ref, range: { start: 0, end: bytes.length } });
  assert.equal(evidence.status, 200); assert.deepEqual(Buffer.from(evidence.value.content, 'base64'), bytes);
  assert.equal(evidence.value.receipt.actualRange.unit, 'bytes');
  assert.equal((await request('/api/memory/receipts/' + evidence.value.receipt.id)).value.status, 'ok');
  const download = await fetch(origin + saved.value.url, { headers: { Range: 'bytes=0-7' } });
  assert.equal(download.status, 206); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes.subarray(0, 8));
  assert.match(download.headers.get('cache-control'), /no-store/); assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(download.headers.get('x-memory-read-receipt')); assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8''/);
  assert.ok(download.headers.get('content-disposition').includes(encodeURIComponent(name)));
  const head = await fetch(origin + saved.value.url, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await request('/api/files/save', { attachment: { url: 'https://example.invalid/never-fetch.txt' } })).status, 410);
  assert.equal((await request('/api/files/download?path=' + encodeURIComponent('https://example.invalid/no-fetch'))).status, 410);
  assert.equal((await request('/api/memory/artifacts?limit=1&limit=2')).status, 400);
  const listing = await request('/api/memory/artifacts?limit=1'); assert.equal(listing.status, 200);
  assert.equal(listing.value.coverage.bodyIncluded, false); assert.ok(!JSON.stringify(listing.value).includes('objectKey'));
  const pendingBytes = Buffer.from('T5 resumed exact pending upload'), pending = await request('/api/memory/commands', {
    kind: 'artifact.begin', commandId: randomUUID(), name: 'T5-resumed.txt', contentType: 'text/plain', sizeBytes: pendingBytes.length,
    sha256: createHash('sha256').update(pendingBytes).digest('hex') });
  assert.equal(pending.status, 200);
  const resumed = await upload(pendingBytes, 'T5-resumed.txt', randomUUID(), { artifactId: pending.value.manifest.id, expectedRevision: pending.value.manifest.revision });
  assert.equal(resumed.status, 200); assert.equal(resumed.value.artifact.id, pending.value.manifest.id);
  const foreign = randomUUID(); await client`INSERT INTO "User"(id,email) VALUES (${foreign},${foreign + '@example.invalid'})`;
  const { saveUploadedArtifact } = await import('../../lib/memory/artifacts/service.ts');
  const foreignFile = await saveUploadedArtifact(foreign, { commandId: randomUUID(), name: 'FOREIGN.txt', contentType: 'text/plain', data: Buffer.from('FOREIGN_PRIVATE_BODY') });
  const foreignResponse = await fetch(origin + foreignFile.manifest.url); assert.equal(foreignResponse.status, 404);
  assert.ok(!(await foreignResponse.text()).includes('FOREIGN_PRIVATE_BODY'));
  const readFault = 't5_http_read_' + randomUUID().replaceAll('-', '');
  await client.unsafe(`CREATE FUNCTION ${readFault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${owner}'::uuid AND NEW.purpose='evidence' THEN RAISE EXCEPTION 'synthetic_read_fault'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${readFault} BEFORE INSERT ON memory_artifact_read_receipts FOR EACH ROW EXECUTE FUNCTION ${readFault}()`);
  try {
    const failed = await fetch(origin + saved.value.url); assert.equal(failed.status, 503);
    assert.ok(!(await failed.text()).includes('fixed private source'));
  } finally { await client.unsafe(`DROP TRIGGER ${readFault} ON memory_artifact_read_receipts`); await client.unsafe(`DROP FUNCTION ${readFault}()`); }
  const workId = randomUUID(), runId = randomUUID(), foreignWork = randomUUID();
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workId},${owner},'T5 连续性验收','Synthetic readonly receipt fixture'),(${foreignWork},${foreign},'Foreign Work','Synthetic foreign scope')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status) VALUES (${runId},${workId},'completed')`;
  const events = [
    { type: 'working_memory_updated', status: 'ready_for_projection', schemaVersion: 'host-working-memory.v1' },
    { type: 'working_memory_continuity_loaded', status: 'inherited', schemaVersion: 'working-memory-continuity.v1', guidanceAdmission: { status: 'admitted' } },
    { type: 'working_memory_usage', status: 'provider_result_received', source: 'sdk_result', usageStatus: 'reported', schemaVersion: 'host-working-memory.v1' },
  ];
  const { appendWorkshopEvent } = await import('../../lib/workshops/service.ts');
  for (const event of events) await appendWorkshopEvent({ workshopId: workId, runId, type: event.type,
    title: 'Synthetic runtime receipt', metadata: { receiptAuthority: 'runtime', ...event, state: 'MUST_NOT_EXPOSE_PRIVATE_STATE' } });
  const continuity = await request('/api/memory/continuity?workshopId=' + workId); assert.equal(continuity.status, 200);
  assert.equal(continuity.value.status, 'observed'); assert.equal(continuity.value.receipts.length, 3);
  assert.deepEqual(new Set(continuity.value.receipts.map(row => row.stage)), new Set(['saved', 'prepared-for-request', 'usage-observed']));
  assert.equal(continuity.value.receipts.find(row => row.stage === 'usage-observed').status, 'observed');
  assert.ok(!JSON.stringify(continuity.value).includes('MUST_NOT_EXPOSE_PRIVATE_STATE'));
  assert.equal((await request('/api/memory/continuity?workshopId=' + foreignWork)).status, 404);
  assert.equal((await request('/api/memory/continuity?workshopId=' + workId + '&userId=' + foreign)).status, 400);
  const { checkMemoryModuleT5Browser } = await import('./memory-module-t5-browser.mjs');
  const desktop = await checkMemoryModuleT5Browser({ client, owner, origin, records, mode, workId, request, upload });
  return { name: 'T5 actual file/continuity HTTP and desktop recovery', passed: true, desktop,
    checks: ['private upload replay and conflicting bytes', 'byte window, HEAD metadata and owner isolation', 'current and evidence receipts',
      'pending upload resume', 'legacy uncontrolled URL refusal without fetching', 'receipt failure with no body', 'readonly continuity stages and hidden-state exclusion'] };
}
