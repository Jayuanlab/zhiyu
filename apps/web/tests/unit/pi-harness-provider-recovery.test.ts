import { afterEach, describe, expect, it, vi } from 'vitest';
import { Type } from '@earendil-works/pi-ai';
import { createPiAgentRuntime, createPiRuntimeOptionsFromModelConfig } from '@openzhiyu/ai/agent/runtime';
import type { AgentMessage, AgentOptions } from '@openzhiyu/ai/agent/types';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const frame = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const start = () => frame('message_start', { message: { id: 'fixture', type: 'message', role: 'assistant', model: 'qwen3.7-plus',
  content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
const end = (reason = 'end_turn') => frame('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 5 } }) + frame('message_stop', {});
const tool = (name: string, input: object, id: string) => start() + frame('content_block_start', { index: 0, content_block: { type: 'tool_use', id, name, input: {} } })
  + frame('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }) + frame('content_block_stop', { index: 0 }) + end('tool_use');
const text = (value: string, reason = 'end_turn') => start() + frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
  + frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: value } }) + frame('content_block_stop', { index: 0 }) + end(reason);
const opaque = () => start() + frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
  + frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'FAILED_PARTIAL_MUST_NOT_ENTER_CONTEXT' } })
  + frame('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'failed-write', name: 'write', input: {} } })
  + 'event: error\ndata: {}\n\n';
const response = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
const policy = { version: 'official-go-qwen-opaque.v1' as const, maxRecoveries: 1 as const, sharedTimeoutMs: 120000 as const,
  maxBufferedBytes: 4194304 as const, maxFrames: 20000 as const };
const sourceText = `ORIGINAL_SOURCE_MARKER ${'source evidence '.repeat(400)}`;
const sourcePayload = JSON.stringify({ ok: true, provider: 'jina', finalUrlVerified: true, content: sourceText,
  evidenceId: 'saved-source', warnings: ['extraction_not_independently_verified'], fallbackErrors: [] });
const update = { operation: 'update', commandId: 'update-one', expectedVersion: 0, pruneToolCallIds: ['source-1'],
  state: { facts: [{ text: 'A bounded sourced observation.', evidenceIds: ['source-1'] }], hypotheses: [], openQuestions: ['Verify applicability.'],
    nextAction: { text: 'Verify the conclusion.', evidenceIds: ['source-1'] } } };

async function run(bodies: Array<string | Response>, options: AgentOptions = {}, official = true) {
  const payloads: Array<Record<string, unknown>> = [];
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : '';
    payloads.push(JSON.parse(body));
    const result = bodies[payloads.length - 1];
    if (result === undefined) return new Response('Unexpected request denied.', { status: 401 });
    return typeof result === 'string' ? response(result) : result;
  });
  vi.stubGlobal('fetch', fetch);
  const read = vi.fn(async () => ({ content: [{ type: 'text' as const, text: sourcePayload }], details: { ok: true } }));
  const write = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'write executed' }], details: {} }));
  const configured = createPiRuntimeOptionsFromModelConfig({ apiKey: 'fixture-only', model: 'qwen3.7-plus',
    baseUrl: official ? 'https://opencode.ai/inference/go/anthropic' : 'https://custom.invalid/anthropic', protocol: 'anthropic-messages' });
  const runtime = createPiAgentRuntime({ ...configured, adapter: 'harness', tools: [
    { name: 'webReadPage', label: 'Read', description: 'Read source.', parameters: Type.Object({}), execute: read },
    { name: 'write', label: 'Write', description: 'Protected write.', parameters: Type.Object({}), execute: write },
  ] });
  const messages: AgentMessage[] = [];
  for await (const message of runtime.run({ operation: 'run', prompt: 'Inspect the source under existing permissions.', options })) messages.push(message);
  return { messages, fetch, payloads, read, write };
}

