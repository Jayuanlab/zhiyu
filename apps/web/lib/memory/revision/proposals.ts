import { observationToInsertRow as brainObservationToInsertRow } from "../records/observations";
import { qualifyLessonSources } from "../adapters/postgres/lesson-sources";
import { extractedLessonOmitReason } from "../records/lesson-extraction";
import { getBrainMemoryById } from "../adapters/postgres/memory-records";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { brainAccessGrants, brainMemories, brainObservations } from "@/lib/db/schema";
import type { DrizzleDB } from "@/lib/db/types";
import { brainAccessGrantFromRow, brainMemoryFromRow, brainMemoryToInsertRow } from "../records/memory-record";
import { canWriteMemory } from "./policy";
import { withBrainMemoryTransaction } from "./transaction";
import { acquireBrainWriteAdvisoryLock, brainWriteRowLockOptions, getBrainMemoryCanonicalWriteLockKey } from "./locks";
import { getBrainMemoryRevisionVersion } from "./version";
import { recordMemoryChangeInTransaction } from "./dependencies";
import type { BrainMemory, BrainRequester } from "../kernel/memory-types";
import { commandReplay, digest, fail, nonempty, nowDate, object, recordUpdateReceipt, refs, sameIdentity, updateRecordId, UUID, version, versioned } from "./common";
export { BrainMemoryUpdateError } from "./common";
export type BrainMemoryUpdateRequest = {
    targetMemoryId: string;
    expectedVersion: string;
    commandId: string;
    content: string;
    reason: string;
    evidenceRefs: string[];
};
export function parseBrainMemoryUpdateRequest(value: unknown): BrainMemoryUpdateRequest {
    const b = object(value);
    if (Object.keys(b).some(k => !["targetMemoryId", "expectedVersion", "commandId", "content", "reason", "evidenceRefs"].includes(k)))
        fail("invalid_update", 400, "Update cannot change identity, status or metadata");
    if (typeof b.targetMemoryId !== "string" || !UUID.test(b.targetMemoryId))
        fail("invalid_update", 400, "Invalid targetMemoryId");
    return { targetMemoryId: b.targetMemoryId.toLowerCase(), expectedVersion: version(b.expectedVersion), commandId: nonempty(b.commandId, "commandId", 200), content: nonempty(b.content, "content", 12000), reason: nonempty(b.reason, "reason", 2000), evidenceRefs: refs(b.evidenceRefs) };
}
function proposal(memory: BrainMemory) { return object(memory.metadata?.updateProposal); }
async function authorize(store: DrizzleDB, requester: BrainRequester, base: BrainMemory, now: Date) {
    if (requester.type === "chat" && requester.id !== "brain-mcp")
        return;
    const grants = await store.select().from(brainAccessGrants).where(eq(brainAccessGrants.userId, requester.userId)).for("share");
    if (!canWriteMemory({ request: { requester, targetScope: base.scope, ownerType: base.ownerType, ownerId: base.ownerId, memoryType: base.memoryType, status: "candidate", confidence: base.confidence, evidenceRefs: base.evidenceRefs }, grants: grants.map(brainAccessGrantFromRow), now }).allowed)
        fail("update_not_allowed", 403, "Requester cannot propose updates for this memory");
}
async function lockBase(store: DrizzleDB, userId: string, id: string) {
    const where = and(eq(brainMemories.userId, userId), eq(brainMemories.id, id));
    const [before] = await store.select().from(brainMemories).where(where);
    if (!before)
        fail("memory_not_found", 404, "Brain memory not found");
    const key = getBrainMemoryCanonicalWriteLockKey(brainMemoryFromRow(before));
    await acquireBrainWriteAdvisoryLock(store, key);
    const [row] = await store.select().from(brainMemories).where(where).for("update", brainWriteRowLockOptions());
    if (!row)
        fail("memory_not_found", 404, "Brain memory not found");
    const memory = brainMemoryFromRow(row);
    if (getBrainMemoryCanonicalWriteLockKey(memory) !== key)
        fail("version_conflict", 409, "Memory identity changed; refresh");
    return memory;
}
export async function createBrainMemoryUpdateProposalInTransaction(store: DrizzleDB, input: {
    requester: BrainRequester;
    base: BrainMemory;
    request: BrainMemoryUpdateRequest;
    now: Date;
    requestHash: string;
    candidateMetadata?: Record<string, unknown>;
    resultMetadata?: Record<string, unknown>;
}) {
    const { base, request, now, requester } = input;
    const assertions = new Set(refs(object(base.metadata?.revision).assertionEvidenceRefs));
    const evidenceRefs = [...new Set([...base.evidenceRefs, ...request.evidenceRefs].filter(ref => !assertions.has(ref)))];
    if (evidenceRefs.length > 100)
        fail("invalid_update", 400, "At most 100 source references may be retained");
    const metadata = { ...base.metadata };
    delete metadata.revision;
    delete metadata.revisionRetired;
    delete metadata.updateProposal;
    const candidate: BrainMemory = { ...base, id: updateRecordId(base.userId, request.commandId, "candidate"), content: request.content, status: "candidate", evidenceRefs, supersedes: [], createdAt: now.toISOString(), updatedAt: now.toISOString(), metadata: { ...metadata, ...input.candidateMetadata,
            updateProposal: { status: "pending", targetMemoryId: base.id, expectedBaseVersion: request.expectedVersion, commandId: request.commandId, reason: request.reason, createdAt: now.toISOString(), proposedBy: requester.type, proposalObservationId: updateRecordId(base.userId, request.commandId, "observation") } } };
    const submission = JSON.stringify({ request, requester: { type: requester.type, id: requester.id }, independentlyVerifiesBusinessFact: false });
    await store.insert(brainObservations).values(brainObservationToInsertRow({ id: updateRecordId(base.userId, request.commandId, "observation"), userId: base.userId, sourceType: "memory_update_proposal", sourceId: request.commandId, observedAt: now, content: submission, contentHash: digest(submission), trustLevel: "proposal", metadata: { independentlyVerifiesBusinessFact: false } })).returning();
    const [row] = await store.insert(brainMemories).values(brainMemoryToInsertRow(candidate)).returning();
    const written = brainMemoryFromRow(row);
    const result = { ...input.resultMetadata, candidate: versioned(written), base: versioned(base), baseVersion: getBrainMemoryRevisionVersion(base), proposalVersion: getBrainMemoryRevisionVersion(written), replayed: false,
        receipt: { id: updateRecordId(base.userId, request.commandId), commandId: request.commandId, action: "propose", status: "proposed", candidateId: written.id, baseMemoryId: base.id, previousBaseVersion: request.expectedVersion, previousProposalVersion: null, baseVersion: getBrainMemoryRevisionVersion(base), proposalVersion: getBrainMemoryRevisionVersion(written), effective: false, createdAt: now.toISOString() } };
    await recordUpdateReceipt(store, { userId: base.userId, commandId: request.commandId, requestHash: input.requestHash, memory: written, result, now, reason: request.reason, reviewerType: requester.type, reviewerId: requester.id });
    return result;
}
export async function proposeBrainMemoryUpdate(input: {
    requester: BrainRequester;
    request?: unknown;
    targetMemoryId?: string;
    expectedVersion?: string;
    commandId?: string;
    content?: string;
    reason?: string;
    evidenceRefs?: string[];
    now?: Date;
}) {
    const request = parseBrainMemoryUpdateRequest(input.request ?? { targetMemoryId: input.targetMemoryId, expectedVersion: input.expectedVersion, commandId: input.commandId, content: input.content, reason: input.reason, evidenceRefs: input.evidenceRefs });
    const now = nowDate(input.now), requestHash = digest({ action: "propose", request, requester: { type: input.requester.type, id: input.requester.id } });
    return withBrainMemoryTransaction(input.requester.userId, async (store) => {
        const replay = await commandReplay(store, input.requester.userId, request.commandId, requestHash);
        if (replay) {
            if (input.requester.type !== "chat" || input.requester.id === "brain-mcp") {
                const currentBase = await lockBase(store, input.requester.userId, request.targetMemoryId);
                await authorize(store, input.requester, currentBase, now);
            }
            return { memory: replay.candidate, result: replay, written: false };
        }
        const base = await lockBase(store, input.requester.userId, request.targetMemoryId);
        if (getBrainMemoryRevisionVersion(base) !== request.expectedVersion)
            fail("version_conflict", 409, "Base memory changed; refresh before proposing");
        if (proposal(base).status === "pending")
            fail("invalid_target", 409, "A pending proposal cannot be used as an update base");
        await authorize(store, input.requester, base, now);
        const result = await createBrainMemoryUpdateProposalInTransaction(store, { requester: input.requester, base, request, now, requestHash });
        return { memory: result.candidate, result, written: true };
    });
}
export async function getBrainMemoryUpdate(input: {
    userId: string;
    proposalId: string;
}) {
    if (!UUID.test(input.proposalId))
        fail("invalid_update", 400, "Invalid proposalId");
    const candidate = await getBrainMemoryById({ userId: input.userId, memoryId: input.proposalId });
    if (!candidate || !proposal(candidate).targetMemoryId)
        fail("proposal_not_found", 404, "Memory update proposal not found");
    const meta = proposal(candidate), base = await getBrainMemoryById({ userId: input.userId, memoryId: meta.targetMemoryId });
    if (!base || !sameIdentity(candidate, base))
        fail("proposal_not_found", 404, "Proposal base is unavailable");
    return { candidate: versioned(candidate), proposalVersion: getBrainMemoryRevisionVersion(candidate), base: versioned(base), baseVersion: getBrainMemoryRevisionVersion(base), proposal: meta };
}
export async function listBrainMemoryUpdates(input: {
    userId: string;
    ownerType?: string;
    ownerId?: string;
    limit?: number;
}): Promise<Array<BrainMemory & {
    revisionVersion: string;
}>> {
    const conditions = [eq(brainMemories.userId, input.userId), eq(brainMemories.status, "candidate"), sql `(${brainMemories.metadata}->>'updateProposal') IS NOT NULL`, sql `(${brainMemories.metadata}->'updateProposal'->>'status') = 'pending'`];
    if (input.ownerType)
        conditions.push(eq(brainMemories.ownerType, input.ownerType));
    if (input.ownerId)
        conditions.push(eq(brainMemories.ownerId, input.ownerId));
    const rows = await db.select().from(brainMemories).where(and(...conditions)).orderBy(desc(brainMemories.updatedAt), desc(brainMemories.id)).limit(Math.max(1, Math.min(100, input.limit ?? 20)));
    return rows.map((row: any) => versioned(brainMemoryFromRow(row)));
}
export async function findPendingBrainMemoryUpdates(input: {
    userId: string;
    baseMemoryIds: string[];
}) {
    if (!input.baseMemoryIds.length)
        return [];
    const ids = [...new Set(input.baseMemoryIds)].slice(0, 100);
    const bases = await db.select().from(brainMemories).where(and(eq(brainMemories.userId, input.userId), inArray(brainMemories.id, ids)));
    const pairs = bases.map((row: any) => { const base = brainMemoryFromRow(row); return and(sql `${brainMemories.metadata}->'updateProposal'->>'targetMemoryId' = ${base.id}`, sql `${brainMemories.metadata}->'updateProposal'->>'expectedBaseVersion' = ${getBrainMemoryRevisionVersion(base)}`); });
    if (!pairs.length)
        return [];
    // Deduplicate target/version before limiting so a noisy base cannot hide other conflicts.
    const target = sql<string> `${brainMemories.metadata}->'updateProposal'->>'targetMemoryId'`, expected = sql<string> `${brainMemories.metadata}->'updateProposal'->>'expectedBaseVersion'`;
    return await db.select({ targetMemoryId: target, expectedBaseVersion: expected }).from(brainMemories).where(and(eq(brainMemories.userId, input.userId), eq(brainMemories.status, "candidate"), sql `${brainMemories.metadata}->'updateProposal'->>'status' = 'pending'`, or(...pairs))).groupBy(target, expected).limit(100) as Array<{
        targetMemoryId: string;
        expectedBaseVersion: string;
    }>;
}
export async function decideBrainMemoryUpdate(input: {
    requester: BrainRequester;
    proposalId: string;
    request: unknown;
    now?: Date;
}) {
    if (input.requester.type !== "chat")
        fail("owner_decision_required", 403, "Only the owner may accept or reject memory updates");
    if (!UUID.test(input.proposalId))
        fail("invalid_update", 400, "Invalid proposalId");
    const b = object(input.request);
    if (Object.keys(b).some(k => !["action", "commandId", "expectedVersion", "expectedBaseVersion", "reason", "evidenceConfirmed"].includes(k)))
        fail("invalid_update", 400, "Invalid decision fields");
    if (b.action !== "accept" && b.action !== "reject")
        fail("invalid_update", 400, "Invalid update decision");
    const request = { action: b.action, commandId: nonempty(b.commandId, "commandId", 200), expectedVersion: version(b.expectedVersion), expectedBaseVersion: version(b.expectedBaseVersion, "expectedBaseVersion"), reason: nonempty(b.reason, "reason", 2000), evidenceConfirmed: b.evidenceConfirmed === true };
    if (request.action === "accept" && !request.evidenceConfirmed)
        fail("evidence_verification_required", 400, "Acceptance requires explicit source verification");
    const now = nowDate(input.now), requestHash = digest({ proposalId: input.proposalId.toLowerCase(), request });
    return withBrainMemoryTransaction(input.requester.userId, async (store) => {
        const replay = await commandReplay(store, input.requester.userId, request.commandId, requestHash);
        if (replay)
            return { memory: replay.candidate, result: replay, written: false };
        const [preview] = await store.select().from(brainMemories).where(and(eq(brainMemories.userId, input.requester.userId), eq(brainMemories.id, input.proposalId)));
        if (!preview)
            fail("proposal_not_found", 404, "Memory update proposal not found");
        const target = proposal(brainMemoryFromRow(preview)).targetMemoryId;
        if (typeof target !== "string")
            fail("proposal_not_found", 404, "Memory update proposal not found");
        const base = await lockBase(store, input.requester.userId, target);
        const where = and(eq(brainMemories.userId, input.requester.userId), eq(brainMemories.id, input.proposalId));
        const [row] = await store.select().from(brainMemories).where(where).for("update", brainWriteRowLockOptions());
        const candidate = brainMemoryFromRow(row), meta = proposal(candidate);
        if (request.action === "accept" && candidate.metadata?.lessonExtraction) {
            await qualifyLessonSources(store, input.requester.userId, [candidate], true);
            if (extractedLessonOmitReason(candidate) || candidate.expiresAt && Date.parse(candidate.expiresAt) <= now.getTime())
                fail("lesson_source_changed_or_expired", 409, "Extract a new current source-linked lesson before accepting this update");
        }
        if (!sameIdentity(base, candidate) || meta.targetMemoryId !== base.id)
            fail("update_not_allowed", 403, "Proposal ownership does not match base");
        if (meta.status !== "pending" || candidate.status !== "candidate")
            fail("proposal_closed", 409, "Proposal was already resolved");
        if (getBrainMemoryRevisionVersion(candidate) !== request.expectedVersion || getBrainMemoryRevisionVersion(base) !== request.expectedBaseVersion || request.action === "accept" && meta.expectedBaseVersion !== request.expectedBaseVersion)
            fail("version_conflict", 409, "Candidate or base changed; inspect both versions before deciding");
        if (request.action === "accept" && (base.status === "deleted" || base.status === "superseded" || base.expiresAt && new Date(base.expiresAt).getTime() <= now.getTime()))
            fail("memory_inactive", 409, "Inactive or expired bases require a new explicit revision");
        let nextBase = base;
        let evidenceRefs = candidate.evidenceRefs;
        const metadata = { ...candidate.metadata, updateProposal: { ...meta, status: request.action === "accept" ? "accepted" : "rejected", decisionCommandId: request.commandId, decisionReason: request.reason, decidedAt: now.toISOString() } };
        if (request.action === "accept") {
            if (evidenceRefs.length > 100)
                fail("invalid_update", 400, "At most 100 source references may be retained");
            const observationId = updateRecordId(base.userId, request.commandId, "observation");
            const assertionRef = `brain-observation:${observationId}`;
            const submission = JSON.stringify({ proposalId: candidate.id, request, independentlyVerifiesBusinessFact: false });
            await store.insert(brainObservations).values(brainObservationToInsertRow({ id: observationId, userId: base.userId, sourceType: "owner_memory_update_review", sourceId: request.commandId, observedAt: now, content: submission, contentHash: digest(submission), trustLevel: "owner_assertion", metadata: { independentlyVerifiesBusinessFact: false } })).returning();
            evidenceRefs = [...evidenceRefs, assertionRef];
            const prior = object(base.metadata?.revision);
            Object.assign(metadata, { revision: { operation: "correct", commandId: request.commandId, previousMemoryId: base.id, previousVersion: request.expectedBaseVersion, authority: "external_fact", reviewStatus: "applied", rootMemoryId: prior.rootMemoryId ?? base.id, sequence: typeof prior.sequence === "number" ? prior.sequence + 1 : 1, createdAt: now.toISOString(), reason: request.reason, assertionEvidenceRefs: [assertionRef], independentlyVerifiesBusinessFact: false } });
            const [retired] = await store.update(brainMemories).set({ status: "superseded", updatedAt: now, metadata: { ...base.metadata, revisionRetired: { operation: "correct", commandId: request.commandId, reviewId: updateRecordId(base.userId, request.commandId), nextMemoryId: candidate.id, previousVersion: request.expectedBaseVersion, createdAt: now.toISOString(), reason: request.reason } } }).where(and(eq(brainMemories.userId, base.userId), eq(brainMemories.id, base.id))).returning();
            nextBase = brainMemoryFromRow(retired);
        }
        const [updated] = await store.update(brainMemories).set({ status: request.action === "accept" ? "active" : "deleted", evidenceRefs, metadata, updatedAt: now, supersedes: request.action === "accept" ? [base.id] : [] }).where(where).returning();
        const next = brainMemoryFromRow(updated);
        const result = { candidate: versioned(next), base: versioned(nextBase), baseVersion: getBrainMemoryRevisionVersion(nextBase), proposalVersion: getBrainMemoryRevisionVersion(next), replayed: false,
            receipt: { id: updateRecordId(base.userId, request.commandId), commandId: request.commandId, action: request.action, status: request.action === "accept" ? "accepted" : "rejected", candidateId: next.id, baseMemoryId: base.id, previousProposalVersion: request.expectedVersion, previousBaseVersion: request.expectedBaseVersion, proposalVersion: getBrainMemoryRevisionVersion(next), baseVersion: getBrainMemoryRevisionVersion(nextBase), effective: request.action === "accept", createdAt: now.toISOString() } };
        await recordUpdateReceipt(store, { userId: base.userId, commandId: request.commandId, requestHash, memory: next, result, now, reason: request.reason, reviewerType: "chat", reviewerId: input.requester.id });
        if (request.action === "accept")
            await recordMemoryChangeInTransaction(store, { beforeMemory: base, afterMemory: nextBase, replacementMemory: next, commandId: request.commandId, reason: request.reason, now, reviewId: updateRecordId(base.userId, request.commandId) });
        return { memory: next, result, written: true };
    });
}
