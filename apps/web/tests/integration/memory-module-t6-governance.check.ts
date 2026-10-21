import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type postgres from "postgres";
import { insertBrainMemory } from "@/lib/memory/revision/legacy-storage";
import { getBrainMemoryById } from "@/lib/memory/adapters/postgres/memory-records";
import { getBrainMemoryRevisionVersion } from "@/lib/memory/revision/version";
import { createBrainMemoryCorrectionDraft, getBrainMemoryCorrectionDraft } from "@/lib/memory/revision/correction-draft";
import { getBrainMemoryAutoUpdatePolicy, updateBrainMemoryAutoUpdatePolicy } from "@/lib/memory/revision/auto-update-policy";
import { applyDocumentMemoryUpdate } from "@/lib/memory/revision/document-update";
import { appendWorkshopEvent, addWorkshopMemory, getWorkshop } from "@/lib/workshops/service";
import { db } from "@/lib/db/client";
import type { DrizzleDB } from "@/lib/db/types";
import { ensureWorkshopMemoryMirrorInTransaction } from "@/lib/memory/revision/workshop-mirror";
import { cancelWorkRun } from "@/lib/work-runtime/cancel-run";
import { checkCanonicalBatches } from "./brain-canonical-batches.check";

/** Actual migrated governance against the root's disposable database. No
 * model, Work execution, network provider or production configuration changes. */
