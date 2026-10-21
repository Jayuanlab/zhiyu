import test from "node:test";
import assert from "node:assert/strict";
import { canonicalHash, same, inputTextParts, continuityFromPayload, verifyDispatchOrder, verifyPromotion, verifyReview, verifyCorrection } from "./memory-continuity-verification.mjs";

const copy = value => structuredClone(value);
const ownerId = "11111111-1111-4111-a111-111111111111", workshopId = "22222222-2222-4222-a222-222222222222";
const loopId = "33333333-3333-4333-a333-333333333333", runId = "44444444-4444-4444-a444-444444444444";
const policyIdentity = { version: "memory.v1", hash: "a".repeat(64) };
function fixture() {
  const source = { id: "55555555-5555-4555-a555-555555555555", seq: 1, type: "source_checked", workshopId, loopId, loopRunId: runId,
    metadata: { receiptAuthority: "runtime", ok: true, toolName: "webReadPage", toolUseId: "call_1", evidenceId: "evidence-1", contentHash: "b".repeat(64), offset: 0, contentLength: 100, totalChars: 100, provider: "test-reader" } };
  const catalog = [{ toolCallId: "call_1", toolName: "webReadPage", referenceEligible: true, sourceIdentityStatus: "reported", contentHash: "c".repeat(64),
    sourceIdentity: { sourceEventId: source.id, evidenceId: "evidence-1", contentHash: "b".repeat(64), offset: 0, contentLength: 100, totalChars: 100 } }];
  const checkpoint = { id: "66666666-6666-4666-a666-666666666666", seq: 2, type: "working_memory_updated", metadata: { receiptAuthority: "runtime", mode: "apply", status: "ready_for_projection", version: 1, policyIdentity,
    state: { facts: [], hypotheses: [{ key: "acceptance.policy", text: "Exercise-only observation", evidenceIds: ["call_1"] }] }, evidenceCatalog: catalog } };
  const prepared = { id: "77777777-7777-4777-a777-777777777777", seq: 3, type: "working_memory_projected", metadata: { receiptAuthority: "runtime", status: "provider_request_prepared", version: 1, policyIdentity, evidenceCatalog: copy(catalog) } };
  const command = { runKind: "loop", loopId, runId, noteKey: "acceptance.policy", expectedVersion: 1, commandId: "promote-1" };
  const identity = { runKind: "loop", loopId, runId };
  const sources = [{ toolCallId: "call_1", sourceEventId: source.id, evidenceId: "evidence-1", contentHash: "b".repeat(64), sourceVersion: `sha256:${"b".repeat(64)}`, sourceVersionKind: "content_hash",
    span: { offset: 0, contentLength: 100, totalChars: 100 }, provider: "test-reader", detail: null, warningCodes: [], warningTexts: [], finalUrlVerified: false }];
  const h = canonicalHash(["working-memory-promotion.v1", ownerId, workshopId, identity, command.noteKey, "hypothesis", "Exercise-only observation", sources]);
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  const memory = { id, userId: ownerId, scope: { type: "work", workId: workshopId }, ownerType: "work", ownerId: workshopId,
    memoryType: "insight", subject: "Fixture / acceptance.policy", content: "Exercise-only observation", status: "candidate", confidence: 25,
    evidenceRefs: [source.id], tags: [], metadata: { workingMemoryPromotion: { source: "working-memory-promotion.v1", authority: "model-authored-unverified", category: "hypothesis", commandId: command.commandId,
      runIdentity: identity, requestHash: canonicalHash([identity, command.noteKey, 1]), expectedVersion: 1, checkpointEventId: checkpoint.id,
      projectionEventId: prepared.id, policyIdentity, sources } } };
  const receipt = { type: "working_memory_promoted", metadata: { commandId: command.commandId, candidateId: id, status: "candidate", version: 1,
    checkpointEventId: checkpoint.id, projectionEventId: prepared.id, noteKey: command.noteKey, runIdentity: identity, sourceEventIds: [source.id] } };
  return { ownerId, workshopId, loopId, initial: { result: { loopRunId: runId }, events: [source, checkpoint, prepared], providerRequests: [{ kind: "working-memory-agent",
    hostPrepared: { eventId: prepared.id, seq: prepared.seq, version: 1 }, responseStatus: 200, error: null }] },
    promotion: { command, result: { candidateId: id, status: "candidate" }, memory: { memory }, events: [receipt] } };
}

