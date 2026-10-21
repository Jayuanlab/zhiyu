import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentOptions } from '@openzhiyu/ai/agent/types';
import { createPiAgentRuntime } from '@openzhiyu/ai/agent/runtime';
import type { WorkingMemorySnapshot } from '@openzhiyu/ai/agent/runtime/host-working-memory';
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, Type } from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

async function collect(source: AsyncGenerator<AgentMessage>) {
  const messages: AgentMessage[] = [];
  for await (const message of source) messages.push(message);
  return messages;
}
const state = { facts: [], hypotheses: [], openQuestions: ['What is the next scoped observation?'],
  nextAction: { text: 'Inspect the next authorized source.', evidenceIds: [] } };
function fixture(log: boolean, auditFails = false) {
  const responses = log ? [fauxAssistantMessage([fauxToolCall('workingMemory', {
    operation: 'update', commandId: 'save-notebook', expectedVersion: 0,
    state, pruneToolCallIds: [], phase: 'LOG',
  })], { stopReason: 'toolUse' }), fauxAssistantMessage('A final report is not a save receipt.')]
    : [fauxAssistantMessage('The notes were saved.')];
  let index = 0;
  const streamFn = vi.fn<StreamFn>(async () => {
    const message = responses[index++];
    if (!message) throw Error('Unexpected extra forward in fixture');
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: { ...message, content: [] } });
    stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
    stream.end(message);
    return stream;
  });
  const read: AgentTool = { name: 'read', label: 'Local read', description: 'Read the local fixture source.',
    parameters: Type.Object({}), execute: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'local source' }], details: {} })) };
  const runtime = createPiAgentRuntime({ adapter: 'harness', model: createFauxCore({}).getModel(), tools: [read], streamFn });
  const audited = vi.fn(async () => { if (auditFails) throw Error('Local fixture audit storage unavailable'); });
  const snapshots: Array<WorkingMemorySnapshot | undefined> = [];
  const validate = vi.fn(async (candidate: Parameters<NonNullable<AgentOptions['hostFinalValidation']>['validate']>[0]) => {
    const observed = candidate.workingMemory;
    snapshots.push(observed);
    return observed?.version === 1 && observed.logCount === 1 && observed.state.openQuestions[0] === state.openQuestions[0]
      ? { ok: true as const } : { ok: false as const, feedback: 'The required notebook has no accepted LOG update.' };
  });
  const options: AgentOptions = {
    hostWorkingMemory: { mode: 'apply', readonlyToolNames: ['read'], deniedToolNames: [], maxEdits: 2,
      maxSummaryChars: 4000, onAudit: audited },
    hostFinalValidation: { validate, maxCorrections: 0, maxExtraForwards: 1, timeoutMs: 120000 },
  };
  return { run: () => collect(runtime.run({ operation: 'run', prompt: 'Complete a scoped notebook task.', options })),
    audited, snapshots, validate, read, streamFn };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Final delivery validation observes actual committed working memory', () => {
  it('provides the committed host snapshot after an accepted LOG, before final approval', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw Error('Network is forbidden in this unit fixture'); }));
    const test = fixture(true);
    const messages = await test.run();
    expect(test.audited).toHaveBeenCalledTimes(1);
    expect(test.validate).toHaveBeenCalledTimes(1);
    expect(test.audited.mock.invocationCallOrder[0]).toBeLessThan(test.validate.mock.invocationCallOrder[0]);
    expect(test.snapshots[0]).toMatchObject({ version: 1, logCount: 1, state });
    expect(test.read.execute).not.toHaveBeenCalled();
    expect(test.streamFn).toHaveBeenCalledTimes(2);
    expect(messages.find(message => message.type === 'runtime_terminal')?.runtimeTerminal).toMatchObject({ status: 'completed', cleanupStatus: 'completed' });
  });
  it('does not treat report text claiming a save as a committed LOG', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw Error('Network is forbidden in this unit fixture'); }));
    const test = fixture(false);
    const messages = await test.run();
    expect(test.audited).not.toHaveBeenCalled();
    expect(test.validate).toHaveBeenCalledTimes(1);
    expect(test.snapshots[0]).toMatchObject({ version: 0, logCount: 0 });
    expect(messages.find(message => message.type === 'runtime_terminal')?.runtimeTerminal).toMatchObject({ status: 'failed', cleanupStatus: 'completed' });
    expect(messages.some(message => message.type === 'result' && message.answerPhase === 'committed')).toBe(false);
  });
  it('keeps a precommit audit failure out of the snapshot even when the model requested a LOG', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw Error('Network is forbidden in this unit fixture'); }));
    const test = fixture(true, true);
    const messages = await test.run();
    expect(test.audited).toHaveBeenCalledTimes(1);
    expect(test.validate).toHaveBeenCalledTimes(1);
    expect(test.snapshots[0]).toMatchObject({ version: 0, logCount: 0, state: {
      facts: [], hypotheses: [], openQuestions: [], nextAction: { text: '', evidenceIds: [] },
    } });
    expect(messages.find(message => message.type === 'runtime_terminal')?.runtimeTerminal)
      .toMatchObject({ status: 'failed', cleanupStatus: 'completed' });
    expect(messages.some(message => message.type === 'result' && message.answerPhase === 'committed')).toBe(false);
    expect(test.read.execute).not.toHaveBeenCalled();
  });
});
