import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { createOwnerMemoryClient } from "@/lib/memory";
import { actOnInteractionTask, TaskActionConflict } from "@/lib/interactions/task-state";
import { clearInteractionWikiItems, createInteractionTask, deleteInteractionWikiItem, updateInteractionTaskStatus } from "@/lib/interactions/service";
import { buildInteractionScenarioSnapshots } from "@/lib/interactions/scenarios";
import { persistInteractionScenarioState } from "@/lib/interactions/scenario-state-store";
import { withExecutionContext } from "@/lib/work-runtime/execution-context";
import { createBrainStateSnapshot } from "@/lib/brain/service";

type TaskView = { id: string; userId: string; title: string; status: string; revision: number; eventId?: string | null;
  metadata: { taskState?: { version?: number; verificationStatus?: string }; [key: string]: unknown } };
type CurrentResult<T> = { status: string; record: T; ref: { record: Record<string, unknown>; revision: string };
  receipt: { id: string; purpose: "current"; ref: { record: Record<string, unknown>; revision: string } } };
type ScenarioView = { id: string; content: { revision: number; authority: string;
  openLoops: Array<{ id: string; status: string; stateRevision?: number }>;
  closedLoops: Array<{ id: string; status: string; stateRevision?: number }> } };
type MigrationFixture = { owner: string; schemaBefore: string; cases: Array<{ id: string; expectedVersion: number; metadata: Record<string, unknown> }> };

function currentRecord<T>(value: unknown): CurrentResult<T> {
  const result = value as CurrentResult<T>;
  assert.equal(result.status, "ok"); assert.ok(result.record); assert.ok(result.ref?.revision);
  assert.equal(result.receipt.purpose, "current"); assert.deepEqual(result.receipt.ref, result.ref);
  return result;
}
function version(task: TaskView, expected: number) {
  assert.equal(typeof task.revision, "number"); assert.equal(task.revision, expected);
  assert.equal(task.metadata.taskState?.version, expected, "Metadata is a mirror of the authoritative task revision");
}
function errorIncludes(error: unknown, expected: RegExp) {
  const messages: string[] = []; let cause = error;
  for (let depth = 0; depth < 8 && cause && typeof cause === "object"; depth++) {
    messages.push(String((cause as { message?: unknown }).message)); cause = (cause as { cause?: unknown }).cause;
  }
  assert.match(messages.join(" "), expected); return true;
}

async function databaseBarrier<T>(label: string, inspect: () => Promise<T | undefined>) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await inspect(); if (value !== undefined) return value;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw Error(`T2 database barrier not observed: ${label}`);
}

