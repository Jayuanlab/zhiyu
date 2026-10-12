import { createHash } from "node:crypto";
import type { applyWorkshopManifest } from "@/lib/workshops/manifest";
import type { getWorkshop } from "@/lib/workshops/service";
import { findLatestWorkshopManifestReview } from "./native-conversation";
import { WorkshopManifestApplicationError, type ManifestApplicationDependencies } from "./native-workshop-manifest-application";

export type ReviewedWorkshopManifestBinding = {
  ownerId: string;
  chatId: string;
  reviewAssistantMessageId: string;
  reviewToolCallId: string;
  manifestYaml: string;
  manifestSha256: string;
  revalidate: () => Promise<void>;
};

export type ReviewedWorkshopManifestRequest = {
  chatId: string;
  reviewAssistantMessageId: string;
  reviewToolCallId: string;
  manifestSha256: string;
};

export type ReviewedWorkshopManifestExecutionDependencies = {
  applyManifest: typeof applyWorkshopManifest;
  readWorkshop: typeof getWorkshop;
};

const defaultBindingDependencies: ManifestApplicationDependencies = {
  async loadChat(chatId) {
    const { getChatById } = await import("@/lib/db/chat-queries");
    return getChatById({ id: chatId });
  },
  async loadMessages(chatId) {
    const { getMessagesByChatId } = await import("@/lib/db/chat-queries");
    return getMessagesByChatId({ id: chatId, limit: 1001 });
  },
};

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256;
}

function fail(code: string, message: string): never {
  throw new WorkshopManifestApplicationError(code, message);
}

/** A button click is the action request; it does not require a second chat confirmation. */
export async function resolveOwnerClickedWorkshopManifestApplication(
  ownerId: string,
  request: ReviewedWorkshopManifestRequest,
  dependencies: ManifestApplicationDependencies = defaultBindingDependencies,
): Promise<ReviewedWorkshopManifestBinding> {
  if (!boundedId(ownerId) || !boundedId(request.chatId) || !boundedId(request.reviewAssistantMessageId)
    || !boundedId(request.reviewToolCallId) || !/^[a-f0-9]{64}$/.test(request.manifestSha256)) {
    fail("workshop_apply_invalid_binding", "无法应用：配置来源信息不完整，请刷新对话后重试。");
  }
  const expected = Object.freeze({ ...request });
  async function loadBinding() {
    const chat = await dependencies.loadChat(expected.chatId);
    if (!chat || chat.userId !== ownerId) {
      fail("workshop_apply_chat_not_owned", "无法应用：此对话不属于当前用户。");
    }
    const messages = await dependencies.loadMessages(expected.chatId);
    if (messages.length > 1000) {
      fail("workshop_apply_history_limit", "无法应用：历史消息过多，请在新对话粘贴完整 YAML 并重新审核。");
    }
    if (messages.some(message => message.chatId !== expected.chatId)) {
      fail("workshop_apply_chat_mismatch", "无法应用：配置来源与当前会话不一致。");
    }
    const review = findLatestWorkshopManifestReview(messages, expected.chatId);
    if (!review || review.state !== "valid" || !review.manifestYaml || !review.toolUseId) {
      fail("workshop_apply_review_missing", "无法应用：当前没有完整且审核通过的 YAML，请先生成或修正配置并审核。");
    }
    const manifestSha256 = createHash("sha256").update(review.manifestYaml, "utf8").digest("hex");
    if (review.assistantMessageId !== expected.reviewAssistantMessageId || review.toolUseId !== expected.reviewToolCallId
      || manifestSha256 !== expected.manifestSha256) {
      fail("workshop_apply_draft_changed", "无法应用：审核配置已改变，请查看最新配置后再应用。");
    }
    return { ownerId, chatId: expected.chatId, reviewAssistantMessageId: review.assistantMessageId,
      reviewToolCallId: review.toolUseId, manifestYaml: review.manifestYaml, manifestSha256 };
  }
  const binding = await loadBinding();
  return Object.freeze({ ...binding, async revalidate() { await loadBinding(); } });
}

/** Both chat and owner-button retries must use the exact same command and payload. */
export function stableReviewedWorkshopManifestCommand(input: ReviewedWorkshopManifestBinding) {
  const digest = createHash("sha256").update(JSON.stringify([
    "web-chat-reviewed-manifest.v1", input.ownerId, input.chatId, input.reviewAssistantMessageId,
    input.reviewToolCallId, input.manifestSha256,
  ])).digest("hex");
  return `web-chat-manifest:${digest}`;
}

export async function executeReviewedWorkshopManifestApplication(
  input: ReviewedWorkshopManifestBinding,
  dependencies?: ReviewedWorkshopManifestExecutionDependencies,
  signal?: AbortSignal,
) {
  const binding = Object.freeze({ ...input });
  if (![binding.ownerId, binding.chatId, binding.reviewAssistantMessageId, binding.reviewToolCallId].every(boundedId)
    || typeof binding.manifestYaml !== "string" || !binding.manifestYaml.trim()
    || !/^[a-f0-9]{64}$/.test(binding.manifestSha256)
    || createHash("sha256").update(binding.manifestYaml, "utf8").digest("hex") !== binding.manifestSha256
    || typeof binding.revalidate !== "function") {
    throw Error("Invalid server workshop manifest approval binding.");
  }
  signal?.throwIfAborted();
  await binding.revalidate();
  signal?.throwIfAborted();
  const adapters = dependencies ?? {
    applyManifest: (await import("@/lib/workshops/manifest")).applyWorkshopManifest,
    readWorkshop: (await import("@/lib/workshops/service")).getWorkshop,
  };
  signal?.throwIfAborted();
  const commandId = stableReviewedWorkshopManifestCommand(binding);
  // Preserve the original chat payload so cross-entry retries cannot conflict.
  const result = await adapters.applyManifest({
    userId: binding.ownerId,
    manifestYaml: binding.manifestYaml,
    commandId,
    source: "chat_agent",
    reason: `Owner-confirmed chat manifest ${binding.chatId}/${binding.reviewAssistantMessageId}/${binding.reviewToolCallId}; sha256=${binding.manifestSha256}`,
  });
  const provenance = { manifestSha256: binding.manifestSha256,
    reviewAssistantMessageId: binding.reviewAssistantMessageId, reviewToolCallId: binding.reviewToolCallId };
  let actual: Awaited<ReturnType<typeof getWorkshop>>;
  try {
    actual = await adapters.readWorkshop(binding.ownerId, result.workshop.id);
    if (!actual || actual.id !== result.workshop.id || actual.userId !== binding.ownerId) {
      throw Error("Created Workshop is not visible in the owner's readback.");
    }
  } catch (error) {
    return {
      ok: false as const,
      status: "created_readback_pending" as const,
      message: "The creation transaction committed, but owner-scoped readback failed. Do not claim the Workshop is ready. Retry the same reviewed draft to read the same command result without creating a duplicate.",
      commandId,
      workshopId: result.workshop.id,
      detail: error instanceof Error ? error.message : "Workshop readback failed.",
      retrySafe: true,
      ...provenance,
    };
  }
  return {
    ok: true as const,
    status: "created_verified" as const,
    message: "Workshop created from the owner-approved reviewed YAML and read back from the owner's Workshop list.",
    commandId,
    workshop: { id: actual.id, name: actual.name, mission: actual.mission, status: actual.status, autonomyLevel: actual.autonomyLevel },
    workshopUrl: `/workshop?workId=${encodeURIComponent(actual.id)}`,
    ...provenance,
    review: result.review,
    created: result.created,
  };
}
