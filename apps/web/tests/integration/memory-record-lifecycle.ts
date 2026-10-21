import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { closeDb } from "@/lib/db/adapters";
import { user, brainMemories, brainMemoryReviews, brainStateSnapshots } from "@/lib/db/schema";
import { brainMemoryToInsertRow, brainMemoryFromRow } from "@/lib/memory/records/memory-record";
import { governRecordLifecycle } from "@/lib/memory/governance/record-lifecycle";
import { getBrainMemoryRevisionVersion } from "@/lib/memory/revision/version";
import { recordLifecycleView, memoryRecallOmitReason } from "@/lib/memory/records/lifecycle";
import { listMemoryCandidatesForUser } from "@/lib/memory/retrieval/candidates";
import { buildBrainContextPack } from "@/lib/memory/context/pack";
import { admitExactUse } from "@/lib/memory/context/exact-use-admission";
import type { BrainMemory } from "@/lib/memory/kernel/memory-types";

async function main() {
  assert.equal(process.env.ZHIYU_TEST_MODE, "integration");
  assert.match(new URL(process.env.POSTGRES_URL!).pathname, /^\/zhiyu_test_[a-f0-9]{32}$/);
  assert.equal(process.env.POSTGRES_URL, process.env.ZHIYU_TEST_DATABASE_URL);
  const owner = randomUUID(), stranger = randomUUID(), workId = randomUUID(), checks: string[] = [];
  const requester = { type: "chat" as const, userId: owner, id: "memory-lifecycle-owner" };
  try {
    await db.insert(user).values([{ id: owner, email: "lifecycle-owner@example.invalid" }, { id: stranger, email: "lifecycle-other@example.invalid" }]);
    const raw: BrainMemory = { id: randomUUID(), userId: owner, scope: { type: "work", workId }, ownerType: "work", ownerId: workId,
      memoryType: "insight", subject: "Checkpoint fixture", content: "2026-10-02 research checkpoint: checked sources; next questions", status: "active", confidence: 80,
      evidenceRefs: ["fixture-source"], tags: ["checkpoint", "research-state"], createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" };
    const fresh = { ...raw, id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await db.insert(brainMemories).values(brainMemoryToInsertRow(fresh));
    const [future] = await db.select().from(brainMemories).where(eq(brainMemories.id, fresh.id));
    assert.equal(recordLifecycleView(brainMemoryFromRow(future)).recordClass, "run_record"); checks.push("new_write_classified");
    // Seed a genuine pre-governance row by clearing only the automatic fixture metadata.
    await db.insert(brainMemories).values({ ...brainMemoryToInsertRow(raw), metadata: {} });
    const read = async () => brainMemoryFromRow((await db.select().from(brainMemories).where(eq(brainMemories.id, raw.id)))[0]);
    const original = await read();
    const command = { requester, memoryId: raw.id, expectedVersion: getBrainMemoryRevisionVersion(original), commandId: randomUUID(), action: "classify" as const,
      recordClass: "run_record" as const, reason: "Authored operational checkpoint, preserve original" };
    await assert.rejects(governRecordLifecycle({ ...command, requester: { ...requester, userId: stranger } }), /unavailable/i);
    await assert.rejects(governRecordLifecycle({ ...command, requester: { ...requester, type: "work" } }), /Owner lifecycle/); checks.push("owner_and_cross_owner_boundary");
    const result = await governRecordLifecycle(command), after = await read();
    assert.equal(result.lifecycle.phase, "archived"); assert.equal(after.content, original.content); assert.equal(after.updatedAt, original.updatedAt);
    assert.deepEqual(after.evidenceRefs, original.evidenceRefs); assert.equal(after.status, original.status); checks.push("preserved_raw_and_observation_time");
    const replay = await governRecordLifecycle(command); assert.equal(replay.replayed, true);
    assert.equal((await db.select().from(brainMemoryReviews).where(eq(brainMemoryReviews.memoryId, raw.id))).length, 1); checks.push("idempotent_audited_command");
    await assert.rejects(governRecordLifecycle({ ...command, reason: "Conflicting replay" }), /commandId/);
    await assert.rejects(governRecordLifecycle({ ...command, commandId: randomUUID() }), /changed/); checks.push("command_and_version_conflicts");
    const listed = await listMemoryCandidatesForUser({ userId: owner, statuses: ["active"] }); assert.equal(listed.some(row => row.id === raw.id), false);
    const operational = await listMemoryCandidatesForUser({ userId: owner, recordClass: "run_record" }); assert.equal(operational.length, 2);
    const pack = buildBrainContextPack({ memories: [after], requester, accessMode: "owner_override", taskIntent: "checkpoint", includeCandidates: true });
    assert.equal(pack.items.length, 0); assert.equal(pack.omitted[0].reason, "record_class:run_record");
    await assert.rejects(admitExactUse({ requester, accessMode: "owner_override", purpose: "isolated_lifecycle_test", memories: [after] })); checks.push("list_pack_and_exact_egress_blocked");
    const undone = await governRecordLifecycle({ requester, memoryId: raw.id, expectedVersion: result.afterVersion, commandId: randomUUID(), action: "rollback", restoreReceiptId: result.receiptId, reason: "Restore baseline for matched recovery test" });
    assert.equal(undone.afterVersion, getBrainMemoryRevisionVersion(original)); assert.deepEqual(await read(), original); checks.push("exact_rollback_readback");
    const reclass = await governRecordLifecycle({ ...command, commandId: randomUUID() });
    await assert.rejects(governRecordLifecycle({ requester, memoryId: raw.id, expectedVersion: reclass.afterVersion, commandId: randomUUID(), action: "classify", recordClass: "long_term", reason: "Owner requests source review of a reusable conclusion" }), (error: unknown) => (error as { code?: string }).code === "extract_lesson_required");
    assert.equal(memoryRecallOmitReason(await read()), "record_class:run_record"); checks.push("whole_report_promotion_rejected");
    await assert.rejects(governRecordLifecycle({ requester, memoryId: raw.id, expectedVersion: result.afterVersion, commandId: randomUUID(), action: "rollback", restoreReceiptId: result.receiptId, reason: "Reject stale rollback" })); checks.push("stale_rollback_rejected");
    const boundary = { ...raw, id: randomUUID(), memoryType: "boundary" as const };
    await db.insert(brainMemories).values(brainMemoryToInsertRow(boundary));
    const boundaryRead = brainMemoryFromRow((await db.select().from(brainMemories).where(eq(brainMemories.id, boundary.id)))[0]);
    await assert.rejects(governRecordLifecycle({ ...command, memoryId: boundary.id, expectedVersion: getBrainMemoryRevisionVersion(boundaryRead), commandId: randomUUID() }), /Boundary/); checks.push("restriction_preserved");
    const events = await db.select().from(brainStateSnapshots).where(and(eq(brainStateSnapshots.userId, owner), eq(brainStateSnapshots.snapshotType, "memory_dependency_change")));
    assert.equal(events.length, 3); checks.push("dependency_invalidation_ledger");
    const output = process.env.ZHIYU_LIFECYCLE_TEST_RESULT; assert.ok(output);
    fs.writeFileSync(output, JSON.stringify({ passed: true, checks, count: checks.length, database: new URL(process.env.POSTGRES_URL!).pathname }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: checks.length }));
  } finally { await closeDb(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
