import { and, desc, eq, sql } from "drizzle-orm";
import { brainStateSnapshots, type InsertBrainStateSnapshot } from "@/lib/db/schema";
import type { DrizzleDB } from "@/lib/db/types";

export async function readAutoUpdatePolicySnapshotRow(store: DrizzleDB, userId: string) {
  const [row] = await store.select().from(brainStateSnapshots).where(and(eq(brainStateSnapshots.userId, userId),
    eq(brainStateSnapshots.scopeType, "global"), eq(brainStateSnapshots.snapshotType, "memory_auto_update_policy"),
    sql`${brainStateSnapshots.metadata}->>'source' = 'brain_memory_auto_policy.v1'`))
    .orderBy(desc(sql`(${brainStateSnapshots.content}->>'sequence')::bigint`), desc(brainStateSnapshots.createdAt), desc(brainStateSnapshots.id)).limit(1);
  return row ?? null;
}
export async function readAutoUpdatePolicyCommandRow(store: DrizzleDB, userId: string, id: string) {
  const [row] = await store.select().from(brainStateSnapshots).where(and(eq(brainStateSnapshots.userId, userId), eq(brainStateSnapshots.id, id)));
  return row ?? null;
}
export async function insertAutoUpdatePolicySnapshotRow(store: DrizzleDB, row: InsertBrainStateSnapshot) {
  await store.insert(brainStateSnapshots).values(row).returning();
}