async function checkFencedTaskWrites(client: postgres.Sql, userId: string, source: string) {
  const workshopId = randomUUID(), runId = randomUUID(), workerId = `t2-worker-${randomUUID()}`;
  const lease = { userId, workshopId, runId, workerId, token: 7 };
  await client`INSERT INTO workshops(id,user_id,name,mission,status) VALUES (${workshopId},${userId},'T2 synthetic fence','fixture','active')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${runId},${workshopId},'running',clock_timestamp())`;
  await client`INSERT INTO workshop_execution_leases(workshop_id,token,run_id,worker_id,phase,lease_until)
    VALUES (${workshopId},${lease.token},${runId},${workerId},'running',clock_timestamp()+interval '5 minutes')`;
  const input = { userId, commandId: randomUUID(), title: "Synthetic leased task", sourceEventIds: [source],
    metadata: { scenarioHints: [{ type: "project", key: `t2-leased-${randomUUID()}`, title: "Synthetic leased scenario" }] } };
  const task = await withExecutionContext(lease, () => createInteractionTask(input)); version(task, 0);
  const confirmed = await withExecutionContext(lease, () => actOnInteractionTask({ userId, id: task.id,
    action: "confirmEvidence", commandId: randomUUID(), expectedVersion: 0 })); version(confirmed.task, 1);
  const execution = { workshopId, runId, workerId, token: lease.token };
  const initialAudits = await client`SELECT snapshot FROM interaction_task_revisions WHERE task_id=${task.id} ORDER BY revision`;
  assert.equal(initialAudits.length, 2);
  for (const row of initialAudits) { assert.deepEqual(row.snapshot.execution, execution); assert.equal(row.snapshot.actor, userId); }
  const counts = async () => (await client`SELECT
    (SELECT count(*)::int FROM interaction_tasks WHERE user_id=${userId}) AS tasks,
    (SELECT count(*)::int FROM interaction_task_revisions WHERE user_id=${userId}) AS history,
    (SELECT count(*)::int FROM brain_state_snapshots WHERE user_id=${userId}) AS scenarios`)[0];
  const before = await counts(), stale = { ...lease, token: lease.token - 1 };
  await assert.rejects(withExecutionContext(lease, () => createBrainStateSnapshot({ userId, scope: { type: "global" },
    snapshotType: "wechat_scenario_state", content: { authority: "business_task_record", revision: 999999 },
    metadata: { scenarioType: "project", scenarioKey: input.metadata.scenarioHints[0].key, revision: 999999 } })),
    { code: "reserved_scenario_snapshot", status: 400 });
  assert.deepEqual(await counts(), before);
  await assert.rejects(withExecutionContext(stale, () => createInteractionTask({ ...input, commandId: randomUUID() })), { code: "lease_lost" });
  await assert.rejects(withExecutionContext(stale, () => actOnInteractionTask({ userId, id: task.id,
    action: "completeTask", commandId: randomUUID(), expectedVersion: 1 })), { code: "lease_lost" });
  assert.deepEqual(await counts(), before);
  const trigger = `reject_t2_fenced_${randomUUID().replaceAll("-", "")}`;
  const command = { userId, id: task.id, action: "completeTask" as const, commandId: randomUUID(), expectedVersion: 1 };
  await client.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${userId}'::uuid AND NEW.snapshot_type='wechat_scenario_state' THEN RAISE EXCEPTION 'injected T2 fenced projection failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON brain_state_snapshots FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  try {
    await assert.rejects(withExecutionContext(lease, () => actOnInteractionTask(command)), error => errorIncludes(error, /injected T2 fenced projection failure/));
    assert.deepEqual(await counts(), before);
    const current = currentRecord<TaskView>(await createOwnerMemoryClient(userId).read({ purpose: "current", ref: { kind: "interaction_task", id: task.id } }));
    version(current.record, 1); assert.equal(current.record.metadata.taskState?.verificationStatus, "confirmed");
  } finally { await client.unsafe(`DROP TRIGGER ${trigger} ON brain_state_snapshots`); await client.unsafe(`DROP FUNCTION ${trigger}()`); }
  const completed = await withExecutionContext(lease, () => actOnInteractionTask(command)); version(completed.task, 2);
  assert.equal(Number((await client`SELECT count(*)::int AS n FROM interaction_task_revisions WHERE task_id=${task.id}`)[0].n), 3);
  const snapshots = await client`SELECT content FROM brain_state_snapshots WHERE user_id=${userId} AND metadata->>'scenarioKey'=${input.metadata.scenarioHints[0].key} ORDER BY created_at DESC LIMIT 1`;
  assert.ok(snapshots[0].content.closedLoops.some((item: { id: string; stateRevision: number }) => item.id === task.id && item.stateRevision === 2));
  return "valid synthetic Work/run/lease commits task history and L2, stale tokens cannot write, and a projection fault rolls back before the same command recovers";
}

