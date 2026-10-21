import { describe, expect, it, vi } from 'vitest';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createPiMemoryScenarioRunner, hashPiMemoryScenarioToolContract, type PiMemoryScenarioEvent } from '@/lib/harness-evolution/memory-pi-scenario-runner';
import { DEFAULT_WORKING_MEMORY_STRATEGY, resolveWorkingMemoryStrategy } from '@/lib/workshops/working-memory-strategy';
import { sha256Canonical } from '@/lib/harness-evolution/canonical-json';
import { hashFrozenMemorySource } from '@/lib/harness-evolution/memory-scenario-executor';

function fixture(options: { maxCalls?: number; timeoutMs?: number; sourceWarning?: string; persistFailure?: string } = {}) {
  const faux = createFauxCore({});
  const model = faux.getModel();
  const sources = [{ id: 'frozen-1', content: `IMMUTABLE_SOURCE_MARKER ${'facts '.repeat(1200)}`,
    contentHash: '', observedAt: '2026-10-13T00:00:00.000Z', provider: 'frozen-file', warning: options.sourceWarning ?? null }];
  sources[0].contentHash = hashFrozenMemorySource(sources[0].content);
  const runtime = { model: model.id, provider: model.provider,
    sourceSnapshotHash: sha256Canonical(sources.map(({ content: _content, ...metadata }) => metadata)),
    toolContractHash: hashPiMemoryScenarioToolContract(), allowedTools: ['readFrozenSource', 'workingMemory'],
    deniedTools: ['external_send'], budget: { maxModelCalls: options.maxCalls ?? 5, maxTotalTokens: 10000, maxDurationMs: options.timeoutMs ?? 2000 } };
  const policy = structuredClone(DEFAULT_WORKING_MEMORY_STRATEGY);
  const events: PiMemoryScenarioEvent[] = [];
  const persistEvent = vi.fn(async (event: PiMemoryScenarioEvent) => {
    if (event.type === options.persistFailure) throw new Error('Audit unavailable');
    events.push(structuredClone(event));
  });
  const streamFn = vi.fn<StreamFn>((...args) => faux.streamSimple(...args));
  const runner = createPiMemoryScenarioRunner({ model, streamFn, executionKind: 'sdk-test', persistEvent });
  const scenario = { scenarioKey: 'memory-sandbox', name: 'Memory sandbox', mode: 'dry_run' as const, tags: ['memory'],
    riskTier: 'normal' as const, fixtureRef: 'frozen-local-sources', preconditions: {}, taskIntent: 'Read the frozen source and summarize its observed claim.',
    expectedArtifacts: [], hardInvariants: ['no_external_actions'], forbiddenActions: ['external_send'], metrics: ['taskScore'], repetitions: 1,
    timeoutMs: options.timeoutMs ?? 2000, status: 'active' as const };
  const request = { scenario, repetition: 1, runtime, runtimeHash: sha256Canonical(runtime), policy, policyHash: resolveWorkingMemoryStrategy(policy).identity.hash,
    sources, allowExternalActions: false as const };
  const note = { facts: [{ key: 'observed-claim', text: 'The frozen source reports its observed claim.', evidenceIds: ['source-1'] }],
    hypotheses: [], openQuestions: [], nextAction: { text: 'Verify the observed claim.', evidenceIds: ['source-1'] } };
  const call = (name: string, args: Record<string, unknown>, id: string) => fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: 'toolUse' });
  const script = () => faux.setResponses([
    fauxAssistantMessage([fauxThinking('THINKING_MUST_REMAIN'), fauxToolCall('readFrozenSource', { sourceId: 'frozen-1' }, { id: 'source-1' })], { stopReason: 'toolUse' }),
    call('workingMemory', { operation: 'update', commandId: 'memory-edit', expectedVersion: 0, phase: 'LOG', state: note, pruneToolCallIds: ['source-1'] }, 'memory-1'),
    call('workingMemory', { operation: 'read', query: 'observed-claim', maxChars: 512 }, 'memory-2'),
    fauxAssistantMessage('The frozen source reports its claim. [source:frozen-1]'),
  ]);
  return { faux, model, streamFn, runner, request, events, persistEvent, script, call, note };
}

