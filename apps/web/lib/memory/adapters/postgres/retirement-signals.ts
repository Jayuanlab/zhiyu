import type { BrainRetirementIdentity, BrainRetirementQuery } from "../../records/retirement-signals";

export async function queryBrainRetirementIdentities(input: BrainRetirementQuery): Promise<BrainRetirementIdentity[]> {
  const { db } = await import('@/lib/db/client');
  const { and, desc, eq, gte, inArray, lte } = await import('drizzle-orm');
  const { brainMemories } = await import('@/lib/db/schema');
  return await db.select({ id: brainMemories.id, userId: brainMemories.userId, scopeType: brainMemories.scopeType,
    scopeId: brainMemories.scopeId, ownerType: brainMemories.ownerType, ownerId: brainMemories.ownerId,
    memoryType: brainMemories.memoryType, status: brainMemories.status, updatedAt: brainMemories.updatedAt, expiresAt: brainMemories.expiresAt })
    .from(brainMemories).where(and(eq(brainMemories.userId, input.userId), eq(brainMemories.ownerType, 'work'),
      eq(brainMemories.ownerId, input.workId), eq(brainMemories.scopeId, input.workId), inArray(brainMemories.scopeType, ['work', 'workshop']),
      inArray(brainMemories.status, ['deleted', 'superseded']), gte(brainMemories.updatedAt, input.updatedAfter), lte(brainMemories.updatedAt, input.now)))
    .orderBy(desc(brainMemories.updatedAt), desc(brainMemories.id)).limit(input.limit) as BrainRetirementIdentity[];
}
