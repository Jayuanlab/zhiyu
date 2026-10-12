import { afterEach, describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import { createPiRuntimeOptionsFromModelConfig } from '@openzhiyu/ai/agent/runtime';
import {
  createLoopCurrentFetchObserver,
  loopCurrentSdkEndpoint,
} from '../../scripts/lib/platform-loop-current-comparison-fetch-observer.mjs';

const upstreamBaseUrl = 'https://opencode.ai/zen/go';
const proxyBaseUrl = 'http://127.0.0.1:19876/zen/go';
const model = 'Qwen3.7 Plus/Transport Fixture';
const protocol = 'anthropic-messages';
const fakeApiKey = 'synthetic-transport-fixture-key';
const blockedFetch = globalThis.fetch;
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function requestUrl(input: FetchInput) {
  return input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
}

function effectiveHeaders(input: FetchInput, init: FetchInit) {
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
}

function fakeAnthropicResponse() {
  const events = [
    { type: 'message_start', message: { id: 'msg_transport_fixture', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 7, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture response' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function callRealPiSdk() {
  const runtime = createPiRuntimeOptionsFromModelConfig({ apiKey: fakeApiKey, baseUrl: upstreamBaseUrl, model, protocol });
  if (!runtime.model || !runtime.streamFn) throw Error('Expected a configured real Pi stream implementation');
  const stream = await runtime.streamFn(runtime.model, {
    systemPrompt: 'Synthetic transport fixture. Do not access external tools.',
    messages: [{ role: 'user', content: 'Read the synthetic state.', timestamp: 1 }],
    tools: [{ name: 'platformRecall', description: 'Read synthetic state.', parameters: Type.Object({ query: Type.String() }) }],
  }, { maxTokens: 123, temperature: 0, maxRetries: 0 });
  const events = [];
  for await (const event of stream) events.push(event);
  expect(events.at(-1)?.type).toBe('done');
  return runtime;
}

afterEach(() => {
  globalThis.fetch = blockedFetch;
  vi.restoreAllMocks();
});

describe('evaluation main-provider transport with the actual Pi SDK', () => {
  it('constructs the real Go endpoint and production session header before any observation', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => fakeAnthropicResponse());
    globalThis.fetch = fetchMock;
    const runtime = await callRealPiSdk();
    expect(runtime.model?.baseUrl).toBe(upstreamBaseUrl);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0];
    expect(requestUrl(input)).toBe('https://opencode.ai/zen/go/v1/messages?beta=true');
    expect(loopCurrentSdkEndpoint({ baseUrl: upstreamBaseUrl, protocol })).toBe(requestUrl(input));
    expect(effectiveHeaders(input, init).get('x-opencode-session')).toBe('zhiyu-pi-runtime-qwen3.7-plus-transport-fixture');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model, max_tokens: 123, temperature: 0, stream: true });
    expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual(['platformRecall']);
  });

  it('redirects the SDK request without reconstructing its init, headers, body or budget', async () => {
    const destinationFetch = vi.fn<typeof fetch>(async () => fakeAnthropicResponse());
    const observedFetch = createLoopCurrentFetchObserver({ upstreamBaseUrl, proxyBaseUrl, model, protocol, fetchImpl: destinationFetch });
    const originalSdkFetch = vi.fn<typeof fetch>((input, init) => observedFetch(input, init));
    globalThis.fetch = originalSdkFetch;
    await callRealPiSdk();
    expect(originalSdkFetch).toHaveBeenCalledOnce();
    expect(destinationFetch).toHaveBeenCalledOnce();
    const [originalInput, originalInit] = originalSdkFetch.mock.calls[0];
    const [redirectedInput, redirectedInit] = destinationFetch.mock.calls[0];
    const originalUrl = new URL(requestUrl(originalInput));
    const redirectedUrl = new URL(requestUrl(redirectedInput));
    expect(originalUrl.origin).toBe('https://opencode.ai');
    expect(redirectedUrl.origin).toBe('http://127.0.0.1:19876');
    expect(redirectedUrl.pathname + redirectedUrl.search).toBe(originalUrl.pathname + originalUrl.search);
    expect(redirectedInit).toBe(originalInit);
    expect(redirectedInit?.headers).toBe(originalInit?.headers);
    expect(redirectedInit?.body).toBe(originalInit?.body);
    expect(redirectedInit?.signal).toBe(originalInit?.signal);
    expect(effectiveHeaders(redirectedInput, redirectedInit)).toEqual(effectiveHeaders(originalInput, originalInit));
  });
});

