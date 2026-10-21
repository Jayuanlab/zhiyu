import { isDeepStrictEqual } from "node:util";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import type { DrizzleDB } from "@/lib/db/types";
import { brainContextLogs, user, type BrainContextLog } from "@/lib/db/schema";
import { deserializeJson, serializeJson } from "@/lib/db/serialization";
import { contextLogToInsertRow, type ContextLogWrite } from "../../records/context-log";
import { MemoryReferenceError, MemoryIdentityConflict } from "../../kernel/reference-errors";

export async function lockContextOwnerForShare(store: DrizzleDB, userId: string) {
  const [principal] = await store.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("share");
  if (!principal) throw new MemoryReferenceError();
}
export async function readOwnedContextLogForShare(store: DrizzleDB, userId: string, id: string) {
  const [row] = await store.select().from(brainContextLogs)
    .where(and(eq(brainContextLogs.userId, userId), eq(brainContextLogs.id, id))).for("share");
  return row ? { ...row, metadata: deserializeJson(row.metadata) } : null;
}
export async function insertContextLogInTransaction(store: DrizzleDB, input: ContextLogWrite): Promise<BrainContextLog> {
  const [created] = await store.insert(brainContextLogs).values(contextLogToInsertRow(input)).returning();
  if (!created) throw new Error("Context admission audit was not persisted");
  return created as BrainContextLog;
}
export async function completeContextAuditInTransaction(store: DrizzleDB, input: {
  userId: string; contextLogId: string; key: "evidenceReadOutcome" | "queryRetryOutcome"; outcome: Record<string, unknown>;
}) {
  const outcome = JSON.parse(JSON.stringify(input.outcome)) as Record<string, unknown>;
  const [row] = await store.select().from(brainContextLogs)
    .where(and(eq(brainContextLogs.id, input.contextLogId), eq(brainContextLogs.userId, input.userId))).for("update");
  if (!row) throw new MemoryReferenceError();
  const decoded = deserializeJson(row.metadata);
  const metadata = decoded && typeof decoded === "object" && !Array.isArray(decoded) ? decoded as Record<string, unknown> : {};
  if (metadata[input.key] !== undefined) {
    if (!isDeepStrictEqual(metadata[input.key], outcome)) throw new MemoryIdentityConflict();
    return { recorded: true as const, written: false };
  }
  await store.update(brainContextLogs).set({ metadata: serializeJson({ ...metadata, [input.key]: outcome }) })
    .where(and(eq(brainContextLogs.id, input.contextLogId), eq(brainContextLogs.userId, input.userId)));
  return { recorded: true as const, written: true };
}
export async function readContextLogsForQuality(input: { userId: string; limit?: number }): Promise<BrainContextLog[]> {
  return db.select().from(brainContextLogs).where(eq(brainContextLogs.userId, input.userId))
    .orderBy(desc(brainContextLogs.createdAt)).limit(Math.min(2_000, Math.max(1, input.limit ?? 500)));
}
