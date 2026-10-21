import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentOptions } from '@openzhiyu/ai/agent/types';
import { createPiAgentRuntime } from '@openzhiyu/ai/agent/runtime';
import { createHostFinalValidation } from '@openzhiyu/ai/agent/runtime/host-final-validation';
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, Type } from '@earendil-works/pi-ai';
import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

type FinalPolicy = NonNullable<AgentOptions['hostFinalValidation']>;
async function collect(source: AsyncGenerator<AgentMessage>) {
  const messages: AgentMessage[] = [];
  for await (const message of source) messages.push(message);
  return messages;
}
function message(text: string, total = 1000, output = 10, stopReason: 'stop' | 'length' = 'stop') {
  const result = fauxAssistantMessage(text, { stopReason });
  return { ...result, usage: { ...result.usage, input: total - output, output, totalTokens: total } };
}
function overflowFixture(timeoutMs = 120000) {
  const model = { ...createFauxCore({}).getModel(), contextWindow: 128000, maxTokens: 16384 };
  const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'source '.repeat(20000) }], details: {} }));
  const tool: AgentTool = { name: 'read', label: 'read', description: 'local source', parameters: Type.Object({}), execute };
  const log: AgentTool = { name: 'log', label: 'log', description: 'local observation', parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text', text: 'observation saved' }], details: {} }) };
  const first = fauxAssistantMessage([fauxToolCall('read', {}), fauxToolCall('read', {})], { stopReason: 'toolUse' });
  const responses = [first, message('bad0', 110000, 3000), message('bad1', 123594, 3137),
    message('', 126022, 1, 'length'), message('bounded history summary', 27949, 2977),
    message('bounded prefix summary', 5875, 989), message('good', 30000, 100)];
  const payloadCaps: number[] = [];
  const blocked: { index?: number; started?: () => void } = {};
  const streamFn = vi.fn<StreamFn>(async (currentModel, context, options) => {
    const result = responses[streamFn.mock.calls.length - 1];
    if (!result) throw new Error('local fixture response exhausted');
    result.timestamp = Date.now();
    const actual = clampMaxTokensToContext(currentModel, context, options?.maxTokens ?? currentModel.maxTokens);
    payloadCaps.push(actual);
    await options?.onPayload?.({ max_completion_tokens: actual }, currentModel);
    const stream = createAssistantMessageEventStream();
    if (streamFn.mock.calls.length - 1 === blocked.index) { blocked.started?.(); return stream; }
    stream.push({ type: 'start', partial: { ...result, content: [] } });
    stream.push({ type: 'done', reason: result.stopReason === 'length' ? 'length' : result.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: result });
    stream.end(result);
    return stream;
  });
  const runtime = createPiAgentRuntime({ adapter: 'harness', model, tools: [tool, log], streamFn, streamOptions: { timeoutMs } });
  const receipts: Array<Record<string, unknown>> = [];
  const validate = vi.fn(async ({ text }: { text: string }) => text === 'good' ? { ok: true as const }
    : { ok: false as const, feedback: text === 'bad1' ? 'f'.repeat(7344) : 'correct' });
  const options: FinalPolicy = { validate, reserveOutputTokens: vi.fn(() => 16384),
    boundedCompaction: { maxForwards: 2, totalOutputTokens: 4096, perForwardOutputTokens: 3072 },
    onForward: vi.fn(data => { receipts.push(data as unknown as Record<string, unknown>); }),
  };
  const run = (abortController?: AbortController) => collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: options, abortController,
    conversation: [{ role: 'user', content: 'prior question' }, { role: 'assistant', content: 'prior answer' }] } }));
  return { run, streamFn, payloadCaps, receipts, validate, options, execute, responses, blocked, model };
}
afterEach(() => vi.restoreAllMocks());

