import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalHash } from "./lib/memory-continuity-verification.mjs";
import { boundedRetrySourceDelta, eligibleExternalFailure, exactCurrentCorrection, exactEvidenceCallBinding, exactFreshRetryCheckpoint, exactOriginalFailure, frozenSources, retryAllowedPaths, verifiedEvidenceExpansion } from "./verify-memory-continuity-followup.mjs";

const digest = text => createHash("sha256").update(text).digest("hex");
function fixture() {
  const oldId = "old-memory", id = "new-memory", version = "bmrv1:current";
  const request = { commandId: "owner-correct", expectedVersion: "bmrv1:old", operation: "correct", authority: "owner_statement",
    content: "exercise-only current policy with its complete scope and safety boundary", reason: "explicit owner correction", evidenceRefs: [] };
  const correction = { request, expectedVersion: version, result: { newMemory: { id } }, afterNew: { memory: { metadata: { revision: { observationId: "owner-observation" } } } } };
  const context = { memoryRecall: { backend: "brain", contextPack: { selected: [{ id, revisionVersion: version }] } },
    memoryContext: { taskRelevantMemories: [{ id, revisionVersion: version, content: request.content }] } };
  const content = JSON.stringify({ memoryId: oldId, request });
  const evidence = { status: "read", provider: "workshop_memory_evidence", memoryBackend: "brain",
    memory: { id, expectedVersion: version, revisionVersion: version, content: request.content }, brainEvidence: [{ id: "brain-observation:owner-observation", status: "resolved",
      source: "brain_observation", content, metadata: { sourceType: "owner_memory_revision", sourceId: request.commandId, contentHash: digest(content),
        provenance: { provesOwnerSubmissionOnly: true, independentlyVerifiesBusinessFact: false } } }],
    evidenceResolution: [{ id: "brain-observation:owner-observation", status: "resolved", provider: "brain_observation" }] };
  return { oldId, correction, context, evidence };
}

