import { and, desc, eq, sql } from "drizzle-orm";
import { brainMemories, brainObservations, workshopEvents, workshopSources, workshops,
  type InsertBrainMemoryRow, type InsertBrainObservation } from "@/lib/db/schema";
import type { DrizzleDB } from "@/lib/db/types";

export async function readDocumentUpdateContext(store: DrizzleDB, input: { userId: string; workId: string; sourceId: string; sourceEventId: string }) {
  const [work] = await store.select({ id: workshops.id }).from(workshops).where(and(eq(workshops.id, input.workId), eq(workshops.userId, input.userId))).for("share");
  const [source] = await store.select().from(workshopSources).where(and(eq(workshopSources.id, input.sourceId), eq(workshopSources.workshopId, input.workId))).for("share");
  const [event] = await store.select().from(workshopEvents).where(and(eq(workshopEvents.id, input.sourceEventId), eq(workshopEvents.workshopId, input.workId))).for("share");
  return { work, source, event };
}
export async function readDocumentMemorySlotRows(store: DrizzleDB, input: { userId: string; workId: string; slot: string }, lockOptions: { noWait: true } | undefined) {
  return store.select().from(brainMemories).where(and(eq(brainMemories.userId, input.userId), eq(brainMemories.ownerType, "work"),
    eq(brainMemories.ownerId, input.workId), eq(brainMemories.scopeType, "work"), eq(brainMemories.scopeId, input.workId), eq(brainMemories.canonicalGroupId, input.slot)))
    .orderBy(desc(brainMemories.updatedAt), desc(brainMemories.id)).for("update", lockOptions);
}
export async function readLatestDocumentSourceEvent(store: DrizzleDB, input: { workId: string; sourceId: string }) {
  const [row] = await store.select({ seq: workshopEvents.seq }).from(workshopEvents).where(and(eq(workshopEvents.workshopId, input.workId),
    eq(workshopEvents.type, "document_converted"), sql`${workshopEvents.metadata}->>'sourceId' = ${input.sourceId}`,
    sql`${workshopEvents.metadata}->>'receiptAuthority' = 'runtime'`)).orderBy(desc(workshopEvents.seq)).limit(1);
  return row ?? null;
}
export async function insertDocumentObservationRow(store: DrizzleDB, row: InsertBrainObservation) {
  await store.insert(brainObservations).values(row).returning();
}
export async function insertDocumentMemoryRow(store: DrizzleDB, row: InsertBrainMemoryRow) {
  const [created] = await store.insert(brainMemories).values(row).returning();
  return created;
}
export async function updateDocumentMemoryRow(store: DrizzleDB, input: { userId: string; memoryId: string; values: Partial<InsertBrainMemoryRow> }) {
  const [row] = await store.update(brainMemories).set(input.values).where(and(eq(brainMemories.userId, input.userId), eq(brainMemories.id, input.memoryId))).returning();
  return row;
}
