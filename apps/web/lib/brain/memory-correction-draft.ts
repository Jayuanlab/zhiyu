import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { brainMemories, brainObservations, brainStateSnapshots } from "@/lib/db/schema";
import type { DrizzleDB } from "@/lib/db/types";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import type { BrainMemory, BrainRequester } from "./types";
import { brainMemoryFromRow, brainObservationToInsertRow } from "./repository";
import { getBrainMemoryRevisionVersion } from "./memory-revision-version";
import { acquireBrainWriteAdvisoryLock, getBrainMemoryCanonicalWriteLockKey } from "./memory-revision-lock";
import { BrainMemoryWriteBusy } from "./write-errors";
import { withBrainRecordWrite } from "./write-guard";
import {
  BRAIN_MEMORY_CORRECTION_DRAFT_SOURCE, BRAIN_MEMORY_CORRECTION_DRAFT_TYPE, BRAIN_MEMORY_CORRECTION_INTENT_TYPE,
  BRAIN_MEMORY_CORRECTION_RULE_VERSION, CORRECTION_UUID, brainMemoryCorrectionRecordId,
  correctionDigest, correctionFail, correctionNow, correctionObject, correctionTextHash,
  getBrainMemoryCorrectionDraftVersion, parseBrainMemoryCorrectionDraftRequest, parseBrainMemoryCorrectionIntent,
  type BrainMemoryCorrectionDraft, type BrainMemoryCorrectionDraftReceipt, type BrainMemoryCorrectionDraftResult,
} from "./memory-correction-draft-common";
export * from "./memory-correction-draft-common";

