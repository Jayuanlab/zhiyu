import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loopCurrentSdkEndpoint, loopCurrentSdkSessionMarker } from './platform-loop-current-comparison-fetch-observer.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const maximumCapture = 4 * 1024 * 1024;
const forbiddenHeaders = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding']);

/** Transport observation only: forward provider bytes; never synthesize model responses. */
export async function startLoopCurrentProviderProxy({ upstreamBaseUrl, outputDir, arm, model, protocol, secrets = [] }) {
  const upstream = new URL(upstreamBaseUrl);
  if (upstream.username || upstream.password || !['http:', 'https:'].includes(upstream.protocol)) throw Error('Invalid provider endpoint');
  const sdkEndpoint = new URL(loopCurrentSdkEndpoint({ baseUrl: upstreamBaseUrl, protocol }));
  const sdkMarker = loopCurrentSdkSessionMarker(model);
  let activeCase = null, sequence = 0;
  const receipts = [];
  const redact = value => [...secrets, upstreamBaseUrl].filter(secret => typeof secret === 'string' && secret.length > 0)
    .reduce((safe, secret) => safe.replaceAll(secret, '[REDACTED]'), value);
  fs.mkdirSync(outputDir, { recursive: true });
  const server = http.createServer(async (request, response) => {
    const incoming = new URL(request.url, 'http://127.0.0.1');
    const target = sdkEndpoint;
    if (request.method !== 'POST' || incoming.pathname !== sdkEndpoint.pathname || incoming.search !== sdkEndpoint.search
      || request.headers['x-opencode-session'] !== sdkMarker) { response.writeHead(403); response.end('Provider proxy scope denied'); return; }
    const tag = activeCase;
    if (!tag) { response.writeHead(409); response.end('No active synthetic case'); return; }
    const number = ++sequence;
    const prefix = `${tag}-${String(number).padStart(3, '0')}`;
    const record = { schemaVersion: 'transparent-provider-observation.v1', arm, caseId: tag,
      sequence: number, startedAt: new Date().toISOString(), endpointHash: hash(upstreamBaseUrl),
      requestHash: null, observedModel: null, observedToolNames: [], modelVisibleToolSchemaHash: null,
      modelVisibleContextHash: null, responseBytes: 0, captureTruncated: false, responseHash: null, status: 'running' };
    record.transportScope = 'exact_locked_main_sdk_endpoint';
    record.sdkSessionHeaderMatched = true;
    const controller = new AbortController(); response.on('close', () => { if (!response.writableEnded) controller.abort(); });
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > maximumCapture) throw Error('Provider request observation limit exceeded'); chunks.push(chunk); }
      const body = Buffer.concat(chunks); record.requestHash = hash(body);
      const payload = JSON.parse(body.toString('utf8'));
      record.observedModel = typeof payload.model === 'string' ? payload.model : null;
      record.observedProtocol = incoming.pathname.endsWith('/messages') ? 'anthropic-messages'
        : incoming.pathname.endsWith('/chat/completions') ? 'openai-completions' : incoming.pathname.endsWith('/responses') ? 'openai-responses' : null;
      record.observedToolNames = (Array.isArray(payload.tools) ? payload.tools : []).map(tool => tool.name ?? tool.function?.name).filter(name => typeof name === 'string');
      record.modelVisibleToolSchemaHash = hash(JSON.stringify(payload.tools ?? []));
      record.modelVisibleContextHash = hash(JSON.stringify({ system: payload.system, instructions: payload.instructions, messages: payload.messages, input: payload.input }));
      record.observedBudget = Object.fromEntries(['max_tokens', 'max_output_tokens', 'temperature', 'top_p', 'stream'].filter(key => key in payload).map(key => [key, payload[key]]));
      // Do not persist request headers, endpoint URLs, credentials or arbitrary
      // provider metadata. This body contains only synthetic model input fields.
      const safePayload = Object.fromEntries(['model', 'system', 'instructions', 'messages', 'input', 'tools', 'max_tokens', 'max_output_tokens', 'temperature', 'top_p', 'stream'].filter(key => key in payload).map(key => [key, payload[key]]));
      const originalModelVisible = JSON.stringify(safePayload, null, 2), safeModelVisible = redact(originalModelVisible);
      record.modelVisibleCaptureRedacted = originalModelVisible !== safeModelVisible;
      record.persistedModelVisibleHash = hash(safeModelVisible);
      fs.writeFileSync(path.join(outputDir, `${prefix}-model-visible.json`), safeModelVisible, 'utf8');
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([key]) => !forbiddenHeaders.has(key.toLowerCase())));
      // A redirect would leave the independently locked endpoint. Treat it as an
      // unsupported observer transport rather than silently capturing another URL.
      const upstreamResponse = await fetch(target, { method: 'POST', headers, body, signal: controller.signal, redirect: 'error' });
      record.httpStatus = upstreamResponse.status;
      const publicHeaders = Object.fromEntries([...upstreamResponse.headers].filter(([key]) => !['connection', 'content-length', 'content-encoding', 'transfer-encoding'].includes(key.toLowerCase())));
      // Never copy upstream cookie/auth/credential headers to the observer files.
      response.writeHead(upstreamResponse.status, publicHeaders);
      const captured = [], responseDigest = createHash('sha256'); let capturedBytes = 0;
      if (upstreamResponse.body) for await (const chunk of upstreamResponse.body) {
        const block = Buffer.from(chunk); responseDigest.update(block); record.responseBytes += block.length;
        const remaining = Math.max(0, maximumCapture - capturedBytes);
        if (remaining) { const retained = block.subarray(0, remaining); captured.push(retained); capturedBytes += retained.length; }
        if (record.responseBytes > maximumCapture) record.captureTruncated = true;
        response.write(block);
      }
      response.end(); record.responseHash = responseDigest.digest('hex');
      const originalCapture = Buffer.concat(captured).toString('utf8');
      const safeCapture = redact(originalCapture);
      record.captureRedacted = safeCapture !== originalCapture;
      fs.writeFileSync(path.join(outputDir, `${prefix}-raw-provider-stream.txt`), safeCapture, 'utf8');
      record.status = 'completed';
    } catch {
      record.status = controller.signal.aborted ? 'aborted' : 'transport_error';
      // Raw exception messages may contain credential-bearing URLs.
      if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain' });
      if (!response.writableEnded) response.end('Transparent provider transport failed');
    } finally {
      record.finishedAt = new Date().toISOString(); receipts.push(record);
      fs.writeFileSync(path.join(outputDir, `${prefix}-receipt.json`), JSON.stringify(record, null, 2), 'utf8');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl: origin + upstream.pathname + upstream.search,
    endpointHash: hash(upstreamBaseUrl), resolvedProxyUrl: origin + upstream.pathname,
    beginCase(id) { if (!/^LOOP-CURRENT-\d{2}$/.test(id)) throw Error('Invalid synthetic case tag'); activeCase = id; },
    endCase() { activeCase = null; }, receipts,
    async stop() { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
