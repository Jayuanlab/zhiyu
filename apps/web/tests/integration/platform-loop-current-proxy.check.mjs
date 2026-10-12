// Loopback transport contract only. No real model, provider or business request.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startLoopCurrentProviderProxy } from '../../scripts/lib/platform-loop-current-comparison-proxy.mjs';
const secret = 'synthetic-secret-only', received = {}; let upstreamCalls = 0;
const upstream = http.createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  upstreamCalls++; received.body = Buffer.concat(chunks).toString(); received.key = request.headers['x-api-key'];
  received.marker = request.headers['x-opencode-session']; received.url = request.url;
  response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(`data: ${secret}\n\n`);
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const address = upstream.address(); if (!address || typeof address === 'string') throw Error('Missing test server');
const endpoint = `http://127.0.0.1:${address.port}/go`, folder = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-proxy-contract-'));
const proxy = await startLoopCurrentProviderProxy({ upstreamBaseUrl: endpoint, outputDir: folder, arm: 'off', model: 'synthetic', protocol: 'anthropic-messages', secrets: [secret] });
try {
  proxy.beginCase('LOOP-CURRENT-01');
  const body = JSON.stringify({ model: 'synthetic', messages: [{ role: 'user', content: secret }], tools: [{ name: 'time' }], max_tokens: 17 });
  const headers = { 'Content-Type': 'application/json', 'x-api-key': secret, 'x-opencode-session': 'zhiyu-pi-runtime-synthetic' };
  const response = await fetch(`${proxy.baseUrl}/v1/messages?beta=true`, { method: 'POST', headers, body });
  assert.equal(await response.text(), `data: ${secret}\n\n`); assert.deepEqual(received, { body, key: secret, marker: headers['x-opencode-session'], url: '/go/v1/messages?beta=true' });
  for (let count = 0; !proxy.receipts.length && count < 20; count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(proxy.receipts.length, 1); assert.equal(proxy.receipts[0].status, 'completed');
  assert.deepEqual(proxy.receipts[0].observedBudget, { max_tokens: 17 });
  assert.equal(proxy.receipts[0].sdkSessionHeaderMatched, true);
  for (const [suffix, requestHeaders] of [['/v1/messages?beta=true&target=other', headers], ['/other?beta=true', headers], ['/v1/messages?beta=true', { ...headers, 'x-opencode-session': 'zhiyu-brain-synthetic' }]]) {
    const denied = await fetch(proxy.baseUrl + suffix, { method: 'POST', headers: requestHeaders, body });
    assert.equal(denied.status, 403); await denied.body?.cancel();
  }
  assert.equal(upstreamCalls, 1); assert.equal(proxy.receipts.length, 1);
  const persisted = fs.readdirSync(folder).map(name => fs.readFileSync(path.join(folder, name), 'utf8')).join('\n');
  assert.ok(!persisted.includes(secret) && !persisted.includes(endpoint) && !persisted.includes('x-api-key'));
  console.log(JSON.stringify({ status: 'passed', scope: 'scripted_transport_contract_only', programChecks: 13, realModelCalls: 0 }));
} finally {
  await proxy.stop(); await new Promise(resolve => upstream.close(() => resolve()));
  if (path.dirname(path.resolve(folder)) !== path.resolve(os.tmpdir()) || !path.basename(folder).startsWith('loop-proxy-contract-') || fs.lstatSync(folder).isSymbolicLink()) throw Error('Unsafe contract cleanup scope');
  fs.rmSync(folder, { recursive: true });
}
