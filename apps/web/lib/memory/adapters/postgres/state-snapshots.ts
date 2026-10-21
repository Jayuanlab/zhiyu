import { and, desc, eq, getTableColumns, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import type { DrizzleDB } from "@/lib/db/types";
import { brainMemories, brainStateSnapshots, type BrainStateSnapshot } from "@/lib/db/schema";
import { brainStateSnapshotFromRow, brainStateSnapshotToInsertRow, scopeColumns, type SnapshotQuery, type StateSnapshotRecord } from "../../records/state-snapshots";
import { MemoryReferenceError, assertMemoryReferenceIds } from "../../kernel/reference-errors";

function snapshotConditions(input: SnapshotQuery) {
  const conditions = [eq(brainStateSnapshots.userId, input.userId)];
  if (input.workId) conditions.push(and(
    inArray(brainStateSnapshots.scopeType, ["work", "workshop"]),
    eq(brainStateSnapshots.scopeId, input.workId),
  )!);
  if (input.snapshotId) conditions.push(eq(brainStateSnapshots.id, input.snapshotId));
  if (input.pageAfter) conditions.push(sql`(${brainStateSnapshots.createdAt} < ${input.pageAfter.time} or (${brainStateSnapshots.createdAt} = ${input.pageAfter.time} and ${brainStateSnapshots.id} < ${input.pageAfter.id}))`);
  if (input.recordedBefore) conditions.push(lte(brainStateSnapshots.createdAt, new Date(input.recordedBefore)));
  if (input.contentQuery !== undefined) {
    const term = input.contentQuery.trim();
    if (term.length < 2 || term.length > 200) throw Error("Snapshot content query must be 2 to 200 characters");
    const pattern = `%${term.toLowerCase().replace(/[!%_]/g, character => `!${character}`)}%`;
    conditions.push(sql`lower(cast(${brainStateSnapshots.content} as text)) like ${pattern} escape '!'`);
  }
  if (input.scope) {
    const scope = scopeColumns(input.scope);
    conditions.push(eq(brainStateSnapshots.scopeType, scope.scopeType));
    if (scope.scopeId) {
      conditions.push(eq(brainStateSnapshots.scopeId, scope.scopeId));
    }
  }
  if (input.snapshotTypes?.length) {
    conditions.push(
      inArray(brainStateSnapshots.snapshotType, input.snapshotTypes),
    );
  }
  return and(...conditions);
}

export async function catalogBrainStateSnapshots(input: SnapshotQuery) {
  const rows = await db.select({ snapshotType: brainStateSnapshots.snapshotType,
    count: sql<number>`count(*)`, firstRecordedAt: sql<string>`min(${brainStateSnapshots.createdAt})`,
    lastRecordedAt: sql<string>`max(${brainStateSnapshots.createdAt})`,
  }).from(brainStateSnapshots).where(snapshotConditions(input))
    .groupBy(brainStateSnapshots.snapshotType).orderBy(brainStateSnapshots.snapshotType).limit(101);
  return { types: rows.slice(0, 100).map((row: any) => {
    const count = Number(row.count);
    if (!Number.isSafeInteger(count) || count < 0) throw Error("Snapshot count is outside the safe integer range");
    return { ...row, count };
  }), hasMoreTypes: rows.length > 100 };
}

export async function listBrainStateSnapshots(input: SnapshotQuery) {
  const rows = await db
    .select({ ...getTableColumns(brainStateSnapshots), paginationTime: sql<string>`cast(${brainStateSnapshots.createdAt} as text)` })
    .from(brainStateSnapshots)
    .where(snapshotConditions(input))
    .orderBy(desc(brainStateSnapshots.createdAt), desc(brainStateSnapshots.id))
    .limit(input.limit ?? 100);
  return (rows as (BrainStateSnapshot & { paginationTime: string })[]).map(row => ({
    ...brainStateSnapshotFromRow(row), ...(input.includePagePosition ? { paginationTime: row.paginationTime } : {}),
  }));
}

export async function insertStateSnapshotInTransaction(store: DrizzleDB, input: Parameters<typeof brainStateSnapshotToInsertRow>[0]) {
  assertMemoryReferenceIds(input.sourceMemoryIds ?? []);
  const sourceIds = [...new Set((input.sourceMemoryIds ?? []).map(id => id.toLowerCase()))];
  if (sourceIds.length) { const memories = await store.select({ id: brainMemories.id }).from(brainMemories).where(and(eq(brainMemories.userId, input.userId), inArray(brainMemories.id, sourceIds))).for("share"); if (memories.length !== sourceIds.length) throw new MemoryReferenceError(); }
  const [created] = await store.insert(brainStateSnapshots).values(brainStateSnapshotToInsertRow({ ...input, sourceMemoryIds: sourceIds })).returning();
  if (!created) throw new Error("State snapshot was not persisted");
  return brainStateSnapshotFromRow(created);
}
export async function readStateSnapshotInTransaction(store: DrizzleDB, input: { userId: string; snapshotId: string; workId?: string; lock?: "share" }): Promise<StateSnapshotRecord | null> {
  const query = store.select().from(brainStateSnapshots).where(snapshotConditions({ userId: input.userId, snapshotId: input.snapshotId, workId: input.workId })).limit(1);
  const [row] = input.lock ? await query.for(input.lock) : await query;
  return row ? brainStateSnapshotFromRow(row) : null;
}