/** Exercises provider-contract admission with an injected stub. It performs no
 * HTTP requests; positive stub usage is only unit-test data, never cost proof. */
function providerContractStub(options: { omitPayload?: boolean; omitCap?: boolean; mutateModel?: boolean; unknownUsage?: boolean } = {}) {
  const f = fixture();
  const model = { ...f.model, id: 'unit-contract-model', provider: 'unit-contract-provider', api: 'openai-completions' as const };
  const runtime = { ...f.request.runtime, model: model.id, provider: model.provider,
    budget: { ...f.request.runtime.budget, maxTotalTokens: 100000 } };
  const streamFn = vi.fn<StreamFn>(async (requestedModel, context, streamOptions) => {
    if (!options.omitPayload) await streamOptions?.onPayload?.({ model: requestedModel.id,
      ...(!options.omitCap ? { max_tokens: streamOptions?.maxTokens } : {}), messages: context.messages },
    options.mutateModel ? { ...requestedModel, id: 'unexpected-model' } : requestedModel);
    const source = f.faux.streamSimple(f.model, context, streamOptions);
    if (!options.unknownUsage) return source;
    const output = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of source) if (event.type !== 'done' && event.type !== 'error') output.push(event);
      const result = { ...await source.result(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      output.push({ type: 'done', reason: result.stopReason as 'stop' | 'length' | 'toolUse', message: result });
      output.end(result);
    })();
    return output;
  });
  const runner = createPiMemoryScenarioRunner({ model, streamFn, executionKind: 'provider', persistEvent: f.persistEvent });
  return { ...f, runner, streamFn, request: { ...f.request, runtime, runtimeHash: sha256Canonical(runtime) } };
}

