import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
import {
  createPiRuntimeOptionsFromModelConfig,
  type PiModelRuntimeConfig,
} from './pi-model-config';
import { admitPiProviderTerminal } from './pi-provider-terminal';

/** AI SDK callers and the Pi agent use the same installed Pi serializers.
 * This adapter transports model/tool messages; it never executes a tool.
 */
export function createPiLanguageModel(
  config: PiModelRuntimeConfig,
  transport?: typeof fetch,
): LanguageModelV2 {
  const runtime = createPiRuntimeOptionsFromModelConfig(config);
  const usage = (message: any) => ({
    inputTokens: message.usage?.input,
    outputTokens: message.usage?.output,
    totalTokens: message.usage?.totalTokens,
    cachedInputTokens: message.usage?.cacheRead,
  });
  const finish = (message: any) =>
    message.stopReason === 'toolUse'
      ? ('tool-calls' as const)
      : message.stopReason === 'length'
        ? ('length' as const)
        : ('stop' as const);
  const admit = (message: any) => {
    const admitted = admitPiProviderTerminal(message);
    if (!['stop', 'toolUse'].includes(admitted.stopReason))
      throw new Error(
        admitted.stopReason === 'aborted'
          ? 'pi_model_request_aborted'
          : 'pi_model_request_failed',
      );
    return admitted;
  };
  const prepare = (options: LanguageModelV2CallOptions) => {
    const system: string[] = [],
      messages: any[] = [];
    for (const message of options.prompt) {
      if (message.role === 'system') {
        system.push(message.content);
        continue;
      }
      if (message.role === 'tool') {
        for (const part of message.content) {
          const output = part.output as any;
          messages.push({
            role: 'toolResult',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            content: [
              {
                type: 'text',
                text:
                  typeof output.value === 'string'
                    ? output.value
                    : JSON.stringify(output.value ?? output),
              },
            ],
            isError: output.type?.startsWith('error'),
            timestamp: Date.now(),
          });
        }
        continue;
      }
      const content: any[] = [];
      for (const part of message.content) {
        if (part.type === 'text')
          content.push({ type: 'text', text: part.text });
        else if (part.type === 'reasoning')
          content.push({ type: 'thinking', thinking: part.text });
        else if (part.type === 'tool-call')
          content.push({
            type: 'toolCall',
            id: part.toolCallId,
            name: part.toolName,
            arguments: part.input,
          });
        else if (part.type === 'file') {
          if (!part.mediaType.startsWith('image/') || part.data instanceof URL)
            throw Error('pi_model_unsupported_attachment');
          content.push({
            type: 'image',
            mimeType: part.mediaType,
            data:
              typeof part.data === 'string'
                ? part.data
                : Buffer.from(part.data).toString('base64'),
          });
        }
      }
      messages.push(
        message.role === 'assistant'
          ? {
              role: 'assistant',
              content,
              api: runtime.model.api,
              provider: runtime.model.provider,
              model: runtime.model.id,
              stopReason: content.some((p) => p.type === 'toolCall')
                ? 'toolUse'
                : 'stop',
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
              timestamp: Date.now(),
            }
          : { role: 'user', content, timestamp: Date.now() },
      );
    }
    if (options.responseFormat?.type === 'json')
      system.push(
        'Respond with valid JSON only.' +
          (options.responseFormat.schema
            ? ` Required JSON schema: ${JSON.stringify(options.responseFormat.schema)}`
            : ''),
      );
    const tools = options.tools?.map((tool) => {
      if (tool.type !== 'function')
        throw Error('pi_model_provider_tool_unsupported');
      return {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.inputSchema,
      };
    });
    if (
      options.toolChoice?.type === 'tool' ||
      options.toolChoice?.type === 'required'
    )
      throw Error('pi_model_tool_choice_unsupported');
    return {
      systemPrompt: system.join('\n\n'),
      messages,
      ...(tools?.length ? { tools } : {}),
    };
  };
  const source = async (
    options: LanguageModelV2CallOptions,
    signal = options.abortSignal,
  ) =>
    await runtime.streamFn(runtime.model, prepare(options), {
      signal,
      maxTokens: options.maxOutputTokens,
      temperature: options.temperature,
      toolChoice: options.toolChoice?.type === 'none' ? 'none' : 'auto',
      ...(transport ? { fetch: transport } : {}),
      maxRetries: 0,
    });
  return {
    specificationVersion: 'v2',
    provider: 'zhiyu-pi',
    modelId: config.model,
    supportedUrls: {},
    async doGenerate(options) {
      const stream = await source(options);
      for await (const _event of stream) {
      }
      const message = admit(await stream.result());
      const content = message.content.flatMap<LanguageModelV2Content>(
        (part: any) =>
          part.type === 'text'
            ? [{ type: 'text' as const, text: part.text }]
            : part.type === 'thinking'
              ? [{ type: 'reasoning' as const, text: part.thinking }]
              : part.type === 'toolCall'
                ? [
                    {
                      type: 'tool-call' as const,
                      toolCallId: part.id,
                      toolName: part.name,
                      input: JSON.stringify(part.arguments),
                    },
                  ]
                : [],
      );
      return {
        content,
        finishReason: finish(message),
        usage: usage(message),
        warnings: [],
        response: {
          modelId: message.model,
          timestamp: new Date(message.timestamp),
        },
      };
    },
    async doStream(options) {
      const controller = new AbortController(),
        signal = options.abortSignal
          ? AbortSignal.any([options.abortSignal, controller.signal])
          : controller.signal;
      const stream = new ReadableStream<LanguageModelV2StreamPart>({
        async start(output) {
          output.enqueue({ type: 'stream-start', warnings: [] });
          try {
            const events = await source(options, signal);
            for await (const event of events) {
              const item = event as any,
                id = String(item.contentIndex ?? 0);
              if (item.type === 'text_start')
                output.enqueue({ type: 'text-start', id });
              else if (item.type === 'text_delta')
                output.enqueue({ type: 'text-delta', id, delta: item.delta });
              else if (item.type === 'text_end')
                output.enqueue({ type: 'text-end', id });
              else if (item.type === 'thinking_start')
                output.enqueue({ type: 'reasoning-start', id });
              else if (item.type === 'thinking_delta')
                output.enqueue({
                  type: 'reasoning-delta',
                  id,
                  delta: item.delta,
                });
              else if (item.type === 'thinking_end')
                output.enqueue({ type: 'reasoning-end', id });
            }
            const result = admit(await events.result());
            for (const part of result.content)
              if (part.type === 'toolCall')
                output.enqueue({
                  type: 'tool-call',
                  toolCallId: part.id,
                  toolName: part.name,
                  input: JSON.stringify(part.arguments),
                });
            output.enqueue({
              type: 'finish',
              finishReason: finish(result),
              usage: usage(result),
            });
            output.close();
          } catch {
            output.error(
              new Error(
                signal.aborted
                  ? 'pi_model_request_aborted'
                  : 'pi_model_request_failed',
              ),
            );
          }
        },
        cancel() {
          controller.abort();
        },
      });
      return { stream };
    },
  };
}
