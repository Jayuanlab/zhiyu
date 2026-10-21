import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { brainMemories, brainMemoryReviews } from "@/lib/db/schema";

/** Persisted stamp: separate Next workers must observe a committed revision. */
export async function getBrainMemoryReadVersion(userId: string): Promise<string> {
  const [memories, reviews] = await Promise.all([
    db.select({ count: sql`count(*)`, latest: sql`max(${brainMemories.updatedAt})` })
      .from(brainMemories).where(eq(brainMemories.userId, userId)),
    db.select({ count: sql`count(*)`, latest: sql`max(${brainMemoryReviews.createdAt})` })
      .from(brainMemoryReviews).where(eq(brainMemoryReviews.userId, userId)),
  ]);
  return JSON.stringify([memories[0]?.count, memories[0]?.latest, reviews[0]?.count, reviews[0]?.latest]);
}
