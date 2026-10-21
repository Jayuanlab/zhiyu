import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { brainAccessGrants, brainMemories } from "@/lib/db/schema";
import { brainAccessGrantFromRow, brainMemoryFromRow, brainMemoryToInsertRow } from "../records/memory-record";
import { canWriteMemory } from "./policy";
import { withBrainMemoryTransaction, BrainMemoryIdentityConflict } from "./transaction";
import { acquireBrainWriteAdvisoryLock, brainWriteRowLockOptions, getBrainMemoryCanonicalWriteLockKey } from "./locks";
import { getBrainMemoryRevisionVersion } from "./version";
import { getBrainMemoryCanonicalMetadata } from "./canonical";
import { createBrainMemoryUpdateProposalInTransaction } from "./proposals";
import { commandReplay, digest, fail, nowDate, object, recordUpdateReceipt, sameIdentity } from "./common";
import type { BrainMemory, BrainRequester } from "../kernel/memory-types";
/** Ordinary understanding writes never replace an existing slot by status rank. */
export async function admitOrdinaryBrainMemory(input: {
    requester: BrainRequester;
    memory: BrainMemory;
    now?: Date;
}) {
    const incoming = input.memory, now = nowDate(input.now), canonical = getBrainMemoryCanonicalMetadata(incoming);
    if (input.requester.userId !== incoming.userId)
        fail("update_not_allowed", 403, "Requester and memory must belong to the same owner");
    const scopeId = incoming.scope.type === "global" ? null : incoming.scope.type === "work" ? incoming.scope.workId : incoming.scope.type === "workshop" ? incoming.scope.workshopId : incoming.scope.workspaceId;
    const requestHash = digest({ identity: [incoming.userId, incoming.scope, incoming.ownerType, incoming.ownerId, canonical.canonicalGroupId], content: incoming.content, subject: incoming.subject, memoryType: incoming.memoryType, evidenceRefs: [...incoming.evidenceRefs].sort(), status: incoming.status });
    const commandId = `ordinary:${requestHash}`;
    return withBrainMemoryTransaction(incoming.userId, async (store) => {
        const grants = await store.select().from(brainAccessGrants).where(eq(brainAccessGrants.userId, incoming.userId)).for("share");
        if (!canWriteMemory({ request: { requester: input.requester, targetScope: incoming.scope, ownerType: incoming.ownerType, ownerId: incoming.ownerId, memoryType: incoming.memoryType, status: incoming.status, confidence: incoming.confidence, evidenceRefs: incoming.evidenceRefs }, grants: grants.map(brainAccessGrantFromRow), now }).allowed)
            fail("update_not_allowed", 403, "Ordinary memory admission is no longer authorized");
        const replay = await commandReplay(store, incoming.userId, commandId, requestHash);
        if (replay) {
            const saved = replay.candidate ?? replay.memory;
            let id = saved.id;
            let memory: BrainMemory | undefined;
            const seen = new Set<string>();
            for (let count = 0; count < 8; count++) {
                if (seen.has(id))
                    fail("update_history_unavailable", 409, "Admission history contains a cycle");
                seen.add(id);
                const [current] = await store.select().from(brainMemories).where(and(eq(brainMemories.userId, incoming.userId), eq(brainMemories.id, id)));
                if (!current)
                    fail("memory_not_found", 404, "Previous admission memory is unavailable");
                const next = brainMemoryFromRow(current);
                if (memory && !sameIdentity(memory, next))
                    fail("update_history_unavailable", 409, "Admission replacement identity changed");
                memory = next;
                const nextId = object(memory.metadata?.revisionRetired).nextMemoryId;
                if (memory.status !== "superseded" || typeof nextId !== "string")
                    return { memory, result: memory, written: false };
                id = nextId;
            }
            fail("update_history_unavailable", 409, "Admission history exceeds the bounded replay limit; read current memory");
        }
        await acquireBrainWriteAdvisoryLock(store, getBrainMemoryCanonicalWriteLockKey(incoming));
        const [sameId] = await store.select().from(brainMemories).where(and(eq(brainMemories.userId, incoming.userId), eq(brainMemories.id, incoming.id))).for("update", brainWriteRowLockOptions());
        const identity = and(eq(brainMemories.userId, incoming.userId), eq(brainMemories.ownerType, incoming.ownerType), eq(brainMemories.ownerId, incoming.ownerId), eq(brainMemories.scopeType, incoming.scope.type), scopeId === null ? isNull(brainMemories.scopeId) : eq(brainMemories.scopeId, scopeId));
        const rows = await store.select().from(brainMemories).where(and(identity, or(eq(brainMemories.id, incoming.id), eq(brainMemories.canonicalGroupId, canonical.canonicalGroupId)))).orderBy(desc(brainMemories.updatedAt), desc(brainMemories.id)).for("update", brainWriteRowLockOptions());
        if (sameId && !rows.some((r: any) => r.id === incoming.id))
            throw new BrainMemoryIdentityConflict();
        const memories: BrainMemory[] = rows.map((row: any) => brainMemoryFromRow(row));
        const base = memories.find(memory => ["active", "verified", "weakened"].includes(memory.status) && !(memory.metadata?.updateProposal as any)?.status?.includes("pending")) ?? memories.find(memory => memory.status !== "superseded" && !(memory.metadata?.updateProposal as any)?.status) ?? memories.find(memory => memory.id === incoming.id) ?? memories[0];
        if (base) {
            if (base.metadata?.updateProposal && (base.metadata.updateProposal as any).status === "pending")
                fail("memory_update_decision_required", 409, "Pending candidates must be resolved through their update decision");
            if (base.content === incoming.content) {
                const result = { memory: base, replayed: false, status: "noop", receipt: { id: commandId, effective: ["active", "verified"].includes(base.status) } };
                await recordUpdateReceipt(store, { userId: incoming.userId, commandId, requestHash, memory: base, result, now, reason: "Identical ordinary understanding retained without overwrite", reviewerType: input.requester.type, reviewerId: input.requester.id });
                return { memory: base, result: base, written: true };
            }
            const result = await createBrainMemoryUpdateProposalInTransaction(store, { requester: input.requester, base, request: { targetMemoryId: base.id, expectedVersion: getBrainMemoryRevisionVersion(base), commandId, content: incoming.content, reason: "New understanding differs from the current canonical memory; owner decision required", evidenceRefs: incoming.evidenceRefs }, now, requestHash });
            return { memory: result.candidate, result: result.candidate, written: true };
        }
        const [created] = await store.insert(brainMemories).values(brainMemoryToInsertRow(incoming)).returning();
        if (!created)
            throw new BrainMemoryIdentityConflict();
        const memory = brainMemoryFromRow(created);
        const result = { memory, replayed: false, status: "created", receipt: { id: commandId, effective: ["active", "verified"].includes(memory.status) } };
        await recordUpdateReceipt(store, { userId: incoming.userId, commandId, requestHash, memory, result, now, reason: "Initial canonical memory admission", reviewerType: input.requester.type, reviewerId: input.requester.id });
        return { memory, result: memory, written: true };
    });
}
