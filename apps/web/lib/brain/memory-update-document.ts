import { and, desc, eq, sql } from "drizzle-orm";
import { brainMemories, brainObservations, workshopEvents, workshopSources, workshops } from "@/lib/db/schema";
import { brainMemoryFromRow, brainMemoryToInsertRow, brainObservationToInsertRow } from "./repository";
import { withBrainMemoryTransaction } from "./write-guard";
import { acquireBrainWriteAdvisoryLock, brainWriteRowLockOptions, getBrainMemoryCanonicalWriteLockKey } from "./memory-revision-lock";
import { getBrainMemoryRevisionVersion } from "./memory-revision-version";
import { recordMemoryChangeInTransaction } from "./memory-dependencies";
import { createBrainMemoryUpdateProposalInTransaction } from "./memory-update-proposal";
import { lockBrainMemoryAutoUpdatePolicy, readBrainMemoryAutoUpdatePolicy } from "./memory-update-policy";
import { commandReplay, digest, fail, nonempty, nowDate, object, readCurrentMemorySuccessor, recordUpdateReceipt, updateRecordId, UUID, versioned } from "./memory-update-common";
import type { BrainMemory } from "./types";
export const DOCUMENT_MEMORY_UPDATE_POLICY_VERSION = "document-program-facts.v1";
export type DocumentMemoryUpdateInput = {
    userId: string;
    workId: string;
    sourceId: string;
    sourceEventId: string;
    sourceEventSeq: number;
    observedAt: string | Date;
    sourceSha256: string;
    documentSha256: string;
    manifestSha256: string;
    sourceFormat: string;
    chunkCount: number;
    warnings: string[];
    sourceName?: string;
    now?: Date;
};
type DocumentMemoryReceipt = {
    id: string;
    commandId: string;
    status: string;
    effective: boolean;
    createdAt: string;
    historical?: boolean;
};
type DocumentVersionedMemory = ReturnType<typeof versioned>;
export type DocumentMemoryUpdateResult = { reason?: string } & (
    { status: "created_active" | "replaced_active" | "noop" | "candidate"; memory: DocumentVersionedMemory; replayed: false; receipt: DocumentMemoryReceipt; baseMemoryId?: string | null }
    | { status: "skipped"; memory: DocumentVersionedMemory | null; replayed: false; receipt: DocumentMemoryReceipt }
    | { status: "replayed"; memory: DocumentVersionedMemory; replayed: true; receipt: DocumentMemoryReceipt; historicalReceipt: DocumentMemoryReceipt; currentEffective: boolean; currentReadAt: string }
    | (Awaited<ReturnType<typeof createBrainMemoryUpdateProposalInTransaction>> & { status: "pending_conflict"; reason: string })
);
/** Internal trusted conversion adapter. No HTTP or model input can request this authority. */
export async function applyDocumentMemoryUpdate(input: DocumentMemoryUpdateInput): Promise<DocumentMemoryUpdateResult> {
    const now = nowDate(input.now);
    if (![input.userId, input.workId, input.sourceId, input.sourceEventId].every(id => typeof id === "string" && UUID.test(id)))
        fail("invalid_document_evidence", 400, "Invalid document source identity");
    if (![input.sourceSha256, input.documentSha256, input.manifestSha256].every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)))
        fail("invalid_document_evidence", 400, "Document hashes must be SHA-256 values");
    if (!Number.isSafeInteger(input.sourceEventSeq) || input.sourceEventSeq < 1 || !Number.isSafeInteger(input.chunkCount) || input.chunkCount < 1 || input.chunkCount > 100000)
        fail("invalid_document_evidence", 400, "Invalid source sequence or chunk count");
    const sourceFormat = nonempty(input.sourceFormat, "sourceFormat", 80);
    if (!Array.isArray(input.warnings) || input.warnings.length > 100 || input.warnings.some(w => typeof w !== "string" || w.length > 2000))
        fail("invalid_document_evidence", 400, "Invalid document warnings");
    const observedAt = new Date(input.observedAt);
    if (!Number.isFinite(observedAt.getTime()))
        fail("invalid_document_evidence", 400, "Invalid document observation time");
    const commandId = `document:${input.sourceEventId}:${DOCUMENT_MEMORY_UPDATE_POLICY_VERSION}`;
    const facts = { sourceId: input.sourceId, sourceFormat, sourceSha256: input.sourceSha256, documentSha256: input.documentSha256, manifestSha256: input.manifestSha256, chunkCount: input.chunkCount };
    const requestHash = digest({ workId: input.workId, sourceEventId: input.sourceEventId, sourceEventSeq: input.sourceEventSeq, observedAt: observedAt.toISOString(), facts, warnings: input.warnings });
    const slot = `document-program:${input.workId}:${input.sourceId}`;
    const skeleton: BrainMemory = { id: updateRecordId(input.userId, commandId, "document"), userId: input.userId, scope: { type: "work", workId: input.workId }, ownerType: "work", ownerId: input.workId, memoryType: "insight", subject: "Document conversion program facts", content: JSON.stringify(facts), status: "candidate", confidence: 100, evidenceRefs: [input.sourceEventId], createdAt: now.toISOString(), updatedAt: now.toISOString(), metadata: { canonicalKind: "state", canonicalGroupId: slot } };
    return withBrainMemoryTransaction<DocumentMemoryUpdateResult>(input.userId, async (store) => {
        // Pause commands and automatic activation share this lock; grants remain unchanged.
        await lockBrainMemoryAutoUpdatePolicy(store, input.userId);
        const replay = await commandReplay(store, input.userId, commandId, requestHash);
        if (replay) {
            await acquireBrainWriteAdvisoryLock(store, getBrainMemoryCanonicalWriteLockKey(skeleton));
            const memory = await readCurrentMemorySuccessor(store, replay.memory ?? replay.candidate);
            const currentEffective = ["active", "verified", "weakened"].includes(memory.status) && (!memory.expiresAt || Number.isFinite(Date.parse(memory.expiresAt)) && Date.parse(memory.expiresAt) > now.getTime());
            const result: DocumentMemoryUpdateResult = { status: "replayed", replayed: true, memory: versioned(memory), currentEffective, currentReadAt: now.toISOString(), historicalReceipt: replay.receipt,
                receipt: { ...replay.receipt, historical: true, status: "replayed", effective: currentEffective } };
            return { memory, result, written: false };
        }
        const [work] = await store.select({ id: workshops.id }).from(workshops).where(and(eq(workshops.id, input.workId), eq(workshops.userId, input.userId))).for("share");
        const [source] = await store.select().from(workshopSources).where(and(eq(workshopSources.id, input.sourceId), eq(workshopSources.workshopId, input.workId))).for("share");
        const [event] = await store.select().from(workshopEvents).where(and(eq(workshopEvents.id, input.sourceEventId), eq(workshopEvents.workshopId, input.workId))).for("share");
        const sourceMeta = object(source?.config), eventMeta = object(event?.metadata);
        if (!work || !source || source.type !== "file" || !source.enabled || sourceMeta.scope === "conversation" || !event || event.type !== "document_converted" || event.seq !== input.sourceEventSeq || new Date(event.createdAt).getTime() !== observedAt.getTime() || eventMeta.receiptAuthority !== "runtime" || eventMeta.sourceId !== input.sourceId || eventMeta.sourceSha256 !== input.sourceSha256 || eventMeta.documentSha256 !== input.documentSha256 || eventMeta.manifestSha256 !== input.manifestSha256 || eventMeta.sourceFormat !== sourceFormat || eventMeta.chunkCount !== input.chunkCount || JSON.stringify(eventMeta.warnings ?? []) !== JSON.stringify(input.warnings))
            fail("document_evidence_not_authorized", 403, "Only a matching runtime conversion of an enabled persistent source can update memory");
        await acquireBrainWriteAdvisoryLock(store, getBrainMemoryCanonicalWriteLockKey(skeleton));
        const rows = await store.select().from(brainMemories).where(and(eq(brainMemories.userId, input.userId), eq(brainMemories.ownerType, "work"), eq(brainMemories.ownerId, input.workId), eq(brainMemories.scopeType, "work"), eq(brainMemories.scopeId, input.workId), eq(brainMemories.canonicalGroupId, slot))).orderBy(desc(brainMemories.updatedAt), desc(brainMemories.id)).for("update", brainWriteRowLockOptions());
        const memories: BrainMemory[] = rows.map((row: any) => brainMemoryFromRow(row));
        const base = memories.find(m => m.status !== "superseded" && object(m.metadata?.updateProposal).status !== "pending" && object(m.metadata?.updateProposal).status !== "rejected");
        const active = memories.filter(m => ["active", "verified", "weakened"].includes(m.status));
        if (active.length > 1)
            fail("document_slot_conflict", 409, "Document memory slot has multiple current versions; owner review is required");
        const policy = await readBrainMemoryAutoUpdatePolicy(store, input.userId);
        const [latestSourceEvent] = await store.select({ seq: workshopEvents.seq }).from(workshopEvents).where(and(eq(workshopEvents.workshopId, input.workId), eq(workshopEvents.type, "document_converted"), sql `${workshopEvents.metadata}->>'sourceId' = ${input.sourceId}`, sql `${workshopEvents.metadata}->>'receiptAuthority' = 'runtime'`)).orderBy(desc(workshopEvents.seq)).limit(1);
        const lastSequence = Math.max(0, ...memories.map(m => Number(object(m.metadata?.documentProgramUpdate).sourceEventSeq) || 0));
        const lastObserved = Math.max(0, ...memories.map(m => {
            const metadata = object(m.metadata?.documentProgramUpdate);
            return metadata.appliedAsReliableVersion === true ? Date.parse(String(metadata.observedAt ?? "")) || 0 : 0;
        }));
        const pinned = !!base && (base.status === "deleted" || base.status === "superseded" || !!base.metadata?.revisionRetired || !!base.metadata?.revision && object(base.metadata.revision).createdBy !== "document_adapter");
        let reason: string | undefined;
        if (input.sourceEventSeq <= lastSequence || input.sourceEventSeq < (latestSourceEvent?.seq ?? input.sourceEventSeq))
            reason = "non_monotonic_source";
        else if (pinned)
            reason = "owner_pinned";
        else if (observedAt.getTime() < lastObserved)
            reason = "non_monotonic_source";
        else if (observedAt.getTime() > now.getTime() || now.getTime() - observedAt.getTime() > 5 * 60000)
            reason = "stale_or_future_source";
        if (!reason && base?.expiresAt && (!Number.isFinite(new Date(base.expiresAt).getTime()) || new Date(base.expiresAt).getTime() <= now.getTime()))
            reason = "memory_expired";
        if (!reason && !policy.enabled)
            reason = "automatic_updates_paused";
        if (!reason && input.warnings.length)
            reason = "document_conversion_warnings";
        const documentMetadata = { policyVersion: DOCUMENT_MEMORY_UPDATE_POLICY_VERSION, sourceEventId: input.sourceEventId, sourceEventSeq: input.sourceEventSeq, observedAt: observedAt.toISOString(), appliedAsReliableVersion: !reason, ...facts, warnings: input.warnings, sourceName: source.name, independentlyVerifiesDocumentClaims: false };
        if (reason === "non_monotonic_source") {
            const memory = base ?? skeleton;
            const result: DocumentMemoryUpdateResult = { status: "skipped", reason, memory: base ? versioned(base) : null, replayed: false, receipt: { id: updateRecordId(input.userId, commandId), commandId, effective: false, status: "skipped", createdAt: now.toISOString() } };
            // No fabricated memory is persisted. Existing slots can retain a durable ignored-event receipt.
            if (base)
                await recordUpdateReceipt(store, { userId: input.userId, commandId, requestHash, memory: base, result, now, reason });
            return { memory, result, written: !!base };
        }
        if (base && reason) {
            const result = await createBrainMemoryUpdateProposalInTransaction(store, { requester: { type: "system", userId: input.userId, id: "document-program-adapter" }, base, request: { targetMemoryId: base.id, expectedVersion: getBrainMemoryRevisionVersion(base), commandId, content: skeleton.content, reason, evidenceRefs: [input.sourceEventId] }, now, requestHash, candidateMetadata: { documentProgramUpdate: documentMetadata, observationTime: observedAt.toISOString(), observationTimeUnknown: false }, resultMetadata: { status: "pending_conflict", reason } });
            return { memory: result.candidate, result: { ...result, status: "pending_conflict", reason }, written: true };
        }
        const sameValue = !!base && ["active", "verified"].includes(base.status) && base.content === skeleton.content;
        if (sameValue && !reason) {
            const result: DocumentMemoryUpdateResult = { status: "noop", memory: versioned(base!), replayed: false, receipt: { id: updateRecordId(input.userId, commandId), commandId, status: "noop", effective: true, createdAt: now.toISOString() } };
            await recordUpdateReceipt(store, { userId: input.userId, commandId, requestHash, memory: base!, result, now, reason: "Matching program facts already active" });
            return { memory: base!, result, written: true };
        }
        const memory: BrainMemory = { ...skeleton, status: reason ? "candidate" : "active", expiresAt: base?.expiresAt, supersedes: base ? [base.id] : [], metadata: { ...skeleton.metadata, observationTime: observedAt.toISOString(), observationTimeUnknown: false, documentProgramUpdate: documentMetadata,
                revision: { operation: "state_change", commandId, createdBy: "document_adapter", authority: "program_fact", previousMemoryId: base?.id ?? null, previousVersion: base ? getBrainMemoryRevisionVersion(base) : null, rootMemoryId: object(base?.metadata?.revision).rootMemoryId ?? skeleton.id, sequence: (Number(object(base?.metadata?.revision).sequence) || 0) + 1, reason: reason ?? "Verified conversion program facts", createdAt: now.toISOString(), assertionEvidenceRefs: [], independentlyVerifiesBusinessFact: false } } };
        await store.insert(brainObservations).values(brainObservationToInsertRow({ id: updateRecordId(input.userId, commandId, "observation"), userId: input.userId, sourceType: "document_program_fact", sourceId: input.sourceEventId, sourceEventId: input.sourceEventId, observedAt, content: JSON.stringify(facts), contentHash: digest(facts), trustLevel: "program_fact", metadata: { sourceEventId: input.sourceEventId, independentlyVerifiesDocumentClaims: false } })).returning();
        const [created] = await store.insert(brainMemories).values(brainMemoryToInsertRow(memory)).returning();
        const written = brainMemoryFromRow(created);
        if (base) {
            const [retired] = await store.update(brainMemories).set({ status: "superseded", updatedAt: now, metadata: { ...base.metadata, revisionRetired: { operation: "state_change", createdBy: "document_adapter", commandId, nextMemoryId: written.id, previousVersion: getBrainMemoryRevisionVersion(base), createdAt: now.toISOString(), reason: "New verified conversion program version" } } }).where(and(eq(brainMemories.userId, input.userId), eq(brainMemories.id, base.id))).returning();
            await recordMemoryChangeInTransaction(store, { beforeMemory: base, afterMemory: brainMemoryFromRow(retired), replacementMemory: written, commandId, reason: "New verified conversion program version", now, reviewId: updateRecordId(input.userId, commandId) });
        }
        const result: DocumentMemoryUpdateResult = { status: reason ? "candidate" : base ? "replaced_active" : "created_active", ...(reason ? { reason } : {}), memory: versioned(written), baseMemoryId: base?.id ?? null, replayed: false, receipt: { id: updateRecordId(input.userId, commandId), commandId, status: reason ? "candidate" : "applied", effective: !reason, createdAt: now.toISOString() } };
        await recordUpdateReceipt(store, { userId: input.userId, commandId, requestHash, memory: written, result, now, reason: reason ?? "Verified conversion program facts" });
        return { memory: written, result, written: true };
    });
}