describe('concrete isolated Pi memory runner (SDK fake, no network or production evidence)', () => {
  it('runs the real Harness with frozen read tools and policy while labeling fake-provider costs as unknown', async () => {
    const f = fixture(); f.script();
    const result = await f.runner.execute(f.request);
    expect(result.warnings).toEqual(['sdk_test_provider_not_production_evidence; simulated usage is excluded from cost metrics.']);
    expect(result).toMatchObject({ status: 'success', loadedPolicyHash: f.request.policyHash, actualRuntimeHash: f.request.runtimeHash,
      sourceRefs: ['frozen-1'], usage: null, output: 'The frozen source reports its claim. [source:frozen-1]' });
    expect(result.warnings).toContain('sdk_test_provider_not_production_evidence; simulated usage is excluded from cost metrics.');
    expect(result.providerRequests).toHaveLength(4);
    expect(result.memoryOperations.map(operation => operation.operation)).toEqual(['update', 'read']);
    expect(result.memoryOperations.every(operation => operation.policyHash === f.request.policyHash && f.events.some(event => event.id === operation.eventId))).toBe(true);
    const last = f.streamFn.mock.calls.at(-1)![1];
    expect(last.tools?.map(tool => tool.name)).toEqual(['readFrozenSource', 'workingMemory']);
    expect(JSON.stringify(last.messages)).toContain('THINKING_MUST_REMAIN');
    expect(JSON.stringify(last.messages)).not.toContain('IMMUTABLE_SOURCE_MARKER');
    expect(f.events.filter(event => event.type === 'working_memory_usage')).toHaveLength(4);
    expect(f.events.every(event => event.metadata.receiptAuthority === 'runtime' && event.metadata.executionKind === 'sdk-test')).toBe(true);
  });

  it('rejects changed source, policy, tools, model and runtime before any provider request', async () => {
    const f = fixture(); f.script();
    const changed = [
      { ...f.request, sources: [{ ...f.request.sources[0], content: 'Changed source' }] },
      { ...f.request, policyHash: 'b'.repeat(64) },
      { ...f.request, runtime: { ...f.request.runtime, toolContractHash: 'b'.repeat(64) } },
      { ...f.request, runtime: { ...f.request.runtime, model: 'other-model' } },
      { ...f.request, runtimeHash: 'b'.repeat(64) },
    ];
    for (const request of changed) await expect(f.runner.execute(request)).rejects.toThrow();
    expect(f.streamFn).not.toHaveBeenCalled();
  });

  it('gives denied priority and keeps paused scenarios paused', async () => {
    const f = fixture();
    const runtime = { ...f.request.runtime, deniedTools: ['workingMemory'] };
    await expect(f.runner.execute({ ...f.request, runtime, runtimeHash: sha256Canonical(runtime) })).rejects.toThrow('denied takes priority');
    await expect(f.runner.execute({ ...f.request, scenario: { ...f.request.scenario, status: 'paused' } })).rejects.toThrow('Paused');
    expect(f.streamFn).not.toHaveBeenCalled();
  });

  it('fences attempted unregistered external actions and returns a blocked trace', async () => {
    const f = fixture();
    f.faux.setResponses([f.call('external_send', { message: 'Must not be sent' }, 'send-1'), fauxAssistantMessage('done')]);
    const result = await f.runner.execute(f.request);
    expect(result.status).toBe('blocked');
    expect(result.actions).toContain('external_send');
    expect(result.sourceRefs).toEqual([]);
    expect(f.events.some(event => event.type === 'source_read')).toBe(false);
  });

  it('stops repeated model requests at the call budget and propagates the actual output limit', async () => {
    const f = fixture({ maxCalls: 2 }); f.script();
    const result = await f.runner.execute(f.request);
    expect(result.status).toBe('failed');
    expect(result.warnings).toContain('model_call_budget_exceeded');
    expect(f.streamFn).toHaveBeenCalledTimes(2);
    expect(f.streamFn.mock.calls.every(([, , options]) => options?.maxTokens && options.maxTokens <= 10000)).toBe(true);
  });

  it('preserves frozen source warnings and declines unsafe projection without losing the evidence-backed notes', async () => {
    const f = fixture({ sourceWarning: 'Direct fallback; redirect destination unverified.' });
    f.faux.setResponses([
      f.call('readFrozenSource', { sourceId: 'frozen-1' }, 'source-1'),
      f.call('workingMemory', { operation: 'update', commandId: 'note-1', expectedVersion: 0, state: f.note, pruneToolCallIds: [] }, 'memory-1'),
      fauxAssistantMessage('Source report remains unverified. [source:frozen-1]'),
    ]);
    const result = await f.runner.execute(f.request);
    expect(result.status).toBe('success');
    const update = f.events.find(event => event.type === 'working_memory_updated')!;
    expect(update.metadata.evidenceCatalog).toEqual([expect.objectContaining({ referenceEligible: true, projectionEligible: false,
      projectionBlockedReasons: ['fallback_warning'] })]);
    expect(JSON.stringify(f.streamFn.mock.calls.at(-1)![1])).toContain('IMMUTABLE_SOURCE_MARKER');
    expect(JSON.stringify(f.streamFn.mock.calls.at(-1)![1])).toContain('Direct fallback; redirect destination unverified.');
  });

  it('retains the source body when the edit audit fails and records the rejection', async () => {
    const f = fixture({ persistFailure: 'working_memory_updated' }); f.script();
    const result = await f.runner.execute(f.request);
    expect(result.memoryOperations.some(operation => operation.operation === 'update')).toBe(false);
    expect(f.events.find(event => event.type === 'working_memory_rejected')?.metadata.code).toBe('audit_failed');
    expect(JSON.stringify(f.streamFn.mock.calls.at(-1)![1])).toContain('IMMUTABLE_SOURCE_MARKER');
  });

  it('responds to cancellation and leaves no successful final trace', async () => {
    const f = fixture();
    const controller = new AbortController(); controller.abort();
    await expect(f.runner.execute({ ...f.request, signal: controller.signal })).rejects.toThrow();
    expect(f.streamFn).not.toHaveBeenCalled();
  });

  it('times out an abort-ignoring SDK stub and reports incomplete cleanup instead of hanging indefinitely', async () => {
    const f = fixture({ timeoutMs: 30 });
    const runner = createPiMemoryScenarioRunner({ model: f.model, streamFn: () => new Promise(() => undefined),
      executionKind: 'sdk-test', persistEvent: f.persistEvent });
    const result = await runner.execute(f.request);
    expect(result.status).toBe('timeout');
    expect(result.usage).toBeNull();
    expect(result.warnings).toContain('duration_budget_exceeded');
    expect(result.warnings).toContain('Provider cancellation cleanup is incomplete; usage may be unknown.');
    expect(result.durationMs).toBeLessThan(1600);
  });

  it('keeps a declared Faux model as SDK-only even when the caller labels its execution provider', async () => {
    const f = fixture(); f.script();
    const runner = createPiMemoryScenarioRunner({ model: f.model, streamFn: f.streamFn, executionKind: 'provider', persistEvent: f.persistEvent });
    const result = await runner.execute(f.request);
    expect(result.usage).toBeNull();
    expect(result.warnings).toContain('sdk_test_provider_not_production_evidence; simulated usage is excluded from cost metrics.');
  });
});

