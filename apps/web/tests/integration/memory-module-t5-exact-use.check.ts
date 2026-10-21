import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { seedMemoryModuleT4Fixture } from "./memory-module-t4.check";
import { readWorkshopMemoryEvidence } from "@/lib/workshops/memory-evidence-reader";
import { listBrainMemoriesForUser, listBrainSnapshotsForUser } from "@/lib/ai/brain-read-tools";
import { createObservation } from "@/lib/memory/ingestion/observations";
import { createStateSnapshot } from "@/lib/memory/continuity/state-snapshots";
import { createBrainAccessGrant, deleteBrainAccessGrant } from "@/lib/memory/governance/access-grants";
import { getMemoryById } from "@/lib/memory/adapters/postgres/memory-records";
import { createOwnerMemoryClient } from "@/lib/memory";
import { getBrainMemoryRevisionVersion } from "@/lib/memory/revision/version";
import { withMemoryDispatchContext, bindMemoryDispatchRuntime, assertMemoryDispatchCurrent } from "@/lib/memory/context/dispatch";
import { createPiAgentRuntime } from "@openzhiyu/ai/agent/runtime";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { readPlatformRecordForOwner } from "@/lib/ai/platform-record-reader";
import { withExactUseReaderPolicy } from "@/lib/memory/context/exact-use";
import { admitExactUse } from "@/lib/memory/context/exact-use-admission";
import { saveUploadedArtifact, cleanupArtifact, readArtifactCurrent } from "@/lib/memory/artifacts/service";
import { createNativePiWebChatTools, createNativePiWebChatToolDefinitions } from "@/lib/ai/native-pi-web-chat-tools";

/** Real isolated PG only. Local faux transport exercises the actual Pi hook;
 * no model, network endpoint or ordinary application database is used. */
