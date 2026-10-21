import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { createObservation, createOwnerMemoryClient as createAnyOwnerMemoryClient } from "@/lib/memory";
import { withExecutionContext } from "@/lib/work-runtime/execution-context";

function createOwnerMemoryClient(userId: string) {
  const client = createAnyOwnerMemoryClient(userId);
  return { ...client, submit: async (value: unknown) => {
    const result = await client.submit(value);
    assert.ok("observation" in result, "T1 requires the observation command result");
    return result;
  } };
}

async function checkFencedObservationAudit(client: postgres.Sql, userId: string) {
  const workshopId = randomUUID(), runId = randomUUID(), workerId = `t1-worker-${randomUUID()}`;
  const lease = { userId, workshopId, runId, workerId, token: 7 };
  await client`INSERT INTO workshops(id,user_id,name,mission,status) VALUES (${workshopId},${userId},'T1 synthetic fence','fixture','active')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${runId},${workshopId},'running',clock_timestamp())`;
  await client`INSERT INTO workshop_execution_leases(workshop_id,token,run_id,worker_id,phase,lease_until)
    VALUES (${workshopId},${lease.token},${runId},${workerId},'running',clock_timestamp()+interval '5 minutes')`;
  const input = { userId, sourceType: "t1_fenced_fixture", sourceId: randomUUID(), observedAt: "2026-10-20T03:04:05.000Z",
    content: "Synthetic raw Work observation", trustLevel: "raw" };
  const saved = await withExecutionContext(lease, () => createObservation(input));
  const events = await client`SELECT run_id,metadata FROM workshop_events WHERE workshop_id=${workshopId} AND type='brain_record_written'`;
  assert.equal(events.length, 1); assert.equal(events[0].run_id, runId);
  assert.equal(events[0].metadata.recordId, saved.id); assert.equal(events[0].metadata.actorId, userId);
  assert.deepEqual(events[0].metadata.execution, { workerId, token: lease.token });
  assert.equal(events[0].metadata.implementation, "memory-t1.v1");
  const count = async () => Number((await client`SELECT count(*)::int AS n FROM brain_observations WHERE user_id=${userId} AND source_type='t1_fenced_fixture'`)[0].n);
  await assert.rejects(withExecutionContext({ ...lease, token: lease.token - 1 },
    () => createObservation({ ...input, sourceId: randomUUID() })), { code: "lease_lost" });
  assert.equal(await count(), 1);
  const counterBefore = (await client`SELECT last_seq FROM workshop_event_counters WHERE workshop_id=${workshopId}`)[0].last_seq;
  const name = `reject_t1_audit_${randomUUID().replaceAll("-", "")}`;
  await client.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workshop_id='${workshopId}'::uuid AND NEW.type='brain_record_written' THEN RAISE EXCEPTION 'injected T1 Work audit failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  const failed = { ...input, sourceId: randomUUID() };
  try { await assert.rejects(withExecutionContext(lease, () => createObservation(failed))); }
  finally { await client.unsafe(`DROP TRIGGER ${name} ON workshop_events`); await client.unsafe(`DROP FUNCTION ${name}()`); }
  assert.equal(await count(), 1);
  assert.equal(Number((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${workshopId}`)[0].n), 1);
  assert.equal((await client`SELECT last_seq FROM workshop_event_counters WHERE workshop_id=${workshopId}`)[0].last_seq, counterBefore);
  const recovered = await withExecutionContext(lease, () => createObservation(failed));
  assert.equal(await count(), 2);
  const recoveredAudit = await client`SELECT metadata FROM workshop_events WHERE workshop_id=${workshopId} AND metadata->>'recordId'=${recovered.id}`;
  assert.equal(recoveredAudit.length, 1);
  return "real valid Work/run/token ingestion commits its audit; stale token is fenced; failed audit rolls back observation and sequence before retry";
}

/** Observe an actual database wait rather than infer ordering from a sleep. */
async function waitForDatabaseBarrier<T>(label: string, inspect: () => Promise<T | undefined>) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const observed = await inspect();
    if (observed !== undefined) return observed;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw Error(`T1 database barrier not observed: ${label}`);
}

async function checkEvidenceSourceShare(client: postgres.Sql, userId: string) {
  const owner = createOwnerMemoryClient(userId);
  for (const mutation of ["update", "delete"] as const) {
    const saved = await owner.submit({ kind: "observation.append", commandId: randomUUID(), sourceId: `share:${randomUUID()}`,
      observedAt: "2026-10-20T04:05:06.000Z", content: "Stable source while its read receipt commits" });
    const coordinator = await client.reserve(), writer = await client.reserve();
    const key1 = Number.parseInt(randomUUID().slice(0, 7), 16), key2 = Number.parseInt(randomUUID().slice(0, 7), 16);
    const gate = `gate_t1_read_${randomUUID().replaceAll("-", "")}`;
    let gateHeld = false, triggerCreated = false, functionCreated = false, readSettled = false, writerSettled = false;
    let reading: Promise<{ result?: Awaited<ReturnType<typeof owner.read>>; error?: unknown }> | undefined;
    let writing: Promise<{ error?: unknown }> | undefined;
    try {
      await coordinator`SELECT pg_advisory_lock(${key1},${key2})`; gateHeld = true;
      // The source SELECT has finished before this receipt trigger blocks.
      await client.unsafe(`CREATE FUNCTION ${gate}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.observation_id='${saved.observation.id}'::uuid THEN PERFORM pg_advisory_xact_lock(${key1},${key2}); END IF; RETURN NEW; END $$`);
      functionCreated = true;
      await client.unsafe(`CREATE TRIGGER ${gate} BEFORE INSERT ON memory_read_receipts FOR EACH ROW EXECUTE FUNCTION ${gate}()`);
      triggerCreated = true;
      reading = owner.read({ purpose: "evidence", ref: saved.ref, range: { start: 0, end: 6 } })
        .then(result => ({ result }), error => ({ error })).finally(() => { readSettled = true; });
      const readerPid = await waitForDatabaseBarrier("reader waits inside receipt insert", async () => {
        if (readSettled) throw Error("Evidence read finished before the receipt barrier");
        const rows = await client`SELECT pid FROM pg_locks WHERE locktype='advisory' AND NOT granted
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
          AND classid=${key1}::oid AND objid=${key2}::oid AND objsubid=2`;
        return rows[0] ? Number(rows[0].pid) : undefined;
      });
      const writerPid = Number((await writer`SELECT pg_backend_pid() AS pid`)[0].pid);
      await writer`SET statement_timeout='15000ms'`;
      const write = mutation === "update"
        ? writer`UPDATE brain_observations SET content='Synthetic post-read update' WHERE id=${saved.observation.id} RETURNING id`
        : writer`DELETE FROM brain_observations WHERE id=${saved.observation.id} RETURNING id`;
      writing = write.then(() => ({}), error => ({ error })).finally(() => { writerSettled = true; });
      await waitForDatabaseBarrier("source writer blocked by the reader transaction", async () => {
        if (writerSettled) throw Error(`Source ${mutation} committed before the read receipt`);
        const rows = await client`SELECT ${readerPid}::int=ANY(pg_blocking_pids(${writerPid}::int)) AS blocked`;
        return rows[0]?.blocked ? true : undefined;
      });
      assert.equal(Number((await client`SELECT count(*)::int AS n FROM memory_read_receipts WHERE observation_id=${saved.observation.id}`)[0].n), 0);
      await coordinator`SELECT pg_advisory_unlock(${key1},${key2})`; gateHeld = false;
      const readOutcome = await reading; if (readOutcome.error) throw readOutcome.error;
      assert.ok(readOutcome.result?.status === "ok" && "content" in readOutcome.result); assert.equal(readOutcome.result.content, "Stable");
      const writeOutcome = await writing; if (writeOutcome.error) throw writeOutcome.error;
      assert.equal(Number((await client`SELECT count(*)::int AS n FROM memory_read_receipts WHERE id=${readOutcome.result.receipt.id}`)[0].n), 1);
    } finally {
      if (gateHeld) await coordinator`SELECT pg_advisory_unlock(${key1},${key2})`;
      if (reading) await reading;
      if (writing) await writing;
      if (triggerCreated) await client.unsafe(`DROP TRIGGER ${gate} ON memory_read_receipts`);
      if (functionCreated) await client.unsafe(`DROP FUNCTION ${gate}()`);
      coordinator.release(); writer.release();
    }
  }
  return "real pg_locks barriers prove UPDATE and DELETE wait for the source share lock until the evidence receipt commits";
}

/** Public T1 contract against a fresh migrated database, never an application DB. */
export async function checkMemoryModuleT1(client: postgres.Sql) {
  const database = (await client`SELECT current_database() AS name`)[0]?.name;
  assert.match(String(database), /^zhiyu_test_[a-f0-9]{32}$/);
  const configured = new URL(process.env.ZHIYU_TEST_DATABASE_URL ?? "");
  assert.equal(configured.pathname, `/${database}`);
  assert.equal(process.env.ZHIYU_TEST_MODE, "integration");
  const userId = randomUUID(), otherId = randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},${userId + "@example.invalid"}),(${otherId},${otherId + "@example.invalid"})`;
  const owner = createOwnerMemoryClient(userId), other = createOwnerMemoryClient(otherId);
  // Seven code points, eight UTF-16 code units: a window must never split the emoji.
  const content = "A\u4e2d\u6587\u{1f642}B\nC";
  const command = { kind: "observation.append" as const, commandId: randomUUID(), sourceId: `fixture:${randomUUID()}`,
    observedAt: "2026-10-20T01:02:03.000Z", content, metadata: { fixture: "memory-module-t1" } };
  const observations = async () => Number((await client`SELECT count(*)::int AS n FROM brain_observations WHERE user_id=${userId}`)[0].n);
  const operations = async () => Number((await client`SELECT count(*)::int AS n FROM memory_operation_receipts WHERE user_id=${userId}`)[0].n);
  const reads = async () => Number((await client`SELECT count(*)::int AS n FROM memory_read_receipts WHERE user_id=${userId}`)[0].n);
  const checks: string[] = [];

  const simultaneous = await Promise.all([owner.submit(command), owner.submit(command)]);
  assert.deepEqual(simultaneous.map(result => result.status), ["committed", "committed"]);
  assert.equal(simultaneous.filter(result => result.replayed).length, 1);
  const saved = simultaneous.find(result => !result.replayed); assert.ok(saved);
  assert.equal(simultaneous[0].observation.id, simultaneous[1].observation.id);
  assert.equal(simultaneous[0].receipt.id, simultaneous[1].receipt.id);
  assert.equal(saved.observation.content, content); assert.equal(saved.observation.sourceType, "manual");
  assert.equal(saved.observation.trustLevel, "raw"); assert.equal(saved.observation.userId, userId);
  assert.deepEqual(saved.ref.record, { kind: "observation", id: saved.observation.id });
  assert.match(saved.ref.revision, /^obsrv1:[a-f0-9]{64}$/);
  assert.equal(await observations(), 1); assert.equal(await operations(), 1);
  const replay = await owner.submit(command);
  assert.equal(replay.replayed, true); assert.equal(replay.receipt.id, saved.receipt.id);
  checks.push("concurrent identical command commits one observation and one receipt; replay preserves identity");

  await assert.rejects(owner.submit({ ...command, content: "changed same command" }), { code: "memory_command_conflict", status: 409 });
  await assert.rejects(owner.submit({ ...command, commandId: randomUUID(), content: "changed same source" }), { code: "observation_source_conflict", status: 409 });
  assert.equal(await observations(), 1); assert.equal(await operations(), 1);
  checks.push("same command and same source reject conflicting payloads without a second write");

  const current = await owner.read({ purpose: "current", ref: saved.ref.record });
  assert.ok(current.status === "ok" && "content" in current, "Current observation read must succeed");
  assert.equal(current.content, content); assert.deepEqual(current.ref, saved.ref);
  assert.deepEqual(current.receipt.actualRange, { start: 0, end: 7, unit: "unicode_code_points" });
  assert.equal(current.receipt.totalLength, 7);
  const window = await owner.read({ purpose: "evidence", ref: saved.ref, range: { start: 1, end: 4 } });
  assert.ok(window.status === "ok" && "content" in window, "Evidence read must succeed");
  assert.equal(window.content, "\u4e2d\u6587\u{1f642}");
  assert.deepEqual(window.receipt.actualRange, { start: 1, end: 4, unit: "unicode_code_points" });
  assert.equal(window.receipt.totalLength, 7); assert.deepEqual(window.receipt.ref, saved.ref);
  const clipped = await owner.read({ purpose: "evidence", ref: saved.ref, range: { start: 4, end: 99 } });
  assert.ok(clipped.status === "ok" && "content" in clipped, "Clipped evidence read must succeed");
  assert.equal(clipped.content, "B\nC");
  assert.deepEqual(clipped.receipt.actualRange, { start: 4, end: 7, unit: "unicode_code_points" });
  assert.equal(await reads(), 3);
  assert.notEqual(window.receipt.id, current.receipt.id);
  checks.push("fixed evidence version and actual Unicode code-point windows; current and clipped reads have separate receipts");

  const wrongVersion = await owner.read({ purpose: "evidence", ref: { ...saved.ref, revision: `obsrv1:${"0".repeat(64)}` }, range: { start: 0, end: 1 } });
  assert.ok(wrongVersion.status === "unavailable");
  assert.equal(wrongVersion.code, "version_mismatch");
  assert.ok(!JSON.stringify(wrongVersion).includes(content));
  const foreign = await other.read({ purpose: "evidence", ref: saved.ref, range: { start: 0, end: 7 } });
  const missing = await other.read({ purpose: "current", ref: { kind: "observation", id: randomUUID() } });
  assert.equal(foreign.status, "not_found"); assert.equal(missing.status, "not_found");
  assert.ok(!JSON.stringify(foreign).includes(content));
  assert.equal((await other.explain({ receiptId: saved.receipt.id })).status, "not_found");
  assert.equal((await other.explain({ receiptId: window.receipt.id })).status, "not_found");
  const explained = await owner.explain({ receiptId: window.receipt.id });
  assert.ok(explained.status === "ok"); assert.equal(explained.type, "read");
  assert.deepEqual(explained.receipt.ref, saved.ref);
  assert.ok(!JSON.stringify(explained).includes(content), "A safe receipt explanation does not duplicate the observation body");
  const otherSaved = await other.submit(command);
  assert.equal(otherSaved.observation.userId, otherId);
  assert.notEqual(otherSaved.observation.id, saved.observation.id);
  assert.notEqual(otherSaved.receipt.id, saved.receipt.id);
  assert.equal(await reads(), 3, "Failed reads must not create success receipts");
  checks.push("foreign/missing records conceal bodies and receipts; version mismatch is explicit");

  for (const range of [{ start: -1, end: 1 }, { start: 2, end: 1 }, { start: 0.5, end: 2 }, { start: 8, end: 9 }, { start: 0, end: 8193 }]) {
    await assert.rejects(owner.read({ purpose: "evidence", ref: saved.ref, range }), { code: "invalid_memory_request", status: 400 });
  }
  const forbidden = { ...command, commandId: randomUUID(), sourceId: `fixture:${randomUUID()}`, userId: otherId };
  await assert.rejects(owner.submit(forbidden), { code: "invalid_memory_request", status: 400 });
  await assert.rejects(withExecutionContext({ userId, workshopId: randomUUID(), runId: randomUUID(), workerId: "t1-fixture", token: 1 },
    () => owner.submit({ ...command, commandId: randomUUID(), sourceId: `fixture:${randomUUID()}` })), (error: unknown) => {
      assert.equal((error as { status?: number }).status, 403); return true;
    });
  assert.equal(await observations(), 1); assert.equal(await operations(), 1); assert.equal(await reads(), 3);
  checks.push("invalid ranges and privilege fields fail; an owner client cannot be reused inside a Work execution");

  // A deferred fault fires at transaction commit, after all callback statements.
  // This verifies rollback independent of the internal insert ordering.
  const suffix = randomUUID().replaceAll("-", ""), trigger = `reject_t1_${suffix}`;
  await client.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected T1 deferred receipt failure'; END $$`);
  await client.unsafe(`CREATE CONSTRAINT TRIGGER ${trigger} AFTER INSERT ON memory_operation_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  await client.unsafe(`CREATE CONSTRAINT TRIGGER ${trigger} AFTER INSERT ON memory_read_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  const failedCommand = { ...command, commandId: randomUUID(), sourceId: `fixture:${randomUUID()}` };
  try {
    await assert.rejects(owner.submit(failedCommand));
    await assert.rejects(owner.read({ purpose: "evidence", ref: saved.ref, range: { start: 0, end: 1 } }));
  } finally {
    await client.unsafe(`DROP TRIGGER ${trigger} ON memory_operation_receipts`);
    await client.unsafe(`DROP TRIGGER ${trigger} ON memory_read_receipts`);
    await client.unsafe(`DROP FUNCTION ${trigger}()`);
  }
  assert.equal(await observations(), 1); assert.equal(await operations(), 1); assert.equal(await reads(), 3);
  const recovered = await owner.submit(failedCommand);
  assert.equal(recovered.status, "committed"); assert.equal(recovered.replayed, false);
  assert.equal(await observations(), 2); assert.equal(await operations(), 2);
  const recoveredRead = await owner.read({ purpose: "evidence", ref: recovered.ref, range: { start: 0, end: 1 } });
  assert.equal(recoveredRead.status, "ok");
  checks.push("deferred PostgreSQL commit failure rolls back writes and read receipts without returning evidence; the same command safely recovers");
  checks.push(await checkFencedObservationAudit(client, userId));
  checks.push(await checkEvidenceSourceShare(client, userId));

  return { name: "T1 public memory observation/evidence contract on isolated PostgreSQL", passed: true,
    databaseScope: "synthetic_isolated", checks, observations: await observations(), operationReceipts: await operations(), readReceipts: await reads(),
    externalActions: "none", dailyInstance: "not_accessed" };
}
