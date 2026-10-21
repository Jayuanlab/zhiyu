import { createHash } from 'node:crypto';

type RecoveryModel = { id: string; api: string; baseUrl: string };
type UsageObservation = {
  status: 'partial' | 'unknown';
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  billing: 'unknown';
};
type Classification = 'opaque_empty_error' | 'complete_sse' | 'explicit_error' | 'length' |
  'incomplete_sse' | 'parse_error' | 'http_error' | 'non_sse' | 'transport_error' |
  'aborted' | 'buffer_limit' | 'frame_limit';
type ReceiptBase = {
  schemaVersion: 'host-provider-transport.v1';
  logicalInvocation: number;
  attempt: 1 | 2;
  transportOrdinal: number;
  bodyHash: string;
};

export type HostProviderTransportAttempt = ReceiptBase & (
  | { phase: 'prepared'; deadlineAt: string; sameBody: boolean | null; sameHeaders: boolean | null }
  | { phase: 'finished'; httpStatus: number | null; physicalFetchStarted: boolean;
    responseBytes: number | null; responseBodyHash: string | null; frameCount: number | null;
    classification: Classification; usage: UsageObservation }
  | { phase: 'recovery_decision'; decision: 'retry_once' | 'not_recovered';
    reason: 'exact_opaque_error' | 'run_recovery_budget_exhausted' | 'not_eligible' }
);
export type HostProviderTransportReceipt = HostProviderTransportAttempt;

/** Trusted host configuration only. This is deliberately not a model/tool option. */
export type HostProviderRecoveryOptions = {
  policy: {
    version: 'official-go-qwen-opaque.v1' | 'official-go-qwen-report.v1';
    maxRecoveries: 1;
    sharedTimeoutMs: 120000 | 300000;
    maxBufferedBytes: 4194304;
    maxFrames: 20000;
  };
  onTransportAttempt: (receipt: HostProviderTransportAttempt) => void | Promise<void>;
};

const endpoint = 'https://opencode.ai/inference/go/anthropic/v1/messages';
const baseUrl = 'https://opencode.ai/inference/go/anthropic';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const emptyUsage = (): UsageObservation => ({ status: 'unknown', inputTokens: null, outputTokens: null,
  cacheReadTokens: null, cacheWriteTokens: null, billing: 'unknown' });

class RecoveryBoundaryError extends Error {
  constructor(readonly classification: Classification, message: string) {
    super(message); this.name = 'ProviderRecoveryBoundaryError';
  }
}

function isCanonical(url: string, expected: string, allowSdkBetaQuery = false) {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname.replace(/\/$/, '') === expected
      && !parsed.username && !parsed.password && !parsed.hash
      && (!parsed.search || allowSdkBetaQuery && parsed.search === '?beta=true');
  } catch { return false; }
}