async function checkCurrentReceiptFailure(client: postgres.Sql, userId: string, taskId: string, scenarioKey: string) {
  const count = async () => Number((await client`SELECT count(*)::int AS n FROM memory_state_read_receipts WHERE user_id=${userId}`)[0].n);
  const before = await count(), trigger = `reject_t2_receipt_${randomUUID().replaceAll("-", "")}`;
  await client.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${userId}'::uuid THEN RAISE EXCEPTION 'injected T2 current receipt failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON memory_state_read_receipts FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  try {
    const owner = createOwnerMemoryClient(userId);
    for (const ref of [{ kind: "interaction_task" as const, id: taskId }, { kind: "scenario_state" as const, scenarioType: "project" as const, scenarioKey }]) {
      await assert.rejects(owner.read({ purpose: "current", ref }), error => errorIncludes(error, /injected T2 current receipt failure/));
      assert.equal(await count(), before);
    }
  } finally { await client.unsafe(`DROP TRIGGER ${trigger} ON memory_state_read_receipts`); await client.unsafe(`DROP FUNCTION ${trigger}()`); }
  return "a state-read receipt insert failure rejects task/scenario current reads and leaves no successful receipt";
}

async function checkCurrentTaskCommitOrder(client: postgres.Sql, userId: string, source: string) {
  const task = await createInteractionTask({ userId, commandId: randomUUID(), title: "Synthetic task read lock",
    sourceEventIds: [source] });
  const owner = createOwnerMemoryClient(userId), coordinator = await client.reserve();
  const key1 = Number.parseInt(randomUUID().slice(0, 7), 16), key2 = Number.parseInt(randomUUID().slice(0, 7), 16);
  const trigger = `gate_t2_current_${randomUUID().replaceAll("-", "")}`;
  let held = false, functionCreated = false, triggerCreated = false, readSettled = false, writeSettled = false;
  let reading: Promise<{ result?: unknown; error?: unknown }> | undefined;
  let writing: Promise<{ result?: Awaited<ReturnType<typeof actOnInteractionTask>>; error?: unknown }> | undefined;
  try {
    await coordinator`SELECT pg_advisory_lock(${key1},${key2})`; held = true;
    await client.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${userId}'::uuid THEN PERFORM pg_advisory_xact_lock(${key1},${key2}); END IF; RETURN NEW; END $$`);
    functionCreated = true;
    await client.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON memory_state_read_receipts FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    triggerCreated = true;
    reading = owner.read({ purpose: "current", ref: { kind: "interaction_task", id: task.id } })
      .then(result => ({ result }), error => ({ error })).finally(() => { readSettled = true; });
    const readerPid = await databaseBarrier("current reader waits inside its receipt insert", async () => {
      if (readSettled) throw Error("Current reader finished before its receipt barrier");
      const rows = await client`SELECT pid FROM pg_locks WHERE locktype='advisory' AND NOT granted
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND classid=${key1}::oid AND objid=${key2}::oid AND objsubid=2`;
      return rows[0] ? Number(rows[0].pid) : undefined;
    });
    writing = actOnInteractionTask({ userId, id: task.id, action: "confirmEvidence", commandId: randomUUID(), expectedVersion: 0 })
      .then(result => ({ result }), error => ({ error })).finally(() => { writeSettled = true; });
    await databaseBarrier("domain task writer is blocked by current reader", async () => {
      if (writeSettled) throw Error("Task writer committed before the current read receipt");
      const rows = await client`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
        AND ${readerPid}::int=ANY(pg_blocking_pids(pid))`;
      return rows[0] ? Number(rows[0].pid) : undefined;
    });
    await coordinator`SELECT pg_advisory_unlock(${key1},${key2})`; held = false;
    const readOutcome = await reading; if (readOutcome.error) throw readOutcome.error;
    const read = currentRecord<TaskView>(readOutcome.result); version(read.record, 0); assert.ok(read.ref.revision.startsWith("task:0:"));
    const writeOutcome = await writing; if (writeOutcome.error) throw writeOutcome.error;
    assert.ok(writeOutcome.result); version(writeOutcome.result.task, 1);
    assert.equal(Number((await client`SELECT count(*)::int AS n FROM memory_state_read_receipts WHERE id=${read.receipt.id}`)[0].n), 1);
  } finally {
    if (held) await coordinator`SELECT pg_advisory_unlock(${key1},${key2})`;
    if (reading) await reading;
    if (writing) await writing;
    if (triggerCreated) await client.unsafe(`DROP TRIGGER ${trigger} ON memory_state_read_receipts`);
    if (functionCreated) await client.unsafe(`DROP FUNCTION ${trigger}()`);
    coordinator.release();
  }
  version(currentRecord<TaskView>(await owner.read({ purpose: "current", ref: { kind: "interaction_task", id: task.id } })).record, 1);
  return "pg_locks barrier proves a current task snapshot/ref/receipt commits coherently before a competing real domain transition";
}

