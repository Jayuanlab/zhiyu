import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type postgres from "postgres";
import { db, withDatabaseTransaction } from "@/lib/db/client";
import { buildAgentRuntimeRunSnapshot } from "@/lib/ai/runtime/run-snapshot";
import { appendWorkshopEvent } from "@/lib/workshops/service";
import { persistWorkRunRuntimeSnapshot } from "@/lib/memory/continuity/runtime-snapshot";
import { buildContinuityRuntimeBinding } from "@/lib/memory/continuity/runtime-binding";
import { loadWorkingMemoryContinuity, type WorkingMemoryContinuityInput } from "@/lib/memory/continuity/working-memory";
import { createContinuitySourceVerifier } from "@/lib/memory/continuity/source-validation";
import { createStateSnapshot } from "@/lib/memory/continuity/state-snapshots";
import { BrainMemoryUpdateError, MemoryIdentityConflict } from "@/lib/memory/kernel/reference-errors";
import { BrainMemoryUpdateError as LegacyUpdateError } from "@/lib/brain/memory-update-common";
import { getBrainMemoryById } from "@/lib/memory/adapters/postgres/memory-records";
import { getBrainMemoryRevisionVersion } from "@/lib/memory/revision/version";
import { createBrainAccessGrant, deleteBrainAccessGrant } from "@/lib/memory/governance/access-grants";
import { withMemoryDispatchContext, bindMemoryDispatchRuntime, assertMemoryDispatchCurrent } from "@/lib/memory/context/dispatch";
import { workMemoryApplicabilityHash, workMemorySourceFilters } from "@/lib/memory/kernel/runtime-applicability";
import { promotionEvents } from "../fixtures/working-memory-promotion";

/** Invoked only by the root's isolated PG runner. Creates terminal fixture rows;
 * never starts a Work/Loop, invokes a model, or opens another DB connection. */
