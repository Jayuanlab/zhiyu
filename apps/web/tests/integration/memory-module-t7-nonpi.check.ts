import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, request as localHttpRequest, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { controlledClaudeQuery } from '@/lib/ai/extensions/agent/claude/controlled-sdk';
import { createControlledClaudeTransport } from '@/lib/ai/extensions/agent/claude/guarded-transport';

/** Synthetic loopback only; no DB, real provider, private user data or model.
 * Kept outside unit runner because that runner must forbid real sockets. */
export async function checkMemoryModuleT7NonPiTransport() {
  const goRouting = await checkMemoryModuleT7GoRouting();
  const providerBodies: string[] = [], providerHeaders: string[] = [];
  let redirect = false, streaming = false, openResponse: ServerResponse | undefined;
  const provider = createServer(async (request, response) => {
    const parts: Buffer[] = []; for await (const chunk of request) parts.push(Buffer.from(chunk));
    providerBodies.push(Buffer.concat(parts).toString('utf8')); providerHeaders.push(String(request.headers['x-api-key']));
    if (streaming) { openResponse = response; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('event: open\ndata: {}\n\n'); return; }
    if (redirect) { response.writeHead(307, { location: 'https://forbidden.invalid/collect' }); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('event: done\ndata: {}\n\n');
  });
  const listening = once(provider, 'listening'); provider.listen(0, '127.0.0.1'); await listening;
  const address = provider.address(); assert.ok(address && typeof address !== 'string');
  const context = new AsyncLocalStorage<string>(); let checks = 0, allowed = true;
  const controller = new AbortController();
  const transport = await context.run('trusted-synthetic-owner', () => createControlledClaudeTransport({
    upstream: `http://127.0.0.1:${address.port}/anthropic`, apiKey: 'synthetic-upstream-secret', signal: controller.signal,
    beforeRequest: async () => { assert.equal(context.getStore(), 'trusted-synthetic-owner'); checks++; if (!allowed) throw Error('synthetic private cause'); },
  }));
  const send = (path = '/v1/messages', token = transport.token) => fetch(transport.baseUrl + path, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': token }, body: '{"model":"synthetic","messages":[]}',
  });
  try {
    for (const path of ['/v1/messages?beta=true', '/v1/messages', '/v1/messages/count_tokens']) {
      const response = await send(path); assert.equal(response.status, 200); assert.match(await response.text(), /event: done/);
    }
    assert.equal(checks, 3); assert.equal(transport.requestCount, 3); assert.equal(providerBodies.length, 3);
    assert.ok(providerHeaders.every(value => value === 'synthetic-upstream-secret')); assert.notEqual(transport.token, 'synthetic-upstream-secret');
    assert.equal(providerBodies[0], '{"model":"synthetic","messages":[]}');
    assert.equal((await send('/v1/messages', 'wrong')).status, 403);
    assert.equal((await send('/collect')).status, 403); assert.equal((await send('/v1/messages?other=true')).status, 403);
    const oversized = await new Promise<number>(resolve => {
      const request = localHttpRequest(transport.baseUrl + '/v1/messages', { method: 'POST', headers: { 'x-api-key': transport.token, 'content-length': 16 * 1024 * 1024 + 1 } }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode ?? 0));
      }); request.end();
    }); assert.equal(oversized, 413);
    streaming = true;
    const streamed = await send(); const reader = streamed.body!.getReader(); await reader.read(); assert.ok(openResponse);
    const cancelled = once(openResponse, 'close', { signal: AbortSignal.timeout(3000) });
    await reader.cancel(); await cancelled; streaming = false;
    redirect = true; const redirected = await send(); assert.equal(redirected.status, 502); assert.doesNotMatch(await redirected.text(), /forbidden.invalid/);
    const beforeRevoke = providerBodies.length; allowed = false;
    const denied = await send(); assert.equal(denied.status, 503); assert.match(await denied.text(), /memory_dispatch_context_unavailable/);
    assert.equal((await send()).status, 503); assert.equal(providerBodies.length, beforeRevoke); assert.equal(checks, 6);
    return { status: 'passed', provider: 'synthetic_loopback_anthropic', realProviderCalled: false, goRouting,
      physicalRequestsForwarded: transport.requestCount, admissionChecks: checks, retryAfterDenialBlocked: true,
      invalidCredentialAndPathBlocked: true, boundedBodyRejected: true, cancelledStreamClosed: true, crossOriginRedirectBlocked: true, hostAsyncScopePreserved: true };
  } finally {
    await transport.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
  }
}

