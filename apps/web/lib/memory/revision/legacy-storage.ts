import { and, eq, isNull, or, sql } from "drizzle-orm";
import { brainMemories, brainMemoryReviews, type BrainMemoryRow, type BrainMemoryReview } from "@/lib/db/schema";
import type { BrainMemory, BrainRequester, BrainMemoryReviewDecision } from "../kernel/memory-types";
import { MemoryReferenceError as BrainReferenceError, assertMemoryReferenceIds as assertBrainReferenceIds } from "../kernel/reference-errors";
import { MemoryRevisionProtected as BrainMemoryRevisionProtected } from "./legacy-errors";
import { brainMemoryToInsertRow, brainMemoryFromRow, brainMemoryReviewToInsertRow } from "../records/memory-record";
import { withMemoryWrite as withBrainMemoryWrite, withMemoryRecordWrite as withBrainRecordWrite, MemoryIdentityConflict as BrainMemoryIdentityConflict } from "./transaction";
import { acquireBrainWriteAdvisoryLock, brainWriteRowLockOptions, getBrainMemoryCanonicalWriteLockKey } from "./locks";
import { getBrainMemoryRevisionVersion } from "./version";
import { recordMemoryChangeInTransaction } from "./dependencies";

/** Compatibility storage commands retain their original protections. Ordinary
 * model understanding uses revision admission instead of these raw commands. */
export async function insertBrainMemory(
  memory: BrainMemory,
): Promise<BrainMemoryRow> {
  return withBrainMemoryWrite(memory,async store=>{
  const [created] = await store
    .insert(brainMemories)
    .values(brainMemoryToInsertRow(memory))
    .returning();
  return created as BrainMemoryRow;
  });
}

export async function upsertBrainMemory(
  memory: BrainMemory,
): Promise<BrainMemory> {
  const row = brainMemoryToInsertRow(memory);
  return withBrainMemoryWrite(memory,async store=>{
  await acquireBrainWriteAdvisoryLock(store,getBrainMemoryCanonicalWriteLockKey(memory));
  // A caller can change the incoming group. Lock its existing ID regardless
  // of group so a concurrent retirement cannot be overwritten after waiting.
  const [beforeRow] = await store.select().from(brainMemories)
    .where(and(eq(brainMemories.userId,row.userId),eq(brainMemories.id,memory.id))).for("update",brainWriteRowLockOptions());
  const sameIdentity = and(eq(brainMemories.userId,row.userId),eq(brainMemories.scopeType,row.scopeType),
    row.scopeId==null?isNull(brainMemories.scopeId):eq(brainMemories.scopeId,row.scopeId),
    eq(brainMemories.ownerType,row.ownerType),eq(brainMemories.ownerId,row.ownerId));
  const [protectedRow] = await store.select({id: brainMemories.id}).from(brainMemories)
    .where(and(sameIdentity, or(eq(brainMemories.id, memory.id), eq(brainMemories.canonicalGroupId, row.canonicalGroupId)),
      or(sql`(${brainMemories.metadata} ->> 'revision') is not null`,
        sql`(${brainMemories.metadata} ->> 'revisionRetired') is not null`,
        sql`(${brainMemories.metadata} ->> 'updateProposal') is not null`,
        sql`(${brainMemories.metadata} ->> 'documentProgramUpdate') is not null`,
        sql`(${brainMemories.metadata} -> 'recordLifecycle' ->> 'authority') = 'owner_classification'`,
        sql`(${brainMemories.metadata} ->> 'lessonExtraction') is not null`))).limit(1);
  if (protectedRow) throw new BrainMemoryRevisionProtected();
  const [created] = await store
    .insert(brainMemories)
    .values(row)
    .onConflictDoUpdate({
      target: brainMemories.id,
      set: {
        memoryType: row.memoryType,
        subject: row.subject,
        content: row.content,
        status: row.status,
        confidence: row.confidence,
        canonicalKind: row.canonicalKind,
        canonicalGroupId: row.canonicalGroupId,
        evidenceRefs: row.evidenceRefs,
        tags: row.tags,
        metadata: row.metadata,
        expiresAt: row.expiresAt,
        supersedes: row.supersedes,
        updatedAt: row.updatedAt,
      },
      setWhere: and(eq(brainMemories.userId,row.userId),eq(brainMemories.scopeType,row.scopeType),
        row.scopeId==null?isNull(brainMemories.scopeId):eq(brainMemories.scopeId,row.scopeId),
        eq(brainMemories.ownerType,row.ownerType),eq(brainMemories.ownerId,row.ownerId)),
    })
    .returning();
  if(!created)throw new BrainMemoryIdentityConflict();
  const after = brainMemoryFromRow(created as BrainMemoryRow);
  if (beforeRow) {
    const before = brainMemoryFromRow(beforeRow as BrainMemoryRow);
    if (getBrainMemoryRevisionVersion(before) !== getBrainMemoryRevisionVersion(after)) await recordMemoryChangeInTransaction(store, {
      beforeMemory: before, afterMemory: after, commandId: `legacy-upsert:${after.id}:${getBrainMemoryRevisionVersion(after)}`,
      reason: "Legacy memory upsert changed the persisted source record", now: new Date(after.updatedAt),
    });
  }
  return after;
  });
}

export async function insertBrainMemoryReview(input: {
  userId: string;
  memoryId: string;
  reviewerType: BrainRequester["type"];
  reviewerId?: string | null;
  decision: BrainMemoryReviewDecision | "edited";
  reason?: string | null;
  evidenceRefs?: string[];
  metadata?: Record<string, unknown>;
}): Promise<BrainMemoryReview> {
  return withBrainRecordWrite(input.userId,"review",async store=>{
  assertBrainReferenceIds([input.memoryId]);
  const [memory] = await store.select({id:brainMemories.id}).from(brainMemories)
    .where(and(eq(brainMemories.userId,input.userId),eq(brainMemories.id,input.memoryId))).for("share");
  if (!memory) throw new BrainReferenceError();
  const [created] = await store
    .insert(brainMemoryReviews)
    .values(brainMemoryReviewToInsertRow(input))
    .returning();
  return {id:created.id,result:created as BrainMemoryReview};
  });
}
