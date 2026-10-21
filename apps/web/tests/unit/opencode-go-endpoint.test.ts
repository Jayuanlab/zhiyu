import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPiAgentRuntime, createPiRuntimeOptionsFromModelConfig } from '@openzhiyu/ai/agent/runtime';
import { resolvePiAgentModelConfig } from '@/lib/ai/model-policy';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const base = 'https://opencode.ai/inference/go/anthropic';
const sse = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
function completedAnthropicResponse(kind: 'end_turn' | 'max_tokens' | 'eof' | 'inspection' = 'end_turn') {
  return new Response(
    sse('message_start', { message: { id: 'fixture', type: 'message', role: 'assistant', model: 'qwen3.7-plus',
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }) +
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'complete fixture' } }) +
    sse('content_block_stop', { index: 0 }) +
    (kind === 'inspection'
      ? sse('error', { error: { type: 'server_error', message: 'data_inspection_failed: partial output rejected' } })
      : kind === 'eof' ? '' : sse('message_delta', { delta: { stop_reason: kind, stop_sequence: null }, usage: { output_tokens: 5 } }) + sse('message_stop', {})),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('documented OpenCode Go Qwen endpoint on actual runtime paths', () => {
  it.each(['https://opencode.ai/zen/go', 'https://opencode.ai/zen/go/v1', base, `${base}/v1`])(
    'uses the documented Messages protocol for %s', url => {
      const options = createPiRuntimeOptionsFromModelConfig({ model: 'qwen3.7-plus', apiKey: 'fixture-only',
        baseUrl: url, protocol: 'openai-completions' });
      expect(options.model).toMatchObject({ id: 'qwen3.7-plus', api: 'anthropic-messages', baseUrl: base });
    },
  );

  it('reports the actual migrated protocol in the application model resolution', () => {
    const resolved = resolvePiAgentModelConfig({ envConfig: { apiKey: 'fixture-only', model: 'qwen3.7-plus',
      baseUrl: 'https://opencode.ai/zen/go' }, runtimeProtocol: 'openai-completions', fallbackModel: 'unused' });
    expect(resolved).toMatchObject({ source: 'env', model: 'qwen3.7-plus', baseUrl: base, piProtocol: 'anthropic-messages' });
  });

  it.each(['https://custom.invalid/zen/go', 'https://opencode.ai/custom', 'https://opencode.ai.evil.invalid/zen/go'])
    ('does not rewrite a custom endpoint %s', url => {
      const options = createPiRuntimeOptionsFromModelConfig({ model: 'qwen3.7-plus', apiKey: 'fixture-only',
        baseUrl: url, protocol: 'openai-completions' });
      expect(options.model).toMatchObject({ api: 'openai-completions', baseUrl: url });
    });

  it('sends Messages wire format, preserves content, and completes through the installed SDK', async () => {
    const options = createPiRuntimeOptionsFromModelConfig({ model: 'qwen3.7-plus', apiKey: 'fixture-only',
      baseUrl: 'https://opencode.ai/zen/go', protocol: 'openai-completions' });
    const fetch = vi.fn(async () => completedAnthropicResponse());
    const stream = await options.streamFn(options.model, { systemPrompt: 'unchanged policy',
      messages: [{ role: 'user', content: 'unchanged owner input', timestamp: 1 }] },
    { fetch, sessionId: 'workshop-conversation-a', maxTokens: 128 });
    for await (const _event of stream) { /* use the installed SDK parser */ }
    const result = await stream.result();
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(String(url)).origin + new URL(String(url)).pathname).toBe(`${base}/v1/messages`);
    const payload = JSON.parse(String(init.body));
    expect(payload.model).toBe('qwen3.7-plus');
    expect(payload.max_tokens).toBe(128);
    expect(JSON.stringify(payload.system)).toContain('unchanged policy');
    expect(JSON.stringify(payload.messages)).toContain('unchanged owner input');
    const headers = new Headers(init.headers);
    expect(headers.get('x-opencode-session')).toBe('workshop-conversation-a');
    expect(headers.get('user-agent')).toContain('zhiyu');
    expect(result.stopReason).toBe('stop');
    expect(result.content).toContainEqual(expect.objectContaining({ type: 'text', text: 'complete fixture' }));
  });

  it.each(['max_tokens', 'eof', 'inspection'] as const)('keeps %s incomplete on the migrated Harness path', async kind => {
    const fetch = vi.fn(async () => completedAnthropicResponse(kind));
    vi.stubGlobal('fetch', fetch);
    const runtime = createPiAgentRuntime({ ...createPiRuntimeOptionsFromModelConfig({
      model: 'qwen3.7-plus', apiKey: 'fixture-only', baseUrl: 'https://opencode.ai/zen/go', protocol: 'openai-completions',
    }), adapter: 'harness' });
    const events = [];
    for await (const event of runtime.run({ operation: 'run', prompt: 'Synthetic bounded fixture.', options: {} })) events.push(event);
    expect(fetch).toHaveBeenCalledOnce();
    expect(events.some(event => event.type === 'result')).toBe(false);
    expect(events.find(event => event.type === 'runtime_terminal')?.runtimeTerminal).toMatchObject({ status: 'failed', cleanupStatus: 'completed' });
    if (kind === 'max_tokens') expect(events.find(event => event.type === 'error')?.message).toContain('provider_output_truncated');
    if (kind === 'inspection') expect(events.find(event => event.type === 'error')?.message).toContain('provider_content_rejected');
  });
});
