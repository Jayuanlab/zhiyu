import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPiAgentRuntime } from '@openzhiyu/ai/agent/runtime';
import type { AgentMessage } from '@openzhiyu/ai/agent/types';
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { createGuardedPiTool } from '@/lib/ai/runtime/pi-tool-adapter';

async function collect(source: AsyncGenerator<AgentMessage>) {
  const messages: AgentMessage[] = [];
  for await (const message of source) messages.push(message);
  return messages;
}

function fixture(tools: AgentTool[] = [], systemPrompt?: string) {
  const faux = createFauxCore({});
  const streamFn = vi.fn<StreamFn>(async (...args) =>
    faux.streamSimple(...args),
  );
  const runtime = createPiAgentRuntime({
    adapter: 'harness',
    model: faux.getModel(),
    streamFn,
    tools,
    systemPrompt,
  });
  return { faux, streamFn, runtime };
}

afterEach(() => vi.unstubAllEnvs());

describe('Pi Harness host integration', () => {
  it('passes the exact host system instructions to the first model context', async () => {
    const systemPrompt = 'Project rules:\nObserve before acting.\n\nWork role: analyst.\n';
    const { runtime, streamFn, faux } = fixture([], systemPrompt);
    faux.setResponses([fauxAssistantMessage('observed')]);
    const messages = await collect(
      runtime.run({ operation: 'run', prompt: 'Inspect the current sources.' }),
    );

    expect(streamFn).toHaveBeenCalledOnce();
    const firstContext = streamFn.mock.calls[0]?.[1];
    expect(firstContext?.systemPrompt).toBe(systemPrompt);
    expect(JSON.stringify(firstContext?.messages)).toContain('Inspect the current sources.');
    expect(JSON.stringify(firstContext?.messages)).not.toContain('Project rules:');
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'result', content: 'observed' }),
    );
  });

  it('supports explicit rollback and rejects unknown adapter names', () => {
    const faux = createFauxCore({});
    const options = { model: faux.getModel(), streamFn: faux.streamSimple };
    vi.stubEnv('PI_RUNTIME_ADAPTER', 'agent');
    expect(createPiAgentRuntime(options).metadata.adapter).toBe(
      'pi-agent-core',
    );
    expect(
      createPiAgentRuntime({ ...options, adapter: 'harness' }).metadata.adapter,
    ).toBe('pi-agent-harness');
    vi.stubEnv('PI_RUNTIME_ADAPTER', 'typo');
    expect(() => createPiAgentRuntime(options)).toThrow(
      'Unknown PI_RUNTIME_ADAPTER',
    );
  });

  it('does not dispatch a pre-aborted request', async () => {
    const { runtime, streamFn } = fixture();
    const abortController = new AbortController();
    abortController.abort();
    const messages = await collect(
      runtime.run({
        operation: 'run',
        prompt: 'never',
        options: { abortController },
      }),
    );
    expect(streamFn).not.toHaveBeenCalled();
    expect(messages.map((m) => m.type)).toEqual(['error', 'done']);
  });

  it('forwards configured provider stream timeouts to Pi streams', async () => {
    const faux = createFauxCore({});
    const streamFn = vi.fn<StreamFn>(async (...args) =>
      faux.streamSimple(...args),
    );
    const runtime = createPiAgentRuntime({
      adapter: 'harness',
      model: faux.getModel(),
      streamFn,
      streamOptions: { timeoutMs: 120_000 },
    });
    faux.setResponses([fauxAssistantMessage('ok')]);

    await collect(runtime.run({ operation: 'run', prompt: 'hello' }));

    expect(streamFn).toHaveBeenCalledOnce();
    expect(streamFn.mock.calls[0]?.[2]).toMatchObject({
      timeoutMs: 120_000,
    });
  });

  it('isolates history even when a host session id is reused', async () => {
    const { runtime, streamFn, faux } = fixture();
    faux.setResponses([
      fauxAssistantMessage('private reply'),
      fauxAssistantMessage('fresh reply'),
    ]);
    await collect(
      runtime.run({
        operation: 'run',
        prompt: 'private marker',
        options: { sessionId: 'shared' },
      }),
    );
    await collect(
      runtime.run({
        operation: 'run',
        prompt: 'fresh',
        options: { sessionId: 'shared' },
      }),
    );
    const second = streamFn.mock.calls[1]?.[1];
    expect(JSON.stringify(second)).not.toContain('private');
    expect(JSON.stringify(second)).toContain('fresh');
  });

  it('preserves denied-over-allowed policy and awaited audit traces', async () => {
    const execute = vi.fn(async () => 'written');
    const onTrace = vi.fn(async () => undefined);
    const tool = createGuardedPiTool({
      name: 'write',
      description: 'write',
      parameters: Type.Object({}),
      policy: { allowedTools: ['write'], deniedTools: ['write'] },
      execute,
      onTrace,
    });
    const { runtime, faux } = fixture([tool]);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('write', {}), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('denied'),
    ]);
    const messages = await collect(
      runtime.run({ operation: 'run', prompt: 'write' }),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(onTrace).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'denied' }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'tool_result', isError: true }),
    );
    expect(messages.at(-1)?.type).toBe('done');
  });

  it('emits a tool result for platformRecall-shaped tools with section arrays', async () => {
    const execute = vi.fn(async () => ({
      ok: true,
      question: '查询记录 44861dfc-916f-431f-899b-364ca54f0aa1',
      sections: ['registry', 'works'],
      registryVersion: 'platform-information-registry-v1',
      data: {
        registry: Array.from({ length: 6 }, (_, index) => ({
          id: `registry-${index}`,
          title: `Registry ${index}`,
          memoryPolicy: 'read_live',
        })),
        works: {
          workshops: Array.from({ length: 30 }, (_, index) => ({
            id: `work-${index}`,
            name: index === 0 ? 'AI 知识博主' : `Work ${index}`,
            mission: '持续生产和复盘 AI 知识内容',
            status: 'active',
            boundaries: ['read-only recall', 'review before change'],
          })),
        },
      },
      warnings: ['Live sections are current reads.'],
      text: JSON.stringify({
        answer: 'AI 知识博主当前 active',
        evidence: Array.from({ length: 30 }, (_, index) => `work-${index}`),
      }),
    }));
    const tool = createGuardedPiTool({
      name: 'platformRecall',
      description: 'Recall platform information',
      parameters: Type.Object({
        question: Type.Optional(Type.String()),
        sections: Type.Optional(Type.Array(Type.String())),
        limit: Type.Optional(Type.Number()),
      }),
      policy: { allowedTools: ['platformRecall'] },
      execute,
      formatResult: (result) =>
        typeof (result as { text?: unknown }).text === 'string'
          ? (result as { text: string }).text
          : JSON.stringify(result),
    });
    const { runtime, faux } = fixture([tool]);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall('platformRecall', {
          question: '查询记录 44861dfc-916f-431f-899b-364ca54f0aa1（AI 知识博主）的使命和当前状态',
          sections: ['registry', 'works'],
        }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('已根据 platformRecall 回答。'),
    ]);

    const messages = await collect(
      runtime.run({ operation: 'run', prompt: 'recall platform work' }),
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'tool_use',
        name: 'platformRecall',
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        toolUseId: expect.any(String),
        isError: false,
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'result',
        content: '已根据 platformRecall 回答。',
      }),
    );
  });

  it('terminates on a rejected host fence before tool dispatch', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'written' }],
      details: {},
    }));
    const { runtime, faux, streamFn } = fixture([
      {
        name: 'write',
        label: 'write',
        description: 'write',
        parameters: Type.Object({}),
        execute,
      },
    ]);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('write', {}), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('must not continue'),
    ]);
    const onBeforeToolUse = vi.fn(async () => {
      throw new Error('lease lost');
    });
    const messages = await collect(
      runtime.run({
        operation: 'run',
        prompt: 'write',
        options: { onBeforeToolUse },
      }),
    );
    expect(onBeforeToolUse).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(streamFn).toHaveBeenCalledOnce();
    expect(messages.some((m) => m.type === 'error')).toBe(true);
    expect(messages.filter((m) => m.type === 'done')).toHaveLength(1);
  });

  it('surfaces asynchronous provider failure without retry or false success', async () => {
    const { runtime, streamFn } = fixture();
    streamFn.mockRejectedValue(new Error('503 unavailable'));
    const messages = await collect(
      runtime.run({ operation: 'run', prompt: 'fail' }),
    );
    expect(streamFn).toHaveBeenCalledOnce();
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('503'),
      }),
    );
    expect(messages.some((m) => m.type === 'result')).toBe(false);
    expect(messages.filter((m) => m.type === 'done')).toHaveLength(1);
  });

  it('does not replay a completed write when the following model request fails', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'written' }],
      details: {},
    }));
    const { runtime, faux, streamFn } = fixture([
      {
        name: 'write',
        label: 'write',
        description: 'write',
        parameters: Type.Object({}),
        replay: 'safe',
        execute,
      },
    ]);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('write', {}), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: '503 after write',
      }),
    ]);
    const messages = await collect(
      runtime.run({ operation: 'run', prompt: 'write once' }),
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('503'),
      }),
    );
    expect(messages.filter((m) => m.type === 'done')).toHaveLength(1);
  });

  it('propagates external cancellation to an active provider stream', async () => {
    const { runtime, streamFn } = fixture();
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let providerAborted = false;
    streamFn.mockImplementation(async (_model, _context, options) => {
      started();
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener(
          'abort',
          () => {
            providerAborted = true;
            resolve();
          },
          { once: true },
        );
      });
      throw new Error('provider aborted');
    });
    const result = collect(
      runtime.run({
        operation: 'run',
        prompt: 'wait',
        options: { abortController: controller },
      }),
    );
    await ready;
    controller.abort();
    const messages = await result;
    expect(providerAborted).toBe(true);
    expect(messages.some((m) => m.type === 'error')).toBe(true);
    expect(messages.at(-1)?.type).toBe('done');
  });

  it.each(['stop', 'disconnect'])(
    'cancels an active tool on %s and waits for cleanup',
    async (mode) => {
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let cleaned = false;
      const tool: AgentTool = {
        name: 'wait',
        label: 'wait',
        description: 'wait',
        parameters: Type.Object({}),
        execute: async (_id, _params, signal) => {
          started();
          await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            else
              signal?.addEventListener('abort', () => resolve(), {
                once: true,
              });
          });
          cleaned = true;
          return {
            content: [{ type: 'text', text: 'cancelled' }],
            details: {},
          };
        },
      };
      const { runtime, faux, streamFn } = fixture([tool]);
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall('wait', {}), {
          stopReason: 'toolUse',
        }),
      ]);
      const source = runtime.run({
        operation: 'run',
        prompt: 'wait',
        options: { sessionId: 'active' },
      });
      await source.next();
      await ready;
      const busy = await collect(
        runtime.run({
          operation: 'run',
          prompt: 'duplicate',
          options: { sessionId: 'active' },
        }),
      );
      expect(busy[0]?.message).toContain('active run');
      if (mode === 'stop') {
        await runtime.stop('active');
        await collect(source);
      } else await source.return(undefined);
      expect(cleaned).toBe(true);
      expect(streamFn).toHaveBeenCalledOnce();
      faux.setResponses([fauxAssistantMessage('new run')]);
      const next = await collect(
        runtime.run({
          operation: 'run',
          prompt: 'again',
          options: { sessionId: 'active' },
        }),
      );
      expect(next).toContainEqual(
        expect.objectContaining({ type: 'result', content: 'new run' }),
      );
    },
  );
});
