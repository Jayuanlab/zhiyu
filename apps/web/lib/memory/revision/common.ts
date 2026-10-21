import { BrainMemoryUpdateError } from "../kernel/reference-errors";
export { BrainMemoryUpdateError } from "../kernel/reference-errors";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { brainMemories, brainMemoryReviews } from "@/lib/db/schema";
import type { DrizzleDB } from "@/lib/db/types";
import { brainMemoryFromRow, brainMemoryReviewToInsertRow } from "../records/memory-record";
import { getBrainMemoryRevisionVersion } from "./version";
import type { BrainMemory } from "../kernel/memory-types";
import { acquireBrainWriteAdvisoryLock } from "./locks";
export const UPDATE_SOURCE = "brain_memory_update.v1";
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function fail(code: string, status: number, message: string): never { throw new BrainMemoryUpdateError(code, status, message); }
export function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function updateRecordId(userId: string, commandId: string, purpose = "receipt") {
    const h = digest([UPDATE_SOURCE, userId.toLowerCase(), commandId, purpose]);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function object(value: unknown): Record<string, any> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
export function nonempty(value: unknown, name: string, max: number): string {
    if (typeof value !== "string" || !value.trim() || value.length > max)
        fail("invalid_update", 400, `${name} must contain 1 to ${max} characters`);
    return value.trim();
}
export function version(value: unknown, name = "expectedVersion") {
    if (typeof value !== "string" || !/^bmrv1:[a-f0-9]{64}$/.test(value))
        fail("invalid_update", 400, `${name} is required`);
    return value;
}
export function refs(value: unknown): string[] {
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || value.length > 101 || value.some(v => typeof v !== "string" || !v.trim() || v.length > 2048))
        fail("invalid_update", 400, "evidenceRefs must contain at most 101 bounded references");
    return [...new Set(value.map(v => v.trim()))];
}
export function nowDate(now?: Date) {
    const value = now ?? new Date();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
        fail("invalid_update", 400, "Invalid submission time");
    return value;
}
export function versioned(memory: BrainMemory) { return { ...memory, revisionVersion: getBrainMemoryRevisionVersion(memory) }; }
export function sameIdentity(a: BrainMemory, b: BrainMemory) {
    return a.userId === b.userId && a.ownerType === b.ownerType && a.ownerId === b.ownerId && JSON.stringify(a.scope) === JSON.stringify(b.scope);
}
/** Read persisted state without presenting a saved command receipt as current truth. */
export async function readCurrentMemorySuccessor(store: DrizzleDB, saved: BrainMemory) {
    let id = saved.id;
    const seen = new Set<string>();
    for (let count = 0; count < 8; count++) {
        if (seen.has(id))
            fail("update_history_unavailable", 409, "Memory replacement history contains a cycle");
        seen.add(id);
        const [row] = await store.select().from(brainMemories).where(and(eq(brainMemories.userId, saved.userId), eq(brainMemories.id, id)));
        if (!row)
            fail("memory_not_found", 404, "Previous update memory is unavailable");
        const current = brainMemoryFromRow(row);
        if (!sameIdentity(saved, current))
            fail("update_history_unavailable", 409, "Memory replacement identity changed");
        const nextId = object(current.metadata?.revisionRetired).nextMemoryId;
        if (current.status !== "superseded" || typeof nextId !== "string")
            return current;
        id = nextId;
    }
    fail("update_history_unavailable", 409, "Memory replacement history exceeds the bounded replay limit; read current memory");
}
export async function commandReplay(store: DrizzleDB, userId: string, commandId: string, requestHash: string) {
    await acquireBrainWriteAdvisoryLock(store, JSON.stringify([UPDATE_SOURCE, userId, commandId]));
    const [row] = await store.select().from(brainMemoryReviews).where(and(eq(brainMemoryReviews.userId, userId), eq(brainMemoryReviews.id, updateRecordId(userId, commandId))));
    if (!row)
        return null;
    const meta = object(row.metadata);
    if (meta.source !== UPDATE_SOURCE || meta.requestHash !== requestHash)
        fail("command_conflict", 409, "commandId already identifies a different update");
    return { ...meta.result, replayed: true };
}
export async function recordUpdateReceipt(store: DrizzleDB, input: {
    userId: string;
    commandId: string;
    requestHash: string;
    memory: BrainMemory;
    result: unknown;
    now: Date;
    reason: string;
    reviewerType?: string;
    reviewerId?: string;
}) {
    await store.insert(brainMemoryReviews).values({ ...brainMemoryReviewToInsertRow({ userId: input.userId, memoryId: input.memory.id,
            reviewerType: (input.reviewerType ?? "system") as any, reviewerId: input.reviewerId, decision: "edited", reason: input.reason, evidenceRefs: input.memory.evidenceRefs,
            metadata: { source: UPDATE_SOURCE, requestHash: input.requestHash, result: input.result, commandId: input.commandId } }), id: updateRecordId(input.userId, input.commandId), createdAt: input.now }).returning();
}