/** Uses the actual parent proxy while replacing only its external fetch seam.
 * The requester cannot choose or leak the provider's routing identity. */
export async function checkMemoryModuleT7GoRouting() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    assert.equal(new URL(String(url)).hostname, '127.0.0.1', 'No external network is permitted in this routing regression');
    return originalFetch(url, init);
  }) as typeof fetch;
  try {
    const sessions: string[] = [];
    for (const upstream of ['https://opencode.ai/inference/go/anthropic', 'https://opencode.ai/zen/go', 'https://custom.invalid/zen/go', 'https://opencode.ai.evil.invalid/zen/go']) {
      const seen: Array<{ target: string; headers: Headers }> = []; let checks = 0, allowed = true;
      const transport = await createControlledClaudeTransport({ upstream, apiKey: 'synthetic-only-provider-key', signal: new AbortController().signal,
        beforeRequest: async () => { checks++; if (!allowed) throw Error('synthetic revoked'); },
        forward: async (target, init) => { seen.push({ target: String(target), headers: new Headers(init?.headers) }); return Response.json({ ok: true }); },
      });
      try {
        for (const route of ['/v1/messages', '/v1/messages?beta=true', '/v1/messages/count_tokens']) {
          const response = await fetch(transport.baseUrl + route, { method: 'POST', headers: { 'x-api-key': transport.token,
            'x-opencode-session': 'untrusted-client-session', 'user-agent': 'untrusted-client' }, body: '{"model":"synthetic","messages":[]}' });
          assert.equal(response.status, 200); await response.text();
        }
        assert.equal(checks, 3); assert.equal(seen.length, 3);
        const official = new URL(upstream).hostname === 'opencode.ai';
        for (const sent of seen) {
          assert.equal(sent.headers.get('x-api-key'), 'synthetic-only-provider-key');
          assert.equal(new URL(sent.target).origin, new URL(upstream).origin);
          if (official) {
            assert.match(sent.headers.get('x-opencode-session') ?? '', /^zhiyu-controlled-claude-[a-f0-9-]+$/);
            assert.equal(sent.headers.get('user-agent'), 'zhiyu-agent/0.5.0');
          } else { assert.equal(sent.headers.has('x-opencode-session'), false); assert.equal(sent.headers.has('user-agent'), false); }
        }
        if (official) { assert.equal(new Set(seen.map(item => item.headers.get('x-opencode-session'))).size, 1); sessions.push(seen[0]!.headers.get('x-opencode-session')!); }
        allowed = false;
        const denied = await fetch(transport.baseUrl + '/v1/messages', { method: 'POST', headers: { 'x-api-key': transport.token }, body: '{}' });
        assert.equal(denied.status, 503); await denied.text(); assert.equal(seen.length, 3);
      } finally { await transport.close(); }
    }
    assert.equal(new Set(sessions).size, 2);
    return { passed: true, officialHeadersStableWithinRun: true, distinctRunsIsolated: true, customAndLookalikeUnchanged: true,
      spoofedClientHeadersIgnored: true, revokedBeforeForward: true, realProviderCalled: false };
  } finally { globalThis.fetch = originalFetch; }
}

/** Installed SDK subprocess and real MCP tool/follow-up protocol, connected
 * exclusively to the synthetic loopback Anthropic server. */
