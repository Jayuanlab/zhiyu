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
} from '@earendil-works/pi-ai';
import type { AgentMessage } from '../types';
import {
  mapPiEvent,
  type PiAgentRuntimeAdapterOptions,
} from './pi-agent-adapter';
import type { AgentRuntime, AgentRuntimeRequest } from './types';

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
      yield { type: 'done' };
      return;
    }
    const sessionId = request.options?.sessionId;
    if (sessionId && this.pending.has(sessionId)) {
      yield { type: 'error', message: 'Pi session already has an active run' };
      yield { type: 'done' };
      return;
    }
    const controller = new AbortController();
    const externalSignal = request.options?.abortController?.signal;
    const queue: AgentMessage[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    let lane: AgentLane | undefined;
    let operationId: string | undefined;
    let abortWork: Promise<unknown> | undefined;
    const push = (...messages: AgentMessage[]) => {
      queue.push(...messages);
      wake?.();
      wake = undefined;
    };
    const cancel = () => {
      controller.abort();
      if (lane && operationId && !abortWork) {
        abortWork = lane
          .requestAbort(operationId, BACKGROUND_CONTEXT)
          .catch((error) => {
            push({
              type: 'error',
              message: `Pi cancellation failed: ${String(error)}`,
            });
          });
      }
    };
    externalSignal?.addEventListener('abort', cancel, { once: true });
    if (externalSignal?.aborted) cancel();

    const run = async () => {
      const repo = new MemorySessionRepo();
      let harness: AgentHarness | undefined;
      const unsubscribers: (() => void)[] = [];
      try {
        controller.signal.throwIfAborted();
        const models = createModels();
        // Credentials, endpoint and compatibility options stay in the host's
        // configured streamFn. Never fall back to global SDK credentials.
        const stream: ProviderStreams['streamSimple'] = (
          model,
          context,
          options,
        ) => {
          const output = createAssistantMessageEventStream();
          void (async () => {
            try {
              controller.signal.throwIfAborted();
              const signal = options?.signal
                ? AbortSignal.any([controller.signal, options.signal])
                : controller.signal;
              const source = await this.options.streamFn(model, context, {
                ...options,
                signal,
              });
              for await (const event of source) output.push(event);
              output.end(await source.result());
            } catch (error) {
              output.push({
                type: 'error',
                reason: controller.signal.aborted ? 'aborted' : 'error',
                error: {
                  role: 'assistant',
                  content: [],
                  api: model.api,
                  provider: model.provider,
                  model: model.id,
                  timestamp: Date.now(),
                  stopReason: controller.signal.aborted ? 'aborted' : 'error',
                  errorMessage:
                    error instanceof Error ? error.message : String(error),
                  usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: {
                      input: 0,
                      output: 0,
                      cacheRead: 0,
                      cacheWrite: 0,
                      total: 0,
                    },
                  },
                },
              });
            }
          })();
          return output;
        };
        models.setProvider(
          createProvider({
            id: this.options.model.provider,
            models: [this.options.model],
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
          this.options.tools ?? []
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
              cancel();
              throw error;
            }
            signal.throwIfAborted();
            const permission = await request.options?.onPermissionRequest?.({
              toolName: tool.name, toolInput: params as Record<string, unknown>, toolUseID: id,
            });
            if (permission?.behavior === 'deny') {
              throw new Error(permission.message ?? `Tool denied: ${tool.name}`);
            }
            signal.throwIfAborted();
            return tool.execute(id, permission?.updatedInput ?? params, signal, onUpdate);
          },
        }));
        const session = await repo.create({}, BACKGROUND_CONTEXT);
        ({ harness } = await AgentHarness.create(
          {
            session,
            models,
            model: this.options.model,
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
        unsubscribers.push(
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
              push(...mapPiEvent({ type: 'message_end', message: e.message }));
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
            push({
              type: 'error',
              message: `Pi harness event handler failed: ${String(e.error)}`,
            });
            cancel();
          }),
        );
        lane = await harness.lane('main', BACKGROUND_CONTEXT);
        controller.signal.throwIfAborted();
        const admitted = await lane.accept(
          { kind: 'prompt', prompt: request.prompt },
          BACKGROUND_CONTEXT,
        );
        if (!admitted.ok) throw admitted.error;
        operationId = admitted.value.operationId;
        if (controller.signal.aborted) {
          cancel();
          await abortWork;
        }
        const result = await lane.drive({ operationId }, BACKGROUND_CONTEXT);
        if (!result.ok) throw result.error;
        if (result.value.kind !== 'settled')
          throw new Error('Pi run unexpectedly suspended');
        const outcome = result.value.outcome;
        if (outcome.status !== 'completed')
          throw new Error(outcome.error?.message ?? `Pi run ${outcome.status}`);
      } catch (error) {
        push({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        try {
          await abortWork;
          await harness?.close(BACKGROUND_CONTEXT);
        } catch (error) {
          push({
            type: 'error',
            message: `Pi cleanup failed: ${String(error)}`,
          });
        } finally {
          for (const unsubscribe of unsubscribers) unsubscribe();
          await repo.close(BACKGROUND_CONTEXT);
        }
      }
    };
    // Reserve the session synchronously before any asynchronous initialization.
    const settled = Promise.resolve()
      .then(run)
      .catch((error) => {
        push({ type: 'error', message: String(error) });
      })
      .finally(() => {
        externalSignal?.removeEventListener('abort', cancel);
        if (sessionId) this.pending.delete(sessionId);
        finished = true;
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