describe('evaluation transparent fetch observer boundaries', () => {
  const marker = 'zhiyu-pi-runtime-qwen3.7-plus-transport-fixture';
  const sdkUrl = 'https://opencode.ai/zen/go/v1/messages?beta=true';
  const body = '{ "model": "fixture", "max_tokens": 123, "tools": [], "messages": [{"content":"raw bytes"}] }';
  function factory(fetchImpl: typeof fetch) {
    return createLoopCurrentFetchObserver({ upstreamBaseUrl, proxyBaseUrl, model, protocol, fetchImpl });
  }

  it('preserves URL input type and every RequestInit option by reference', async () => {
    const response = new Response('synthetic response');
    const fetchMock = vi.fn<typeof fetch>(async () => response);
    const controller = new AbortController();
    const init: RequestInit = { method: 'POST', headers: new Headers({ 'x-opencode-session': marker, authorization: 'synthetic-only' }),
      body, signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error', integrity: 'sha256-synthetic', keepalive: true,
      referrerPolicy: 'no-referrer', mode: 'cors' };
    const wrapped = factory(fetchMock);
    expect(await wrapped(new URL(sdkUrl), init)).toBe(response);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, receivedInit] = fetchMock.mock.calls[0];
    expect(input).toBeInstanceOf(URL);
    expect(requestUrl(input)).toBe('http://127.0.0.1:19876/zen/go/v1/messages?beta=true');
    expect(receivedInit).toBe(init);
    expect(receivedInit?.headers).toBe(init.headers);
    expect(receivedInit?.body).toBe(body);
    expect(receivedInit?.signal).toBe(controller.signal);
  });

  it.each([false, true])('preserves inherited Request bytes, headers and options with keepalive=%s and cancellation propagation', async keepalive => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('synthetic response'));
    const controller = new AbortController();
    const original = new Request(sdkUrl, { method: 'POST', headers: { 'x-opencode-session': marker, authorization: 'synthetic-only' }, body,
      signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error', integrity: 'sha256-synthetic', keepalive,
      referrerPolicy: 'no-referrer', mode: 'cors' });
    const originalBytes = await original.clone().text();
    await factory(fetchMock)(original);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBeInstanceOf(Request);
    if (!(input instanceof Request)) throw Error('Expected Request input');
    expect(input.url).toBe('http://127.0.0.1:19876/zen/go/v1/messages?beta=true');
    expect(init).toBeUndefined();
    expect(await input.clone().text()).toBe(originalBytes);
    expect([...input.headers]).toEqual([...original.headers]);
    for (const field of ['method', 'cache', 'credentials', 'redirect', 'integrity', 'keepalive', 'referrerPolicy', 'mode'] as const) {
      expect(input[field]).toBe(original[field]);
    }
    expect(input.signal.aborted).toBe(false);
    controller.abort();
    expect(input.signal.aborted).toBe(true);
  });

  it('uses RequestInit overrides exactly once without consuming or rewriting the supplied body', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('synthetic response'));
    const original = new Request(sdkUrl, { method: 'GET', headers: { 'x-opencode-session': 'zhiyu-brain-fixture' } });
    const controller = new AbortController();
    const rawBody = new Uint8Array([123, 125, 10]);
    const init: RequestInit = { method: 'POST', headers: [['x-opencode-session', marker], ['x-synthetic-option', 'preserved']], body: rawBody, signal: controller.signal };
    await factory(fetchMock)(original, init);
    const [input, receivedInit] = fetchMock.mock.calls[0];
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestUrl(input)).toBe('http://127.0.0.1:19876/zen/go/v1/messages?beta=true');
    expect(receivedInit).toBe(init);
    expect(receivedInit?.body).toBe(rawBody);
    expect(receivedInit?.signal).toBe(controller.signal);
    expect(original.bodyUsed).toBe(false);
  });

  it.each([
    ['brain marker on main path', sdkUrl, 'POST', 'zhiyu-brain-recall-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    ['formal brain path and marker', 'https://opencode.ai/zen/go/v1/messages', 'POST', 'zhiyu-brain-recall-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    ['formal JEV endpoint without SDK marker', 'https://api.typesafe.ai/v1/systemone', 'POST', ''],
    ['missing marker', sdkUrl, 'POST', ''],
    ['other model marker', sdkUrl, 'POST', 'zhiyu-pi-runtime-other-model'],
    ['other host', 'https://other.example.invalid/zen/go/v1/messages?beta=true', 'POST', marker],
    ['other path', 'https://opencode.ai/zen/go/v1/messages/count_tokens?beta=true', 'POST', marker],
    ['extra query', 'https://opencode.ai/zen/go/v1/messages?beta=true&scope=other', 'POST', marker],
    ['GET', sdkUrl, 'GET', marker],
  ])('passes %s through unchanged and never creates a second request', async (_label, url, method, sessionMarker) => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('synthetic response'));
    const input = new URL(url);
    const init: RequestInit = { method, headers: { 'x-opencode-session': sessionMarker }, ...(method === 'POST' ? { body } : {}) };
    await factory(fetchMock)(input, init);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(input);
    expect(fetchMock.mock.calls[0][1]).toBe(init);
  });

  it('rejects unauthorized observation destinations with generic errors and no request', () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('synthetic response'));
    for (const badProxy of ['https://proxy.example.invalid/zen/go', 'http://127.0.0.1:19876/other', 'http://credential:secret@127.0.0.1:19876/zen/go']) {
      try {
        createLoopCurrentFetchObserver({ upstreamBaseUrl, proxyBaseUrl: badProxy, model, protocol, fetchImpl: fetchMock });
        throw Error('Expected observer configuration rejection');
      } catch (error) {
        expect(String(error)).not.toContain('secret');
        expect(String(error)).not.toContain(badProxy);
        expect(String(error)).not.toContain('Expected observer configuration rejection');
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
