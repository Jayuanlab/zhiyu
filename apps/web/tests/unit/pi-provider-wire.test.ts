import { afterEach, describe, expect, it, vi } from 'vitest';
import { Type, type OpenAICompletionsCompat, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import { createPiAgentRuntime, createPiRuntimeOptionsFromModelConfig } from '@openzhiyu/ai/agent/runtime';
import type { AgentMessage, AgentOptions } from '@openzhiyu/ai/agent/types';

// Exercise the installed SDK serializer and Harness with synthetic HTTP/SSE only.
// Every fetch is stubbed; no credential or live provider is used.
const inspectedError = 'Streaming response failed: [data_inspection_failed] <400> InternalError.Algo.DataInspectionFailed: Output data may contain inappropriate content.';
const partial = 'An incomplete draft retained for diagnosis.';
const chunk = (delta: object, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
    model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;

function response(kind: 'stop' | 'length' | 'inspection' | 'content_filter' | 'network_error' | 'eof' | 'length-tool', outputTokens?: number) {
  let body = chunk({ role: 'assistant', content: partial });
  if (kind === 'length-tool') body += chunk({ tool_calls: [{ index: 0, id: 'call-fixture',
    type: 'function', function: { name: 'write', arguments: '{}' } }] });
  if (kind === 'inspection') body += `data: ${JSON.stringify({ error: {
    message: inspectedError, code: 'data_inspection_failed', type: 'invalid_request_error',
  } })}\n\n`;
  else if (kind !== 'eof') body += chunk({}, kind === 'length-tool' ? 'length' : kind);
  if (outputTokens !== undefined) body += `data: ${JSON.stringify({ id: 'fixture',
    object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [], usage: {
      prompt_tokens: 20, completion_tokens: outputTokens, total_tokens: 20 + outputTokens,
    } })}\n\n`;
  if (kind !== 'eof') body += 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function config() {
  return createPiRuntimeOptionsFromModelConfig({ model: 'fixture-model', apiKey: 'fixture-only',
    protocol: 'openai-completions', baseUrl: 'https://example.invalid/v1', headers: { 'x-host': 'kept' } });
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Pi compatible wire protocol through the installed SDK', () => {
  async function wire(compat?: OpenAICompletionsCompat, modelCompat?: OpenAICompletionsCompat) {
    const options = config();
    if (modelCompat) options.model.compat = { ...options.model.compat, ...modelCompat };
    const fetch = vi.fn(async () => response('stop', 7));
    const stream = await options.streamFn(options.model, { messages: [{ role: 'user', content: 'fixture', timestamp: 1 }] }, {
      fetch, sessionId: 'fixture-session', headers: { 'x-request': 'kept' },
      maxTokens: 321, ...(compat ? { compat } : {}),
    } as SimpleStreamOptions & { compat?: OpenAICompletionsCompat });
    for await (const _event of stream) { /* drain the real SDK */ }
    const result = await stream.result();
    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = fetch.mock.calls[0] as unknown as [unknown, RequestInit];
    return { body: JSON.parse(String(init.body)), headers: new Headers(init.headers), result, model: options.model };
  }

  it('honors the host max_tokens and streaming-usage compatibility settings', async () => {
    const { body, model, result } = await wire();
    expect(model.compat).toMatchObject({ maxTokensField: 'max_tokens', supportsStore: false,
      supportsUsageInStreaming: false, sendSessionAffinityHeaders: false });
    expect(body.max_tokens).toBe(321);
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('stream_options');
    expect(body).not.toHaveProperty('store');
    expect(body.stream).toBe(true);
    expect(result.stopReason).toBe('stop');
    expect(result.usage.output).toBe(7);
  });

  it('preserves explicit per-call overrides, API-key and host/request headers', async () => {
    const { body, headers } = await wire({ maxTokensField: 'max_completion_tokens', supportsUsageInStreaming: true });
    expect(body.max_completion_tokens).toBe(321);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(headers.get('authorization')).toBe('Bearer fixture-only');
    expect(headers.get('x-host')).toBe('kept');
    expect(headers.get('x-request')).toBe('kept');
    expect(headers.has('session_id')).toBe(false);
    expect(headers.has('x-session-affinity')).toBe(false);
  });

  it('honors model compatibility without mutating it when per-call overrides differ', async () => {
    const { body, model } = await wire({ supportsUsageInStreaming: false }, {
      maxTokensField: 'max_completion_tokens', supportsUsageInStreaming: true,
    });
    expect(body.max_completion_tokens).toBe(321);
    expect(body).not.toHaveProperty('stream_options');
    expect(model.compat).toMatchObject({ maxTokensField: 'max_completion_tokens', supportsUsageInStreaming: true });
  });
});

describe('Pi Harness incomplete provider output', () => {
  async function run(kind: Parameters<typeof response>[0], outputTokens?: number,
    hostFinalValidation?: AgentOptions['hostFinalValidation']) {
    let dispatches = 0;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).model).toBe('fixture-model');
      if (++dispatches > 3) return new Response('Unexpected fixture recovery blocked.', { status: 401 });
      return response(kind, outputTokens);
    });
    vi.stubGlobal('fetch', fetch);
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'must not execute' }], details: {} }));
    const options = config();
    const runtime = createPiAgentRuntime({ ...options, adapter: 'harness', tools: [{ name: 'write', label: 'write',
      description: 'A side effect fixture.', parameters: Type.Object({}), execute }] });
    const events: AgentMessage[] = [];
    for await (const event of runtime.run({ operation: 'run', prompt: 'Synthetic diagnostic fixture.',
      options: hostFinalValidation ? { hostFinalValidation } : {} })) events.push(event);
    return { events, fetch, execute };
  }

  it('still completes a real SDK stop response and preserves reported usage', async () => {
    const { events, fetch } = await run('stop', 7);
    expect(fetch).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({ type: 'result', content: partial, answerPhase: 'candidate_final' }));
    expect(events.find(event => event.type === 'runtime_terminal')?.runtimeTerminal).toMatchObject({ status: 'completed', cleanupStatus: 'completed' });
  });

  it.each([undefined, 16384])('fails closed for length with output usage %s without hidden provider recovery', async output => {
    const { events, fetch, execute } = await run('length', output);
    expect(fetch).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: 'text', content: partial, answerPhase: 'draft' }));
    expect(events.some(event => event.type === 'result')).toBe(false);
    expect(events.find(event => event.type === 'runtime_terminal')?.runtimeTerminal).toMatchObject({ status: 'failed', cleanupStatus: 'completed' });
    expect(events.find(event => event.type === 'error')?.message).toContain('[provider_output_truncated]');
    const diagnostic = events.find(event => event.type === 'error')?.providerStreamDiagnostics?.invocations[0]?.contextReceipt;
    expect(diagnostic?.stopReason).toBe('length');
    expect(diagnostic?.usage.outputTokens).toBe(output ?? null);
    expect(diagnostic?.usage.status).toBe(output === undefined ? 'unknown' : 'reported');
  });

  it('never executes a tool call from a length-truncated generation', async () => {
    const { events, fetch, execute } = await run('length-tool', 16384);
    expect(fetch).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(events.find(event => event.type === 'runtime_terminal')?.runtimeTerminal?.status).toBe('failed');
  });

  it.each([false, true])('rejects truncated tools even when final validation is enabled (bounded=%s)', async bounded => {
    const validate = vi.fn(async () => ({ ok: true as const }));
    const { events, fetch, execute } = await run('length-tool', 16384, { validate,
      reserveOutputTokens: () => 16384, ...(bounded ? { boundedCompaction: {
        maxForwards: 2, totalOutputTokens: 4096, perForwardOutputTokens: 3072,
      } } : {}) });
    expect(fetch).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(events.some(event => event.answerPhase === 'candidate_final')).toBe(false);
    expect(events.find(event => event.type === 'runtime_terminal')?.runtimeTerminal).toMatchObject({ status: 'failed',
      error: expect.stringContaining('[provider_output_truncated]') });
  });

  it('does not implicitly recover length merely because final validation is enabled', async () => {
    const validate = vi.fn(async () => ({ ok: true as const }));
    const { events, fetch } = await run('length', undefined, { validate, reserveOutputTokens: () => 16384 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(validate).not.toHaveBeenCalled();
    expect(events.find(event => event.type === 'runtime_terminal')?.runtimeTerminal?.status).toBe('failed');
  });

  it('does not approve a full-output-cap length even with explicit bounded compaction', async () => {
    const validate = vi.fn(async () => ({ ok: true as const }));
    const { events, fetch } = await run('length', 16384, { validate, reserveOutputTokens: () => 16384,
      boundedCompaction: { maxForwards: 2, totalOutputTokens: 4096, perForwardOutputTokens: 3072 } });
    expect(fetch).toHaveBeenCalledOnce();
    expect(validate).not.toHaveBeenCalled();
    expect(events.some(event => event.answerPhase === 'candidate_final')).toBe(false);
    expect(events.find(event => event.type === 'runtime_terminal')?.runtimeTerminal?.status).toBe('failed');
  });

  it('keeps the exact provider rejection as evidence with explicit code and no retry', async () => {
    const { events, fetch } = await run('inspection');
    expect(fetch).toHaveBeenCalledOnce();
    expect(events.some(event => event.type === 'result')).toBe(false);
    const error = events.find(event => event.type === 'error');
    expect(error?.message).toContain('[provider_content_rejected]');
    expect(error?.message).toContain(inspectedError);
    expect(error?.providerStreamDiagnostics?.invocations[0]?.contextReceipt?.usage.status).toBe('unknown');
    expect(events.find(event => event.type === 'runtime_terminal')?.runtimeTerminal?.status).toBe('failed');
  });

  it('keeps abrupt EOF as a stream failure rather than a provider content rejection', async () => {
    const { events, fetch } = await run('eof');
    expect(fetch).toHaveBeenCalledOnce();
    const error = events.find(event => event.type === 'error');
    expect(error?.message).toContain('Stream ended without finish_reason');
    expect(error?.message).not.toContain('provider_content_rejected');
    expect(events.find(event => event.type === 'runtime_terminal')?.runtimeTerminal?.status).toBe('failed');
  });

  it('classifies the SDK content_filter finish reason without retry or partial completion', async () => {
    const { events, fetch, execute } = await run('content_filter');
    expect(fetch).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(events.some(event => event.type === 'result')).toBe(false);
    expect(events.find(event => event.type === 'error')?.message).toContain('[provider_content_rejected] Provider finish_reason: content_filter');
    expect(events.find(event => event.type === 'runtime_terminal')?.runtimeTerminal?.status).toBe('failed');
  });

  it('keeps a provider network finish reason distinct from content rejection', async () => {
    const { events, fetch } = await run('network_error');
    expect(fetch).toHaveBeenCalledOnce();
    expect(events.find(event => event.type === 'error')?.message).toContain('Provider finish_reason: network_error');
    expect(events.find(event => event.type === 'error')?.message).not.toContain('provider_content_rejected');
    expect(events.find(event => event.type === 'runtime_terminal')?.runtimeTerminal?.status).toBe('failed');
  });
});
