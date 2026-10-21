import { and, eq } from "drizzle-orm";
import { brainMemories, brainObservations, brainStateSnapshots,
  type InsertBrainObservation, type InsertBrainStateSnapshot } from "@/lib/db/schema";
import type { DrizzleDB } from "@/lib/db/types";

export async function readCorrectionMemoryRow(store: DrizzleDB, userId: string, memoryId: string, lock = false) {
  const query = store.select().from(brainMemories).where(and(eq(brainMemories.userId, userId), eq(brainMemories.id, memoryId)));
  const [row] = lock ? await query.for("share", { noWait: true }) : await query;
  return row ?? null;
}
export async function readCorrectionSnapshotRow(store: DrizzleDB, userId: string, id: string) {
  const [row] = await store.select().from(brainStateSnapshots).where(and(eq(brainStateSnapshots.userId, userId), eq(brainStateSnapshots.id, id)));
  return row ?? null;
}
export async function readCorrectionObservationRow(store: DrizzleDB, userId: string, id: string) {
  const [row] = await store.select().from(brainObservations).where(and(eq(brainObservations.userId, userId), eq(brainObservations.id, id)));
  return row ?? null;
}
export async function insertCorrectionObservationRow(store: DrizzleDB, row: InsertBrainObservation) {
  await store.insert(brainObservations).values(row).returning();
}
export async function insertCorrectionSnapshotRow(store: DrizzleDB, row: InsertBrainStateSnapshot) {
  await store.insert(brainStateSnapshots).values(row).returning();
}
