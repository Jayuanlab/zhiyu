import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type ProviderStreams } from '@earendil-works/pi-ai';
import type { AgentProviderStreamDiagnostics, AgentSdkRequestParameters } from '../types';

type Invocation = AgentProviderStreamDiagnostics['invocations'][number];
type Stage = Invocation['stages'][number];
type SafeError = NonNullable<Stage['error']>;
type ContextReceipt = NonNullable<Invocation['contextReceipt']>;
type PayloadCallback = AgentSdkRequestParameters['callbacks'][number];
const tokenParameterFields = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'] as const;

function requestParametersReceipt(): AgentSdkRequestParameters {
  return { schemaVersion: 'pi-sdk-request-parameters.v1', source: 'sdk_request_parameters', state: 'unknown',
    totalCallbacks: 0, omittedCallbacks: 0, maximumRetainedCallbacks: 4, observerFailures: 0, callbacks: [] };
}

function updateRequestParametersState(receipt: AgentSdkRequestParameters) {
  const observed = receipt.callbacks.filter(callback => callback.outcome === 'observed').length;
  receipt.state = observed === 0 ? 'unknown'
    : observed === receipt.callbacks.length && receipt.omittedCallbacks === 0 ? 'observed' : 'partial';
}

const errorNames = new Set<NonNullable<SafeError['name']>>([
  'Error', 'TypeError', 'RangeError', 'AbortError', 'TimeoutError', 'APIError',
  'APIConnectionError', 'APIConnectionTimeoutError', 'AuthenticationError',
  'PermissionDeniedError', 'BadRequestError', 'NotFoundError', 'ConflictError',
  'UnprocessableEntityError', 'RateLimitError', 'InternalServerError', 'UnknownError',
]);
const errorCodes = new Set<NonNullable<SafeError['code']>>([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'ABORT_ERR', 'ERR_CANCELED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'ERR_NETWORK',
]);

function field(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try { return Reflect.get(value, key); } catch { return undefined; }
}

const tokenCount = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const positiveTokenCount = (value: unknown): number | null => {
  const count = tokenCount(value);
  return count !== null && count > 0 ? count : null;
};

function contextReceipt(input: { model: unknown; context: unknown; options: unknown }): ContextReceipt {
  const configuredWindow = positiveTokenCount(field(input.model, 'contextWindow'));
  const configuredOutput = positiveTokenCount(field(input.options, 'maxTokens'));
  const messages = field(input.context, 'messages'), tools = field(input.context, 'tools');
  let serializedCharacters: number | null = null;
  // This is the SDK context representation, not tokenization or the HTTP payload.
  // Only its length survives; no prompt, tool arguments or provider headers are stored.
  try {
    const encoded = JSON.stringify(input.context);
    if (typeof encoded === 'string') serializedCharacters = encoded.length;
  } catch { /* Cyclic or inaccessible contexts remain unknown without affecting the run. */ }
  return {
    schemaVersion: 'pi-context-receipt.v1',
    configuredContextWindow: { value: configuredWindow, source: configuredWindow === null ? 'unknown' : 'local_model_config' },
    configuredMaxOutputTokens: { value: configuredOutput, source: configuredOutput === null ? 'unknown' : 'stream_options' },
    sdkInput: { serializedCharacters, characterUnit: 'utf16', messages: Array.isArray(messages) ? messages.length : null,
      tools: Array.isArray(tools) ? tools.length : null },
    usage: { status: 'unknown', source: 'unknown', inputTokens: null, outputTokens: null, cacheReadTokens: null,
      cacheWriteTokens: null, totalTokens: null, reasoningTokens: null },
    stopReason: 'unknown', providerContextLimit: null, tokenizer: 'unknown', tokenEstimate: null,
    truncation: 'unknown', compaction: 'unknown', evidenceIds: 'unknown',
  };
}

