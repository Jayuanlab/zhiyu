import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { brainMemoryReviews, type BrainMemoryReview } from "@/lib/db/schema";
export async function listBrainMemoryReviewsForUser(input: {
  userId: string;
  memoryId?: string;
  limit?: number;
}): Promise<BrainMemoryReview[]> {
  const conditions = [eq(brainMemoryReviews.userId, input.userId)];
  if (input.memoryId) {
    conditions.push(eq(brainMemoryReviews.memoryId, input.memoryId));
  }
  const rows = await db
    .select()
    .from(brainMemoryReviews)
    .where(and(...conditions))
    .orderBy(desc(brainMemoryReviews.createdAt))
    .limit(input.limit ?? 100);
  return rows as BrainMemoryReview[];
}
