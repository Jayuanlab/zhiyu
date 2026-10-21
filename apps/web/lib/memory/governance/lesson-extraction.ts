import { ZHIYU_MEMORY_RULES } from "@/lib/memory-policies/zhiyu/rules";
import { and, eq } from "drizzle-orm";
import { brainMemories, brainObservations } from "@/lib/db/schema";
import type { BrainMemory, BrainRequester } from "../kernel/memory-types";
import { brainMemoryFromRow, brainMemoryToInsertRow } from "../records/memory-record";
import { observationToInsertRow } from "../records/observations";
import { isVolatileLesson } from "../records/operational-content";
import { makeRecordLifecycle, recordLifecycleView } from "../records/lifecycle";
import { getBrainMemoryRevisionVersion } from "../revision/version";
import { withMemoryTransaction } from "../revision/transaction";
import { acquireBrainWriteAdvisoryLock } from "../revision/locks";
import { commandReplay, digest, fail, nonempty, recordUpdateReceipt, updateRecordId, version, UUID } from "../revision/common";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import { getBrainMemoryCanonicalMetadata } from "../kernel/memory-canonical";

export type LessonExtractionCommand = { requester: BrainRequester; sourceMemoryId: string; expectedVersion: string; commandId: string;
  offset: number; quote: string; conclusion: string; conditions: string; counterexample: string; recheckWhen: string; validityDays: number };
export async function proposeLessonExtraction(input: LessonExtractionCommand) {
  if (resolveExecutionLease() || input.requester.type !== "chat" || input.requester.id !== "memory-lifecycle-owner") fail("lifecycle_owner_required", 403, "Owner context required");
  if (!UUID.test(input.sourceMemoryId)) fail("invalid_extraction", 400, "Invalid source ID");
  const commandId = nonempty(input.commandId, "commandId", 200); version(input.expectedVersion);
  nonempty(input.quote, "quote", 2000);
  const quote = input.quote, conclusion = nonempty(input.conclusion, "conclusion", 2000),
    conditions = nonempty(input.conditions, "conditions", 1200), counterexample = nonempty(input.counterexample, "counterexample", 1200), recheckWhen = nonempty(input.recheckWhen, "recheckWhen", 1200);
  if (quote.length < 10 || !Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isSafeInteger(input.validityDays) || input.validityDays < 1 || input.validityDays > ZHIYU_MEMORY_RULES.lessonMaxDays)
    fail("invalid_extraction", 400, "Exact source span and 1-90 day review window required");
  if (isVolatileLesson(conclusion) || conclusion === quote) fail("volatile_lesson", 400, "Extract an independent reusable conclusion, not a snapshot or the unchanged report");
  const semantic = { sourceMemoryId: input.sourceMemoryId, sourceVersion: input.expectedVersion, offset: input.offset, quote, conclusion, conditions, counterexample, recheckWhen, validityDays: input.validityDays };
  const requestHash = digest(semantic), id = updateRecordId(input.requester.userId, `lesson:${requestHash}`, "candidate");
  return withMemoryTransaction(input.requester.userId, async store => {
    const replay = await commandReplay(store, input.requester.userId, commandId, requestHash);
    await acquireBrainWriteAdvisoryLock(store, `lesson:${input.requester.userId}:${id}`);
    const [sourceRow] = await store.select().from(brainMemories).where(and(eq(brainMemories.userId, input.requester.userId), eq(brainMemories.id, input.sourceMemoryId))).for("share");
    if (!sourceRow) fail("memory_not_found", 404, "Source unavailable");
    const source = brainMemoryFromRow(sourceRow);
    const [prior] = await store.select().from(brainMemories).where(and(eq(brainMemories.userId, input.requester.userId), eq(brainMemories.id, id))).for("share");
    if (replay) return { memory: prior ? brainMemoryFromRow(prior) : source, result: { ...replay, currentCandidateVersion: prior ? getBrainMemoryRevisionVersion(brainMemoryFromRow(prior)) : null }, written: false };
    if (getBrainMemoryRevisionVersion(source) !== input.expectedVersion) fail("version_conflict", 409, "Source changed; reload before extraction");
    if (recordLifecycleView(source).recordClass !== "run_record" || ["deleted", "superseded"].includes(source.status) || source.metadata?.lessonExtraction)
      fail("extraction_source_unavailable", 409, "Only a retained operational source can be extracted; audit and retired records are not business evidence");
    if (source.content.slice(input.offset, input.offset + quote.length) !== quote) fail("source_span_conflict", 409, "Quote does not match the exact original span");
    const now = new Date(), observationId = updateRecordId(source.userId, `lesson:${requestHash}`, "observation");
    let candidate: BrainMemory;
    if (prior) candidate = brainMemoryFromRow(prior);
    else {
      if (source.evidenceRefs.length > 99) fail("extraction_evidence_budget", 400, "The source exceeds the candidate reference budget");
      const content = `${conclusion}\n\n适用条件：${conditions}\n反例与限制：${counterexample}\n复查触发：${recheckWhen}\n\n候选经验：来源为历史运行观测，不证明当前业务状态，也不授予行动权限。`;
      if (isVolatileLesson(content)) fail("volatile_lesson", 400, "Keep current prices, holdings and balances out of the reusable lesson");
      candidate = { ...source, id, memoryType: "insight", subject: `提炼候选 · ${source.subject}`, content, status: "candidate", confidence: Math.min(50, source.confidence),
        evidenceRefs: [...source.evidenceRefs, `brain-observation:${observationId}`], tags: ["extracted_lesson"], supersedes: [], createdAt: now.toISOString(), updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + input.validityDays * 86400_000).toISOString(), metadata: { canonicalKind: "lesson", canonicalGroupId: `lesson:${requestHash}`,
          observationTime: source.createdAt, admission: { requiresOwnerVerification: true, source: "memory-lesson-extraction.v1" },
          facets: { ...getBrainMemoryCanonicalMetadata(source).facets, sourceKind: "operational_lesson_extraction", scopeType: source.scope.type },
          lessonExtraction: { schemaVersion: "memory-lesson-extraction.v1", sourceMemoryId: source.id, sourceVersion: input.expectedVersion, offset: input.offset, quote,
            conditions, counterexample, recheckWhen, commandId, createdAt: now.toISOString() } } };
      candidate.metadata!.recordLifecycle = makeRecordLifecycle(candidate, "long_term", "extracted_lesson_requires_review", now);
      await store.insert(brainObservations).values(observationToInsertRow({ id: observationId, userId: source.userId, sourceType: "operational_lesson_proposal", sourceId: source.id,
        observedAt: now, content: JSON.stringify(semantic), contentHash: requestHash, trustLevel: "proposal",
        metadata: { sourceVersion: input.expectedVersion, memoryId: candidate.id, scope: source.scope, independentlyVerifiesBusinessFact: false } }));
      const [created] = await store.insert(brainMemories).values(brainMemoryToInsertRow(candidate)).returning(); candidate = brainMemoryFromRow(created);
    }
    const result = { kind: "lesson_extraction", candidateId: candidate.id, candidateVersion: getBrainMemoryRevisionVersion(candidate), sourceMemoryId: source.id,
      receiptId: updateRecordId(source.userId, commandId), duplicate: Boolean(prior), replayed: false };
    await recordUpdateReceipt(store, { userId: source.userId, commandId, requestHash, memory: candidate, result, now,
      reason: "Scoped source-linked lesson candidate; owner evidence review still required", reviewerType: "chat", reviewerId: input.requester.id });
    return { memory: candidate, result };
  });
}