function validatePolicy(options: HostProviderRecoveryOptions) {
  const policy = options.policy;
  const matchedDeadline = policy?.version === 'official-go-qwen-opaque.v1' ? policy.sharedTimeoutMs === 120000
    : policy?.version === 'official-go-qwen-report.v1' && policy.sharedTimeoutMs === 300000;
  if (!policy || !matchedDeadline || policy.maxRecoveries !== 1
    || policy.maxBufferedBytes !== 4194304 || policy.maxFrames !== 20000
    || typeof options.onTransportAttempt !== 'function') {
    throw new Error('Invalid trusted provider recovery policy');
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Provider recovery aborted', 'AbortError');
}

async function underSignal<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    // The late settlement is observed even when the abort wins the race.
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); })
      .then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function readBounded(body: ReadableStream<Uint8Array> | null, maxBytes: number, signal: AbortSignal) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await underSignal(() => reader.read(), signal);
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) throw new RecoveryBoundaryError('buffer_limit', 'Provider recovery response byte limit exceeded');
      chunks.push(next.value);
    }
  } catch (error) {
    // Cancellation is best effort; it must not extend the shared deadline.
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

type Scan = { classification: Classification; frameCount: number; usage: UsageObservation };
function scanSse(bytes: Uint8Array, maxFrames: number): Scan {
  const usage = emptyUsage();
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/g, '\n'); }
  catch { return { classification: 'parse_error', frameCount: 0, usage }; }
  // A final unterminated event cannot authorize recovery, even if its prefix is '{}'.
  const terminated = text.endsWith('\n\n');
  const segments = text.split('\n\n');
  let frameCount = 0, opaqueErrors = 0, explicitErrors = 0, starts = 0, stops = 0;
  let malformed = false, length = false, anyStopReason = false;
  let errorSeen = false;
  const openBlocks = new Set<number>();
  const known = new Set(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop',
    'message_delta', 'message_stop', 'ping']);
  const token = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const observeUsage = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const raw = value as Record<string, unknown>;
    for (const [field, key] of [['inputTokens', 'input_tokens'], ['outputTokens', 'output_tokens'],
      ['cacheReadTokens', 'cache_read_input_tokens'], ['cacheWriteTokens', 'cache_creation_input_tokens']] as const) {
      const observed = token(raw[key]); if (observed !== null) { usage[field] = observed; usage.status = 'partial'; }
    }
  };
  for (const segment of segments) {
    if (!segment.trim()) continue;
    // Count comment-only frames too, so pings cannot evade the frame bound.
    frameCount++;
    if (frameCount > maxFrames) throw new RecoveryBoundaryError('frame_limit', 'Provider recovery SSE frame limit exceeded');
    let event: string | undefined;
    const data: string[] = [];
    for (const line of segment.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const key = colon < 0 ? line : line.slice(0, colon);
      const raw = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (key === 'event') { if (event !== undefined) malformed = true; event = raw; }
      else if (key === 'data') data.push(raw);
      else if (key !== 'id' && key !== 'retry') malformed = true;
    }
    if (!event && !data.length) continue;
    const joined = data.join('\n');
    if (errorSeen) malformed = true;
    if (event === 'error') {
      if (joined.trim() === '{}') opaqueErrors++; else explicitErrors++;
      errorSeen = true;
      continue;
    }
    if (!event || !known.has(event) || !data.length) { malformed = true; continue; }
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(joined);
      if (!value || typeof value !== 'object' || Array.isArray(value)) { malformed = true; continue; }
      parsed = value as Record<string, unknown>;
    } catch { malformed = true; continue; }
    if (parsed.type !== event) { malformed = true; continue; }
    if (event === 'message_start') {
      starts++;
      const message = parsed.message as Record<string, unknown> | undefined;
      if (!message || typeof message !== 'object' || message.type !== 'message' || message.role !== 'assistant'
        || typeof message.id !== 'string' || !Array.isArray(message.content)) malformed = true;
      observeUsage(message?.usage);
    }
    else if (event !== 'ping' && (starts !== 1 || stops !== 0)) malformed = true;
    if (event.startsWith('content_block_')) {
      const index = parsed.index;
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) malformed = true;
      else if (event === 'content_block_start') {
        const block = parsed.content_block as Record<string, unknown> | undefined;
        if (openBlocks.has(index) || !block || typeof block !== 'object'
          || !['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(String(block.type))) malformed = true;
        openBlocks.add(index);
      } else {
        if (!openBlocks.has(index)) malformed = true;
        if (event === 'content_block_stop') openBlocks.delete(index);
        else if (!parsed.delta || typeof parsed.delta !== 'object') malformed = true;
      }
    }
    if (event === 'message_stop') { stops++; if (openBlocks.size || !anyStopReason) malformed = true; }
    if (event === 'message_delta') {
      observeUsage(parsed.usage);
      const delta = parsed.delta as Record<string, unknown> | undefined;
      if (delta?.stop_reason != null) {
        anyStopReason = true;
        if (delta.stop_reason === 'max_tokens' || delta.stop_reason === 'length') length = true;
        else if (!['end_turn', 'tool_use', 'stop_sequence'].includes(String(delta.stop_reason))) explicitErrors++;
      }
    }
  }
  const classification: Classification = length ? 'length' : explicitErrors ? 'explicit_error'
    : malformed || starts > 1 || stops > 1 ? 'parse_error'
    : !terminated ? 'incomplete_sse'
    : opaqueErrors === 1 && stops === 0 && !anyStopReason ? 'opaque_empty_error'
    : opaqueErrors ? 'explicit_error'
    : starts === 1 && stops === 1 && anyStopReason ? 'complete_sse' : 'incomplete_sse';
  return { classification, frameCount, usage };
}

