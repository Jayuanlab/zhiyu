import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { brainStateSnapshots } from "@/lib/db/schema";
import type { DrizzleDB } from "@/lib/db/types";
import { withBrainRecordWrite } from "./write-guard";
import type { BrainRequester } from "./types";
import { acquireBrainWriteAdvisoryLock } from "./memory-revision-lock";
import { digest, fail, nonempty, nowDate, object, updateRecordId } from "./memory-update-common";
export const BRAIN_MEMORY_AUTO_UPDATE_POLICY_TYPE = "memory_auto_update_policy";
export async function lockBrainMemoryAutoUpdatePolicy(store: DrizzleDB, userId: string) {
    await acquireBrainWriteAdvisoryLock(store, JSON.stringify(["brain-memory-auto-policy.v1", userId]));
}
export async function readBrainMemoryAutoUpdatePolicy(store: DrizzleDB, userId: string) {
    const [row] = await store.select().from(brainStateSnapshots).where(and(eq(brainStateSnapshots.userId, userId), eq(brainStateSnapshots.scopeType, "global"), eq(brainStateSnapshots.snapshotType, BRAIN_MEMORY_AUTO_UPDATE_POLICY_TYPE), sql `${brainStateSnapshots.metadata}->>'source' = 'brain_memory_auto_policy.v1'`)).orderBy(desc(sql `(${brainStateSnapshots.content}->>'sequence')::bigint`), desc(brainStateSnapshots.createdAt), desc(brainStateSnapshots.id)).limit(1);
    if (!row)
        return { enabled: true, version: "bmup1:initial", snapshotId: null, sequence: 0 };
    const content = object(row.content);
    if (typeof content.enabled !== "boolean" || !Number.isSafeInteger(content.sequence) || content.sequence < 1)
        fail("policy_unavailable", 503, "Automatic memory policy cannot be read safely");
    return { enabled: content.enabled, version: `bmup1:${digest({ id: row.id, content })}`, snapshotId: row.id, sequence: content.sequence };
}
export async function getBrainMemoryAutoUpdatePolicy(input: {
    userId: string;
}) { return readBrainMemoryAutoUpdatePolicy(db, input.userId); }
export async function updateBrainMemoryAutoUpdatePolicy(input: {
    requester: BrainRequester;
    request: unknown;
    now?: Date;
}) {
    if (input.requester.type !== "chat")
        fail("owner_decision_required", 403, "Only the owner may pause or resume automatic memory updates");
    const body = object(input.request);
    if (Object.keys(body).some(k => !["commandId", "expectedVersion", "enabled", "reason"].includes(k)) || typeof body.enabled !== "boolean")
        fail("invalid_update", 400, "Invalid automatic policy command");
    const commandId = nonempty(body.commandId, "commandId", 200), reason = nonempty(body.reason, "reason", 2000);
    const expectedVersion = nonempty(body.expectedVersion, "expectedVersion", 100);
    if (expectedVersion !== "bmup1:initial" && !/^bmup1:[a-f0-9]{64}$/.test(expectedVersion))
        fail("invalid_update", 400, "Invalid expected policy version");
    const now = nowDate(input.now), userId = input.requester.userId, id = updateRecordId(userId, commandId, "policy"), requestHash = digest({ commandId, expectedVersion, enabled: body.enabled, reason });
    return withBrainRecordWrite(userId, "snapshot", async (store) => {
        await lockBrainMemoryAutoUpdatePolicy(store, userId);
        const [prior] = await store.select().from(brainStateSnapshots).where(and(eq(brainStateSnapshots.userId, userId), eq(brainStateSnapshots.id, id)));
        if (prior) {
            const meta = object(prior.metadata);
            if (meta.source !== "brain_memory_auto_policy.v1" || meta.requestHash !== requestHash)
                fail("command_conflict", 409, "commandId already identifies another policy command");
            return { id, result: { ...meta.result, replayed: true }, written: false };
        }
        const current = await readBrainMemoryAutoUpdatePolicy(store, userId);
        if (current.version !== expectedVersion)
            fail("version_conflict", 409, "Automatic policy changed; refresh before changing it");
        const content = { enabled: body.enabled, sequence: current.sequence + 1 };
        const version = `bmup1:${digest({ id, content })}`;
        const result = { enabled: body.enabled, version, snapshotId: id, replayed: false, receipt: { id, commandId, enabled: body.enabled, previousVersion: expectedVersion, version, snapshotId: id, createdAt: now.toISOString() } };
        await store.insert(brainStateSnapshots).values({ id, userId, scopeType: "global", scopeId: null, snapshotType: BRAIN_MEMORY_AUTO_UPDATE_POLICY_TYPE, content, sourceMemoryIds: [], metadata: { source: "brain_memory_auto_policy.v1", requestHash, reason, commandId, request: { expectedVersion, enabled: body.enabled, reason }, previousVersion: current.version, result }, createdAt: now }).returning();
        return { id, result, written: true };
    });
}
