import { describe, expect, it, vi } from 'vitest';
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createPiAgentRuntime } from '@openzhiyu/ai/agent/runtime';
import type { AgentMessage } from '@openzhiyu/ai/agent/types';
import { createWorkshopRuntimeFinalOutput } from '@/lib/workshops/runtime-final-output';

async function collect(source: AsyncGenerator<AgentMessage>) {
  const messages: AgentMessage[] = [];
  for await (const message of source) messages.push(message);
  return messages;
}

describe.each(['harness', 'agent'] as const)('Pi %s final response boundary', (adapter) => {
  it('keeps a tool-bound partial JSON separate from the final assistant response', async () => {
    const faux = createFauxCore({});
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'source receipt' }], details: {} }));
    const tool: AgentTool = { name: 'read', label: 'read', description: 'local source read', parameters: Type.Object({}), execute };
    const partial = 'Now prepare the report.\n```json\n{"presentation":{"reportMarkdown":"unfinished draft';
    const final = JSON.stringify({ researchEvidence: { works: [], gaps: ['unread source'] }, summary: 'single final response' });
    faux.setResponses([
      fauxAssistantMessage([{ type: 'text', text: partial }, fauxToolCall('read', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage(final),
    ]);
    const streamFn = vi.fn<StreamFn>(async (...args) => faux.streamSimple(...args));
    const runtime = createPiAgentRuntime({ adapter, model: faux.getModel(), streamFn, tools: [tool] });
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'read then report' }));
    const collector = createWorkshopRuntimeFinalOutput(runtime.metadata);
    messages.forEach(message => collector.observe(message));
    expect(collector.finish()).toMatchObject({ ok: true, text: final, transcript: partial + final,
      metadata: { mode: adapter === 'harness' ? 'pi-harness-terminal' : 'pi-agent-candidate' } });

    expect(execute).toHaveBeenCalledOnce();
    expect(streamFn).toHaveBeenCalledTimes(2);
    // All text events are a display transcript, not a single final document.
    expect(messages.filter(message => message.type === 'text').map(message => message.content ?? '').join('')).toBe(partial + final);
    expect(messages.filter(message => message.type === 'result')).toEqual([
      expect.objectContaining({ content: partial, answerPhase: 'intermediate' }),
      expect.objectContaining({ content: final, answerPhase: 'candidate_final' }),
    ]);
    expect(messages.filter(message => message.type === 'result' && message.answerPhase === 'candidate_final')).toHaveLength(1);
    expect(messages.at(-1)?.type).toBe('done');
  });

  it('does not append the full message_end snapshot to its streamed text again', async () => {
    const faux = createFauxCore({});
    const response = JSON.stringify({ summary: 'one result', body: 'first line\nsecond line', works: ['math', 'r1', 'grm'] });
    faux.setResponses([fauxAssistantMessage(response)]);
    const runtime = createPiAgentRuntime({ adapter, model: faux.getModel(), streamFn: faux.streamSimple });
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report' }));
    expect(messages.filter(message => message.type === 'text').map(message => message.content ?? '').join('')).toBe(response);
    expect(messages.filter(message => message.type === 'result')).toEqual([
      expect.objectContaining({ content: response, answerPhase: 'candidate_final' }),
    ]);
  });

  it('preserves a malformed final response rather than salvaging its last JSON', async () => {
    const faux = createFauxCore({});
    const malformed = '```json\n{"presentation":{"reportMarkdown":"unfinished\nNow compile another report.\n```json\n{"summary":"later object"}\n```';
    faux.setResponses([fauxAssistantMessage(malformed)]);
    const runtime = createPiAgentRuntime({ adapter, model: faux.getModel(), streamFn: faux.streamSimple });
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report' }));
    expect(messages.filter(message => message.type === 'result')).toEqual([
      expect.objectContaining({ content: malformed, answerPhase: 'candidate_final' }),
    ]);
    expect(messages.filter(message => message.type === 'text').map(message => message.content ?? '').join('')).toBe(malformed);
  });

  it('does not label an output-length stop as a final candidate', async () => {
    const faux = createFauxCore({});
    const partial = '{"presentation":{"reportMarkdown":"output stopped';
    faux.setResponses([fauxAssistantMessage(partial, { stopReason: 'length' })]);
    const runtime = createPiAgentRuntime({ adapter, model: faux.getModel(), streamFn: faux.streamSimple });
    const messages = await collect(runtime.run({ operation: 'run', prompt: 'report' }));
    if (adapter === 'harness') {
      expect(messages.filter(message => message.type === 'result')).toEqual([]);
      expect(messages.find(message => message.type === 'runtime_terminal')?.runtimeTerminal)
        .toMatchObject({ status: 'failed', error: expect.stringContaining('[provider_output_truncated]') });
    } else {
      expect(messages.filter(message => message.type === 'result')).toEqual([
        expect.objectContaining({ content: partial, answerPhase: 'intermediate' }),
      ]);
    }
    expect(messages.some(message => message.type === 'result' && message.answerPhase === 'candidate_final')).toBe(false);
  });
});
