import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPiAgentRuntime, createPiRuntimeOptionsFromModelConfig } from '@openzhiyu/ai/agent/runtime';
import { admitPiProviderTerminal } from '../../../../packages/ai/src/agent/runtime/pi-provider-terminal';
const frame = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
afterEach(() => vi.unstubAllGlobals());
describe('opaque provider errors remain incomplete', () => {
  it('normalizes a real installed-SDK empty error frame and keeps the partial draft out of success', async () => {
    const options = createPiRuntimeOptionsFromModelConfig({ model: 'qwen3.7-plus', apiKey: 'fixture-only',
      baseUrl: 'https://opencode.ai/inference/go/anthropic', protocol: 'anthropic-messages' });
    const fetch = async () => new Response(frame('message_start', { message: { id: 'opaque-fixture', type: 'message', role: 'assistant', model: 'qwen3.7-plus', content: [], stop_reason: null,
      stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }) + frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
      frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'unfinished draft' } }) + 'event: error\ndata: {}\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
    vi.stubGlobal('fetch', fetch);
    const runtime = createPiAgentRuntime({ ...options, adapter: 'harness' });
    const events = [];
    for await (const event of runtime.run({ operation: 'run', prompt: 'Offline opaque stream fixture.', options: {} })) events.push(event);
    expect(events.find(event => event.type === 'runtime_terminal')?.runtimeTerminal).toMatchObject({ status: 'failed', cleanupStatus: 'completed' });
    expect(events.some(event => event.type === 'result')).toBe(false);
    expect(events.find(event => event.type === 'error')?.message).toContain('[provider_stream_interrupted]');
  });
  it('does not reinterpret a complete message with opaque-looking text', () => {
    const result = { stopReason: 'stop', errorMessage: '{}', content: [] } as any;
    expect(admitPiProviderTerminal(result)).toBe(result);
  });
});
