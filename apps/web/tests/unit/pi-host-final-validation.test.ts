import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentOptions } from '@openzhiyu/ai/agent/types';
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { MemorySessionRepo } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createPiAgentRuntime } from '@openzhiyu/ai/agent/runtime';

async function collect(source: AsyncGenerator<AgentMessage>) {
  const messages: AgentMessage[] = [];
  for await (const message of source) messages.push(message);
  return messages;
}
function fixture(timeoutMs: number | undefined = 120_000, maxTokens = 100, toolExecution: 'sequential' | 'parallel' = 'sequential', includeControl = false) {
  const faux = createFauxCore({});
  const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'source receipt' }], details: {} }));
  const tool: AgentTool = { name: 'read', label: 'read', description: 'local source read', parameters: Type.Object({}), execute };
  const controlExecute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'must never execute during recovery' }], details: {} }));
  const control: AgentTool = { name: 'control', label: 'control', description: 'unrelated control', parameters: Type.Object({}), execute: controlExecute };
  const streamFn = vi.fn<StreamFn>(async (...args) => faux.streamSimple(...args));
  const runtime = createPiAgentRuntime({ adapter: 'harness', model: { ...faux.getModel(), maxTokens },
    streamFn, tools: includeControl ? [tool, control] : [tool], toolExecution, streamOptions: timeoutMs ? { timeoutMs } : undefined });
  return { faux, execute, controlExecute, streamFn, runtime };
}
function validation(): NonNullable<AgentOptions['hostFinalValidation']> {
  return { validate: vi.fn(async ({ text }) => text === 'good' ? { ok: true as const } : { ok: false as const, feedback: 'Correct the report using the same sources.' }),
    reserveOutputTokens: vi.fn(() => 400) };
}
const response = (text: string) => fauxAssistantMessage(text);
const read = () => fauxAssistantMessage(fauxToolCall('read', {}), { stopReason: 'toolUse' });
const finals = (messages: AgentMessage[]) => messages.filter(message => message.type === 'result' && message.answerPhase === 'candidate_final');
afterEach(() => vi.restoreAllMocks());

