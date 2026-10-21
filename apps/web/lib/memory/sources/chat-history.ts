import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { chat, message } from "@/lib/db/schema";
import { MemoryModuleError } from "../kernel/errors";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import { admitMemorySourceUse } from "./registration";

/** Only persisted messages in this exact owned chat can become remembered
 * conversation. The new user request itself remains a current control input. */
export async function readOwnerChatHistory(input: { userId: string; chatId: string; excludeIds?: string[] }) {
  if (resolveExecutionLease()) throw new MemoryModuleError("memory_source_scope_unverified", 403, "Chat history is owner-only");
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.chatId)) throw new MemoryModuleError("invalid_memory_request", 400, "Invalid chat reference");
  try {
  const [owned] = await db.select({ id: chat.id }).from(chat).where(and(eq(chat.id, input.chatId), eq(chat.userId, input.userId))).limit(1);
  if (!owned) throw new MemoryModuleError("memory_source_not_found", 404, "Chat unavailable");
  const stored: Array<{ id: string; chatId: string; role: string; parts: unknown[] }> = await db.select({ id: message.id, chatId: message.chatId,
    role: message.role, parts: message.parts }).from(message).where(eq(message.chatId, owned.id))
    .orderBy(desc(message.createdAt), desc(message.id)).limit(50);
  const rows = stored.filter(row => !input.excludeIds?.includes(row.id) && ["user", "assistant"].includes(row.role)).reverse();
  const sourceUse = { source: "message" as const, records: rows.map(projection => ({ id: projection.id, projection })) };
  await admitMemorySourceUse({ userId: input.userId, ...sourceUse });
  return { rows, sourceUse, coverage: "bounded_owned_chat_history" as const, complete: false as const };
  } catch (error) {
    if (error instanceof MemoryModuleError) throw error;
    throw new MemoryModuleError('memory_source_unavailable', 503, 'Owned chat history could not be verified');
  }
}