/** One instance belongs to one host run; wrapping multiple logical fetches shares its single recovery. */
export function createProviderStreamRecovery(input: {
  model: RecoveryModel;
  options?: HostProviderRecoveryOptions;
  controllerSignal?: AbortSignal;
}): { enabled: boolean; wrapFetch: (baseFetch: typeof fetch) => typeof fetch } {
  const { options } = input;
  if (!options) return { enabled: false, wrapFetch: baseFetch => baseFetch };
  validatePolicy(options);
  const enabled = input.model.id === 'qwen3.7-plus' && input.model.api === 'anthropic-messages'
    && isCanonical(input.model.baseUrl, baseUrl);
  if (!enabled) return { enabled: false, wrapFetch: baseFetch => baseFetch };
  // Copy fixed limits and the callback so later option mutation cannot relax the boundary.
  const { sharedTimeoutMs, maxBufferedBytes, maxFrames } = options.policy;
  const audit = options.onTransportAttempt;
  let recoveryUsed = false, logicalSequence = 0, transportSequence = 0;

  return { enabled: true, wrapFetch: baseFetch => async (fetchInput, init) => {
    const url = fetchInput instanceof Request ? fetchInput.url : String(fetchInput);
    if (!isCanonical(url, endpoint, true)) return baseFetch(fetchInput, init);
    const original = new Request(fetchInput, init);
    if (original.method !== 'POST') return baseFetch(original, init);
    // Keep nonstandard transport extensions (e.g. undici dispatcher/agent) by
    // identity. Only the privately frozen request fields are replaced below.
    const transportInit = { ...init };
    const deadline = Date.now() + sharedTimeoutMs;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new DOMException('Provider logical request deadline exceeded', 'TimeoutError')), sharedTimeoutMs);
    const signal = AbortSignal.any([original.signal, timeout.signal, ...(input.controllerSignal ? [input.controllerSignal] : [])]);
    try {
      const requestBytes = await readBounded(original.clone().body, maxBufferedBytes, signal);
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(requestBytes)); }
      catch { return await baseFetch(original, transportInit); }
      if (!payload || typeof payload !== 'object' || (payload as Record<string, unknown>).model !== 'qwen3.7-plus'
        || (payload as Record<string, unknown>).stream !== true) return await baseFetch(original, transportInit);
      const logicalInvocation = ++logicalSequence;
      const bodyHash = hash(requestBytes);
      const originalHeaders = [...original.headers.entries()];
      const makeRequest = () => new Request(original.url, { method: original.method, headers: new Headers(originalHeaders),
        body: requestBytes.slice(), signal, credentials: original.credentials, cache: original.cache,
        redirect: original.redirect, referrer: original.referrer, referrerPolicy: original.referrerPolicy,
        integrity: original.integrity, keepalive: original.keepalive, mode: original.mode });
      for (const attempt of [1, 2] as const) {
        signal.throwIfAborted();
        const request = makeRequest();
        const sameBody = attempt === 1 ? null : hash(new Uint8Array(await request.clone().arrayBuffer())) === bodyHash;
        const sameHeaders = attempt === 1 ? null : JSON.stringify([...request.headers.entries()]) === JSON.stringify(originalHeaders);
        if (sameBody === false || sameHeaders === false) throw new Error('Provider recovery private request equality failed');
        const receipt: ReceiptBase = { schemaVersion: 'host-provider-transport.v1', logicalInvocation, attempt,
          transportOrdinal: ++transportSequence, bodyHash };
        await underSignal(async () => audit({ ...receipt, phase: 'prepared', deadlineAt: new Date(deadline).toISOString(), sameBody, sameHeaders }), signal);
        signal.throwIfAborted();
        let physicalFetchStarted = false;
        let response: Response;
        let bytes: Uint8Array | undefined;
        let scan: Scan | undefined;
        let status: number | null = null;
        let classification: Classification = 'transport_error';
        try {
          physicalFetchStarted = true;
          response = await underSignal(() => baseFetch(request, { ...transportInit, method: request.method,
            headers: new Headers(originalHeaders), body: requestBytes.slice(), signal }), signal);
          status = response.status;
          if (status !== 200) classification = 'http_error';
          else if (!/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) classification = 'non_sse';
          else {
            bytes = await readBounded(response.body, maxBufferedBytes, signal);
            scan = scanSse(bytes, maxFrames);
            classification = scan.classification;
          }
        } catch (error) {
          classification = signal.aborted ? 'aborted' : error instanceof RecoveryBoundaryError ? error.classification : 'transport_error';
          // Do not extend the logical deadline to wait for a broken audit store.
          // An unresolved prepared receipt remains incomplete evidence, never a success.
          try {
            await underSignal(async () => audit({ ...receipt, phase: 'finished', httpStatus: status, physicalFetchStarted,
              responseBytes: bytes?.byteLength ?? null, responseBodyHash: bytes ? hash(bytes) : null,
              frameCount: scan?.frameCount ?? null, classification, usage: scan?.usage ?? emptyUsage() }), signal);
          } catch (auditError) {
            if (!signal.aborted) throw auditError;
          }
          throw error;
        }
        await underSignal(async () => audit({ ...receipt, phase: 'finished', httpStatus: status, physicalFetchStarted,
          responseBytes: bytes?.byteLength ?? null, responseBodyHash: bytes ? hash(bytes) : null,
          frameCount: scan?.frameCount ?? null, classification, usage: scan?.usage ?? emptyUsage() }), signal);
        signal.throwIfAborted();
        if (classification === 'opaque_empty_error' && attempt === 1 && !recoveryUsed) {
          // Reserve synchronously before awaiting audit so concurrent logical calls cannot both retry.
          recoveryUsed = true;
          await underSignal(async () => audit({ ...receipt, phase: 'recovery_decision', decision: 'retry_once', reason: 'exact_opaque_error' }), signal);
          continue;
        }
        await underSignal(async () => audit({ ...receipt, phase: 'recovery_decision', decision: 'not_recovered',
          reason: classification === 'opaque_empty_error' ? 'run_recovery_budget_exhausted' : 'not_eligible' }), signal);
        // SDK remains the sole semantic/terminal validator. A second failed stream is never repaired here.
        return bytes ? new Response(new Uint8Array(bytes), { status: response.status, statusText: response.statusText, headers: response.headers }) : response;
      }
      throw new Error('Provider recovery attempt boundary exhausted');
    } finally { clearTimeout(timer); }
  } };
}