function requireOwner(requester: BrainRequester) {
  // This capability is owner-UI only. A model requester or lease cannot impersonate review.
  if (requester.type !== "chat" || requester.id === "brain-mcp" || resolveExecutionLease())
    correctionFail("correction_owner_required", 403, "Only the owner may prepare a correction draft");
}
function targetId(value: unknown): string {
  if (typeof value !== "string" || !CORRECTION_UUID.test(value)) correctionFail("invalid_correction_draft", 400, "Invalid memoryId");
  return value.toLowerCase();
}
function commandId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) correctionFail("invalid_correction_draft", 400, "A bounded commandId is required");
  return value.trim();
}
async function withCorrectionLockErrors<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; cause && typeof cause === "object" && depth < 8; depth++) {
      if ((cause as { code?: unknown }).code === "55P03") throw new BrainMemoryWriteBusy();
      cause = (cause as { cause?: unknown }).cause;
    }
    throw error;
  }
}
function currentState(memory: BrainMemory, draft: BrainMemoryCorrectionDraft): BrainMemoryCorrectionDraftResult["current"] {
  const version = getBrainMemoryRevisionVersion(memory), versionMatches = version === draft.expectedVersion;
  const inactive = memory.status === "deleted" || memory.status === "superseded";
  const pending = correctionObject(memory.metadata?.updateProposal).status === "pending";
  return { memoryId: memory.id, version, status: memory.status, expiresAt: memory.expiresAt ?? null,
    versionMatches, canSeed: versionMatches && !inactive && !pending };
}
async function readMemory(store: DrizzleDB, userId: string, memoryId: string, canonicalLock: boolean): Promise<BrainMemory> {
  const where = and(eq(brainMemories.userId, userId), eq(brainMemories.id, memoryId));
  if (canonicalLock) {
    const [before] = await store.select().from(brainMemories).where(where);
    if (!before) correctionFail("memory_not_found", 404, "Memory is unavailable");
    await acquireBrainWriteAdvisoryLock(store, getBrainMemoryCanonicalWriteLockKey(brainMemoryFromRow(before)));
  }
  const [row] = await store.select().from(brainMemories).where(where).for("share", { noWait: true });
  if (!row) correctionFail("memory_not_found", 404, "Memory is unavailable");
  return brainMemoryFromRow(row);
}
async function readSavedDraft(store: DrizzleDB, userId: string, memoryId: string, command: string, expectedRequestHash?: string): Promise<{ draft: BrainMemoryCorrectionDraft; receipt: BrainMemoryCorrectionDraftReceipt } | null> {
  const id = brainMemoryCorrectionRecordId(userId, command, "draft");
  const [row] = await store.select().from(brainStateSnapshots).where(and(eq(brainStateSnapshots.userId, userId), eq(brainStateSnapshots.id, id)));
  if (!row) return null;
  const metadata = correctionObject(row.metadata), content = correctionObject(row.content);
  if (row.snapshotType !== BRAIN_MEMORY_CORRECTION_DRAFT_TYPE || metadata.source !== BRAIN_MEMORY_CORRECTION_DRAFT_SOURCE)
    correctionFail("draft_record_unavailable", 503, "Stored correction draft cannot be verified");
  if (expectedRequestHash && metadata.requestHash !== expectedRequestHash)
    correctionFail("draft_command_conflict", 409, "commandId already identifies a different correction draft");
  const draft = content.draft as BrainMemoryCorrectionDraft | undefined;
  const receipt = content.receipt as BrainMemoryCorrectionDraftReceipt | undefined;
  if (!draft || !receipt || draft.id !== id || draft.commandId !== command || draft.memoryId !== memoryId ||
      receipt.id !== brainMemoryCorrectionRecordId(userId, command, "receipt") || receipt.draftId !== id ||
      receipt.commandId !== command || receipt.memoryId !== memoryId || receipt.expectedVersion !== draft.expectedVersion ||
      receipt.observationId !== brainMemoryCorrectionRecordId(userId, command, "observation") || receipt.effective !== false ||
      draft.provider !== "deterministic_rules" || typeof draft.intent !== "string" || !draft.intent.trim() || draft.intent.length > 4000 ||
      draft.authority !== null || draft.sourceObservedAt !== null || !Number.isFinite(Date.parse(draft.createdAt)) || receipt.createdAt !== draft.createdAt ||
      !Array.isArray(draft.evidenceRefs) || draft.evidenceRefs.length !== 1 || draft.evidenceRefs[0] !== `brain-observation:${receipt.observationId}` ||
      getBrainMemoryCorrectionDraftVersion(draft) !== receipt.draftVersion ||
      metadata.requestHash !== correctionDigest({ memoryId, commandId: command, expectedVersion: draft.expectedVersion, intent: draft.intent }))
    correctionFail("draft_record_unavailable", 503, "Stored correction draft cannot be verified");
  // The server's raw observation is mandatory, not an arbitrary caller evidence ref.
  const [observation] = await store.select().from(brainObservations).where(and(eq(brainObservations.userId, userId), eq(brainObservations.id, receipt.observationId)));
  const observationMetadata = correctionObject(observation?.metadata);
  if (!observation || observation.sourceType !== BRAIN_MEMORY_CORRECTION_INTENT_TYPE || observation.sourceId !== command ||
      observation.content !== draft.intent || observation.contentHash !== correctionTextHash(draft.intent) ||
      observationMetadata.source !== BRAIN_MEMORY_CORRECTION_DRAFT_SOURCE || observationMetadata.memoryId !== memoryId ||
      observationMetadata.expectedVersion !== draft.expectedVersion || observationMetadata.provesOwnerSubmissionOnly !== true || observationMetadata.independentlyVerifiesBusinessFact !== false)
    correctionFail("draft_source_unavailable", 503, "Original owner correction statement is unavailable or cannot be verified");
  const quote = draft.quote;
  if (quote && (!Number.isSafeInteger(quote.start) || !Number.isSafeInteger(quote.end) || quote.start < 0 || quote.end <= quote.start ||
      quote.end > draft.intent.length || draft.intent.slice(quote.start, quote.end) !== quote.text))
    correctionFail("draft_record_unavailable", 503, "Stored correction quote does not match the original statement");
  if (!Array.isArray(draft.questions) || !Array.isArray(draft.warnings) ||
      draft.questions.some(value => typeof value !== "string") || draft.warnings.some(value => typeof value !== "string") ||
      draft.outcome === "ready" && (!quote || !["correct", "supplement", "state_change", "deactivate"].includes(String(draft.operation)) ||
        typeof draft.reason !== "string" || !draft.reason.trim() || draft.questions.length !== 0 ||
        (draft.operation === "deactivate" ? draft.content !== null : typeof draft.content !== "string" || draft.content !== quote.text)) ||
      draft.outcome === "needs_clarification" && (draft.operation !== null || draft.content !== null || draft.reason !== null || draft.questions.length === 0) ||
      !["ready", "needs_clarification"].includes(draft.outcome))
    correctionFail("draft_record_unavailable", 503, "Stored correction interpretation cannot be verified");
  return { draft, receipt };
}

