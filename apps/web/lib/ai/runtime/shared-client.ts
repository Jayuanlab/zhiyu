/**
 * Client callers use the authenticated Pi host; no agent engine or provider
 * credentials are instantiated in the browser.
 */
import { streamNativeAgentResponse } from '@/lib/ai/router/index';
import { formatAgentStreamErrorForUser } from './format-error';
import type { HandleAgentRuntimeOptions } from './shared';
export type { HandleAgentRuntimeOptions } from './shared';
export async function handleAgentRuntime(
  prompt: string,
  options: HandleAgentRuntimeOptions,
  replyCallback: (message: string) => Promise<void>,
  platform:
    | 'telegram'
    | 'whatsapp'
    | 'imessage'
    | 'feishu'
    | 'dingtalk'
    | 'qqbot'
    | 'weixin',
): Promise<void> {
  let candidate = '',
    terminal: any,
    failed: Error | undefined;
  try {
    if (options.modelConfig?.apiKey || options.modelConfig?.baseUrl)
      throw Error('model_connection_override_denied');
    await new Promise<void>((resolve, reject) => {
      void streamNativeAgentResponse(prompt, {
        provider: 'pi',
        conversation: options.conversation
          ?.filter((message) => message.role !== 'system')
          .map((message) => ({
            role: message.role as 'user' | 'assistant',
            content: message.content,
          })),
        modelConfig: options.modelConfig?.model
          ? { model: options.modelConfig.model }
          : undefined,
        workDir: options.workDir,
        loopIdForGuard: options.loopIdForGuard,
        onAbortFnReady: (abort) => {
          if (options.abortController?.signal.aborted) abort();
          else
            options.abortController?.signal.addEventListener('abort', abort, {
              once: true,
            });
        },
        onUpdate: (message) => {
          if (
            message.type === 'result' &&
            message.answerPhase !== 'intermediate'
          )
            candidate = message.content ?? '';
          if (message.type === 'runtime_terminal')
            terminal = message.runtimeTerminal;
          if (message.type === 'error')
            failed = Error(message.message ?? 'pi_runtime_failed');
        },
        onDone: resolve,
        onError: reject,
      }).catch(reject);
    });
    if (failed) throw failed;
    if (
      terminal?.status !== 'completed' ||
      terminal.cleanupStatus !== 'completed' ||
      !candidate.trim()
    )
      throw Error('pi_delivery_unconfirmed');
    for (let offset = 0; offset < candidate.length; offset += 4000)
      await replyCallback(candidate.slice(offset, offset + 4000));
  } catch (error) {
    await replyCallback(
      formatAgentStreamErrorForUser(
        platform,
        error instanceof Error ? error.message : 'pi_runtime_failed',
      ),
    );
  }
}
