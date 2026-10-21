import { ZHIYU_MEMORY_RULES } from "@/lib/memory-policies/zhiyu/rules";
import { describeZhiyuMemoryPolicy } from "@/lib/memory-zhiyu/policy";
import { and, eq } from "drizzle-orm";
import { brainMemories, brainMemoryReviews } from "@/lib/db/schema";
import { brainMemoryFromRow } from "../records/memory-record";
import { inferRecordClass, makeRecordLifecycle, recordLifecycleView, type MemoryRecordClass } from "../records/lifecycle";
import { listMemoryCandidatesForUser } from "../retrieval/candidates";
import { withMemoryTransaction } from "../revision/transaction";
import { getBrainMemoryRevisionVersion } from "../revision/version";
import { commandReplay, digest, fail, nonempty, recordUpdateReceipt, updateRecordId, version } from "../revision/common";
import { recordMemoryChangeInTransaction } from "../revision/dependencies";
import type { BrainRequester } from "../kernel/memory-types";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import { findLessonSpans, analyzeOperationalContent } from "../records/operational-content";
import { extractedLessonOmitReason, lessonExtraction } from "../records/lesson-extraction";
import { getBrainMemoryById } from "../adapters/postgres/memory-records";

export async function listLifecycleRecords(userId: string, recordClass: MemoryRecordClass | "all" = "all", limit = 100, before?: { updatedAt: string; id: string }, extractionsOnly = false, memoryId?: string) {
  const memory = memoryId ? await getBrainMemoryById({ userId, memoryId }) : null;
  const rows = memoryId ? memory ? [memory] : [] : await listMemoryCandidatesForUser({ userId, recordClass, limit: Math.min(101, limit + 1), before, extractionsOnly });
  return { policy: describeZhiyuMemoryPolicy(), records: rows.slice(0, limit).map(memory => ({ ...memory, revisionVersion: getBrainMemoryRevisionVersion(memory),
    lifecycle: recordLifecycleView(memory), suggestion: inferRecordClass(memory), operational: analyzeOperationalContent(memory),
    extractionSpans: findLessonSpans(memory.content), extraction: lessonExtraction(memory), extractionSourceProblem: extractedLessonOmitReason(memory),
    intake: (memory.metadata?.admission as any)?.source === "historical_long_term_intake.v1", intakeSourceMissing: memory.evidenceRefs.length === 0,
    restoreReceiptId: (memory.metadata?.recordLifecycle as any)?.commandId ? updateRecordId(userId, (memory.metadata?.recordLifecycle as any).commandId) : null })), truncated: rows.length > limit,
    nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ updatedAt: rows[limit - 1].updatedAt, id: rows[limit - 1].id })).toString("base64url") : null };
}

export type LifecycleCommand = { requester: BrainRequester; memoryId: string; expectedVersion: string; commandId: string;
  action: "classify" | "rollback"; recordClass?: MemoryRecordClass; reason: string; restoreReceiptId?: string; requireReview?: boolean };
