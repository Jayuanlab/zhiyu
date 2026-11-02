import { auth } from '@/app/(auth)/auth';
import {
  loadModelConfiguration,
  createTextModelFromConfiguration,
} from '@/lib/ai/model-configuration';
import { assertModelSelectionOnly } from '@openzhiyu/shared/model-configuration';
import { generateText, streamText } from 'ai';
import { z } from 'zod';
export const runtime = 'nodejs';
const schema = z
  .object({
    model: z.string().max(256).optional(),
    system: z.string().optional(),
    messages: z
      .array(
        z.object({
          role: z.enum(['system', 'user', 'assistant']),
          content: z.union([z.string(), z.array(z.unknown())]),
        }),
      )
      .min(1),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    max_tokens: z.number().int().min(1).max(65536).optional(),
    max_completion_tokens: z.number().int().min(1).max(65536).optional(),
    purpose: z.enum(['text', 'conversation_compaction']).optional(),
    response_format: z.object({ type: z.string() }).passthrough().optional(),
  })
  .passthrough();
function promptMessages(messages: z.infer<typeof schema>['messages']) {
  return messages.map((message) => ({
    role: message.role,
    content: Array.isArray(message.content)
      ? message.content.map((raw: any) =>
          raw?.type === 'image_url'
            ? { type: 'image', image: new URL(raw.image_url.url) }
            : raw?.type === 'text'
              ? { type: 'text', text: String(raw.text) }
              : (() => {
                  throw Error('unsupported_message_part');
                })(),
        )
      : message.content,
  }));
}
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id)
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const raw = await request.json();
    assertModelSelectionOnly(raw);
    const body = schema.parse(raw);
    if (body.tools || body.tool_choice || body.functions)
      return Response.json(
        { error: 'proxy_tools_require_pi_agent_runtime' },
        { status: 400 },
      );
    const config = await loadModelConfiguration({
      userId: session.user.id,
      purpose: body.purpose ?? 'text',
      modelOverride: body.model,
    });
    if (!config)
      return Response.json({ error: 'model_not_configured' }, { status: 400 });
    const messages = promptMessages(body.messages),
      signal = AbortSignal.any([request.signal, AbortSignal.timeout(120000)]);
    const options = {
      model: createTextModelFromConfiguration(config),
      messages: messages as any,
      system:
        [
          body.system,
          body.response_format?.type === 'json_object'
            ? 'Return valid JSON only.'
            : undefined,
        ]
          .filter(Boolean)
          .join('\n') || undefined,
      temperature: body.temperature,
      maxOutputTokens: body.max_completion_tokens ?? body.max_tokens,
      abortSignal: signal,
      maxRetries: 0,
    };
    const id = `chatcmpl-${crypto.randomUUID()}`,
      created = Math.floor(Date.now() / 1000),
      headers = {
        'Cache-Control': 'no-store',
        'X-Zhiyu-Model-Revision': config.revision ?? 'deployment',
      };
    if (!body.stream) {
      const result = await generateText(options);
      if (result.finishReason !== 'stop' || !result.text.trim())
        throw Error('model_response_incomplete');
      return Response.json(
        {
          id,
          object: 'chat.completion',
          created,
          model: config.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: result.text },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: result.usage.inputTokens,
            completion_tokens: result.usage.outputTokens,
            total_tokens: result.usage.totalTokens,
          },
        },
        { headers },
      );
    }
    const result = streamText(options),
      encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(output) {
        const send = (value: unknown) =>
          output.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
        try {
          for await (const part of result.fullStream) {
            if (part.type === 'text')
              send({
                id,
                object: 'chat.completion.chunk',
                created,
                model: config.model,
                choices: [
                  {
                    index: 0,
                    delta: { content: part.text },
                    finish_reason: null,
                  },
                ],
              });
            else if (part.type === 'error') throw Error('model_stream_failed');
            else if (part.type === 'finish') {
              if (part.finishReason !== 'stop')
                throw Error('model_response_incomplete');
              send({
                id,
                object: 'chat.completion.chunk',
                created,
                model: config.model,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              });
            }
          }
          output.enqueue(encoder.encode('data: [DONE]\n\n'));
          output.close();
        } catch {
          send({
            error: { message: 'model_stream_failed', type: 'provider_error' },
          });
          output.close();
        }
      },
    });
    return new Response(stream, {
      headers: { ...headers, 'Content-Type': 'text/event-stream' },
    });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return Response.json({ error: 'invalid_model_request' }, { status: 400 });
    const code =
      error instanceof Error &&
      /^(model_|pi_model_|unsupported_message_part)/.test(error.message)
        ? error.message.split(':')[0]
        : 'model_request_failed';
    return Response.json({ error: code }, { status: 400 });
  }
}
