/** Pure production acceptance boundary tests. No HTTP server, business database, or real provider is used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { digest, BUDGET, childRunId, assertAnchor, httpClient, sourceHashes, buildSnapshot, ownRunEvent, assertProductionPreflight, assertNoCredentialFields } from './prove-memory-continuity-production.mjs';
import { createAuditedFetch, trustedTarget, providerKind, safeResponseSummary, observePersistedRun } from './memory-production-preload.mjs';
import { completedProductionTask, healthyAuxiliaries, exactProductionParent, actualToolHistory, sameActualProductionProvider, eventsBeforeDeadline, executionEventBound } from './verify-memory-continuity-production.mjs';
import { canonicalHash } from './lib/memory-continuity-verification.mjs';

const clone = structuredClone;
function fixture() {
  const identity = { userId: 'owner', workshopId: 'work', loopId: 'loop' };
  const provider = { actualModel: 'model', actualEndpointHash: digest('https://provider.invalid/v1/chat/completions'), protocol: 'openai-completions' };
  const plan = { identity, provider, budget: BUDGET, sourceHashes: {} };
  const lease = { userId: 'owner', workshopId: 'work', runId: 'run', workerId: 'worker', token: 9 };
  const created = Date.now();
  const intent = { round: 'P1', expectedRunId: 'run', planHash: digest(plan), budget: BUDGET, createdAt: new Date(created).toISOString(), deadlineAt: new Date(created + 360_000).toISOString() };
  return { plan, lease, intent };
}
function harness(overrides = {}) {
  const f = fixture(), requests = [], responses = [], calls = [];
  const settings = { plan: f.plan, leaseReader: async () => f.lease, intentReader: run => run === 'run' ? f.intent : undefined, readPrepared: async () => ({ loopRunId: 'run' }),
    countRequests: () => requests.length, recordRequest: (round, index, value) => requests.push(value), recordResponse: (round, index, value) => responses.push(value),
    boot: { bootId: 'boot', pid: 123 }, network: { metadata: { mode: 'default' }, apply: (url, init) => init },
    originalFetch: async (...args) => { calls.push(args); return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'private output' } }], usage: { total_tokens: 5 } }), { status: 200 }); }, ...overrides };
  return { ...f, requests, responses, calls, settings, fetch: createAuditedFetch(settings) };
}
const main = { model: 'model', messages: [{ role: 'user', content: 'private prompt' }], stream: true, tools: [{ function: { name: 'workingMemory' } }] };
const post = payload => ({ method: 'POST', headers: { Authorization: 'Bearer secret-test-only' }, body: JSON.stringify(payload) });

test('deterministic child ID matches independently recomputed version-eight UUID recipe', () => {
  const args = ['a'.repeat(36), 'b'.repeat(36), 'production:P1'];
  const hash = digest(JSON.stringify(['work-command-child.v1', ...args, 'loop-run']));
  assert.equal(childRunId(...args), `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`);
  assert.notEqual(childRunId(...args), childRunId(args[0], args[1], 'production:P2'));
});
test('fixed anchor rejects a different output directory or increased cap', () => {
  const plan = { a: 1 }, anchor = { schemaVersion: 'memory-production-phase-anchor.v1', phase: 'memory-production-20261018', outputDirectory: resolve('fixture'), planHash: digest(plan), budget: BUDGET };
  assert.doesNotThrow(() => assertAnchor(anchor, plan, resolve('fixture')));
  assert.throws(() => assertAnchor(anchor, plan, resolve('another')));
  assert.throws(() => assertAnchor({ ...anchor, budget: { ...BUDGET, maximumRounds: 4 } }, plan, resolve('fixture')));
});
test('real HTTP origin allows loopback3515 and rejects remote, credentials, path, HTTPS ambiguity', () => {
  assert.equal(httpClient('http://127.0.0.1:3515').origin, 'http://127.0.0.1:3515');
  for (const value of ['http://example.com', 'http://user:password@127.0.0.1:3515', 'http://127.0.0.1:3515/path', 'https://127.0.0.1']) assert.throws(() => httpClient(value));
});
test('only exact planned server lease is a trusted target', () => {
  const { plan, lease, intent } = fixture(); assert.equal(trustedTarget(plan, lease, intent), true);
  for (const key of ['userId', 'workshopId', 'runId']) assert.equal(trustedTarget(plan, { ...lease, [key]: 'other' }, intent), false);
  assert.equal(trustedTarget(plan, lease, { ...intent, planHash: 'wrong' }), false);
  assert.equal(trustedTarget(plan, lease, { ...intent, round: 'P4' }), false);
  assert.equal(trustedTarget(plan, undefined, intent), false);
});
test('unrelated owner work or unplanned run fetch is byte-for-byte unchanged and unrecorded', async () => {
  for (const change of [{ userId: 'other' }, { workshopId: 'other' }, { runId: 'other' }]) {
    const f = fixture(), h = harness({ leaseReader: async () => ({ ...f.lease, ...change }) }); const init = post(main);
    await h.fetch('https://provider.invalid/v1/chat/completions', init);
    assert.equal(h.requests.length, 0); assert.equal(h.calls.length, 1); assert.equal(h.calls[0][1], init);
  }
});
test('GET transport preflight bypasses lease and capture and cannot recursively initialize network', async () => {
  const h = harness({ leaseReader: () => { throw Error('should not load'); } });
  await h.fetch('https://provider.invalid/v1/chat/completions', { method: 'HEAD' });
  assert.equal(h.requests.length, 0); assert.equal(h.calls.length, 1);
});
test('non-model JSON tools are neither altered nor budgeted', async () => {
  const h = harness(); await h.fetch('https://example.invalid/page', post({ query: 'source' }));
  assert.equal(h.requests.length, 0); assert.equal(h.calls.length, 1);
});
test('actual payload retained but request headers credentials and fencing token are never captured', async () => {
  const h = harness(); await h.fetch('https://provider.invalid/v1/chat/completions', post(main));
  assert.equal(h.requests.length, 1); assert.deepEqual(h.requests[0].payload, main);
  const recorded = JSON.stringify(h.requests[0]); assert.equal(recorded.includes('secret-test-only'), false); assert.equal(recorded.includes('Authorization'), false);
  assert.equal(h.requests[0].authority.token, undefined); assert.equal(h.requests[0].authority.workerId, 'worker'); assert.equal(h.requests[0].hostPrepared.loopRunId, 'run');
});
test('main actual model drift fails before any provider transmission', async () => {
  const h = harness(); await assert.rejects(h.fetch('https://provider.invalid/v1/chat/completions', post({ ...main, model: 'other' })), /drift/); assert.equal(h.calls.length, 0);
});
test('main actual endpoint drift fails before any provider transmission', async () => {
  const h = harness(); await assert.rejects(h.fetch('https://other.invalid/v1/chat/completions', post(main)), /drift/); assert.equal(h.calls.length, 0);
});
test('missing or different-run persisted host preparation fails before transmission', async () => {
  for (const value of [null, { loopRunId: 'other' }]) {
    const h = harness({ readPrepared: async () => value }); await assert.rejects(h.fetch('https://provider.invalid/v1/chat/completions', post(main)), /preparation/); assert.equal(h.calls.length, 0);
  }
});
test('all auxiliary and main requests share hard ten-request bound before transmission', async () => {
  const h = harness(); for (let i = 0; i < 10; i++) await h.fetch('https://provider.invalid/v1/chat/completions', post(i % 2 ? main : { model: 'aux', messages: [] }));
  await assert.rejects(h.fetch('https://provider.invalid/v1/chat/completions', post(main)), /budget exhausted/); assert.equal(h.calls.length, 10); assert.equal(h.requests.length, 10);
});
test('expired intent deadline stops dispatch and never reports success', async () => {
  const f = fixture(), h = harness({ intentReader: () => ({ ...f.intent, createdAt: '2000-01-01T00:00:00Z', deadlineAt: '2000-01-01T00:06:00Z' }) });
  await assert.rejects(h.fetch('https://provider.invalid/v1/chat/completions', post(main)), /budget/); assert.equal(h.calls.length, 0);
});
test('frozen source drift stops only target before any transmission', async () => {
  const h = harness({ assertFrozen: () => { throw Error('source drift'); } });
  await assert.rejects(h.fetch('https://provider.invalid/v1/chat/completions', post(main)), /source drift/); assert.equal(h.calls.length, 0);
});
test('fetch rejection is preserved with unknown HTTP status and safe error class', async () => {
  const h = harness({ originalFetch: async () => { throw Object.assign(Error('private error'), { name: 'TimeoutError' }); } });
  await assert.rejects(h.fetch('https://provider.invalid/v1/chat/completions', post(main)), /private error/);
  assert.deepEqual(h.responses[0], { responseStatus: null, error: 'TimeoutError', receivedAt: null, responseSummary: null });
});
test('nonstream auxiliary response stores terminal and usage without private output', async () => {
  const h = harness(); await h.fetch('https://provider.invalid/v1/chat/completions', post({ model: 'aux', messages: [] }));
  assert.equal(h.responses[0].responseSummary.finishReasons[0], 'stop'); assert.equal(JSON.stringify(h.responses).includes('private output'), false);
});
test('auxiliary error/length/unknown remains visibly incomplete even HTTP200', () => {
  assert.equal(safeResponseSummary({ choices: [{ finish_reason: 'length' }] }).finishReasons[0], 'length');
  assert.equal(safeResponseSummary({ error: { message: 'private' } }).providerError, true);
  assert.equal(safeResponseSummary({}).stopReason, null);
});
test('planner classified by actual system protocol text rather than round label', () => {
  assert.equal(providerKind(main), 'working-memory-agent');
  assert.equal(providerKind({ messages: [{ role: 'system', content: 'You are the recall planner for a unified memory platform.' }] }), 'recall-planner');
  assert.equal(providerKind({ messages: [] }), 'auxiliary-model');
});

function auxFixture() {
  const provider = { protocol: 'anthropic-messages', finishReason: 'end_turn' };
  const contexts = [{ memoryRecall: { recallPlan: { mode: 'llm', provider } } }];
  const events = [{ type: 'report_quality_review', metadata: { evaluatorMode: 'llm', semanticReviewStatus: 'completed', degraded: false, provider } }];
  const requests = ['recall-planner', 'auxiliary-model'].map(kind => ({ kind, responseStatus: 200, error: null, responseSummary: { validJsonResponse: true, providerError: false, finishReasons: [], stopReason: 'end_turn' } }));
  return { contexts, events, requests };
}
test('actual complete planner and quality receipts plus terminal responses establish auxiliary health', () => { const f = auxFixture(); assert.equal(healthyAuxiliaries(f.contexts, f.events, f.requests), true); });
for (const [name, mutate] of [
  ['planner rule fallback', f => { f.contexts[0].memoryRecall.recallPlan.mode = 'fallback_rules'; }],
  ['quality rule fallback', f => { f.events[0].metadata.evaluatorMode = 'rule_based'; }],
  ['semantic review missing', f => { f.events[0].metadata.semanticReviewStatus = 'not_completed'; }],
  ['planner max_tokens', f => { f.contexts[0].memoryRecall.recallPlan.provider.finishReason = 'max_tokens'; }],
  ['auxiliary HTTP401', f => { f.requests[1].responseStatus = 401; }],
  ['auxiliary TimeoutError', f => { f.requests[0].error = 'TimeoutError'; }],
  ['auxiliary raw length', f => { f.requests[1].responseSummary.stopReason = 'max_tokens'; }],
  ['auxiliary no parsed JSON', f => { f.requests[1].responseSummary.validJsonResponse = false; }],
]) test(`auxiliary health rejects ${name} without hiding task outcome`, () => { const f = auxFixture(); mutate(f); assert.equal(healthyAuxiliaries(f.contexts, f.events, f.requests), false); });

function terminalFixture() {
  const { plan } = fixture(), id = 'run', stamp = '2026-10-18T01:00:00.000Z';
  const terminal = { schemaVersion: 'agent-runtime-terminal.v1', status: 'completed', cleanupStatus: 'completed', completionScope: 'runtime' };
  const events = [{ type: 'agent_runtime_terminal', seq: 1, createdAt: stamp, runId: id, loopRunId: id, workshopId: 'work', loopId: 'loop',
    metadata: { receiptAuthority: 'runtime', ordinal: 1, currentRunId: id, scope: { kind: 'loop', loopId: 'loop' }, runtime: { engine: 'pi', adapter: 'pi-agent-harness', version: '1' }, runtimeTerminal: terminal, execution: { workerId: 'worker', token: 9 } } },
  { type: 'loop_run_completed', seq: 2, createdAt: stamp, loopRunId: id, body: 'actual result', metadata: { status: 'success', execution: { workerId: 'worker' } } },
  { type: 'run_completed', seq: 3, createdAt: stamp, runId: id, body: 'actual result', metadata: { execution: { workerId: 'worker' } } },
  { type: 'execution_claimed', seq: 0, createdAt: stamp, runId: id, metadata: { workerId: 'worker', fencingToken: 9 } },
  { type: 'agent_trace_completed', seq: 1, createdAt: stamp, runId: id, metadata: { runtimeTrace: true, traceType: 'completed', traceStatus: 'completed' } }];
  const trace = { toolCallCount: 2, maxToolCalls: 12, budgetExceeded: false, runtimeTerminal: terminal, runtimeTerminalCount: 1,
    events: [{ type: 'budget_configured', status: 'completed', metadata: { maxToolCalls: 12 } }, { type: 'agent_runtime_terminal', status: 'completed', metadata: { runtimeTerminal: terminal } }, { type: 'completed', status: 'completed' }] };
  const loop = { currentPhase: 'idle', blockedReason: null, stateJson: { lastLoopRunId: id, lastJobStatus: 'success', lastVerificationPassed: true, lastCheckerPassed: true, lastOutcomeAction: 'complete', lastAttemptsUsed: 1 },
    runs: [{ id, status: 'success', verificationPassed: true, checkerAction: 'complete', executionTrace: trace }] };
  const verification = { executionTrace: trace };
  const round = { failure: null, cancellation: null, intent: { expectedRunId: id, binding: { workerInstanceId: 'worker', workerBootId: 'boot', workerPid: 123 } }, events, after: { detail: { data: { loop } } },
    httpDetailTraceIsComplete: false, workerRun: { schemaVersion: 'memory-production-worker-run.v1', runId: id, loopId: 'loop', status: 'success', outputSummary: 'actual result',
      verificationResult: verification, verificationHash: digest(verification), authority: { kind: 'read_only_existing_owner_services_from_observed_server_lease', ...plan.identity, runId: id, workerId: 'worker' },
      bootId: 'boot', pid: 123, planHash: digest(plan), sourceHashes: plan.sourceHashes },
    run: { data: { run: { id, status: 'completed', outputSummary: 'actual result', completedAt: stamp }, truncatedFields: [] } } };
  return { plan, round };
}
test('real production task predicate binds native terminal, persisted output, durable verification and worker lease', () => { const f = terminalFixture(); assert.equal(completedProductionTask(f.round, f.plan), true); });
for (const [name, mutate] of [
  ['HTTP200 without terminal', r => { r.events.shift(); }],
  ['provider raw completed but cleanup missing', r => { delete r.events[0].metadata.runtimeTerminal.cleanupStatus; }],
  ['wrong worker instance', r => { r.events[0].metadata.execution.workerId = 'other'; }],
  ['duplicate terminal', r => { r.events.unshift(clone(r.events[0])); }],
  ['failed durable verification', r => { r.after.detail.data.loop.stateJson.lastVerificationPassed = false; }],
  ['terminal scope beyond runtime', r => { r.events[0].metadata.runtimeTerminal.completionScope = 'session'; }],
  ['truncated persisted output', r => { r.run.data.truncatedFields.push('run.outputSummary'); }],
  ['different persisted output', r => { r.events[1].body = 'copied old result'; }],
  ['tool cap silently raised', r => { r.after.detail.data.loop.runs[0].executionTrace.events[0].metadata.maxToolCalls = 40; }],
  ['second domain attempt', r => { r.after.detail.data.loop.stateJson.lastAttemptsUsed = 2; }],
  ['deadline cancellation unconfirmed', r => { r.cancellation = { requested: true }; }],
]) test(`real task predicate rejects ${name}`, () => { const f = terminalFixture(); mutate(f.round); if (f.round.workerRun) f.round.workerRun.verificationHash = digest(f.round.workerRun.verificationResult); assert.equal(completedProductionTask(f.round, f.plan), false); });

function lineageFixture() {
  const { plan } = fixture(), createdAt = '2026-10-18T01:00:00.000Z', expiresAt = '2026-10-19T01:00:00.000Z';
  const event = { id: 'event', seq: 1, type: 'working_memory_updated', createdAt, metadata: { receiptAuthority: 'runtime', mode: 'apply', status: 'ready_for_projection', version: 1, policyIdentity: { version: '1' }, state: { openQuestions: ['open'] } } };
  const root = { result: { loopRunId: 'root' }, before: { workshopId: 'work' }, events: [event] };
  const checkpoint = { sourceRunId: 'root', checkpointEventId: 'event', version: 1, policyIdentity: { version: '1' }, createdAt, expiresAt,
    chain: { depth: 0, viaRunIds: [], assertionsSuppressed: true, rootHash: canonicalHash({ workshopId: 'work', sourceRunId: 'root', checkpointEventId: 'event', metadata: event.metadata, expiresAt }) }, history: { openQuestions: ['open'] } };
  const previous = { intent: { expectedRunId: 'previous' }, before: { detail: { data: { loop: { stateJson: { lastLoopRunId: 'root' } } } } },
    events: [{ type: 'working_memory_continuity_loaded', seq: 2, metadata: { receiptAuthority: 'runtime', status: 'inherited', currentRunId: 'previous', checkpoint } }] };
  const inherited = clone(checkpoint); inherited.chain.depth++; inherited.chain.viaRunIds.push('previous');
  return { plan, root, previous, checkpoint, inherited, map: new Map([['root', root], ['previous', previous]]) };
}
test('exact lineage independently binds original root and every inherited parent', () => {
  const f = lineageFixture(); assert.equal(exactProductionParent(f.checkpoint, f.root, f.map, f.plan), true); assert.equal(exactProductionParent(f.inherited, f.previous, f.map, f.plan), true);
});
for (const [name, mutate] of [
  ['forged root hash', f => { f.inherited.chain.rootHash = 'forged'; }],
  ['refreshed ancestor TTL', f => { f.inherited.expiresAt = '2026-10-20T01:00:00.000Z'; }],
  ['parent ID merely listed with wrong root', f => { f.inherited.sourceRunId = 'old-failed'; }],
  ['missing actual ancestor', f => { f.map.delete('root'); }],
  ['wrong latest checkpoint event', f => { f.inherited.checkpointEventId = 'other'; }],
]) test(`lineage rejects ${name}`, () => { const f = lineageFixture(); mutate(f); assert.equal(exactProductionParent(f.inherited, f.previous, f.map, f.plan), false); });

test('real production build must include completed BUILD_ID and manifests', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'memory-prod-test-'));
  try { assert.throws(() => buildSnapshot(root)); mkdirSync(resolve(root, 'apps/web/.next'), { recursive: true }); for (const name of ['BUILD_ID', 'required-server-files.json', 'build-manifest.json', 'routes-manifest.json']) writeFileSync(resolve(root, 'apps/web/.next', name), name === 'BUILD_ID' ? 'actual-build-id' : '{}'); assert.equal(buildSnapshot(root).buildId, 'actual-build-id'); }
  finally { rmSync(root, { recursive: true }); }
});
test('production source seal includes new worker scope and auxiliary helper files', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'memory-prod-test-'));
  try { for (const name of ['apps/web/lib/runtime/module-policy.ts', 'apps/web/lib/work-runtime/loop-consumer.ts', 'apps/web/lib/ai/auxiliary-model-connection.ts']) { mkdirSync(resolve(root, name, '..'), { recursive: true }); writeFileSync(resolve(root, name), 'fixture'); }
    const hashes = sourceHashes(root); assert.equal(Object.keys(hashes).length, 3); }
  finally { rmSync(root, { recursive: true }); }
});
test('Messages planner system field is recognized without changing source body', () => {
  const payload = { model: 'aux', system: 'You are the recall planner for a unified memory platform.', messages: [{ role: 'user', content: 'task' }] };
  assert.equal(providerKind(payload), 'recall-planner');
});
test('same actual model with explicit canonical Messages migration keeps exact endpoint and protocol guard', () => {
  const provider = { actualModel: 'qwen-test', actualEndpointHash: digest('https://provider.invalid/v1/messages'), protocol: 'anthropic-messages' };
  const request = { model: 'qwen-test', endpointHash: provider.actualEndpointHash, protocol: 'anthropic-messages' }, payload = { model: 'qwen-test', messages: [] };
  assert.equal(sameActualProductionProvider(payload, request, provider), true);
  assert.equal(sameActualProductionProvider(payload, { ...request, protocol: 'openai-completions' }, provider), false);
  assert.equal(sameActualProductionProvider(payload, { ...request, endpointHash: 'old' }, provider), false);
});
test('Messages actual tool_use and tool_result preserve exact call argument and body identity', () => {
  const value = { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'workshopGetMemoryEvidence', input: { memoryId: 'corrected' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: [{ type: 'text', text: '{"status":"read"}' }] }] }] };
  const normalized = actualToolHistory(value);
  assert.deepEqual(normalized.calls.get('call'), { id: 'call', name: 'workshopGetMemoryEvidence', arguments: { memoryId: 'corrected' } });
  assert.deepEqual(normalized.results[0], { toolCallId: 'call', content: [{ type: 'text', text: '{"status":"read"}' }] });
});
test('ordinary user quoted tool-result text does not become an actual provider tool envelope', () => {
  assert.equal(actualToolHistory({ messages: [{ role: 'user', content: '{"type":"tool_result","tool_use_id":"copied"}' }] }).results.length, 0);
});
test('own-run event binding accepts exact Loop-only scope and specific Work execution lifecycle', () => {
  const identity = { workshopId: 'work', loopId: 'loop' };
  assert.equal(ownRunEvent({ workshopId: 'work', runId: null, loopId: 'loop', loopRunId: 'run', type: 'tool_result' }, identity, 'run'), true);
  assert.equal(ownRunEvent({ workshopId: 'work', runId: 'run', loopId: null, loopRunId: null, type: 'execution_claimed' }, identity, 'run'), true);
  assert.equal(ownRunEvent({ workshopId: 'work', runId: 'run', loopId: 'other', loopRunId: 'run', type: 'tool_result' }, identity, 'run'), false);
  assert.equal(ownRunEvent({ workshopId: 'work', runId: 'other', loopId: 'loop', loopRunId: 'run', type: 'tool_result' }, identity, 'run'), false);
  assert.equal(ownRunEvent({ workshopId: 'work', runId: 'run', loopId: null, loopRunId: null, type: 'tool_result' }, identity, 'run'), false);
});
test('deadline cannot be widened by changing the immutable-looking budget object only', async () => {
  const f = fixture(), h = harness({ intentReader: () => ({ ...f.intent, deadlineAt: new Date(Date.parse(f.intent.createdAt) + 600_000).toISOString() }) });
  await assert.rejects(h.fetch('https://provider.invalid/v1/chat/completions', post(main)), /fixed deadline/); assert.equal(h.calls.length, 0);
});
test('concurrent real target dispatch reservations cannot exceed ten model requests', async () => {
  const h = harness(); const results = await Promise.allSettled(Array.from({ length: 11 }, () => h.fetch('https://provider.invalid/v1/chat/completions', post(main))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 10); assert.equal(h.calls.length, 10);
  assert.equal(new Set(h.requests.map(request => request.index)).size, 10);
});
test('actual persisted terminal completion must fit exact deadline, not audit collection grace', () => {
  const f = terminalFixture(); assert.equal(eventsBeforeDeadline(f.round.events, '2026-10-18T01:00:00.000Z'), true);
  assert.equal(eventsBeforeDeadline(f.round.events, '2026-10-18T00:59:59.999Z'), false);
});
test('full worker trace catches late error beyond first20 presentation steps', () => {
  const f = terminalFixture(), trace = f.round.workerRun.verificationResult.executionTrace;
  trace.events.push(...Array.from({ length: 21 }, () => ({ type: 'tool_result', status: 'completed' })), { type: 'error', status: 'error' });
  f.round.after.detail.data.loop.runs[0].executionTrace = { ...trace, events: trace.events.slice(0, 20) };
  f.round.workerRun.verificationHash = digest(f.round.workerRun.verificationResult);
  assert.equal(completedProductionTask(f.round, f.plan), false);
});
test('HTTP first20 trace cannot substitute for a missing trusted worker complete trace', () => {
  const f = terminalFixture(); delete f.round.workerRun; assert.equal(completedProductionTask(f.round, f.plan), false);
});
test('complete worker trace requires same native terminal count and object as actual audit', () => {
  for (const mutate of [trace => { trace.runtimeTerminalCount = 2; }, trace => { trace.runtimeTerminal = { ...trace.runtimeTerminal, cleanupStatus: 'unknown' }; }]) {
    const f = terminalFixture(); mutate(f.round.workerRun.verificationResult.executionTrace); f.round.workerRun.verificationHash = digest(f.round.workerRun.verificationResult);
    assert.equal(completedProductionTask(f.round, f.plan), false);
  }
});
test('read-only worker observer records full actual persisted verification only after exact owned run finishes', async () => {
  const f = fixture(), records = []; let reads = 0;
  const verificationResult = { executionTrace: { events: Array.from({ length: 25 }, () => ({ type: 'tool_result' })) } };
  await observePersistedRun({ ...f, boot: { bootId: 'boot', pid: 123 }, readOwnedRun: async () => ++reads === 1 ? { id: 'run', loopId: 'loop', status: 'running' }
    : { id: 'run', loopId: 'loop', status: 'success', outputSummary: 'private result', error: null, startedAt: f.intent.createdAt, completedAt: f.intent.createdAt, verificationResult }, sleep: async () => {}, record: value => records.push(value) });
  assert.equal(records.length, 1); assert.equal(records[0].verificationResult.executionTrace.events.length, 25); assert.equal(records[0].authority.workerId, 'worker'); assert.equal(records[0].authority.token, undefined);
});
test('read-only worker observer rejects changed run/Loop scope without a successful artifact', async () => {
  const f = fixture(); let recorded = false;
  await assert.rejects(observePersistedRun({ ...f, boot: {}, readOwnedRun: async () => ({ id: 'other', loopId: 'loop', status: 'success' }), record: () => { recorded = true; } }), /identity/);
  assert.equal(recorded, false);
});
function productionFixture() {
  const modelConfig = {}, goal = 'unchanged goal', loop = { id: 'loop', status: 'active', goal, contextConfig: {}, actionPolicy: {}, approvalPolicy: {}, retryPolicy: {}, triggerConfig: { type: 'manual' } };
  const plan = { identity: { userId: 'owner', workshopId: 'work', loopId: 'loop', goalHash: digest(goal), modelConfigHash: digest(modelConfig), loopConfigurationHash: digest([goal, {}, {}, {}, {}]) },
    correction: { memoryId: 'current', expectedVersion: 'current-version', contentHash: digest('canonical owner content') },
    build: { directory: 'actual-review98', buildId: 'build98', hashes: {} }, sourceHashes: { runtime: 'hash' }, workerPolicy: { modules: ['loop-execution'], workshopIds: ['work'], maxToolCalls: '12' } };
  const snapshot = { origin: 'http://127.0.0.1:3515', observedAt: '2026-10-18T01:00:00.000Z', identity: { data: { actorId: 'owner', mode: 'local_owner' } },
    runtime: { data: { worker: { online: true, state: 'online', configuredMode: 'worker', instanceMode: 'worker', instanceId: 'actual-instance', heartbeatAgeMs: 200, leaseUntil: '2026-10-18T01:00:10.000Z', modules: [{ name: 'loop-execution' }] } } },
    workshop: { data: { workshop: { status: 'active', modelConfig } } }, detail: { data: { loop } }, loops: { data: { loops: [loop] } },
    revision: { data: { memory: { id: 'current', content: 'canonical owner content', confidence: 25, status: 'active' }, expectedVersion: 'current-version' } } };
  const common = { nodeEnv: 'production', planHash: digest(plan), build: plan.build, sourceHashes: plan.sourceHashes, selectedBuildDirectory: plan.build.directory };
  const boots = [{ ...common, role: 'manager', pid: 101, ppid: 0, argv: ['./scripts/start-managed-application.mjs', 'start', '--port', '3515'], bootId: 'manager-boot' },
    { ...common, role: 'web', pid: 102, ppid: 101, bootId: 'web-boot' }, { ...common, role: 'worker', pid: 103, ppid: 101, bootId: 'worker-boot', workerPolicy: plan.workerPolicy }];
  const deployment = { schemaVersion: 'memory-production-deployment.v1', managedCommand: 'native managed web:start', managerPid: 101, webPid: 102, workerPid: 103, listeningPid: 102, port: 3515 };
  return { plan, snapshot, boots, deployment };
}
test('actual production preflight binds manager children, listening PID, selected build, scoped worker and real authenticated identity', () => {
  const f = productionFixture(), proof = assertProductionPreflight(f.plan, f.snapshot, f.deployment, f.boots);
  assert.equal(proof.workerInstanceId, 'actual-instance'); assert.equal(proof.workerBootId, 'worker-boot'); assert.equal(proof.webPid, 102);
});
for (const [name, mutate] of [
  ['different real actor', f => { f.snapshot.identity.data.actorId = 'spoofed'; }],
  ['wrong listening process', f => { f.deployment.listeningPid = 999; }],
  ['wrong port', f => { f.deployment.port = 3000; }],
  ['unrelated web manager', f => { f.boots[1].ppid = 999; }],
  ['valid disk build but wrong selected distDir', f => { f.boots[1].selectedBuildDirectory = 'old-review'; }],
  ['wrong worker scope', f => { f.boots[2].workerPolicy = { ...f.plan.workerPolicy, workshopIds: ['other'] }; }],
  ['tool env default40', f => { f.boots[2].workerPolicy = { ...f.plan.workerPolicy, maxToolCalls: '40' }; }],
  ['unscoped background modules', f => { f.snapshot.runtime.data.worker.modules.push({ name: 'outbox-recovery' }); }],
  ['second Loop inside Work filter', f => { f.snapshot.loops.data.loops.push({ id: 'other' }); }],
  ['expired worker lease', f => { f.snapshot.runtime.data.worker.leaseUntil = '2026-10-18T00:59:59.000Z'; }],
  ['malformed worker lease', f => { f.snapshot.runtime.data.worker.leaseUntil = 'not-a-date'; }],
  ['source receipt drift', f => { f.boots[1].sourceHashes = { runtime: 'other' }; }],
  ['owner feedback confidence raised to score', f => { f.snapshot.revision.data.memory.confidence = 80; }],
  ['stale canonical revision', f => { f.snapshot.revision.data.expectedVersion = 'old-version'; }],
]) test(`production preflight rejects ${name}`, () => { const f = productionFixture(); mutate(f); assert.throws(() => assertProductionPreflight(f.plan, f.snapshot, f.deployment, f.boots)); });
test('HTTP credential fields are never persisted, while numeric fencing identity stays readable', () => {
  assert.throws(() => assertNoCredentialFields({ modelConfig: { apiKey: 'unit-secret' } }), /credential/);
  assert.throws(() => assertNoCredentialFields({ nested: [{ Authorization: 'unit-secret' }] }), /credential/);
  assert.doesNotThrow(() => assertNoCredentialFields({ execution: { token: 9 }, modelConfig: { apiKey: null } }));
});
test('actual Work run-completion source envelope independently binds event run, owner, claim token and worker without a nested runId', () => {
  const source = readFileSync(new URL('../lib/work-runtime/run-completion.ts', import.meta.url), 'utf8');
  assert.match(source, /const execution=input\.lease\?\{token:input\.lease\.token,workerId:input\.lease\.workerId\}:null/);
  const expected = { runId: 'run', workerId: 'worker', fencingToken: 9, userId: 'owner' };
  const event = { type: 'run_completed', runId: 'run', loopId: null, loopRunId: null, metadata: { actorId: 'owner', execution: { token: 9, workerId: 'worker' } } };
  assert.equal(executionEventBound(event, expected), true);
  for (const mutate of [e => { e.metadata.execution.token = 10; }, e => { e.metadata.execution.workerId = 'other'; }, e => { e.runId = 'other'; },
    e => { e.metadata.actorId = 'other'; }, e => { e.metadata.execution.runId = 'other'; }, e => { e.loopId = 'loop'; }]) {
    const wrong = clone(event); mutate(wrong); assert.equal(executionEventBound(wrong, expected), false);
  }
});
test('native Loop execution envelope still requires its exact nested runId and exact claim fencing token', () => {
  const expected = { runId: 'run', workerId: 'worker', fencingToken: 9, userId: 'owner' };
  const event = { type: 'agent_runtime_terminal', runId: 'run', loopId: 'loop', loopRunId: 'run', metadata: { execution: { runId: 'run', workerId: 'worker', token: 9 } } };
  assert.equal(executionEventBound(event, expected), true);
  const missing = clone(event); delete missing.metadata.execution.runId; assert.equal(executionEventBound(missing, expected), false);
  const stale = clone(event); stale.metadata.execution.token = 8; assert.equal(executionEventBound(stale, expected), false);
});
