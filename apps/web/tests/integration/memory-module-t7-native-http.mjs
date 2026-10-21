import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function installedSdkVersion() {
  const require = createRequire(import.meta.url), resolved = require.resolve('@anthropic-ai/claude-agent-sdk');
  let directory = path.dirname(resolved);
  for (let depth = 0; depth < 5; depth++, directory = path.dirname(directory)) {
    const filename = path.join(directory, 'package.json');
    if (!fs.existsSync(filename)) continue;
    const packageJson = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (packageJson.name === '@anthropic-ai/claude-agent-sdk') return packageJson.version;
  }
  throw Error('Installed Claude SDK package version unavailable');
}
function anthropicResponse(response, payload, content, sequence) {
  const stopReason = content[0]?.type === 'tool_use' ? 'tool_use' : 'end_turn';
  const message = { id: `msg_t7_native_${sequence}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content,
    stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 12 } };
  if (!payload.stream) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(message)); return; }
  const event = (name, value) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  response.write(event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 40, output_tokens: 0 } } }));
  for (const [index, block] of content.entries()) {
    response.write(event('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } }));
    response.write(event('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }));
    response.write(event('content_block_stop', { type: 'content_block_stop', index }));
  }
  response.write(event('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 12 } }));
  response.end(event('message_stop', { type: 'message_stop' }));
}

/** A real loopback provider for the actual Next HTTP route and installed SDK.
 * It never calls a model or forwards a request. Captured bodies remain in
 * memory only; evidence contains hashes/counts and fixed synthetic markers.
 */
export async function startT7NativeHttpProvider({ client, owner }) {
  assert.match(owner, uuid);
  assert.match(String((await client`SELECT current_database() AS name`)[0].name), /^zhiyu_test_[a-f0-9]{32}$/);
  const key = 'synthetic-t7-native-' + randomUUID(), requests = [], failures = [];
  let active, sequence = 0, closed = false;
  const provider = createServer((request, response) => { void handle(request, response); });
  async function handle(request, response) {
    try {
      assert.ok(request.socket.remoteAddress === '127.0.0.1' || request.socket.remoteAddress === '::ffff:127.0.0.1');
      assert.equal(request.method, 'POST');
      assert.match(request.url ?? '', /^\/v1\/messages(?:\/count_tokens)?(?:\?beta=true)?$/);
      assert.ok(request.headers['x-api-key'] === key || request.headers.authorization === `Bearer ${key}`);
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 16 * 1024 * 1024); chunks.push(Buffer.from(chunk)); }
      const raw = Buffer.concat(chunks).toString('utf8'), payload = JSON.parse(raw);
      if (!active) throw Error('Provider request outside a selected synthetic scenario');
      const entry = { scenario: active.name, path: request.url, bytes, sha256: digest(raw), stream: payload.stream === true };
      requests.push(entry); active.bodies.push(raw);
      if (request.url.includes('count_tokens')) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"input_tokens":40}'); return; }
      active.messages++; sequence++;
      let content;
      if (active.kind === 'plan') {
        content = [{ type: 'text', text: JSON.stringify({ type: 'plan', goal: active.goal,
          steps: [{ id: 'review', description: 'Review the selected stored evidence using the permitted time tool; perform no external action.' }] }) }];
      } else if (active.kind === 'mutation' && active.messages === 1) {
        const name = (payload.tools ?? []).map(tool => tool.name).find(name => typeof name === 'string' && /(?:__|^)time$/.test(name));
        assert.ok(name, 'The actual installed SDK did not mount the controlled time tool'); active.timeTool = name;
        // The first request was already admitted and physically reached this
        // provider. A real source edit now precedes the MCP continuation.
        await client`UPDATE rag_chunks SET content=${active.replacement} WHERE id=${active.chunkId} AND user_id=${owner}`;
        active.mutated = true;
        content = [{ type: 'tool_use', id: 'toolu_t7_native_time', name, input: { timezone: 'UTC' } }];
      } else {
        content = [{ type: 'text', text: active.kind === 'mutation' ? 'UNEXPECTED_SECOND_REQUEST_AFTER_SOURCE_CHANGE' : 'T7_SYNTHETIC_NATIVE_EXECUTION_COMPLETED' }];
      }
      anthropicResponse(response, payload, content, sequence);
    } catch (error) {
      failures.push({ code: 'synthetic_provider_contract_failure', message: error instanceof assert.AssertionError ? error.message.split('\n')[0] : error?.message ?? String(error) });
      if (!response.headersSent) { response.writeHead(500, { 'Content-Type': 'application/json' }); response.end('{"type":"error","error":{"type":"api_error","message":"synthetic protocol boundary failed"}}'); }
      else response.destroy();
    }
  }
  provider.requestTimeout = 120000;
  const listening = once(provider, 'listening'); provider.listen(0, '127.0.0.1'); await listening;
  const address = provider.address(); assert.ok(address && typeof address !== 'string'); const baseUrl = `http://127.0.0.1:${address.port}`;
  const environment = { ANTHROPIC_API_KEY: key, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_MODEL: 'claude-sonnet-4-6',
    CRON_SECRET: 'synthetic-t7-cron-' + randomUUID(),
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6', ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-sonnet-4-6', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-sonnet-4-6' };
  async function check({ origin, records, mode }) {
    assert.equal(new URL(origin).hostname, '127.0.0.1'); assert.ok(!closed); assert.ok(!active);
    const firstRequest = requests.length;
    const result = { name: 'T7 actual Native HTTP to persisted source plan to installed SDK', mode, passed: false, apiResponsesMocked: false,
      realProviderCalled: false, installedSdkVersion: installedSdkVersion(), scenarios: [], providerRequests: [], failures };
    const select = (kind, name, extra = {}) => { active = { kind, name, messages: 0, bodies: [], ...extra }; return active; };
    const post = async body => {
      const response = await fetch(origin + '/api/native/agent', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify(body), signal: AbortSignal.timeout(150000) });
      const text = await response.text(), events = [];
      if (response.headers.get('content-type')?.includes('text/event-stream')) for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (data && data !== '[DONE]') events.push(JSON.parse(data));
      }
      return { status: response.status, events, json: events.length ? undefined : text ? JSON.parse(text) : undefined,
        types: events.map(event => event.type), responseBytes: Buffer.byteLength(text), responseHash: digest(text) };
    };
    const evidence = response => ({ status: response.status, eventTypes: response.types, responseBytes: response.responseBytes, responseHash: response.responseHash,
      terminals: response.events.filter(event => event.type === 'runtime_terminal').map(event => event.runtimeTerminal),
      errorCodes: response.events.filter(event => event.type === 'error').map(event => event.code ?? event.message),
      ...(response.json ? { code: response.json.code ?? response.json.error } : {}) });
    async function seed(label) {
      const chatId = randomUUID(), documentId = randomUUID(), chunkId = randomUUID(), messageId = randomUUID();
      const marker = 'T7_NATIVE_HTTP_' + randomUUID().replaceAll('-', ''), historyMarker = marker + '_OWNED_HISTORY', ragMarker = marker + '_OWNED_RAG';
      await client`INSERT INTO "Chat"(id,"userId",title,"createdAt",visibility) VALUES (${chatId},${owner},${'T7 HTTP SDK ' + label},now(),'private')`;
      await client`INSERT INTO "Message_v2"(id,"chatId",role,parts,attachments,"createdAt") VALUES (${messageId},${chatId},'user',${JSON.stringify([{ type: 'text', text: historyMarker }])}::json,'[]'::json,now())`;
      await client`INSERT INTO rag_documents(id,user_id,file_name,content_type,size_bytes,total_chunks) VALUES (${documentId},${owner},${label + '.txt'},'text/plain',${Buffer.byteLength(ragMarker)},1)`;
      await client`INSERT INTO rag_chunks(id,document_id,user_id,chunk_index,content) VALUES (${chunkId},${documentId},${owner},0,${ragMarker})`;
      const { getTaskSessionDir } = await import('../../lib/files/workspace/sessions.ts');
      return { chatId, taskId: chatId, workDir: getTaskSessionDir(chatId), documentId, chunkId, marker, historyMarker, ragMarker };
    }
    async function plan(fixture, label) {
      const selected = select('plan', label, { goal: fixture.marker + ' controlled source review' });
      const response = await post({ provider: 'claude', phase: 'plan', prompt: fixture.marker + ' Plan a controlled review of the selected owned document. No external action.',
        chatId: fixture.chatId, taskId: fixture.taskId, workDir: fixture.workDir, ragDocuments: [{ id: fixture.documentId, name: label + '.txt' }], allowedTools: ['time'] });
      result.scenarios.push({ scenario: label, response: evidence(response), messageRequests: selected.messages });
      assert.equal(response.status, 200); assert.deepEqual(response.events.filter(event => event.type === 'error'), []);
      const event = response.events.find(event => event.type === 'plan'); assert.ok(event?.plan?.id, 'Actual Native HTTP did not yield a persisted plan');
      assert.match(event.sourceLineage?.version ?? '', /^mplan1:[a-f0-9]{64}$/); assert.equal(event.sourceLineage.state, 'ready');
      assert.ok(event.sourceLineage.sourceCount >= 3, 'Expected captured owned history, RAG and current input receipts');
      assert.ok(selected.bodies.some(body => body.includes(fixture.historyMarker))); assert.ok(selected.bodies.some(body => body.includes(fixture.ragMarker)));
      const [stored] = await client`SELECT state,origin,task_id,work_dir,source_receipt_ids,version FROM memory_plan_records WHERE user_id=${owner} AND plan_id=${event.plan.id} ORDER BY revision DESC LIMIT 1`;
      assert.equal(stored.state, 'ready'); assert.equal(stored.origin, 'generated'); assert.equal(stored.task_id, fixture.chatId);
      assert.equal(stored.work_dir, fixture.workDir); assert.equal(stored.version, event.sourceLineage.version); assert.ok(stored.source_receipt_ids.length >= 3);
      return { event, stored };
    }
    try {
      const fixture = await seed('normal'), ready = await plan(fixture, `${mode}:plan`);
      const commandId = randomUUID(), execution = { provider: 'claude', phase: 'execute', prompt: 'Execute the reviewed synthetic control proposal.',
        planId: ready.event.plan.id, planVersion: ready.event.sourceLineage.version, planCommandId: commandId, chatId: fixture.chatId,
        taskId: fixture.taskId, workDir: fixture.workDir, allowedTools: ['time'] };
      const selected = select('execute', `${mode}:execute`), completed = await post(execution);
      result.scenarios.push({ scenario: selected.name, response: evidence(completed), messageRequests: selected.messages });
      assert.equal(completed.status, 200); assert.deepEqual(completed.events.filter(event => event.type === 'error'), []);
      assert.ok(completed.events.some(event => event.type === 'runtime_terminal' && event.runtimeTerminal.status === 'completed' && event.runtimeTerminal.cleanupStatus === 'completed'));
      assert.ok(selected.messages > 0); assert.ok(selected.bodies.some(body => body.includes(fixture.historyMarker) && body.includes(fixture.ragMarker)));
      const [command] = await client`SELECT execution_state,execution_finished_at FROM memory_plan_commands WHERE user_id=${owner} AND command_id=${commandId}`;
      assert.equal(command.execution_state, 'completed'); assert.ok(command.execution_finished_at);
      const beforeReplay = requests.length, replay = await post(execution);
      result.scenarios.push({ scenario: `${mode}:same-command-replay`, response: evidence(replay), providerRequestsAdded: requests.length - beforeReplay });
      assert.equal(requests.length, beforeReplay, 'The same approved command executed the SDK twice');
      assert.ok(replay.status === 409 || replay.events.some(event => event.type === 'error' && event.code === 'memory_plan_execution_already_started'));
      const second = await seed('source-mutation'), secondReady = await plan(second, `${mode}:mutation-plan`);
      const mutation = select('mutation', `${mode}:source-mutation-followup`, { chunkId: second.chunkId, replacement: second.marker + '_REVISED_AFTER_ADMISSION' });
      const mutationCommand = randomUUID(), blocked = await post({ ...execution, planId: secondReady.event.plan.id, planVersion: secondReady.event.sourceLineage.version,
        planCommandId: mutationCommand, chatId: second.chatId, taskId: second.taskId, workDir: second.workDir });
      result.scenarios.push({ scenario: mutation.name, response: evidence(blocked), messageRequests: mutation.messages, sourceMutated: mutation.mutated === true,
        timeTool: mutation.timeTool, actualToolUseObserved: blocked.events.some(event => event.type === 'tool_use' && String(event.name).includes('time')),
        actualToolResultObserved: blocked.events.some(event => event.type === 'tool_result') });
      assert.equal(blocked.status, 200); assert.equal(mutation.mutated, true); assert.equal(mutation.messages, 1, 'A later SDK request forwarded the stale RAG body');
      assert.ok(blocked.events.some(event => event.type === 'error' && (event.code ?? event.message) === 'memory_dispatch_context_unavailable'));
      assert.ok(!blocked.events.some(event => event.type === 'runtime_terminal' && event.runtimeTerminal.status === 'completed'));
      const [failed] = await client`SELECT execution_state,execution_finished_at FROM memory_plan_commands WHERE user_id=${owner} AND command_id=${mutationCommand}`;
      assert.ok(['failed', 'interrupted'].includes(failed.execution_state)); assert.ok(failed.execution_finished_at);
      active = undefined;
      const { checkMemoryModuleT7SourceProtectionHttp } = await import('./memory-module-t7-source-protection-http.mjs');
      result.otherEntryProtection = await checkMemoryModuleT7SourceProtectionHttp({ client, owner, origin, records, mode,
        getProviderRequestCount: () => requests.length + failures.length, cronSecret: environment.CRON_SECRET });
      assert.deepEqual(failures, []); result.passed = true; return result;
    } catch (error) {
      result.failure = { name: error?.name ?? 'Error', message: error instanceof assert.AssertionError ? error.message.split('\n')[0] : error?.message ?? String(error) }; throw error;
    } finally {
      active = undefined; result.providerRequests = requests.slice(firstRequest);
      fs.writeFileSync(path.join(records, `t7-${mode}-native-installed-sdk-http.json`), JSON.stringify(result, null, 2));
    }
  }
  return { environment, check, getRequestCount: () => requests.length + failures.length,
    async close() { closed = true; provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); } };
}