export async function checkMemoryModuleT6Governance(client: postgres.Sql, owner: string) {
  const database = String((await client`SELECT current_database() AS name`)[0].name);
  assert.match(database, /^zhiyu_test_[a-f0-9]{32}$/);
  assert.equal(new URL(process.env.ZHIYU_TEST_DATABASE_URL ?? "").pathname, `/${database}`);
  const requester = { type: "chat" as const, userId: owner, id: "synthetic-t6-owner" };
  const memoryId = randomUUID(), now = new Date().toISOString();
  await insertBrainMemory({ id: memoryId, userId: owner, scope: { type: "global" }, ownerType: "chat", ownerId: owner,
    memoryType: "fact", subject: "T6 synthetic correction", content: "Original synthetic statement", status: "active", confidence: 70,
    evidenceRefs: [], createdAt: now, updatedAt: now, metadata: { canonicalKind: "state", canonicalGroupId: memoryId } });
  const current = await getBrainMemoryById({ userId: owner, memoryId }); assert.ok(current);
  const version = getBrainMemoryRevisionVersion(current), commandId = randomUUID();
  const request = { commandId, expectedVersion: version, intent: "完整改为：新的合成原始陈述，仅证明主人提交。" };
  const drafted = await createBrainMemoryCorrectionDraft({ requester, memoryId, request });
  assert.equal(drafted.draft.outcome, "ready"); assert.equal(drafted.receipt.effective, false);
  assert.equal(drafted.draft.authority, null); assert.equal(drafted.draft.sourceObservedAt, null);
  assert.equal((await getBrainMemoryCorrectionDraft({ requester, memoryId, commandId })).receipt.id, drafted.receipt.id);
  assert.equal((await createBrainMemoryCorrectionDraft({ requester, memoryId, request })).replayed, true);
  await assert.rejects(createBrainMemoryCorrectionDraft({ requester, memoryId, request: { ...request, intent: "完整改为：另一份内容。" } }));
  await assert.rejects(createBrainMemoryCorrectionDraft({ requester: { type: "work", userId: owner, id: memoryId }, memoryId, request }));
  const unchanged = await getBrainMemoryById({ userId: owner, memoryId }); assert.ok(unchanged);
  assert.equal(getBrainMemoryRevisionVersion(unchanged), version);
  const original = (await client`SELECT content,metadata FROM brain_observations WHERE id=${drafted.receipt.observationId}`)[0];
  assert.equal(original.content, request.intent); assert.equal(original.metadata.independentlyVerifiesBusinessFact, false);
  const trigger = "t6_draft_fault_" + randomUUID().replaceAll("-", "");
  const priorCount = Number((await client`SELECT count(*)::int AS n FROM brain_observations WHERE user_id=${owner}`)[0].n);
  await client.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${owner}'::uuid AND NEW.snapshot_type='memory_correction_draft' THEN RAISE EXCEPTION 'synthetic_t6_draft_receipt_fault'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON brain_state_snapshots FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  try { await assert.rejects(createBrainMemoryCorrectionDraft({ requester, memoryId, request: { ...request, commandId: randomUUID() } })); }
  finally { await client.unsafe(`DROP TRIGGER ${trigger} ON brain_state_snapshots`); await client.unsafe(`DROP FUNCTION ${trigger}()`); }
  assert.equal(Number((await client`SELECT count(*)::int AS n FROM brain_observations WHERE user_id=${owner}`)[0].n), priorCount);

  const policy = await getBrainMemoryAutoUpdatePolicy({ userId: owner });
  const policyRequest = { commandId: randomUUID(), expectedVersion: policy.version, enabled: false, reason: "Synthetic bounded pause" };
  const paused = await updateBrainMemoryAutoUpdatePolicy({ requester, request: policyRequest });
  assert.equal(paused.enabled, false); assert.equal((await updateBrainMemoryAutoUpdatePolicy({ requester, request: policyRequest })).replayed, true);
  await assert.rejects(updateBrainMemoryAutoUpdatePolicy({ requester, request: { ...policyRequest, commandId: randomUUID(), enabled: true } }));
  const resumed = await updateBrainMemoryAutoUpdatePolicy({ requester, request: { commandId: randomUUID(), expectedVersion: paused.version, enabled: true, reason: "Synthetic resume" } });
  assert.equal(resumed.enabled, true);
  assert.equal((await client`SELECT metadata->>'source' AS source FROM brain_state_snapshots WHERE id=${resumed.snapshotId}`)[0].source, "brain_memory_auto_policy.v1");

  const workId = randomUUID(), sourceId = randomUUID();
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workId},${owner},'T6 document program fixture','Synthetic document state program')`;
  await client`INSERT INTO workshop_sources(id,workshop_id,type,name,enabled,config) VALUES (${sourceId},${workId},'file','T6 synthetic document',true,'{}'::jsonb)`;
  const facts = { sourceId, sourceSha256: "a".repeat(64), documentSha256: "b".repeat(64), manifestSha256: "c".repeat(64), sourceFormat: "markdown", chunkCount: 1, warnings: [] as string[] };
  const event = () => appendWorkshopEvent({ workshopId: workId, type: "document_converted", title: "Synthetic program facts",
    metadata: { receiptAuthority: "runtime", ...facts } });
  const late = await event(), latest = await event();
  const apply = (source: typeof late) => applyDocumentMemoryUpdate({ userId: owner, workId, ...facts,
    sourceEventId: source.id, sourceEventSeq: source.seq, observedAt: source.createdAt });
  const applied = await apply(latest); assert.equal(applied.status, "created_active");
  const ignored = await apply(late); assert.equal(ignored.status, "skipped"); assert.equal(ignored.reason, "non_monotonic_source");
  const replayed = await apply(latest); assert.equal(replayed.status, "replayed");
  const rows = await client`SELECT status,metadata FROM brain_memories WHERE user_id=${owner} AND owner_id=${workId}`;
  assert.equal(rows.filter(row => row.status === "active").length, 1);
  assert.equal(rows.find(row => row.status === "active")?.metadata.documentProgramUpdate.sourceEventSeq, latest.seq);
  const work = await getWorkshop(owner, workId); assert.ok(work);
  const mirror = await addWorkshopMemory({ workshopId: workId, kind: "finding", content: "Synthetic historical Work mirror",
    confidence: 70, sourceEventIds: [latest.id] });
  // Simulate an already-retired source in the original mirror slot. A legacy
  // caller may ensure its existence, but cannot replace its status or content.
  await client`UPDATE brain_memories SET status='superseded',content='OWNER_RETIRED_VERSION',
    metadata=metadata||' {"revisionRetired":{"fixture":true}}'::jsonb WHERE id=${mirror.id}`;
  const beforeMirror = (await client`SELECT to_jsonb(m) AS value FROM brain_memories m WHERE id=${mirror.id}`)[0].value;
  await db.transaction((store: DrizzleDB) => ensureWorkshopMemoryMirrorInTransaction(store, { workshop: work, memory: mirror }));
  assert.deepEqual((await client`SELECT to_jsonb(m) AS value FROM brain_memories m WHERE id=${mirror.id}`)[0].value, beforeMirror);
  const runId = randomUUID();
  await client`INSERT INTO workshop_runs(id,workshop_id,status) VALUES (${runId},${workId},'queued')`;
  const stateFault = "t6_state_fault_" + randomUUID().replaceAll("-", "");
  await client.unsafe(`CREATE FUNCTION ${stateFault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${owner}'::uuid AND NEW.snapshot_type='work_state' THEN RAISE EXCEPTION 'synthetic_t6_state_receipt_fault'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${stateFault} BEFORE INSERT ON brain_state_snapshots FOR EACH ROW EXECUTE FUNCTION ${stateFault}()`);
  try { await assert.rejects(cancelWorkRun({ userId: owner, workId, runId, commandId: randomUUID() })); }
  finally { await client.unsafe(`DROP TRIGGER ${stateFault} ON brain_state_snapshots`); await client.unsafe(`DROP FUNCTION ${stateFault}()`); }
  assert.equal((await client`SELECT status FROM workshop_runs WHERE id=${runId}`)[0].status, "queued");
  const cancelled = await cancelWorkRun({ userId: owner, workId, runId, commandId: randomUUID() });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(Number((await client`SELECT count(*)::int AS n FROM brain_state_snapshots WHERE user_id=${owner} AND snapshot_type='work_state' AND content->>'runId'=${runId}`)[0].n), 1);
  const canonical = await checkCanonicalBatches(client, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
  return { name: "T6 migrated governance", passed: true, correctionRawStatement: true, correctionNoEffectiveChange: true,
    draftReceiptFailureRollsBackObservation: true, policyCASAndReplay: true, documentLateSequenceRejected: true,
    retiredMirrorNotRewritten: true, domainTerminalAndMemoryRollbackTogether: true, canonical };
}
