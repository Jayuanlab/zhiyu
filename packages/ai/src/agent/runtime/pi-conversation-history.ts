import type { AssistantMessage, Model, UserMessage } from '@earendil-works/pi-ai';
import { estimateTokens } from '../billing/tokens';
import type { ConversationMessage } from '../types';

const MAX_HISTORY_TOKENS = 40_000;

/** Explicit host history is run-local text context, never tool execution or system authority. */
export function preparePiConversationHistory(
  conversation: ConversationMessage[] | undefined,
  model: Model<any>,
): Array<UserMessage | AssistantMessage> {
  if (conversation === undefined) return [];
  if (!Array.isArray(conversation)) throw new Error('Invalid Pi conversation history.');
  let tokens = 0;
  for (const message of conversation) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string') {
      throw new Error('Pi conversation history must contain user or assistant text messages.');
    }
    tokens += estimateTokens(message.content) + 4;
    if (tokens > MAX_HISTORY_TOKENS) {
      throw new Error('Pi conversation history exceeds the 40000-token budget. Shorten the conversation before retrying; history was not truncated.');
    }
  }
  const firstTimestamp = Date.now() - conversation.length;
  return conversation.map((message, index) => {
    const timestamp = firstTimestamp + index;
    if (message.role === 'user') return { role: 'user', content: message.content, timestamp };
    // SDK fields describe this text projection. Historical tool calls, usage and
    // provider-native signatures are unavailable and must not be reconstructed.
    return {
      role: 'assistant', content: [{ type: 'text', text: message.content }],
      api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp,
    };
  });
}