describe('Pi bounded host final validation with the actual SDK lane', () => {
  it('funds all four long-report correction forwards without starving the final answer',async()=>{
    const {faux,streamFn,runtime}=fixture(120000,16384);faux.setResponses([response('bad'),read(),read(),read(),response('good')]);
    const onForward=vi.fn();const messages=await collect(runtime.run({operation:'run',prompt:'report',options:{hostFinalValidation:{...validation(),maxCorrections:1,maxExtraForwards:4,perForwardOutputTokens:16384,reserveOutputTokens:()=>65536,onForward}}}));
    expect(onForward.mock.calls.map(([r])=>r.maxTokens)).toEqual([16384,16384,16384,16384]);
    expect(onForward.mock.calls.at(-1)?.[0].remainingOutputTokens).toBe(0);
    expect(streamFn.mock.calls.at(-1)?.[1].tools).toEqual([]);expect(finals(messages)).toEqual([expect.objectContaining({content:'good'})]);
  });
  it('reserves a full long-report forward instead of dividing every answer to 8192 tokens',async()=>{
    const {faux,streamFn,runtime}=fixture(120000,16384);faux.setResponses([response('bad'),response('good')]);
    const onForward=vi.fn();const messages=await collect(runtime.run({operation:'run',prompt:'report',options:{hostFinalValidation:{...validation(),maxCorrections:1,maxExtraForwards:4,perForwardOutputTokens:16384,reserveOutputTokens:()=>32768,onForward}}}));
    expect(onForward).toHaveBeenCalledWith(expect.objectContaining({maxTokens:16384,remainingOutputTokens:16384}));
    expect(streamFn.mock.calls[1][2]?.maxTokens).toBe(16384);expect(finals(messages)).toEqual([expect.objectContaining({content:'good'})]);
  });
  it('keeps the last correction forward for the validated answer after three bounded tool forwards',async()=>{
    const {faux,execute,streamFn,runtime}=fixture();
    faux.setResponses([response('bad'),read(),read(),read(),response('good')]);
    const messages=await collect(runtime.run({operation:'run',prompt:'report',options:{hostFinalValidation:{...validation(),maxCorrections:1,maxExtraForwards:4}}}));
    expect(execute).toHaveBeenCalledTimes(3);
    expect(streamFn).toHaveBeenCalledTimes(5);
    expect(streamFn.mock.calls.slice(0,4).every(c=>c[1].tools?.some(t=>t.name==='read'))).toBe(true);
    expect(streamFn.mock.calls[4][1].tools).toEqual([]);
    expect(streamFn.mock.calls[4][2]?.toolChoice).toBe('none');
    expect(finals(messages)).toEqual([expect.objectContaining({content:'good'})]);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({status:'completed',cleanupStatus:'completed'});
  });
  it.each([false, true])('recovers five authorized missing windows before reserving report forwards (batch=%s)', async batch => {
    const { faux, execute, streamFn, runtime } = fixture(120_000, 6000, batch ? 'parallel' : 'sequential');
    const batchRead = fauxAssistantMessage([fauxToolCall('read', {}), fauxToolCall('read', {})], { stopReason: 'toolUse' });
    faux.setResponses([response('bad'), read(), read(), read(), ...(batch ? [batchRead] : [read(), read()]), response('good')]);
    const receipts: Array<{ phase: string; maxTokens: number }> = [];
    const option = { ...validation(), reserveOutputTokens: vi.fn(() => 16_384), sourceRecovery: {
      maxForwards: 12, perForwardOutputTokens: 512,
      beforeForward: vi.fn(async () => execute.mock.calls.length < 5),
      isToolAllowed: vi.fn((name: string) => name === 'read'),
    }, onForward: vi.fn(async (receipt: { phase: string; maxTokens: number }) => { receipts.push(receipt); }) };
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: option } }));
    expect(execute).toHaveBeenCalledTimes(5);
    expect(streamFn).toHaveBeenCalledTimes(batch ? 6 : 7);
    expect(option.validate).toHaveBeenCalledTimes(2);
    expect(option.reserveOutputTokens).toHaveBeenCalledOnce();
    expect(option.sourceRecovery.beforeForward).toHaveBeenCalledTimes(batch ? 5 : 6);
    expect(receipts.filter(receipt => receipt.phase === 'source_recovery')).toHaveLength(batch ? 4 : 5);
    expect(receipts.filter(receipt => receipt.phase === 'report_correction')).toEqual([expect.objectContaining({ maxTokens: expect.any(Number) })]);
    expect(receipts.at(-1)?.maxTokens).toBeGreaterThan(3000);
    expect(finals(messages)).toEqual([expect.objectContaining({ content: 'good' })]);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'completed', cleanupStatus: 'completed' });
  });

  it('rejects an early recovery candidate and never treats missing coverage as a successful final', async () => {
    const { faux, execute, runtime } = fixture(120_000, 6000);
    faux.setResponses([response('bad'), response('good'), read(), response('good')]);
    const validate = vi.fn(async () => execute.mock.calls.length === 1 ? { ok: true as const }
      : { ok: false as const, feedback: 'Source coverage is still incomplete.' });
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: {
      validate, reserveOutputTokens: () => 16_384,
      sourceRecovery: { maxForwards: 12, perForwardOutputTokens: 512,
        beforeForward: async () => execute.mock.calls.length === 0, isToolAllowed: name => name === 'read' },
    } } }));
    expect(validate.mock.calls.map(call => (call as unknown[])[0])).toEqual([
      expect.objectContaining({ text: 'bad', attempt: 0 }), expect.objectContaining({ text: 'good', attempt: 1 }),
      expect.objectContaining({ text: 'good', attempt: 2 }),
    ]);
    expect(execute).toHaveBeenCalledOnce();
    expect(messages.filter(message => message.answerPhase === 'intermediate')).toHaveLength(2);
    expect(finals(messages)).toHaveLength(1);
  });

  it('keeps recovery off before rejection and permanently exits after the host reports complete coverage', async () => {
    const { faux, execute, runtime } = fixture(120_000, 6000);
    faux.setResponses([read(), response('bad'), response('bad again'), response('good')]);
    const beforeForward = vi.fn(async () => false);
    const isToolAllowed = vi.fn(() => false);
    const phases: string[] = [];
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: {
      ...validation(), reserveOutputTokens: () => 16_384,
      sourceRecovery: { maxForwards: 12, perForwardOutputTokens: 512, beforeForward, isToolAllowed },
      onForward: data => { phases.push(data.phase); },
    } } }));
    expect(execute).toHaveBeenCalledOnce();
    expect(beforeForward).toHaveBeenCalledOnce();
    expect(isToolAllowed).not.toHaveBeenCalled();
    expect(phases).toEqual(['report_correction', 'report_correction']);
    expect(finals(messages)).toHaveLength(1);
  });

  it('does not start recovery or reserve output when the first candidate passes', async () => {
    const { faux, streamFn, runtime } = fixture(); faux.setResponses([response('good')]);
    const option = { ...validation(), sourceRecovery: { maxForwards: 12, perForwardOutputTokens: 512,
      beforeForward: vi.fn(async () => true), isToolAllowed: vi.fn(() => true) }, onForward: vi.fn() };
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: option } }));
    expect(streamFn).toHaveBeenCalledOnce();
    expect(option.sourceRecovery.beforeForward).not.toHaveBeenCalled();
    expect(option.sourceRecovery.isToolAllowed).not.toHaveBeenCalled();
    expect(option.reserveOutputTokens).not.toHaveBeenCalled();
    expect(option.onForward).not.toHaveBeenCalled();
    expect(finals(messages)).toHaveLength(1);
  });

  it('retains the original caller tool fence during source recovery', async () => {
    const { faux, execute, runtime } = fixture(); faux.setResponses([response('bad'), read(), response('good')]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: {
      hostFinalValidation: { ...validation(), reserveOutputTokens: () => 16_384,
        sourceRecovery: { maxForwards: 12, perForwardOutputTokens: 512, beforeForward: async () => true, isToolAllowed: () => true } },
      onBeforeToolUse: async () => { throw Error('original thirty-tool limit exhausted'); },
    } }));
    expect(execute).not.toHaveBeenCalled(); expect(finals(messages)).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', error: 'original thirty-tool limit exhausted' });
  });

  it('pre-deducts twelve recovery and four report forwards from one unchanged output grant', async () => {
    const { faux, execute, streamFn, runtime } = fixture(120_000, 6000);
    faux.setResponses([response('bad'), ...Array.from({ length: 12 }, read), read(), response('bad'), read(), response('good')]);
    const receipts: Array<{ phase: string; maxTokens: number; remainingOutputTokens: number }> = [];
    const option = { ...validation(), reserveOutputTokens: vi.fn(() => 16_384),
      sourceRecovery: { maxForwards: 12, perForwardOutputTokens: 512,
        beforeForward: vi.fn(async () => execute.mock.calls.length < 12), isToolAllowed: (name: string) => name === 'read' },
      onForward: async (data: { phase: string; maxTokens: number; remainingOutputTokens: number }) => { receipts.push(data); },
    };
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: option } }));
    expect(streamFn).toHaveBeenCalledTimes(17);
    expect(receipts.filter(receipt => receipt.phase === 'source_recovery')).toHaveLength(12);
    expect(receipts.filter(receipt => receipt.phase === 'report_correction')).toHaveLength(4);
    expect(receipts.reduce((sum, receipt) => sum + receipt.maxTokens, 0)).toBe(16_384);
    expect(receipts.at(-1)?.remainingOutputTokens).toBe(0);
    expect(option.reserveOutputTokens).toHaveBeenCalledOnce();
    expect(option.sourceRecovery.beforeForward).toHaveBeenCalledTimes(13);
    expect(finals(messages)).toHaveLength(1);
  });

  it('fails when recovery itself exceeds its finite forward bound', async () => {
    const { faux, execute, streamFn, runtime } = fixture(120_000, 6000);
    faux.setResponses([response('bad'), ...Array.from({ length: 13 }, read), response('good')]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: {
      ...validation(), reserveOutputTokens: () => 16_384,
      sourceRecovery: { maxForwards: 12, perForwardOutputTokens: 512, beforeForward: async () => true, isToolAllowed: () => true },
    } } }));
    expect(execute).toHaveBeenCalledTimes(12); expect(streamFn).toHaveBeenCalledTimes(13);
    expect(finals(messages)).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', error: 'Final validation source recovery forward limit exhausted' });
  });

  it('does not dispatch a recovery request that would consume the report reserve', async () => {
    const { faux, execute, streamFn, runtime } = fixture(); faux.setResponses([response('bad'), read()]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: {
      ...validation(), reserveOutputTokens: () => 4,
      sourceRecovery: { maxForwards: 12, perForwardOutputTokens: 512, beforeForward: async () => true, isToolAllowed: () => true },
    } } }));
    expect(execute).not.toHaveBeenCalled(); expect(streamFn).toHaveBeenCalledOnce();
    expect(messages.at(-2)?.runtimeTerminal?.error).toBe('Final validation source recovery output budget exhausted');
  });

  it.each(['throws', 'invalid'] as const)('hard fails when the recovery tool policy cannot decide (%s)', async policy => {
    const { faux, execute, runtime } = fixture(); faux.setResponses([response('bad'), read(), response('good')]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: {
      hostFinalValidation: { ...validation(), reserveOutputTokens: () => 16_384,
        sourceRecovery: { maxForwards: 12, perForwardOutputTokens: 512, beforeForward: async () => true,
          isToolAllowed: (_name, params) => {
            if (policy === 'throws') throw Error('policy failed');
            if (policy === 'invalid') return {} as boolean;
            return !(params as { changed?: boolean }).changed;
          } },
      },
    } }));
    expect(execute).not.toHaveBeenCalled(); expect(finals(messages)).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal?.status).toBe('failed');
    expect(messages.at(-2)?.runtimeTerminal?.error).toContain('source recovery tool');
  });

  it.each(['wrong-params', 'unknown-control'] as const)('returns a denied %s request to the model and accepts a later authorized read', async deniedKind => {
    const { faux, execute, controlExecute, streamFn, runtime } = fixture(120_000, 6000, 'sequential', true);
    const name = deniedKind === 'unknown-control' ? 'control' : 'read';
    const params = deniedKind === 'unknown-control' ? {} : { kind: deniedKind };
    const denied = fauxAssistantMessage(fauxToolCall(name, params), { stopReason: 'toolUse' });
    faux.setResponses([response('bad'), denied, read(), response('good')]);
    const requests: unknown[] = [];
    const denials: unknown[] = [];
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: {
      onBeforeToolUse: async data => { requests.push({ name: data.toolName, input: data.input }); },
      hostFinalValidation: { ...validation(), reserveOutputTokens: () => 16_384,
        sourceRecovery: { maxForwards: 12, perForwardOutputTokens: 512,
          beforeForward: async () => execute.mock.calls.length === 0,
          isToolAllowed: (toolName, params) => toolName === 'read' && !(params as { kind?: string }).kind,
          onToolDenied: async data => { denials.push(data); return 'Use the host cursor and required paper URL.'; },
        },
      },
    } }));
    expect(requests).toEqual([{ name, input: params }, { name: 'read', input: {} }]);
    expect(denials).toEqual([{ name, input: params }]);
    expect(execute).toHaveBeenCalledOnce();
    expect(controlExecute).not.toHaveBeenCalled();
    expect(streamFn).toHaveBeenCalledTimes(4);
    expect(messages).toContainEqual(expect.objectContaining({ type: 'tool_result', isError: true,
      output: expect.stringContaining('Use the host cursor') }));
    expect(finals(messages)).toHaveLength(1);
    expect(messages.at(-2)?.runtimeTerminal?.status).toBe('completed');
  });

  it('denies changed permission input without effects and allows a corrected subsequent request', async () => {
    const { faux, execute, runtime } = fixture(120_000, 6000);
    faux.setResponses([response('bad'), read(), read(), response('good')]);
    let permissionCalls = 0;
    const onToolDenied = vi.fn(async () => 'The replacement input is outside the admitted source cursor.');
    const onBeforeToolUse = vi.fn(async () => undefined);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: {
      onBeforeToolUse,
      onPermissionRequest: async () => ({ behavior: 'allow', updatedInput: ++permissionCalls === 1 ? { changed: true } : {} }),
      hostFinalValidation: { ...validation(), reserveOutputTokens: () => 16_384,
        sourceRecovery: { maxForwards: 12, perForwardOutputTokens: 512,
          beforeForward: async () => execute.mock.calls.length === 0,
          isToolAllowed: (_name, params) => !(params as { changed?: boolean }).changed, onToolDenied },
      },
    } }));
    expect(onBeforeToolUse).toHaveBeenCalledTimes(2);
    expect(onToolDenied).toHaveBeenCalledOnce();
    expect(onToolDenied).toHaveBeenCalledWith({ name: 'read', input: { changed: true } });
    expect(execute).toHaveBeenCalledOnce();
    expect((execute.mock.calls[0] as unknown[] | undefined)?.[1]).toEqual({});
    expect(finals(messages)).toHaveLength(1);
  });

  it('keeps continually denied tools inside the finite recovery forward limit', async () => {
    const { faux, execute, streamFn, runtime } = fixture(120_000, 6000);
    faux.setResponses([response('bad'), ...Array.from({ length: 13 }, read), response('good')]);
    const onToolDenied = vi.fn(async () => undefined);
    const onBeforeToolUse = vi.fn(async () => undefined);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: {
      onBeforeToolUse, hostFinalValidation: { ...validation(), reserveOutputTokens: () => 16_384,
        sourceRecovery: { maxForwards: 12, perForwardOutputTokens: 512,
          beforeForward: async () => true, isToolAllowed: () => false, onToolDenied },
      },
    } }));
    expect(execute).not.toHaveBeenCalled(); expect(streamFn).toHaveBeenCalledTimes(13);
    expect(onBeforeToolUse).toHaveBeenCalledTimes(12); expect(onToolDenied).toHaveBeenCalledTimes(12);
    expect(finals(messages)).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal?.error).toBe('Final validation source recovery forward limit exhausted');
  });

  it('charges denied requests to the original caller tool budget before recovery policy', async () => {
    const { faux, execute, runtime } = fixture(); faux.setResponses([response('bad'), read(), read(), response('good')]);
    let priorRequests = 29;
    const onToolDenied = vi.fn(async () => undefined);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: {
      onBeforeToolUse: async () => { if (++priorRequests > 30) throw Error('original tool budget exhausted: 31/30'); },
      hostFinalValidation: { ...validation(), reserveOutputTokens: () => 16_384,
        sourceRecovery: { maxForwards: 12, perForwardOutputTokens: 512,
          beforeForward: async () => true, isToolAllowed: () => false, onToolDenied },
      },
    } }));
    expect(priorRequests).toBe(31); expect(onToolDenied).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled();
    expect(finals(messages)).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal?.error).toBe('original tool budget exhausted: 31/30');
  });

  it('hard fails when the denial audit cannot persist', async () => {
    const { faux, execute, runtime } = fixture(); faux.setResponses([response('bad'), read(), read(), response('good')]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: {
      ...validation(), reserveOutputTokens: () => 16_384,
      sourceRecovery: { maxForwards: 12, perForwardOutputTokens: 512, beforeForward: async () => true,
        isToolAllowed: () => false, onToolDenied: async () => { throw Error('audit failed'); } },
    } } }));
    expect(execute).not.toHaveBeenCalled(); expect(finals(messages)).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal?.error).toBe('Final validation source recovery denial receipt failed');
  });

  it.each([null, {}, 'x'.repeat(4001)])('rejects invalid denial feedback without dispatch', async detail => {
    const { faux, execute, runtime } = fixture(); faux.setResponses([response('bad'), read()]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: {
      ...validation(), reserveOutputTokens: () => 16_384,
      sourceRecovery: { maxForwards: 12, perForwardOutputTokens: 512, beforeForward: async () => true,
        isToolAllowed: () => false, onToolDenied: async () => detail as string },
    } } }));
    expect(execute).not.toHaveBeenCalled(); expect(finals(messages)).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal?.error).toBe('Final validation source recovery denial feedback is invalid');
  });

  it('keeps cancellation while the denial receipt is pending', async () => {
    const { faux, execute, runtime } = fixture(); faux.setResponses([response('bad'), read()]);
    const abortController = new AbortController(); let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const pending = collect(runtime.run({ operation: 'run', prompt: 'report', options: { abortController, hostFinalValidation: {
      ...validation(), reserveOutputTokens: () => 16_384,
      sourceRecovery: { maxForwards: 12, perForwardOutputTokens: 512, beforeForward: async () => true,
        isToolAllowed: () => false, onToolDenied: async () => { ready(); return new Promise<string>(() => {}); } },
    } } }));
    await started; abortController.abort(); const messages = await pending;
    expect(execute).not.toHaveBeenCalled(); expect(finals(messages)).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'aborted', cleanupStatus: 'completed' });
  });

  it('keeps the original deadline while the denial receipt is pending', async () => {
    const { faux, execute, runtime } = fixture(50); faux.setResponses([response('bad'), read()]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: {
      ...validation(), reserveOutputTokens: () => 16_384,
      sourceRecovery: { maxForwards: 12, perForwardOutputTokens: 512, beforeForward: async () => true,
        isToolAllowed: () => false, onToolDenied: async () => new Promise<string>(() => {}) },
    } } }));
    expect(execute).not.toHaveBeenCalled(); expect(finals(messages)).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal?.error).toBe('Final validation whole-runtime deadline exhausted');
  });

  it.each(['throws', 'invalid'] as const)('fails closed on a %s coverage callback', async mode => {
    const { faux, streamFn, runtime } = fixture(); faux.setResponses([response('bad'), read()]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: {
      ...validation(), reserveOutputTokens: () => 16_384,
      sourceRecovery: { maxForwards: 12, perForwardOutputTokens: 512,
        beforeForward: async () => { if (mode === 'throws') throw Error('coverage read failed'); return {} as boolean; }, isToolAllowed: () => true },
    } } }));
    expect(streamFn).toHaveBeenCalledOnce(); expect(finals(messages)).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal?.status).toBe('failed');
  });

  it('fails before dispatch when the forward budget receipt cannot persist', async () => {
    const { faux, streamFn, runtime } = fixture(); faux.setResponses([response('bad'), read()]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: {
      ...validation(), reserveOutputTokens: () => 16_384,
      sourceRecovery: { maxForwards: 12, perForwardOutputTokens: 512, beforeForward: async () => true, isToolAllowed: () => true },
      onForward: async () => { throw Error('receipt failed'); },
    } } }));
    expect(streamFn).toHaveBeenCalledOnce(); expect(finals(messages)).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal?.error).toBe('Final validation forward budget receipt failed');
  });

  it('keeps cancellation while the source coverage callback is pending', async () => {
    const { faux, streamFn, runtime } = fixture(); faux.setResponses([response('bad'), read()]);
    const abortController = new AbortController(); let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const pending = collect(runtime.run({ operation: 'run', prompt: 'report', options: { abortController, hostFinalValidation: {
      ...validation(), reserveOutputTokens: () => 16_384,
      sourceRecovery: { maxForwards: 12, perForwardOutputTokens: 512,
        beforeForward: async () => { ready(); return new Promise<boolean>(() => {}); }, isToolAllowed: () => true },
    } } }));
    await started; abortController.abort(); const messages = await pending;
    expect(streamFn).toHaveBeenCalledOnce(); expect(finals(messages)).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'aborted', cleanupStatus: 'completed' });
  });

  it('keeps the original deadline while recovery coverage is pending', async () => {
    const { faux, streamFn, runtime } = fixture(50); faux.setResponses([response('bad'), read()]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: {
      ...validation(), reserveOutputTokens: () => 16_384,
      sourceRecovery: { maxForwards: 12, perForwardOutputTokens: 512,
        beforeForward: async () => new Promise<boolean>(() => {}), isToolAllowed: () => true },
    } } }));
    expect(streamFn).toHaveBeenCalledOnce(); expect(finals(messages)).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal?.error).toBe('Final validation whole-runtime deadline exhausted');
  });

  it.each([{ maxForwards: 13 }, { maxForwards: 0 }, { perForwardOutputTokens: 513 }, { perForwardOutputTokens: 0 }])('rejects an invalid recovery cap %j before any request', async override => {
    const { streamFn, runtime } = fixture();
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: {
      ...validation(), sourceRecovery: { maxForwards: 12, perForwardOutputTokens: 512, ...override,
        beforeForward: async () => true, isToolAllowed: () => true },
    } } }));
    expect(streamFn).not.toHaveBeenCalled();
    expect(messages.at(-2)?.runtimeTerminal?.error).toBe('Final validation source recovery configuration is invalid');
  });
  it('uses feedback in the same operation and emits one approved final only after cleanup', async () => {
    const { faux, streamFn, runtime } = fixture(); faux.setResponses([response('bad'), response('good')]);
    const option = validation();
    const originalClose = MemorySessionRepo.prototype.close;
    let closed = false;
    vi.spyOn(MemorySessionRepo.prototype, 'close').mockImplementationOnce(async function (this: MemorySessionRepo, ...args) {
      await originalClose.apply(this, args); closed = true;
    });
    const messages: AgentMessage[] = [];
    for await (const message of runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: option } })) {
      if (message.answerPhase === 'candidate_final') expect(closed).toBe(true);
      messages.push(message);
    }
    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(option.validate).toHaveBeenNthCalledWith(1, expect.objectContaining({ text: 'bad', attempt: 0 }));
    expect(option.validate).toHaveBeenNthCalledWith(2, expect.objectContaining({ text: 'good', attempt: 1 }));
    expect(option.reserveOutputTokens).toHaveBeenCalledOnce();
    expect(JSON.stringify(streamFn.mock.calls[1]?.[1].messages)).toContain('Correct the report using the same sources.');
    expect(messages).toContainEqual(expect.objectContaining({ type: 'result', content: 'bad', answerPhase: 'intermediate' }));
    expect(finals(messages)).toEqual([expect.objectContaining({ content: 'good' })]);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'completed', cleanupStatus: 'completed' });
    expect(messages.filter(message => message.type === 'runtime_terminal')).toHaveLength(1);
  });

  it('does not reserve or forward when the first candidate already passes', async () => {
    const { faux, streamFn, runtime } = fixture(); faux.setResponses([response('good')]);
    const option = validation();
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: option } }));
    expect(option.validate).toHaveBeenCalledOnce(); expect(option.reserveOutputTokens).not.toHaveBeenCalled();
    expect(streamFn).toHaveBeenCalledOnce(); expect(finals(messages)).toHaveLength(1);
  });

  it('hard fails after two corrections without publishing any invalid final candidate', async () => {
    const { faux, streamFn, runtime } = fixture(); faux.setResponses([response('bad'), response('bad again'), response('still bad'), response('must not run')]);
    const option = validation();
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: option } }));
    expect(streamFn).toHaveBeenCalledTimes(3); expect(option.validate).toHaveBeenCalledTimes(3);
    expect(option.reserveOutputTokens).toHaveBeenCalledOnce(); expect(finals(messages)).toHaveLength(0);
    expect(messages.filter(message => message.type === 'result' && message.answerPhase === 'intermediate')).toHaveLength(3);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', cleanupStatus: 'completed', error: 'Final validation correction limit exhausted' });
  });

  it('can read missing sources during corrections within four forwards and one output reservation', async () => {
    const { faux, execute, streamFn, runtime } = fixture();
    faux.setResponses([response('bad'), read(), response('bad after read'), read(), response('good')]);
    const option = validation();
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: option } }));
    expect(streamFn).toHaveBeenCalledTimes(5); expect(execute).toHaveBeenCalledTimes(2);
    expect(option.validate).toHaveBeenCalledTimes(3); expect(option.reserveOutputTokens).toHaveBeenCalledOnce();
    for (const args of streamFn.mock.calls.slice(1)) {
      expect(args[0].maxTokens).toBe(100); expect(args[2]?.maxTokens).toBe(100);
      expect(args[2]?.timeoutMs).toBeGreaterThan(0); expect(args[2]?.timeoutMs).toBeLessThanOrEqual(120_000);
    }
    expect(finals(messages)).toEqual([expect.objectContaining({ content: 'good' })]);
    expect(messages.at(-2)?.runtimeTerminal?.status).toBe('completed');
  });

  it('keeps the original host tool fence during corrections', async () => {
    const { faux, execute, streamFn, runtime } = fixture(); faux.setResponses([response('bad'), read(), response('good')]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: validation(),
      onBeforeToolUse: async () => { throw Error('original tool budget exhausted'); } } }));
    expect(execute).not.toHaveBeenCalled(); expect(streamFn).toHaveBeenCalledTimes(2); expect(finals(messages)).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', error: 'original tool budget exhausted' });
  });

  it('does not dispatch tools when no further correction forward can follow them', async () => {
    const { faux, execute, streamFn, runtime } = fixture(); faux.setResponses([response('bad'), read(), response('good')]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: { ...validation(), maxExtraForwards: 1 } } }));
    expect(execute).not.toHaveBeenCalled(); expect(streamFn).toHaveBeenCalledTimes(2); expect(finals(messages)).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal?.status).toBe('failed');
  });

  it('hard fails on a thrown validation callback even if the SDK swallows hook errors', async () => {
    const { faux, streamFn, runtime } = fixture(); faux.setResponses([response('bad'), response('good')]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: {
      ...validation(), validate: async () => { throw Error('host snapshot query failed'); },
    } } }));
    expect(streamFn).toHaveBeenCalledOnce(); expect(finals(messages)).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', error: 'host snapshot query failed' });
  });

  it.each(['', ' '.repeat(3), 'a'.repeat(16001)])('rejects invalid feedback without an extra request', async feedback => {
    const { faux, streamFn, runtime } = fixture(); faux.setResponses([response('bad')]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: {
      ...validation(), validate: async () => ({ ok: false, feedback }),
    } } }));
    expect(streamFn).toHaveBeenCalledOnce(); expect(finals(messages)).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal?.status).toBe('failed');
  });

  it('does not invent an unknown output reservation', async () => {
    const { faux, streamFn, runtime } = fixture(); faux.setResponses([response('bad')]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: {
      validate: async () => ({ ok: false, feedback: 'correct' }),
    } } }));
    expect(streamFn).toHaveBeenCalledOnce(); expect(finals(messages)).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal?.error).toContain('output budget');
  });

  it('does not invent an unknown whole-runtime deadline', async () => {
    const { faux, streamFn, runtime } = fixture(0); faux.setResponses([response('bad')]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: validation() } }));
    expect(streamFn).toHaveBeenCalledOnce(); expect(finals(messages)).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal?.error).toContain('deadline is unknown');
  });

  it('enforces the original deadline while the host callback is pending', async () => {
    const { faux, streamFn, runtime } = fixture(50); faux.setResponses([response('bad')]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: {
      ...validation(), validate: async () => new Promise(() => {}),
    } } }));
    expect(streamFn).toHaveBeenCalledOnce(); expect(finals(messages)).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', error: 'Final validation whole-runtime deadline exhausted' });
  });

  it('keeps user cancellation while a host callback is pending', async () => {
    const { faux, streamFn, runtime } = fixture(); faux.setResponses([response('bad')]);
    const abortController = new AbortController(); let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const pending = collect(runtime.run({ operation: 'run', prompt: 'report', options: { abortController, hostFinalValidation: {
      ...validation(), validate: async () => { ready(); return new Promise(() => {}); },
    } } }));
    await started; abortController.abort(); const messages = await pending;
    expect(streamFn).toHaveBeenCalledOnce(); expect(finals(messages)).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'aborted', cleanupStatus: 'completed' });
  });

  it('withholds an approved candidate when cleanup fails', async () => {
    const { faux, runtime } = fixture(); faux.setResponses([response('good')]);
    const originalClose = MemorySessionRepo.prototype.close;
    vi.spyOn(MemorySessionRepo.prototype, 'close').mockImplementationOnce(async function (this: MemorySessionRepo, ...args) {
      await originalClose.apply(this, args); throw Error('cleanup failed');
    });
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: validation() } }));
    expect(finals(messages)).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', cleanupStatus: 'failed' });
  });

  it('rejects readonly continuation and validation configured together before forwarding', async () => {
    const { streamFn, runtime } = fixture();
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report', options: { hostFinalValidation: validation(),
      hostReadonlyContinuation: { beforeClose: async () => null },
    } }));
    expect(streamFn).not.toHaveBeenCalled(); expect(finals(messages)).toHaveLength(0);
    expect(messages.at(-2)?.runtimeTerminal?.error).toContain('cannot coexist');
  });

  it('keeps validation off and preserves existing message boundaries without the option', async () => {
    const { faux, streamFn, runtime } = fixture(); faux.setResponses([read(), response('ordinary final')]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'ordinary work' }));
    expect(streamFn).toHaveBeenCalledTimes(2); expect(finals(messages)).toEqual([expect.objectContaining({ content: 'ordinary final' })]);
    expect(messages.at(-2)?.runtimeTerminal?.status).toBe('completed');
  });
});
