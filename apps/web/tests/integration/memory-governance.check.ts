import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { buildInteractionScenarioSnapshots } from "@/lib/interactions/scenarios";
import { persistInteractionScenarioState } from "@/lib/interactions/scenario-state-store";
import { actOnInteractionTask } from "@/lib/interactions/task-state";
import { updateInteractionTaskStatus } from "@/lib/interactions/service";

/** Synthetic fixtures only; invoked by the isolated migration runner. */
export async function checkMemoryGovernance(client: postgres.Sql) {
  const database = (await client`SELECT current_database() AS name`)[0].name;
  assert.match(database, /^zhiyu_test_[a-f0-9]{32}$/);
  assert.equal(new URL(process.env.ZHIYU_TEST_DATABASE_URL ?? "").pathname, `/${database}`);
  const owner = randomUUID(), foreignOwner = randomUUID(), memoryId = randomUUID();
  const events = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const tasks = [randomUUID(), randomUUID(), randomUUID()];
  const scenarioKey = `governance-${randomUUID()}`;
  await client`INSERT INTO "User"(id,email) VALUES (${owner},${owner + "@example.invalid"}),(${foreignOwner},${foreignOwner + "@example.invalid"})`;
  for (let index = 0; index < events.length; index++) await client`INSERT INTO interaction_events
    (id,user_id,platform,source,conversation_name,content,message_time,dedupe_key)
    VALUES (${events[index]},${index === 3 ? foreignOwner : owner},'fixture','memory_governance','synthetic scenario','synthetic observation',now(),${randomUUID()})`;
  await client`INSERT INTO brain_memories(id,user_id,scope_type,owner_type,owner_id,memory_type,subject,content,status,evidence_refs)
    VALUES (${memoryId},${owner},'global','chat',${owner},'fact','fixture candidate','unverified fixture','candidate',${JSON.stringify([events[0]])}::jsonb)`;
  const hint = { type: "project" as const, key: scenarioKey, title: "Synthetic scenario" };
  for (let index = 0; index < tasks.length; index++) await client`INSERT INTO interaction_tasks
    (id,user_id,title,status,source_event_ids,metadata) VALUES (${tasks[index]},${owner},${`task ${index}`},'candidate',
      ${JSON.stringify([events[index]])}::jsonb,${JSON.stringify({ scenarioHints: [hint] })}::jsonb)`;
  const draft = (index: number, status = "candidate", includeMemory = false) => buildInteractionScenarioSnapshots({
    observedAt: new Date("2026-10-20T01:00:00.000Z"), items: [
      { id: tasks[index], kind: "task", title: `task ${index}`, content: "fixture task", status,
        sourceEventIds: [events[index]], metadata: { scenarioHints: [hint] } },
      ...(includeMemory ? [{ id: memoryId, kind: "memory" as const, subject: "fixture candidate", content: "unverified fixture",
        confidence: 60, sourceEventIds: [events[0]], metadata: { scenarioHints: [hint] } }] : []),
    ],
  })[0];
  const snapshots = async () => client`SELECT id,content,metadata FROM brain_state_snapshots
    WHERE user_id=${owner} AND snapshot_type='wechat_scenario_state'
    AND metadata->>'scenarioType'='project' AND metadata->>'scenarioKey'=${scenarioKey}
    ORDER BY (metadata->>'revision')::bigint`;
  const first = await persistInteractionScenarioState({ userId: owner, draft: draft(0, "candidate", true) });
  assert.equal(first.content.revision, 1);
  assert.equal(first.content.authority, "model_estimate_unverified");
  const concurrent = await Promise.all([persistInteractionScenarioState({ userId: owner, draft: draft(1) }),
    persistInteractionScenarioState({ userId: owner, draft: draft(2) })]);
  assert.deepEqual(concurrent.map(row => Number(row.content.revision)).sort(), [2, 3]);
  const afterConcurrent = await snapshots();
  assert.equal(afterConcurrent.length, 3);
  assert.deepEqual(afterConcurrent[2].content.openLoops.map((task: any) => task.id).sort(), [...tasks].sort());
  assert.equal(afterConcurrent[1].content.previousSnapshotId, first.id);
  assert.equal(afterConcurrent[2].content.previousSnapshotId, afterConcurrent[1].id);
  const replayed = await persistInteractionScenarioState({ userId: owner, draft: draft(0, "candidate", true) });
  assert.equal(replayed.id, afterConcurrent[2].id); assert.equal((await snapshots()).length, 3);

  // Both owner-facing task mutations project in the same transaction.
  await actOnInteractionTask({ userId: owner, id: tasks[0], commandId: randomUUID(), expectedVersion: 0, action: "completeTask" });
  await updateInteractionTaskStatus({ userId: owner, id: tasks[1], status: "dismissed" });
  let rows = await snapshots();
  assert.equal(rows.length, 5);
  const latestAfterClosure = rows.at(-1); assert.ok(latestAfterClosure);
  assert.deepEqual(latestAfterClosure.content.openLoops.map((task: any) => task.id), [tasks[2]]);
  assert.deepEqual(latestAfterClosure.content.closedLoops.map((task: any) => task.id).sort(), tasks.slice(0, 2).sort());
  assert.equal((await client`SELECT status FROM brain_memories WHERE id=${memoryId}`)[0].status, "candidate");
  const foreignSource = draft(2);
  foreignSource.sourceEventIds = [events[3]]; foreignSource.content.sourceEventIds = [events[3]];
  foreignSource.content.taskUpdates![0].sourceEventIds = [events[3]];
  foreignSource.content.openLoops[0].sourceEventIds = [events[3]];
  await assert.rejects(persistInteractionScenarioState({ userId: owner, draft: foreignSource }), { code: "memory_reference_not_found" });
  assert.equal((await snapshots()).length, 5);

  const legacyId = randomUUID(), legacyKey = `Legacy-${randomUUID()}`;
  const legacyDraft = draft(2);
  Object.assign(legacyDraft, { scenarioType: "topic", scenarioKey: legacyKey });
  Object.assign(legacyDraft.content, { scenarioType: "topic", scenarioKey: legacyKey });
  await client`INSERT INTO brain_state_snapshots(id,user_id,scope_type,snapshot_type,content,metadata)
    VALUES (${legacyId},${owner},'global','wechat_scenario_state',${JSON.stringify(legacyDraft.content)}::jsonb,
      ${JSON.stringify({ scenarioType: "topic", scenarioKey: legacyKey, observedAt: "2026-10-19T00:00:00.000Z" })}::jsonb)`;
  legacyDraft.scenarioKey = legacyKey.toLowerCase(); legacyDraft.content.scenarioKey = legacyKey.toLowerCase();
  const legacyMerged = await persistInteractionScenarioState({ userId: owner, draft: legacyDraft });
  assert.equal(legacyMerged.content.previousSnapshotId, legacyId);
  assert.equal(legacyMerged.metadata.historicalCoverage, "legacy_snapshot_coverage_unknown");

  // A storage fault cannot commit either a new snapshot or the task status.
  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `reject_governance_${suffix}`, triggerName = `reject_governance_${suffix}`;
  await client.unsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${owner}'::uuid AND NEW.snapshot_type='wechat_scenario_state' THEN RAISE EXCEPTION 'injected governance snapshot failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON brain_state_snapshots FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
  const storageFault = (error: any) => {
    const messages: string[] = []; let current = error;
    for (let depth = 0; current && depth < 8; depth++, current = current.cause) messages.push(String(current.message));
    assert.match(messages.join(" "), /injected governance snapshot failure/); return true;
  };
  try {
    await assert.rejects(updateInteractionTaskStatus({ userId: owner, id: tasks[2], status: "done" }), storageFault);
    await assert.rejects(actOnInteractionTask({ userId: owner, id: tasks[2], commandId: randomUUID(), expectedVersion: 0, action: "completeTask" }), storageFault);
    assert.equal((await client`SELECT status FROM interaction_tasks WHERE id=${tasks[2]}`)[0].status, "candidate");
    assert.equal((await snapshots()).length, 5);
  } finally {
    await client.unsafe(`DROP TRIGGER ${triggerName} ON brain_state_snapshots`);
    await client.unsafe(`DROP FUNCTION ${functionName}()`);
  }
  const overCapacity = draft(2);
  overCapacity.content.taskUpdates = Array.from({ length: 5_001 }, (_, index) => ({ id: `capacity-${index}`, title: "fixture", status: "candidate", sourceEventIds: [events[2]] }));
  await assert.rejects(persistInteractionScenarioState({ userId: owner, draft: overCapacity }), { code: "scenario_state_capacity_exceeded" });
  rows = await snapshots(); assert.equal(rows.length, 5);
  const latest = rows.at(-1); assert.ok(latest);
  assert.equal(latest.content.verification, "business_state_not_verified");
  return { name: "memory governance: real PostgreSQL append-only scenario merge, concurrent lineage lock, replay, owner sources and atomic task projections",
    passed: true, databaseScope: "synthetic_isolated", snapshots: rows.length, revisions: rows.map(row => row.content.revision),
    checks: ["first snapshot", "two competing batches", "old-batch replay", "same-id task closure", "foreign source rejected", "legacy key normalization and unknown historical coverage", "both task mutations roll back on projection failure", "capacity failure preserves prior version", "Brain candidate stays candidate"] };
}
