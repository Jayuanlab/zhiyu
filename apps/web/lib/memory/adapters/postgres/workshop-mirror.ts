import { eq } from "drizzle-orm";
import { brainMemories, type InsertBrainMemoryRow } from "@/lib/db/schema";
import type { DrizzleDB } from "@/lib/db/types";

export async function insertMissingWorkshopMirrorRow(store: DrizzleDB, row: InsertBrainMemoryRow) {
  await store.insert(brainMemories).values(row).onConflictDoNothing({ target: brainMemories.id });
}
export async function readWorkshopMirrorForUpdate(store: DrizzleDB, memoryId: string, lockOptions: { noWait: true } | undefined) {
  const [row] = await store.select().from(brainMemories).where(eq(brainMemories.id, memoryId)).for("update", lockOptions);
  return row ?? null;
}
