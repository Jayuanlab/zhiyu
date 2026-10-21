import { AsyncResource } from 'node:async_hooks';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import { auxiliaryModelSessionHeader } from '@/lib/ai/auxiliary-model-connection';

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export class ControlledClaudeError extends Error {
  constructor(readonly code: string, readonly status = 503) { super(code); }
}
export type ClaudeTransportInput = {
  upstream: string; apiKey: string; beforeRequest: () => Promise<void>; signal: AbortSignal;
  /** Internal transport seam for protocol tests. Never supplied by HTTP callers. */
  forward?: typeof fetch;
  onRejected?: () => void;
};
const fail = (response: ServerResponse, status: number, code: string) => {
  if (!response.headersSent && !response.destroyed) { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: code } })); }
  else response.destroy();
};
/** SDK process transport. Every physical Messages request is admitted, including
 * retries and internal compaction/auxiliary calls. Tool events are not a proxy
 * for this admission. Real provider credentials remain in this parent process. */
export async function createControlledClaudeTransport(input: ClaudeTransportInput) {
  let upstream: URL;
  try { upstream = new URL(input.upstream); } catch { throw new ControlledClaudeError('memory_source_runtime_unsupported', 422); }
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash || !input.apiKey)
    throw new ControlledClaudeError('memory_source_runtime_unsupported', 422);
  input.signal.throwIfAborted();
  const token = randomBytes(32).toString('hex'), tokenBytes = Buffer.from(token);
  const connections = new Set<Socket>(), requests = new Set<AbortController>();
  let closed = false, rejected = false, requestCount = 0;
  const admit = AsyncResource.bind(input.beforeRequest);
  const forward = input.forward ?? fetch;
  // Parent-generated, run-stable routing metadata for the exact official Go
  // endpoints only. Never forward a child-supplied session or user agent.
  const providerHeaders = auxiliaryModelSessionHeader(upstream.href, 'zhiyu-controlled-claude');
  const server = createServer((request, response) => { void handle(request, response); });
  server.on('connection', socket => { connections.add(socket); socket.once('close', () => connections.delete(socket)); });
  server.requestTimeout = 120_000; server.headersTimeout = 15_000; server.maxHeadersCount = 64;
  const stop = () => { closed = true; for (const controller of requests) controller.abort(); for (const socket of connections) socket.destroy(); server.close(); };
  input.signal.addEventListener('abort', stop, { once: true });
  const listening = once(server, 'listening'); server.listen(0, '127.0.0.1'); await listening;
  if (input.signal.aborted) { stop(); input.signal.throwIfAborted(); }
  const address = server.address();
  if (!address || typeof address === 'string') { stop(); throw new ControlledClaudeError('memory_source_runtime_unsupported', 422); }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const controller = new AbortController(); requests.add(controller);
    const onClosed = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', onClosed); request.once('aborted', () => controller.abort());
    try {
      if (closed || rejected || input.signal.aborted) return fail(response, 503, 'memory_dispatch_context_unavailable');
      const provided = request.headers['x-api-key'] ?? (request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '');
      const supplied = Buffer.from(typeof provided === 'string' ? provided : '');
      if (supplied.length !== tokenBytes.length || !timingSafeEqual(supplied, tokenBytes)) return fail(response, 403, 'controlled_transport_auth_required');
      if (request.headers.host !== new URL(baseUrl).host || request.method !== 'POST'
        || !/^\/v1\/messages(?:\/count_tokens)?(?:\?beta=true)?$/.test(request.url ?? '')) return fail(response, 403, 'controlled_transport_path_unsupported');
      const claimed = Number(request.headers['content-length'] ?? 0);
      if (!Number.isSafeInteger(claimed) || claimed < 0 || claimed > MAX_REQUEST_BYTES) return fail(response, 413, 'controlled_transport_request_too_large');
      const chunks: Buffer[] = []; let length = 0;
      for await (const raw of request) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); length += chunk.length;
        if (length > MAX_REQUEST_BYTES) return fail(response, 413, 'controlled_transport_request_too_large'); chunks.push(chunk);
      }
      controller.signal.throwIfAborted(); input.signal.throwIfAborted();
      // Count-tokens also receives transcript text and therefore uses the same gate.
      try { await admit(); } catch { rejected = true; fail(response, 503, 'memory_dispatch_context_unavailable'); input.onRejected?.(); return; }
      if (closed || rejected) return fail(response, 503, 'memory_dispatch_context_unavailable');
      controller.signal.throwIfAborted(); input.signal.throwIfAborted(); requestCount++;
      const target = new URL(upstream.origin);
      const path = new URL(request.url!, baseUrl); target.pathname = upstream.pathname.replace(/\/$/, '') + path.pathname; target.search = path.search;
      const headers = new Headers({ 'content-type': 'application/json', 'x-api-key': input.apiKey, ...providerHeaders });
      if (request.headers.authorization?.startsWith('Bearer ')) headers.set('authorization', `Bearer ${input.apiKey}`);
      for (const name of ['anthropic-version', 'anthropic-beta', 'accept', 'idempotency-key', 'x-stainless-retry-count', 'x-stainless-timeout']) {
        const value = request.headers[name]; if (typeof value === 'string') headers.set(name, value);
      }
      const result = await forward(target, { method: 'POST', headers, body: Buffer.concat(chunks, length), signal: controller.signal, redirect: 'manual' });
      if (result.status >= 300 && result.status < 400) { await result.body?.cancel(); return fail(response, 502, 'controlled_transport_redirect_unsupported'); }
      const responseHeaders: Record<string, string> = { 'content-type': result.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' };
      for (const name of ['request-id', 'retry-after', 'retry-after-ms', 'x-should-retry']) {
        const value = result.headers.get(name); if (value) responseHeaders[name] = value;
      }
      result.headers.forEach((value, name) => { if (name.startsWith('anthropic-ratelimit-')) responseHeaders[name] = value; });
      response.writeHead(result.status, responseHeaders);
      const reader = result.body?.getReader();
      const cancelRead = () => { void reader?.cancel().catch(() => undefined); };
      controller.signal.addEventListener('abort', cancelRead, { once: true });
      if (reader) try {
        while (true) { const next = await reader.read(); if (next.done) break; if (!response.write(next.value)) await once(response, 'drain', { signal: controller.signal }); }
      } finally { controller.signal.removeEventListener('abort', cancelRead); if (controller.signal.aborted) await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      response.end();
    } catch { fail(response, 503, 'controlled_transport_unavailable'); }
    finally { requests.delete(controller); response.off('close', onClosed); }
  }
  return { baseUrl, token, get requestCount() { return requestCount; }, get rejected() { return rejected; },
    async close() {
      input.signal.removeEventListener('abort', stop);
      const closing = server.listening ? once(server, 'close') : undefined; stop();
      if (closing) await closing;
    } };
}
