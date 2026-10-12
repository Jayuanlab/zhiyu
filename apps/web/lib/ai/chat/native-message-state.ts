import type { ChatMessage } from "@openzhiyu/shared";

export function findNativeAssistantIndex(
  messages: readonly ChatMessage[],
  assistantMessageId: string,
): number {
  return messages.findIndex(
    (message) => message.id === assistantMessageId && message.role === "assistant",
  );
}

export function nativeAssistantSnapshot(
  assistantMessageId: string,
  content: string,
  parts: ChatMessage["parts"],
): ChatMessage {
  return {
    id: assistantMessageId,
    role: "assistant",
    content,
    parts: [...parts],
  } as ChatMessage;
}

/** Refresh unchanged history while preserving edits made after this fetch began. */
export function mergeChatHistory(
  baseline: readonly ChatMessage[],
  current: readonly ChatMessage[],
  history: readonly ChatMessage[],
): ChatMessage[] {
  const before = new Map(baseline.map((message) => [message.id, message]));
  const now = new Map(current.map((message) => [message.id, message]));
  const changed = new Map(
    current
      .filter((message) => before.get(message.id) !== message)
      .map((message) => [message.id, message]),
  );
  const removed = new Set(
    baseline.filter((message) => !now.has(message.id)).map((message) => message.id),
  );
  const merged = history.flatMap((message) => {
    if (removed.has(message.id)) return [];
    const local = changed.get(message.id);
    changed.delete(message.id);
    return [local ?? message];
  });
  return [...merged, ...changed.values()];
}
