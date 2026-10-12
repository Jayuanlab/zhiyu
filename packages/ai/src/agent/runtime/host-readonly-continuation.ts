import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentOptions } from '../types';

const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** A run-local bounded episode; it does not own Web evidence or tool budgets. */
export function createHostReadonlyContinuation(input: {
  options?: AgentOptions['hostReadonlyContinuation']; signal: AbortSignal;
  timeoutMs?: number; toolNames: string[];
}) {
  const startedAt = performance.now();
  let attempted = false, active = false, extraForwards = 0, reads = 0, outputRemaining = 0;
  let failure: string | undefined;
  const handles = new Set<string>();
  const fail = (message: string) => {
    failure ??= message;
    return new Error(failure);
  };
  const validTool = (name: string, params: unknown) => {
    if (name !== 'platformRecall' || !params || typeof params !== 'object' || Array.isArray(params)) return false;
    try {
      if (Object.getPrototypeOf(params) !== Object.prototype && Object.getPrototypeOf(params) !== null) return false;
      const keys = Reflect.ownKeys(params);
      const handle = Object.getOwnPropertyDescriptor(params, 'readHandle')?.value;
      return keys.length === 1 && keys[0] === 'readHandle' && typeof handle === 'string' && handles.has(handle);
    } catch { return false; }
  };
  return {
    get enabled() { return !!input.options; },
    get active() { return active; },
    get failure() { return failure; },
    async beforeClose() {
      if (!input.options || attempted || input.signal.aborted) return undefined;
      attempted = true;
      try {
        const candidate = await input.options.beforeClose();
        input.signal.throwIfAborted();
        if (!candidate || typeof candidate.followUp !== 'string' || !candidate.followUp.trim() || candidate.followUp.length > 16000
          || !Array.isArray(candidate.readHandles) || candidate.readHandles.length < 1 || candidate.readHandles.length > 2
          || candidate.readHandles.some(handle => typeof handle !== 'string' || !handle.trim() || handle.length > 1000)
          || new Set(candidate.readHandles).size !== candidate.readHandles.length || !input.toolNames.includes('platformRecall')) return undefined;
        const grant = await input.options.reserveOutputTokens?.();
        input.signal.throwIfAborted();
        // Two requests receive pre-reserved caps. Unknown SDK usage never releases a grant.
        if (!positiveInteger(grant) || grant < 2) return undefined;
        if (positiveInteger(input.timeoutMs) && performance.now() - startedAt >= input.timeoutMs) {
          fail('Readonly continuation original timeout exhausted');
          return undefined;
        }
        outputRemaining = grant;
        candidate.readHandles.forEach(handle => handles.add(handle));
        active = true;
        await input.options.onEpisodeStarted?.({ readHandles: [...handles], maxForwards: 2, maxReads: 2, reservedOutputTokens: grant });
        input.signal.throwIfAborted();
        return { followUp: candidate.followUp };
      } catch {
        if (!input.signal.aborted) fail('Readonly continuation host admission failed');
        return undefined;
      }
    },
    wrapStream(streamFn: StreamFn): StreamFn {
      return async (model, context, options) => {
        input.signal.throwIfAborted();
        if (failure) throw new Error(failure);
        if (!active) return streamFn(model, context, options);
        // This check is immediately before the actual configured host stream.
        // SDK hooks may swallow errors; they cannot bypass this forward fence.
        if (extraForwards >= 2) throw fail('Readonly continuation forward limit exceeded');
        const reservedCap = Math.floor(outputRemaining / (2 - extraForwards));
        const cap = Math.min(reservedCap, positiveInteger(model.maxTokens) ? model.maxTokens : reservedCap,
          positiveInteger(options?.maxTokens) ? options.maxTokens : reservedCap);
        if (!positiveInteger(cap)) throw fail('Readonly continuation output budget exhausted');
        const remainingTimeout = positiveInteger(input.timeoutMs) ? Math.floor(input.timeoutMs - (performance.now() - startedAt)) : undefined;
        if (remainingTimeout !== undefined && remainingTimeout <= 0) throw fail('Readonly continuation original timeout exhausted');
        extraForwards++;
        outputRemaining -= cap;
        return streamFn({ ...model, maxTokens: cap }, context, { ...options, maxTokens: cap,
          ...(remainingTimeout !== undefined ? { timeoutMs: Math.min(remainingTimeout, positiveInteger(options?.timeoutMs) ? options.timeoutMs : remainingTimeout) } : {}) });
      };
    },
    checkResponse<T extends AssistantMessage>(message: T): T {
      if (!active) return message;
      if (message.stopReason === 'length') fail('Readonly continuation output was truncated');
      const calls = message.content.filter(block => block.type === 'toolCall');
      // The second reserved request is the final response. Reject before the
      // SDK dispatches any tools, even when a repeated handle is allowlisted.
      if (extraForwards >= 2 && calls.length) fail('Readonly continuation final phase cannot call tools');
      if (calls.some(call => !validTool(call.name, call.arguments)) || reads + calls.length > 2) fail('Readonly continuation tool fence rejected the call');
      return failure ? { ...message, content: [], stopReason: 'error', errorMessage: failure } : message;
    },
    beforeTool(name: string, params: unknown, consume = false) {
      if (!active) return;
      input.signal.throwIfAborted();
      if (failure) throw new Error(failure);
      // Keep dispatch independently fenced if a SDK response hook is bypassed.
      if (extraForwards >= 2) throw fail('Readonly continuation final phase cannot call tools');
      if (!validTool(name, params) || (consume && reads >= 2)) throw fail('Readonly continuation tool fence rejected the call');
      if (consume) reads++;
    },
  };
}