describe('provider-contract stub tests (no network, not production evidence)', () => {
  it('hashes only observed provider payloads and accounts reported SDK fields without storing source bodies', async () => {
    const f = providerContractStub(); f.script();
    const result = await f.runner.execute(f.request);
    expect(result.status).toBe('success');
    expect(result.providerRequests).toHaveLength(4);
    expect(result.providerRequests.every(receipt => /^[a-f0-9]{64}$/.test(receipt.payloadHash) && receipt.model === 'unit-contract-model')).toBe(true);
    expect(result.usage).toMatchObject({ source: 'sdk', completeness: 'complete' });
    expect(result.usage!.totalTokens).toBeGreaterThan(0);
    expect(f.events.filter(event => event.type === 'provider_request_prepared').every(event => event.metadata.payloadSource === 'sdk_provider_payload')).toBe(true);
    expect(JSON.stringify(f.events)).not.toContain('IMMUTABLE_SOURCE_MARKER');
  });

  it('declines a missing actual payload hook and keeps cost completeness unknown', async () => {
    const f = providerContractStub({ omitPayload: true }); f.script();
    const result = await f.runner.execute(f.request);
    expect(result.status).toBe('failed');
    expect(result.providerRequests).toEqual([]);
    expect(result.usage?.completeness).toBe('partial');
    expect(result.warnings).toContain('Actual provider payload was not observed for every dispatch.');
  });

  it('blocks an unobserved output grant or actual model drift before accepting a provider payload', async () => {
    for (const options of [{ omitCap: true }, { mutateModel: true }]) {
      const f = providerContractStub(options); f.script();
      const result = await f.runner.execute(f.request);
      expect(result.status).toBe('failed');
      expect(result.providerRequests).toEqual([]);
      expect(result.sourceRefs).toEqual([]);
      expect(f.events.some(event => event.type === 'source_read')).toBe(false);
    }
  });

  it('does not dispatch another actual request after unknown SDK usage and retains partial cost status', async () => {
    const f = providerContractStub({ unknownUsage: true }); f.script();
    const result = await f.runner.execute(f.request);
    expect(f.streamFn).toHaveBeenCalledOnce();
    expect(result.providerRequests).toHaveLength(1);
    expect(result.status).toBe('failed');
    expect(result.usage).toMatchObject({ completeness: 'partial' });
    expect(result.warnings).toContain('actual_usage_unknown_before_next_request');
  });
});
