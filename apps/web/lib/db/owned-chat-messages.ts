import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { isTauriMode } from "@/lib/env/constants";
import { db, withDatabaseTransaction } from "./client";
import { chat, message, type DBMessage } from "./schema";
import { serializeJson } from "./serialization";
import { DB_INSERT_CHUNK_SIZE } from "./batch";
import { AgentAnswerAuditError, lockAnswerPersistenceKey } from "./agent-answer-audits";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = new Set(["user", "assistant", "system", "tool"]);

function auditReference(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const turnId = (value as Record<string, unknown>).turnId;
  return typeof turnId === "string" && UUID.test(turnId) ? { turnId } : undefined;
}

/** Browser-provided evidence is a reference only, never a verified snapshot. */
export function sanitizeClientAnswerEvidence(parts: unknown, metadata: unknown) {
  const safeParts = Array.isArray(parts) ? parts.flatMap((part) => {
    if (!part || typeof part !== "object") return [part];
    const p = part as Record<string, unknown>;
    if (p.type !== "data-answerEvidence" && p.type !== "data-answer_evidence") return [part];
    const reference = auditReference(p.data);
    return reference ? [{ type: "data-answerEvidence", data: reference }] : [];
  }) : [];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return { parts: safeParts, metadata: null };
  const safeMetadata = { ...(metadata as Record<string, unknown>) };
  for (const key of ["answerEvidence", "answer_evidence", "data-answerEvidence"]) {
    if (!(key in safeMetadata)) continue;
    const reference = auditReference(safeMetadata[key]);
    if (reference) safeMetadata[key] = reference;
    else delete safeMetadata[key];
  }
  return { parts: safeParts, metadata: safeMetadata };
}

export async function saveOwnedChatMessages(input: { ownerId: string; chatId: string; title: string; messages: DBMessage[] }) {
  if (!UUID.test(input.ownerId) || !UUID.test(input.chatId)) throw new AgentAnswerAuditError("invalid_chat_request", 400, "Invalid chat identity");
  const ids = new Set<string>();
  for (const item of input.messages) {
    if (!item || !UUID.test(item.id) || item.chatId !== input.chatId || !ROLES.has(item.role) || !Array.isArray(item.parts) || !Array.isArray(item.attachments) || !(item.createdAt instanceof Date) || !Number.isFinite(item.createdAt.getTime())) throw new AgentAnswerAuditError("invalid_message_request", 400, "Invalid message identity, role, or content");
    if (ids.has(item.id)) throw new AgentAnswerAuditError("duplicate_message_id", 409, "Duplicate message ID in request");
    ids.add(item.id);
  }
  const persist = async () => {
    if (!isTauriMode()) {
      await lockAnswerPersistenceKey(`chat-save:${input.chatId}`);
      for (const id of [...ids].sort()) await lockAnswerPersistenceKey(`message-save:${id}`);
    }
    // The guarded conflict statements below also protect callers outside this lock protocol.
    const created = await db.insert(chat).values({ id: input.chatId, userId: input.ownerId, title: input.title, createdAt: new Date(), visibility: "public" }).onConflictDoNothing({ target: chat.id }).returning({ id: chat.id });
    const [ownedChat] = await db.select().from(chat).where(eq(chat.id, input.chatId)).limit(1);
    if (!ownedChat || ownedChat.userId !== input.ownerId) throw new AgentAnswerAuditError("chat_not_owned", 403, "Chat is not owned by this user");
    for (let offset = 0; offset < input.messages.length; offset += DB_INSERT_CHUNK_SIZE) {
      const chunk = input.messages.slice(offset, offset + DB_INSERT_CHUNK_SIZE);
      const existing: Array<{ id: string; chatId: string; role: string; parts: unknown }> = await db.select({ id: message.id, chatId: message.chatId, role: message.role, parts: message.parts }).from(message).where(inArray(message.id, chunk.map((item) => item.id)));
      if (existing.some((item) => item.chatId !== input.chatId || item.role !== chunk.find((candidate) => candidate.id === item.id)?.role)) throw new AgentAnswerAuditError("message_identity_conflict", 409, "Message ID belongs to another chat or role");
      const values = chunk.map((item) => {
        const safe = sanitizeClientAnswerEvidence(item.parts, item.metadata);
        const prior = existing.find(value => value.id === item.id);
        const priorParts = typeof prior?.parts === "string" ? JSON.parse(prior.parts) : prior?.parts;
        const references = sanitizeClientAnswerEvidence(priorParts, null).parts.filter(part => (part as Record<string, unknown>)?.type === "data-answerEvidence");
        // A stale/empty client mirror must not erase the server's turn lookup.
        // The owner GET still validates the chat/message binding of every ref.
        if (references.length) safe.parts = [...safe.parts.filter(part => (part as Record<string, unknown>)?.type !== "data-answerEvidence"), ...references];
        return { id: item.id, chatId: item.chatId, role: item.role, parts: serializeJson(safe.parts), attachments: serializeJson(item.attachments as unknown[]), metadata: serializeJson(safe.metadata), createdAt: item.createdAt };
      });
      const rows = await db.insert(message).values(values).onConflictDoUpdate({
        target: message.id,
        set: { parts: sql`excluded.parts`, attachments: sql`excluded.attachments`, metadata: sql`excluded.metadata` },
        setWhere: and(eq(message.chatId, input.chatId), sql`${message.role} = excluded.role`, sql`EXISTS (SELECT 1 FROM ${chat} WHERE ${chat.id} = ${input.chatId} AND ${chat.userId} = ${input.ownerId})`),
      }).returning({ id: message.id });
      if (rows.length !== chunk.length) throw new AgentAnswerAuditError("message_identity_conflict", 409, "Message identity changed while saving");
    }
    return { chat: ownedChat, created: created.length === 1 };
  };
  // better-sqlite3 transactions are synchronous; retain its legacy execution path.
  return isTauriMode() ? persist() : withDatabaseTransaction(persist);
}

export async function updateOwnedChatTitle(input: { ownerId: string; chatId: string; title: string }) {
  return db.update(chat).set({ title: input.title }).where(and(eq(chat.id, input.chatId), eq(chat.userId, input.ownerId)));
}
