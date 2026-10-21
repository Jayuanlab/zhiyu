import { afterEach, describe, expect, it, vi } from 'vitest';
import { Type, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import { createPiAgentRuntime, createPiRuntimeOptionsFromModelConfig } from '@openzhiyu/ai/agent/runtime';
import {
  createProviderStreamRecovery,
  type HostProviderRecoveryOptions,
  type HostProviderTransportReceipt,
} from '../../../../packages/ai/src/agent/runtime/provider-stream-recovery';

const endpoint = 'https://opencode.ai/inference/go/anthropic/v1/messages?beta=true';
const model = { id: 'qwen3.7-plus', api: 'anthropic-messages', baseUrl: 'https://opencode.ai/inference/go/anthropic' };
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const start = frame('message_start', { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant',
  model: model.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 19, output_tokens: 0 } } });
const text = (value: string) => frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  + frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } });
const stop = frame('content_block_stop', { type: 'content_block_stop', index: 0 })
  + frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } })
  + frame('message_stop', { type: 'message_stop' });
const complete = start + text('accepted final') + stop;
const opaque = start + text('discarded partial') + frame('error', '{}');
const response = (body: string, status = 200, contentType = 'text/event-stream') =>
  new Response(body, { status, headers: { 'content-type': contentType } });
const requestInit = (): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json',
  'x-api-key': 'private-fixture-key', 'x-opencode-session': 'private-fixture-session' },
body: JSON.stringify({ model: model.id, stream: true, messages: [{ role: 'user', content: 'private-fixture-prompt' }] }) });

