import equal from "fast-deep-equal";
import type { ChatMessage } from "@openzhiyu/shared";

export type ChatHistorySnapshot = {
  chatId: string;
  baseline: readonly ChatMessage[];
  messages: readonly ChatMessage[];
  protectedMessageIds?: readonly string[];
};

/** The server may return a recent window. Absence is not a deletion receipt. */
export function mergeBackgroundChatMessages(
  snapshot: ChatHistorySnapshot,
  current: readonly ChatMessage[],
  protectedMessageIds: ReadonlySet<string>,
): ChatMessage[] {
  const before = new Map(snapshot.baseline.map(message => [message.id, message]));
  const now = new Map(current.map(message => [message.id, message]));
  const merged = new Map<string, ChatMessage>();
  const protectedAtRead = new Set(snapshot.protectedMessageIds);
  for (const server of snapshot.messages) {
    if (!server || typeof server.id !== "string" || !Array.isArray(server.parts)) continue;
    // UI messages may omit chatId; the authenticated URL supplies their scope.
    const chatId = (server as ChatMessage & { chatId?: unknown }).chatId;
    if (chatId !== undefined && chatId !== snapshot.chatId) continue;
    if (before.has(server.id) && !now.has(server.id)) continue;
    const local = now.get(server.id);
    if (local && (protectedMessageIds.has(server.id) || protectedAtRead.has(server.id) ||
        (before.has(server.id) ? before.get(server.id) !== local : true))) {
      merged.set(server.id, local);
      continue;
    }
    merged.set(server.id, local && equal(local, server) ? local : server);
  }
  for (const local of current) if (!merged.has(local.id)) merged.set(local.id, local);
  const result = [...merged.values()];
  // Preserve undated local order. New messages created by chat carry a timestamp.
  if (result.every(message => typeof message.metadata?.createdAt === "string" &&
      Number.isFinite(Date.parse(message.metadata.createdAt)))) {
    result.sort((a, b) => Date.parse(a.metadata!.createdAt!) - Date.parse(b.metadata!.createdAt!));
  }
  return result;
}

export function sameMessageReferences(a: readonly ChatMessage[], b: readonly ChatMessage[]) {
  return a.length === b.length && a.every((message, index) => message === b[index]);
}
