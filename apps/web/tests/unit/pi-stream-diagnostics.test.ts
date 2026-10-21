import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPiAgentRuntime } from '@openzhiyu/ai/agent/runtime';
import { mapPiEvent } from '@openzhiyu/ai/agent/runtime/pi-agent-adapter';
import { createPiStreamDiagnostics, observePiStreamFn } from '@openzhiyu/ai/agent/runtime/pi-stream-diagnostics';
import type { AgentMessage } from '@openzhiyu/ai/agent/types';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, Type } from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

async function collect(source: AsyncGenerator<AgentMessage>) {
  const messages: AgentMessage[] = [];
  for await (const message of source) messages.push(message);
  return messages;
}

function fixture(adapter: 'harness' | 'agent' = 'harness') {
  const faux = createFauxCore({});
  const streamFn = vi.fn<StreamFn>(async (...args) => faux.streamSimple(...args));
  return { faux, streamFn, runtime: createPiAgentRuntime({ adapter, model: faux.getModel(), streamFn }) };
}

afterEach(() => vi.restoreAllMocks());

describe('Pi provider stream diagnostics', () => {
  it('observes the inner SDK token parameter while preserving an unknown outer option', async () => {
    const host = new AbortController(), recorder = createPiStreamDiagnostics(host.signal);
    const model = { ...createFauxCore({}).getModel(), maxTokens: 2200 };
    const receipt = fauxAssistantMessage('local fixture');
    const underlying: StreamFn = async (innerModel, _context, options) => {
      const parameters = { max_tokens: innerModel.maxTokens, messages: ['private-prompt'], headers: { authorization: 'private-key' } };
      expect(await options?.onPayload?.(parameters, innerModel)).toBeUndefined();
      const source = createAssistantMessageEventStream();
      source.push({ type: 'done', reason: 'stop', message: receipt }); source.end(receipt);
      return source;
    };
    const output = observePiStreamFn(underlying, host.signal, recorder)(model, { messages: [] });
    for await (const _event of output) { /* Drain only the local fixture stream. */ }
    expect(await output.result()).toBe(receipt);
    const invocation = recorder.snapshot()?.invocations[0];
    expect(invocation?.contextReceipt?.configuredMaxOutputTokens).toEqual({ value: null, source: 'unknown' });
    expect(invocation?.sdkRequestParameters).toMatchObject({
      schemaVersion: 'pi-sdk-request-parameters.v1', source: 'sdk_request_parameters', state: 'observed',
      totalCallbacks: 1, omittedCallbacks: 0, maximumRetainedCallbacks: 4, observerFailures: 0,
      callbacks: [{ callback: 1, outcome: 'observed', tokenParameters: [{ field: 'max_tokens', value: 2200 }] }],
    });
    expect(JSON.stringify(invocation?.sdkRequestParameters)).not.toMatch(/private-|messages|headers|authorization|prompt|https:/);
  });

  it.each(['mutate', 'replace', 'reject'] as const)('preserves an asynchronous original payload hook that will %s', async (mode) => {
    const host = new AbortController(), recorder = createPiStreamDiagnostics(host.signal);
    const model = createFauxCore({}).getModel(), receipt = fauxAssistantMessage('local fixture');
    const payload = { max_tokens: 2200 }, replacement = { max_output_tokens: 3300 };
    const failure = new Error('original hook rejected');
    const receiver = { receiver: true };
    const hook = vi.fn(async function (this: unknown, input: unknown) {
      expect(this).toBe(receiver); expect(input).toBe(payload);
      await Promise.resolve();
      if (mode === 'reject') throw failure;
      if (mode === 'replace') return replacement;
      payload.max_tokens = 1100;
      return undefined;
    });
    const underlying: StreamFn = async (innerModel, _context, options) => {
      const result = await options!.onPayload!.call(receiver, payload, innerModel);
      expect(result).toBe(mode === 'replace' ? replacement : undefined);
      const source = createAssistantMessageEventStream();
      source.push({ type: 'done', reason: 'stop', message: receipt }); source.end(receipt);
      return source;
    };
    const output = observePiStreamFn(underlying, host.signal, recorder)(model, { messages: [] }, { onPayload: hook });
    for await (const _event of output) { /* Drain only the local fixture stream. */ }
    const result = await output.result(), invocation = recorder.snapshot()!.invocations[0]!;
    expect(hook).toHaveBeenCalledOnce();
    if (mode === 'reject') {
      expect(result.stopReason).toBe('error'); expect(result.errorMessage).toBe(failure.message);
      expect(invocation.stages.at(-1)?.outcome).toBe('failed');
      expect(invocation.sdkRequestParameters).toMatchObject({ state: 'unknown',
        callbacks: [{ outcome: 'hook_rejected', tokenParameters: [] }] });
    } else {
      expect(result).toBe(receipt);
      expect(invocation.sdkRequestParameters?.callbacks[0]?.tokenParameters).toEqual(mode === 'replace'
        ? [{ field: 'max_output_tokens', value: 3300 }] : [{ field: 'max_tokens', value: 1100 }]);
    }
  });

  it('keeps unreached, unsafe, ambiguous and inaccessible payload parameters explicit', async () => {
    const host = new AbortController(), recorder = createPiStreamDiagnostics(host.signal);
    const model = createFauxCore({}).getModel(), receipt = fauxAssistantMessage('local fixture');
    const getter = vi.fn(() => { throw new Error('private getter'); });
    const payloads = [
      { max_tokens: '2200', max_output_tokens: Infinity, max_completion_tokens: -1 },
      Object.defineProperty({}, 'max_tokens', { get: getter }),
      { max_tokens: 2200, max_completion_tokens: 2200 },
      new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private proxy'); } }),
    ];
    const stream = observePiStreamFn(async (innerModel, _context, options) => {
      for (const payload of payloads) expect(await options!.onPayload!(payload, innerModel)).toBeUndefined();
      const source = createAssistantMessageEventStream();
      source.push({ type: 'done', reason: 'stop', message: receipt }); source.end(receipt);
      return source;
    }, host.signal, recorder);
    const output = stream(model, { messages: [] });
    for await (const _event of output) { /* Drain the local fixture stream. */ }
    expect(await output.result()).toBe(receipt);
    expect(recorder.snapshot()?.invocations[0]?.sdkRequestParameters).toMatchObject({ state: 'unknown', observerFailures: 1,
      callbacks: [{ outcome: 'unknown', tokenParameters: [] }, { outcome: 'unknown', tokenParameters: [] },
        { outcome: 'ambiguous', tokenParameters: [{ field: 'max_tokens', value: 2200 }, { field: 'max_completion_tokens', value: 2200 }] },
        { outcome: 'observer_error', tokenParameters: [] }] });
    expect(getter).not.toHaveBeenCalled();
    const unreached = observePiStreamFn(async () => {
      const source = createAssistantMessageEventStream(); source.push({ type: 'done', reason: 'stop', message: receipt }); source.end(receipt); return source;
    }, host.signal, recorder)(model, { messages: [] });
    for await (const _event of unreached) { /* Drain the local fixture stream. */ }
    await unreached.result();
    expect(recorder.snapshot()?.invocations[1]?.sdkRequestParameters).toMatchObject({ state: 'unknown', totalCallbacks: 0, callbacks: [] });
    expect(JSON.stringify(recorder.snapshot())).not.toMatch(/private|2200"|Infinity|proxy|getter/);
  });

  it('bounds callback receipts and deep copies token parameters without retaining payload references', async () => {
    const host = new AbortController(), recorder = createPiStreamDiagnostics(host.signal);
    const model = createFauxCore({}).getModel(), receipt = fauxAssistantMessage('local fixture');
    const payload = { max_tokens: 2200 };
    const output = observePiStreamFn(async (innerModel, _context, options) => {
      for (let index = 0; index < 9; index++) await options!.onPayload!(payload, innerModel);
      payload.max_tokens = 999;
      const source = createAssistantMessageEventStream(); source.push({ type: 'done', reason: 'stop', message: receipt }); source.end(receipt); return source;
    }, host.signal, recorder)(model, { messages: [] });
    for await (const _event of output) { /* Drain the local fixture stream. */ }
    await output.result();
    const snapshot = recorder.snapshot()!, parameters = snapshot.invocations[0]!.sdkRequestParameters!;
    expect(parameters).toMatchObject({ state: 'partial', totalCallbacks: 9, omittedCallbacks: 5, maximumRetainedCallbacks: 4 });
    expect(parameters.callbacks.map(callback => callback.callback)).toEqual([6, 7, 8, 9]);
    expect(parameters.callbacks.every(callback => callback.tokenParameters[0]?.value === 2200)).toBe(true);
    parameters.callbacks[0]!.tokenParameters[0]!.value = 777;
    expect(recorder.snapshot()?.invocations[0]?.sdkRequestParameters?.callbacks[0]?.tokenParameters[0]?.value).toBe(2200);
  });

  it('binds overlapping payload callbacks to their invocation and ignores commitments after terminal', async () => {
    const host = new AbortController(), recorder = createPiStreamDiagnostics(host.signal);
    const model = createFauxCore({}).getModel(), receipt = fauxAssistantMessage('local fixture');
    let release!: () => void, ready!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { ready = resolve; });
    const original = async (payload: unknown) => { if ((payload as { max_tokens: number }).max_tokens === 1100) { ready(); await waiting; } return undefined; };
    const stream = observePiStreamFn(async (innerModel, context, options) => {
      await options!.onPayload!({ max_tokens: context.messages.length ? 2200 : 1100 }, innerModel);
      const source = createAssistantMessageEventStream(); source.push({ type: 'done', reason: 'stop', message: receipt }); source.end(receipt); return source;
    }, host.signal, recorder);
    const first = stream(model, { messages: [] }, { onPayload: original });
    await started;
    const second = stream(model, { messages: [{ role: 'user', content: 'local', timestamp: 1 }] }, { onPayload: original });
    for await (const _event of second) { /* Complete the second local fixture first. */ }
    await second.result(); release();
    for await (const _event of first) { /* Then complete the first fixture. */ }
    await first.result();
    expect(recorder.snapshot()?.invocations.map(invocation => invocation.sdkRequestParameters?.callbacks[0]?.tokenParameters[0]?.value)).toEqual([1100, 2200]);
    let lateHook: ((payload: unknown, payloadModel: typeof model) => unknown) | undefined;
    const late = observePiStreamFn(async (_model, _context, options) => {
      lateHook = options!.onPayload;
      const source = createAssistantMessageEventStream(); source.push({ type: 'done', reason: 'stop', message: receipt }); source.end(receipt); return source;
    }, host.signal, recorder)(model, { messages: [] });
    for await (const _event of late) { /* Settle before the late callback. */ }
    await late.result(); await lateHook!({ max_tokens: 3300 }, model);
    expect(recorder.snapshot()?.invocations[2]?.sdkRequestParameters).toMatchObject({ state: 'unknown', callbacks: [{ outcome: 'after_terminal', tokenParameters: [] }] });
  });

  it.each(['error', 'aborted'] as const)('maps an empty or partial %s message_end to error', (stopReason) => {
    for (const text of ['', 'unfinished draft']) {
      const message = fauxAssistantMessage(text, { stopReason, errorMessage: 'original failure' });
      const mapped = mapPiEvent({ type: 'message_end', message });
      expect(mapped).toContainEqual(expect.objectContaining({ type: 'error', message: 'original failure' }));
      expect(mapped.some(event => event.type === 'result')).toBe(false);
    }
  });

  it('retains safe thrown timeout metadata before SDK text conversion, with no retry', async () => {
    const { runtime, streamFn } = fixture();
    const failure = Object.assign(new Error('Request timed out.'), {
      name: 'APIConnectionTimeoutError', code: 'ETIMEDOUT', status: 408,
      cause: { name: 'TimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT', message: 'secret-cause', headers: { authorization: 'secret-key' } },
      endpoint: 'https://secret-endpoint', context: 'secret-prompt', response: 'secret-response',
    });
    streamFn.mockRejectedValue(failure);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'private prompt' }));
    const error = messages.find(message => message.type === 'error');
    expect(error?.message).toBe('Request timed out.');
    expect(error?.providerStreamDiagnostics).toMatchObject({
      scope: 'provider_stream_invocation', totalInvocations: 1, omittedInvocations: 0,
      invocations: [{ invocation: 1, firstEventReceived: false, stages: [
        { stage: 'request_start', elapsedMs: 0, signalAborted: false, controllerAborted: false },
        { stage: 'error', phase: 'stream_open', error: { name: 'APIConnectionTimeoutError', code: 'ETIMEDOUT', status: 408, causeName: 'TimeoutError', causeCode: 'UND_ERR_CONNECT_TIMEOUT' } },
        { stage: 'terminal', outcome: 'failed' },
      ] }],
    });
    const serialized = JSON.stringify(error?.providerStreamDiagnostics);
    expect(serialized).not.toMatch(/secret|private prompt|https:|authorization|stack|endpoint|response|headers/);
    expect(streamFn).toHaveBeenCalledOnce();
    expect(messages.filter(message => message.type === 'error')).toHaveLength(1);
    expect(messages.filter(message => message.type === 'runtime_terminal')).toHaveLength(1);
    expect(messages.some(message => message.type === 'result')).toBe(false);
    expect(messages.at(-2)?.providerStreamDiagnostics).toEqual(error?.providerStreamDiagnostics);
  });

  it('observes first provider event and successful stream completion without changing results', async () => {
    const { runtime, streamFn, faux } = fixture();
    faux.setResponses([fauxAssistantMessage('finished')]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'normal' }));
    expect(messages).toContainEqual(expect.objectContaining({ type: 'result', content: 'finished', answerPhase: 'candidate_final' }));
    expect(messages.some(message => message.type === 'error')).toBe(false);
    const invocation = messages.at(-2)?.providerStreamDiagnostics?.invocations[0];
    expect(invocation).toMatchObject({ invocation: 1, firstEventReceived: true, stages: [
      { stage: 'request_start', elapsedMs: 0 }, { stage: 'first_event' }, { stage: 'terminal', outcome: 'completed' },
    ] });
    expect(invocation?.stages.every(stage => Number.isFinite(stage.elapsedMs) && stage.elapsedMs >= 0)).toBe(true);
    expect(streamFn).toHaveBeenCalledOnce();
  });

  it('records SDK-reported usage and local configuration without retaining context or inferring a provider limit', async () => {
    const host = new AbortController();
    const recorder = createPiStreamDiagnostics(host.signal);
    const model = { ...createFauxCore({}).getModel(), contextWindow: 32768, headers: { authorization: 'private-key' } };
    const context = { systemPrompt: 'private-system', messages: [{ role: 'user' as const, content: 'private-user', timestamp: 1 }] };
    const receipt = fauxAssistantMessage('private-answer');
    receipt.usage = { input: 123, output: 45, cacheRead: 17, cacheWrite: 3, totalTokens: 188, reasoning: 9,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const underlying = vi.fn<StreamFn>(async () => ({
      async *[Symbol.asyncIterator]() { yield { type: 'done', reason: 'stop', message: receipt }; },
      result: async () => receipt,
    } as unknown as ReturnType<typeof createAssistantMessageEventStream>));
    const output = observePiStreamFn(underlying, host.signal, recorder)(model, context, { maxTokens: 2048 });
    for await (const _event of output) { /* Drain the local SDK stream. */ }
    expect(await output.result()).toEqual(receipt);
    expect(underlying.mock.calls[0]?.[1]).toBe(context);
    expect(recorder.snapshot()?.invocations[0]?.contextReceipt).toEqual({
      schemaVersion: 'pi-context-receipt.v1',
      configuredContextWindow: { value: 32768, source: 'local_model_config' },
      configuredMaxOutputTokens: { value: 2048, source: 'stream_options' },
      sdkInput: { serializedCharacters: JSON.stringify(context).length, characterUnit: 'utf16', messages: 1, tools: null },
      usage: { status: 'reported', source: 'sdk_result', inputTokens: 123, outputTokens: 45, cacheReadTokens: 17,
        cacheWriteTokens: 3, totalTokens: 188, reasoningTokens: 9 },
      stopReason: 'stop', providerContextLimit: null, tokenizer: 'unknown', tokenEstimate: null,
      truncation: 'unknown', compaction: 'unknown', evidenceIds: 'unknown',
    });
    expect(JSON.stringify(recorder.snapshot())).not.toMatch(/private-|authorization|headers|baseUrl|content/);
  });

  it('keeps missing, unsafe or inaccessible usage unknown and snapshots independent', () => {
    const controller = new AbortController(), recorder = createPiStreamDiagnostics(controller.signal);
    const cyclicContext: Record<string, unknown> = {}; cyclicContext.self = cyclicContext;
    const invocation = recorder.start(controller.signal, { model: { contextWindow: Infinity }, context: cyclicContext,
      options: { maxTokens: -1 } });
    invocation.result({ usage: { input: 0, output: -1, cacheRead: NaN, cacheWrite: Number.MAX_SAFE_INTEGER + 1,
      get totalTokens() { throw new Error('private usage'); } }, stopReason: 'private-stop-reason' });
    invocation.finish();
    const snapshot = recorder.snapshot()!;
    expect(snapshot.invocations[0]?.contextReceipt).toMatchObject({
      configuredContextWindow: { value: null, source: 'unknown' }, configuredMaxOutputTokens: { value: null, source: 'unknown' },
      sdkInput: { serializedCharacters: null, messages: null, tools: null }, stopReason: 'unknown',
      usage: { status: 'unknown', source: 'unknown', inputTokens: null, outputTokens: null, cacheReadTokens: null,
        cacheWriteTokens: null, totalTokens: null, reasoningTokens: null },
    });
    snapshot.invocations[0]!.contextReceipt!.usage.inputTokens = 999;
    expect(recorder.snapshot()?.invocations[0]?.contextReceipt?.usage.inputTokens).toBeNull();
    expect(JSON.stringify(recorder.snapshot())).not.toContain('private');
  });

  it.each(['error', 'aborted', 'length', 'stop', 'receipt_only_eof'] as const)(
    'keeps SDK default all-zero usage unknown for %s without inferring zero cost', async (kind) => {
      const controller = new AbortController(), recorder = createPiStreamDiagnostics(controller.signal);
      const model = createFauxCore({}).getModel();
      const reason = kind === 'receipt_only_eof' ? 'stop' : kind;
      const receipt = fauxAssistantMessage('local partial response', { stopReason: reason });
      expect(receipt.usage).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
      const output = observePiStreamFn(async () => ({
        async *[Symbol.asyncIterator]() {
          if (kind === 'error' || kind === 'aborted') yield { type: 'error', reason, error: receipt };
          else if (kind !== 'receipt_only_eof') yield { type: 'done', reason, message: receipt };
        },
        result: async () => receipt,
      } as unknown as ReturnType<typeof createAssistantMessageEventStream>), controller.signal, recorder)(model, { messages: [] });
      for await (const _event of output) { /* Offline SDK fixture only. */ }
      await output.result();
      const usage = recorder.snapshot()?.invocations[0]?.contextReceipt?.usage;
      expect(usage).toEqual({ status: 'unknown', source: 'unknown', inputTokens: null, outputTokens: null,
        cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, reasoningTokens: null });
      expect(JSON.stringify(usage)).not.toMatch(/cost|billing/);
    },
  );

  it.each(['error', 'length'] as const)('preserves actually positive partial usage on %s without filling absent fields', reason => {
    const controller = new AbortController(), recorder = createPiStreamDiagnostics(controller.signal);
    const invocation = recorder.start(controller.signal, { model: {}, context: {}, options: {} });
    invocation.result({ stopReason: reason, usage: { input: 88, cacheRead: 0, reasoning: 2,
      cost: { total: 0 } } });
    invocation.finish(reason);
    expect(recorder.snapshot()?.invocations[0]?.contextReceipt?.usage).toEqual({ status: 'partial', source: 'sdk_result',
      inputTokens: 88, outputTokens: null, cacheReadTokens: 0, cacheWriteTokens: null, totalTokens: null, reasoningTokens: 2 });
  });

  it('does not record synthetic zero usage when opening the provider stream fails', async () => {
    const { runtime, streamFn } = fixture();
    streamFn.mockRejectedValue(new Error('provider unavailable'));
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'private request' }));
    expect(messages.find(message => message.type === 'error')?.providerStreamDiagnostics?.invocations[0]?.contextReceipt).toMatchObject({
      usage: { status: 'unknown', source: 'unknown', inputTokens: null, outputTokens: null, totalTokens: null }, stopReason: 'unknown',
    });
  });

  it('reports actual SDK usage in the agent rollback adapter', async () => {
    const { runtime, streamFn } = fixture('agent');
    const receipt = fauxAssistantMessage('local completed answer');
    receipt.usage.input = 11; receipt.usage.output = 4; receipt.usage.totalTokens = 15;
    streamFn.mockImplementation(async () => ({
      async *[Symbol.asyncIterator]() { yield { type: 'done', reason: 'stop', message: receipt }; },
      result: async () => receipt,
    } as unknown as ReturnType<typeof createAssistantMessageEventStream>));
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'local fixture' }));
    expect(messages.find(message => message.type === 'result')?.providerStreamDiagnostics?.invocations[0]?.contextReceipt?.usage)
      .toMatchObject({ status: 'reported', source: 'sdk_result', inputTokens: 11, outputTokens: 4, totalTokens: 15 });
    expect(streamFn).toHaveBeenCalledOnce();
  });

  it.each(['harness', 'agent'] as const)('surfaces SDK error events with partial text for %s', async (adapter) => {
    const { runtime, streamFn, faux } = fixture(adapter);
    faux.setResponses([fauxAssistantMessage('partial answer', { stopReason: 'error', errorMessage: 'SDK stream error' })]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'fail in stream' }));
    const error = messages.find(message => message.type === 'error');
    expect(error?.message).toBe('SDK stream error');
    expect(error?.providerStreamDiagnostics?.invocations[0]).toMatchObject({ firstEventReceived: true, stages: [
      { stage: 'request_start' }, { stage: 'first_event' }, { stage: 'error', phase: 'stream_event', errorMetadataStatus: 'not_exposed' }, { stage: 'terminal', outcome: 'failed' },
    ] });
    expect(messages.some(message => message.type === 'result')).toBe(false);
    expect(messages.filter(message => message.type === 'done')).toHaveLength(1);
    expect(streamFn).toHaveBeenCalledOnce();
  });

  it.each(['stream_iteration', 'stream_result'] as const)('distinguishes %s rejection', async (phase) => {
    const { runtime, streamFn } = fixture();
    const source = {
      async *[Symbol.asyncIterator]() {
        if (phase === 'stream_iteration') throw Object.assign(new Error('stream failed'), { code: 'ECONNRESET' });
      },
      result: async () => { throw Object.assign(new Error('stream failed'), { code: 'ECONNRESET' }); },
    } as unknown as ReturnType<typeof createAssistantMessageEventStream>;
    streamFn.mockResolvedValue(source);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'fail after opening' }));
    expect(messages.find(message => message.type === 'error')?.providerStreamDiagnostics?.invocations[0]?.stages).toContainEqual(
      expect.objectContaining({ stage: 'error', phase, error: { name: 'Error', code: 'ECONNRESET' } }),
    );
    expect(messages.filter(message => message.type === 'runtime_terminal')).toHaveLength(1);
    expect(messages.at(-2)?.runtimeTerminal?.status).toBe('failed');
    expect(streamFn).toHaveBeenCalledOnce();
  });

  it('records actual abort signals and isolates the following run', async () => {
    const { runtime, streamFn, faux } = fixture();
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    streamFn.mockImplementationOnce(async (_model, _context, options) => {
      started();
      await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      throw Object.assign(new Error('original aborted'), { name: 'AbortError' });
    });
    const pending = collect(runtime.run({ operation: 'run', prompt: 'wait', options: { abortController: controller } }));
    await ready;
    controller.abort();
    const messages = await pending;
    const stages = messages.find(message => message.type === 'error')?.providerStreamDiagnostics?.invocations[0]?.stages;
    expect(stages).toContainEqual(expect.objectContaining({ stage: 'error', signalAborted: true, controllerAborted: true, error: { name: 'AbortError' } }));
    expect(messages.at(-2)?.runtimeTerminal?.status).toBe('aborted');
    faux.setResponses([fauxAssistantMessage('fresh')]);
    const next = await collect(runtime.run({ operation: 'run', prompt: 'fresh' }));
    expect(next.at(-2)?.providerStreamDiagnostics).toMatchObject({ totalInvocations: 1, invocations: [{ invocation: 1 }] });
    expect(JSON.stringify(next.at(-2)?.providerStreamDiagnostics)).not.toContain('AbortError');
  });

  it('does not turn a done event into success before result() resolves', async () => {
    const { runtime, streamFn } = fixture();
    const message = fauxAssistantMessage('apparently complete');
    streamFn.mockResolvedValue({
      async *[Symbol.asyncIterator]() { yield { type: 'done', reason: 'stop', message }; },
      result: async () => { await Promise.resolve(); throw new Error('terminal result rejected'); },
    } as unknown as ReturnType<typeof createAssistantMessageEventStream>);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'result failure' }));
    expect(messages.find(event => event.type === 'error')?.message).toBe('terminal result rejected');
    expect(messages.find(event => event.type === 'error')?.providerStreamDiagnostics?.invocations[0]?.stages).toContainEqual(
      expect.objectContaining({ stage: 'error', phase: 'stream_result' }),
    );
    expect(messages.some(event => event.type === 'result')).toBe(false);
    expect(messages.at(-2)?.runtimeTerminal?.status).toBe('failed');
    expect(messages.filter(event => event.type === 'runtime_terminal')).toHaveLength(1);
  });

  it('keeps 21 recent invocations, four stages each, independent snapshots and duplicate terminal safety', () => {
    const controller = new AbortController();
    const recorder = createPiStreamDiagnostics(controller.signal);
    for (let index = 0; index < 30; index++) {
      const invocation = recorder.start(controller.signal);
      invocation.firstEvent(); invocation.firstEvent();
      invocation.fail(Object.assign(new Error('do not copy'), { code: 'ECONNRESET' }), 'stream_iteration');
      invocation.fail(new Error('duplicate'), 'stream_result');
      invocation.finish(); invocation.finish(); invocation.firstEvent();
    }
    const snapshot = recorder.snapshot()!;
    expect(snapshot).toMatchObject({ totalInvocations: 30, omittedInvocations: 9 });
    expect(snapshot.invocations).toHaveLength(21);
    expect(snapshot.invocations[0]?.invocation).toBe(10);
    expect(snapshot.invocations.at(-1)?.invocation).toBe(30);
    expect(snapshot.invocations.every(invocation => invocation.stages.length === 4)).toBe(true);
    snapshot.invocations[0]!.stages[2]!.error!.name = 'UnknownError';
    expect(recorder.snapshot()?.invocations[0]?.stages[2]?.error?.name).toBe('Error');
    expect(JSON.stringify(snapshot).length).toBeLessThan(18_000);
  });

  it('drops unapproved metadata values and safely handles cyclic causes and getters', () => {
    const controller = new AbortController();
    const recorder = createPiStreamDiagnostics(controller.signal);
    const failure: Record<string, unknown> = { name: 'https://private-host', code: 'secret-key', status: '401', message: 'private-prompt', response: 'raw-response' };
    failure.cause = failure;
    const first = recorder.start(controller.signal);
    first.fail(failure, 'stream_open'); first.finish();
    const second = recorder.start(controller.signal);
    second.fail({ get name() { throw new Error('private-name'); }, get code() { throw new Error('private-code'); }, status: Infinity,
      get cause() { throw new Error('private-cause'); } }, 'stream_result'); second.finish();
    const snapshot = recorder.snapshot()!;
    expect(snapshot.invocations[0]?.stages[1]?.error).toEqual({ name: 'UnknownError', causeName: 'UnknownError' });
    expect(snapshot.invocations[1]?.stages[1]?.error).toEqual({ name: 'UnknownError' });
    expect(JSON.stringify(snapshot)).not.toMatch(/private|secret|response|https:|Infinity|401/);
  });

  it('distinguishes provider option signal cancellation from the host controller', async () => {
    const host = new AbortController(), provider = new AbortController();
    const recorder = createPiStreamDiagnostics(host.signal);
    const stream = observePiStreamFn(async () => {
      provider.abort();
      throw Object.assign(new Error('provider option aborted'), { name: 'AbortError' });
    }, host.signal, recorder);
    const output = stream(createFauxCore({}).getModel(), { messages: [] }, { signal: provider.signal });
    for await (const _event of output) { /* Drain the SDK stream locally. */ }
    await output.result();
    expect(recorder.snapshot()?.invocations[0]?.stages).toContainEqual(expect.objectContaining({
      stage: 'error', signalAborted: true, controllerAborted: false, error: { name: 'AbortError' },
    }));
    expect(host.signal.aborted).toBe(false);
  });

  it('binds the failed second invocation after one completed tool and preserves its result', async () => {
    const { faux, streamFn } = fixture();
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'actual local receipt' }], details: { local: true } }));
    const runtime = createPiAgentRuntime({ adapter: 'harness', model: faux.getModel(), streamFn,
      tools: [{ name: 'observe', label: 'observe', description: 'local fixture', parameters: Type.Object({}), execute }] });
    faux.setResponses([fauxAssistantMessage(fauxToolCall('observe', {}), { stopReason: 'toolUse' }),
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'second stream failed' })]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'local tool fixture' }));
    expect(messages).toContainEqual(expect.objectContaining({ type: 'tool_result', output: 'actual local receipt', isError: false }));
    expect(execute).toHaveBeenCalledOnce();
    expect(streamFn).toHaveBeenCalledTimes(2);
    const diagnostic = messages.find(message => message.type === 'error')?.providerStreamDiagnostics;
    expect(diagnostic?.totalInvocations).toBe(2);
    expect(diagnostic?.invocations.map(invocation => [invocation.invocation, invocation.stages.at(-1)?.outcome])).toEqual([[1, 'completed'], [2, 'failed']]);
    expect(messages.filter(message => message.type === 'runtime_terminal')).toHaveLength(1);
    expect(messages.at(-2)?.runtimeTerminal?.status).toBe('failed');
  });

  it.each(['error', 'aborted'] as const)('fails closed when a done event has a final %s receipt', async (stopReason) => {
    const { runtime, streamFn } = fixture();
    const done = fauxAssistantMessage('contradictory completed payload');
    const receipt = fauxAssistantMessage('', { stopReason, errorMessage: 'final receipt failed' });
    streamFn.mockResolvedValue({
      async *[Symbol.asyncIterator]() { yield { type: 'done', reason: 'stop', message: done }; },
      result: async () => receipt,
    } as unknown as ReturnType<typeof createAssistantMessageEventStream>);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'receipt contradiction' }));
    expect(messages.find(event => event.type === 'error')?.message).toBe('final receipt failed');
    expect(messages.some(event => event.type === 'result')).toBe(false);
    expect(messages.at(-2)?.runtimeTerminal?.status).toBe('failed');
    expect(messages.at(-2)?.providerStreamDiagnostics?.invocations[0]?.stages.at(-1)?.outcome).toBe(stopReason === 'aborted' ? 'aborted' : 'failed');
    expect(streamFn).toHaveBeenCalledOnce();
  });

  it.each(['error', 'aborted'] as const)('fails closed when a %s event has a normal final receipt', async (reason) => {
    const { runtime, streamFn } = fixture();
    const error = fauxAssistantMessage('', { stopReason: reason, errorMessage: 'terminal event failed' });
    const receipt = fauxAssistantMessage('contradictory normal receipt');
    streamFn.mockResolvedValue({
      async *[Symbol.asyncIterator]() { yield { type: 'error', reason, error }; },
      result: async () => receipt,
    } as unknown as ReturnType<typeof createAssistantMessageEventStream>);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'event contradiction' }));
    expect(messages.find(event => event.type === 'error')?.message).toBe('terminal event failed');
    expect(messages.some(event => event.type === 'result')).toBe(false);
    expect(messages.at(-2)?.runtimeTerminal?.status).toBe('failed');
    expect(messages.at(-2)?.providerStreamDiagnostics?.invocations[0]?.stages.at(-1)?.outcome).toBe(reason === 'aborted' ? 'aborted' : 'failed');
    expect(streamFn).toHaveBeenCalledOnce();
  });

  it.each([
    ['harness', 'error'], ['harness', 'aborted'], ['agent', 'error'], ['agent', 'aborted'],
  ] as const)('preserves an earlier %s %s event when a later done has a normal receipt', async (adapter, reason) => {
    const { runtime, streamFn } = fixture(adapter);
    const error = fauxAssistantMessage('', { stopReason: reason, errorMessage: 'first terminal failure' });
    const receipt = fauxAssistantMessage('later apparently complete');
    streamFn.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'error', reason, error };
        yield { type: 'done', reason: 'stop', message: receipt };
      },
      result: async () => receipt,
    } as unknown as ReturnType<typeof createAssistantMessageEventStream>);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'duplicate terminal contradiction' }));
    expect(messages.find(event => event.type === 'error')?.message).toBe('first terminal failure');
    expect(messages.some(event => event.type === 'result')).toBe(false);
    expect(messages.find(event => event.type === 'error')?.providerStreamDiagnostics?.invocations[0]?.stages.at(-1)).toMatchObject({
      outcome: reason === 'aborted' ? 'aborted' : 'failed', terminalConsistency: 'event_result_mismatch',
    });
    expect(streamFn).toHaveBeenCalledOnce();
  });

  it.each(['harness', 'agent'] as const)('fails closed for %s when the provider ignores host cancellation', async (adapter) => {
    const { runtime, streamFn } = fixture(adapter);
    const controller = new AbortController();
    const receipt = fauxAssistantMessage('provider completion after host cancellation');
    streamFn.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        controller.abort();
        yield { type: 'done', reason: 'stop', message: receipt };
      },
      result: async () => receipt,
    } as unknown as ReturnType<typeof createAssistantMessageEventStream>);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'ignored host cancellation', options: { abortController: controller } }));
    expect(messages.find(event => event.type === 'error')?.message).toBe(adapter === 'harness' ? 'Pi run aborted' : controller.signal.reason.message);
    expect(messages.some(event => event.type === 'result')).toBe(false);
    expect(messages.find(event => event.type === 'error')?.providerStreamDiagnostics?.invocations[0]?.stages.at(-1)?.outcome).toBe('aborted');
    if (adapter === 'harness') expect(messages.at(-2)?.runtimeTerminal?.status).toBe('aborted');
    expect(streamFn).toHaveBeenCalledOnce();
  });
});