function resultUsage(result: unknown): ContextReceipt['usage'] {
  const usage = field(result, 'usage');
  const counts = {
    inputTokens: tokenCount(field(usage, 'input')), outputTokens: tokenCount(field(usage, 'output')),
    cacheReadTokens: tokenCount(field(usage, 'cacheRead')), cacheWriteTokens: tokenCount(field(usage, 'cacheWrite')),
    totalTokens: tokenCount(field(usage, 'totalTokens')), reasoningTokens: tokenCount(field(usage, 'reasoning')),
  };
  // SDK default/error receipts synthesize zero counts even when no provider
  // usage arrived. Those defaults do not establish zero token use or cost.
  if (!Object.values(counts).some(value => value !== null && value > 0)) {
    return { status: 'unknown', source: 'unknown', inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, reasoningTokens: null };
  }
  const required = [counts.inputTokens, counts.outputTokens, counts.cacheReadTokens, counts.cacheWriteTokens, counts.totalTokens];
  const observed = required.filter(value => value !== null).length;
  return { status: observed === required.length ? 'reported' : observed || counts.reasoningTokens !== null ? 'partial' : 'unknown',
    source: observed || counts.reasoningTokens !== null ? 'sdk_result' : 'unknown', ...counts };
}

function safeName(value: unknown): SafeError['name'] {
  return typeof value === 'string' && errorNames.has(value as NonNullable<SafeError['name']>)
    ? value as NonNullable<SafeError['name']> : 'UnknownError';
}

function safeCode(value: unknown): SafeError['code'] {
  return typeof value === 'string' && errorCodes.has(value as NonNullable<SafeError['code']>)
    ? value as NonNullable<SafeError['code']> : undefined;
}

/** Fixed enum/HTTP status projection. Never stringify an error or read its payload. */
function safeError(error: unknown): SafeError {
  const code = safeCode(field(error, 'code'));
  const status = field(error, 'status');
  const cause = field(error, 'cause');
  const causeCode = safeCode(field(cause, 'code'));
  return {
    name: safeName(field(error, 'name')),
    ...(code ? { code } : {}),
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(cause !== undefined ? { causeName: safeName(field(cause, 'name')) } : {}),
    ...(causeCode ? { causeCode } : {}),
  };
}