test("current correction requires exact full body, current identity and version", () => {
  const f = fixture(); assert.equal(exactCurrentCorrection(f.context, f.correction, f.oldId), true);
});
test("current correction rejects the real truncated-body failure pattern", () => {
  const f = fixture(); f.context.memoryContext.taskRelevantMemories[0].content = "exercise-only current... [truncated 40 chars]";
  assert.equal(exactCurrentCorrection(f.context, f.correction, f.oldId), false);
});
test("current correction rejects an otherwise exact stale revision", () => {
  const f = fixture(); f.context.memoryContext.taskRelevantMemories[0].revisionVersion = "bmrv1:old";
  assert.equal(exactCurrentCorrection(f.context, f.correction, f.oldId), false);
});
test("current correction rejects old memory included alongside replacement", () => {
  const f = fixture(); f.context.memoryRecall.contextPack.selected.push({ id: f.oldId });
  assert.equal(exactCurrentCorrection(f.context, f.correction, f.oldId), false);
});
for (const [name, mutate] of [
  ["stale selected receipt revision", f => { f.context.memoryRecall.contextPack.selected[0].revisionVersion = "bmrv1:old"; }],
  ["missing selected receipt revision", f => { delete f.context.memoryRecall.contextPack.selected[0].revisionVersion; }],
  ["duplicate contradictory selected identities", f => { f.context.memoryRecall.contextPack.selected.push({ id: "new-memory", revisionVersion: "bmrv1:old" }); }],
]) test(`current correction rejects ${name}`, () => {
  const f = fixture(); mutate(f); assert.equal(exactCurrentCorrection(f.context, f.correction, f.oldId), false);
});
test("original failed review must keep exactly the two original body failures", () => {
  const review = { schemaVersion: "memory-continuity-independent-review.v1", status: "failed", mechanismPassed: false, modelUsePassed: true,
    checks: ["C", "D"].map(name => ({ name: `${name}: exact corrected body and current version supplied`, passed: false })) };
  assert.equal(exactOriginalFailure(review), true);
  assert.equal(exactOriginalFailure({ ...review, status: "verified" }), false);
  assert.equal(exactOriginalFailure({ ...review, checks: [...review.checks, { name: "another failure", passed: false }] }), false);
});
test("evidence repair needs exact typed owner submission and complete current memory", () => {
  const f = fixture(); assert.equal(verifiedEvidenceExpansion(f.evidence, f.correction, f.oldId), true);
});
for (const [name, mutate] of [
  ["wrong current memory ID", f => { f.evidence.memory.id = "other-memory"; }],
  ["wrong current version", f => { f.evidence.memory.expectedVersion = "bmrv1:old"; }],
  ["contradictory current version pair", f => { f.evidence.memory.revisionVersion = "bmrv1:old"; }],
  ["missing current revision version", f => { delete f.evidence.memory.revisionVersion; }],
  ["truncated memory body", f => { f.evidence.memory.content = "exercise-only current..."; }],
  ["foreign typed observation", f => { f.evidence.brainEvidence[0].id = "brain-observation:foreign"; }],
  ["altered observation hash", f => { f.evidence.brainEvidence[0].metadata.contentHash = "wrong"; }],
  ["wrong correction command", f => { f.evidence.brainEvidence[0].metadata.sourceId = "other-command"; }],
  ["fabricated business fact authority", f => { f.evidence.brainEvidence[0].metadata.provenance.independentlyVerifiesBusinessFact = true; }],
  ["unresolved observation", f => { f.evidence.evidenceResolution[0].status = "unresolved"; }],
  ["body/hash changed consistently but different owner request", f => {
    const content = JSON.stringify({ memoryId: f.oldId, request: { ...f.correction.request, content: "different policy" } });
    f.evidence.brainEvidence[0].content = content; f.evidence.brainEvidence[0].metadata.contentHash = digest(content);
  }],
]) test(`evidence repair rejects ${name}`, () => {
  const f = fixture(); mutate(f); assert.equal(verifiedEvidenceExpansion(f.evidence, f.correction, f.oldId), false);
});
test("evidence request must bind actual assistant and runtime requested memory IDs", () => {
  const call = { id: "call-evidence", function: { name: "workshopGetMemoryEvidence", arguments: JSON.stringify({ memoryId: "new-memory" }) } };
  const event = { type: "tool_call", body: JSON.stringify({ memoryId: "new-memory", maxEvents: 10 }),
    metadata: { runtimeTrace: true, toolUseId: "call-evidence", toolName: "workshopGetMemoryEvidence" } };
  assert.equal(exactEvidenceCallBinding(call, event, "new-memory"), true);
  assert.equal(exactEvidenceCallBinding({ ...call, function: { ...call.function, arguments: JSON.stringify({ memoryId: "old-memory" }) } }, event, "new-memory"), false);
  assert.equal(exactEvidenceCallBinding(call, { ...event, body: JSON.stringify({ memoryId: "other-memory" }) }, "new-memory"), false);
  assert.equal(exactEvidenceCallBinding(call, { ...event, metadata: { ...event.metadata, toolUseId: "another-call" } }, "new-memory"), false);
});
test("source freeze excludes evaluation code while retaining both runtime fixes", () => {
  assert.deepEqual(frozenSources({ "apps/web/scripts/verify-memory-continuity.mjs": "old-evaluator",
    "apps/web/scripts/verify-memory-continuity-followup.mjs": "new-evaluator", "apps/web/lib/loops/context-window.ts": "context-fix",
    "apps/web/lib/workshops/memory-evidence-reader.ts": "evidence-fix", "apps/web/scripts/prove-memory-continuity.ts": "runner" }),
  { "apps/web/lib/loops/context-window.ts": "context-fix", "apps/web/lib/workshops/memory-evidence-reader.ts": "evidence-fix",
    "apps/web/scripts/prove-memory-continuity.ts": "runner" });
});

