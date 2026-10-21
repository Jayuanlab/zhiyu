import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type postgres from "postgres";
import { createOwnerMemoryClient } from "@/lib/memory";
import { createInteractionTask } from "@/lib/interactions/service";
import { getMemoryById } from "@/lib/memory/adapters/postgres/memory-records";
import { getBrainMemoryRevisionVersion } from "@/lib/memory/revision/version";
import type { ContextRecallReadResult, DiscoveryReadResult, ContextEntry } from "@/lib/memory/query-contracts";
import { buildBrainContextFromMemoryRequest } from "@/lib/memory/retrieval/recall";
import { finalizeContextPack } from "@/lib/memory/context/finalize";
import { workMemorySourceFilters } from "@/lib/memory/context/runtime-applicability";
import { withExecutionContext } from "@/lib/work-runtime/execution-context";
import { recordRecallFeedback } from "@/lib/memory/governance/recall-feedback";
import { inspectWorkshopMemoryRecallQuality, synchronizeWorkshopMemoryRecallQualityReviews } from "@/lib/workshops/memory-recall-quality";
import { createBrainAccessGrant, deleteBrainAccessGrant } from "@/lib/memory/governance/access-grants";
import type { ExecutionLease } from "@/lib/work-runtime/execution-lease";
import { withMemoryDispatchContext, bindMemoryDispatchRuntime, assertMemoryDispatchCurrent } from "@/lib/memory/context/dispatch";

function discovered(value: unknown): DiscoveryReadResult {
  const result = value as DiscoveryReadResult; assert.ok(["ok", "empty"].includes(result.status));
  assert.equal(result.purpose, "discover"); assert.equal(result.receipt.purpose, "discover");
  assert.equal(result.meta.provider, "postgres"); assert.equal(result.meta.implementationVersion, "memory-t4.v1");
  assert.equal(result.coverage.complete, false); assert.deepEqual(result.coverage.recordKinds, ["memory"]);
  for (const item of result.items) { assert.equal(item.useSemantics, "discovery_only"); assert.equal(item.receipt.id, result.receipt.id); assert.ok(item.ref.revision); }
  return result;
}
function recalled(value: unknown) {
  const result = value as ContextRecallReadResult; assert.ok(["ok", "empty"].includes(result.status));
  if (result.status === "unavailable") throw Error(`Synthetic recall unavailable: ${result.code}`);
  assert.equal(result.purpose, "recall"); assert.equal(result.receipt.purpose, "recall");
  assert.equal(result.meta.provider, "postgres"); assert.equal(result.meta.implementationVersion, "memory-t4.v1");
  assert.equal(result.pack.interfaceVersion, "memory-context.v1");
  for (const key of ["currentStates", "historicalEvidence", "interpretations", "constraints", "openQuestions"] as const) assert.ok(Array.isArray(result.pack[key]));
  assert.equal(result.pack.coverage.independentBusinessVerification, false);
  assert.equal(result.pack.coverage.dependencyCoverage, "registered_edges_only");
  assert.ok(result.pack.budget.usedUpperBound <= result.pack.budget.maxTokens);
  return result;
}
function entries(result: ReturnType<typeof recalled>): ContextEntry[] {
  return [...result.pack.currentStates, ...result.pack.historicalEvidence, ...result.pack.interpretations, ...result.pack.constraints];
}
function causedBy(error: unknown, expression: RegExp) {
  let cause = error; const messages: string[] = [];
  for (let depth = 0; cause && typeof cause === "object" && depth < 8; depth++) {
    messages.push(String((cause as { message?: unknown }).message)); cause = (cause as { cause?: unknown }).cause;
  }
  assert.match(messages.join(" "), expression); return true;
}
async function databaseBarrier<T>(label: string, probe: () => Promise<T | undefined>) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { const result = await probe(); if (result !== undefined) return result; await new Promise<void>(resolve => setImmediate(resolve)); }
  throw Error(`T4 database barrier not observed: ${label}`);
}