/** Run-local recorder with four stages per invocation and the last 21 invocations. */
export function createPiStreamDiagnostics(controllerSignal: AbortSignal) {
  let totalInvocations = 0;
  const invocations: Invocation[] = [];
  return {
    start(signal: AbortSignal, input?: { model: unknown; context: unknown; options: unknown }) {
      const started = performance.now();
      const invocation: Invocation = { invocation: ++totalInvocations, firstEventReceived: false, stages: [] };
      if (input) {
        invocation.contextReceipt = contextReceipt(input);
        invocation.sdkRequestParameters = requestParametersReceipt();
      }
      invocations.push(invocation);
      if (invocations.length > 21) invocations.shift();
      let failed = false, terminal = false, reportedAborted = false;
      const record = (stage: Stage['stage'], extra: Partial<Stage> = {}) => {
        invocation.stages.push({
          stage,
          elapsedMs: stage === 'request_start' ? 0 : Math.max(0, Math.round(performance.now() - started)),
          signalAborted: signal.aborted,
          controllerAborted: controllerSignal.aborted,
          ...extra,
        });
      };
      record('request_start');
      const fail = (error: unknown, phase: NonNullable<Stage['phase']>, aborted = false) => {
        if (terminal) return;
        reportedAborted ||= aborted;
        if (failed) return;
        failed = true;
        record('error', { phase, errorMetadataStatus: error === undefined ? 'not_exposed' : 'safe_projection',
          ...(error !== undefined ? { error: safeError(error) } : {}) });
      };
      return {
        startPayloadCallback() {
          const receipt = invocation.sdkRequestParameters ??= requestParametersReceipt();
          const callback: PayloadCallback = { callback: ++receipt.totalCallbacks,
            outcome: terminal ? 'after_terminal' : 'pending', tokenParameters: [] };
          receipt.callbacks.push(callback);
          if (receipt.callbacks.length > receipt.maximumRetainedCallbacks) receipt.callbacks.shift();
          receipt.omittedCallbacks = receipt.totalCallbacks - receipt.callbacks.length;
          updateRequestParametersState(receipt);
          return {
            resolve(payload: unknown) {
              if (terminal) { callback.outcome = 'after_terminal'; updateRequestParametersState(receipt); return; }
              try {
                // Inspect only approved own data fields. Do not invoke getters,
                // stringify a payload, retain references or infer absent limits.
                if (payload !== null && typeof payload === 'object') {
                  for (const name of tokenParameterFields) {
                    const descriptor = Object.getOwnPropertyDescriptor(payload, name);
                    const value = descriptor && 'value' in descriptor ? positiveTokenCount(descriptor.value) : null;
                    if (value !== null) callback.tokenParameters.push({ field: name, value });
                  }
                }
                callback.outcome = callback.tokenParameters.length === 1 ? 'observed'
                  : callback.tokenParameters.length > 1 ? 'ambiguous' : 'unknown';
              } catch {
                callback.tokenParameters = [];
                callback.outcome = 'observer_error';
                receipt.observerFailures++;
              }
              updateRequestParametersState(receipt);
            },
            reject() {
              callback.outcome = terminal ? 'after_terminal' : 'hook_rejected';
              updateRequestParametersState(receipt);
            },
          };
        },
        firstEvent(firstEventKind: NonNullable<Stage['firstEventKind']> = 'other') {
          if (invocation.firstEventReceived || terminal) return;
          invocation.firstEventReceived = true;
          record('first_event', { firstEventKind });
        },
        fail,
        result(result: unknown) {
          if (terminal || !invocation.contextReceipt) return;
          invocation.contextReceipt.usage = resultUsage(result);
          const reason = field(result, 'stopReason');
          invocation.contextReceipt.stopReason = reason === 'stop' || reason === 'length' || reason === 'toolUse' || reason === 'error' || reason === 'aborted'
            ? reason : 'unknown';
        },
        finish(stopReason?: string, terminalConsistency?: Stage['terminalConsistency']) {
          if (terminal) return;
          if (stopReason === 'error' || stopReason === 'aborted') fail(undefined, 'stream_result', stopReason === 'aborted');
          const outcome = reportedAborted || signal.aborted || controllerSignal.aborted ? 'aborted' : failed ? 'failed' : 'completed';
          record('terminal', { outcome, ...(terminalConsistency ? { terminalConsistency } : {}) });
          terminal = true;
        },
      };
    },
    snapshot(): AgentProviderStreamDiagnostics | undefined {
      if (totalInvocations === 0) return undefined;
      return {
        schemaVersion: 'agent-provider-stream-diagnostics.v1', scope: 'provider_stream_invocation',
        totalInvocations, omittedInvocations: totalInvocations - invocations.length,
        invocations: invocations.map(invocation => ({ ...invocation,
          ...(invocation.sdkRequestParameters ? { sdkRequestParameters: { ...invocation.sdkRequestParameters,
            callbacks: invocation.sdkRequestParameters.callbacks.map(callback => ({ ...callback,
              tokenParameters: callback.tokenParameters.map(parameter => ({ ...parameter })),
            })),
          } } : {}),
          ...(invocation.contextReceipt ? { contextReceipt: { ...invocation.contextReceipt,
            configuredContextWindow: { ...invocation.contextReceipt.configuredContextWindow },
            configuredMaxOutputTokens: { ...invocation.contextReceipt.configuredMaxOutputTokens },
            sdkInput: { ...invocation.contextReceipt.sdkInput }, usage: { ...invocation.contextReceipt.usage },
          } } : {}),
          stages: invocation.stages.map(stage => ({ ...stage, ...(stage.error ? { error: { ...stage.error } } : {}) })),
        })),
      };
    },
  };
}