export async function checkMemoryModuleT5ExactUse(client: postgres.Sql, owner: string) {
  const database = String((await client`SELECT current_database() AS name`)[0].name);
  assert.match(database, /^zhiyu_test_[a-f0-9]{32}$/);
  assert.equal(new URL(process.env.ZHIYU_TEST_DATABASE_URL ?? "").pathname, `/${database}`);
  const fixture = await seedMemoryModuleT4Fixture(client, owner), checks: string[] = [];
  const workshop = { id: fixture.workId, userId: owner,
    modelConfig: { memoryApplicability: { schemaVersion: "memory-applicability.v1", scenarioKeys: [fixture.alpha] } } };
  const observation = await createObservation({ userId: owner, sourceType: "owner_memory_revision", sourceId: randomUUID(),
    observedAt: new Date(), content: `${fixture.marker} T5_EXACT_OBSERVATION`, trustLevel: "owner_assertion", metadata: { memoryId: fixture.ids.own } });
  await client`UPDATE brain_memories SET evidence_refs=${JSON.stringify([`brain-observation:${observation.id}`])}::jsonb WHERE id=${fixture.ids.own} AND user_id=${owner}`;
  const snapshot = await createStateSnapshot({ userId: owner, scope: { type: "work", workId: fixture.workId }, snapshotType: "work_state",
    content: { state: `${fixture.marker} T5_EXACT_SNAPSHOT` }, sourceMemoryIds: [fixture.ids.own] });
  const auditCount = async () => Number((await client`SELECT count(*)::int AS n FROM brain_context_logs
    WHERE user_id=${owner} AND metadata->>'source'='memory_exact_use_dispatch'`)[0].n);
  function runtime() {
    const faux = createFauxCore({}); let calls = 0;
    const agent = createPiAgentRuntime({ adapter: "harness", model: faux.getModel(), streamFn: async (...args) => {
      calls++; return faux.streamSimple(...args);
    } });
    async function request(prompt = "Use only the previously read synthetic evidence") {
      faux.setResponses([fauxAssistantMessage("synthetic local response")]);
      const messages = [];
      for await (const message of agent.run({ operation: "run", prompt,
        options: { onBeforeProviderRequest: assertMemoryDispatchCurrent } })) messages.push(message);
      return messages.find(message => message.type === "runtime_terminal")?.runtimeTerminal?.status;
    }
    return { agent, request, calls: () => calls };
  }
  async function blockAfter(read: () => Promise<void | string>, mutate: () => Promise<unknown>) {
    await withMemoryDispatchContext(async () => {
      const provider = runtime(); bindMemoryDispatchRuntime(provider.agent.metadata);
      const body = await read(); const prompt = typeof body === "string" ? body : undefined;
      const before = await auditCount(); assert.equal(await provider.request(prompt), "completed");
      assert.equal(provider.calls(), 1); assert.ok(await auditCount() > before);
      const committed = await auditCount(); await mutate();
      assert.equal(await provider.request(prompt), "failed"); assert.equal(provider.calls(), 1, "Changed evidence must not reach even the local transport");
      assert.equal(await auditCount(), committed, "Failed admission cannot leave a partial successful audit batch");
      await assert.rejects(assertMemoryDispatchCurrent(), { code: "memory_dispatch_context_unavailable" });
    });
  }
  const readOwn = async () => {
    const result = await readWorkshopMemoryEvidence({ workshop, memoryId: fixture.ids.own }); assert.equal(result.status, "read");
    if (result.status !== "read") throw Error("Synthetic exact Work read unavailable");
    assert.equal(result.memoryBackend, "brain"); assert.equal(result.brainEvidence[0]?.content, observation.content);
    assert.ok(result.sourceIdentity?.sourceVersion.startsWith("bmrv1:"));
  };
  await blockAfter(readOwn, async () => {
    const before = await getMemoryById({ userId: owner, memoryId: fixture.ids.own }); assert.ok(before);
    const result = await createOwnerMemoryClient(owner).submit({ kind: "memory.revise", commandId: randomUUID(), memoryId: before.id,
      expectedVersion: getBrainMemoryRevisionVersion(before), operation: "correct", authority: "owner_statement",
      content: `${fixture.marker} T5_REAL_OWNER_CORRECTION`, reason: "Synthetic exact-use revision test", evidenceRefs: [fixture.evidenceRef] });
    assert.equal(result.status, "recorded");
  });
  checks.push("Actual independent Work canonical+observation read without recall registers real versions; a committed owner correction blocks the next Pi request and rolls back its audit batch");
  // The old source remains an authorized historical revision. It still carries
  // the fixed observation provenance, independently checked on the next request.
  await blockAfter(readOwn, () => client`UPDATE brain_observations SET content=content||' CHANGED_SYNTHETIC_SOURCE' WHERE id=${observation.id} AND user_id=${owner}`);
  checks.push("Independent observation body/version changes block later dispatch even when its parent remains readable history");
  await blockAfter(async () => {
    const result = await listBrainSnapshotsForUser({ userId: owner, workId: fixture.workId, snapshotId: snapshot.id });
    assert.equal(result.ok, true); assert.match(result.text, /T5_EXACT_SNAPSHOT/);
  }, () => client`UPDATE brain_state_snapshots SET content=${JSON.stringify({ state: "changed synthetic snapshot" })}::jsonb WHERE id=${snapshot.id} AND user_id=${owner}`);
  checks.push("The real exact snapshot window reader registers ssrv1; same-ID content replacement cannot silently refresh an old transcript proof");
  await blockAfter(async () => {
    const result = await readPlatformRecordForOwner({ userId: owner, source: "brainObservations", id: observation.id });
    assert.equal(result.status, "read"); if (result.status !== "read") throw Error("Synthetic published observation read unavailable");
    assert.match(result.content, /CHANGED_SYNTHETIC_SOURCE/);
  }, () => client`UPDATE brain_observations SET metadata=${JSON.stringify({ memoryId: fixture.ids.own, syntheticRevision: 2 })}::jsonb WHERE id=${observation.id} AND user_id=${owner}`);
  await withMemoryDispatchContext(async () => {
    bindMemoryDispatchRuntime({ engine: "pi", adapter: "pi-agent-harness" });
    for (const [source, id] of [["brainMemories", fixture.ids.own], ["brainStateSnapshots", snapshot.id]] as const) {
      assert.equal((await readPlatformRecordForOwner({ userId: owner, source, id })).status, "read");
    }
    await assertMemoryDispatchCurrent();
    await assert.rejects(withExactUseReaderPolicy({ requester: { type: "work", userId: owner, id: fixture.workId }, purpose: "synthetic_platform_read" }, () =>
      readPlatformRecordForOwner({ userId: owner, source: "brainMemories", id: fixture.ids.own })), { code: "memory_exact_use_unavailable" });
  });
  checks.push("The actual platform-record SQL gateway compares its published physical projection, registers all three source versions and rejects Work use of owner-only projections");
  const grant = await createBrainAccessGrant({ userId: owner, subjectType: "work", subjectId: fixture.workId,
    scope: { type: "work", workId: fixture.sourceWorkId }, permissions: ["reference"], memoryTypes: ["insight"] });
  await blockAfter(async () => {
    const result = await readWorkshopMemoryEvidence({ workshop, memoryId: fixture.ids.shared }); assert.equal(result.status, "read", JSON.stringify(result));
  }, () => deleteBrainAccessGrant({ userId: owner, grantId: grant.id }));
  checks.push("Actual grant revocation blocks an independently read cross-Work canonical source without owner-wide fallback");
  await blockAfter(async () => {
    const result = await listBrainMemoriesForUser({ userId: owner, ownerType: "work", ownerId: fixture.workId, statuses: ["candidate"], limit: 1 });
    assert.equal(result.ok, true); assert.match(result.text, /CANDIDATE_BODY_NOT_ACTIVE/);
  }, () => client`UPDATE brain_memories SET expires_at='2000-01-01T00:00:00Z' WHERE id=${fixture.ids.candidate} AND user_id=${owner}`);
  checks.push("Actual owner canonical inspection registers candidate versions; expiry prevents later model consumption");
  await blockAfter(async () => {
    assert.equal((await listBrainSnapshotsForUser({ userId: owner, workId: fixture.workId, snapshotId: snapshot.id })).ok, true);
  }, () => client`UPDATE workshops SET model_config=${JSON.stringify({ memoryApplicability: { schemaVersion: "memory-applicability.v1", scenarioKeys: [fixture.beta] } })}::jsonb WHERE id=${fixture.workId} AND user_id=${owner}`);
  await client`UPDATE workshops SET model_config=${JSON.stringify(workshop.modelConfig)}::jsonb WHERE id=${fixture.workId} AND user_id=${owner}`;
  checks.push("Current saved Work binding is SHARE-checked again; changing binding blocks a previously read unchanged snapshot before the next provider call");
  await withMemoryDispatchContext(async () => {
    bindMemoryDispatchRuntime({ engine: "pi", adapter: "pi-agent-harness" });
    const denied = await readWorkshopMemoryEvidence({ workshop, memoryId: fixture.ids.beta });
    assert.equal(denied.status, "unavailable"); assert.ok(!JSON.stringify(denied).includes(fixture.bodies.beta));
  });
  const crossGrant = await createBrainAccessGrant({ userId: owner, subjectType: "work", subjectId: fixture.workId,
    scope: { type: "work", workId: fixture.otherWorkId }, permissions: ["reference"], memoryTypes: ["insight"] });
  try {
    await withMemoryDispatchContext(async () => {
      bindMemoryDispatchRuntime({ engine: "pi", adapter: "pi-agent-harness" });
      const denied = await readWorkshopMemoryEvidence({ workshop, memoryId: fixture.ids.beta });
      assert.equal(denied.status, "unavailable"); assert.ok(!JSON.stringify(denied).includes(fixture.bodies.beta), "A grant cannot bypass the actual Work scenario binding");
    });
  } finally { await deleteBrainAccessGrant({ userId: owner, grantId: crossGrant.id }); }
  await withMemoryDispatchContext(async () => {
    bindMemoryDispatchRuntime({ engine: "claude", adapter: "claude-agent-sdk" });
    const result = await listBrainSnapshotsForUser({ userId: owner, snapshotId: snapshot.id }); assert.equal(result.ok, false);
    assert.ok(!result.text.includes("changed synthetic snapshot"));
  });
  checks.push("Cross-Work grants do not override saved scenario binding; unsupported runtimes withhold exact snapshot bodies before returning a tool result");
  const trigger = `reject_t5_exact_${randomUUID().replaceAll("-", "")}`;
  await client.unsafe(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${owner}'::uuid AND NEW.metadata->>'source'='memory_exact_use_dispatch' THEN RAISE EXCEPTION 'injected synthetic exact admission audit failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${trigger} BEFORE INSERT ON brain_context_logs FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  try {
    await withMemoryDispatchContext(async () => {
      const provider = runtime(); bindMemoryDispatchRuntime(provider.agent.metadata);
      assert.equal((await listBrainSnapshotsForUser({ userId: owner, snapshotId: snapshot.id })).ok, true);
      const count = await auditCount(); assert.equal(await provider.request(), "failed"); assert.equal(provider.calls(), 0); assert.equal(await auditCount(), count);
    });
  } finally { await client.unsafe(`DROP TRIGGER ${trigger} ON brain_context_logs`); await client.unsafe(`DROP FUNCTION ${trigger}()`); }
  checks.push("A real PG audit trigger failure causes zero local provider calls and no partial dispatch receipt");
  assert.match(process.env.MEMORY_ARTIFACT_STORAGE_ROOT ?? "", /[\\/]\.runtime[\\/]memory-module-t[567][\\/][^\\/]+[\\/]private-objects$/);
  const bytes = new TextEncoder().encode(`${fixture.marker} T5_PRIVATE_ARTIFACT_\u{1f600}_ORIGINAL`);
  const artifact = await saveUploadedArtifact(owner, { commandId: randomUUID(), name: "T5-exact-model-reader.txt", contentType: "text/plain", data: bytes, saveRecord: false });
  const artifactTool = () => createNativePiWebChatTools({ userId: owner, policy: { allowedTools: ["getMemoryArtifact"] } })
    .find(tool => tool.name === "getMemoryArtifact")!;
  const current = await readArtifactCurrent(owner, { artifactId: artifact.manifest.id }); assert.equal(current.status, "ok");
  if (current.status !== "ok") throw Error("Synthetic artifact metadata unavailable");
  await withMemoryDispatchContext(async () => {
    bindMemoryDispatchRuntime({ engine: "pi", adapter: "pi-agent-harness" });
    await assert.rejects(admitExactUse({ requester: { type: "chat", userId: owner }, accessMode: "owner_override", purpose: "synthetic_metadata_not_evidence",
      artifacts: [{ id: artifact.manifest.id, revision: artifact.ref.revision, evidenceReceiptId: current.receipt.id, start: 0, end: 0 }] }), { code: "memory_exact_use_unavailable" });
  });
  const foreignTool = createNativePiWebChatTools({ userId: fixture.foreignOwner, policy: { allowedTools: ["getMemoryArtifact"] } }).find(tool => tool.name === "getMemoryArtifact")!;
  const hidden = await foreignTool.execute("foreign-artifact", { artifactId: artifact.manifest.id });
  assert.ok(!JSON.stringify(hidden).includes("T5_PRIVATE_ARTIFACT")); assert.match(JSON.stringify(hidden), /artifact_not_found/);
  const workTool = createNativePiWebChatToolDefinitions({ userId: owner, memoryWorkId: fixture.workId }).find(tool => tool.name === "getMemoryArtifact")!;
  await assert.rejects(async () => workTool.execute({ artifactId: artifact.manifest.id }, { toolCallId: "work-artifact" }), { status: 403, code: "memory_owner_context_required" });
  const readTrigger = `reject_t5_artifact_model_read_${randomUUID().replaceAll("-", "")}`;
  await client.unsafe(`CREATE FUNCTION ${readTrigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${owner}'::uuid AND NEW.artifact_id='${artifact.manifest.id}'::uuid AND NEW.purpose='evidence' THEN RAISE EXCEPTION 'injected synthetic artifact evidence receipt failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${readTrigger} BEFORE INSERT ON memory_artifact_read_receipts FOR EACH ROW EXECUTE FUNCTION ${readTrigger}()`);
  try {
    await withMemoryDispatchContext(async () => {
      bindMemoryDispatchRuntime({ engine: "pi", adapter: "pi-agent-harness" });
      const count = await auditCount(), response = await artifactTool().execute("artifact-read-receipt-fault", { artifactId: artifact.manifest.id });
      assert.ok(!JSON.stringify(response).includes("T5_PRIVATE_ARTIFACT")); assert.match(JSON.stringify(response), /memory_read_unavailable/);
      assert.equal(await auditCount(), count);
    });
  } finally { await client.unsafe(`DROP TRIGGER ${readTrigger} ON memory_artifact_read_receipts`); await client.unsafe(`DROP FUNCTION ${readTrigger}()`); }
  await blockAfter(async () => {
    const result = await artifactTool().execute("managed-artifact-read", { url: `/api/files/${artifact.manifest.id}`, maxBytes: 4096 });
    const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    assert.match(text, /T5_PRIVATE_ARTIFACT/); assert.match(text, /\"purpose\":\"evidence\"/); return text;
  }, () => cleanupArtifact(owner, { kind: "artifact.cleanup", commandId: randomUUID(), artifactId: artifact.manifest.id, expectedRevision: artifact.manifest.revision }));
  checks.push("Actual Chat getMemoryArtifact reads private text without recall and registers a persisted evidence receipt; cleanup blocks its second Pi request, current-only receipt/foreign owner/Work capability/read-receipt failure cannot expose its body");
  return { name: "T5 independent exact-source dispatch admission", passed: true, databaseScope: "synthetic_isolated", checks,
    limits: ["Local faux Pi transport only; no external model calls", "Managed artifact text only; binary content, legacy workspace/RAG paths and independent domain/event sources are not implied to have these proofs",
      "Permission lookup outage is injected at the DAO seam in unit tests; this PG helper tests real grant revocation without renaming shared tables"] };
}
