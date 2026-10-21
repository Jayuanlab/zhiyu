import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
  type AgentHarnessTool,
  type AgentLane,
} from '@earendil-works/pi-agent-core';
import {
  createModels,
  createProvider,
  createAssistantMessageEventStream,
  type ProviderStreams,
  type Context as PiContext,
  type AssistantMessageEvent,
} from '@earendil-works/pi-ai';
import type { AgentMessage, AgentRuntimeTerminal } from '../types';
import {
  mapPiEvent,
  type PiAgentRuntimeAdapterOptions,
} from './pi-agent-adapter';
import type { AgentRuntime, AgentRuntimeRequest } from './types';
import { createPiStreamDiagnostics, observePiStreamFn } from './pi-stream-diagnostics';
import { createHostReadonlyContinuation } from './host-readonly-continuation';
import { createHostFinalValidation } from './host-final-validation';
import { preparePiConversationHistory } from './pi-conversation-history';
import { createHostWorkingMemory } from './host-working-memory';
import { admitPiProviderTerminal } from './pi-provider-terminal';
import { createProviderStreamRecovery } from './provider-stream-recovery';
import { createHostReportReserve } from './host-report-reserve';

/** Run-local SDK state. Durable business state and fencing remain host-owned. */
export class PiHarnessRuntimeAdapter implements AgentRuntime {
  readonly metadata;
  private readonly pending = new Map<
    string,
    { cancel: () => void; settled: Promise<void> }
  >();

  constructor(private readonly options: PiAgentRuntimeAdapterOptions) {
    this.metadata = {
      engine: 'pi' as const,
      adapter: 'pi-agent-harness',
      version: options.version ?? '0.85.1',
    };
  }