/** Public domain writers and exact Memory reads, only in a fresh isolated DB. */
export async function checkMemoryModuleT2(client: postgres.Sql, migration: MigrationFixture) {
  const database = String((await client`SELECT current_database() AS name`)[0].name);
  assert.match(database, /^zhiyu_test_[a-f0-9]{32}$/);
  assert.equal(new URL(process.env.ZHIYU_TEST_DATABASE_URL ?? "").pathname, `/${database}`);
  assert.equal(process.env.ZHIYU_TEST_MODE, "integration");
  assert.equal(migration?.schemaBefore, "revision_column_absent", "The runner must seed before the real revision migration");
  const checks: string[] = [];
  for (const fixture of migration.cases) {
    const result = currentRecord<TaskView>(await createOwnerMemoryClient(migration.owner).read({ purpose: "current", ref: { kind: "interaction_task", id: fixture.id } }));
    version(result.record, fixture.expectedVersion); assert.ok(result.ref.revision.startsWith(`task:${fixture.expectedVersion}:`));
    assert.equal(result.record.metadata.legacyMarker, fixture.metadata.legacyMarker);
    const baseline = await client`SELECT revision,snapshot FROM interaction_task_revisions WHERE user_id=${migration.owner} AND task_id=${fixture.id}`;
    assert.equal(baseline.length, 1); assert.equal(Number(baseline[0].revision), fixture.expectedVersion);
    assert.equal(baseline[0].snapshot.historyCoverage, "from_migration_only");
    assert.equal(baseline[0].snapshot.task.metadata.legacyMarker, fixture.metadata.legacyMarker);
  }
  checks.push("actual 0162 migration preserves valid legacy version 7, defaults missing version to 0, mirrors metadata and creates explicit baseline history");

  const userId = randomUUID(), foreignUser = randomUUID(), source = randomUUID(), foreignSource = randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},${userId + "@example.invalid"}),(${foreignUser},${foreignUser + "@example.invalid"})`;
  for (const [id, user] of [[source, userId], [foreignSource, foreignUser]]) await client`INSERT INTO interaction_events
    (id,user_id,platform,source,conversation_name,content,message_time,dedupe_key)
    VALUES (${id},${user},'fixture','memory_module_t2','synthetic conversation','Synthetic source observation','2026-10-01T00:00:00Z',${randomUUID()})`;
  const scenarioKey = `t2-${randomUUID()}`, hint = { type: "project" as const, key: scenarioKey.toUpperCase(), title: "Synthetic T2 scenario" };
  const owner = createOwnerMemoryClient(userId), foreign = createOwnerMemoryClient(foreignUser);
  const readTask = async (id: string) => currentRecord<TaskView>(await owner.read({ purpose: "current", ref: { kind: "interaction_task", id } }));
  const readScenario = async () => currentRecord<ScenarioView>(await owner.read({ purpose: "current",
    ref: { kind: "scenario_state", scenarioType: "project", scenarioKey } }));
  const createInput = (title: string) => ({ userId, commandId: randomUUID(), title, status: "candidate", sourceEventIds: [source], metadata: { scenarioHints: [hint] } });
  const creation = createInput("\u5408\u6210 T2 task A");
  const created = await createInteractionTask(creation); version(created, 0);
  const createReplay = await createInteractionTask(creation); assert.equal(createReplay.id, created.id); version(createReplay, 0);
  await assert.rejects(createInteractionTask({ ...creation, title: "Conflicting create" }), TaskActionConflict);
  const initialScenario = await readScenario(); assert.equal(initialScenario.record.content.authority, "model_estimate_unverified");
  assert.ok(initialScenario.record.content.openLoops.some(task => task.id === created.id && task.stateRevision === 0));
  const creationHistory = await client`SELECT id,snapshot FROM interaction_task_revisions WHERE user_id=${userId} AND command_id=${creation.commandId}`;
  assert.equal(creationHistory.length, 1); assert.equal(creationHistory[0].snapshot.task.revision, 0);
  for (const read of [await readTask(created.id), initialScenario]) {
    const explanation = await owner.explain({ receiptId: read.receipt.id });
    assert.ok(explanation.status === "ok" && "ref" in explanation.receipt); assert.deepEqual(explanation.receipt.ref, read.ref);
    assert.equal((await foreign.explain({ receiptId: read.receipt.id })).status, "not_found");
    const stored = await client`SELECT to_jsonb(r) AS value FROM memory_state_read_receipts AS r WHERE id=${read.receipt.id}`;
    assert.equal(stored.length, 1); assert.ok(!JSON.stringify(stored[0].value).includes(created.title), "State read receipt stores a locator/version, not task text");
  }
  checks.push("create and idempotent retry write one revision-0 task/history and a same-transaction L2 projection");

  const races = [
    { userId, id: created.id, commandId: randomUUID(), expectedVersion: 0, action: "completeTask" as const },
    { userId, id: created.id, commandId: randomUUID(), expectedVersion: 0, action: "dismiss" as const },
  ];
  const outcomes = await Promise.allSettled(races.map(command => actOnInteractionTask(command)));
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(result => result.status === "rejected").length, 1);
  const loser = outcomes.find(result => result.status === "rejected");
  assert.ok(loser?.status === "rejected" && loser.reason instanceof TaskActionConflict);
  const winnerIndex = outcomes.findIndex(result => result.status === "fulfilled"), outcome = outcomes[winnerIndex];
  assert.ok(outcome.status === "fulfilled"); const won = outcome.value; version(won.task, 1);
  assert.equal(won.receipt.fromVersion, 0); assert.equal(won.receipt.toVersion, 1);
  const replay = await actOnInteractionTask(races[winnerIndex]);
  assert.equal(replay.replayed, true); assert.equal(replay.receipt.id, won.receipt.id); version(replay.task, 1);
  assert.equal(replay.resultSemantics, "command_result_at_revision");
  await assert.rejects(actOnInteractionTask({ ...races[winnerIndex], expectedVersion: 1 }), TaskActionConflict);
  assert.ok((await readTask(created.id)).ref.revision.startsWith("task:1:"));
  const advancedCreateReplay = await createInteractionTask(creation); version(advancedCreateReplay, 1);
  assert.equal((await client`SELECT snapshot->'task'->>'revision' AS revision FROM interaction_task_revisions WHERE id=${creationHistory[0].id}`)[0].revision, "0");
  checks.push("competing same-version actions have one winner; retry has a fixed receipt; changed expectedVersion conflicts; create retry returns current task without rewriting its creation history");

  const late = buildInteractionScenarioSnapshots({ observedAt: new Date("2026-10-02T00:00:00Z"), processingMode: "t2_late_batch", items: [{
    id: created.id, kind: "task", title: created.title, content: "Late model candidate", status: "candidate", sourceEventIds: [source], metadata: { scenarioHints: [hint] },
  }] })[0];
  await persistInteractionScenarioState({ userId, draft: late });
  const afterLate = (await readScenario()).record.content;
  assert.ok(!afterLate.openLoops.some(task => task.id === created.id));
  assert.ok(afterLate.closedLoops.some(task => task.id === created.id && task.stateRevision === 1));
  await assert.rejects(updateInteractionTaskStatus({ userId, id: created.id, status: "confirmed", commandId: randomUUID(), expectedVersion: 1 }));
  version((await readTask(created.id)).record, 1);
  checks.push("late candidate batches and legacy confirmation cannot reopen a terminal authoritative task");

  const secondCreation = createInput("Synthetic task B");
  const second = await createInteractionTask(secondCreation); version(second, 0);
  const confirmed = await updateInteractionTaskStatus({ userId, id: second.id, status: "confirmed", commandId: randomUUID(), expectedVersion: 0 }); version(confirmed, 1);
  const correction = { userId, id: second.id, action: "correctTime" as const, commandId: randomUUID(), expectedVersion: 1, at: "2099-01-01T00:00:00Z" };
  const corrected = await actOnInteractionTask(correction); version(corrected.task, 2);
  await updateInteractionTaskStatus({ userId, id: second.id, status: "done", commandId: randomUUID(), expectedVersion: 2 });
  const oldResult = await actOnInteractionTask(correction); version(oldResult.task, 2);
  assert.equal(oldResult.resultSemantics, "command_result_at_revision");
  version((await readTask(second.id)).record, 3);
  const deletion = { userId, kind: "task" as const, id: second.id, commandId: randomUUID(), expectedVersion: 3 };
  const deleted = await deleteInteractionWikiItem(deletion); assert.ok(deleted.task); version(deleted.task, 4);
  const deletedAgain = await deleteInteractionWikiItem(deletion); assert.ok(deletedAgain.task); version(deletedAgain.task, 4);
  assert.equal((await readTask(second.id)).record.status, "deleted");
  assert.ok((await readScenario()).record.content.closedLoops.some(task => task.id === second.id && task.stateRevision === 4));
  checks.push("legacy status, action and single delete share the revision/history/projection path; historical action replay is distinct from exact current");

  const third = await createInteractionTask(createInput("Synthetic clear task"));
  const preserved = await createInteractionTask(createInput("Synthetic preserved task"));
  await clearInteractionWikiItems({ userId, preserve: { taskIds: [preserved.id] } });
  version((await readTask(created.id)).record, 2); assert.equal((await readTask(created.id)).record.status, "deleted");
  version((await readTask(third.id)).record, 1); assert.equal((await readTask(third.id)).record.status, "deleted");
  version((await readTask(preserved.id)).record, 0); assert.equal((await readTask(preserved.id)).record.status, "candidate");
  checks.push("clear records domain transitions and L2 closure for each changed task while preserving the excluded task");

  const snapshotCount = async () => Number((await client`SELECT count(*)::int AS n FROM brain_state_snapshots WHERE user_id=${userId}`)[0].n);
  const historyCount = async () => Number((await client`SELECT count(*)::int AS n FROM interaction_task_revisions WHERE user_id=${userId}`)[0].n);
  const beforeFault = { snapshots: await snapshotCount(), history: await historyCount(), tasks: Number((await client`SELECT count(*)::int AS n FROM interaction_tasks WHERE user_id=${userId}`)[0].n) };
  const trigger = `reject_t2_projection_${randomUUID().replaceAll("-", "")}`;
  await client.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${userId}'::uuid AND NEW.snapshot_type='wechat_scenario_state' THEN RAISE EXCEPTION 'injected T2 projection failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON brain_state_snapshots FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  const failedCreate = createInput("Synthetic failed create");
  const projectionFailure = (error: unknown) => {
    const messages: string[] = []; let cause = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === "object"; depth++) {
      messages.push(String((cause as { message?: unknown }).message)); cause = (cause as { cause?: unknown }).cause;
    }
    assert.match(messages.join(" "), /injected T2 projection failure/); return true;
  };
  try {
    for (const write of [() => createInteractionTask(failedCreate),
      () => actOnInteractionTask({ userId, id: preserved.id, action: "completeTask", commandId: randomUUID(), expectedVersion: 0 }),
      () => updateInteractionTaskStatus({ userId, id: preserved.id, status: "done", commandId: randomUUID(), expectedVersion: 0 }),
      () => deleteInteractionWikiItem({ userId, kind: "task", id: preserved.id, commandId: randomUUID(), expectedVersion: 0 }),
      () => clearInteractionWikiItems({ userId })]) {
      await assert.rejects(write(), projectionFailure);
      version((await readTask(preserved.id)).record, 0); assert.equal((await readTask(preserved.id)).record.status, "candidate");
      assert.equal(await snapshotCount(), beforeFault.snapshots); assert.equal(await historyCount(), beforeFault.history);
      assert.equal(Number((await client`SELECT count(*)::int AS n FROM interaction_tasks WHERE user_id=${userId}`)[0].n), beforeFault.tasks);
    }
  } finally { await client.unsafe(`DROP TRIGGER ${trigger} ON brain_state_snapshots`); await client.unsafe(`DROP FUNCTION ${trigger}()`); }
  const recovered = await createInteractionTask(failedCreate); version(recovered, 0);
  checks.push("projection failure rolls back create/action/legacy status/delete/clear together with task revision, history and snapshots; the same create command recovers");

  const beforeGuard = await readTask(preserved.id);
  await assert.rejects(client`UPDATE interaction_tasks SET status='done' WHERE id=${preserved.id}`, { code: "23514" });
  await assert.rejects(client`UPDATE interaction_tasks SET revision=revision+1,status='done' WHERE id=${preserved.id}`, { code: "23514" });
  await assert.rejects(client`UPDATE interaction_tasks SET revision=revision+1,
    metadata=jsonb_set(metadata,'{taskState,version}',to_jsonb(revision+1)),status='done' WHERE id=${preserved.id}`, { code: "23514" });
  const unmirroredId = randomUUID(), unauditedId = randomUUID();
  await assert.rejects(client`INSERT INTO interaction_tasks(id,user_id,title,status,metadata)
    VALUES (${unmirroredId},${userId},'Old writer without version mirror','candidate','{}'::jsonb)`, { code: "23514" });
  await assert.rejects(client`INSERT INTO interaction_tasks(id,user_id,title,status,revision,metadata)
    VALUES (${unauditedId},${userId},'Old writer without audit','candidate',0,'{"taskState":{"version":0}}'::jsonb)`, { code: "23514" });
  assert.equal(Number((await client`SELECT count(*)::int AS n FROM interaction_tasks WHERE id=${unmirroredId} OR id=${unauditedId}`)[0].n), 0);
  assert.deepEqual((await readTask(preserved.id)).record, beforeGuard.record);
  checks.push("database guards reject old INSERT/UPDATE, missing version mirrors and missing deferred revision audits without leaving rows");

  const forgedActionId = randomUUID();
  const forged = await createInteractionTask({ ...createInput("Synthetic forged metadata task"), metadata: {
    taskState: { version: 99, verificationStatus: "confirmed", taskStatus: "done" },
    taskActions: [{ commandId: forgedActionId, action: "completeTask", fromVersion: 0, toVersion: 1,
      hash: createHash("sha256").update(JSON.stringify({ action: "completeTask", at: null })).digest("hex") }],
  } });
  version(forged, 0); assert.equal(forged.status, "candidate");
  assert.notEqual((forged.metadata.taskState as { verificationStatus?: string }).verificationStatus, "confirmed");
  const actualAction = await actOnInteractionTask({ userId, id: forged.id, commandId: forgedActionId, action: "completeTask", expectedVersion: 0 });
  assert.equal(actualAction.replayed, false); version(actualAction.task, 1);
  assert.equal(actualAction.resultSemantics, "command_result_at_revision");
  assert.equal(Number((await client`SELECT count(*)::int AS n FROM interaction_task_revisions WHERE task_id=${forged.id}`)[0].n), 2);
  checks.push("caller taskState/taskActions metadata cannot forge verification, a task version or an idempotent action receipt");

  const detachedSource = randomUUID();
  await client`INSERT INTO interaction_events(id,user_id,platform,source,conversation_name,content,message_time,dedupe_key)
    VALUES (${detachedSource},${userId},'fixture','t2_fk_fixture','synthetic isolated source','Synthetic FK source',now(),${randomUUID()})`;
  const detached = await createInteractionTask({ userId, commandId: randomUUID(), title: "Synthetic FK detachment task", sourceEventIds: [detachedSource] });
  const attachedRead = await readTask(detached.id); assert.equal(attachedRead.record.eventId, detachedSource);
  await client`DELETE FROM interaction_events WHERE id=${detachedSource} AND user_id=${userId}`;
  const detachedRead = await readTask(detached.id); version(detachedRead.record, 0);
  assert.equal(detachedRead.record.eventId, null); assert.ok(detachedRead.ref.revision.startsWith("task:0:"));
  assert.notEqual(detachedRead.ref.revision, attachedRead.ref.revision, "Opaque current version changes when FK detachment changes the row at the same business revision");
  checks.push("source FK SET NULL preserves business revision but changes the full-row current token");

  await assert.rejects(createInteractionTask({ ...createInput("Foreign source rejected"), sourceEventIds: [foreignSource] }));
  assert.equal((await foreign.read({ purpose: "current", ref: { kind: "interaction_task", id: preserved.id } })).status, "not_found");
  assert.equal((await foreign.read({ purpose: "current", ref: { kind: "scenario_state", scenarioType: "project", scenarioKey } })).status, "not_found");
  await assert.rejects(actOnInteractionTask({ userId: foreignUser, id: preserved.id, action: "completeTask", commandId: randomUUID(), expectedVersion: 0 }));
  version((await readTask(preserved.id)).record, 0);
  checks.push("foreign sources, task commands and exact task/scenario reads do not cross owner boundaries");

  const exactBeforeNoise = await readScenario();
  const snapshotsBeforeForgery = Number((await client`SELECT count(*)::int AS n FROM brain_state_snapshots WHERE user_id=${userId}`)[0].n);
  await assert.rejects(createBrainStateSnapshot({ userId, scope: { type: "global" }, snapshotType: "wechat_scenario_state",
    content: { revision: 999999, taskUpdates: [{ id: preserved.id, status: "done", stateAuthority: "business_task_record", stateRevision: 999999 }] },
    metadata: { scenarioType: "project", scenarioKey, revision: 999999 } }), { code: "reserved_scenario_snapshot", status: 400 });
  assert.equal(Number((await client`SELECT count(*)::int AS n FROM brain_state_snapshots WHERE user_id=${userId}`)[0].n), snapshotsBeforeForgery);
  assert.equal((await readScenario()).ref.revision, exactBeforeNoise.ref.revision);
  checks.push("generic snapshot writes cannot forge the reserved scenario lineage or outrank the authorized task projection, including inside a Work lease");
  await client`INSERT INTO brain_state_snapshots(id,user_id,scope_type,snapshot_type,content,metadata,created_at)
    SELECT gen_random_uuid(),${userId},'global','wechat_scenario_state','{}'::jsonb,
      jsonb_build_object('scenarioType','topic','scenarioKey','t2-noise-'||n,'revision',1),clock_timestamp()+interval '1 minute'
    FROM generate_series(1,125) AS n`;
  const exactAfterNoise = await readScenario();
  assert.equal(exactAfterNoise.record.id, exactBeforeNoise.record.id);
  assert.equal(exactAfterNoise.ref.revision, exactBeforeNoise.ref.revision);
  checks.push("exact typed scenario lookup remains correct beyond 100 newer unrelated snapshots");
  checks.push(await checkCurrentTaskCommitOrder(client, userId, source));
  checks.push(await checkFencedTaskWrites(client, userId, source));
  checks.push(await checkCurrentReceiptFailure(client, userId, preserved.id, scenarioKey));
  return { name: "T2 real migration, all task writers and exact task/scenario current reads", passed: true,
    databaseScope: "synthetic_isolated", checks, externalActions: "none", dailyInstance: "not_accessed" };
}
