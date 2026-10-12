import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { getBrainMemoryById, upsertBrainMemory, upsertBrainObservation } from "@/lib/brain/repository";
import { getBrainMemoryRevisionVersion, reviseBrainMemory } from "@/lib/brain/memory-revision";
import { buildBrainContextPack } from "@/lib/brain/context";
import { claimWorkshopExecution } from "@/lib/work-runtime/execution-lease";
import { withExecutionContext } from "@/lib/work-runtime/execution-context";
import type { BrainMemory } from "@/lib/brain/types";

/** Called only by an isolated migration runner, never against an application database. */
export async function checkBrainMemoryRevision(client: postgres.Sql) {
  const userId = randomUUID(), otherUserId = randomUUID(), workshopId = randomUUID(), runId = randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},'revision-owner@example.invalid'),(${otherUserId},'revision-other@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workshopId},${userId},'revision fixture','test')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${runId},${workshopId},'queued',NULL)`;
  const observation = await upsertBrainObservation({userId, sourceType: "revision_fixture", sourceId: randomUUID(),
    observedAt: new Date("2026-09-01T00:00:00.000Z"), content: "不可改写的原始观测", contentHash: "fixture-original"});
  const seed = async (overrides: Partial<BrainMemory> = {}) => upsertBrainMemory({
    id: randomUUID(), userId, scope: {type: "workshop", workshopId}, ownerType: "work", ownerId: workshopId,
    memoryType: "preference", subject: "fixture preference", content: "原来的记忆正文", status: "active", confidence: 80,
    evidenceRefs: [`brain-observation:${observation.id}`], createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    metadata: {observationTime: "2026-09-01T00:00:00.000Z", canonicalGroupId: `revision-fixture:${randomUUID()}`}, ...overrides,
  });
  const owner = {type: "chat" as const, userId, id: "owner-fixture"};
  const request = (memory: BrainMemory, overrides: Record<string, unknown> = {}) => ({commandId: randomUUID(),
    expectedVersion: getBrainMemoryRevisionVersion(memory), operation: "correct", authority: "owner_statement",
    content: "明确纠正后的正文", reason: "主人明确更正旧理解", evidenceRefs: [], ...overrides});
  const run = (memory: BrainMemory, payload: Record<string, unknown>) => reviseBrainMemory({requester: owner, memoryId: memory.id, request: payload});
  const counts = async () => (await client`SELECT (SELECT count(*) FROM brain_memory_reviews WHERE user_id=${userId})::int AS reviews,
    (SELECT count(*) FROM brain_observations WHERE user_id=${userId})::int AS observations,
    (SELECT count(*) FROM brain_memories WHERE user_id=${userId})::int AS memories`)[0];

  const original = await seed(), payload = request(original);
  const concurrent = await Promise.all([run(original, payload), run(original, payload)]);
  assert.equal(concurrent.filter(result => result.replayed).length, 1);
  const applied = concurrent.find(result => !result.replayed)!;
  assert.equal(applied.oldMemory.status, "superseded"); assert.equal(applied.oldMemory.content, original.content);
  assert.equal(applied.newMemory!.status, "active"); assert.equal(applied.newMemory!.content, payload.content);
  assert.notEqual(applied.newMemory!.id, original.id); assert.equal(applied.newMemory!.ownerId, original.ownerId);
  assert.deepEqual(applied.newMemory!.scope, original.scope); assert.equal(applied.receipt.effective, true);
  assert.equal(applied.newMemory!.metadata?.observationTime, original.metadata?.observationTime);
  const pack = buildBrainContextPack({requester: owner, taskIntent: "language preference", accessMode: "owner_override", memories: [applied.oldMemory, applied.newMemory!], grants: []});
  assert.ok(pack.items.some(item => item.id === applied.newMemory!.id)); assert.ok(!pack.items.some(item => item.id === original.id));
  const review = (await client`SELECT metadata,reason,decision FROM brain_memory_reviews WHERE id=${applied.receipt.id}`)[0];
  assert.equal(review.decision, "edited"); assert.equal(review.reason, payload.reason);
  assert.equal(review.metadata.beforeMemory.content, original.content); assert.equal(review.metadata.newVersion, applied.receipt.newVersion);
  assert.equal(review.metadata.request.commandId, payload.commandId);
  assert.equal((await client`SELECT content FROM brain_observations WHERE id=${observation.id}`)[0].content, "不可改写的原始观测");
  const asserted = (await client`SELECT metadata FROM brain_observations WHERE source_type='owner_memory_revision' AND source_id=${payload.commandId}`)[0];
  assert.equal(asserted.metadata.independentlyVerifiesBusinessFact, false);

  // Ordinary admission cannot overwrite a revision or resurrect either historical ID.
  await assert.rejects(upsertBrainMemory({...original, status: "verified", content: "旧观测不能复活"}), {code: "memory_revision_required"});
  await assert.rejects(upsertBrainMemory({...applied.newMemory!, status: "verified", content: "更高等级不能覆盖更正"}), {code: "memory_revision_required"});
  await assert.rejects(upsertBrainMemory({...original, id: randomUUID(), status: "verified", content: "新ID同组不能覆盖更正"}), {code: "memory_revision_required"});
  await assert.rejects(upsertBrainMemory({...original, metadata: {canonicalGroupId: randomUUID()}, status: "active"}), {code: "memory_revision_required"});
  const independent = await seed(); assert.equal(independent.status, "active");

  await assert.rejects(run(original, {...payload, content: "different payload"}), {code: "command_conflict"});
  await assert.rejects(run(original, request(original)), {code: "version_conflict"});
  await assert.rejects(reviseBrainMemory({requester: {...owner, userId: otherUserId}, memoryId: original.id, request: request(original)}), {code: "memory_not_found"});
  await assert.rejects(reviseBrainMemory({requester: {...owner, type: "work", id: workshopId}, memoryId: original.id, request: request(original)}), {code: "owner_revision_required"});
  await assert.rejects(run(applied.newMemory!, request(applied.newMemory!, {ownerId: randomUUID()})), {code: "invalid_revision"});

  const raced = await seed();
  const race = await Promise.allSettled([run(raced, request(raced)), run(raced, request(raced, {content: "other concurrent correction"}))]);
  assert.equal(race.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(race.filter(result => result.status === "rejected" && result.reason.code === "version_conflict").length, 1);
  const ordinaryRaceTarget = await seed();
  const ordinaryRace = await Promise.allSettled([run(ordinaryRaceTarget, request(ordinaryRaceTarget)),
    upsertBrainMemory({...ordinaryRaceTarget, content: "并发旧观测", status: "verified"})]);
  let protectedReplacement: BrainMemory;
  if (ordinaryRace[0].status === "fulfilled") {
    protectedReplacement = ordinaryRace[0].value.newMemory!;
    assert.equal(ordinaryRace[1].status, "rejected");
  } else {
    assert.equal(ordinaryRace[0].reason.code, "version_conflict");
    const refreshed = (await getBrainMemoryById({userId, memoryId: ordinaryRaceTarget.id}))!;
    protectedReplacement = (await run(refreshed, request(refreshed))).newMemory!;
  }
  assert.equal((await getBrainMemoryById({userId, memoryId: protectedReplacement.id}))!.content, "明确纠正后的正文");
  await assert.rejects(upsertBrainMemory({...ordinaryRaceTarget, status: "verified"}), {code: "memory_revision_required"});

  // Force both writers to queue while they hold different canonical-group locks.
  // The unconditional same-ID row lock must make the ordinary writer recheck retirement.
  const changedGroupTarget = await seed();
  let releaseRow!: () => void;
  let rowLocked!: () => void;
  const lockReady = new Promise<void>(resolve => {rowLocked = resolve;});
  const releaseReady = new Promise<void>(resolve => {releaseRow = resolve;});
  const holdRow = client.begin(async transaction => {
    await transaction`SELECT id FROM brain_memories WHERE id=${changedGroupTarget.id} FOR UPDATE`;
    rowLocked(); await releaseReady;
  });
  await lockReady;
  const changedGroupRevision = run(changedGroupTarget, request(changedGroupTarget));
  let changedGroupOrdinary: Promise<BrainMemory> | undefined;
  const waitForMemoryLocks = async (minimum: number) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const row = (await client`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%brain_memories%'`)[0];
      if (row.count >= minimum) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Expected ${minimum} concurrent memory writers to wait for the held fixture row`);
  };
  try {
    await waitForMemoryLocks(1);
    changedGroupOrdinary = upsertBrainMemory({...changedGroupTarget, status: "verified", content: "换组不能并发复活旧ID",
      metadata: {...changedGroupTarget.metadata, canonicalGroupId: `changed-group:${randomUUID()}`}});
    await waitForMemoryLocks(2);
  } finally {releaseRow(); await holdRow;}
  const changedGroupRace = await Promise.allSettled([changedGroupRevision, changedGroupOrdinary!]);
  assert.equal(changedGroupRace[0].status, "fulfilled");
  assert.equal(changedGroupRace[1].status, "rejected");
  if (changedGroupRace[1].status === "rejected") assert.equal(changedGroupRace[1].reason.code, "memory_revision_required");
  if (changedGroupRace[0].status === "fulfilled") {
    assert.equal((await getBrainMemoryById({userId, memoryId: changedGroupTarget.id}))!.status, "superseded");
    assert.equal((await getBrainMemoryById({userId, memoryId: changedGroupRace[0].value.newMemory!.id}))!.content, "明确纠正后的正文");
  }
  const third = await run(applied.newMemory!, request(applied.newMemory!, {content: original.content, reason: "显式撤销修订，形成第三个版本"}));
  assert.equal(third.newMemory!.content, original.content); assert.notEqual(third.newMemory!.id, original.id);
  assert.equal(third.newMemory!.metadata?.revision && (third.newMemory!.metadata.revision as Record<string, unknown>).sequence, 2);
  assert.equal(third.newMemory!.evidenceRefs.length, applied.newMemory!.evidenceRefs.length);
  assert.equal(third.newMemory!.evidenceRefs.filter(ref => ref.startsWith("brain-observation:")).length, 2);
  assert.equal((await getBrainMemoryById({userId, memoryId: applied.newMemory!.id}))!.status, "superseded");
  const historicReplay = await run(original, payload); assert.equal(historicReplay.replayed, true);
  assert.equal(historicReplay.newMemory!.status, "active"); // Historical receipt, not the now-current status.

  const risky = await seed({memoryType: "fact"});
  const pending = await run(risky, request(risky, {operation: "state_change"}));
  assert.equal(pending.newMemory!.status, "candidate"); assert.equal(pending.receipt.effective, false);
  assert.equal(pending.oldMemory.status, "superseded"); assert.equal(pending.newMemory!.metadata?.observationTimeUnknown, true);
  const pendingPack = buildBrainContextPack({requester: owner, taskIntent: "current fact", accessMode: "owner_override", memories: [pending.oldMemory, pending.newMemory!], grants: []});
  assert.equal(pendingPack.items.length, 0);
  const off = await seed(); const offPayload = request(off, {operation: "deactivate"}); delete (offPayload as Record<string, unknown>).content;
  const deactivated = await run(off, offPayload); assert.equal(deactivated.oldMemory.status, "deleted");
  assert.equal(deactivated.oldMemory.content, off.content); assert.equal(deactivated.newMemory, null);
  const restored = await run(deactivated.oldMemory, request(deactivated.oldMemory, {operation: "restore", content: off.content}));
  assert.notEqual(restored.newMemory!.id, off.id); assert.equal(restored.newMemory!.status, "active");
  assert.equal(restored.newMemory!.metadata?.revisionRetired, undefined);
  assert.equal((await getBrainMemoryById({userId, memoryId: off.id}))!.status, "superseded");
  await assert.rejects(run(applied.oldMemory, request(applied.oldMemory, {operation: "restore"})), {code: "memory_inactive"});
  const future = await seed();
  await assert.rejects(run(future, request(future, {operation: "state_change", sourceObservedAt: "2999-01-01T00:00:00Z"})), {code: "invalid_revision"});

  for (const stage of ["observation", "review"] as const) {
    const target = await seed(); const before = await counts();
    const table = stage === "observation" ? "brain_observations" : "brain_memory_reviews";
    await client.unsafe(`CREATE FUNCTION reject_revision_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected revision failure'; END $$`);
    await client.unsafe(`CREATE TRIGGER reject_revision_fixture BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_revision_fixture()`);
    try {await assert.rejects(run(target, request(target)));}
    finally {await client.unsafe(`DROP TRIGGER reject_revision_fixture ON ${table}`); await client.unsafe("DROP FUNCTION reject_revision_fixture()");}
    assert.equal((await getBrainMemoryById({userId, memoryId: target.id}))!.status, "active");
    assert.deepEqual(await counts(), before);
  }

  const lease = await claimWorkshopExecution({userId, workshopId, runId, workerId: "revision", leaseMs: 30_000});
  if (lease.state !== "claimed") throw new Error("fixture lease not claimed");
  const scoped = <T>(work: () => Promise<T>) => withExecutionContext(lease.lease, work);
  const leased = await seed(); const leasedRequest = request(leased);
  const eventCount = async () => Number((await client`SELECT count(*) AS count FROM workshop_events WHERE workshop_id=${workshopId} AND type='brain_memory_written'`)[0].count);
  const countBefore = await eventCount();
  await scoped(() => run(leased, leasedRequest)); await scoped(() => run(leased, leasedRequest));
  assert.equal(await eventCount(), countBefore + 1);
  const rollback = await seed(); const beforeRollback = await counts();
  await client.unsafe(`CREATE FUNCTION reject_revision_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='brain_memory_written' THEN RAISE EXCEPTION 'injected event failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe("CREATE TRIGGER reject_revision_event BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_revision_event()");
  try {await assert.rejects(scoped(() => run(rollback, request(rollback))));}
  finally {await client.unsafe("DROP TRIGGER reject_revision_event ON workshop_events"); await client.unsafe("DROP FUNCTION reject_revision_event()");}
  assert.deepEqual(await counts(), beforeRollback);
  assert.equal((await getBrainMemoryById({userId, memoryId: rollback.id}))!.status, "active");
  return {name: "memory revision: immutable observations/history, equal-rank replace, owner/scope guards, risky candidates, durable replay, races, undo versions, observation/review/event rollback", passed: true};
}
