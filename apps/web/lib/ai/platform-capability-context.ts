import type { PlatformCapabilityContext } from "./platform-capability-routing";
import { redactEvidence } from "../brain/jev-evidence-check";

type Message = { id: string; role: string; chatId?: string | null; parts?: readonly unknown[] };
type ContextDependencies = {
  loadChat: (chatId: string) => Promise<{ userId: string } | undefined>;
  loadMessages: (chatId: string) => Promise<readonly Message[]>;
};
const defaults: ContextDependencies = {
  async loadChat(chatId) { return (await import("@/lib/db/chat-queries")).getChatById({ id: chatId }); },
  async loadMessages(chatId) { return (await import("@/lib/db/chat-queries")).getMessagesByChatId({ id: chatId, limit: 32, order: "latest" }); },
};

export function needsPlatformCapabilityContext(question: string) {
  return /(它|这个|该任务|该车间|刚才|上次|继续)/u.test(question);
}

function userText(message: Message) {
  return (message.parts ?? []).flatMap(part => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const value = part as Record<string, unknown>;
    return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
  }).join("");
}

/** Small advisory snapshot from the owned persisted turn; assistant text is excluded. */
export async function loadPlatformCapabilityContext(input: {
  ownerId: string; chatId?: string; userMessageId?: string; question: string;
  confirmedTarget?: PlatformCapabilityContext["confirmedTarget"];
}, dependencies: ContextDependencies = defaults): Promise<{
  status: "ok" | "unavailable" | "degraded"; detail?: string; context?: PlatformCapabilityContext;
}> {
  if (input.confirmedTarget) return { status: "ok", context: { confirmedTarget: input.confirmedTarget } };
  if (!needsPlatformCapabilityContext(input.question)) return { status: "unavailable", detail: "context_not_needed" };
  if (!input.chatId || !input.userMessageId) return { status: "unavailable", detail: "persisted_turn_missing" };
  try {
    const chat = await dependencies.loadChat(input.chatId);
    if (chat?.userId !== input.ownerId) return { status: "unavailable", detail: "owned_chat_missing" };
    const messages = await dependencies.loadMessages(input.chatId);
    const index = messages.findIndex(message => message.id === input.userMessageId && message.role === "user"
      && message.chatId === input.chatId && userText(message) === input.question);
    if (index < 0 || messages.slice(index + 1).some(message => message.role === "user")) {
      return { status: "unavailable", detail: "persisted_turn_changed" };
    }
    const previousUserRequests = messages.slice(0, index)
      .filter(message => message.role === "user" && message.chatId === input.chatId)
      .slice(-2).map(message => redactEvidence(userText(message))).filter(Boolean);
    // The last admitted Workshop is not necessarily the latest conversational
    // subject. Only the current verified Host binding may confirm a target.
    const context: PlatformCapabilityContext = { ...(previousUserRequests.length ? { previousUserRequests } : {}) };
    if (JSON.stringify(context).length > 2000) return { status: "degraded", detail: "context_too_large" };
    return { status: "ok", context };
  } catch {
    return { status: "degraded", detail: "context_source_unavailable" };
  }
}
