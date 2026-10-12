import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPiAgentRuntime } from '@openzhiyu/ai/agent/runtime';
import type { AgentMessage, AgentOptions } from '@openzhiyu/ai/agent/types';
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { createHostReadonlyContinuation } from '../../../../packages/ai/src/agent/runtime/host-readonly-continuation';
import { Type } from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

async function collect(source: AsyncGenerator<AgentMessage>) { const messages: AgentMessage[] = []; for await (const message of source) messages.push(message); return messages; }
function fixture(names = ['platformRecall'], timeoutMs?: number) {
  const faux = createFauxCore({});
  const executes = Object.fromEntries(names.map(name => [name, vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'committed field' }], details: {} }))]));
  const tools: AgentTool[] = names.map(name => ({ name, label: name, description: name,
    parameters: Type.Object({ readHandle: Type.Optional(Type.String()) }, { additionalProperties: true }), execute: executes[name]! }));
  const streamFn = vi.fn<StreamFn>(async (...args) => faux.streamSimple(...args));
  const runtime = createPiAgentRuntime({ adapter: 'harness', model: { ...faux.getModel(), maxTokens: 100 }, streamFn, tools,
    streamOptions: timeoutMs ? { timeoutMs } : undefined });
  return { faux, executes, streamFn, runtime };
}
function options(readHandles = ['allowed']): NonNullable<AgentOptions['hostReadonlyContinuation']> {
  return { beforeClose: vi.fn(async () => ({ followUp: 'Read only these host handles.', readHandles })), reserveOutputTokens: vi.fn(() => 200), onEpisodeStarted: vi.fn() };
}
const draft = () => fauxAssistantMessage('initial draft');
const read = (handle = 'allowed', name = 'platformRecall', extra: Record<string, unknown> = {}) => fauxAssistantMessage(fauxToolCall(name, { readHandle: handle, ...extra }), { stopReason: 'toolUse' });
const final = () => fauxAssistantMessage('bounded final');
afterEach(() => vi.restoreAllMocks());

