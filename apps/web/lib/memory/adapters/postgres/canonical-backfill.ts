import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import type { DrizzleDB } from "@/lib/db/types";
import { brainMemories, brainBackfillBatches as batches, brainBackfillItems as items, brainBackfillEvents as events } from "@/lib/db/schema.pg";
export type CanonicalBatchRow = typeof batches.$inferSelect;
export type CanonicalBatchItemRow = typeof items.$inferSelect;
export type CanonicalBackfillMemoryRow = typeof brainMemories.$inferSelect;
export function withCanonicalBackfillTransaction<T>(work: (store: DrizzleDB) => Promise<T>): Promise<T> { return db.transaction(work); }
export async function readCanonicalBatchForUpdate(store: DrizzleDB, userId: string, batchId: string) {
  const [row] = await store.select().from(batches).where(and(eq(batches.id, batchId), eq(batches.userId, userId))).for("update"); return row;
}
export async function readCanonicalBatchVersion(store: DrizzleDB, batchId: string) {
  const [row] = await store.select({ version: sql<string>`${events.id}::text` }).from(events).where(eq(events.batchId, batchId)).orderBy(desc(events.id)).limit(1); return row?.version ?? "0";
}
export async function readCanonicalBatchCommand(store: DrizzleDB, batchId: string, commandId: string) {
  const [row] = await store.select({ detail: events.detail }).from(events).where(and(eq(events.batchId, batchId), eq(events.kind, "command_completed"), sql`${events.detail}->>'commandId' = ${commandId}`)).limit(1); return row;
}
export async function appendCanonicalBatchEvent(store: DrizzleDB, batchId: string, kind: string, memoryId: string | null, detail: Record<string, unknown>) { await store.insert(events).values({ batchId, kind, memoryId, detail }); }
export async function lockCanonicalBatchPreparation(store: DrizzleDB, batchId: string) { await store.execute(sql`select pg_advisory_xact_lock(hashtextextended(${batchId}, 0))`); }
export async function readCanonicalBatchById(store: DrizzleDB, batchId: string) { const [row] = await store.select().from(batches).where(eq(batches.id, batchId)); return row; }
export async function readCanonicalBackfillSourceRows(store: DrizzleDB, input: { userId: string; cursor?: string; limit: number }): Promise<CanonicalBackfillMemoryRow[]> {
  return store.select().from(brainMemories).where(and(eq(brainMemories.userId, input.userId), input.cursor ? gt(brainMemories.id, input.cursor) : undefined)).orderBy(asc(brainMemories.id)).limit(input.limit);
}
export async function insertCanonicalBatchRow(store: DrizzleDB, row: typeof batches.$inferInsert) { const [saved] = await store.insert(batches).values(row).returning(); return saved; }
export async function insertCanonicalBatchItems(store: DrizzleDB, rows: Array<typeof items.$inferInsert>) { if (rows.length) await store.insert(items).values(rows); }
export async function listCanonicalBatchRows(userId: string) { return db.select().from(batches).where(eq(batches.userId, userId)).orderBy(desc(batches.createdAt), desc(batches.id)).limit(51); }
export async function readCanonicalBatchForShare(store: DrizzleDB, userId: string, batchId: string) { const [row] = await store.select().from(batches).where(and(eq(batches.id, batchId), eq(batches.userId, userId))).for("share"); return row; }
export async function readCanonicalBatchItems(store: DrizzleDB, batchId: string, status?: string, limit?: number): Promise<CanonicalBatchItemRow[]> {
  const query = store.select().from(items).where(and(eq(items.batchId, batchId), status ? eq(items.status, status) : undefined)).orderBy(asc(items.ordinal));
  return limit === undefined ? query : query.limit(limit);
}
export async function updateCanonicalBatchRow(store: DrizzleDB, batchId: string, values: Partial<typeof batches.$inferInsert>) { await store.update(batches).set(values).where(eq(batches.id, batchId)); }
export async function updateCanonicalBatchItem(store: DrizzleDB, batchId: string, memoryId: string, values: Partial<typeof items.$inferInsert>) { await store.update(items).set(values).where(and(eq(items.batchId, batchId), eq(items.memoryId, memoryId))); }
export async function readCanonicalBackfillMemoryForUpdate(store: DrizzleDB, userId: string, memoryId: string) { const [row] = await store.select().from(brainMemories).where(and(eq(brainMemories.id, memoryId), eq(brainMemories.userId, userId))).for("update"); return row; }
export async function updateCanonicalBackfillMemory(store: DrizzleDB, userId: string, memoryId: string, values: { canonicalKind?: string | null; canonicalGroupId?: string | null }) { const [row] = await store.update(brainMemories).set(values).where(and(eq(brainMemories.id, memoryId), eq(brainMemories.userId, userId))).returning(); return row; }
export async function readCanonicalBatchItemStatuses(store: DrizzleDB, batchId: string): Promise<Array<{ status: string }>> { return store.select({ status: items.status }).from(items).where(eq(items.batchId, batchId)); }
export async function cancelPendingCanonicalBatchItems(store: DrizzleDB, batchId: string) { await store.update(items).set({ status: "cancelled" }).where(and(eq(items.batchId, batchId), eq(items.status, "pending"))); }
