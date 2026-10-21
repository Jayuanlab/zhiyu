import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleDB } from "@/lib/db/types";
import { db } from "@/lib/db/client";
import { brainMemories, brainAccessGrants, type BrainMemoryRow, type BrainAccessGrantRow } from "@/lib/db/schema";
import type { BrainMemory, BrainAccessGrant } from "../../kernel/memory-types";
import { brainMemoryFromRow, brainAccessGrantFromRow } from "../../records/memory-record";
import { qualifyLessonSources } from "./lesson-sources";

export async function getBrainMemoryById(input: {
  userId: string;
  memoryId: string;
}): Promise<BrainMemory | null> {
  const [row] = await db
    .select()
    .from(brainMemories)
    .where(
      and(
        eq(brainMemories.userId, input.userId),
        eq(brainMemories.id, input.memoryId),
      ),
    )
    .limit(1);
  return row ? (await qualifyLessonSources(db, input.userId, [brainMemoryFromRow(row as BrainMemoryRow)]))[0] : null;
}

export async function listBrainAccessGrantsForUser(input: {
  userId: string;
  limit?: number;
  subjectType?: BrainAccessGrant["subjectType"];
  subjectId?: string;
}): Promise<BrainAccessGrant[]> {
  const conditions = [eq(brainAccessGrants.userId, input.userId)];
  if (input.subjectType) {
    conditions.push(eq(brainAccessGrants.subjectType, input.subjectType));
  }
  if (input.subjectId) {
    conditions.push(eq(brainAccessGrants.subjectId, input.subjectId));
  }
  const rows = await db
    .select()
    .from(brainAccessGrants)
    .where(and(...conditions))
    .orderBy(desc(brainAccessGrants.updatedAt))
    .limit(input.limit ?? 200);
  return (rows as BrainAccessGrantRow[]).map(brainAccessGrantFromRow);
}

export { getBrainMemoryById as getMemoryById, listBrainAccessGrantsForUser as listAccessGrantsForUser };

export async function getBrainMemoriesByIds(input: {userId: string; memoryIds: string[]}): Promise<BrainMemory[]> {
  const ids = [...new Set(input.memoryIds)];
  if (ids.length === 0) return [];
  if (ids.length > 200) {
    const batches: BrainMemory[] = [];
    for (let offset = 0; offset < ids.length; offset += 200) {
      batches.push(...await getBrainMemoriesByIds({...input, memoryIds: ids.slice(offset, offset + 200)}));
    }
    return batches;
  }
  const rows = await db.select().from(brainMemories)
    .where(and(eq(brainMemories.userId, input.userId), inArray(brainMemories.id, ids)));
  return qualifyLessonSources(db, input.userId, (rows as BrainMemoryRow[]).map(brainMemoryFromRow));
}

/** Final admission holds the returned rows until its audit/outer receipt commits. */
export async function readContextMemoriesForShare(store: DrizzleDB, userId: string, ids: string[]) {
  if (!ids.length) return [] as BrainMemory[];
  const rows = await store.select().from(brainMemories)
    .where(and(eq(brainMemories.userId, userId), inArray(brainMemories.id, [...new Set(ids)].sort())))
    .orderBy(brainMemories.id).for("share");
  return qualifyLessonSources(store, userId, (rows as BrainMemoryRow[]).map(brainMemoryFromRow), true);
}

export async function readContextGrantsForShare(store: DrizzleDB, userId: string) {
  const rows = await store.select().from(brainAccessGrants).where(eq(brainAccessGrants.userId, userId))
    .orderBy(brainAccessGrants.id).for("share");
  return (rows as BrainAccessGrantRow[]).map(brainAccessGrantFromRow);
}

export async function readContextPendingUpdates(store: DrizzleDB, userId: string, baseIds: string[]) {
  if (!baseIds.length) return [] as Array<{ metadata: Record<string, unknown> }>;
  return store.select({ metadata: brainMemories.metadata }).from(brainMemories)
    .where(and(eq(brainMemories.userId, userId), eq(brainMemories.status, "candidate"),
      sql`${brainMemories.metadata}->'updateProposal'->>'status' = 'pending'`,
      inArray(sql<string>`${brainMemories.metadata}->'updateProposal'->>'targetMemoryId'`, baseIds)))
    .orderBy(brainMemories.id).for("share", { noWait: true }) as Promise<Array<{ metadata: Record<string, unknown> }>>;
}