describe('Pi host readonly continuation using the actual SDK lane', () => {
  it('uses one episode, two real extra forwards and a pre-reserved output grant', async () => {
    const { faux, executes, streamFn, runtime } = fixture(['platformRecall'], 120_000);
    faux.setResponses([draft(), read(), final()]);
    const continuation = options();
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'read', options: { hostReadonlyContinuation: continuation } }));
    expect(streamFn).toHaveBeenCalledTimes(3);
    expect(executes.platformRecall).toHaveBeenCalledOnce();
    expect(continuation.beforeClose).toHaveBeenCalledOnce();
    expect(continuation.reserveOutputTokens).toHaveBeenCalledOnce();
    expect(continuation.onEpisodeStarted).toHaveBeenCalledWith({ readHandles: ['allowed'], maxForwards: 2, maxReads: 2, reservedOutputTokens: 200 });
    expect(streamFn.mock.calls.slice(1).map(call => [call[0].maxTokens, call[2]?.maxTokens])).toEqual([[100, 100], [100, 100]]);
    for (const call of streamFn.mock.calls.slice(1)) expect(call[2]?.timeoutMs).toBeLessThanOrEqual(120_000);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'completed', cleanupStatus: 'completed' });
  });
  it('rejects a read in the final extra response before dispatch or a third forward', async () => {
    const { faux, executes, streamFn, runtime } = fixture();
    faux.setResponses([draft(), read('first'), read('second'), final()]);
    const continuation = options(['first', 'second']);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'read', options: { hostReadonlyContinuation: continuation } }));
    expect(streamFn).toHaveBeenCalledTimes(3); // Original plus exactly two extra requests.
    expect(executes.platformRecall).toHaveBeenCalledOnce();
    expect(continuation.beforeClose).toHaveBeenCalledOnce();
    expect(messages.some(message => message.type === 'error' && message.message?.includes('final phase'))).toBe(true);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', cleanupStatus: 'completed' });
    expect(messages.filter(message => message.type === 'runtime_terminal')).toHaveLength(1);
    expect(messages.filter(message => message.type === 'done')).toHaveLength(1);
  });
  it('rejects an allowlisted repeated handle in the final extra response', async () => {
    const { faux, executes, streamFn, runtime } = fixture();
    faux.setResponses([draft(), read(), read(), final()]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'read', options: { hostReadonlyContinuation: options() } }));
    expect(streamFn).toHaveBeenCalledTimes(3);
    expect(executes.platformRecall).toHaveBeenCalledOnce();
    expect(messages.some(message => message.type === 'error' && message.message?.includes('final phase'))).toBe(true);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', cleanupStatus: 'completed' });
  });
  it('still allows two reads in the first extra response followed by a final response', async () => {
    const { faux, executes, streamFn, runtime } = fixture();
    faux.setResponses([draft(), fauxAssistantMessage([
      fauxToolCall('platformRecall', { readHandle: 'first' }), fauxToolCall('platformRecall', { readHandle: 'second' }),
    ], { stopReason: 'toolUse' }), final()]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'read', options: { hostReadonlyContinuation: options(['first', 'second']) } }));
    expect(streamFn).toHaveBeenCalledTimes(3);
    expect(executes.platformRecall).toHaveBeenCalledTimes(2);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'completed', cleanupStatus: 'completed' });
  });
  it('independently fences final-phase dispatch and the third actual provider forward', async () => {
    const faux = createFauxCore({});
    faux.setResponses([final(), final()]);
    const streamFn = vi.fn<StreamFn>(async (...args) => faux.streamSimple(...args));
    const episode = createHostReadonlyContinuation({ options: options(), signal: new AbortController().signal, toolNames: ['platformRecall'] });
    expect(await episode.beforeClose()).toMatchObject({ followUp: 'Read only these host handles.' });
    const stream = episode.wrapStream(streamFn);
    const context = { messages: [] };
    for (let index = 0; index < 2; index++) {
      const response = await stream({ ...faux.getModel(), maxTokens: 100 }, context);
      for await (const _event of response) { /* Consume the actual SDK stream. */ }
    }
    expect(() => episode.beforeTool('platformRecall', { readHandle: 'allowed' }, true)).toThrow('final phase');
    expect(streamFn).toHaveBeenCalledTimes(2);
    await expect(stream({ ...faux.getModel(), maxTokens: 100 }, context)).rejects.toThrow();
    expect(streamFn).toHaveBeenCalledTimes(2);
    const separate = createHostReadonlyContinuation({ options: options(), signal: new AbortController().signal, toolNames: ['platformRecall'] });
    await separate.beforeClose();
    const separateStream = separate.wrapStream(streamFn);
    faux.setResponses([final(), final()]);
    for (let index = 0; index < 2; index++) {
      const response = await separateStream({ ...faux.getModel(), maxTokens: 100 }, context);
      for await (const _event of response) { /* Consume without response hooks. */ }
    }
    await expect(separateStream({ ...faux.getModel(), maxTokens: 100 }, context)).rejects.toThrow('forward limit');
    expect(streamFn).toHaveBeenCalledTimes(4);
  });
  it.each(['askMemory', 'write', 'discover', 'unregistered'])('rejects %s even when the SDK would accept or fail its lookup', async name => {
    const { faux, executes, streamFn, runtime } = fixture(['platformRecall', 'askMemory', 'write', 'discover']);
    faux.setResponses([draft(), read('allowed', name), final()]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'read', options: { hostReadonlyContinuation: options() } }));
    expect(streamFn).toHaveBeenCalledTimes(2);
    for (const execute of Object.values(executes)) expect(execute).not.toHaveBeenCalled();
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', cleanupStatus: 'completed' });
  });
  it.each([{ readHandle: 'other' }, { readHandle: 'allowed', records: [] }, { question: 'discover' }, { readHandle: 'allowed', source: 'message' }])('rejects non-allowlisted or expanded read parameters: %j', async params => {
    const { faux, executes, streamFn, runtime } = fixture();
    faux.setResponses([draft(), fauxAssistantMessage(fauxToolCall('platformRecall', params), { stopReason: 'toolUse' }), final()]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'read', options: { hostReadonlyContinuation: options() } }));
    expect(executes.platformRecall).not.toHaveBeenCalled();
    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(messages.at(-2)?.runtimeTerminal?.status).toBe('failed');
  });
  it('checks permission-updated parameters again before tool dispatch', async () => {
    const { faux, executes, streamFn, runtime } = fixture();
    faux.setResponses([draft(), read(), final()]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'read', options: { hostReadonlyContinuation: options(),
      onPermissionRequest: async () => ({ behavior: 'allow', updatedInput: { readHandle: 'allowed', records: [] } }) } }));
    expect(executes.platformRecall).not.toHaveBeenCalled();
    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(messages.at(-2)?.runtimeTerminal?.status).toBe('failed');
  });
  it('rejects more than two reads in one response before dispatch', async () => {
    const { faux, executes, streamFn, runtime } = fixture();
    faux.setResponses([draft(), fauxAssistantMessage([fauxToolCall('platformRecall', { readHandle: 'allowed' }), fauxToolCall('platformRecall', { readHandle: 'allowed' }), fauxToolCall('platformRecall', { readHandle: 'allowed' })], { stopReason: 'toolUse' })]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'read', options: { hostReadonlyContinuation: options() } }));
    expect(executes.platformRecall).not.toHaveBeenCalled();
    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(messages.at(-2)?.runtimeTerminal?.status).toBe('failed');
  });
  it('awaits entry_added tool context receipts before deciding whether to close', async () => {
    const { faux, executes, runtime } = fixture();
    faux.setResponses([read('initial'), draft(), read(), final()]);
    const committed: string[] = [];
    const continuation = options();
    continuation.beforeClose = vi.fn(async () => {
      expect(committed).toHaveLength(1);
      return { followUp: 'Read allowed.', readHandles: ['allowed'] };
    });
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'read', options: { hostReadonlyContinuation: continuation,
      onToolContextCommitted: async receipt => { await Promise.resolve(); expect(receipt.entryId).toBeTruthy(); expect(receipt.modelText).toBe('committed field'); committed.push(receipt.toolCallId); } } }));
    expect(executes.platformRecall).toHaveBeenCalledTimes(2);
    expect(committed).toHaveLength(2);
    expect(continuation.beforeClose).toHaveBeenCalledOnce();
    expect(messages.at(-2)?.runtimeTerminal?.status).toBe('completed');
  });
  it.each([{ handles: [] }, { handles: ['same', 'same'] }, { handles: ['one', 'two', 'three'] }])('does not start an episode with invalid handles: %j', async ({ handles }) => {
    const { faux, streamFn, runtime } = fixture(); faux.setResponses([draft()]);
    const continuation = options(handles);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'read', options: { hostReadonlyContinuation: continuation } }));
    expect(streamFn).toHaveBeenCalledOnce();
    expect(continuation.reserveOutputTokens).not.toHaveBeenCalled();
    expect(continuation.onEpisodeStarted).not.toHaveBeenCalled();
    expect(messages.at(-2)?.runtimeTerminal?.status).toBe('completed');
  });
  it.each([undefined, null, 0, -1, NaN])('keeps an unknown/invalid output grant off without guessing usage: %s', async grant => {
    const { faux, streamFn, runtime } = fixture(); faux.setResponses([draft()]);
    const continuation = options(); continuation.reserveOutputTokens = grant === undefined ? undefined : vi.fn(() => grant);
    await collect(runtime.run({ operation: 'run', prompt: 'read', options: { hostReadonlyContinuation: continuation } }));
    expect(streamFn).toHaveBeenCalledOnce(); expect(continuation.onEpisodeStarted).not.toHaveBeenCalled();
  });
  it('does not reset the episode across separate requests or change default-off behavior', async () => {
    const { faux, streamFn, runtime } = fixture();
    const continuation = options();
    for (let index = 0; index < 2; index++) { faux.setResponses([draft(), read(), final()]); await collect(runtime.run({ operation: 'run', prompt: 'read', options: { sessionId: 'same-session', hostReadonlyContinuation: continuation } })); }
    expect(continuation.beforeClose).toHaveBeenCalledTimes(2); expect(continuation.reserveOutputTokens).toHaveBeenCalledTimes(2); expect(streamFn).toHaveBeenCalledTimes(6);
    faux.setResponses([draft()]); await collect(runtime.run({ operation: 'run', prompt: 'default off' })); expect(streamFn).toHaveBeenCalledTimes(7);
  });
  it('preserves user cancellation while host beforeClose is pending', async () => {
    const { faux, streamFn, runtime } = fixture(); faux.setResponses([draft()]);
    const abortController = new AbortController();
    const continuation = options(); continuation.beforeClose = vi.fn(async () => { abortController.abort(); return { followUp: 'never', readHandles: ['allowed'] }; });
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'read', options: { abortController, hostReadonlyContinuation: continuation } }));
    expect(streamFn).toHaveBeenCalledOnce(); expect(continuation.reserveOutputTokens).not.toHaveBeenCalled(); expect(continuation.onEpisodeStarted).not.toHaveBeenCalled();
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'aborted', cleanupStatus: 'completed' });
  });
  it('preserves user cancellation during the actual extra provider call', async () => {
    const { faux, streamFn, runtime } = fixture(); faux.setResponses([draft()]);
    const abortController = new AbortController();
    const originalStream = streamFn.getMockImplementation()!;
    streamFn.mockImplementation(async (...args) => {
      if (streamFn.mock.calls.length === 1) return originalStream(...args);
      abortController.abort();
      args[2]?.signal?.throwIfAborted();
      throw new Error('aborted');
    });
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'read', options: { abortController, hostReadonlyContinuation: options() } }));
    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'aborted', cleanupStatus: 'completed' });
  });
  it('fails instead of renewing an exhausted original timeout', async () => {
    const { faux, streamFn, runtime } = fixture(['platformRecall'], 10); faux.setResponses([draft()]);
    const continuation = options(); continuation.beforeClose = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 15));
      return { followUp: 'too late', readHandles: ['allowed'] };
    });
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'read', options: { hostReadonlyContinuation: continuation } }));
    expect(streamFn).toHaveBeenCalledOnce();
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', cleanupStatus: 'completed' });
  });
  it('does not manufacture success when an episode response is cut off by output length', async () => {
    const { faux, streamFn, runtime } = fixture(); faux.setResponses([draft(), fauxAssistantMessage('cut off', { stopReason: 'length' })]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'read', options: { hostReadonlyContinuation: options() } }));
    expect(streamFn).toHaveBeenCalledTimes(2); expect(messages.at(-2)?.runtimeTerminal?.status).toBe('failed');
  });
  it.each(['beforeClose', 'reserveOutputTokens', 'onEpisodeStarted'] as const)('does not forward after the host %s callback rejects', async stage => {
    const { faux, executes, streamFn, runtime } = fixture(); faux.setResponses([draft(), read(), final()]);
    const continuation = options();
    continuation[stage] = vi.fn(async () => { throw new Error('host admission or audit failure'); });
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'read', options: { hostReadonlyContinuation: continuation } }));
    expect(streamFn).toHaveBeenCalledOnce(); expect(executes.platformRecall).not.toHaveBeenCalled();
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', cleanupStatus: 'completed' });
  });
  it('fails and cleans up after the original host tool budget rejects during an episode', async () => {
    const { faux, executes, streamFn, runtime } = fixture(); faux.setResponses([draft(), read(), final()]);
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'read', options: { hostReadonlyContinuation: options(),
      onBeforeToolUse: async () => { throw new Error('original host tool budget exhausted'); } } }));
    expect(executes.platformRecall).not.toHaveBeenCalled(); expect(streamFn).toHaveBeenCalledTimes(2);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', cleanupStatus: 'completed', error: 'original host tool budget exhausted' });
  });
  it('fails without another forward when the entry_added audit observer rejects', async () => {
    const { faux, streamFn, runtime } = fixture(); faux.setResponses([read('initial'), draft(), read(), final()]);
    const continuation = options();
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'read', options: { hostReadonlyContinuation: continuation,
      onToolContextCommitted: async () => { throw new Error('context audit failed'); } } }));
    expect(streamFn).toHaveBeenCalledOnce(); expect(continuation.beforeClose).not.toHaveBeenCalled();
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'failed', cleanupStatus: 'completed' });
    expect(messages.at(-2)?.runtimeTerminal?.error).toContain('context audit failed');
  });
  it('prioritizes actual user cancellation over a later internal host fence failure', async () => {
    const { faux, executes, streamFn, runtime } = fixture(); faux.setResponses([draft(), read(), final()]);
    const abortController = new AbortController();
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'read', options: { abortController, hostReadonlyContinuation: options(),
      onBeforeToolUse: async () => { abortController.abort(); throw new Error('host failed after user cancelled'); } } }));
    expect(executes.platformRecall).not.toHaveBeenCalled(); expect(streamFn).toHaveBeenCalledTimes(2);
    expect(messages.at(-2)?.runtimeTerminal).toMatchObject({ status: 'aborted', cleanupStatus: 'completed' });
  });
});