export async function checkMemoryModuleT5Continuity(client: postgres.Sql, owner: string) {
  const database = String((await client`SELECT current_database() AS name`)[0].name);
  assert.match(database, /^zhiyu_test_[a-f0-9]{32}$/);
  assert.equal(new URL(process.env.ZHIYU_TEST_DATABASE_URL ?? "").pathname, `/${database}`);
  assert.equal(new URL(process.env.POSTGRES_URL ?? process.env.DATABASE_URL ?? "").pathname, `/${database}`);
  assert.equal(String((await db.execute(sql`SELECT current_database() AS name`))[0].name), database);
  const ids = { work: randomUUID(), otherWork: randomUUID(), sourceRun: randomUUID(), currentRun: randomUUID(),
    memory: randomUUID(), failedSnapshot: randomUUID(), loop: randomUUID(), otherLoop: randomUUID(),
    loopPhysical: randomUUID(), loopSource: randomUUID(), loopCurrent: randomUUID() };
  const marker = `T5_CONTINUITY_${randomUUID()}`, runtime = { engine: "pi" as const, adapter: "pi-agent-harness", version: "synthetic-t5" };
  const policyIdentity = { version: "memact-automem.v1", hash: "c".repeat(64) };
  const modelConfig = { memoryApplicability: { schemaVersion: "memory-applicability.v1", scenarioKeys: ["project:synthetic-alpha"] } };
  const applicabilityHash = workMemoryApplicabilityHash(modelConfig), sourceFilters = workMemorySourceFilters(modelConfig);
  const baseConfig = { mission: "Synthetic continuity fixture", boundaryPolicy: { externalWrite: "deny" }, modelConfig };
  const binding = (runId: string, patch: Partial<Parameters<typeof buildContinuityRuntimeBinding>[0]> = {}) => buildContinuityRuntimeBinding({
    userId: owner, workshopId: ids.work, loopId: null, runId, runtime, workshopConfig: baseConfig,
    allowedToolNames: ["webReadPage"], deniedToolNames: ["sendMessage"], policyIdentity, applicabilityHash, ...patch });
  let grantId: string | undefined, trigger: string | undefined;
  try {
    await client`INSERT INTO workshops(id,user_id,name,mission,boundary_policy,model_config) VALUES
      (${ids.work},${owner},${marker},${baseConfig.mission},${JSON.stringify(baseConfig.boundaryPolicy)}::jsonb,${JSON.stringify(modelConfig)}::jsonb),
      (${ids.otherWork},${owner},${marker + "_other"},'Other synthetic scope','{}','{}')`;
    await client`INSERT INTO workshop_runs(id,workshop_id,status,created_at,started_at) VALUES
      (${ids.sourceRun},${ids.work},'running',now()-interval '1 minute',now()-interval '1 minute'),
      (${ids.currentRun},${ids.work},'running',now(),now())`;
    await client`INSERT INTO loops(id,user_id,workshop_id,name,goal) VALUES
      (${ids.loop},${owner},${ids.work},${marker + "_loop"},'Synthetic loop'),
      (${ids.otherLoop},${owner},${ids.work},${marker + "_other_loop"},'Other synthetic loop')`;
    await client`INSERT INTO brain_memories(id,user_id,scope_type,owner_type,owner_id,memory_type,subject,content,status,confidence,
      evidence_refs,canonical_kind,canonical_group_id,metadata) VALUES (${ids.memory},${owner},'global','chat',${owner},'fact',${marker},
      'Synthetic saved source.','active',80,'[]','state',${ids.memory},${JSON.stringify({ canonicalKind: "state", canonicalGroupId: ids.memory,
        facets: { scenarioKeys: ["project:synthetic-alpha"] } })}::jsonb)`;
    const memory = await getBrainMemoryById({ userId: owner, memoryId: ids.memory }); assert.ok(memory);
    const version = getBrainMemoryRevisionVersion(memory);
    const grant = await createBrainAccessGrant({ userId: owner, subjectType: "work", subjectId: ids.work, scope: { type: "global" },
      permissions: ["reference"], memoryTypes: ["fact"] }); grantId = grant.id;
    const storedBinding = binding(ids.sourceRun);
    const snapshot = buildAgentRuntimeRunSnapshot({ runtime, runtimeSelection: { engine: "pi", source: "config" },
      model: { model: "synthetic-no-provider", source: "user", tier: "standard" }, prompt: "Synthetic run; no provider invoked",
      allowedTools: ["webReadPage"], policy: baseConfig.boundaryPolicy,
      extra: { workshopId: ids.work, continuityBinding: storedBinding, workingMemoryPolicy: { applicabilityHash } } });
    const configured = await appendWorkshopEvent({ workshopId: ids.work, runId: ids.sourceRun, type: "agent_configured",
      title: marker, metadata: { receiptAuthority: "runtime", runtimeRunSnapshot: snapshot } });
    await persistWorkRunRuntimeSnapshot(db, { workshopId: ids.work, runId: ids.sourceRun, eventId: configured.id, snapshot });
    await persistWorkRunRuntimeSnapshot(db, { workshopId: ids.work, runId: ids.sourceRun, eventId: configured.id, snapshot });
    await assert.rejects(() => persistWorkRunRuntimeSnapshot(db, { workshopId: ids.work, runId: ids.sourceRun, eventId: configured.id,
      snapshot: { ...snapshot, model: "forged-second-origin" } }), MemoryIdentityConflict);
    const events = promotionEvents(), source = events[0], updated = events[1], projected = events[2];
    const sourceId: string = randomUUID();
    const catalogEntry = { ...(updated.metadata.evidenceCatalog as Array<Record<string, unknown>>)[0],
      sourceIdentity: { sourceEventId: sourceId, evidenceId: "synthetic-source", contentHash: "a".repeat(64), offset: 0,
        contentLength: 1000, totalChars: 2000, memoryId: ids.memory, sourceVersion: version } };
    await appendWorkshopEvent({ workshopId: ids.work, runId: ids.sourceRun, type: "source_checked", title: marker,
      metadata: { ...source.metadata, evidenceId: "synthetic-source", sourceVersion: version } }).then(async saved => {
      // The host-generated event ID, never a guessed/model ID, binds the source.
      catalogEntry.sourceIdentity.sourceEventId = saved.id;
    });
    await appendWorkshopEvent({ workshopId: ids.work, runId: ids.sourceRun, type: "working_memory_updated", title: marker,
      metadata: { ...updated.metadata, runtimeBinding: storedBinding, applicabilityHash, evidenceCatalog: [catalogEntry],
        state: { facts: [{ text: marker + "_ASSERTION", evidenceIds: ["read-1"] }], hypotheses: [],
          openQuestions: ["Which current source should be checked?"], nextAction: { text: marker + "_ACTION", evidenceIds: ["read-1"] },
          summary: marker + "_SUMMARY", progress: marker + "_PROGRESS" } } });
    await appendWorkshopEvent({ workshopId: ids.work, runId: ids.sourceRun, type: "working_memory_projected", title: marker,
      metadata: { ...projected.metadata, evidenceCatalog: [catalogEntry] } });
    await client`UPDATE workshop_runs SET status='completed',completed_at=now() WHERE id=${ids.sourceRun}`;
    const input: WorkingMemoryContinuityInput = { userId: owner, workshopId: ids.work, currentRunId: ids.currentRun,
      scope: { kind: "parent_run", parentRunId: ids.sourceRun }, policyIdentity, applicabilityHash,
      runtimeBinding: binding(ids.currentRun), now: new Date(Date.now() + 10_000),
      verifySources: createContinuitySourceVerifier({ requester: { type: "work", userId: owner, id: ids.work }, sourceFilters }) };
    const use = <T>(work: () => Promise<T>) => withMemoryDispatchContext(async () => { bindMemoryDispatchRuntime(runtime); return work(); });
    const loaded = await use(async () => {
      const value = await loadWorkingMemoryContinuity(input); await assertMemoryDispatchCurrent(); return value;
    });
    assert.equal(loaded.status, "inherited"); assert.ok(loaded.checkpoint?.history.facts.length);
    assert.equal(loaded.checkpoint.authority, "historical-model-authored-unverified");
    const loadedReceipt = await appendWorkshopEvent({ workshopId: ids.work, runId: ids.currentRun, type: "working_memory_continuity_loaded",
      title: marker, metadata: { receiptAuthority: "runtime", ...loaded, runtimeBinding: binding(ids.currentRun) } });
    assert.ok((await client`SELECT id FROM workshop_events WHERE id=${loadedReceipt.id}`)[0]);
    for (const patch of [{ allowedToolNames: ["anotherRead"] }, { deniedToolNames: ["webReadPage"] },
      { applicabilityHash: "e".repeat(64) }, { workshopConfig: { ...baseConfig, mission: "Changed role" } }]) {
      const changed = await use(() => loadWorkingMemoryContinuity({ ...input, runtimeBinding: binding(ids.currentRun, patch) }));
      assert.equal(changed.status, "skipped"); assert.equal(changed.checkpoint, null);
    }
    assert.equal((await loadWorkingMemoryContinuity({ ...input, workshopId: ids.otherWork })).status, "skipped");
    assert.equal((await loadWorkingMemoryContinuity({ ...input, scope: { kind: "loop", loopId: ids.otherLoop },
      runtimeBinding: binding(ids.currentRun, { loopId: ids.otherLoop }) })).status, "skipped");
    // The logical Loop run and its Work lease run are separate identifiers in
    // persisted projections. The reader must bind both without conflating them.
    await client`INSERT INTO workshop_runs(id,workshop_id,status,created_at,started_at) VALUES
      (${ids.loopPhysical},${ids.work},'running',now()-interval '1 minute',now()-interval '1 minute')`;
    await client`INSERT INTO loop_runs(id,loop_id,status,created_at,started_at) VALUES
      (${ids.loopSource},${ids.loop},'running',now()-interval '1 minute',now()-interval '1 minute'),
      (${ids.loopCurrent},${ids.loop},'running',now(),now())`;
    const loopBinding = binding(ids.loopSource, { loopId: ids.loop });
    const loopSnapshot = buildAgentRuntimeRunSnapshot({ runtime, runtimeSelection: { engine: "pi", source: "config" },
      model: { model: "synthetic-no-provider", source: "user", tier: "standard" }, prompt: "Synthetic Loop",
      allowedTools: ["webReadPage"], policy: baseConfig.boundaryPolicy,
      extra: { workshopId: ids.work, continuityBinding: loopBinding, workingMemoryPolicy: { applicabilityHash } } });
    const loopScope = { workshopId: ids.work, runId: ids.loopPhysical, loopId: ids.loop, loopRunId: ids.loopSource };
    const loopConfigured = await appendWorkshopEvent({ ...loopScope, type: "agent_configured", title: marker,
      metadata: { receiptAuthority: "runtime", runtimeRunSnapshot: loopSnapshot } });
    await persistWorkRunRuntimeSnapshot(db, { ...loopScope, eventId: loopConfigured.id, snapshot: loopSnapshot });
    const loopSourceEvent = await appendWorkshopEvent({ ...loopScope, type: "source_checked", title: marker,
      metadata: { ...source.metadata, evidenceId: "synthetic-source", sourceVersion: version } });
    const loopCatalog = { ...catalogEntry, sourceIdentity: { ...catalogEntry.sourceIdentity, sourceEventId: loopSourceEvent.id } };
    await appendWorkshopEvent({ ...loopScope, type: "working_memory_updated", title: marker,
      metadata: { ...updated.metadata, runtimeBinding: loopBinding, applicabilityHash, evidenceCatalog: [loopCatalog],
        state: { facts: [{ text: marker + "_LOOP_ASSERTION", evidenceIds: ["read-1"] }], hypotheses: [],
          openQuestions: ["Which Loop source should be checked?"], nextAction: { text: "", evidenceIds: [] } } } });
    await appendWorkshopEvent({ ...loopScope, type: "working_memory_projected", title: marker,
      metadata: { ...projected.metadata, evidenceCatalog: [loopCatalog] } });
    await client`UPDATE loop_runs SET status='completed',completed_at=now() WHERE id=${ids.loopSource}`;
    const loopLoaded = await use(() => loadWorkingMemoryContinuity({ ...input, currentRunId: ids.loopCurrent,
      scope: { kind: "loop", loopId: ids.loop }, runtimeBinding: binding(ids.loopCurrent, { loopId: ids.loop }) }));
    assert.equal(loopLoaded.status, "inherited"); assert.equal(loopLoaded.checkpoint?.sourceRunId, ids.loopSource);
    assert.equal(loopLoaded.checkpoint?.loopId, ids.loop); assert.ok(loopLoaded.checkpoint?.history.facts.length);
    const foreignLoop = await loadWorkingMemoryContinuity({ ...input, currentRunId: ids.loopCurrent,
      scope: { kind: "loop", loopId: ids.otherLoop }, runtimeBinding: binding(ids.loopCurrent, { loopId: ids.otherLoop }) });
    assert.equal(foreignLoop.status, "skipped"); assert.equal(foreignLoop.checkpoint, null);
    await deleteBrainAccessGrant({ userId: owner, grantId }); grantId = undefined;
    const denied = await use(() => loadWorkingMemoryContinuity(input));
    assert.equal(denied.reason, "current_sources_unverified_questions_only");
    assert.deepEqual(denied.checkpoint?.history.facts, []); assert.equal(denied.checkpoint?.history.nextAction, null);
    assert.ok(!JSON.stringify(denied).includes(marker));
    const unknown = await loadWorkingMemoryContinuity({ ...input, verifySources: undefined });
    assert.equal(unknown.reason, "current_sources_unverified_questions_only");
    assert.ok(!JSON.stringify(unknown).includes(marker));
    assert.equal(BrainMemoryUpdateError, LegacyUpdateError);
    for (const snapshotType of ["memory_auto_update_policy", "memory_dependency_registry", "memory_dependency_change", "memory_correction_draft", "wechat_scenario_state"]) {
      await assert.rejects(() => createStateSnapshot({ userId: owner, scope: { type: "work", workId: ids.work }, snapshotType, content: {} }), LegacyUpdateError);
    }
    trigger = "t5_continuity_receipt_" + randomUUID().replaceAll("-", "");
    await client.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workshop_id='${ids.work}'::uuid AND NEW.type='working_memory_continuity_loaded' THEN RAISE EXCEPTION 'synthetic_t5_loaded_receipt_fault'; END IF; RETURN NEW; END $$`);
    await client.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    await assert.rejects(() => withDatabaseTransaction(async () => {
      await createStateSnapshot({ id: ids.failedSnapshot, userId: owner, scope: { type: "work", workId: ids.work }, snapshotType: "synthetic_t5_continuity", content: { marker } });
      await appendWorkshopEvent({ workshopId: ids.work, runId: ids.currentRun, type: "working_memory_continuity_loaded", title: marker,
        metadata: { receiptAuthority: "runtime", status: "skipped", reason: "synthetic_receipt_test" } });
    }));
    assert.equal((await client`SELECT id FROM brain_state_snapshots WHERE id=${ids.failedSnapshot}`).length, 0);
    return { saved: true, loaded: true, loadedReceipt: true, configurationAndScopeRejected: true, currentSourcePermissionsChecked: true,
      unknownSourcesQuestionsOnly: true, loopSavedAndLoaded: true, logicalLoopRunPreserved: true,
      snapshotOriginImmutable: true, reservedTypesProtected: true, receiptFailureRolledBack: true };
  } finally {
    if (trigger) { await client.unsafe(`DROP TRIGGER IF EXISTS ${trigger} ON workshop_events`); await client.unsafe(`DROP FUNCTION IF EXISTS ${trigger}()`); }
    if (grantId) await deleteBrainAccessGrant({ userId: owner, grantId });
    await client`DELETE FROM brain_memories WHERE id=${ids.memory} AND user_id=${owner}`;
    await client`DELETE FROM workshops WHERE id IN (${ids.work},${ids.otherWork}) AND user_id=${owner}`;
  }
}
