import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { clearInteractionMemories, clearInteractionWikiItems, createInteractionMemoryCandidate, createInteractionNote,
  createInteractionTask, deleteInteractionWikiItem, updateInteractionMemoryStatus } from "@/lib/interactions/service";
import { reviewBrainMemory } from "@/lib/brain/service";

/** Synthetic records only. The caller owns creation/disposal of the isolated database. */
export async function checkInteractionMemoryGovernance(client: postgres.Sql) {
  const database = (await client`SELECT current_database() AS name`)[0].name;
  assert.match(database, /^zhiyu_test_[a-f0-9]{32}$/);
  assert.equal(new URL(process.env.ZHIYU_TEST_DATABASE_URL ?? "").pathname, `/${database}`);
  const owner = randomUUID(), foreign = randomUUID(), source = randomUUID(), foreignSource = randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},${owner + "@example.invalid"}),(${foreign},${foreign + "@example.invalid"})`;
  for (const [id, userId] of [[source, owner], [foreignSource, foreign]]) await client`INSERT INTO interaction_events
    (id,user_id,platform,source,conversation_name,content,message_time,dedupe_key)
    VALUES (${id},${userId},'fixture','interaction_governance','synthetic conversation','synthetic observation',now(),${randomUUID()})`;
  const create = (subject: string, extra: Record<string, unknown> = {}) => createInteractionMemoryCandidate({ userId: owner,
    memoryType: "preference", subject, content: "Synthetic user prefers concise evidence-backed reports.", confidence: 95,
    sourceEventIds: [source], expiresAt: new Date("2099-01-01T00:00:00.000Z"), ...extra });
  const status = async (id: string) => ({
    legacy: (await client`SELECT status,metadata FROM interaction_memories WHERE id=${id}`)[0],
    brain: (await client`SELECT status,metadata,owner_id FROM brain_memories WHERE id=${id}`)[0],
  });
  const assertPending = async (id: string) => {
    const state = await status(id); assert.equal(state.legacy.status, "candidate"); assert.equal(state.brain.status, "candidate");
  };
  await client.unsafe("CREATE FUNCTION fail_interaction_candidate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.subject LIKE 'interaction_fault_create_%' THEN RAISE EXCEPTION 'injected interaction canonical failure'; END IF; RETURN NEW; END $$");
  await client.unsafe("CREATE TRIGGER fail_interaction_candidate BEFORE INSERT ON brain_memories FOR EACH ROW EXECUTE FUNCTION fail_interaction_candidate()");
  const faultSubject = `interaction_fault_create_${randomUUID()}`;
  try { await assert.rejects(create(faultSubject)); }
  finally { await client.unsafe("DROP TRIGGER fail_interaction_candidate ON brain_memories"); await client.unsafe("DROP FUNCTION fail_interaction_candidate()"); }
  assert.equal((await client`SELECT count(*)::int AS n FROM interaction_memories WHERE user_id=${owner} AND subject=${faultSubject}`)[0].n, 0);
  assert.equal((await client`SELECT count(*)::int AS n FROM brain_memories WHERE user_id=${owner} AND subject=${faultSubject}`)[0].n, 0);
  await assert.rejects(create("foreign source rejected", { sourceEventIds: [foreignSource] }), /missing or not accessible/);
  const memory = await create("same UUID pending candidate", { status: "confirmed" });
  await assertPending(memory.id);
  assert.match(memory.id, /^[a-f0-9-]{36}$/i);
  assert.equal((memory.metadata as Record<string, unknown>).brainMemoryId, memory.id);
  const initial = await status(memory.id);
  assert(initial.brain.metadata.derivedRefs.some((ref: any) => ref.source === "interaction_memory" && ref.id === memory.id));
  await client`UPDATE brain_memories SET owner_id=${foreign} WHERE id=${memory.id}`;
  await assert.rejects(updateInteractionMemoryStatus({ userId: owner, id: memory.id, status: "confirmed" }), /owner and source linkage/);
  assert.equal((await status(memory.id)).legacy.status, "candidate");
  await client`UPDATE brain_memories SET owner_id=${owner} WHERE id=${memory.id}`;
  const installReviewFault = async (id: string) => {
    assert.match(id, /^[a-f0-9-]{36}$/i);
    await client.unsafe(`CREATE FUNCTION fail_interaction_review() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.memory_id='${id}'::uuid THEN RAISE EXCEPTION 'injected interaction review failure'; END IF; RETURN NEW; END $$`);
    await client.unsafe("CREATE TRIGGER fail_interaction_review BEFORE INSERT ON brain_memory_reviews FOR EACH ROW EXECUTE FUNCTION fail_interaction_review()");
  };
  const removeReviewFault = async () => {
    await client.unsafe("DROP TRIGGER fail_interaction_review ON brain_memory_reviews"); await client.unsafe("DROP FUNCTION fail_interaction_review()");
  };
  await installReviewFault(memory.id);
  try { await assert.rejects(updateInteractionMemoryStatus({ userId: owner, id: memory.id, status: "confirmed" })); }
  finally { await removeReviewFault(); }
  await assertPending(memory.id);
  await updateInteractionMemoryStatus({ userId: owner, id: `legacy-interaction-memory:${memory.id}`, status: "confirmed" });
  assert.equal((await status(memory.id)).legacy.status, "confirmed"); assert.equal((await status(memory.id)).brain.status, "verified");
  await installReviewFault(memory.id);
  try { await assert.rejects(deleteInteractionWikiItem({ userId: owner, kind: "memory", id: memory.id })); }
  finally { await removeReviewFault(); }
  assert.equal((await status(memory.id)).legacy.status, "confirmed"); assert.equal((await status(memory.id)).brain.status, "verified");
  await deleteInteractionWikiItem({ userId: owner, kind: "memory", id: `legacy-interaction-memory:${memory.id}` });
  assert.equal((await status(memory.id)).legacy.status, "deleted"); assert.equal((await status(memory.id)).brain.status, "deleted");
  const reviewed = await create("direct canonical review fixture");
  await reviewBrainMemory({ requester: { type: "chat", userId: owner, id: "synthetic-owner" }, memoryId: reviewed.id, decision: "confirmed" });
  const unrelated = randomUUID();
  await client`INSERT INTO brain_memories(id,user_id,scope_type,owner_type,owner_id,memory_type,subject,content,status)
    VALUES (${unrelated},${owner},'global','chat',${owner},'preference','generic owner memory','outside interaction cleanup','candidate')`;
  assert.equal((await clearInteractionMemories({ userId: owner })).deletedCount, 1);
  assert.equal((await client`SELECT status FROM brain_memories WHERE id=${unrelated}`)[0].status, "candidate");
  const keep = await create("preserved memory"), drop = await create("deleted memory");
  const note = await createInteractionNote({ userId: owner, noteType: "fact", title: "Synthetic note", body: "Synthetic body", sourceEventIds: [source] });
  const task = await createInteractionTask({ userId: owner, title: "Synthetic task", status: "confirmed", sourceEventIds: [source] });
  const preserves = { memoryIds: [`legacy-interaction-memory:${keep.id}`] };
  await installReviewFault(drop.id);
  try { await assert.rejects(clearInteractionWikiItems({ userId: owner, preserve: preserves })); }
  finally { await removeReviewFault(); }
  await assertPending(drop.id); await assertPending(keep.id);
  assert.equal((await client`SELECT status FROM interaction_tasks WHERE id=${task.id}`)[0].status, "confirmed");
  assert.equal((await client`SELECT metadata->>'deletedAt' AS deleted FROM interaction_notes WHERE id=${note.id}`)[0].deleted, null);
  const cleared = await clearInteractionWikiItems({ userId: owner, preserve: preserves });
  assert.deepEqual(cleared, { deletedNotes: 1, deletedTasks: 1, deletedMemories: 1, deletedCount: 3 });
  await assertPending(keep.id);
  assert.equal((await status(drop.id)).brain.status, "deleted");
  assert.equal((await status(drop.id)).legacy.status, "deleted");
  assert.equal((await client`SELECT status FROM brain_memories WHERE id=${unrelated}`)[0].status, "candidate");
  return { name: "actual interaction candidate/review/delete/clear atomicity: same UUID, forced pending candidate, raw-source and owner isolation, canonical trigger rollback, preserved scope and unrelated owner memory retention", passed: true };
}