export async function createBrainMemoryCorrectionDraft(input: { requester: BrainRequester; memoryId: string; request: unknown; now?: Date }): Promise<BrainMemoryCorrectionDraftResult> {
  requireOwner(input.requester);
  const memoryId = targetId(input.memoryId), request = parseBrainMemoryCorrectionDraftRequest(input.request), now = correctionNow(input.now);
  const userId = input.requester.userId;
  const requestHash = correctionDigest({ memoryId, ...request });
  return withCorrectionLockErrors(() => withBrainRecordWrite<BrainMemoryCorrectionDraftResult>(userId, "snapshot", async store => {
    await acquireBrainWriteAdvisoryLock(store, JSON.stringify([BRAIN_MEMORY_CORRECTION_DRAFT_SOURCE, "command", userId, request.commandId]));
    // Replay identity is checked before current version. Saved drafts remain historical.
    const replay = await readSavedDraft(store, userId, memoryId, request.commandId, requestHash);
    const memory = await readMemory(store, userId, memoryId, true);
    if (replay) return { id: replay.draft.id, result: { ...replay, current: currentState(memory, replay.draft), replayed: true }, written: false };
    if (getBrainMemoryRevisionVersion(memory) !== request.expectedVersion) correctionFail("version_conflict", 409, "Memory changed; read the current version before preparing another draft");
    if (memory.status === "deleted" || memory.status === "superseded") correctionFail("memory_inactive", 409, "Retired memories require their current version or the explicit restore workflow");
    if (correctionObject(memory.metadata?.updateProposal).status === "pending") correctionFail("memory_update_decision_required", 409, "Resolve the pending proposal through its own decision workflow");
    const observationId = brainMemoryCorrectionRecordId(userId, request.commandId, "observation");
    const draftId = brainMemoryCorrectionRecordId(userId, request.commandId, "draft");
    const createdAt = now.toISOString();
    const draft: BrainMemoryCorrectionDraft = { ...parseBrainMemoryCorrectionIntent(memory.content, request.intent), id: draftId,
      commandId: request.commandId, memoryId, expectedVersion: request.expectedVersion, intent: request.intent,
      evidenceRefs: [`brain-observation:${observationId}`], createdAt };
    const receipt: BrainMemoryCorrectionDraftReceipt = { id: brainMemoryCorrectionRecordId(userId, request.commandId, "receipt"), commandId: request.commandId,
      memoryId, expectedVersion: request.expectedVersion, draftId, observationId, draftVersion: getBrainMemoryCorrectionDraftVersion(draft), createdAt, effective: false };
    await store.insert(brainObservations).values(brainObservationToInsertRow({ id: observationId, userId, sourceType: BRAIN_MEMORY_CORRECTION_INTENT_TYPE,
      sourceId: request.commandId, observedAt: now, content: request.intent, contentHash: correctionTextHash(request.intent), trustLevel: "owner_assertion",
      metadata: { source: BRAIN_MEMORY_CORRECTION_DRAFT_SOURCE, memoryId, expectedVersion: request.expectedVersion,
        submittedAt: createdAt, provesOwnerSubmissionOnly: true, independentlyVerifiesBusinessFact: false } })).returning();
    const scopeId = memory.scope.type === "global" ? null : memory.scope.type === "work" ? memory.scope.workId
      : memory.scope.type === "workshop" ? memory.scope.workshopId : memory.scope.workspaceId;
    await store.insert(brainStateSnapshots).values({ id: draftId, userId, scopeType: memory.scope.type, scopeId,
      snapshotType: BRAIN_MEMORY_CORRECTION_DRAFT_TYPE, content: { draft, receipt }, sourceMemoryIds: [memoryId],
      metadata: { source: BRAIN_MEMORY_CORRECTION_DRAFT_SOURCE, parserVersion: BRAIN_MEMORY_CORRECTION_RULE_VERSION, commandId: request.commandId,
        requestHash, observationId, actor: { type: "chat", id: input.requester.id ?? null }, independentlyVerifiesBusinessFact: false, changesEffectiveMemory: false }, createdAt: now }).returning();
    return { id: draftId, result: { draft, receipt, current: currentState(memory, draft), replayed: false }, written: true };
  }));
}

export async function getBrainMemoryCorrectionDraft(input: { requester: BrainRequester; memoryId: string; commandId: string }): Promise<BrainMemoryCorrectionDraftResult> {
  requireOwner(input.requester);
  const memoryId = targetId(input.memoryId), command = commandId(input.commandId);
  return withCorrectionLockErrors(() => db.transaction(async (store: DrizzleDB) => {
    const saved = await readSavedDraft(store, input.requester.userId, memoryId, command);
    if (!saved) correctionFail("draft_not_found", 404, "Correction draft was not found");
    const memory = await readMemory(store, input.requester.userId, memoryId, false);
    return { ...saved, current: currentState(memory, saved.draft), replayed: true };
  }));
}