test("canonical comparison is independent of object key order, exact on content", () => {
  assert.equal(same({ a: 1, b: [2] }, { b: [2], a: 1 }), true);
  assert.equal(same({ a: 1 }, { a: "1" }), false);
});
test("history is parsed from host user input, not an assistant echo or loose ID mention", () => {
  const history = { schemaVersion: "working-memory-continuity.v1", checkpoint: { id: "a", history: { facts: ["quote { x }"] } } };
  const marker = "历史工作检查点（未核实，仅同一连续任务的接续材料）：";
  const payload = { messages: [{ role: "user", content: `${marker}\n${JSON.stringify(history)}\nEND` }] };
  assert.deepEqual(continuityFromPayload(payload), [history]);
  assert.deepEqual(continuityFromPayload({ messages: [{ role: "assistant", content: payload.messages[0].content }] }), []);
  assert.deepEqual(inputTextParts({ messages: [{ role: "tool", content: "spoof" }] }), []);
  assert.equal(same(history, { ...history, checkpoint: { ...history.checkpoint, id: "different" } }), false);
});
test("exact promotion fixture passes without calling the implementation", () => assert.equal(verifyPromotion(fixture()).passed, true));
for (const [label, mutate] of [
  ["body", f => { f.promotion.memory.memory.content = "Changed conclusion"; }],
  ["category", f => { f.promotion.memory.memory.memoryType = "fact"; }],
  ["key", f => { f.promotion.command.noteKey = "another.key"; }],
  ["version", f => { f.promotion.command.expectedVersion = 2; }],
  ["catalog snapshot hash", f => { f.initial.events[2].metadata.evidenceCatalog[0].sourceIdentity.contentHash = "d".repeat(64); }],
  ["source window", f => { f.initial.events[0].metadata.offset = 1; }],
  ["already reviewed candidate", f => { f.promotion.memory.memory.status = "verified"; }],
  ["owner", f => { f.promotion.memory.memory.userId = "other-owner"; }],
]) test(`promotion rejects tampered ${label}`, () => { const f = fixture(); mutate(f); assert.equal(verifyPromotion(f).passed, false); });
test("review preserves the exact owner/body/evidence and candidate fence", () => {
  const expected = fixture().promotion.memory.memory, after = { ...copy(expected), status: "verified" };
  const review = { request: { requester: { type: "chat", userId: ownerId }, memoryId: expected.id, expectedVersion: "version-1", evidenceConfirmed: true, reason: "Checked source", decision: "confirmed" },
    before: { expectedVersion: "version-1", memory: copy(expected) }, after: { memory: after }, result: copy(after) };
  assert.equal(verifyReview(review, expected), true);
  review.after.memory.content = "Mutated during review";
  assert.equal(verifyReview(review, expected), false);
});
test("dispatch requires persisted preparation before transmission and the matching result", () => {
  const prepared = { id: "prepared-1", seq: 2, createdAt: "2026-10-16T00:00:00.000Z", type: "working_memory_projected", workshopId, loopId, loopRunId: runId,
    metadata: { receiptAuthority: "runtime", status: "provider_request_prepared", version: 1, policyIdentity } };
  const usage = { id: "usage-1", seq: 4, createdAt: "2026-10-16T00:00:02.000Z", type: "working_memory_usage",
    metadata: { receiptAuthority: "runtime", invocation: 1, version: 1, model: "real-model", policyIdentity } };
  const round = { before: { workshopId, loopId }, result: { loopRunId: runId }, events: [prepared, usage], providerRequests: [{ index: 1, kind: "working-memory-agent", model: "real-model", responseStatus: 200, error: null,
    dispatchedAt: "2026-10-16T00:00:01.000Z", hostPrepared: { eventId: prepared.id, seq: 2, loopRunId: runId, createdAt: prepared.createdAt, version: 1, policyIdentity } }] };
  assert.equal(verifyDispatchOrder(round).passed, true);
  round.providerRequests[0].dispatchedAt = "2026-10-15T23:59:59.000Z";
  assert.equal(verifyDispatchOrder(round).passed, false);
  round.providerRequests[0].dispatchedAt = "2026-10-16T00:00:01.000Z";
  round.providerRequests[0].error = "TimeoutError";
  assert.equal(verifyDispatchOrder(round).passed, false);
});
test("correction requires the request's exact new body and replacement lineage", () => {
  const original = fixture().promotion.memory.memory, newId = "88888888-8888-4888-a888-888888888888";
  const replacement = { ...copy(original), id: newId, content: "Corrected exercise", status: "active", supersedes: [original.id],
    metadata: { revision: { commandId: "correct-1", previousMemoryId: original.id } } };
  const correction = { request: { commandId: "correct-1", expectedVersion: "version-1", operation: "correct", authority: "owner_statement", content: replacement.content },
    before: { expectedVersion: "version-1", memory: copy(original) },
    afterOld: { memory: { ...copy(original), status: "superseded", metadata: { revisionRetired: { nextMemoryId: newId } } } }, afterNew: { memory: copy(replacement) },
    result: { commandId: "correct-1", oldMemory: copy(original), newMemory: copy(replacement), receipt: { oldMemoryId: original.id, newMemoryId: newId } } };
  assert.equal(verifyCorrection(correction, original), true);
  correction.afterNew.memory.content = "Invented third version";
  assert.equal(verifyCorrection(correction, original), false);
});
