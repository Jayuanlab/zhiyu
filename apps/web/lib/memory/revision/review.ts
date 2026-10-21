import { and, eq } from "drizzle-orm";
import type { DrizzleDB } from "@/lib/db/types";
import { brainMemories, brainMemoryReviews, brainAccessGrants } from "@/lib/db/schema";
import { brainMemoryFromRow, brainMemoryReviewToInsertRow, brainAccessGrantFromRow } from "../records/memory-record";
import { withBrainMemoryTransaction } from "./transaction";
import { canWriteMemory } from "./policy";
import type { BrainRequester, BrainMemoryStatus, BrainMemoryReviewDecision } from "../kernel/memory-types";
import { getBrainMemoryRevisionVersion } from "./version";
import { brainWriteRowLockOptions } from "./locks";
import { recordMemoryChangeInTransaction } from "./dependencies";
import { qualifyLessonSources } from "../adapters/postgres/lesson-sources";
import { extractedLessonOmitReason } from "../records/lesson-extraction";

export class BrainMemoryReviewConflict extends Error {
  constructor(public code: string, message: string, public status = 409) {
    super(message);
  }
}

export type BrainMemoryReviewInput = {
  requester: BrainRequester;
  memoryId: string;
  decision: BrainMemoryReviewDecision;
  reason?: string | null;
  expectedVersion?: string;
  evidenceConfirmed?: boolean;
  now?: Date;
};

export async function reviewBrainMemoryTransaction(input: BrainMemoryReviewInput) {
  return withBrainMemoryTransaction(input.requester.userId, async (store) => {
    const memory = await reviewBrainMemoryInTransaction(input, store);
    return {memory, result: memory};
  });
}

/** Used only inside a caller-owned, database-only transaction. */
export async function reviewBrainMemoryInTransaction(input: BrainMemoryReviewInput, store: DrizzleDB) {
    const statuses: Record<BrainMemoryReviewDecision, BrainMemoryStatus> = {
      confirmed: "verified", dismissed: "deleted", rejected: "deleted",
      active: "active", weakened: "weakened",
    };
    if (!Object.hasOwn(statuses, input.decision)) throw new Error("Invalid review decision");
    const where = and(eq(brainMemories.id, input.memoryId), eq(brainMemories.userId, input.requester.userId));
    const [row] = await store.select().from(brainMemories).where(where).for("update", brainWriteRowLockOptions());
    if (!row) throw new BrainMemoryReviewConflict("memory_not_found", "Memory unavailable", 404);
    const existing = brainMemoryFromRow(row);
    if(existing.metadata?.updateProposal) {
      throw new BrainMemoryReviewConflict("memory_update_decision_required", "Resolve this update through its versioned accept or reject command.");
    }
    if (input.expectedVersion && input.expectedVersion !== getBrainMemoryRevisionVersion(existing)) {
      throw new BrainMemoryReviewConflict("version_conflict", "Memory changed; refresh before reviewing.");
    }
    const now = input.now ?? new Date();
    const status = statuses[input.decision];
    const activating = status === "verified" || status === "active" || status === "weakened";
    if (activating && (existing.metadata?.admission as any)?.source === "historical_long_term_intake.v1") {
      const reviewBy = (existing.metadata?.recordLifecycle as any)?.reviewBy;
      if (!existing.evidenceRefs.length || reviewBy && Date.parse(reviewBy) <= now.getTime()) throw new BrainMemoryReviewConflict("intake_source_required", "Supplement current verifiable evidence through a revision before reviewing this historical understanding");
    }
    if (activating && existing.metadata?.lessonExtraction) {
      await qualifyLessonSources(store, existing.userId, [existing], true);
      if (extractedLessonOmitReason(existing) || existing.expiresAt && Date.parse(existing.expiresAt) <= now.getTime())
        throw new BrainMemoryReviewConflict("lesson_source_changed_or_expired", "The source or lesson changed or expired; extract and review a new current candidate.");
      if (input.requester.type !== "chat" || !input.expectedVersion || input.evidenceConfirmed !== true || !input.reason?.trim())
        throw new BrainMemoryReviewConflict("lesson_verification_required", "Check the exact source, applicability and counterexample before reviewing this lesson.", 400);
    }
    if (!activating && existing.metadata?.revision) {
      throw new BrainMemoryReviewConflict("memory_revision_required", "Retire a revised memory through an explicit deactivate revision so its receipt and restore chain are preserved.");
    }
    if (activating && (existing.status === "superseded" || existing.status === "deleted")) {
      throw new BrainMemoryReviewConflict("inactive_memory", "Retired memories cannot be reactivated by review; create a new revision.");
    }
    if (activating && existing.metadata?.revision) {
      if (input.requester.type !== "chat" || !input.expectedVersion || input.evidenceConfirmed !== true || !input.reason?.trim()) {
        throw new BrainMemoryReviewConflict("revision_verification_required", "Review this revision with its current version, verified sources and a reason.", 400);
      }
    }
    if(activating && (existing.metadata?.admission as any)?.requiresOwnerVerification === true) {
      if(input.requester.type !== "chat" || !input.expectedVersion || input.evidenceConfirmed !== true || !input.reason?.trim()) {
        throw new BrainMemoryReviewConflict("update_verification_required", "Review this new understanding with its current version, checked sources and an owner reason.", 400);
      }
    }
    const grants = await store.select().from(brainAccessGrants).where(eq(brainAccessGrants.userId, input.requester.userId));
    // Preserve the existing review policy while evaluating the locked memory,
    // rather than authorizing a stale copy read before the transaction.
    const access = canWriteMemory({
      request: {
        requester: input.requester, targetScope: existing.scope,
        ownerType: existing.ownerType, ownerId: existing.ownerId,
        memoryType: existing.memoryType, status,
        confidence: existing.confidence, evidenceRefs: existing.evidenceRefs,
      },
      grants: grants.map(brainAccessGrantFromRow), now,
    });
    if (!access.allowed && input.requester.type !== "chat") {
      throw new Error(`Brain memory review rejected: ${access.reason}`);
    }
    // An audit decision changes status only. It must never write an old copy of
    // the content, evidence, metadata or identity over a concurrent update.
    const [updated] = await store.update(brainMemories).set({status, updatedAt: now}).where(where).returning();
    const memory = brainMemoryFromRow(updated);
    const [review] = await store.insert(brainMemoryReviews).values(brainMemoryReviewToInsertRow({
      userId: input.requester.userId, memoryId: memory.id,
      reviewerType: input.requester.type,
      reviewerId: input.requester.id ?? input.requester.workId ?? input.requester.workshopId ?? null,
      decision: input.decision, reason: input.reason, evidenceRefs: memory.evidenceRefs,
      metadata: {source: "brain_service_review", previousStatus: existing.status, nextStatus: memory.status,
        previousVersion: getBrainMemoryRevisionVersion(existing), nextVersion: getBrainMemoryRevisionVersion(memory),
        evidenceConfirmed: input.evidenceConfirmed === true},
    })).returning();
    if (!review?.id) throw new Error("Memory review audit was not persisted");
    await recordMemoryChangeInTransaction(store, {
      beforeMemory: existing, afterMemory: memory,
      commandId: `memory-review:${review.id}`, reviewId: review.id,
      reason: input.reason?.trim() || `Owner review: ${input.decision}`, now,
    });
    return memory;
}