function fixture(hook?: HostProviderRecoveryOptions['onTransportAttempt']) {
  const receipts: HostProviderTransportReceipt[] = [];
  const options: HostProviderRecoveryOptions = { policy: { version: 'official-go-qwen-opaque.v1', maxRecoveries: 1,
    sharedTimeoutMs: 120000, maxBufferedBytes: 4194304, maxFrames: 20000 },
  onTransportAttempt: async receipt => { receipts.push(receipt); await hook?.(receipt); } };
  return { receipts, options, recovery: createProviderStreamRecovery({ model, options }) };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('explicit, bounded opaque provider SSE recovery', () => {
  it('rejects mixing a short deadline with the ordinary-report policy identity',()=>{
    const {options}=fixture();
    expect(()=>createProviderStreamRecovery({model,options:{...options,policy:{...options.policy,version:'official-go-qwen-report.v1',sharedTimeoutMs:120000}}})).toThrow('Invalid trusted provider recovery policy');
  });
  it('allows a delayed ordinary report body beyond the short deadline without replaying a request',async()=>{
    vi.useFakeTimers();const receipts:HostProviderTransportReceipt[]=[];
    const recovery=createProviderStreamRecovery({model,options:{policy:{version:'official-go-qwen-report.v1',sharedTimeoutMs:300000,maxRecoveries:1,maxBufferedBytes:4194304,maxFrames:20000},onTransportAttempt:async e=>{receipts.push(e);}}});
    const fetch=vi.fn(async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(start));setTimeout(()=>{c.enqueue(new TextEncoder().encode(text('delayed final')+stop));c.close();},150000);}}),{headers:{'content-type':'text/event-stream'}}));
    let settled=false;const request=recovery.wrapFetch(fetch)(endpoint,requestInit()).then(async r=>{settled=true;return r.text();});
    await vi.advanceTimersByTimeAsync(120001);expect(settled).toBe(false);expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30000);expect(await request).toContain('delayed final');
    expect(receipts).toContainEqual(expect.objectContaining({phase:'finished',classification:'complete_sse'}));
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('still stops a stalled report at its explicit deadline and never retries incomplete output',async()=>{
    vi.useFakeTimers();const recovery=createProviderStreamRecovery({model,options:{policy:{version:'official-go-qwen-report.v1',sharedTimeoutMs:300000,maxRecoveries:1,maxBufferedBytes:4194304,maxFrames:20000},onTransportAttempt:async()=>{}}});
    const fetch=vi.fn(async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(start));}}),{headers:{'content-type':'text/event-stream'}}));
    const result=recovery.wrapFetch(fetch)(endpoint,requestInit()).then(()=>null,e=>e);
    await vi.advanceTimersByTimeAsync(300001);expect(await result).toBeInstanceOf(Error);expect(fetch).toHaveBeenCalledOnce();
  });
  it('is the exact original fetch when no trusted policy is supplied', () => {
    const fetch = vi.fn();
    expect(createProviderStreamRecovery({ model }).wrapFetch(fetch)).toBe(fetch);
  });

  it('awaits durable prepared receipts before both physical requests and keeps their exact private request', async () => {
    const { recovery, receipts } = fixture();
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(receipts.at(-1)?.phase).toBe('prepared');
      requests.push(input as Request);
      return response(requests.length === 1 ? opaque : complete);
    });
    const result = await recovery.wrapFetch(fetch)(endpoint, requestInit());
    expect(await result.text()).toBe(complete);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toBe(endpoint);
    expect(requests[1]!.url).toBe(endpoint);
    expect(await requests[0]!.text()).toBe(await requests[1]!.text());
    expect([...requests[0]!.headers]).toEqual([...requests[1]!.headers]);
    expect(receipts.filter(value => value.phase === 'prepared')).toMatchObject([
      { attempt: 1, sameBody: null, sameHeaders: null }, { attempt: 2, sameBody: true, sameHeaders: true },
    ]);
    expect(receipts.filter(value => value.phase === 'finished')).toMatchObject([
      { classification: 'opaque_empty_error', usage: { status: 'partial', inputTokens: 19, billing: 'unknown' } },
      { classification: 'complete_sse', usage: { outputTokens: 7, billing: 'unknown' } },
    ]);
    expect(JSON.stringify(receipts)).not.toMatch(/private-fixture|x-api-key|x-opencode-session|authorization|discarded partial|accepted final/);
  });

  it('shares a single recovery allowance across logical calls rather than resetting per fetch', async () => {
    const { recovery } = fixture();
    const fetch = vi.fn(async () => response(fetch.mock.calls.length === 2 ? complete : opaque));
    const wrapped = recovery.wrapFetch(fetch);
    expect(await (await wrapped(endpoint, requestInit())).text()).toBe(complete);
    expect(await (await wrapped(endpoint, requestInit())).text()).toBe(opaque);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('reserves the run budget atomically across concurrent wrappers', async () => {
    const { recovery } = fixture();
    let dispatches = 0;
    const fetch = vi.fn(async () => response(++dispatches <= 2 ? opaque : complete));
    const results = await Promise.all([recovery.wrapFetch(fetch)(endpoint, requestInit()), recovery.wrapFetch(fetch)(endpoint, requestInit())]);
    expect((await Promise.all(results.map(result => result.text()))).sort()).toEqual([complete, opaque].sort());
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not make a third attempt when the second stream has the same opaque error', async () => {
    const { recovery } = fixture();
    const fetch = vi.fn(async () => response(opaque));
    expect(await (await recovery.wrapFetch(fetch)(endpoint, requestInit())).text()).toBe(opaque);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['explicit inspection', start + frame('error', { type: 'error', error: { type: 'data_inspection_failed', message: 'rejected' } })],
    ['two opaque errors', opaque + frame('error', '{}')],
    ['length', start + frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: {} }) + frame('error', '{}')],
    ['EOF without stop', start + text('unfinished')],
    ['incomplete frame', opaque.trimEnd()],
    ['malformed JSON', start + frame('content_block_delta', '{') + frame('error', '{}')],
    ['delta before message start', frame('content_block_delta', { type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: 'bad order' } }) + frame('error', '{}')],
    ['content after error', opaque + text('bad order')],
    ['aborted terminal signal', start + frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'aborted' } }) + frame('error', '{}')],
    ['contradictory complete then error', complete + frame('error', '{}')],
  ])('never recovers %s', async (_label, body) => {
    const { recovery } = fixture();
    const fetch = vi.fn(async () => response(body));
    await recovery.wrapFetch(fetch)(endpoint, requestInit());
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([[401, 'text/event-stream'], [200, 'application/json']] as const)('does not buffer/recover HTTP %s %s', async (status, type) => {
    const { recovery } = fixture(); const original = response(opaque, status, type);
    const fetch = vi.fn(async () => original);
    expect(await recovery.wrapFetch(fetch)(endpoint, requestInit())).toBe(original);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    'http://opencode.ai/inference/go/anthropic/v1/messages',
    'https://opencode.ai.evil.invalid/inference/go/anthropic/v1/messages',
    'https://opencode.ai/zen/go/v1/messages',
    'https://opencode.ai/inference/go/anthropic/v1/messages?other=true',
    'https://opencode.ai/inference/go/anthropic/v1/messages?beta=true&other=true',
  ])('does not recover another endpoint %s', async url => {
    const { recovery } = fixture(); const fetch = vi.fn(async () => response(opaque));
    await recovery.wrapFetch(fetch)(url, requestInit()); expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not recover another model or a non-streaming request', async () => {
    const { recovery } = fixture(); const fetch = vi.fn(async () => response(opaque));
    for (const payload of [{ model: 'other', stream: true }, { model: model.id, stream: false }])
      await recovery.wrapFetch(fetch)(endpoint, { ...requestInit(), body: JSON.stringify(payload) });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...model, id: 'another-model' }, { ...model, api: 'openai-completions' },
    { ...model, baseUrl: 'https://another.invalid' },
    { ...model, baseUrl: `${model.baseUrl}?other=true` },
  ])('does not activate policy for a different configured model/provider: %j', configured => {
    const { options } = fixture(); const fetch = vi.fn();
    const recovery = createProviderStreamRecovery({ model: configured, options });
    expect(recovery.enabled).toBe(false); expect(recovery.wrapFetch(fetch)).toBe(fetch);
  });

  it('rejects a relaxed trusted cap instead of silently broadening recovery', () => {
    const { options } = fixture();
    expect(() => createProviderStreamRecovery({ model, options: { ...options,
      policy: { ...options.policy, maxRecoveries: 2 } as unknown as HostProviderRecoveryOptions['policy'] } })).toThrow('policy');
  });

  it('accepts a Request input without losing its query, body or headers', async () => {
    const { recovery } = fixture(); const fetch = vi.fn(async () => response(fetch.mock.calls.length === 1 ? opaque : complete));
    expect(await (await recovery.wrapFetch(fetch)(new Request(endpoint, requestInit()))).text()).toBe(complete);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves a custom dispatcher/agent identity on both physical attempts and passthroughs', async () => {
    const { recovery } = fixture();
    const dispatcher = { privateTransport: true }, agent = { privateAgent: true };
    const init = { ...requestInit(), dispatcher, agent } as RequestInit & { dispatcher: unknown; agent: unknown };
    const fetch = vi.fn(async (_input: RequestInfo | URL, options?: RequestInit) => {
      expect((options as typeof init).dispatcher).toBe(dispatcher);
      expect((options as typeof init).agent).toBe(agent);
      return response(fetch.mock.calls.length === 1 ? opaque : complete);
    });
    const wrapped = recovery.wrapFetch(fetch);
    await wrapped(endpoint, init);
    await wrapped('https://other.invalid/messages', init);
    await wrapped(endpoint, { ...init, body: JSON.stringify({ model: 'different', stream: true }) });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('never recovers transport errors', async () => {
    const { recovery } = fixture(); const fetch = vi.fn(async () => { throw new Error('connection reset'); });
    await expect(recovery.wrapFetch(fetch)(endpoint, requestInit())).rejects.toThrow('connection reset');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('fails closed if the first durable prepare is unavailable', async () => {
    const { recovery } = fixture(async receipt => { if (receipt.phase === 'prepared') throw new Error('audit unavailable'); });
    const fetch = vi.fn(async () => response(complete));
    await expect(recovery.wrapFetch(fetch)(endpoint, requestInit())).rejects.toThrow('audit');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not replay if durable finished/decision/second-prepare receipt fails', async () => {
    for (const phase of ['finished', 'recovery_decision', 'second_prepare']) {
      const { recovery } = fixture(async receipt => {
        if (receipt.phase === phase || phase === 'second_prepare' && receipt.phase === 'prepared' && receipt.attempt === 2)
          throw new Error('audit unavailable');
      });
      const fetch = vi.fn(async () => response(opaque));
      await expect(recovery.wrapFetch(fetch)(endpoint, requestInit())).rejects.toThrow('audit');
      expect(fetch).toHaveBeenCalledOnce();
    }
  });

  it('does not recover after an abort between attempts', async () => {
    const controller = new AbortController();
    const { options } = fixture(async receipt => { if (receipt.phase === 'finished') controller.abort(); });
    const recovery = createProviderStreamRecovery({ model, options, controllerSignal: controller.signal });
    const fetch = vi.fn(async () => response(opaque));
    await expect(recovery.wrapFetch(fetch)(endpoint, requestInit())).rejects.toThrow(); expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not dispatch when a prepared receipt aborts the caller signal', async () => {
    const controller = new AbortController();
    const { options } = fixture(async receipt => { if (receipt.phase === 'prepared') controller.abort(); });
    const fetch = vi.fn(async () => response(complete));
    const recovery = createProviderStreamRecovery({ model, options, controllerSignal: controller.signal });
    await expect(recovery.wrapFetch(fetch)(endpoint, requestInit())).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });

  it('bounds response bytes and frame count instead of forwarding oversized partial output', async () => {
    for (const body of ['a'.repeat(4194305), ':ping\n\n'.repeat(20001)]) {
      const { recovery } = fixture(); const fetch = vi.fn(async () => response(body));
      await expect(recovery.wrapFetch(fetch)(endpoint, requestInit())).rejects.toThrow(/limit/);
      expect(fetch).toHaveBeenCalledOnce();
    }
  });

  it('shares the 120 second logical deadline across both attempts', async () => {
    vi.useFakeTimers();
    const { recovery } = fixture();
    const fetch = vi.fn(async (_request: RequestInfo | URL) => {
      await new Promise(resolve => setTimeout(resolve, fetch.mock.calls.length === 1 ? 90000 : 90000));
      return response(fetch.mock.calls.length === 1 ? opaque : complete);
    });
    const pending = recovery.wrapFetch(fetch)(endpoint, requestInit());
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120001); await rejected;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('cannot wait forever for a finished audit after transport failure', async () => {
    vi.useFakeTimers();
    const { recovery, receipts } = fixture(async receipt => {
      if (receipt.phase === 'finished') await new Promise<void>(() => {});
    });
    const fetch = vi.fn(async () => { throw new Error('original transport failure'); });
    const rejected = expect(recovery.wrapFetch(fetch)(endpoint, requestInit())).rejects.toThrow('original transport failure');
    await vi.advanceTimersByTimeAsync(120001); await rejected;
    expect(fetch).toHaveBeenCalledOnce();
    expect(receipts.some(receipt => receipt.phase === 'recovery_decision')).toBe(false);
  });
});

describe('actual installed SDK sees only the accepted buffered attempt', () => {
  it('keeps the original opaque error as an SDK failure with policy disabled', async () => {
    const config = createPiRuntimeOptionsFromModelConfig({ model: model.id, apiKey: 'fixture-only', baseUrl: model.baseUrl, protocol: 'anthropic-messages' });
    const stream = await config.streamFn(config.model, { messages: [{ role: 'user', content: 'fixture', timestamp: 1 }] }, {
      fetch: async () => response(opaque), maxRetries: 0,
    });
    for await (const _event of stream) { /* real SDK, synthetic transport */ }
    expect(await stream.result()).toMatchObject({ stopReason: 'error', errorMessage: '{}' });
  });

  it('keeps the second opaque response a real SDK failure without another physical request', async () => {
    const { recovery } = fixture(); const fetch = vi.fn(async () => response(opaque));
    const config = createPiRuntimeOptionsFromModelConfig({ model: model.id, apiKey: 'fixture-only', baseUrl: model.baseUrl, protocol: 'anthropic-messages' });
    const stream = await config.streamFn(config.model, { messages: [{ role: 'user', content: 'fixture', timestamp: 1 }] }, {
      fetch: recovery.wrapFetch(fetch), maxRetries: 0,
    } as SimpleStreamOptions);
    for await (const _event of stream) { /* real SDK, synthetic transport */ }
    expect(await stream.result()).toMatchObject({ stopReason: 'error', errorMessage: '{}' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('discards a first partial tool call and never executes it, then accepts the actual SDK final', async () => {
    const partialTool = start + frame('content_block_start', { type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'partial-tool', name: 'write', input: {} } })
      + frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } })
      + frame('error', '{}');
    const { recovery } = fixture();
    const transport = vi.fn(async () => response(transport.mock.calls.length === 1 ? partialTool : complete));
    vi.stubGlobal('fetch', recovery.wrapFetch(transport));
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'must not execute' }], details: {} }));
    const config = createPiRuntimeOptionsFromModelConfig({ model: model.id, apiKey: 'fixture-only', baseUrl: model.baseUrl, protocol: 'anthropic-messages' });
    const runtime = createPiAgentRuntime({ ...config, adapter: 'harness', tools: [{ name: 'write', label: 'write',
      description: 'A synthetic side effect.', parameters: Type.Object({}), execute }] });
    const events = [];
    for await (const event of runtime.run({ operation: 'run', prompt: 'Synthetic fixture.' })) events.push(event);
    expect(execute).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(events)).not.toContain('partial-tool');
    expect(events.find(event => event.type === 'runtime_terminal')?.runtimeTerminal).toMatchObject({ status: 'completed' });
    expect(events.some(event => event.type === 'result' && event.content === 'accepted final')).toBe(true);
  });
});
