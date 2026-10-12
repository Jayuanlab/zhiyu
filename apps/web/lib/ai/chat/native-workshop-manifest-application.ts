import { createHash } from "node:crypto";
import {
  findLatestWorkshopManifestReview,
  type NativeConversationSourceMessage,
} from "./native-conversation";

export type NativeWorkshopManifestApplication = {
  ownerId: string;
  chatId: string;
  turnId: string;
  reviewAssistantMessageId: string;
  reviewToolCallId: string;
  manifestYaml: string;
  manifestSha256: string;
  confirmationMessageId: string;
  revalidate: () => Promise<void>;
};

export type ManifestApplicationDependencies = {
  loadChat: (chatId: string) => Promise<{ userId: string } | undefined>;
  loadMessages: (chatId: string) => Promise<readonly NativeConversationSourceMessage[]>;
};

export class WorkshopManifestApplicationError extends Error {
  readonly status = 409;
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkshopManifestApplicationError";
  }
}

function fail(code: string, message: string): never {
  throw new WorkshopManifestApplicationError(code, message);
}

// Only a direct imperative grants this narrowly scoped creation capability.
// Questions, quoted instructions and conditional/negative phrases never grant it.
function isExplicitApplication(prompt: string) {
  const text = prompt.trim().replace(/[\s。.!！]+$/u, "").replace(/\s+/gu, "").toLowerCase();
  return /^(?:请)?(?:直接|确认)?应用(?:这个|这份|上述|上面的|刚才的)(?:yaml|配置)$/u.test(text)
    || /^(?:please)?applythis(?:yaml|configuration|config)$/u.test(text)
    || /^(?:请)?确认创建这个智能体$/u.test(text);
}

function messageText(message: NativeConversationSourceMessage) {
  return (message.parts ?? []).flatMap(part => {
    if (!part || typeof part !== "object") return [];
    const textPart = part as { type?: unknown; text?: unknown };
    return textPart.type === "text" && typeof textPart.text === "string" ? [textPart.text] : [];
  }).join("");
}

const defaultDependencies: ManifestApplicationDependencies = {
  async loadChat(chatId) {
    const { getChatById } = await import("@/lib/db/chat-queries");
    return getChatById({ id: chatId });
  },
  async loadMessages(chatId) {
    const { getMessagesByChatId } = await import("@/lib/db/chat-queries");
    // One extra row detects incomplete history; never authorize from a prefix.
    return getMessagesByChatId({ id: chatId, limit: 1001 });
  },
};

/** The model/client cannot supply YAML or manufacture the user's confirmation. */
export async function resolveNativeWorkshopManifestApplication(
  input: { ownerId: string; chatId?: string; sessionId?: string; turnId: string;
    userMessageId?: string; prompt: string },
  dependencies: ManifestApplicationDependencies = defaultDependencies,
): Promise<NativeWorkshopManifestApplication | undefined> {
  if (!isExplicitApplication(input.prompt)) return undefined;
  const { ownerId, chatId, turnId, userMessageId } = input;
  if (!chatId || (input.sessionId && input.sessionId !== chatId)) {
    fail("workshop_apply_chat_mismatch", "无法应用：当前会话标识不一致，请回到生成配置的对话重试。");
  }
  if (!ownerId || !turnId || !userMessageId) {
    fail("workshop_apply_confirmation_missing", "无法应用：缺少已保存的确认消息，请在当前对话重新确认。");
  }
  async function loadBinding() {
    const chat = await dependencies.loadChat(chatId!);
    if (!chat || chat.userId !== ownerId) {
      fail("workshop_apply_chat_not_owned", "无法应用：此对话不属于当前用户。");
    }
    const messages = await dependencies.loadMessages(chatId!);
    if (messages.length > 1000) {
      fail("workshop_apply_history_limit", "无法应用：历史消息过多，请在新对话粘贴完整 YAML 并重新审核。");
    }
    if (messages.some(message => message.chatId !== chatId)) {
      fail("workshop_apply_chat_mismatch", "无法应用：配置来源与当前会话不一致。");
    }
    const confirmationIndex = messages.findIndex(message => message.id === userMessageId);
    const confirmation = messages[confirmationIndex];
    if (!confirmation || confirmation.role !== "user" || messageText(confirmation) !== input.prompt) {
      fail("workshop_apply_confirmation_mismatch", "无法应用：确认消息尚未保存或内容已改变，请重新确认。");
    }
    if (messages.slice(confirmationIndex + 1).some(message => message.role === "user")) {
      fail("workshop_apply_confirmation_stale", "无法应用：对话已有更新的消息，请针对最新配置重新确认。");
    }
    const review = findLatestWorkshopManifestReview(messages, chatId);
    if (!review || review.state !== "valid" || !review.manifestYaml || !review.toolUseId) {
      fail("workshop_apply_review_missing", "无法应用：当前没有完整且审核通过的 YAML，请先生成或修正配置并审核。");
    }
    if (messages.findIndex(message => message.id === review.assistantMessageId) >= confirmationIndex) {
      fail("workshop_apply_review_not_confirmed", "无法应用：配置是在确认之后生成的，请先查看最新配置，再确认应用。");
    }
    return { reviewAssistantMessageId: review.assistantMessageId, reviewToolCallId: review.toolUseId,
      manifestYaml: review.manifestYaml, manifestSha256: createHash("sha256").update(review.manifestYaml).digest("hex") };
  }
  const binding = await loadBinding();
  return {
    ownerId, chatId, turnId, confirmationMessageId: userMessageId, ...binding,
    async revalidate() {
      const fresh = await loadBinding();
      if (fresh.reviewAssistantMessageId !== binding.reviewAssistantMessageId
        || fresh.reviewToolCallId !== binding.reviewToolCallId
        || fresh.manifestSha256 !== binding.manifestSha256) {
        fail("workshop_apply_draft_changed", "无法应用：审核配置已改变，请查看最新配置并重新确认。");
      }
    },
  };
}