describe('Pi Harness trusted provider transport recovery through actual SDK', () => {
  it('keeps the default opaque stream failure and never executes its partial tool', async () => {
    const result = await run([opaque(), text('must not retry')]);
    expect(result.fetch).toHaveBeenCalledOnce(); expect(result.write).not.toHaveBeenCalled();
    expect(result.messages.findLast(message => message.type === 'runtime_terminal')?.runtimeTerminal?.status).toBe('failed');
  });

  it('recovers once after pruning without a second projection or replaying completed tools', async () => {
    const onProjection = vi.fn(), onUsage = vi.fn(), onTransportAttempt = vi.fn(), onRejected = vi.fn();
    const result = await run([tool('webReadPage', {}, 'source-1'), tool('workingMemory', update, 'edit-1'), opaque(), text('Complete recovered answer.')], {
      hostWorkingMemory: { mode: 'apply', readonlyToolNames: ['webReadPage'],
        retainedReadCautions: [{ toolName: 'webReadPage', warningCodes: ['extraction_not_independently_verified'], warningTexts: [] }],
        onAudit: vi.fn(), onProjection, onUsage, onRejected },
      hostProviderRecovery: { policy, onTransportAttempt },
    });
    expect(result.fetch).toHaveBeenCalledTimes(4); expect(result.read).toHaveBeenCalledOnce(); expect(result.write).not.toHaveBeenCalled();
    expect(result.payloads[2]).toEqual(result.payloads[3]);
    expect(onRejected.mock.calls, JSON.stringify(onRejected.mock.calls)).toEqual([]);
    expect(JSON.stringify(result.payloads[2])).not.toContain('ORIGINAL_SOURCE_MARKER');
    expect(JSON.stringify(result.payloads[2])).toContain('A bounded sourced observation.');
    expect(onProjection).toHaveBeenCalledTimes(3); expect(onUsage).toHaveBeenCalledTimes(3);
    expect(onTransportAttempt.mock.calls.filter(([receipt]) => receipt.phase === 'prepared')).toHaveLength(4);
    expect(onTransportAttempt.mock.calls.filter(([receipt]) => receipt.phase === 'finished')).toHaveLength(4);
    expect(onTransportAttempt.mock.calls.filter(([receipt]) => receipt.phase === 'recovery_decision' && receipt.decision === 'retry_once')).toHaveLength(1);
    expect(result.messages.some(message => message.content?.includes('FAILED_PARTIAL_MUST_NOT_ENTER_CONTEXT'))).toBe(false);
    expect(result.messages.findLast(message => message.type === 'result')?.content).toBe('Complete recovered answer.');
    expect(result.messages.findLast(message => message.type === 'runtime_terminal')?.runtimeTerminal).toMatchObject({ status: 'completed', cleanupStatus: 'completed' });
  });

  it('shares the single recovery across separate logical requests in one run', async () => {
    const result = await run([opaque(), tool('webReadPage', {}, 'source-1'), opaque(), text('a second recovery is forbidden')], {
      hostProviderRecovery: { policy, onTransportAttempt: vi.fn() },
    });
    expect(result.fetch).toHaveBeenCalledTimes(3); expect(result.read).toHaveBeenCalledOnce(); expect(result.write).not.toHaveBeenCalled();
    expect(result.messages.findLast(message => message.type === 'runtime_terminal')?.runtimeTerminal?.status).toBe('failed');
  });

  it.each([
    ['inspection', start() + frame('error', { error: { type: 'server_error', message: 'data_inspection_failed' } })],
    ['EOF', start()], ['length', text('partial output', 'max_tokens')], ['HTTP401', new Response('expired', { status: 401 })],
  ])('does not recover %s or treat a partial response as complete', async (_name, body) => {
    const result = await run([body, text('must not recover')], { hostProviderRecovery: { policy, onTransportAttempt: vi.fn() } });
    expect(result.fetch).toHaveBeenCalledOnce(); expect(result.write).not.toHaveBeenCalled();
    expect(result.messages.some(message => message.type === 'result')).toBe(false);
    expect(result.messages.findLast(message => message.type === 'runtime_terminal')?.runtimeTerminal?.status).toBe('failed');
  });

  it('retains tool permission denial after a recovered provider response', async () => {
    const permission = vi.fn(async () => ({ behavior: 'deny' as const, message: 'Owner denied this write.' }));
    const result = await run([opaque(), tool('write', {}, 'actual-write'), text('Permission denial retained.')], {
      hostProviderRecovery: { policy, onTransportAttempt: vi.fn() }, onPermissionRequest: permission,
    });
    expect(permission).toHaveBeenCalled(); expect(result.write).not.toHaveBeenCalled();
  });

  it('stops before transmission when the trusted transport audit fails', async () => {
    const result = await run([text('must not transmit')], { hostProviderRecovery: { policy, onTransportAttempt: async () => { throw Error('Transport audit unavailable.'); } } });
    expect(result.fetch).not.toHaveBeenCalled();
    expect(result.messages.findLast(message => message.type === 'runtime_terminal')?.runtimeTerminal?.status).toBe('failed');
  });

  it('does not change a custom provider even when the host option is supplied', async () => {
    const onTransportAttempt = vi.fn();
    const result = await run([opaque(), text('must not retry')], { hostProviderRecovery: { policy, onTransportAttempt } }, false);
    expect(result.fetch).toHaveBeenCalledOnce(); expect(onTransportAttempt).not.toHaveBeenCalled();
  });
});