async function checkDiscoveryRevisionCommitOrder(client: postgres.Sql, fixture: Awaited<ReturnType<typeof seedMemoryModuleT4Fixture>>) {
  const owner = createOwnerMemoryClient(fixture.owner), before = await getMemoryById({ userId: fixture.owner, memoryId: fixture.ids.beta }); assert.ok(before);
  const expectedVersion = getBrainMemoryRevisionVersion(before), coordinator = await client.reserve();
  const key1 = Number.parseInt(randomUUID().slice(0, 7), 16), key2 = Number.parseInt(randomUUID().slice(0, 7), 16);
  const trigger = `gate_t4_query_${randomUUID().replaceAll("-", "")}`;
  let held = false, created = false, readSettled = false, writeSettled = false;
  let reading: Promise<{ result?: unknown; error?: unknown }> | undefined, writing: Promise<{ result?: unknown; error?: unknown }> | undefined;
  try {
    await coordinator`SELECT pg_advisory_lock(${key1},${key2})`; held = true;
    await client.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${fixture.owner}'::uuid AND NEW.purpose='discover' THEN PERFORM pg_advisory_xact_lock(${key1},${key2}); END IF; RETURN NEW; END $$`);
    await client.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON memory_query_read_receipts FOR EACH ROW EXECUTE FUNCTION ${trigger}()`); created = true;
    reading = owner.read({ purpose: "discover", query: fixture.marker, limit: 100, filters: { memoryTypes: ["insight"], statuses: ["verified"] } })
      .then(result => ({ result }), error => ({ error })).finally(() => { readSettled = true; });
    const readerPid = await databaseBarrier("discovery waits inside its receipt insert", async () => {
      if (readSettled) throw Error("Discovery finished before the receipt barrier");
      const rows = await client`SELECT pid FROM pg_locks WHERE locktype='advisory' AND NOT granted
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=${key1}::oid AND objid=${key2}::oid AND objsubid=2`;
      return rows[0] ? Number(rows[0].pid) : undefined;
    });
    writing = owner.submit({ kind: "memory.revise", commandId: randomUUID(), memoryId: before.id, expectedVersion,
      operation: "correct", authority: "owner_statement", content: `${fixture.marker} BETA_T4_RACE_CORRECTED`, reason: "Synthetic concurrent source correction", evidenceRefs: [fixture.evidenceRef] })
      .then(result => ({ result }), error => ({ error })).finally(() => { writeSettled = true; });
    await databaseBarrier("the real revision writer is blocked by the discovery source SHARE", async () => {
      if (writeSettled) throw Error("Revision committed before discovery receipt");
      const rows = await client`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND ${readerPid}::int=ANY(pg_blocking_pids(pid))`;
      return rows[0] ? Number(rows[0].pid) : undefined;
    });
    await coordinator`SELECT pg_advisory_unlock(${key1},${key2})`; held = false;
    const read = await reading; if (read.error) throw read.error;
    const result = discovered(read.result), item = result.items.find(item => item.id === before.id); assert.ok(item); assert.equal(item.ref.revision, expectedVersion);
    const write = await writing; if (write.error) throw write.error;
    const historical = await owner.explain({ receiptId: result.receipt.id }); assert.equal(historical.status, "ok");
    const row = (await client`SELECT refs FROM memory_query_read_receipts WHERE id=${result.receipt.id}`)[0];
    assert.ok(row.refs.some((ref: unknown) => isDeepStrictEqual(ref, item.ref)));
    const now = await owner.read({ purpose: "current", ref: { kind: "memory", id: before.id } });
    assert.equal(now.status, "ok"); assert.ok("ref" in now); assert.notEqual(now.ref.revision, expectedVersion);
  } finally {
    if (held) await coordinator`SELECT pg_advisory_unlock(${key1},${key2})`;
    if (reading) await reading; if (writing) await writing;
    if (created) { await client.unsafe(`DROP TRIGGER ${trigger} ON memory_query_read_receipts`); await client.unsafe(`DROP FUNCTION ${trigger}()`); }
    coordinator.release();
  }
  return "pg_locks barriers prove discovery source versions and its durable receipt commit before a competing real revision; the next exact current read changes version";
}

async function checkAdmissionRevocationCommitOrder(client: postgres.Sql, input: Parameters<typeof finalizeContextPack>[0], lease: ExecutionLease, grantId: string, sharedId: string) {
  const coordinator = await client.reserve(), key1 = Number.parseInt(randomUUID().slice(0, 7), 16), key2 = Number.parseInt(randomUUID().slice(0, 7), 16);
  const trigger = `gate_t4_access_${randomUUID().replaceAll("-", "")}`;
  let held = false, created = false, readSettled = false, writeSettled = false;
  let reading: Promise<{ result?: Awaited<ReturnType<typeof finalizeContextPack>>; error?: unknown }> | undefined;
  let writing: Promise<{ result?: Awaited<ReturnType<typeof deleteBrainAccessGrant>>; error?: unknown }> | undefined;
  try {
    await coordinator`SELECT pg_advisory_lock(${key1},${key2})`; held = true;
    await client.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${lease.userId}'::uuid AND NEW.metadata->>'source'='t4_access_race' THEN PERFORM pg_advisory_xact_lock(${key1},${key2}); END IF; RETURN NEW; END $$`);
    await client.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON brain_context_logs FOR EACH ROW EXECUTE FUNCTION ${trigger}()`); created = true;
    reading = withExecutionContext(lease, () => finalizeContextPack({ ...input, metadata: { source: "t4_access_race" } }))
      .then(result => ({ result }), error => ({ error })).finally(() => { readSettled = true; });
    const readerPid = await databaseBarrier("final admission holds authority SHARE at its audit insert", async () => {
      if (readSettled) throw Error("Final admission finished before the audit barrier");
      const rows = await client`SELECT pid FROM pg_locks WHERE locktype='advisory' AND NOT granted
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=${key1}::oid AND objid=${key2}::oid AND objsubid=2`;
      return rows[0] ? Number(rows[0].pid) : undefined;
    });
    writing = deleteBrainAccessGrant({ userId: lease.userId, grantId }).then(result => ({ result }), error => ({ error })).finally(() => { writeSettled = true; });
    await databaseBarrier("the real access revoker waits on final admission authority SHARE", async () => {
      if (writeSettled) throw Error("Access revocation committed before final admission audit");
      const rows = await client`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND ${readerPid}::int=ANY(pg_blocking_pids(pid))`;
      return rows[0] ? Number(rows[0].pid) : undefined;
    });
    await coordinator`SELECT pg_advisory_unlock(${key1},${key2})`; held = false;
    const read = await reading; if (read.error) throw read.error; assert.ok(read.result);
    assert.ok(read.result.items.some(item => item.id === sharedId));
    const admittedContextLogId = read.result.contextLogId; assert.ok(admittedContextLogId);
    assert.equal(Number((await client`SELECT count(*)::int AS n FROM brain_context_logs WHERE id=${admittedContextLogId}`)[0].n), 1);
    const write = await writing; if (write.error) throw write.error; assert.equal(write.result?.deletedCount, 1);
    assert.equal(Number((await client`SELECT count(*)::int AS n FROM brain_state_snapshots WHERE user_id=${lease.userId}
      AND snapshot_type='memory_access_change' AND content->>'action'='revoke' AND content->'grant'->>'id'=${grantId}`)[0].n), 1);
  } finally {
    if (held) await coordinator`SELECT pg_advisory_unlock(${key1},${key2})`;
    if (reading) await reading; if (writing) await writing;
    if (created) { await client.unsafe(`DROP TRIGGER ${trigger} ON brain_context_logs`); await client.unsafe(`DROP FUNCTION ${trigger}()`); }
    coordinator.release();
  }
}

async function checkDispatchGuard(client: postgres.Sql, fixture: Awaited<ReturnType<typeof seedMemoryModuleT4Fixture>>, lease: ExecutionLease,
  workRequest: Parameters<typeof buildBrainContextFromMemoryRequest>[0]) {
  const count = async () => Number((await client`SELECT count(*)::int AS n FROM brain_context_logs
    WHERE user_id=${fixture.owner} AND metadata->>'source'='memory_provider_dispatch_admission'`)[0].n);
  const grant = await createBrainAccessGrant({ userId: fixture.owner, subjectType: "work", subjectId: fixture.workId,
    scope: { type: "work", workId: fixture.sourceWorkId }, permissions: ["reference"], memoryTypes: ["insight"] });
  let signalRevoke!: () => void;
  const requested = new Promise<void>(resolve => { signalRevoke = resolve; });
  // The owner mutation is attached outside the run ALS; the read remains fenced
  // by the real run capability. Neither side impersonates the other context.
  const revoked = requested.then(() => deleteBrainAccessGrant({ userId: fixture.owner, grantId: grant.id }))
    .then(result => ({ result }), error => ({ error }));
  try {
    await withExecutionContext(lease, () => withMemoryDispatchContext(async () => {
      bindMemoryDispatchRuntime({ engine: "pi", adapter: "pi-agent-harness" });
      const selected = await buildBrainContextFromMemoryRequest(workRequest); assert.ok(selected.items.some(item => item.id === fixture.ids.shared));
      const before = await count(); await assertMemoryDispatchCurrent(); assert.equal(await count(), before + 1);
      signalRevoke(); const revocation = await revoked; if ("error" in revocation) throw revocation.error;
      assert.equal(revocation.result.deletedCount, 1);
      await assert.rejects(assertMemoryDispatchCurrent(), { code: "memory_dispatch_context_unavailable", status: 503 });
      assert.equal(await count(), before + 1, "Rejected dispatch must roll back the attempted admission audit");
    }));
  } finally { signalRevoke(); const result = await revoked; if ("error" in result) throw result.error; }
  const trigger = `reject_t4_dispatch_${randomUUID().replaceAll("-", "")}`;
  await client.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${fixture.owner}'::uuid AND NEW.metadata->>'source'='memory_provider_dispatch_admission' THEN RAISE EXCEPTION 'injected T4 dispatch admission failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON brain_context_logs FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  try {
    await withExecutionContext(lease, () => withMemoryDispatchContext(async () => {
      bindMemoryDispatchRuntime({ engine: "pi", adapter: "pi-agent-harness" });
      assert.ok((await buildBrainContextFromMemoryRequest(workRequest)).items.length > 0);
      const before = await count();
      await assert.rejects(assertMemoryDispatchCurrent(), { code: "memory_dispatch_context_unavailable", status: 503 });
      assert.equal(await count(), before);
    }));
  } finally { await client.unsafe(`DROP TRIGGER ${trigger} ON brain_context_logs`); await client.unsafe(`DROP FUNCTION ${trigger}()`); }
}

/** Shared PG/HTTP seed; never usable against an ordinary application DB. */
export async function seedMemoryModuleT4Fixture(client: postgres.Sql, suppliedOwner?: string) {
  const database = String((await client`SELECT current_database() AS name`)[0].name);
  assert.match(database, /^zhiyu_test_[a-f0-9]{32}$/);
  assert.equal(new URL(process.env.ZHIYU_TEST_DATABASE_URL ?? "").pathname, `/${database}`);
  const owner = suppliedOwner ?? randomUUID(), foreignOwner = randomUUID(), workId = randomUUID(), otherWorkId = randomUUID(), sourceWorkId = randomUUID();
  if (!suppliedOwner) await client`INSERT INTO "User"(id,email) VALUES (${owner},${owner + "@example.invalid"})`;
  assert.equal((await client`SELECT id FROM "User" WHERE id=${owner}`).length, 1);
  await client`INSERT INTO "User"(id,email) VALUES (${foreignOwner},${foreignOwner + "@example.invalid"})`;
  const alpha = `project:t4-alpha-${randomUUID()}`, beta = `project:t4-beta-${randomUUID()}`, marker = `t4fixture_${randomUUID().replaceAll("-", "")}`;
  const binding = (scenarioKey: string) => ({ memoryApplicability: { schemaVersion: "memory-applicability.v1", scenarioKeys: [scenarioKey] } });
  for (const [id, key, name] of [[workId, alpha, "Synthetic T4 Alpha"], [otherWorkId, beta, "Synthetic T4 Beta"], [sourceWorkId, alpha, "Synthetic T4 shared source"]] as const)
    await client`INSERT INTO workshops(id,user_id,name,mission,status,model_config)
      VALUES (${id},${owner},${name},'Synthetic retrieval fixture only','active',${JSON.stringify(binding(key))}::jsonb)`;
  const ownerClient = createOwnerMemoryClient(owner);
  const raw = await ownerClient.submit({ kind: "observation.append", commandId: randomUUID(), sourceId: randomUUID(),
    observedAt: "2026-10-20T03:00:00Z", content: `${marker} A\u{1f600}\u4e2dB RAW_T4_ORIGINAL_EVIDENCE` });
  assert.equal(raw.status, "committed"); if (raw.status !== "committed") throw Error("Synthetic raw observation was not saved");
  const foreignRaw = await createOwnerMemoryClient(foreignOwner).submit({ kind: "observation.append", commandId: randomUUID(), sourceId: randomUUID(),
    observedAt: "2026-10-20T03:00:00Z", content: `${marker} FOREIGN_RAW_EVIDENCE_MUST_NOT_RETURN` });
  assert.equal(foreignRaw.status, "committed"); if (foreignRaw.status !== "committed") throw Error("Synthetic foreign observation was not saved");
  const evidenceRef = `brain-observation:${raw.observation.id}`;
  const sourceEventId = randomUUID();
  await client`INSERT INTO interaction_events(id,user_id,platform,source,conversation_name,content,message_time,dedupe_key)
    VALUES (${sourceEventId},${owner},'fixture','memory_module_t4','Synthetic T4 event',${marker + " synthetic task observation"},now(),${randomUUID()})`;
  const task = await createInteractionTask({ userId: owner, commandId: randomUUID(), title: `${marker} formal task`, sourceEventIds: [sourceEventId], metadata: { workshopId: workId } });
  const ids = { own: randomUUID(), beta: randomUUID(), shared: randomUUID(), candidate: randomUUID(), expired: randomUUID(), foreign: randomUUID(), global: randomUUID(), constraint: randomUUID() };
  const bodies = { own: `${marker} ALPHA_OWN_INTERPRETATION`, beta: `${marker} BETA_BODY_MUST_NOT_ENTER_ALPHA_RECALL`,
    shared: `${marker} SHARED_BODY_REQUIRES_CURRENT_GRANT`, candidate: `${marker} CANDIDATE_BODY_NOT_ACTIVE`,
    expired: `${marker} EXPIRED_BODY_NOT_ACTIVE`, foreign: `${marker} FOREIGN_T4_PRIVATE_BODY`, global: `${marker} OWNER_GLOBAL_PREFERENCE`,
    constraint: `${marker} CONTROL_T4_BOUNDARY no external action is authorized by recall` };
  for (const name of Object.keys(ids) as Array<keyof typeof ids>) {
    const userId = name === "foreign" ? foreignOwner : owner;
    const scopeWork = ["global", "constraint"].includes(name) ? null : name === "beta" ? otherWorkId : name === "shared" ? sourceWorkId : workId;
    const scenarioKey = name === "beta" ? beta : alpha;
    const metadata = { canonicalKind: name === "constraint" ? "boundary" : name === "global" ? "preference" : "state", canonicalGroupId: `t4:${ids[name]}`,
      facets: scopeWork ? { scenarioKeys: [scenarioKey], scenarioApplicability: "scoped" } : {} };
    await client`INSERT INTO brain_memories(id,user_id,scope_type,scope_id,owner_type,owner_id,memory_type,subject,content,status,confidence,evidence_refs,metadata,expires_at)
      VALUES (${ids[name]},${userId},${scopeWork ? "work" : "global"},${scopeWork},${scopeWork ? "work" : "chat"},${scopeWork ?? owner},
        ${name === "constraint" ? "boundary" : name === "global" ? "preference" : "insight"},${marker + " " + name},${bodies[name]},${name === "candidate" ? "candidate" : "verified"},90,
        ${JSON.stringify([name === "foreign" ? `brain-observation:${foreignRaw.observation.id}` : evidenceRef])}::jsonb,
        ${JSON.stringify(metadata)}::jsonb,${name === "expired" ? "2020-01-01T00:00:00Z" : null})`;
  }
  const source = await getMemoryById({ userId: owner, memoryId: ids.own }); assert.ok(source);
  return { owner, foreignOwner, workId, otherWorkId, sourceWorkId, alpha, beta, marker, ids, bodies, taskId: task.id, raw, foreignRaw,
    evidenceRef, ownVersion: getBrainMemoryRevisionVersion(source), sourceEventId };
}

export async function checkMemoryModuleT4(client: postgres.Sql) {
  const fixture = await seedMemoryModuleT4Fixture(client), owner = createOwnerMemoryClient(fixture.owner), foreign = createOwnerMemoryClient(fixture.foreignOwner);
  const checks: string[] = [], ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = discovered(await owner.read({ purpose: "discover", query: fixture.marker, limit: 2, ...(cursor ? { cursor } : {}),
      filters: { statuses: ["verified", "candidate"] } }));
    assert.ok(result.items.length <= 2); ids.push(...result.items.map(item => item.id));
    assert.ok(!JSON.stringify(result).includes(fixture.bodies.foreign));
    const explanation = await owner.explain({ receiptId: result.receipt.id }); assert.equal(explanation.status, "ok");
    assert.ok(!JSON.stringify(explanation).includes(fixture.bodies.own));
    assert.equal((await foreign.explain({ receiptId: result.receipt.id })).status, "not_found");
    cursor = result.nextCursor ?? undefined; if (!cursor) break;
  }
  assert.equal(cursor, undefined); assert.equal(ids.length, new Set(ids).size);
  for (const name of ["own", "beta", "shared", "candidate", "expired", "global", "constraint"] as const) assert.ok(ids.includes(fixture.ids[name]), `Owner discovery omitted synthetic ${name}`);
  assert.ok(!ids.includes(fixture.ids.foreign));
  checks.push("owner discovery pages saved memories including other scenes and history with exact versions, discovery-only semantics and owner-isolated durable receipts");
  for (const extra of [{ requester: { type: "system" } }, { workId: fixture.otherWorkId }, { accessMode: "owner_override" }, { grant: true }])
    await assert.rejects(owner.read({ purpose: "discover", query: fixture.marker, ...extra }), { status: 400 });
  for (const query of [{ purpose: "discover", query: fixture.marker, limit: 101 }, { purpose: "recall", taskIntent: fixture.marker, maxTokens: 8193 }])
    await assert.rejects(owner.read(query), { status: 400 });
  checks.push("public discovery/recall reject caller-supplied authority and out-of-budget requests");
  const request = { purpose: "recall", taskIntent: fixture.marker, maxTokens: 8192,
    currentRefs: [{ kind: "interaction_task", id: fixture.taskId }],
    needs: [{ id: "owner-preference", category: "user", question: `${fixture.marker} owner preference`, required: true, matchTerms: [fixture.marker] }] };
  const result = recalled(await owner.read(request)), all = entries(result);
  assert.ok(result.pack.currentStates.some(item => item.ref.record.kind === "interaction_task" && item.ref.record.id === fixture.taskId));
  assert.ok(result.pack.interpretations.some(item => item.ref.record.kind === "memory" && item.ref.record.id === fixture.ids.global));
  assert.ok(result.pack.constraints.some(item => item.ref.record.kind === "memory" && item.ref.record.id === fixture.ids.constraint));
  assert.ok(result.pack.historicalEvidence.some(item => item.ref.record.kind === "observation" && item.ref.record.id === fixture.raw.observation.id));
  assert.ok(!JSON.stringify(result.pack).includes(fixture.bodies.candidate)); assert.ok(!JSON.stringify(result.pack).includes(fixture.bodies.expired));
  assert.ok(!JSON.stringify(result.pack).includes(fixture.bodies.foreign));
  for (const item of all) { assert.ok(item.ref.revision); assert.ok(item.receipt.id); assert.ok(item.freshness.asOf); }
  assert.equal((await client`SELECT status FROM brain_memories WHERE id=${fixture.ids.candidate} AND user_id=${fixture.owner}`)[0].status, "candidate");
  const persisted = (await client`SELECT refs,context_log_id,coverage FROM memory_query_read_receipts WHERE id=${result.receipt.id} AND user_id=${fixture.owner}`)[0];
  assert.ok(persisted); assert.equal(persisted.context_log_id, result.pack.contextLogId);
  for (const item of all) assert.ok(persisted.refs.some((ref: unknown) => isDeepStrictEqual(ref, item.ref)));
  checks.push("recall separates exact current state, raw historical evidence, saved interpretations, constraints and open questions without activating candidates");
  const start = Array.from(`${fixture.marker} `).length;
  const evidence = await owner.read({ purpose: "evidence", ref: fixture.raw.ref, range: { start, end: start + 4 } });
  assert.equal(evidence.status, "ok");
  if (evidence.status !== "ok" || !("content" in evidence)) throw Error("Fixed original evidence unavailable");
  assert.equal(evidence.content, "A\u{1f600}\u4e2dB"); assert.equal(evidence.receipt.actualRange.unit, "unicode_code_points");
  assert.equal((await foreign.read({ purpose: "evidence", ref: fixture.raw.ref, range: { start: 0, end: 10 } })).status, "not_found");
  checks.push("fixed original evidence uses the actual Unicode range and remains owner-isolated");
  const feedbackId = randomUUID(), feedbackInput = { userId: fixture.owner, feedbackId, contextLogId: result.pack.contextLogId,
    query: "Synthetic reported text cannot replace the final context task intent", outcome: "used" as const, sources: ["memory"] };
  const feedbackCopies = await Promise.all([recordRecallFeedback(feedbackInput), recordRecallFeedback(feedbackInput)]);
  assert.ok(feedbackCopies.every(item => item.id === feedbackId));
  const feedback = (await client`SELECT system_info FROM feedback WHERE id=${feedbackId} AND user_id=${fixture.owner}`)[0].system_info;
  const finalLog = (await client`SELECT task_intent,selected_memory_ids,metadata FROM brain_context_logs WHERE id=${result.pack.contextLogId} AND user_id=${fixture.owner}`)[0];
  assert.equal(feedback.contextLogId, result.pack.contextLogId); assert.equal(feedback.associationStatus, "verified_context");
  assert.equal(feedback.query, finalLog.task_intent); assert.deepEqual(feedback.selectedMemoryIds, finalLog.selected_memory_ids);
  for (const item of [...result.pack.constraints, ...result.pack.interpretations]) assert.ok(finalLog.metadata.selectedMemoryVersions
    .some((version: { memoryId: string; revisionVersion: string }) => "id" in item.ref.record && version.memoryId === item.ref.record.id && version.revisionVersion === item.ref.revision));
  await assert.rejects(recordRecallFeedback({ ...feedbackInput, outcome: "irrelevant" }), { status: 409 });
  await assert.rejects(recordRecallFeedback({ ...feedbackInput, userId: fixture.foreignOwner }), { status: 404 });
  checks.push("real feedback freezes the final admission context and selected versions, retries once and rejects changed or foreign associations");
  const runId = randomUUID(), workerId = `t4-worker-${randomUUID()}`, lease = { userId: fixture.owner, workshopId: fixture.workId, runId, workerId, token: 7 };
  await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${runId},${fixture.workId},'running',clock_timestamp())`;
  await client`INSERT INTO workshop_execution_leases(workshop_id,token,run_id,worker_id,phase,lease_until)
    VALUES (${fixture.workId},7,${runId},${workerId},'running',clock_timestamp()+interval '5 minutes')`;
  const saved = (await client`SELECT model_config FROM workshops WHERE id=${fixture.workId} AND user_id=${fixture.owner}`)[0];
  const sourceFilters = workMemorySourceFilters(saved.model_config), requester = { type: "work" as const, userId: fixture.owner, id: fixture.workId };
  const workRequest = { requester, taskIntent: `${fixture.marker} ${fixture.beta} requested in prose only`, sourceFilters,
    discoverySources: [] as [], allowQueryRetry: false, maxItems: 20, platformState: { platform: "work" as const, phase: "t4_fixture" }, action: { kind: "answer" as const } };
  const workRecall = () => withExecutionContext(lease, () => buildBrainContextFromMemoryRequest(workRequest));
  const initial = await workRecall(); assert.ok(initial.items.some(item => item.id === fixture.ids.own));
  for (const name of ["shared", "beta", "candidate", "expired", "foreign"] as const) assert.ok(!JSON.stringify(initial.items).includes(fixture.bodies[name]));
  await withExecutionContext(lease, async () => {
    for (const query of [{ purpose: "discover", query: fixture.marker }, { purpose: "recall", taskIntent: fixture.marker }])
      await assert.rejects(owner.read(query), { status: 403 });
  });
  const grant = await createBrainAccessGrant({ userId: fixture.owner, subjectType: "work", subjectId: fixture.workId,
    scope: { type: "work", workId: fixture.sourceWorkId }, permissions: ["reference"], memoryTypes: ["insight"] });
  assert.equal(Number((await client`SELECT count(*)::int AS n FROM brain_state_snapshots WHERE user_id=${fixture.owner}
    AND snapshot_type='memory_access_change' AND content->>'action'='create' AND content->'grant'->>'id'=${grant.id}`)[0].n), 1);
  const granted = await workRecall(); assert.ok(granted.items.some(item => item.id === fixture.ids.shared));
  await checkAdmissionRevocationCommitOrder(client, { requester, pack: granted, taskIntent: workRequest.taskIntent, sourceFilters }, lease, grant.id, fixture.ids.shared);
  const rechecked = await withExecutionContext(lease, () => finalizeContextPack({ requester, pack: granted, taskIntent: workRequest.taskIntent, sourceFilters }));
  assert.ok(!rechecked.items.some(item => item.id === fixture.ids.shared)); assert.ok(!JSON.stringify(rechecked.items).includes(fixture.bodies.shared));
  assert.ok(rechecked.denied.some(item => item.id === fixture.ids.shared));
  const recheckedContextLogId = rechecked.contextLogId; assert.ok(recheckedContextLogId);
  const admittedRow = (await client`SELECT selected_memory_ids,metadata FROM brain_context_logs WHERE id=${recheckedContextLogId} AND user_id=${fixture.owner}`)[0];
  assert.deepEqual(admittedRow.selected_memory_ids, rechecked.items.map(item => item.id));
  assert.ok(!admittedRow.selected_memory_ids.includes(fixture.ids.shared));
  for (const item of rechecked.items) { assert.equal(item.ref?.revision, item.revisionVersion); assert.equal(item.receipt?.id, rechecked.contextLogId); }
  await assert.rejects(withExecutionContext({ ...lease, token: 6 }, () => finalizeContextPack({ requester, pack: initial, taskIntent: workRequest.taskIntent, sourceFilters })), { code: "lease_lost" });
  checks.push("trusted Work coordinator uses the saved scenario; real audited governance grant/revoke calls serialize with final admission under pg_locks barriers, revoke removes old selection and stale tokens cannot finalize");
  await checkDispatchGuard(client, fixture, lease, workRequest);
  checks.push("the real dispatch guard rechecks the registered selected versions before each logical request; revoke and final audit failure both reject with no new admission receipt or external model call");
  const originalGlobal = await getMemoryById({ userId: fixture.owner, memoryId: fixture.ids.global }); assert.ok(originalGlobal);
  const revision = await owner.submit({ kind: "memory.revise", commandId: randomUUID(), memoryId: originalGlobal.id,
    expectedVersion: getBrainMemoryRevisionVersion(originalGlobal), operation: "correct", authority: "owner_statement",
    content: `${fixture.marker} OWNER_GLOBAL_CORRECTED`, reason: "Synthetic same-query revision invalidation", evidenceRefs: [fixture.evidenceRef] });
  assert.equal(revision.status, "recorded");
  const refreshed = recalled(await owner.read(request)); assert.ok(!JSON.stringify(refreshed.pack).includes(fixture.bodies.global));
  assert.ok(JSON.stringify(refreshed.pack).includes("OWNER_GLOBAL_CORRECTED"));
  checks.push("the identical public recall request reads the committed correction rather than an old cached interpretation");
  const queryCount = async () => Number((await client`SELECT count(*)::int AS n FROM memory_query_read_receipts WHERE user_id=${fixture.owner}`)[0].n);
  const finalLogCount = async () => Number((await client`SELECT count(*)::int AS n FROM brain_context_logs WHERE user_id=${fixture.owner} AND metadata->>'source'='owner_recall_final'`)[0].n);
  const beforeFault = await queryCount(), finalBeforeFault = await finalLogCount(), trigger = `reject_t4_query_${randomUUID().replaceAll("-", "")}`;
  await client.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${fixture.owner}'::uuid THEN RAISE EXCEPTION 'injected T4 query receipt failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON memory_query_read_receipts FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  try {
    await assert.rejects(owner.read({ purpose: "discover", query: fixture.marker }), error => causedBy(error, /injected T4 query receipt failure/));
    await assert.rejects(owner.read(request), error => causedBy(error, /injected T4 query receipt failure/));
    assert.equal(await queryCount(), beforeFault);
    assert.equal(await finalLogCount(), finalBeforeFault, "The final context admission and query receipt share one commit");
  } finally { await client.unsafe(`DROP TRIGGER ${trigger} ON memory_query_read_receipts`); await client.unsafe(`DROP FUNCTION ${trigger}()`); }
  recalled(await owner.read(request));
  checks.push("discovery/recall do not return a successful body when the durable query receipt fails; a fresh read recovers");
  const auditTrigger = `reject_t4_admission_${randomUUID().replaceAll("-", "")}`, queryBeforeAudit = await queryCount();
  await client.unsafe(`CREATE FUNCTION ${auditTrigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${fixture.owner}'::uuid AND NEW.metadata->>'source'='owner_recall_final' THEN RAISE EXCEPTION 'injected T4 final admission failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${auditTrigger} BEFORE INSERT ON brain_context_logs FOR EACH ROW EXECUTE FUNCTION ${auditTrigger}()`);
  try {
    await assert.rejects(owner.read(request), { code: "memory_context_unavailable", status: 503 });
    assert.equal(await queryCount(), queryBeforeAudit);
  } finally { await client.unsafe(`DROP TRIGGER ${auditTrigger} ON brain_context_logs`); await client.unsafe(`DROP FUNCTION ${auditTrigger}()`); }
  checks.push("a failed final admission audit never returns the earlier prepared context as a successful recall");
  const reviewCount = async () => Number((await client`SELECT count(*)::int AS n FROM workshop_review_items WHERE workshop_id=${fixture.workId}`)[0].n);
  const reviewsBefore = await reviewCount();
  const quality = await inspectWorkshopMemoryRecallQuality({ userId: fixture.owner, workshopId: fixture.workId, syncReviewItems: false });
  assert.equal(quality.reviewItemSync.status, "skipped"); assert.equal(await reviewCount(), reviewsBefore);
  assert.equal(quality.scope.kind, "user_memory_recall_sample"); assert.equal(quality.auditGuardrails.noContextLogMeans, "unobserved");
  assert.ok(quality.feedbackQuality.verifiedContextCount >= 1);
  for (const body of Object.values(fixture.bodies)) assert.ok(!JSON.stringify(quality).includes(body));
  await assert.rejects(inspectWorkshopMemoryRecallQuality({ userId: fixture.foreignOwner, workshopId: fixture.workId, syncReviewItems: false }), /Workshop not found/);
  assert.equal((await synchronizeWorkshopMemoryRecallQualityReviews({ userId: fixture.owner, workshopId: fixture.workId })).reviewItemSync.status, "synced");
  checks.push("quality inspection remains readonly, aggregate and explicitly unobserved where appropriate; review synchronization is a separate owner maintenance command");
  checks.push(await checkDiscoveryRevisionCommitOrder(client, fixture));
  const largeBoundary = randomUUID();
  await client`INSERT INTO brain_memories(id,user_id,scope_type,owner_type,owner_id,memory_type,subject,content,status,confidence,evidence_refs,metadata)
    VALUES (${largeBoundary},${fixture.owner},'global','chat',${fixture.owner},'boundary',${fixture.marker + " oversized constraint"},
      ${fixture.marker + " FULL_T4_CONSTRAINT ".repeat(1000)},'verified',100,${JSON.stringify([fixture.evidenceRef])}::jsonb,
      ${JSON.stringify({ canonicalKind: "boundary", canonicalGroupId: `t4:${largeBoundary}` })}::jsonb)`;
  const insufficient = await owner.read({ purpose: "recall", taskIntent: fixture.marker, maxTokens: 1024 });
  assert.equal(insufficient.status, "unavailable"); assert.ok("code" in insufficient); assert.equal(insufficient.code, "memory_context_budget_insufficient");
  assert.ok(!JSON.stringify(insufficient).includes("FULL_T4_CONSTRAINT"));
  checks.push("insufficient budget for the complete selected safety constraints returns explicit unavailable rather than silently dropping their text");
  return { name: "T4 owner discovery, finalized recall and original evidence", passed: true, databaseScope: "synthetic_isolated", checks };
}