/** Classification is not a truth confirmation. Raw content and observation timestamps never change. */
export async function governRecordLifecycle(input: LifecycleCommand) {
  if (resolveExecutionLease() || input.requester.type !== "chat" || input.requester.id !== "memory-lifecycle-owner") fail("lifecycle_owner_required", 403, "Owner lifecycle command required");
  const commandId = nonempty(input.commandId, "commandId", 200), reason = nonempty(input.reason, "reason", 2000);
  version(input.expectedVersion);
  if (!["classify", "rollback"].includes(input.action) || input.action === "classify" && !["long_term", "run_record", "acceptance_record"].includes(input.recordClass ?? ""))
    fail("invalid_lifecycle", 400, "Invalid lifecycle operation");
  const requestHash = digest({ ...input, requester: { type: input.requester.type, userId: input.requester.userId, id: input.requester.id } });
  return withMemoryTransaction(input.requester.userId, async store => {
    const replay = await commandReplay(store, input.requester.userId, commandId, requestHash);
    const [row] = await store.select().from(brainMemories).where(and(eq(brainMemories.userId, input.requester.userId), eq(brainMemories.id, input.memoryId))).for("update");
    if (!row) fail("memory_not_found", 404, "Memory unavailable");
    const before = brainMemoryFromRow(row);
    if (replay) return { memory: before, result: { ...replay, currentVersion: getBrainMemoryRevisionVersion(before) }, written: false };
    if (getBrainMemoryRevisionVersion(before) !== input.expectedVersion) fail("version_conflict", 409, "Record changed; reload before classifying");
    const now = new Date();
    let metadata = { ...before.metadata }, status = before.status;
    if (input.action === "rollback") {
      const [receipt] = await store.select().from(brainMemoryReviews).where(and(eq(brainMemoryReviews.userId, before.userId), eq(brainMemoryReviews.id, input.restoreReceiptId ?? "00000000-0000-0000-0000-000000000000")));
      const result = (receipt?.metadata as any)?.result;
      if (receipt?.memoryId !== before.id || result?.kind !== "record_lifecycle" || result.action !== "classify" || result.afterVersion !== input.expectedVersion)
        fail("lifecycle_restore_conflict", 409, "Only the unchanged classified version can be restored");
      if (result.beforeLifecycle === null) delete metadata.recordLifecycle;
      else metadata.recordLifecycle = result.beforeLifecycle;
      if (result.admissionChanged) { if (result.beforeAdmission === null) delete metadata.admission; else metadata.admission = result.beforeAdmission; }
      status = result.beforeStatus;
    } else {
      if (input.requireReview && (before.memoryType === "boundary" || before.metadata?.canonicalKind === "boundary")) fail("protected_boundary", 409, "Boundary review must use the explicit revision service");
      if (input.recordClass === "long_term" && recordLifecycleView(before).recordClass === "run_record")
        fail("extract_lesson_required", 409, "Keep the original report as a run record; extract a separate source-linked lesson candidate");
      if (input.recordClass !== "long_term" && (before.memoryType === "boundary" || before.metadata?.canonicalKind === "boundary"))
        fail("protected_boundary", 409, "Boundary memories cannot be reclassified as operational records");
      metadata.recordLifecycle = makeRecordLifecycle(before, input.recordClass!, reason, now, commandId);
      const originalReviewBy = (before.metadata?.recordLifecycle as any)?.reviewBy;
      if (input.recordClass === "long_term" && originalReviewBy) metadata.recordLifecycle = { ...(metadata.recordLifecycle as object), reviewBy: originalReviewBy };
      // Returning an operational note to long-term storage requires source review again.
      if (input.recordClass === "long_term" && recordLifecycleView(before).recordClass !== "long_term" && !["deleted", "superseded"].includes(status)) status = "candidate";
      if (input.requireReview && input.recordClass === "long_term" && !["deleted", "superseded"].includes(status)) {
        status = "candidate"; metadata.admission = { requiresOwnerVerification: true, source: "historical_long_term_intake.v1" };
        metadata.recordLifecycle = { ...(metadata.recordLifecycle as object), reviewBy: originalReviewBy ?? new Date(now.getTime() + ZHIYU_MEMORY_RULES.lessonDefaultDays * 86400_000).toISOString() };
      }
    }
    const [saved] = await store.update(brainMemories).set({ metadata, status }).where(and(eq(brainMemories.userId, before.userId), eq(brainMemories.id, before.id))).returning();
    const after = brainMemoryFromRow(saved), receiptId = updateRecordId(before.userId, commandId);
    const result = { kind: "record_lifecycle", action: input.action, memoryId: before.id, beforeVersion: input.expectedVersion,
      afterVersion: getBrainMemoryRevisionVersion(after), beforeLifecycle: before.metadata?.recordLifecycle ?? null, beforeStatus: before.status,
      lifecycle: recordLifecycleView(after, now), beforeAdmission: before.metadata?.admission ?? null, admissionChanged: input.requireReview === true && input.recordClass === "long_term",
      receiptId, replayed: false };
    await recordUpdateReceipt(store, { userId: before.userId, commandId, requestHash, memory: after, result, now, reason,
      reviewerType: "chat", reviewerId: input.requester.id });
    await recordMemoryChangeInTransaction(store, { beforeMemory: before, afterMemory: after, commandId, reviewId: receiptId, reason, now });
    return { memory: after, result };
  });
}