function externalFailure() {
  return { round: "E", failure: null, result: { loopRunId: "failed-E", result: { status: "error", error: "Streaming response failed: [data_inspection_failed] <400>" } },
    providerRequests: [{ responseStatus: 200, error: null }], events: [{ type: "tool_error", body: "[data_inspection_failed]" }],
    after: { state: { stateJson: { lastLoopRunId: "failed-E", lastJobStatus: "error", lastOutcomeAction: "fail", lastAttemptsUsed: 1 } } } };
}
test("bounded retry recognizes transport-200 with actual external stream failure", () => {
  assert.equal(eligibleExternalFailure(externalFailure()), true);
});
for (const [name, mutate] of [
  ["HTTP 200 alone", f => { f.result.result.status = "success"; }],
  ["unrelated provider error", f => { f.result.result.error = "Request timed out"; }],
  ["missing runtime error receipt", f => { f.events = []; }],
  ["multiple domain attempts", f => { f.after.state.stateJson.lastAttemptsUsed = 2; }],
  ["another round", f => { f.round = "F"; }],
  ["HTTP request failure", f => { f.providerRequests[0].responseStatus = 401; }],
]) test(`bounded retry rejects ${name}`, () => {
  const f = externalFailure(); mutate(f); assert.equal(eligibleExternalFailure(f), false);
});

test("bounded source repair includes all approved runtime changes", () => {
  const delta = retryAllowedPaths.map(path => ({ path, beforeHash: path.endsWith("memory-recall-risk.ts") ? null : "before", afterHash: "after" }));
  assert.equal(boundedRetrySourceDelta(delta), true);
  assert.equal(boundedRetrySourceDelta(delta.filter(item => !item.path.endsWith("context-window.ts"))), false);
  assert.equal(boundedRetrySourceDelta([...delta, { path: "apps/web/lib/loops/tool-gate.ts", beforeHash: "before", afterHash: "after" }]), false);
  assert.equal(boundedRetrySourceDelta(delta.map(item => item.path.endsWith("memory-recall-risk.ts") ? { ...item, beforeHash: "changed-existing-risk-code" } : item)), false);
});

function freshCheckpoint() {
  const event = { id: "E2-update", type: "working_memory_updated", seq: 10, createdAt: "2026-10-16T08:00:00.000Z",
    metadata: { receiptAuthority: "runtime", mode: "apply", status: "ready_for_projection", version: 1,
      policyIdentity: { version: "policy-v1", hash: "hash" }, state: { openQuestions: ["current question"] } } };
  const previous = { before: { workshopId: "work" }, result: { loopRunId: "E2-run" }, events: [event] };
  const expiresAt = "2026-10-23T08:00:00.000Z";
  const checkpoint = { sourceRunId: "E2-run", checkpointEventId: event.id, version: 1, policyIdentity: event.metadata.policyIdentity,
    createdAt: event.createdAt, expiresAt, history: { openQuestions: ["current question"] },
    chain: { depth: 0, viaRunIds: [], assertionsSuppressed: true, rootHash: canonicalHash({ workshopId: "work", sourceRunId: "E2-run", checkpointEventId: event.id, metadata: event.metadata, expiresAt }) } };
  return { previous, checkpoint };
}
test("F must bind exact fresh E2 accepted state and its independent root hash", () => {
  const f = freshCheckpoint(); assert.equal(exactFreshRetryCheckpoint(f.checkpoint, f.previous), true);
});
for (const [name, mutate] of [
  ["D ancestry with E2 in chain", f => { f.checkpoint.sourceRunId = "D-run"; f.checkpoint.chain = { ...f.checkpoint.chain, depth: 1, viaRunIds: ["E2-run"] }; }],
  ["wrong checkpoint event", f => { f.checkpoint.checkpointEventId = "older-update"; }],
  ["wrong notebook version", f => { f.checkpoint.version = 2; }],
  ["forged root hash", f => { f.checkpoint.chain.rootHash = "forged"; }],
  ["changed question", f => { f.checkpoint.history.openQuestions = ["old question"]; }],
  ["later clear", f => { f.previous.events.push({ id: "clear", type: "working_memory_restored", seq: 11, metadata: { receiptAuthority: "runtime" } }); }],
]) test(`F fresh retry checkpoint rejects ${name}`, () => {
  const f = freshCheckpoint(); mutate(f); assert.equal(exactFreshRetryCheckpoint(f.checkpoint, f.previous), false);
});