  async *run(request: AgentRuntimeRequest): AsyncGenerator<AgentMessage> {
    if (request.operation !== 'run') {
      yield {
        type: 'error',
        message: `Pi runtime does not support ${request.operation} yet`,
      };
      yield { type: 'runtime_terminal', runtimeTerminal: {
        schemaVersion: 'agent-runtime-terminal.v1', status: 'failed',
        cleanupStatus: 'completed', error: 'Unsupported operation',
      } };
      yield { type: 'done' };
      return;
    }
    const sessionId = request.options?.sessionId;
    if (sessionId && this.pending.has(sessionId)) {
      yield { type: 'error', message: 'Pi session already has an active run' };
      yield { type: 'runtime_terminal', runtimeTerminal: {
        schemaVersion: 'agent-runtime-terminal.v1', status: 'failed',
        cleanupStatus: 'completed', error: 'Pi session already has an active run',
      } };
      yield { type: 'done' };
      return;
    }
    const controller = new AbortController();
    const diagnostics = createPiStreamDiagnostics(controller.signal);
    const continuation = createHostReadonlyContinuation({ options: request.options?.hostReadonlyContinuation,
      signal: controller.signal, timeoutMs: this.options.streamOptions?.timeoutMs,
      toolNames: (this.options.tools ?? []).map(tool => tool.name) });
    const externalSignal = request.options?.abortController?.signal;
    const queue: AgentMessage[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    let lane: AgentLane | undefined;
    let operationId: string | undefined;
    let abortWork: Promise<unknown> | undefined;
    let outcomeStatus: AgentRuntimeTerminal['status'] = 'failed';
    let cleanupStatus: AgentRuntimeTerminal['cleanupStatus'] = 'completed';
    let terminalError: string | undefined;
    let userAborted = false;
    let internalFailure: string | undefined;
    const isUserCancelled = () => userAborted || externalSignal?.aborted === true;
    const push = (...messages: AgentMessage[]) => {
      const snapshot = messages.some(message => message.type === 'error') ? diagnostics.snapshot() : undefined;
      queue.push(...messages.map(message => message.type === 'error'
        ? { ...message, ...(snapshot ? { providerStreamDiagnostics: snapshot } : {}) }
        : message));
      wake?.();
      wake = undefined;
    };
    const requestCancellation = () => {
      controller.abort();
      if (lane && operationId && !abortWork) {
        abortWork = lane
          .requestAbort(operationId, BACKGROUND_CONTEXT)
          .catch((error) => {
            cleanupStatus = 'failed';
            terminalError = `Pi cancellation failed: ${String(error)}`;
            push({
              type: 'error',
              message: `Pi cancellation failed: ${String(error)}`,
            });
          });
      }
    };
    const cancel = () => { userAborted = true; requestCancellation(); };
    const failHost = (error: unknown) => {
      internalFailure ??= error instanceof Error ? error.message : String(error);
      requestCancellation();
    };
    const workingMemory = createHostWorkingMemory({ options: request.options?.hostWorkingMemory,
      signal: controller.signal, onFailure: failHost });
    const reportReserve=createHostReportReserve(request.options?.hostReportReserve,controller.signal);
    const finalValidation = createHostFinalValidation({ options: request.options?.hostFinalValidation,
      signal: controller.signal, timeoutMs: this.options.streamOptions?.timeoutMs,
      conflictsWithReadonly: continuation.enabled, onFailure: failHost,
      getWorkingMemorySnapshot: () => workingMemory.enabled ? structuredClone(workingMemory.snapshot()) : undefined,
      onApproved: async text => {
        const progress = request.options?.hostFinalValidation?.progressFromValidatedReport?.(text);
        if (!progress || !workingMemory.enabled) return;
        await workingMemory.commitReportProgress({text,...progress},async command => {
          const id=String(command.commandId);
          await request.options?.onBeforeToolUse?.({toolName:'workingMemory',toolUseId:id,input:command});
          controller.signal.throwIfAborted();
          const permission=await request.options?.onPermissionRequest?.({toolName:'workingMemory',toolInput:command,toolUseID:id});
          if (permission?.behavior==='deny') throw Error(permission.message??'Working memory progress commit denied');
          if (permission?.updatedInput && JSON.stringify(permission.updatedInput)!==JSON.stringify(command)) {
            throw Error('Validated progress cannot be rewritten by a permission response');
          }
          controller.signal.throwIfAborted();
        });
      },
      onIntermediate: message => push(message) });
    externalSignal?.addEventListener('abort', cancel, { once: true });
    if (externalSignal?.aborted) cancel();

    const run = async () => {
      const repo = new MemorySessionRepo();
      let harness: AgentHarness | undefined;
      const unsubscribers: (() => void)[] = [];
      try {
        controller.signal.throwIfAborted();
        finalValidation.assertReady();
        workingMemory.assertReady();
        if (workingMemory.enabled && this.options.tools?.some(tool => tool.name === workingMemory.tool.name)) {
          throw new Error('Working memory tool conflicts with a registered business tool');
        }
        const history = preparePiConversationHistory(request.options?.conversation, this.options.model);
        const runModel = { ...this.options.model };
        // A single instance covers every logical request in this Harness run.
        // Physical recovery stays below context projection and SDK parsing.
        const transport = createProviderStreamRecovery({ model: runModel,
          options: request.options?.hostProviderRecovery, controllerSignal: controller.signal });
        const configuredStream: PiAgentRuntimeAdapterOptions['streamFn'] = async (model, context, options) => {
          controller.signal.throwIfAborted();
          try { await request.options?.onBeforeProviderRequest?.(); }
          catch (error) { failHost(error); throw error; }
          controller.signal.throwIfAborted();
          return transport.enabled ? this.options.streamFn(model, context, { ...options, maxRetries: 0,
            fetch: transport.wrapFetch(options?.fetch ?? globalThis.fetch) }) : this.options.streamFn(model, context, options);
        };
        const models = createModels();
        // Credentials, endpoint and compatibility options stay in the host's
        // configured streamFn. Never fall back to global SDK credentials.
        // The final provider fence repeats the projection even if an SDK hook
        // fails. Diagnostics see the actual prepared context, never the raw
        // transcript masquerading as a smaller provider request.
        const admittedStream = reportReserve.wrapStream(finalValidation.wrapStream(
          continuation.wrapStream(workingMemory.wrapStream(
            observePiStreamFn(configuredStream, controller.signal, diagnostics))),
        ));
        // ProviderStreams is synchronous; host admission and durable audit are
        // asynchronous. Keep that boundary explicit without casting a Promise
        // to the SDK event stream or recording raw input as provider input.
        const stream: ProviderStreams['streamSimple'] = (model, context, options) => {
          const output = createAssistantMessageEventStream();
          void (async () => {
            try {
              controller.signal.throwIfAborted();
              const started = performance.now();
              const source = await admittedStream(model, context, options);
              const terminalEvents: AssistantMessageEvent[] = [];
              for await (const event of source) {
                if (event.type === 'done' || event.type === 'error') terminalEvents.push(event);
                else output.push(event);
              }
              const result = await source.result();
              await workingMemory.recordUsage(result, { model: model.id, provider: model.provider,
                elapsedMs: performance.now() - started });
              const admitted = admitPiProviderTerminal(result, {
                boundedLengthRecovery: finalValidation.enabled && !!request.options?.hostFinalValidation?.boundedCompaction,
              });
              if (admitted !== result) {
                // Raw diagnostics and usage above keep the provider's original
                // terminal. Harness receives a failure, never a partial success.
                output.push({ type: 'error', reason: 'error', error: admitted });
              } else {
                for (const event of terminalEvents) output.push(event);
              }
              output.end(admitted);
            } catch (error) {
              const reason = controller.signal.aborted ? 'aborted' : 'error';
              output.push({ type: 'error', reason, error: {
                role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
                timestamp: Date.now(), stopReason: reason,
                errorMessage: error instanceof Error ? error.message : String(error),
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              } });
            }
          })();
          return output;
        };
        models.setProvider(
          createProvider({
            id: this.options.model.provider,
            models: [runModel],
            auth: {
              apiKey: {
                name: 'Host configured stream',
                resolve: async () => ({ auth: {} }),
              },
            },
            api: { stream, streamSimple: stream },
          }),
        );
        const tools: AgentHarnessTool<object | undefined>[] = (
          [...(this.options.tools ?? []), ...(workingMemory.enabled ? [workingMemory.tool] : [])]
        ).map((tool) => ({
          ...tool,
          replay: 'never',
          execute: async (
            id,
            params,
            onUpdate,
            _toolContext,
            _invocation,
            context,
          ) => {
            const signal = context.abortSignal
              ? AbortSignal.any([controller.signal, context.abortSignal])
              : controller.signal;
            signal.throwIfAborted();
            try {
              await request.options?.onBeforeToolUse?.({
                toolUseId: id,
                toolName: tool.name,
                input: params,
              });
            } catch (error) {
              // A lost host fence terminates the run, not merely one tool call.
              failHost(error);
              throw error;
            }
            signal.throwIfAborted();
            await finalValidation.beforeTool(tool.name, params);
            continuation.beforeTool(tool.name, params);
            const permission = await request.options?.onPermissionRequest?.({
              toolName: tool.name, toolInput: params as Record<string, unknown>, toolUseID: id,
            });
            if (permission?.behavior === 'deny') {
              throw new Error(permission.message ?? `Tool denied: ${tool.name}`);
            }
            signal.throwIfAborted();
            const actualParams = permission?.updatedInput ?? params;
            reportReserve.beforeTool(tool.name,actualParams);
            await finalValidation.beforeTool(tool.name, actualParams);
            continuation.beforeTool(tool.name, actualParams, true);
            return tool.execute(id, actualParams, signal, onUpdate);
          },
        }));
        const session = await repo.create({}, BACKGROUND_CONTEXT);
        ({ harness } = await AgentHarness.create(
          {
            session,
            models,
            model: runModel,
            tools,
            systemPrompt: this.options.systemPrompt ?? '',
            streamOptions: this.options.streamOptions,
            thinkingLevel: 'off',
            toolExecution: this.options.toolExecution ?? 'sequential',
            // The host owns retry/compaction policy during the initial rollout.
            retry: { enabled: false, maxRetries: 0, baseDelayMs: 1000 },
            compaction: {
              enabled: false,
              reserveTokens: 16384,
              keepRecentTokens: 20000,
            },
          },
          BACKGROUND_CONTEXT,
        ));
        lane = await harness.lane('main', BACKGROUND_CONTEXT);
        // Seed only this run's explicit text history before current-turn audit
        // hooks. It must neither replay tools nor commit old prompts as new evidence.
        for (const message of history) {
          controller.signal.throwIfAborted();
          await lane.appendMessage(message, BACKGROUND_CONTEXT);
        }
        if (continuation.enabled) unsubscribers.push(
          harness.hooks.on('before_run_end', () => continuation.beforeClose()),
          harness.hooks.on('after_response', ({ message }) => ({ message: continuation.checkResponse(message) })),
        );
        if (finalValidation.enabled) unsubscribers.push(
          harness.hooks.on('before_request', ({ step, model, streamOptions }) => finalValidation.beforeRequest(step, model, streamOptions)),
          harness.hooks.on('before_run_end', () => finalValidation.beforeClose()),
        );
        if (workingMemory.enabled) unsubscribers.push(
          harness.hooks.on('transform_context', ({ messages, systemPrompt }) => {
            const projected = workingMemory.projectContext({ systemPrompt,
              messages: messages as PiContext['messages'] });
            return { messages: projected.messages };
          }),
        );
        unsubscribers.push(
          harness.events.on('entry_added', async (e) => {
            if (e.entry.type !== 'message') return;
            if (e.entry.message.role === 'user' && request.options?.onPromptContextCommitted) {
              const content = e.entry.message.content;
              const modelText = typeof content === 'string' ? content
                : content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('\n');
              await request.options.onPromptContextCommitted({ entryId: e.entry.id, modelText });
            }
            if (!request.options?.onToolContextCommitted || e.entry.message.role !== 'toolResult' || e.entry.message.isError ||
              e.entry.message.toolName === workingMemory.tool.name) return;
            await request.options.onToolContextCommitted({
              toolCallId: e.entry.message.toolCallId,
              entryId: e.entry.id,
              modelText: e.entry.message.content.filter(block => block.type === 'text')
                .map(block => (block as { text: string }).text).join('\n'),
            });
          }),
          harness.events.on('message_update', (e) => {
            if (e.event.type !== 'error')
              push(
                ...mapPiEvent({
                  type: 'message_update',
                  message: e.message,
                  assistantMessageEvent: e.event,
                }),
              );
          }),
          harness.events.on('message_end', (e) => {
            if (
              !(
                e.message.role === 'assistant' &&
                ['error', 'aborted'].includes(e.message.stopReason)
              )
            ) {
              push(...finalValidation.observeEnd(mapPiEvent({ type: 'message_end', message: e.message })));
            }
          }),
          harness.events.on('tool_start', (e) =>
            push(
              ...mapPiEvent({
                type: 'tool_execution_start',
                toolCallId: e.toolCallId,
                toolName: e.toolName,
                args: e.args,
              }),
            ),
          ),
          harness.events.on('tool_end', (e) =>
            push(
              ...mapPiEvent({
                type: 'tool_execution_end',
                toolCallId: e.toolCallId,
                toolName: e.toolName,
                result: e.result,
                isError: e.isError,
              }),
            ),
          ),
          harness.events.on('handler_error', (e) => {
            terminalError = `Pi harness event handler failed: ${String(e.error)}`;
            push({
              type: 'error',
              message: `Pi harness event handler failed: ${String(e.error)}`,
            });
            failHost(terminalError);
          }),
        );
        controller.signal.throwIfAborted();
        const admitted = await lane.accept(
          { kind: 'prompt', prompt: request.prompt },
          BACKGROUND_CONTEXT,
        );
        if (!admitted.ok) throw admitted.error;
        operationId = admitted.value.operationId;
        if (controller.signal.aborted) {
          requestCancellation();
          await abortWork;
        }
        const result = await lane.drive({ operationId }, BACKGROUND_CONTEXT);
        if (!result.ok) throw result.error;
        if (result.value.kind !== 'settled')
          throw new Error('Pi run unexpectedly suspended');
        const outcome = result.value.outcome;
        if (continuation.failure) throw new Error(continuation.failure);
        if (finalValidation.failure) throw new Error(finalValidation.failure);
        if (workingMemory.failure) throw new Error(workingMemory.failure);
        if (outcome.status !== 'completed')
          throw new Error(outcome.error?.message ?? `Pi run ${outcome.status}`);
        finalValidation.assertValidated();
        outcomeStatus = 'completed';
      } catch (error) {
        outcomeStatus = isUserCancelled() ? 'aborted' : 'failed';
        terminalError = internalFailure ?? (error instanceof Error ? error.message : String(error));
        push({
          type: 'error',
          message: terminalError,
        });
      } finally {
        try {
          await abortWork;
          await harness?.close(BACKGROUND_CONTEXT);
        } catch (error) {
          cleanupStatus = 'failed';
          terminalError = `Pi cleanup failed: ${String(error)}`;
          push({
            type: 'error',
            message: `Pi cleanup failed: ${String(error)}`,
          });
        } finally {
          for (const unsubscribe of unsubscribers) {
            try { unsubscribe(); } catch (error) {
              cleanupStatus = 'failed';
              terminalError = `Pi unsubscribe failed: ${String(error)}`;
              push({ type: 'error', message: terminalError });
            }
          }
          try { await repo.close(BACKGROUND_CONTEXT); } catch (error) {
            cleanupStatus = 'failed';
            terminalError = `Pi repository cleanup failed: ${String(error)}`;
            push({ type: 'error', message: terminalError });
          }
        }
      }
    };
    // Reserve the session synchronously before any asynchronous initialization.
    const settled = Promise.resolve()
      .then(run)
      .catch((error) => {
        outcomeStatus = isUserCancelled() ? 'aborted' : 'failed';
        terminalError = internalFailure ?? String(error);
        push({ type: 'error', message: terminalError });
      })
      .finally(() => {
        finalValidation.dispose();
        externalSignal?.removeEventListener('abort', cancel);
        if (sessionId) this.pending.delete(sessionId);
        finished = true;
        if (finalValidation.enabled && !isUserCancelled() && !internalFailure &&
          cleanupStatus === 'completed' && outcomeStatus === 'completed' && !finalValidation.failure) {
          const candidate = finalValidation.finalCandidate;
          if (candidate) push(candidate);
        }
        push({ type: 'runtime_terminal', runtimeTerminal: {
          schemaVersion: 'agent-runtime-terminal.v1',
          status: isUserCancelled() ? 'aborted'
            : internalFailure || cleanupStatus === 'failed' ? 'failed' : outcomeStatus,
          cleanupStatus,
          completionScope: 'runtime',
          ...(operationId ? { operationId } : {}),
          ...(terminalError ? { error: terminalError } : {}),
        }, ...(diagnostics.snapshot() ? { providerStreamDiagnostics: diagnostics.snapshot() } : {}) });
        push({ type: 'done' });
      });
    if (sessionId) this.pending.set(sessionId, { cancel, settled });
    try {
      while (!finished || queue.length) {
        const next = queue.shift();
        if (next) yield next;
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    } finally {
      if (!finished) cancel();
      await settled;
    }
  }

  async stop(sessionId: string): Promise<void> {
    const pending = this.pending.get(sessionId);
    pending?.cancel();
    await pending?.settled;
  }

  getPlan(_planId: string): undefined {
    return undefined;
  }
  deletePlan(_planId: string): void {}
}
