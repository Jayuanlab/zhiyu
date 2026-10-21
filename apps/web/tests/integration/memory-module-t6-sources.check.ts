import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { withMemoryDispatchContext, bindMemoryDispatchRuntime, assertMemoryDispatchCurrent } from '@/lib/memory/context/dispatch';
import { withExactUseReaderPolicy } from '@/lib/memory/context/exact-use';
import { readPlatformRecordForOwner } from '@/lib/ai/platform-record-reader';
import { readOwnerChatHistory } from '@/lib/memory/sources/chat-history';
import { admitMemorySourceUse } from '@/lib/memory/sources/registration';
import { readOwnerSource } from '@/lib/memory/sources/service';
import { getKnowledgeBaseDocumentContentForUser } from '@/lib/ai/knowledge-base-documents';
import { createNativePiWebChatToolDefinitions } from '@/lib/ai/native-pi-web-chat-tools';
import { createWorkshopToolDefinitions } from '@/lib/workshops/mcp-tools';
import { getWorkshop, appendWorkshopEvent } from '@/lib/workshops/service';
import { claimWorkshopExecution, finishWorkshopExecution } from '@/lib/work-runtime/execution-lease';
import { withExecutionContext } from '@/lib/work-runtime/execution-context';
import { createPiAgentRuntime } from '@openzhiyu/ai/agent/runtime';
import { createFauxCore, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { saveUploadedArtifact, cleanupArtifact } from '@/lib/memory/artifacts/service';

/** Synthetic isolated PostgreSQL only. No external model, ordinary DB or user
 * files are accessed. The local Pi transport sees the actual reader output. */
export async function checkMemoryModuleT6Sources(client: postgres.Sql, owner: string) {
  const database = String((await client`SELECT current_database() AS name`)[0].name);
  assert.match(database, /^zhiyu_test_[a-f0-9]{32}$/);
  assert.equal(new URL(process.env.ZHIYU_TEST_DATABASE_URL ?? '').pathname, `/${database}`);
  const workId = randomUUID(), runId = randomUUID(), rawId = randomUUID(), chatId = randomUUID(), messageId = randomUUID(), documentId = randomUUID();
  const marker = `T6_SOURCE_${randomUUID().replaceAll('-', '')}`, checks: string[] = [];
  const config = { role: 'wechat_assistant', allowedTools: ['workshopGetDirectives', 'workshopReadMemory', 'workshopGetMemoryEvidence', 'wechatListRecordedMessages'] };
  await client`INSERT INTO workshops(id,user_id,name,mission,status,model_config) VALUES (${workId},${owner},'Synthetic T6 source Work','Isolated source fixture','active',${JSON.stringify(config)}::jsonb)`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status) VALUES (${runId},${workId},'queued')`;
  const event = await appendWorkshopEvent({ workshopId: workId, runId, type: 'source_checked', title: 'Synthetic persisted source', body: `${marker}_WORK_EVENT` });
  assert.ok(event);
  await client`INSERT INTO interaction_events(id,user_id,platform,source,conversation_name,content,message_time,dedupe_key)
    VALUES (${rawId},${owner},'wechat','memory_t6_fixture','Synthetic source conversation',${marker + '_RAW_MESSAGE'},now(),${randomUUID()})`;
  await client`INSERT INTO "Chat"(id,"userId",title,"createdAt",visibility) VALUES (${chatId},${owner},'T6 source history',now(),'private')`;
  await client`INSERT INTO "Message_v2"(id,"chatId",role,parts,attachments,"createdAt") VALUES (${messageId},${chatId},'user',${JSON.stringify([{ type: 'text', text: marker + '_CHAT_HISTORY' }])}::json,'[]'::json,now())`;
  await client`INSERT INTO rag_documents(id,user_id,file_name,content_type,size_bytes,total_chunks) VALUES (${documentId},${owner},'T6-source.txt','text/plain',100,1)`;
  await client`INSERT INTO rag_chunks(id,document_id,user_id,chunk_index,content) VALUES (${randomUUID()},${documentId},${owner},0,${marker + '_RAG_TEXT'})`;
  const auditCount = async () => Number((await client`SELECT count(*)::int AS n FROM brain_context_logs WHERE user_id=${owner} AND metadata->>'source'='memory_exact_use_dispatch'`)[0].n);
  function provider() {
    const faux = createFauxCore({}); let calls = 0;
    const agent = createPiAgentRuntime({ adapter: 'harness', model: faux.getModel(), streamFn: async (...args) => { calls++; return faux.streamSimple(...args); } });
    async function request(prompt: string) {
      faux.setResponses([fauxAssistantMessage('synthetic T6 response')]); const messages = [];
      for await (const message of agent.run({ operation: 'run', prompt, options: { onBeforeProviderRequest: assertMemoryDispatchCurrent } })) messages.push(message);
      return messages.find(message => message.type === 'runtime_terminal')?.runtimeTerminal?.status;
    }
    return { agent, request, calls: () => calls };
  }
  async function blockAfter(read: () => Promise<string>, mutate: () => Promise<unknown>) {
    await withMemoryDispatchContext(async () => {
      const local = provider(); bindMemoryDispatchRuntime(local.agent.metadata); const text = await read();
      assert.equal(await local.request(text), 'completed'); assert.equal(local.calls(), 1);
      const before = await auditCount(); await mutate(); assert.equal(await local.request(text), 'failed');
      assert.equal(local.calls(), 1); assert.equal(await auditCount(), before, 'A failed admission cannot commit a partial audit batch');
    });
  }
  await blockAfter(async () => {
    const read = await readPlatformRecordForOwner({ userId: owner, source: 'workshopEvents', id: event.id });
    assert.match(JSON.stringify(read), /_WORK_EVENT/); return JSON.stringify(read);
  }, () => client`UPDATE workshop_events SET body=${marker + '_CORRECTED'} WHERE id=${event.id}`);
  checks.push('Actual platform source reader registers an unseen stored event; a physical body correction blocks the next Pi request');
  await blockAfter(async () => {
    const history = await readOwnerChatHistory({ userId: owner, chatId }); assert.equal(history.rows[0]?.id, messageId);
    return JSON.stringify(history.rows);
  }, () => client`UPDATE "Message_v2" SET parts=${JSON.stringify([{ type: 'text', text: marker + '_CHAT_CORRECTION' }])}::json WHERE id=${messageId}`);
  checks.push('Owner chat history is read from the actual owned Chat/Message rows and cannot survive an unregistered cached history replacement');
  await blockAfter(async () => {
    const tools = createNativePiWebChatToolDefinitions({ userId: owner });
    const listing = await tools.find(tool => tool.name === 'listKnowledgeBaseDocuments')!.execute({ limit: 5 }, { toolCallId: 't6-list-rag' });
    assert.match(JSON.stringify(listing), /T6-source/);
    const full = await tools.find(tool => tool.name === 'getFullDocumentContent')!.execute({ documentId, offset: 0 }, { toolCallId: 't6-read-rag' });
    assert.match(JSON.stringify(full), /_RAG_TEXT/); return JSON.stringify(full);
  }, () => client`UPDATE rag_chunks SET content=${marker + '_RAG_CORRECTION'} WHERE document_id=${documentId}`);
  checks.push('Actual Chat readonly RAG metadata then body uses two real representations without a false version conflict; changed chunks block later dispatch');
  const sourceRead = await readOwnerSource({ userId: owner, source: 'workshopEvents', id: event.id });
  assert.ok(sourceRead.receiptId); assert.match(sourceRead.revision ?? '', /^msrc1:/);
  await client`UPDATE workshop_events SET metadata=${JSON.stringify({ fixture: 'changed_metadata_with_same_published_body' })}::jsonb WHERE id=${event.id}`;
  const count = Number((await client`SELECT count(*)::int AS n FROM brain_context_logs WHERE user_id=${owner}`)[0].n);
  await assert.rejects(readOwnerSource({ userId: owner, source: 'workshopEvents', id: event.id, expectedHash: sourceRead.contentHash, expectedRevision: sourceRead.revision }), { code: 'memory_source_version_changed' });
  assert.equal(Number((await client`SELECT count(*)::int AS n FROM brain_context_logs WHERE user_id=${owner}`)[0].n), count);
  checks.push('Owner UI source windows have durable read receipts and exact full-version continuations; failed continuation leaves no successful receipt');
  const claim = await claimWorkshopExecution({ userId: owner, workshopId: workId, runId, workerId: `t6-source-${randomUUID()}`, leaseMs: 300000 });
  assert.equal(claim.state, 'claimed'); if (claim.state !== 'claimed') throw Error('Synthetic source lease unavailable');
  try {
    const work = await getWorkshop(owner, workId); assert.ok(work);
    await withExecutionContext(claim.lease, async () => {
      await withMemoryDispatchContext(async () => {
        const local = provider(); bindMemoryDispatchRuntime(local.agent.metadata);
        const tool = createWorkshopToolDefinitions({ runtime: 'pi', workshop: work, workshopId: workId, runId, executionLease: claim.lease })
          .find(tool => tool.name === 'wechatListRecordedMessages'); assert.ok(tool);
        const result = await tool.handler({ limit: 5, statuses: ['new'] }, {}); const text = JSON.stringify(result);
        assert.match(text, /_RAW_MESSAGE/); assert.equal(await local.request(text), 'completed');
        await appendWorkshopEvent({ workshopId: workId, runId, type: 'tool_used', title: 'Synthetic runtime event after source read', body: 'No source or policy mutation' });
        assert.equal(await local.request(text), 'completed', 'Normal runtime/audit events must not invalidate the Work authority'); assert.equal(local.calls(), 2);
        await client`UPDATE workshops SET model_config=${JSON.stringify({ ...config, disallowedTools: ['wechatListRecordedMessages'] })}::jsonb WHERE id=${workId}`;
        assert.equal(await local.request(text), 'failed'); assert.equal(local.calls(), 2);
      });
      await client`UPDATE workshops SET model_config=${JSON.stringify(config)}::jsonb WHERE id=${workId}`;
      const prefixedConfig = { ...config, allowedTools: config.allowedTools.map(name => name === 'wechatListRecordedMessages'
        ? 'mcp__workshop-tools__WECHATLISTRECORDEDMESSAGES' : name) };
      await client`UPDATE workshops SET model_config=${JSON.stringify(prefixedConfig)}::jsonb WHERE id=${workId}`;
      const prefixedWork = await getWorkshop(owner, workId); assert.ok(prefixedWork);
      await withMemoryDispatchContext(async () => {
        const local = provider(); bindMemoryDispatchRuntime(local.agent.metadata);
        const tool = createWorkshopToolDefinitions({ runtime: 'pi', workshop: prefixedWork, workshopId: workId, runId, executionLease: claim.lease })
          .find(tool => tool.name === 'wechatListRecordedMessages'); assert.ok(tool);
        const result = await tool.handler({ limit: 5, statuses: ['new'] }, {}); const text = JSON.stringify(result);
        assert.match(text, /_RAW_MESSAGE/); assert.equal(await local.request(text), 'completed'); assert.equal(local.calls(), 1);
        await client`UPDATE workshops SET model_config=${JSON.stringify({ ...prefixedConfig, disallowedTools: ['mcp__workshop-tools__WeChatListRecordedMessages'] })}::jsonb WHERE id=${workId}`;
        assert.equal(await local.request(text), 'failed'); assert.equal(local.calls(), 1);
      });
      await withMemoryDispatchContext(async () => {
        bindMemoryDispatchRuntime({ engine: 'pi', adapter: 'pi-agent-harness' });
        await assert.rejects(withExactUseReaderPolicy({ requester: { type: 'work', userId: owner, id: workId },
          purpose: 'prefixed_deny_initial_admission', sourceCapability: 'wechatListRecordedMessages' }, () =>
          readPlatformRecordForOwner({ userId: owner, source: 'interactionEvents', id: rawId })), { code: 'memory_source_unavailable' });
      });
      checks.push('Actual Work reader and stored-source authority share MCP leaf/case identities: prefixed allow permits one real request, prefixed mixed-case deny blocks initial admission and later dispatch');
      await client`UPDATE workshops SET model_config=${JSON.stringify(config)}::jsonb WHERE id=${workId}`;
      const legacyId = randomUUID(), expires = new Date(Date.now() + 3000);
      await client`INSERT INTO workshop_memories(id,workshop_id,kind,content,confidence,expires_at) VALUES (${legacyId},${workId},'fact',${marker + '_TEMPORARY_LEGACY'},50,${expires.toISOString()}::timestamptz)`;
      await blockAfter(async () => {
        const tool = createWorkshopToolDefinitions({ runtime: 'pi', workshop: work, workshopId: workId, runId, executionLease: claim.lease })
          .find(tool => tool.name === 'workshopGetMemoryEvidence'); assert.ok(tool);
        const result = await tool.handler({ memoryId: legacyId, maxEvents: 1 }, {}); const text = JSON.stringify(result);
        assert.match(text, /_TEMPORARY_LEGACY/); return text;
      }, () => new Promise(resolve => setTimeout(resolve, Math.max(0, expires.getTime() - Date.now()) + 100)));
    });
    checks.push('Actual registered Work reader uses a live lease and current explicit DB capability; runtime logging permits a next request, while actual denied configuration blocks it');
    checks.push('An unchanged legacy Work memory expires by the post-lock clock; its later Pi request is blocked without pretending a new physical row revision occurred');
  } finally {
    await client`UPDATE workshops SET model_config=${JSON.stringify(config)}::jsonb WHERE id=${workId}`;
    await finishWorkshopExecution(claim.lease, { status: 'failed', error: 'synthetic_source_fixture_complete' });
  }
  await withMemoryDispatchContext(async () => {
    bindMemoryDispatchRuntime({ engine: 'pi', adapter: 'pi-agent-harness' });
    await assert.rejects(withExactUseReaderPolicy({ requester: { type: 'work', userId: owner, id: workId }, purpose: 'generic_work_source_attempt' }, () =>
      readPlatformRecordForOwner({ userId: owner, source: 'interactionEvents', id: rawId })), { code: 'memory_source_unavailable' });
  });
  await withMemoryDispatchContext(async () => {
    bindMemoryDispatchRuntime({ engine: 'claude', adapter: 'claude-agent-sdk' });
    await assert.rejects(readPlatformRecordForOwner({ userId: owner, source: 'workshopEvents', id: event.id }), { code: 'memory_dispatch_context_unavailable' });
  });
  checks.push('Generic Work platform recall does not inherit owner raw capability, and unsupported runtimes fail before an unseen source body is returned');
  const artifact = await saveUploadedArtifact(owner, { commandId: randomUUID(), name: 'T6-source-origin.txt', contentType: 'text/plain', data: new TextEncoder().encode(marker + '_ORIGIN'), saveRecord: false });
  const originDocument = randomUUID();
  await client`INSERT INTO rag_documents(id,user_id,file_name,content_type,size_bytes,total_chunks,blob_path)
    VALUES (${originDocument},${owner},'T6-controlled-parsed.txt','text/plain',100,1,${'artifact:' + artifact.manifest.id})`;
  await client`INSERT INTO rag_chunks(id,document_id,user_id,chunk_index,content) VALUES (${randomUUID()},${originDocument},${owner},0,${marker + '_CONTROLLED_PARSED'})`;
  await blockAfter(async () => {
    const read = await getKnowledgeBaseDocumentContentForUser({ userId: owner, documentId: originDocument });
    assert.equal(read.ok, true); assert.match(read.text, /_CONTROLLED_PARSED/); return read.text;
  }, () => cleanupArtifact(owner, { kind: 'artifact.cleanup', commandId: randomUUID(), artifactId: artifact.manifest.id, expectedRevision: artifact.manifest.revision }));
  checks.push('Managed artifact origin authority is checked for parsed RAG; cleaning the original blocks a previously read derivation without deleting its historical chunks');
  const trigger = `reject_t6_source_${randomUUID().replaceAll('-', '')}`;
  await client.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${owner}'::uuid AND NEW.metadata->>'source'='memory_exact_use_dispatch' THEN RAISE EXCEPTION 'synthetic source audit failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON brain_context_logs FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  try {
    await withMemoryDispatchContext(async () => {
      const local = provider(); bindMemoryDispatchRuntime(local.agent.metadata);
      const read = await readPlatformRecordForOwner({ userId: owner, source: 'workshopEvents', id: event.id });
      const before = await auditCount(); assert.equal(await local.request(JSON.stringify(read)), 'failed'); assert.equal(local.calls(), 0); assert.equal(await auditCount(), before);
    });
  } finally { await client.unsafe(`DROP TRIGGER ${trigger} ON brain_context_logs`); await client.unsafe(`DROP FUNCTION ${trigger}()`); }
  checks.push('A real PG dispatch-audit failure prevents even local faux model consumption and leaves no partial successful read audit');
  return { name: 'T6 typed stored-source dispatch', passed: true, databaseScope: 'synthetic_isolated', checks,
    limits: ['Local faux Pi only; no external model', 'Legacy local/cloud files and cached insight/rendered Work prose are explicit gaps, not imported by this check',
      'Remote ledger and live external tools are observations at their recorded read time, not continuously current PostgreSQL facts'] };
}
