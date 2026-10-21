import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options';
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate';
import type { AgentMessage, AgentOptions } from '../types';

const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** A bounded, host-owned correction episode. It does not grant tool access,
 * reparse invalid JSON, own business state, or replay an earlier business run. */
export function createHostFinalValidation(input: {
  options?: AgentOptions['hostFinalValidation']; signal: AbortSignal; timeoutMs?: number;
  conflictsWithReadonly: boolean; onFailure: (message: string) => void;
  onIntermediate: (message: AgentMessage) => void;
  getWorkingMemorySnapshot?: () => Parameters<NonNullable<AgentOptions['hostFinalValidation']>['validate']>[0]['workingMemory'];
  onApproved?: (text: string) => Promise<void>;
}) {
  const startedAt = performance.now();
  const options = input.options;
  const maxCorrections = options?.maxCorrections ?? 2;
  const maxForwards = options?.maxExtraForwards ?? 4;
  const sourceRecovery = options?.sourceRecovery;
  const boundedCompaction = options?.boundedCompaction;
  const maxRecoveryForwards = sourceRecovery?.maxForwards;
  const recoveryOutputCap = sourceRecovery?.perForwardOutputTokens;
  const timeoutMs = options?.timeoutMs ?? input.timeoutMs;
  let failure: string | undefined;
  let pending: AgentMessage | undefined;
  let approved: AgentMessage | undefined;
  let corrections = 0;
  let extraForwards = 0;
  let recoveryForwards = 0;
  let recoveryExited = !sourceRecovery;
  let recoveryActive = false;
  let requestPurpose: 'assistant' | 'compaction' | undefined;
  let preparedAssistant: { model: Parameters<StreamFn>[0]; originalMaxTokens: number; requestedMaxTokens: number } | undefined;
  let compactionForwards = 0;
  let compactionOutputRemaining = boundedCompaction?.totalOutputTokens ?? 0;
  let outputRemaining = 0;
  let reserved = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const fail = (message: string) => {
    if (!failure) { failure = message; input.onFailure(message); }
    return new Error(failure);
  };
  const remainingTimeout = () => positiveInteger(timeoutMs) ? Math.floor(timeoutMs - (performance.now() - startedAt)) : undefined;
  const guard = () => {
    input.signal.throwIfAborted();
    if (failure) throw new Error(failure);
    if (remainingTimeout() !== undefined && remainingTimeout()! <= 0) throw fail('Final validation whole-runtime deadline exhausted');
  };
  const awaitHost = async <T>(work: Promise<T>): Promise<T> => {
    guard();
    let abort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(input.signal.reason ?? new Error('Final validation aborted'));
      input.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const value = await Promise.race([work, aborted]);
      guard();
      return value;
    } finally { input.signal.removeEventListener('abort', abort); }
  };
  const reserveOutput = async () => {
    if (reserved) return;
    const grant = await awaitHost(Promise.resolve().then(() => options?.reserveOutputTokens?.()));
    if (!positiveInteger(grant) || grant < maxForwards) throw fail('Final validation correction output budget is unknown or exhausted');
    reserved = true; outputRemaining = grant;
  };
  const prepareRecovery = async () => {
    recoveryActive = false;
    if (!recoveryExited && sourceRecovery) {
      let needsSources: boolean;
      try { needsSources = await awaitHost(Promise.resolve().then(() => sourceRecovery.beforeForward())); }
      catch { throw fail('Final validation source recovery coverage callback failed'); }
      if (typeof needsSources !== 'boolean') throw fail('Final validation source recovery callback returned an invalid result');
      if (needsSources) {
        if (recoveryForwards >= maxRecoveryForwards!) throw fail('Final validation source recovery forward limit exhausted');
        recoveryActive = true;
      } else recoveryExited = true;
    }
  };
  const requestedOutput = (model: Parameters<StreamFn>[0], streamOptions: Parameters<StreamFn>[2], compaction: boolean) => {
    // Recovery keeps at least one token for each remaining report forward.
    // This reserve is a bound, never a promise that a report will fit.
    const reservedCap = compaction ? Math.min(boundedCompaction!.perForwardOutputTokens, compactionOutputRemaining,
      outputRemaining - (maxForwards - extraForwards))
      : recoveryActive ? Math.min(recoveryOutputCap!, outputRemaining - (maxForwards - extraForwards))
      : options?.perForwardOutputTokens ? Math.min(options.perForwardOutputTokens,outputRemaining-(maxForwards-extraForwards-1))
      : Math.floor(outputRemaining / (maxForwards - extraForwards));
    const requestedMaxTokens = Math.min(reservedCap, positiveInteger(model.maxTokens) ? model.maxTokens : reservedCap,
      positiveInteger(streamOptions?.maxTokens) ? streamOptions.maxTokens : reservedCap);
    if (!positiveInteger(requestedMaxTokens)) throw fail(compaction ? 'Final validation context compaction output budget exhausted'
      : recoveryActive ? 'Final validation source recovery output budget exhausted' : 'Final validation correction output budget exhausted');
    return requestedMaxTokens;
  };
  const releasePreparedAssistant = () => {
    const prepared = preparedAssistant;
    preparedAssistant = undefined;
    if (prepared) prepared.model.maxTokens = prepared.originalMaxTokens;
    return prepared;
  };
  return {
    get enabled() { return !!options; },
    get failure() { return failure; },
    assertReady() {
      if (!options) return;
      if (input.conflictsWithReadonly) throw fail('Final validation cannot coexist with readonly continuation');
      if (typeof options.validate !== 'function' || !Number.isSafeInteger(maxCorrections) || maxCorrections < 0 || maxCorrections > 2
        || !positiveInteger(maxForwards) || maxForwards > 4
        || options.onForward !== undefined && typeof options.onForward !== 'function'
        || options.perForwardOutputTokens!==undefined&&(!positiveInteger(options.perForwardOutputTokens)||options.perForwardOutputTokens>16384)
        || timeoutMs !== undefined && !positiveInteger(timeoutMs)) throw fail('Final validation configuration is invalid');
      if (sourceRecovery && (!positiveInteger(maxRecoveryForwards) || maxRecoveryForwards > 12 ||
        !positiveInteger(recoveryOutputCap) || recoveryOutputCap > 512 || typeof sourceRecovery.beforeForward !== 'function' ||
        typeof sourceRecovery.isToolAllowed !== 'function' || sourceRecovery.onToolDenied !== undefined &&
        typeof sourceRecovery.onToolDenied !== 'function')) throw fail('Final validation source recovery configuration is invalid');
      if (boundedCompaction && (!positiveInteger(boundedCompaction.maxForwards) || boundedCompaction.maxForwards > 2 ||
        !positiveInteger(boundedCompaction.totalOutputTokens) || boundedCompaction.totalOutputTokens > 4096 ||
        !positiveInteger(boundedCompaction.perForwardOutputTokens) || boundedCompaction.perForwardOutputTokens > 3072 ||
        boundedCompaction.totalOutputTokens < boundedCompaction.maxForwards)) throw fail('Final validation context compaction configuration is invalid');
      guard();
      if (positiveInteger(timeoutMs)) deadlineTimer = setTimeout(() => fail('Final validation whole-runtime deadline exhausted'), remainingTimeout()!);
    },
    beforeRequest(step: 'assistant' | 'deferred' | 'compaction' | 'branch_summary',
      model?: Parameters<StreamFn>[0], streamOptions?: Parameters<StreamFn>[2]) {
      if (!options) return;
      guard();
      if (requestPurpose) throw fail('Final validation received overlapping request purpose receipts');
      if (step !== 'assistant' && step !== 'compaction') throw fail('Final validation request purpose is not allowed');
      requestPurpose = step;
      if (step === 'assistant' && corrections && model) return (async () => {
        if (approved) throw fail('Final validation cannot forward after approving its final candidate');
        if (!reserved) throw fail('Final validation correction output budget is unknown or exhausted');
        await prepareRecovery();
        if (!recoveryActive && extraForwards >= maxForwards) throw fail('Final validation correction forward limit exhausted');
        const requestedMaxTokens = requestedOutput(model, streamOptions, false);
        // SDK captures model.maxTokens as intendedOutputLimit after this hook.
        // Only the adapter's run-local model is lent this request's host bound.
        // Restore it at dispatch; context clamping still happens in wrapStream.
        preparedAssistant = { model, originalMaxTokens: model.maxTokens, requestedMaxTokens };
        model.maxTokens = requestedMaxTokens;
        return undefined;
      })();
    },
    observeEnd(messages: AgentMessage[]): AgentMessage[] {
      if (!options) return messages;
      const visible: AgentMessage[] = [];
      for (const message of messages) {
        if (message.type !== 'result' || message.answerPhase !== 'candidate_final') { visible.push(message); continue; }
        if (pending || approved) { fail('Final validation received multiple pending final candidates'); continue; }
        pending = { ...message };
      }
      return visible;
    },
    async beforeClose(): Promise<{ followUp: string } | undefined> {
      if (!options) return undefined;
      try {
        guard();
        if (!pending || typeof pending.content !== 'string' || !pending.content.trim()) throw fail('Final validation has no nonempty candidate');
        const candidate = pending;
        const workingMemory = input.getWorkingMemorySnapshot?.();
        const result = await awaitHost(Promise.resolve().then(() => options.validate({
          text: candidate.content!, attempt: corrections, signal: input.signal,
          ...(workingMemory === undefined ? {} : { workingMemory }),
        })));
        if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') throw fail('Final validation callback returned an invalid result');
        if (result.ok) {
          if (input.onApproved) await awaitHost(input.onApproved(candidate.content!));
          approved = candidate; pending = undefined; return undefined;
        }
        // Every rejected candidate remains an exact intermediate audit message.
        input.onIntermediate({ ...candidate, answerPhase: 'intermediate' });
        pending = undefined;
        if (typeof result.feedback !== 'string' || !result.feedback.trim() || result.feedback.length > 16000) {
          throw fail('Final validation feedback is empty or invalid');
        }
        if (corrections >= maxCorrections) throw fail('Final validation correction limit exhausted');
        if (!positiveInteger(timeoutMs)) throw fail('Final validation correction deadline is unknown');
        await reserveOutput();
        guard();
        if (extraForwards >= maxForwards) throw fail('Final validation correction forward limit exhausted');
        corrections += 1;
        return { followUp: result.feedback };
      } catch (error) {
        if (!failure && !input.signal.aborted) fail(error instanceof Error ? error.message : 'Final validation host callback failed');
        return undefined; // SDK hooks may swallow failures; the persistent fence remains.
      }
    },
    wrapStream(streamFn: StreamFn): StreamFn {
      return async (model, context, streamOptions) => {
        if (!options) return streamFn(model, context, streamOptions);
        guard();
        const purpose = requestPurpose;
        requestPurpose = undefined;
        const prepared = releasePreparedAssistant();
        if (!purpose) throw fail('Final validation request purpose receipt is missing');
        if (approved) throw fail('Final validation cannot forward after approving its final candidate');
        const remaining = remainingTimeout();
        if (!corrections && purpose === 'assistant') return streamFn(model, context, { ...streamOptions,
          ...(remaining !== undefined ? { timeoutMs: Math.min(remaining, positiveInteger(streamOptions?.timeoutMs) ? streamOptions.timeoutMs : remaining) } : {}) });
        const compaction = purpose === 'compaction';
        if (compaction && !boundedCompaction) throw fail('Final validation context compaction is not allowed');
        if (compaction && !positiveInteger(timeoutMs)) throw fail('Final validation context compaction deadline is unknown');
        if (compaction) await reserveOutput();
        if (!reserved) throw fail('Final validation correction output budget is unknown or exhausted');
        if (compaction) recoveryActive = false;
        else if (!prepared) await prepareRecovery();
        if (compaction && compactionForwards >= boundedCompaction!.maxForwards) throw fail('Final validation context compaction forward limit exhausted');
        if (!compaction && !recoveryActive && extraForwards >= maxForwards) throw fail('Final validation correction forward limit exhausted');
        const requestedMaxTokens = prepared?.requestedMaxTokens ?? requestedOutput(model, streamOptions, compaction);
        let cap: number, sdkEstimatedInputTokens: number;
        try {
          sdkEstimatedInputTokens = estimateContextTokens(context).tokens;
          cap = clampMaxTokensToContext(model, context, requestedMaxTokens);
        } catch { throw fail('Final validation SDK context estimate failed'); }
        if (!Number.isSafeInteger(sdkEstimatedInputTokens) || sdkEstimatedInputTokens < 0 || !positiveInteger(cap) || cap > requestedMaxTokens) {
          throw fail('Final validation SDK context estimate is invalid');
        }
        if (compaction) { compactionForwards += 1; compactionOutputRemaining -= cap; }
        else if (recoveryActive) recoveryForwards += 1;
        else extraForwards += 1;
        outputRemaining -= cap;
        if (options.onForward) {
          try { await awaitHost(Promise.resolve().then(() => options.onForward!({
            phase: compaction ? 'context_compaction' : recoveryActive ? 'source_recovery' : 'report_correction',
            forward: compaction ? compactionForwards : recoveryActive ? recoveryForwards : extraForwards,
            maxForwards: compaction ? boundedCompaction!.maxForwards : recoveryActive ? maxRecoveryForwards! : maxForwards,
            maxTokens: cap, remainingOutputTokens: outputRemaining,
            requestedMaxTokens, localContextWindow: positiveInteger(model.contextWindow) ? model.contextWindow : null,
            sdkEstimatedInputTokens, capSource: 'sdk_context_estimate',
          }))); } catch { throw fail('Final validation forward budget receipt failed'); }
        }
        guard();
        const requestRemaining = remainingTimeout();
        // Keep the last bounded report forward for a final answer. Earlier
        // correction forwards can collect evidence; the last request advertises
        // no tools so it cannot spend the answer slot on another log/read.
        // beforeTool still rejects a provider that emits an unsolicited call.
        const finalAnswerOnly = !compaction && !recoveryActive && extraForwards === maxForwards;
        const stream = await streamFn({ ...model, maxTokens: cap }, finalAnswerOnly ? { ...context, tools: [] } : context, { ...streamOptions, maxTokens: cap,
          ...(finalAnswerOnly ? { toolChoice: 'none' as const } : {}),
          timeoutMs: Math.min(requestRemaining!, positiveInteger(streamOptions?.timeoutMs) ? streamOptions.timeoutMs : requestRemaining!) });
        if (compaction) {
          // Preserve first-event timing while withholding only the terminal
          // receipt. A partial/tool summary must not become SDK context state.
          const output = createAssistantMessageEventStream();
          void (async () => {
            try {
              const iterator = stream[Symbol.asyncIterator]();
              for (;;) {
                const next = await awaitHost(iterator.next());
                if (next.done) break;
                if (next.value.type !== 'done' && next.value.type !== 'error') output.push(next.value);
              }
              const result = await awaitHost(stream.result());
              if (result.stopReason !== 'stop' || result.content.some(block => block.type === 'toolCall') ||
                !result.content.some(block => block.type === 'text' && block.text.trim())) throw fail('Final validation context compaction result is invalid');
              output.push({ type: 'done', reason: 'stop', message: result }); output.end(result);
            } catch (error) {
              if (!failure && !input.signal.aborted) fail(error instanceof Error ? error.message : 'Final validation context compaction stream failed');
              const result = { role: 'assistant' as const, content: [], api: model.api, provider: model.provider, model: model.id,
                timestamp: Date.now(), stopReason: input.signal.aborted ? 'aborted' as const : 'error' as const,
                errorMessage: failure ?? (error instanceof Error ? error.message : 'Final validation context compaction stream failed'),
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
              output.push({ type: 'error', reason: result.stopReason, error: result }); output.end(result);
            }
          })();
          return output;
        }
        return stream;
      };
    },
    async beforeTool(name: string, params: unknown) {
      if (!options) return;
      guard();
      if (approved) throw fail('Final validation cannot dispatch tools after approving its final candidate');
      if (recoveryActive && sourceRecovery) {
        let allowed: boolean;
        try { allowed = sourceRecovery.isToolAllowed(name, params); }
        catch { throw fail('Final validation source recovery tool policy failed'); }
        if (typeof allowed !== 'boolean') throw fail('Final validation source recovery tool policy failed');
        if (!allowed) {
          let detail: string | void = undefined;
          if (sourceRecovery.onToolDenied) {
            try { detail = await awaitHost(Promise.resolve().then(() => sourceRecovery.onToolDenied!({ name, input: params }))); }
            catch { throw fail('Final validation source recovery denial receipt failed'); }
            if (detail !== undefined && (typeof detail !== 'string' || detail.length > 4000)) {
              throw fail('Final validation source recovery denial feedback is invalid');
            }
          }
          guard();
          // A rejected request is a tool error, so the model can correct it in
          // the same finite episode. Only policy/lease/budget failures terminate
          // the runtime. The rejected tool never reaches its execute function.
          throw new Error(`Tool denied during source recovery: ${name}. Only the host's currently admitted required-source reads are allowed.${detail ? `\n${detail}` : ''}`);
        }
      } else if (corrections && extraForwards >= maxForwards) throw fail('Final validation correction has no forward budget after this tool');
    },
    assertValidated() {
      if (!options) return;
      guard();
      if (!approved || pending) throw fail('Final validation did not approve a unique final candidate');
    },
    get finalCandidate(): AgentMessage | undefined { return approved ? { ...approved } : undefined; },
    dispose() { requestPurpose = undefined; releasePreparedAssistant(); if (deadlineTimer !== undefined) clearTimeout(deadlineTimer); },
  };
}