export async function checkMemoryModuleT7InstalledSdk(mode: 'normal' | 'plan' | 'deny_initial' | 'deny_followup' | 'deny_retry' | 'retry' | 'compaction' = 'normal') {
  const fixture = await mkdtemp(join(tmpdir(), 'zhiyu-nonpi-sdk-check-'));
  const oldConfig = process.env.CLAUDE_CONFIG_DIR, oldBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
  const providerRequests: Array<{ path: string; payload: Record<string, unknown> }> = [];
  let messageRequests = 0, hookChecks = 0, toolCalls = 0, allowed = mode !== 'deny_initial';
  const sentinels = ['SYNTHETIC_PARENT_CLAUDE_SENTINEL', 'SYNTHETIC_CWD_CLAUDE_SENTINEL', 'SYNTHETIC_GLOBAL_MEMORY_SENTINEL', 'SYNTHETIC_PLUGIN_SENTINEL', 'SYNTHETIC_AGENT_SENTINEL'];
  const provider = createServer(async (request, response) => {
    const parts: Buffer[] = []; for await (const chunk of request) parts.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string, unknown>;
    providerRequests.push({ path: request.url ?? '', payload });
    if (request.url?.includes('count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":32}'); return; }
    messageRequests++;
    if ((mode === 'retry' || mode === 'deny_retry') && messageRequests === 1) {
      if (mode === 'deny_retry') allowed = false;
      response.writeHead(500, { 'content-type': 'application/json', 'retry-after': '0' });
      response.end('{"type":"error","error":{"type":"api_error","message":"synthetic retry"}}'); return;
    }
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    const toolName = tools.map(value => value && typeof value === 'object' ? (value as { name?: unknown }).name : null).find(name => typeof name === 'string' && name.includes('syntheticManagedRead'));
    const content = messageRequests === (mode === 'retry' ? 2 : 1) && typeof toolName === 'string'
      ? [{ type: 'tool_use', id: 'toolu_synthetic', name: toolName, input: {} }]
      : [{ type: 'text', text: mode === 'plan' ? '{"type":"plan","goal":"Read controlled source","steps":[{"id":"read","description":"Read the selected managed source"}]}' : 'Synthetic controlled SDK completed.' }];
    const message = { id: `msg_synthetic_${messageRequests}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content,
      stop_reason: content[0]?.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null,
      usage: { input_tokens: mode === 'compaction' && messageRequests === 1 ? 190000 : 32, output_tokens: 8 } };
    if (!payload.stream) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(message)); return; }
    const event = (name: string, value: unknown) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } }));
    for (const [index, block] of content.entries()) {
      response.write(event('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } }));
      response.write(event('content_block_delta', { type: 'content_block_delta', index, delta: 'text' in block ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: '{}' } }));
      response.write(event('content_block_stop', { type: 'content_block_stop', index }));
    }
    response.write(event('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 8 } }));
    response.end(event('message_stop', { type: 'message_stop' }));
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const oldCwd = join(fixture, 'old-work'), global = join(fixture, 'global');
    await Promise.all([mkdir(join(oldCwd, '.claude', 'agents'), { recursive: true }), mkdir(join(global, 'memory'), { recursive: true }), mkdir(join(oldCwd, '.claude', 'plugins'), { recursive: true })]);
    await Promise.all([writeFile(join(fixture, 'CLAUDE.md'), sentinels[0]!), writeFile(join(oldCwd, 'CLAUDE.md'), sentinels[1]!),
      writeFile(join(global, 'CLAUDE.md'), sentinels[2]!), writeFile(join(global, 'memory', 'MEMORY.md'), sentinels[2]!),
      writeFile(join(oldCwd, '.claude', 'plugins', 'sentinel.md'), sentinels[3]!), writeFile(join(oldCwd, '.claude', 'agents', 'sentinel.md'), sentinels[4]!)]);
    process.env.CLAUDE_CONFIG_DIR = global; process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    const listening = once(provider, 'listening'); provider.listen(0, '127.0.0.1'); await listening;
    const address = provider.address(); assert.ok(address && typeof address !== 'string');
    const abort = new AbortController(); deadline = setTimeout(() => abort.abort(Error('Synthetic SDK deadline exceeded')), 30_000);
    const runtimes: string[] = [], output: string[] = []; let failed: unknown;
    try { for await (const message of controlledClaudeQuery({
      config: { provider: 'claude', model: 'claude-sonnet-4-6', apiKey: 'synthetic-owner-provider-key', baseUrl: `http://127.0.0.1:${address.port}` },
      options: { cwd: oldCwd, sessionId: 'legacy-untrusted-session', skillsConfig: { enabled: true, userDirEnabled: true, appDirEnabled: true },
        mcpConfig: { enabled: true, userDirEnabled: true, appDirEnabled: true }, abortController: abort, stream: true,
        onBeforeProviderRequest: async () => { hookChecks++; if (!allowed) throw Error('Synthetic source or audit unavailable'); }, onRuntimeSelected: runtime => runtimes.push(runtime.adapter),
        runtimeTools: [{ name: 'syntheticManagedRead', label: 'Synthetic managed read', description: 'Read a synthetic source', parameters: Type.Object({}),
          execute: async () => { toolCalls++; if (mode === 'deny_followup') allowed = false; return { content: [{ type: 'text' as const, text: 'SYNTHETIC_MANAGED_TOOL_BODY' }], details: {} }; } }],
      }, prompt: 'Use syntheticManagedRead once, then answer with a short sentence.', plan: mode === 'plan',
    })) output.push(JSON.stringify(message)); } catch (error) { failed = error; }
    const denied = mode.startsWith('deny_');
    if (denied) {
      assert.ok(failed && typeof failed === 'object' && 'code' in failed); assert.equal(failed.code, 'memory_dispatch_context_unavailable', 'cleanupStages' in failed ? JSON.stringify(failed.cleanupStages) : undefined);
      assert.equal(messageRequests, mode === 'deny_initial' ? 0 : 1); assert.equal(hookChecks, providerRequests.length + 1);
      assert.equal(toolCalls, mode === 'deny_followup' ? 1 : 0);
    } else if (mode === 'plan') {
      assert.ifError(failed); assert.equal(messageRequests, 1); assert.equal(toolCalls, 0); assert.equal(hookChecks, providerRequests.length);
    } else {
      assert.ifError(failed); assert.ok(messageRequests >= (mode === 'retry' ? 3 : 2), 'Expected an actual SDK tool-follow-up request'); assert.equal(toolCalls, 1);
      assert.equal(hookChecks, providerRequests.length);
    }
    assert.deepEqual(runtimes, ['claude-sdk-controlled-http']);
    const captured = JSON.stringify(providerRequests);
    for (const sentinel of sentinels) assert.ok(!captured.includes(sentinel), `Unexpected SDK filesystem auto-load: ${sentinel}`);
    if (denied || mode === 'plan') assert.doesNotMatch(captured, /SYNTHETIC_MANAGED_TOOL_BODY/); else assert.match(captured, /SYNTHETIC_MANAGED_TOOL_BODY/);
    for (const request of providerRequests) {
      const tools = Array.isArray(request.payload.tools) ? request.payload.tools : [];
      assert.ok(tools.every(tool => typeof tool === 'object' && tool && String((tool as { name?: string }).name).includes('syntheticManagedRead')), 'Unexpected SDK builtin or dynamic MCP tool');
    }
    if (!denied) assert.ok(output.some(text => text.includes(mode === 'plan' ? 'Read controlled source' : 'Synthetic controlled SDK completed.')));
    const compactionObserved = output.some(text => { const message = JSON.parse(text); return message.type === 'system' && message.subtype === 'compact_boundary'; });
    if (mode === 'compaction') assert.equal(compactionObserved, true, 'Installed SDK did not report actual compaction');
    return { status: 'passed', runtime: 'installed_claude_agent_sdk', realProviderCalled: false, messageRequests, hookChecks, toolCalls,
      mode, compactionObserved, requestBodyCount: providerRequests.length, filesystemSentinelsAbsent: sentinels.length, onlyHostControlledTools: true, oldSessionNotResumed: true };
  } finally {
    if (deadline) clearTimeout(deadline);
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldConfig;
    if (oldBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK; else process.env.CLAUDE_CODE_USE_BEDROCK = oldBedrock;
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    const target = resolve(fixture); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('zhiyu-nonpi-sdk-check-'));
    await rm(target, { recursive: true, force: true });
  }
}