/** Preserves the Harness error text and configured stream; never retries. */
export function observePiStreamFn(
  streamFn: StreamFn,
  controllerSignal: AbortSignal,
  diagnostics: ReturnType<typeof createPiStreamDiagnostics>,
) {
  const stream: ProviderStreams['streamSimple'] = (model, context, options) => {
    const output = createAssistantMessageEventStream();
    const signal = options?.signal ? AbortSignal.any([controllerSignal, options.signal]) : controllerSignal;
    const observed = diagnostics.start(signal, { model, context, options });
    void (async () => {
      let phase: NonNullable<Stage['phase']> = 'stream_open';
      try {
        controllerSignal.throwIfAborted();
        const streamOptions = { ...options, signal };
        const originalHook = streamOptions.onPayload;
        streamOptions.onPayload = async function (payload, payloadModel) {
          const callback = observed.startPayloadCallback();
          try {
            const replacement = await originalHook?.call(this, payload, payloadModel);
            callback.resolve(replacement === undefined ? payload : replacement);
            return replacement;
          } catch (error) {
            callback.reject();
            throw error;
          }
        };
        const source = await streamFn(model, context, streamOptions);
        phase = 'stream_iteration';
        let terminalEvent: Extract<AssistantMessageEvent, { type: 'done' | 'error' }> | undefined;
        for await (const event of source) {
          const firstEventKind = event.type === 'start' || event.type === 'done' || event.type === 'error' ? event.type
            : event.type.startsWith('text_') ? 'text' : event.type.startsWith('thinking_') ? 'thinking'
            : event.type.startsWith('toolcall_') ? 'tool_call' : 'other';
          observed.firstEvent(firstEventKind);
          if (event.type === 'error') observed.fail(undefined, 'stream_event', event.reason === 'aborted');
          // SDK terminal events settle output.result() immediately. Wait for the
          // source's own result receipt so a late rejection cannot look complete.
          if (event.type === 'done' || event.type === 'error') {
            if (terminalEvent?.type !== 'error') terminalEvent = event;
          } else output.push(event);
        }
        phase = 'stream_result';
        const result = await source.result();
        observed.result(result);
        const terminalConsistency = !terminalEvent ? 'receipt_only'
          : terminalEvent.reason === result.stopReason ? 'consistent' : 'event_result_mismatch';
        if (terminalConsistency === 'event_result_mismatch') observed.fail(undefined, 'stream_result');
        // A failed event or receipt always wins. Normal receipts are the final
        // payload, but must never erase an error/abort event or contradictory end.
        const failure = result.stopReason === 'error' || result.stopReason === 'aborted' ? result
          : terminalEvent?.type === 'error' ? terminalEvent.error
          : terminalConsistency === 'event_result_mismatch' ? { ...result, content: [], stopReason: 'error' as const,
            errorMessage: 'Pi provider terminal event disagrees with its result receipt' } : undefined;
        // A provider may ignore cancellation and still return a normal receipt.
        // Reject that receipt before SDK output settlement, retaining existing failures.
        if (!failure) controllerSignal.throwIfAborted();
        observed.finish(result.stopReason, terminalConsistency);
        if (failure) {
          // SDK-local aborts are provider failures unless the host controller is
          // actually cancelled. This prevents Harness invariant errors from
          // replacing the provider's original error text.
          const reason: 'aborted' | 'error' = controllerSignal.aborted ? 'aborted' : 'error';
          const error: AssistantMessage = { ...failure, stopReason: reason };
          output.push({ type: 'error', reason, error });
          output.end(error);
        } else {
          if (terminalEvent?.type === 'done') output.push({ ...terminalEvent, message: result });
          output.end(result);
        }
      } catch (error) {
        observed.fail(error, phase);
        observed.finish();
        output.push({
          type: 'error', reason: controllerSignal.aborted ? 'aborted' : 'error',
          error: {
            role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
            timestamp: Date.now(), stopReason: controllerSignal.aborted ? 'aborted' : 'error',
            errorMessage: error instanceof Error ? error.message : String(error),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          },
        });
      }
    })();
    return output;
  };
  return stream;
}
