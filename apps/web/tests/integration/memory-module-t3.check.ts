import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { createOwnerMemoryClient } from "@/lib/memory";
import type { BrainMemory } from "@/lib/memory/kernel/memory-types";
import type { RevisionCommandResult } from "@/lib/memory/revision/owner-commands";
import type { MemoryDependencySnapshot } from "@/lib/memory/revision/dependencies";
import { createInteractionTask } from "@/lib/interactions/service";
import { actOnInteractionTask } from "@/lib/interactions/task-state";
import { withExecutionContext } from "@/lib/work-runtime/execution-context";
import { upsertBrainMemory } from "@/lib/memory/revision/legacy-storage";

type Current<T> = { status: "ok"; record: T; ref: { record: Record<string, unknown>; revision: string };
  receipt: { id: string; purpose: "current"; ref: { record: Record<string, unknown>; revision: string } }; meta: { contractVersion: string } };
type CurrentMemory = BrainMemory & { revisionVersion: string };
type Dependencies = MemoryDependencySnapshot & { id: string; verified: boolean };
function recorded(value: unknown): RevisionCommandResult {
  const result = value as RevisionCommandResult;
  assert.equal(result.status, "recorded"); assert.equal(result.resultSemantics, "historical_command_outcome");
  assert.equal(result.meta.implementationVersion, "memory-t3.v1"); assert.ok(result.receipt.id);
  for (const row of result.outcome.records) { assert.match(row.revision, /^bmrv1:[a-f0-9]{64}$/); assert.ok(row.id); }
  return result;
}
function current<T>(value: unknown): Current<T> {
  const result = value as Current<T>; assert.equal(result.status, "ok"); assert.ok(result.record);
  assert.equal(result.receipt.purpose, "current"); assert.deepEqual(result.receipt.ref, result.ref);
  assert.equal(result.meta.contractVersion, "memory-revision.v1"); return result;
}
function role(result: RevisionCommandResult, name: string) {
  const record = result.outcome.records.find(record => record.role === name); assert.ok(record, `Missing ${name} outcome record`); return record;
}
function causedBy(error: unknown, pattern: RegExp) {
  let cause = error; const messages: string[] = [];
  for (let depth = 0; depth < 8 && cause && typeof cause === "object"; depth++) {
    messages.push(String((cause as { message?: unknown }).message)); cause = (cause as { cause?: unknown }).cause;
  }
  assert.match(messages.join(" "), pattern); return true;
}

