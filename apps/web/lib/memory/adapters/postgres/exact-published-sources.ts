import { and, eq, inArray } from "drizzle-orm";
import { brainMemories, brainObservations, brainStateSnapshots, workshops } from "@/lib/db/schema";
import type { DrizzleDB } from "@/lib/db/types";
import { workMemorySourceFilters } from "../../kernel/runtime-applicability";
import { memoryArtifactReadReceipts } from "@/lib/db/schema.pg";

export type ExactPublishedSource = "brainMemories" | "brainObservations" | "brainStateSnapshots";
/** Compare the fixed published SQL projection against the actual physical row,
 * including nullable columns, without reconstructing raw columns from a DTO. */
export async function readExactPublishedRowsForShare(store: DrizzleDB, input: { userId: string; source: ExactPublishedSource; ids: string[] }): Promise<Record<string, unknown>[]> {
  const table = { brainMemories, brainObservations, brainStateSnapshots }[input.source];
  return store.select().from(table).where(and(eq(table.userId, input.userId), inArray(table.id, input.ids))).orderBy(table.id).for("share");
}
export async function readExactWorkBindingForShare(store: DrizzleDB, input: { userId: string; workId: string }) {
  const [row] = await store.select({ id: workshops.id, modelConfig: workshops.modelConfig }).from(workshops)
    .where(and(eq(workshops.userId, input.userId), eq(workshops.id, input.workId))).for("share");
  return row ? { sourceFilters: workMemorySourceFilters(row.modelConfig) } : null;
}
export async function readExactArtifactEvidenceReceiptForShare(store: DrizzleDB, input: { userId: string; receiptId: string }) {
  const [row] = await store.select().from(memoryArtifactReadReceipts).where(and(eq(memoryArtifactReadReceipts.userId, input.userId),
    eq(memoryArtifactReadReceipts.id, input.receiptId))).for("share");
  return row ?? null;
}
