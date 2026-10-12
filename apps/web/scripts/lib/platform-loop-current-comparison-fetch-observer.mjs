// Evaluation-only transport observer. SDK configuration keeps the real base URL
// so its production vendor-header decisions happen before destination rewriting.
const protocols = new Set(['anthropic-messages', 'openai-completions', 'openai-responses']);
function endpointBase(value) {
  let url; try { url = new URL(value); } catch { throw Error('Invalid locked provider endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Explicit credential-free provider endpoint required');
  return url;
}
export function loopCurrentSdkEndpoint({ baseUrl, protocol }) {
  if (!protocols.has(protocol)) throw Error('Unsupported locked provider protocol');
  const base = endpointBase(baseUrl);
  let pathname = base.pathname.replace(/\/+$/, '');
  // This is the existing production Pi config's OpenCode completions normalization.
  if (protocol === 'openai-completions' && /^https:\/\/opencode\.ai\/zen\/go$/i.test(base.toString().replace(/\/+$/, ''))) pathname += '/v1';
  const suffix = protocol === 'anthropic-messages' ? '/v1/messages' : protocol === 'openai-completions' ? '/chat/completions' : '/responses';
  base.pathname = pathname + suffix;
  // Installed Pi Anthropic uses client.beta.messages.create, whose formal SDK
  // request path has this fixed query; other query parameters remain outside scope.
  if (protocol === 'anthropic-messages') base.search = '?beta=true';
  return base.toString();
}
export function loopCurrentSdkSessionMarker(model) {
  if (typeof model !== 'string' || !model.trim()) throw Error('Locked model is required');
  const safe = model.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return 'zhiyu-pi-runtime-' + (safe || 'model');
}
/** Exact main SDK requests only. Never add headers, alter the body or retry. */
export function createLoopCurrentFetchObserver({ upstreamBaseUrl, proxyBaseUrl, model, protocol, fetchImpl }) {
  if (typeof fetchImpl !== 'function') throw Error('Original fetch implementation is required');
  const upstream = endpointBase(upstreamBaseUrl), proxy = endpointBase(proxyBaseUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(proxy.hostname) || proxy.protocol !== 'http:'
    || upstream.origin === proxy.origin || upstream.pathname.replace(/\/+$/, '') !== proxy.pathname.replace(/\/+$/, '')) throw Error('Explicit loopback observer destination required');
  const actualEndpoint = loopCurrentSdkEndpoint({ baseUrl: upstreamBaseUrl, protocol });
  const actual = new URL(actualEndpoint), destination = new URL(actual.pathname + actual.search, proxy.origin).toString();
  const marker = loopCurrentSdkSessionMarker(model);
  return async function observedFetch(input, init) {
    const isRequest = input instanceof Request;
    const inputUrl = isRequest ? input.url : input instanceof URL ? input.toString() : String(input);
    const method = String(init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(init?.headers ?? (isRequest ? input.headers : undefined));
    if (inputUrl !== actualEndpoint || method !== 'POST' || headers.get('x-opencode-session') !== marker) {
      // Other provider paths, JEV/Brain markers and unidentifiable requests retain
      // their original destination and are explicitly outside main observations.
      return fetchImpl(input, init);
    }
    // RequestInit takes precedence exactly as in the original fetch call. Its
    // object, raw body, signal and options are not reconstructed or serialized.
    if (isRequest) {
      if (input.keepalive && input.body) {
        // Node rejects reconstructing an inherited keepalive Request body as a
        // stream although the original Request is legal. Transfer its exact
        // bytes and standard Request fields instead; init still takes precedence.
        // Ordinary SDK URL+init calls never use this compatibility branch.
        const body = init?.body != null ? undefined : await input.arrayBuffer();
        const redirected = new Request(destination, { method: input.method, headers: input.headers, body,
          signal: input.signal, cache: input.cache, credentials: input.credentials, redirect: input.redirect,
          integrity: input.integrity, keepalive: input.keepalive, referrer: input.referrer,
          referrerPolicy: input.referrerPolicy, mode: input.mode });
        return fetchImpl(redirected, init);
      }
      return fetchImpl(new Request(destination, input), init);
    }
    return fetchImpl(input instanceof URL ? new URL(destination) : destination, init);
  };
}
const environmentKeys = ['ZHIYU_EVAL_MAIN_FETCH_UPSTREAM', 'ZHIYU_EVAL_MAIN_FETCH_PROXY', 'ZHIYU_EVAL_MAIN_FETCH_MODEL', 'ZHIYU_EVAL_MAIN_FETCH_PROTOCOL'];
if (environmentKeys.some(key => process.env[key] !== undefined)) {
  let database; try { database = new URL(process.env.ZHIYU_TEST_DATABASE_URL ?? ''); } catch { throw Error('Explicit isolated main transport observation required'); }
  if (environmentKeys.some(key => !process.env[key]) || process.env.ZHIYU_TEST_MODE !== 'integration'
    || !['postgres:', 'postgresql:'].includes(database.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)
    || database.search || database.hash || !/^zhiyu_test_[a-f0-9]{32}$/.test(database.pathname.slice(1))) throw Error('Explicit isolated main transport observation required');
  globalThis.fetch = createLoopCurrentFetchObserver({ upstreamBaseUrl: process.env.ZHIYU_EVAL_MAIN_FETCH_UPSTREAM,
    proxyBaseUrl: process.env.ZHIYU_EVAL_MAIN_FETCH_PROXY, model: process.env.ZHIYU_EVAL_MAIN_FETCH_MODEL,
    protocol: process.env.ZHIYU_EVAL_MAIN_FETCH_PROTOCOL, fetchImpl: globalThis.fetch.bind(globalThis) });
}