describe('Pi typed bounded overflow compaction with the actual SDK lane', () => {
  it('does not compact a correction that exhausts the admitted 3328-token output cap', async () => {
    const fixture = overflowFixture();
    // This is the original grant's 13312-token balance after one 3072-token
    // summary, split across the unchanged four report forwards.
    fixture.options.reserveOutputTokens = vi.fn(() => 13312);
    Object.freeze(fixture.model);
    fixture.responses.splice(2, 5, message('partial bounded report', 10000, 3328, 'length'),
      message('history summary must not be requested', 10000, 100),
      message('prefix summary must not be requested', 10000, 100), message('good', 10000, 100));
    const messages = await fixture.run();
    expect(fixture.payloadCaps[2]).toBe(3328);
    expect(fixture.receipts.map(receipt => receipt.phase)).toEqual(['report_correction']);
    expect(fixture.streamFn).toHaveBeenCalledTimes(3);
    expect(fixture.validate.mock.calls.map(call => call[0].text)).toEqual(['bad0']);
    expect(messages.filter(entry => entry.answerPhase === 'candidate_final')).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', error: 'Final validation has no nonempty candidate' });
    expect(fixture.options.reserveOutputTokens).toHaveBeenCalledOnce();
    expect(fixture.model.maxTokens).toBe(16384);
  });

  it('does not compact source recovery that exhausts its admitted 512-token output cap', async () => {
    const fixture = overflowFixture();
    Object.freeze(fixture.model);
    const beforeForward = vi.fn(async () => true);
    fixture.options.sourceRecovery = { maxForwards: 12, perForwardOutputTokens: 512,
      beforeForward, isToolAllowed: name => name === 'read' };
    fixture.responses.splice(2, 5, message('partial required-source recovery', 10000, 512, 'length'),
      message('history summary must not be requested', 10000, 100),
      message('prefix summary must not be requested', 10000, 100), message('good', 10000, 100));
    const messages = await fixture.run();
    expect(fixture.payloadCaps[2]).toBe(512);
    expect(fixture.receipts).toEqual([expect.objectContaining({ phase: 'source_recovery', maxTokens: 512,
      requestedMaxTokens: 512, remainingOutputTokens: 15872 })]);
    expect(fixture.streamFn).toHaveBeenCalledTimes(3);
    expect(beforeForward).toHaveBeenCalledOnce();
    expect(fixture.validate.mock.calls.map(call => call[0].text)).toEqual(['bad0']);
    expect(messages.filter(entry => entry.answerPhase === 'candidate_final')).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', error: 'Final validation has no nonempty candidate' });
    expect(fixture.options.reserveOutputTokens).toHaveBeenCalledOnce();
    expect(fixture.model.maxTokens).toBe(16384);
  });

  it('keeps the two real SDK summary requests separate from report forwards and approves candidate2', async () => {
    const fixture = overflowFixture();
    const messages = await fixture.run();
    expect(fixture.streamFn).toHaveBeenCalledTimes(7);
    expect(fixture.validate.mock.calls.map(call => call[0].text)).toEqual(['bad0', 'bad1', 'good']);
    expect(fixture.receipts.map(receipt => receipt.phase)).toEqual([
      'report_correction', 'report_correction', 'context_compaction', 'context_compaction', 'report_correction',
    ]);
    expect(fixture.receipts.filter(receipt => receipt.phase === 'context_compaction').map(receipt => receipt.maxTokens)).toEqual([3072, 1024]);
    expect(messages.filter(entry => entry.answerPhase === 'candidate_final')).toEqual([expect.objectContaining({ content: 'good' })]);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'completed', cleanupStatus: 'completed' });
    expect(fixture.options.reserveOutputTokens).toHaveBeenCalledOnce();
    expect(fixture.receipts.reduce((sum, receipt) => sum + Number(receipt.maxTokens), 0)).toBeLessThanOrEqual(16384);
  });

  it('records the same SDK context clamp as the actual payload instead of advertising 3712 tokens', async () => {
    const fixture = overflowFixture();
    await fixture.run();
    const receipt = fixture.receipts[1];
    expect(fixture.payloadCaps[3]).toBe(1);
    expect(receipt).toMatchObject({ maxTokens: 1, requestedMaxTokens: 4096, localContextWindow: 128000,
      sdkEstimatedInputTokens: 125430, capSource: 'sdk_context_estimate' });
  });

  it('keeps SDK summaries off unless explicitly authorized', async () => {
    const fixture = overflowFixture(); delete fixture.options.boundedCompaction;
    const messages = await fixture.run();
    expect(fixture.streamFn).toHaveBeenCalledTimes(4);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', error: expect.stringContaining('[provider_output_truncated]') });
    expect(fixture.receipts).toHaveLength(2);

    const host = new AbortController(), fail = vi.fn();
    const disabled = overflowFixture().options; delete disabled.boundedCompaction;
    const validation = createHostFinalValidation({ options: disabled, signal: host.signal,
      conflictsWithReadonly: false, onFailure: fail, onIntermediate: vi.fn(), timeoutMs: 1000 });
    validation.assertReady(); validation.beforeRequest('compaction');
    const source = vi.fn<StreamFn>();
    await expect(validation.wrapStream(source)({ ...createFauxCore({}).getModel() }, { messages: [] })).rejects.toThrow('context compaction is not allowed');
    expect(source).not.toHaveBeenCalled(); validation.dispose();
  });

  it('allows initial overflow summaries from the same one-time grant and still validates the first draft', async () => {
    const fixture = overflowFixture();
    const logged = fauxAssistantMessage(fauxToolCall('log', {}), { stopReason: 'toolUse' });
    fixture.responses.splice(1, 6, logged, message('', 126022, 1, 'length'), message('initial history summary', 10000, 100),
      message('initial prefix summary', 10000, 100), message('bad0', 10000, 100), message('good', 11000, 100));
    const messages = await fixture.run();
    expect(fixture.streamFn).toHaveBeenCalledTimes(7);
    expect(fixture.validate.mock.calls.map(call => call[0].text)).toEqual(['bad0', 'good']);
    expect(fixture.receipts.map(receipt => receipt.phase)).toEqual(['context_compaction', 'context_compaction', 'report_correction']);
    expect(fixture.receipts.map(receipt => receipt.maxTokens)).toEqual([3072, 1024, 3072]);
    expect(fixture.options.reserveOutputTokens).toHaveBeenCalledOnce();
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'completed', cleanupStatus: 'completed' });
  });

  it('enforces the separate summary forward count without expanding report or output grants', async () => {
    const fixture = overflowFixture(); fixture.options.boundedCompaction!.maxForwards = 1;
    const messages = await fixture.run();
    expect(fixture.streamFn).toHaveBeenCalledTimes(5);
    expect(fixture.receipts.filter(receipt => receipt.phase === 'report_correction')).toHaveLength(2);
    expect(fixture.receipts.filter(receipt => receipt.phase === 'context_compaction')).toHaveLength(1);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', error: 'Final validation context compaction forward limit exhausted' });
    expect(fixture.options.reserveOutputTokens).toHaveBeenCalledOnce();
  });

  it('enforces the total summary subbudget and reserves the remaining report forwards', async () => {
    const fixture = overflowFixture(); fixture.options.boundedCompaction!.totalOutputTokens = 2048;
    fixture.responses[4] = message('bounded history summary', 10000, 1000);
    const messages = await fixture.run();
    expect(fixture.streamFn).toHaveBeenCalledTimes(5);
    expect(fixture.receipts.filter(receipt => receipt.phase === 'context_compaction').map(receipt => receipt.maxTokens)).toEqual([2048]);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', error: 'Final validation context compaction output budget exhausted' });
    expect(fixture.receipts.at(-1)?.remainingOutputTokens).toBe(16384 - 4096 - 1 - 2048);
  });

  it('cannot spend a compaction sublimit beyond the same original grant', async () => {
    const fixture = overflowFixture(); fixture.options.reserveOutputTokens = vi.fn(() => 4096);
    fixture.responses[2] = message('bad1', 123594, 100);
    const messages = await fixture.run();
    expect(fixture.streamFn).toHaveBeenCalledTimes(5);
    expect(fixture.receipts.map(receipt => receipt.maxTokens)).toEqual([1024, 1, 3069]);
    expect(fixture.receipts.at(-1)?.remainingOutputTokens).toBe(2);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', error: 'Final validation context compaction output budget exhausted' });
    expect(fixture.options.reserveOutputTokens).toHaveBeenCalledOnce();
  });

  it('never starts an initial summary with an unknown grant or whole-runtime deadline', async () => {
    for (const kind of ['grant', 'deadline'] as const) {
      const fixture = overflowFixture();
      fixture.options.reserveOutputTokens = vi.fn(() => null);
      const controller = new AbortController();
      const gate = createHostFinalValidation({ options: fixture.options, signal: controller.signal,
        ...(kind === 'grant' ? { timeoutMs: 1000 } : {}), conflictsWithReadonly: false,
        onFailure: vi.fn(), onIntermediate: vi.fn() });
      gate.assertReady(); gate.beforeRequest('compaction');
      const source = vi.fn<StreamFn>();
      await expect(gate.wrapStream(source)(createFauxCore({}).getModel(), { messages: [] })).rejects.toThrow(kind === 'grant'
        ? 'output budget is unknown or exhausted' : 'context compaction deadline is unknown');
      expect(source).not.toHaveBeenCalled();
      expect(fixture.options.reserveOutputTokens).toHaveBeenCalledTimes(kind === 'grant' ? 1 : 0);
      gate.dispose();
    }
  });

  it.each(['tool', 'length', 'empty'] as const)('hard rejects a %s summary without executing tools or promoting it to a final', async kind => {
    const fixture = overflowFixture();
    if (kind === 'tool') fixture.responses[4] = fauxAssistantMessage(fauxToolCall('read', {}), { stopReason: 'toolUse' });
    if (kind === 'length') fixture.responses[4] = message('partial summary', 1000, 10, 'length');
    if (kind === 'empty') fixture.responses[4] = message('');
    const messages = await fixture.run();
    expect(fixture.streamFn).toHaveBeenCalledTimes(5); expect(fixture.execute).toHaveBeenCalledTimes(2);
    expect(fixture.validate).toHaveBeenCalledTimes(2);
    expect(messages.filter(entry => entry.answerPhase === 'candidate_final')).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', error: 'Final validation context compaction result is invalid' });
  });

  it('fails before summary dispatch when the typed budget receipt cannot be persisted', async () => {
    const fixture = overflowFixture();
    fixture.options.onForward = data => { if (data.phase === 'context_compaction') throw new Error('host receipt storage unavailable'); };
    const messages = await fixture.run();
    expect(fixture.streamFn).toHaveBeenCalledTimes(4);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', error: 'Final validation forward budget receipt failed' });
  });

  it.each(['cancel', 'deadline'] as const)('keeps the original %s active while a summary result is pending', async mode => {
    const fixture = overflowFixture(mode === 'deadline' ? 500 : 120000);
    fixture.blocked.index = 4;
    const ready = new Promise<void>(resolve => { fixture.blocked.started = resolve; });
    const controller = new AbortController();
    const pending = fixture.run(controller); await ready;
    if (mode === 'cancel') controller.abort();
    const messages = await pending;
    expect(fixture.streamFn).toHaveBeenCalledTimes(5);
    expect(fixture.validate).toHaveBeenCalledTimes(2);
    expect(messages.filter(entry => entry.answerPhase === 'candidate_final')).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject(mode === 'cancel' ? { status: 'aborted', cleanupStatus: 'completed' }
      : { status: 'failed', cleanupStatus: 'completed', error: 'Final validation whole-runtime deadline exhausted' });
  });

  it.each(['missing', 'overlap', 'branch_summary', 'deferred'] as const)('fails closed on a %s request-purpose receipt', async kind => {
    const fixture = overflowFixture(), controller = new AbortController(), onFailure = vi.fn();
    const gate = createHostFinalValidation({ options: fixture.options, signal: controller.signal, timeoutMs: 1000,
      conflictsWithReadonly: false, onFailure, onIntermediate: vi.fn() });
    const stream = vi.fn<StreamFn>(); gate.assertReady();
    if (kind === 'overlap') { gate.beforeRequest('assistant'); expect(() => gate.beforeRequest('compaction')).toThrow('overlapping request purpose receipts'); }
    if (kind === 'branch_summary' || kind === 'deferred') expect(() => gate.beforeRequest(kind)).toThrow('request purpose is not allowed');
    await expect(gate.wrapStream(stream)(createFauxCore({}).getModel(), { messages: [] })).rejects.toThrow();
    expect(stream).not.toHaveBeenCalled(); expect(onFailure).toHaveBeenCalledOnce(); gate.dispose();
  });

  it.each([{ maxForwards: 3 }, { totalOutputTokens: 4097 }, { perForwardOutputTokens: 3073 },
    { maxForwards: 0 }, { totalOutputTokens: 0 }, { perForwardOutputTokens: 0 }])('rejects invalid compaction sublimits %j before any provider request', async invalid => {
    const fixture = overflowFixture(); Object.assign(fixture.options.boundedCompaction!, invalid);
    const messages = await fixture.run();
    expect(fixture.streamFn).not.toHaveBeenCalled();
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', error: 'Final validation context compaction configuration is invalid' });
  });
});