/** Public owner commands and current reads against a generated fixture DB only. */
export async function checkMemoryModuleT3(client: postgres.Sql) {
  const database = String((await client`SELECT current_database() AS name`)[0].name);
  assert.match(database, /^zhiyu_test_[a-f0-9]{32}$/);
  assert.equal(new URL(process.env.ZHIYU_TEST_DATABASE_URL ?? "").pathname, `/${database}`);
  const userId = randomUUID(), otherId = randomUUID(), sourceEventId = randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},${userId + "@example.invalid"}),(${otherId},${otherId + "@example.invalid"})`;
  await client`INSERT INTO interaction_events(id,user_id,platform,source,conversation_name,content,message_time,dedupe_key)
    VALUES (${sourceEventId},${userId},'fixture','memory_module_t3','Synthetic T3 event','Synthetic source event',now(),${randomUUID()})`;
  const owner = createOwnerMemoryClient(userId), other = createOwnerMemoryClient(otherId), checks: string[] = [];
  const submit = async (body: Record<string, unknown>) => recorded(await owner.submit(body));
  const readMemory = async (id: string) => current<CurrentMemory>(await owner.read({ purpose: "current", ref: { kind: "memory", id } }));
  const readDependencies = async (id: string) => current<Dependencies>(await owner.read({ purpose: "current", ref: { kind: "memory_dependencies", entityKind: "interaction_task", entityId: id } }));
  const raw = await owner.submit({ kind: "observation.append", commandId: randomUUID(), sourceId: randomUUID(),
    observedAt: "2026-10-20T03:00:00Z", content: "Synthetic original T3 evidence" });
  assert.equal(raw.status, "committed"); if (raw.status !== "committed") throw Error("Observation fixture unavailable");
  const evidenceRefs = [`brain-observation:${raw.observation.id}`];
  const candidateBody = (label: string) => ({ kind: "candidate.submit", commandId: randomUUID(), subject: `Synthetic T3 ${label} ${randomUUID()}`,
    content: `Synthetic assertion ${label}`, memoryType: "insight", evidenceRefs });
  const candidate = candidateBody("source"), copies = await Promise.all([submit(candidate), submit(candidate)]);
  assert.equal(copies.filter(result => result.replayed).length, 1); assert.deepEqual(copies[0].receipt, copies[1].receipt);
  const root = role(copies[0], "candidate"); assert.equal(copies[0].outcome.state, "candidate");
  await assert.rejects(submit({ ...candidate, content: "Conflicting same command" }), { code: "memory_command_conflict", status: 409 });
  const reviews = await Promise.allSettled(["confirmed", "active"].map(decision => submit({ kind: "memory.review", commandId: randomUUID(),
    memoryId: root.id, expectedVersion: root.revision, decision, reason: "Synthetic owner inspected evidence", evidenceConfirmed: true })));
  assert.equal(reviews.filter(result => result.status === "fulfilled").length, 1);
  assert.ok(reviews.some(result => result.status === "rejected" && result.reason.code === "version_conflict"));
  let source = await readMemory(root.id); assert.ok(["active", "verified"].includes(source.record.status));
  assert.equal(source.record.revisionVersion, source.ref.revision); assert.equal(source.ref.record.id, root.id);
  const retained = await submit({ ...candidate, commandId: randomUUID() });
  assert.equal(retained.outcome.state, "existing_retained"); assert.equal(role(retained, "current").id, root.id);
  checks.push("concurrent candidate command replay, payload conflict and competing review CAS use public owner commands");

  const captured = await createInteractionTask({ userId, commandId: randomUUID(), title: "Synthetic captured dependency task", sourceEventIds: [sourceEventId],
    memoryRequester: { type: "chat", userId, id: "synthetic-owner" }, memoryDependencies: [{ memoryId: source.record.id, expectedVersion: source.ref.revision }] });
  const task = await createInteractionTask({ userId, commandId: randomUUID(), title: "Synthetic registered dependency task", sourceEventIds: [sourceEventId] });
  const unknown = await readDependencies(task.id); assert.equal(unknown.record.coverage, "unknown"); assert.equal(unknown.record.verified, false);
  const bind = async (id: string, action: "register" | "rebind") => {
    const read = await readDependencies(id), latest = await readMemory(root.id);
    return submit({ kind: "dependencies.bind", commandId: randomUUID(), entityKind: "interaction_task", entityId: id, action,
      expectedEntityVersion: read.record.entity.version, expectedDependencyVersion: read.record.dependencyVersion,
      sources: [{ memoryId: latest.record.id, expectedVersion: latest.ref.revision }], reason: "Synthetic owner compared exact source and target", evidenceConfirmed: true });
  };
  const registered = await bind(task.id, "register"); assert.equal(registered.outcome.state, "bound");
  assert.equal((await readDependencies(captured.id)).record.verified, true);
  assert.equal((await readDependencies(task.id)).record.verified, true);
  await actOnInteractionTask({ userId, id: task.id, commandId: randomUUID(), expectedVersion: 0, action: "confirmEvidence" });
  source = await readMemory(root.id);
  const revisionBody = { kind: "memory.revise", commandId: randomUUID(), memoryId: source.record.id, expectedVersion: source.ref.revision,
    operation: "correct", authority: "owner_statement", content: "Synthetic owner correction", reason: "Synthetic exact correction", evidenceRefs };
  const revisions = await Promise.allSettled([submit(revisionBody), submit({ ...revisionBody, commandId: randomUUID(), content: "Competing correction" })]);
  assert.equal(revisions.filter(result => result.status === "fulfilled").length, 1);
  assert.ok(revisions.some(result => result.status === "rejected" && result.reason.code === "version_conflict"));
  const applied = revisions.find(result => result.status === "fulfilled"); assert.ok(applied && applied.status === "fulfilled");
  const revised = await readMemory(root.id); assert.equal(revised.record.id, role(applied.value, "memory").id); assert.equal(revised.ref.record.id, root.id);
  assert.notEqual(revised.ref.revision, source.ref.revision);
  assert.equal((await readDependencies(task.id)).record.assessment, "stale");
  await assert.rejects(actOnInteractionTask({ userId, id: task.id, commandId: randomUUID(), expectedVersion: 1, action: "completeTask" }), { code: "memory_dependency_stale" });
  await bind(task.id, "rebind"); assert.equal((await readDependencies(task.id)).record.verified, true);
  const completed = await actOnInteractionTask({ userId, id: task.id, commandId: randomUUID(), expectedVersion: 1, action: "completeTask" });
  assert.equal(completed.task.status, "done"); assert.equal(completed.task.revision, 2);
  checks.push("real task capture and explicit bind preserve exact sources; correction invalidates old sources, owner rebind restores the actual business action gate");

  const propose = async (content: string) => {
    const base = await readMemory(root.id);
    return submit({ kind: "memory.propose", commandId: randomUUID(), targetMemoryId: base.record.id, expectedVersion: base.ref.revision,
      content, reason: "Synthetic proposal differs from current understanding", evidenceRefs });
  };
  const decide = (proposal: RevisionCommandResult, action: "accept" | "reject") => submit({ kind: "memory.decide", commandId: randomUUID(),
    proposalId: role(proposal, "candidate").id, action, expectedVersion: role(proposal, "candidate").revision,
    expectedBaseVersion: role(proposal, "base").revision, reason: `Synthetic owner ${action} after source inspection`, evidenceConfirmed: true });
  const rejectedProposal = await propose("Synthetic proposal to reject"); assert.equal(rejectedProposal.outcome.state, "proposed");
  assert.equal((await readDependencies(task.id)).record.assessment, "stale");
  assert.equal((await decide(rejectedProposal, "reject")).outcome.state, "rejected");
  assert.equal((await readDependencies(task.id)).record.verified, true);
  const acceptedProposal = await propose("Synthetic accepted assertion");
  const accepted = await decide(acceptedProposal, "accept"); assert.equal(accepted.outcome.state, "accepted");
  const latest = await readMemory(root.id); assert.equal(latest.record.id, role(accepted, "candidate").id);
  assert.equal((await readDependencies(captured.id)).record.assessment, "stale");
  await bind(captured.id, "rebind");
  assert.equal((await actOnInteractionTask({ userId, id: captured.id, commandId: randomUUID(), expectedVersion: 0, action: "completeTask" })).task.status, "done");
  const historical = await submit(candidate); assert.equal(historical.replayed, true); assert.deepEqual(historical.outcome, copies[0].outcome);
  assert.notEqual((await readMemory(root.id)).ref.revision, role(historical, "candidate").revision);
  const explanation = await owner.explain({ receiptId: accepted.receipt.id }); assert.equal(explanation.status, "ok");
  assert.ok(!JSON.stringify(explanation).includes("Synthetic accepted assertion"));
  assert.equal((await other.explain({ receiptId: accepted.receipt.id })).status, "not_found");
  for (const ref of [{ kind: "memory", id: root.id }, { kind: "memory_dependencies", entityKind: "interaction_task", entityId: task.id }]) {
    const denied = await other.read({ purpose: "current", ref }); assert.equal(denied.status, "not_found");
    assert.ok(!JSON.stringify(denied).includes("Synthetic"));
  }
  await assert.rejects(other.submit({ kind: "memory.revise", commandId: randomUUID(), memoryId: latest.record.id, expectedVersion: latest.ref.revision,
    operation: "correct", authority: "owner_statement", content: "Foreign write", reason: "Not allowed", evidenceRefs: [] }));
  checks.push("proposal reject restores source eligibility, accept replaces it, logical current follows successors, historical receipts remain distinct and owner-isolated");

  const workshopId = randomUUID(), runId = randomUUID(), workerId = `t3-worker-${randomUUID()}`;
  await client`INSERT INTO workshops(id,user_id,name,mission,status) VALUES (${workshopId},${userId},'Synthetic T3 Work','Fixture only','active')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${runId},${workshopId},'running',clock_timestamp())`;
  await client`INSERT INTO workshop_execution_leases(workshop_id,token,run_id,worker_id,phase,lease_until)
    VALUES (${workshopId},7,${runId},${workerId},'running',clock_timestamp()+interval '5 minutes')`;
  const receiptCount = async () => Number((await client`SELECT count(*)::int AS n FROM memory_revision_command_receipts WHERE user_id=${userId}`)[0].n);
  const beforeWork = await receiptCount();
  await withExecutionContext({ userId, workshopId, runId, workerId, token: 7 }, async () => {
    for (const kind of ["candidate.submit", "memory.review", "memory.propose", "memory.decide", "memory.revise", "dependencies.bind"])
      await assert.rejects(owner.submit({ kind, commandId: randomUUID() }), { status: 403 });
    await assert.rejects(owner.read({ purpose: "current", ref: { kind: "memory", id: root.id } }), { status: 403 });
  });
  assert.equal(await receiptCount(), beforeWork);
  checks.push("a real synthetic active Work/run/lease cannot acquire owner commands or owner current reads by passing its user ID");
  const grantId = randomUUID();
  await client`INSERT INTO brain_access_grants(id,user_id,subject_type,subject_id,scope_type,permissions,memory_types)
    VALUES (${grantId},${userId},'work',${workshopId},'global','["reference"]'::jsonb,'["insight"]'::jsonb)`;
  const deniedTask = await withExecutionContext({ userId, workshopId, runId, workerId, token: 7 }, () => createInteractionTask({
    userId, commandId: randomUUID(), title: "Synthetic later denied task body", sourceEventIds: [sourceEventId], metadata: { workshopId },
    memoryRequester: { type: "work", userId, id: workshopId }, memoryDependencies: [{ memoryId: latest.record.id, expectedVersion: latest.ref.revision }],
  }));
  assert.equal((await readDependencies(deniedTask.id)).record.verified, true);
  await client`DELETE FROM brain_access_grants WHERE id=${grantId} AND user_id=${userId}`;
  const deniedView = await readDependencies(deniedTask.id);
  assert.equal(deniedView.record.assessment, "denied"); assert.equal(deniedView.record.verified, false);
  assert.equal(deniedView.record.entity.title, ""); assert.equal(deniedView.record.entity.content, "");
  assert.equal(deniedView.record.registry?.reason, "");
  assert.ok(deniedView.record.sources.every(item => !item.oldMemory && !item.currentMemory));
  assert.ok(!JSON.stringify(deniedView.record).includes(latest.record.content));
  await assert.rejects(actOnInteractionTask({ userId, id: deniedTask.id, commandId: randomUUID(), expectedVersion: 0, action: "completeTask" }), { code: "memory_dependency_stale" });
  checks.push("revoked actual Work source grants retain denied priority, withhold dependency bodies and block the real task action even during owner inspection");

  const counts = async () => (await client`SELECT
    (SELECT count(*)::int FROM brain_memories WHERE user_id=${userId}) AS memories,
    (SELECT count(*)::int FROM brain_observations WHERE user_id=${userId}) AS observations,
    (SELECT count(*)::int FROM brain_memory_reviews WHERE user_id=${userId}) AS reviews,
    (SELECT count(*)::int FROM brain_state_snapshots WHERE user_id=${userId}) AS snapshots,
    (SELECT count(*)::int FROM memory_revision_command_receipts WHERE user_id=${userId}) AS receipts`)[0];
  const faultRevision = { kind: "memory.revise", commandId: randomUUID(), memoryId: latest.record.id, expectedVersion: latest.ref.revision,
    operation: "correct", authority: "owner_statement", content: "Synthetic rollback replacement", reason: "Synthetic transaction failure", evidenceRefs };
  for (const mode of ["ledger", "receipt"] as const) {
    const before = await counts(), trigger = `reject_t3_${mode}_${randomUUID().replaceAll("-", "")}`;
    const table = mode === "ledger" ? "brain_state_snapshots" : "memory_revision_command_receipts";
    const condition = mode === "ledger" ? `AND NEW.snapshot_type='memory_dependency_change'` : "";
    await client.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${userId}'::uuid ${condition} THEN RAISE EXCEPTION 'injected T3 ${mode} failure'; END IF; RETURN NEW; END $$`);
    await client.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    try {
      await assert.rejects(submit(faultRevision), error => causedBy(error, new RegExp(`injected T3 ${mode} failure`)));
      assert.deepEqual(await counts(), before);
      if (mode === "receipt") {
        await assert.rejects(submit(candidateBody("rollback candidate")), error => causedBy(error, /injected T3 receipt failure/));
        assert.deepEqual(await counts(), before);
      }
    } finally { await client.unsafe(`DROP TRIGGER ${trigger} ON ${table}`); await client.unsafe(`DROP FUNCTION ${trigger}()`); }
    assert.equal((await readMemory(root.id)).ref.revision, latest.ref.revision);
  }
  const recovered = await submit(faultRevision); assert.equal(recovered.replayed, false);
  assert.equal((await submit(faultRevision)).receipt.id, recovered.receipt.id);
  checks.push("source-change ledger and public command receipt faults roll back memory retirement/replacement, raw assertion, review and receipt; the original command safely retries");
  const readTrigger = `reject_t3_read_${randomUUID().replaceAll("-", "")}`;
  const readsBefore = Number((await client`SELECT count(*)::int AS n FROM memory_state_read_receipts WHERE user_id=${userId}`)[0].n);
  await client.unsafe(`CREATE FUNCTION ${readTrigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${userId}'::uuid THEN RAISE EXCEPTION 'injected T3 state receipt failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${readTrigger} BEFORE INSERT ON memory_state_read_receipts FOR EACH ROW EXECUTE FUNCTION ${readTrigger}()`);
  try {
    await assert.rejects(readMemory(root.id), error => causedBy(error, /injected T3 state receipt failure/));
    await assert.rejects(readDependencies(task.id), error => causedBy(error, /injected T3 state receipt failure/));
    assert.equal(Number((await client`SELECT count(*)::int AS n FROM memory_state_read_receipts WHERE user_id=${userId}`)[0].n), readsBefore);
  } finally { await client.unsafe(`DROP TRIGGER ${readTrigger} ON memory_state_read_receipts`); await client.unsafe(`DROP FUNCTION ${readTrigger}()`); }
  checks.push("memory/dependency current reads reject receipt faults without claiming an unaudited successful read");
  const legacyCandidate = await submit({ ...candidateBody("legacy source"), memoryType: "preference",
    subject: `Synthetic legacy rendering preference ${randomUUID()}`, content: "Use compact synthetic summaries" });
  assert.equal(legacyCandidate.outcome.state, "candidate");
  const legacyRef = role(legacyCandidate, "candidate");
  await submit({ kind: "memory.review", commandId: randomUUID(), memoryId: legacyRef.id, expectedVersion: legacyRef.revision,
    decision: "confirmed", reason: "Synthetic source for legacy writer compatibility", evidenceConfirmed: true });
  const legacyBefore = await readMemory(legacyRef.id);
  const legacyTask = await createInteractionTask({ userId, commandId: randomUUID(), title: "Synthetic legacy source dependent task", sourceEventIds: [sourceEventId],
    memoryRequester: { type: "chat", userId, id: "synthetic-owner" }, memoryDependencies: [{ memoryId: legacyBefore.record.id, expectedVersion: legacyBefore.ref.revision }] });
  const legacyLedgerCount = async () => Number((await client`SELECT count(*)::int AS n FROM brain_state_snapshots
    WHERE user_id=${userId} AND snapshot_type='memory_dependency_change' AND content->>'oldMemoryId'=${legacyRef.id}`)[0].n);
  const oldLedgerCount = await legacyLedgerCount();
  const legacyAfter = await upsertBrainMemory({ ...legacyBefore.record, content: "Synthetic legacy in-place source correction",
    updatedAt: new Date(Date.parse(legacyBefore.record.updatedAt) + 1).toISOString() });
  const legacyCurrent = await readMemory(legacyRef.id); assert.equal(legacyCurrent.record.id, legacyRef.id);
  assert.notEqual(legacyCurrent.ref.revision, legacyBefore.ref.revision); assert.equal(legacyAfter.content, legacyCurrent.record.content);
  assert.equal(await legacyLedgerCount(), oldLedgerCount + 1);
  const legacyChange = (await client`SELECT content FROM brain_state_snapshots WHERE user_id=${userId} AND snapshot_type='memory_dependency_change'
    AND metadata->>'commandId'=${`legacy-upsert:${legacyAfter.id}:${legacyCurrent.ref.revision}`}`)[0];
  assert.ok(legacyChange); assert.equal(legacyChange.content.oldVersion, legacyBefore.ref.revision);
  assert.equal(legacyChange.content.retiredVersion, legacyCurrent.ref.revision);
  assert.equal((await readDependencies(legacyTask.id)).record.assessment, "stale");
  await assert.rejects(actOnInteractionTask({ userId, id: legacyTask.id, commandId: randomUUID(), expectedVersion: 0, action: "completeTask" }), { code: "memory_dependency_stale" });
  await upsertBrainMemory(legacyAfter); assert.equal(await legacyLedgerCount(), oldLedgerCount + 1);
  const legacyBasis = await readDependencies(legacyTask.id);
  await submit({ kind: "dependencies.bind", commandId: randomUUID(), entityKind: "interaction_task", entityId: legacyTask.id, action: "rebind",
    expectedEntityVersion: legacyBasis.record.entity.version, expectedDependencyVersion: legacyBasis.record.dependencyVersion,
    sources: [{ memoryId: legacyAfter.id, expectedVersion: legacyCurrent.ref.revision }], reason: "Synthetic owner reviewed legacy in-place correction", evidenceConfirmed: true });
  const legacyTrigger = `reject_t3_legacy_${randomUUID().replaceAll("-", "")}`;
  await client.unsafe(`CREATE FUNCTION ${legacyTrigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${userId}'::uuid AND NEW.snapshot_type='memory_dependency_change' AND NEW.content->>'oldMemoryId'='${legacyRef.id}' THEN RAISE EXCEPTION 'injected T3 legacy ledger failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${legacyTrigger} BEFORE INSERT ON brain_state_snapshots FOR EACH ROW EXECUTE FUNCTION ${legacyTrigger}()`);
  try {
    await assert.rejects(upsertBrainMemory({ ...legacyAfter, content: "Uncommitted legacy source correction",
      updatedAt: new Date(Date.parse(legacyAfter.updatedAt) + 1).toISOString() }), error => causedBy(error, /injected T3 legacy ledger failure/));
  } finally { await client.unsafe(`DROP TRIGGER ${legacyTrigger} ON brain_state_snapshots`); await client.unsafe(`DROP FUNCTION ${legacyTrigger}()`); }
  assert.equal(await legacyLedgerCount(), oldLedgerCount + 1);
  assert.equal((await readMemory(legacyRef.id)).ref.revision, legacyCurrent.ref.revision);
  assert.equal((await readDependencies(legacyTask.id)).record.verified, true);
  assert.equal((await actOnInteractionTask({ userId, id: legacyTask.id, commandId: randomUUID(), expectedVersion: 0, action: "completeTask" })).task.status, "done");
  checks.push("legacy in-place upsert adds one deterministic exact-version change ledger, invalidates the real dependent gate, skips unchanged replay, and rolls back source plus ledger on failure");
  return { name: "T3 public owner commands, exact current dependencies and atomic revision loop", passed: true, databaseScope: "synthetic_isolated", checks,
    limits: ["recorded dependency edges do not prove completeness", "no external action or real user data", "history outcomes do not establish current business state"] };
}
