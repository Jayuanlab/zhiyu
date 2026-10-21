import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, symlink, link } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type postgres from 'postgres';
import { importWorkspaceFile } from '@/lib/memory/files/import';
import { bindWorkFile, revokeWorkFile } from '@/lib/memory/files/commands';
import { createWorkshopPiTools } from '@/lib/workshops/pi-domain-tools';
import { getWorkshop } from '@/lib/workshops/service';
import { prepareWorkspace } from '@/lib/workshops/workspace';
import { getTaskSessionDir } from '@/lib/files/workspace/sessions';
import { claimWorkshopExecution, finishWorkshopExecution } from '@/lib/work-runtime/execution-lease';
import { withExecutionContext } from '@/lib/work-runtime/execution-context';
import { withMemoryDispatchContext, bindMemoryDispatchRuntime, assertMemoryDispatchCurrent } from '@/lib/memory/context/dispatch';
import { createPiAgentRuntime } from '@openzhiyu/ai/agent/runtime';
import { createFauxCore, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { cleanupArtifact } from '@/lib/memory/artifacts/service';
import { getMemoryArtifactForUser } from '@/lib/ai/brain-read-tools';
import { readOwnerSource } from '@/lib/memory/sources/service';
import { preparePersistedExactUse, admitPersistedExactUse } from '@/lib/memory/context/exact-use-admission';

/** Only root's random isolated DB and configured synthetic application/storage
 * directories. No ordinary files, external models or network providers. */
export async function checkMemoryModuleT7Files(client: postgres.Sql, owner: string) {
  const database = String((await client`SELECT current_database() AS name`)[0].name);
  assert.match(database, /^zhiyu_test_[a-f0-9]{32}$/);
  assert.equal(new URL(process.env.ZHIYU_TEST_DATABASE_URL ?? '').pathname, `/${database}`);
  const appRoot = process.env.ZHIYU_APP_DATA_DIR, storeRoot = process.env.MEMORY_ARTIFACT_STORAGE_ROOT;
  assert.ok(appRoot && isAbsolute(appRoot)); assert.ok(storeRoot && isAbsolute(storeRoot));
  const taskId = randomUUID(), workId = randomUUID(), runId = randomUUID(), sourceId = randomUUID(), marker = `T7_FILE_${randomUUID()}`;
  const checks: string[] = [], original = `${marker}_ORIGINAL\n\u6d4b\u8bd5\ud83d\ude80\n`;
  await client`INSERT INTO "Chat"(id,"userId",title,"createdAt",visibility) VALUES (${taskId},${owner},'Synthetic T7 import',now(),'private')`;
  const taskRoot = getTaskSessionDir(taskId); await mkdir(taskRoot, { recursive: true }); await writeFile(join(taskRoot, 'source.txt'), original);
  const importCommand = { commandId: randomUUID(), taskId, path: 'source.txt' };
  const imported = await importWorkspaceFile(owner, importCommand);
  assert.equal(imported.origin.semantics, 'owner_confirmed_imported_snapshot'); assert.equal(imported.origin.originalFileCurrent, false);
  assert.equal((await importWorkspaceFile(owner, importCommand)).artifactId, imported.artifactId);
  await assert.rejects(importWorkspaceFile(owner, { ...importCommand, path: '../source.txt' }));
  const other = randomUUID(), foreignChat = randomUUID(); await client`INSERT INTO "User"(id,email) VALUES (${other},${other + '@example.invalid'})`;
  await client`INSERT INTO "Chat"(id,"userId",title,"createdAt",visibility) VALUES (${foreignChat},${other},'Foreign task',now(),'private')`;
  await assert.rejects(importWorkspaceFile(owner, { commandId: randomUUID(), taskId: foreignChat, path: 'source.txt' }), { code: 'workspace_file_not_found' });
  await assert.rejects(importWorkspaceFile(owner, { commandId: randomUUID(), taskId, path: '../source.txt' }), { code: 'file_source_unavailable' });
  await mkdir(join(taskRoot, 'inside')); await writeFile(join(taskRoot, 'inside', 'linked.txt'), 'PRIVATE_LINK_BODY');
  await symlink(join(taskRoot, 'inside'), join(taskRoot, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  await link(join(taskRoot, 'inside', 'linked.txt'), join(taskRoot, 'hard.txt'));
  for (const path of ['junction/linked.txt', 'hard.txt']) await assert.rejects(importWorkspaceFile(owner, { commandId: randomUUID(), taskId, path }), { code: 'file_source_unavailable' });
  checks.push('Actual owned Chat plus no-link bounded FD import produces a durable immutable snapshot; foreign task, traversal, junction and hardlink are refused');
  const config = { role: 'document_markdown_cleaner', allowedTools: ['Read', 'workshopConvertDocument'] };
  await client`INSERT INTO workshops(id,user_id,name,mission,status,model_config) VALUES (${workId},${owner},'T7 bound files','Synthetic source check','active',${JSON.stringify(config)}::jsonb)`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status) VALUES (${runId},${workId},'queued')`;
  const cachedBody = `${marker}_REVOKED_CACHED_FILE_BODY`;
  await client`INSERT INTO workshop_sources(id,workshop_id,type,name,uri,content,enabled) VALUES (${sourceId},${workId},'file','Selected imported snapshot','legacy-path-is-not-authority',${cachedBody},true)`;
  const bind = async (expiresAt = new Date(Date.now() + 300000).toISOString(), artifactId = imported.artifactId, artifactRevision = imported.artifactRevision) => {
    const rows = await client`SELECT revision FROM memory_file_bindings WHERE user_id=${owner} AND source_id=${sourceId}`;
    return bindWorkFile(owner, { commandId: randomUUID(), workshopId: workId, sourceId, artifactId, expectedArtifactRevision: artifactRevision,
      expectedBindingRevision: rows[0] ? Number(rows[0].revision) : 0, permissions: ['read', 'convert'], expiresAt });
  };
  const bound = await bind(); const bindingId = String(bound.binding.id);
  // The owner source reader publishes configuration descriptors, not cached
  // file contents. A legacy source receipt cannot acquire the new physical
  // body guarantee merely because its owner/policy/full stored hash still match.
  const descriptor = await readOwnerSource({ userId: owner, source: 'workshopSources', id: sourceId });
  assert.equal(JSON.parse(descriptor.content).content, null); assert.ok(!descriptor.content.includes(cachedBody));
  assert.equal((await client`SELECT content FROM workshop_sources WHERE workshop_id=${workId} AND id=${sourceId}`)[0].content, cachedBody, 'Read must withhold the cache, not rewrite the stored business row');
  type SourceReceipt = { metadata: { source: string; exactUse: { schemaVersion: string; policy: unknown;
    refs: Array<{ kind: string; source?: string; id: string; revision: string; representation?: string }> } } };
  const [descriptorReceipt] = await client<SourceReceipt[]>`SELECT metadata FROM brain_context_logs WHERE user_id=${owner} AND id=${descriptor.receiptId}`;
  assert.ok(descriptorReceipt); const descriptorRefs = descriptorReceipt.metadata.exactUse.refs;
  assert.equal(descriptorRefs.length, 1); assert.deepEqual(descriptorRefs[0], { kind: 'source', source: 'workshopSources', id: sourceId,
    revision: descriptor.revision, representation: 'file_source_descriptor.v1' });
  assert.ok(!JSON.stringify(descriptorReceipt.metadata).includes(cachedBody));
  const freshTicket = await preparePersistedExactUse(owner, descriptor.receiptId), freshProof = await admitPersistedExactUse(freshTicket);
  assert.deepEqual(freshProof.refs, descriptorRefs); assert.ok(freshProof.refs.every(ref => ref.kind === 'source'));
  const legacyReceiptId = randomUUID();
  await client`INSERT INTO brain_context_logs(id,user_id,requester_type,requester_id,task_intent,selected_memory_ids,denied,omitted,metadata)
    SELECT ${legacyReceiptId}::uuid,user_id,requester_type,requester_id,task_intent,selected_memory_ids,denied,omitted,
      jsonb_set(metadata,'{exactUse,refs}',(SELECT jsonb_agg(value - 'representation') FROM jsonb_array_elements(metadata->'exactUse'->'refs') AS item(value)))
    FROM brain_context_logs WHERE user_id=${owner} AND id=${descriptor.receiptId}`;
  const [legacyReceipt] = await client<SourceReceipt[]>`SELECT metadata FROM brain_context_logs WHERE user_id=${owner} AND id=${legacyReceiptId}`;
  assert.ok(legacyReceipt); assert.deepEqual(legacyReceipt.metadata.exactUse.policy, descriptorReceipt.metadata.exactUse.policy);
  assert.deepEqual(legacyReceipt.metadata.exactUse.refs, descriptorRefs.map(({ representation: _representation, ...ref }) => ref));
  const beforeLegacy = Number((await client`SELECT count(*)::int AS n FROM brain_context_logs WHERE user_id=${owner}`)[0].n);
  const legacyTicket = await preparePersistedExactUse(owner, legacyReceiptId);
  assert.equal(Number((await client`SELECT count(*)::int AS n FROM brain_context_logs WHERE user_id=${owner}`)[0].n), beforeLegacy);
  await assert.rejects(admitPersistedExactUse(legacyTicket), { code: 'memory_exact_use_unavailable' });
  assert.equal(Number((await client`SELECT count(*)::int AS n FROM brain_context_logs WHERE user_id=${owner}`)[0].n), beforeLegacy);
  checks.push('Actual owner file-source read with stored cached body publishes content:null and file_source_descriptor.v1 refs; current descriptor restores only as configuration, never a physical body proof');
  checks.push('A synthetic legacy receipt cloned from that actual owned policy/full revision with only representation removed can prepare, but admission fails without a new receipt or cached body authorization');
  const claim = await claimWorkshopExecution({ userId: owner, workshopId: workId, runId, workerId: `t7-files-${randomUUID()}`, leaseMs: 300000 });
  assert.equal(claim.state, 'claimed'); if (claim.state !== 'claimed') throw Error('Synthetic lease missing');
  const lease = claim.lease;
  const layout = await prepareWorkspace({ userId: owner, workshopId: workId, runId }); assert.ok(layout.runDir);
  function provider() {
    const faux = createFauxCore({}); let calls = 0;
    const runtime = createPiAgentRuntime({ adapter: 'harness', model: faux.getModel(), streamFn: async (...args) => { calls++; return faux.streamSimple(...args); } });
    async function request(prompt: string) {
      faux.setResponses([fauxAssistantMessage('synthetic file result')]); const messages = [];
      for await (const message of runtime.run({ operation: 'run', prompt, options: { onBeforeProviderRequest: assertMemoryDispatchCurrent } })) messages.push(message);
      return messages.find(message => message.type === 'runtime_terminal')?.runtimeTerminal?.status;
    }
    return { runtime, request, calls: () => calls };
  }
  const tools = async () => {
    const current = await getWorkshop(owner, workId); assert.ok(current);
    return createWorkshopPiTools({ workshop: current, workshopId: workId, runId, executionLease: lease, workDir: layout.runDir! });
  };
  const readBound = async () => {
    const reader = (await tools()).find(tool => tool.name === 'Read'); assert.ok(reader);
    const read = await reader.execute(`read-${randomUUID()}`, { path: `source:${sourceId}` });
    const text = JSON.stringify(read); assert.match(text, /_ORIGINAL/); return text;
  };
  async function afterWorkRead(mutate: () => Promise<unknown>, next: 'failed' | 'completed' = 'failed') {
    let signalReady!: () => void, signalMutation!: () => void;
    const ready = new Promise<void>(resolve => { signalReady = resolve; }), mutated = new Promise<void>(resolve => { signalMutation = resolve; });
    const active = withExecutionContext(lease, () => withMemoryDispatchContext(async () => {
      const local = provider(); bindMemoryDispatchRuntime(local.runtime.metadata); const text = await readBound();
      assert.equal(await local.request(text), 'completed'); assert.equal(local.calls(), 1); signalReady(); await mutated;
      assert.equal(await local.request(text), next); assert.equal(local.calls(), next === 'failed' ? 1 : 2);
    }));
    const settled = active.then(() => { throw Error('Reader finished before mutation'); }, error => { throw error; });
    await Promise.race([ready, settled]);
    try { await mutate(); } finally { signalMutation(); }
    await active;
  }
  try {
    await afterWorkRead(() => writeFile(join(taskRoot, 'source.txt'), `${marker}_CHANGED_ORIGINAL`), 'completed');
    checks.push('Actual Work Read and runtime audit permit a next request; original workspace changes do not falsify imported_snapshot current semantics');
    const reimported = await importWorkspaceFile(owner, { commandId: randomUUID(), taskId, path: 'source.txt' });
    assert.notEqual(reimported.artifactId, imported.artifactId);
    await afterWorkRead(() => bind(undefined, reimported.artifactId, reimported.artifactRevision)); await bind();
    checks.push('Explicit reimport creates an independent immutable version and owner CAS rebind blocks the older transcript proof');
    const [manifest] = await client`SELECT object_key FROM memory_artifact_manifests WHERE id=${imported.artifactId} AND user_id=${owner}`;
    const object = join(storeRoot, ...String(manifest.object_key).split('/')), originalBytes = await readFile(object);
    await afterWorkRead(() => writeFile(object, 'CORRUPTED_PRIVATE_OBJECT')); await writeFile(object, originalBytes);
    checks.push('A physical managed-object mutation blocks the next actual faux Pi request before another provider call');
    await afterWorkRead(async () => {
      const rows = await client`SELECT revision FROM memory_file_bindings WHERE id=${bindingId}`;
      await revokeWorkFile(owner, { commandId: randomUUID(), bindingId, expectedBindingRevision: Number(rows[0].revision) });
    }); await bind();
    await afterWorkRead(() => client`UPDATE workshops SET model_config=${JSON.stringify({ ...config, disallowedTools: ['mcp__workshop-tools__READ'] })}::jsonb WHERE id=${workId}`);
    await client`UPDATE workshops SET model_config=${JSON.stringify(config)}::jsonb WHERE id=${workId}`;
    await bind(new Date(Date.now() + 3000).toISOString());
    const [expiry] = await client`SELECT expires_at FROM memory_file_bindings WHERE id=${bindingId}`;
    await afterWorkRead(() => new Promise(resolve => setTimeout(resolve, Math.max(0, new Date(expiry.expires_at).getTime() - Date.now()) + 100))); await bind();
    checks.push('Real owner revoke, normalized current tool deny and unchanged-row TTL each block previously read Work file context');
    await withExecutionContext(lease, () => withMemoryDispatchContext(async () => {
      const local = provider(); bindMemoryDispatchRuntime(local.runtime.metadata);
      const converter = (await tools()).find(tool => tool.name === 'workshopConvertDocument'); assert.ok(converter);
      const converted = await converter.execute(`convert-${randomUUID()}`, { sourceId });
      const result = JSON.parse(converted.content.filter(block => block.type === 'text').map(block => block.text).join(''));
      assert.equal(result.status, 'recorded'); assert.ok(result.artifactId); assert.equal(result.originalFileEdited, false);
      const [derived] = await client`SELECT metadata,state FROM memory_artifact_manifests WHERE id=${result.artifactId}`;
      assert.equal(derived.state, 'active'); assert.equal(derived.metadata.origin.bindingId, bindingId);
      assert.equal(await local.request(JSON.stringify(converted)), 'completed');
    }));
    checks.push('Actual separately granted converter saves a new managed Markdown artifact with the bound source version and evidence receipt lineage');
    const trigger = `reject_t7_file_${randomUUID().replaceAll('-', '')}`;
    await client.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${owner}'::uuid AND NEW.metadata->>'source'='memory_exact_use_admission' THEN RAISE EXCEPTION 'synthetic file audit failure'; END IF; RETURN NEW; END $$`);
    await client.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON brain_context_logs FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    try {
      const before = Number((await client`SELECT count(*)::int AS n FROM memory_artifact_read_receipts WHERE user_id=${owner}`)[0].n);
      await withExecutionContext(lease, () => withMemoryDispatchContext(async () => {
        bindMemoryDispatchRuntime({ engine: 'pi', adapter: 'pi-agent-harness' }); await assert.rejects(readBound());
      }));
      assert.equal(Number((await client`SELECT count(*)::int AS n FROM memory_artifact_read_receipts WHERE user_id=${owner}`)[0].n), before);
    } finally { await client.unsafe(`DROP TRIGGER ${trigger} ON brain_context_logs`); await client.unsafe(`DROP FUNCTION ${trigger}()`); }
    checks.push('Actual admission-audit failure rolls back artifact evidence receipt and Work event writes; no model body escapes');
    await withMemoryDispatchContext(async () => {
      const local = provider(); bindMemoryDispatchRuntime(local.runtime.metadata);
      const read = await getMemoryArtifactForUser({ userId: owner, artifactId: imported.artifactId }); assert.equal(read.ok, true);
      assert.equal(await local.request(read.text), 'completed');
      await writeFile(object, 'OWNER_ARTIFACT_MUTATION'); assert.equal(await local.request(read.text), 'failed'); assert.equal(local.calls(), 1);
    }); await writeFile(object, originalBytes);
    await afterWorkRead(async () => {
      const [row] = await client`SELECT revision FROM memory_artifact_manifests WHERE id=${imported.artifactId}`;
      await cleanupArtifact(owner, { kind: 'artifact.cleanup', commandId: randomUUID(), artifactId: imported.artifactId, expectedRevision: Number(row.revision) });
    });
    checks.push('Owner Chat artifact reads also rehash actual managed bytes per request; owner cleanup invalidates the formal Work binding');
  } finally { await finishWorkshopExecution(lease, { status: 'failed', error: 'synthetic_t7_files_complete' }); }
  return { name: 'T7 registered local file snapshots', passed: true, databaseScope: 'synthetic_isolated', checks,
    limits: ['Imported snapshots are independent versions, not arbitrary filesystem grants or claims that originals remain current', 'Local faux Pi only; no real model', 'Edit of original inputs and unisolated shell remain denied'] };
}
