import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalHash } from "./lib/memory-continuity-verification.mjs";
import { completedRealTask, currentCorrectionQualifiers, exactResumeParent, freshSourceCheckpoint, preservedFailedE2, resumeFrozenSources, sameActualMainIdentity, completedEvidenceResultOrder } from "./verify-memory-continuity-resume.mjs";

function completed() {
  const runtimeTerminal = { schemaVersion: "agent-runtime-terminal.v1", status: "completed", cleanupStatus: "completed", completionScope: "runtime" };
  const terminalMetadata = { receiptAuthority: "runtime", currentRunId: "run-r1", scope: { kind: "loop", loopId: "loop" }, ordinal: 1,
    runtime: { engine: "pi", adapter: "pi-agent-harness", version: "1" }, runtimeTerminal };
  return { before: { workshopId: "work", loopId: "loop" }, failure: null, result: { loopRunId: "run-r1", result: { status: "success", output: "actual complete report", result: { executionTrace: {
    budgetExceeded: false, maxToolCalls: 12, toolCallCount: 3, runtimeTerminalCount: 1, runtimeTerminal: structuredClone(runtimeTerminal),
    events: [{ type: "agent_runtime_terminal", status: "completed", metadata: structuredClone(terminalMetadata) }, { type: "completed", status: "completed" }] } } } },
    after: { state: { currentPhase: "idle", blockedReason: null, stateJson: { lastLoopRunId: "run-r1", lastJobStatus: "success", lastVerificationPassed: true,
      lastCheckerPassed: true, lastOutcomeAction: "complete", lastAttemptsUsed: 1 } } },
    events: [{ type: "agent_runtime_terminal", seq: 10, createdAt: "2026-10-18T01:00:00Z", workshopId: "work", loopId: "loop", loopRunId: "run-r1", metadata: terminalMetadata },
      { type: "loop_run_completed", seq: 11, createdAt: "2026-10-18T01:00:01Z", loopRunId: "run-r1", body: "actual complete report" }] };
}
test("actual task success requires persisted completion and trace terminal", () => assert.equal(completedRealTask(completed()), true));
for (const [name, mutate] of [
  ["HTTP200 with failed result", f => { f.result.result.status = "error"; f.providerRequests = [{ responseStatus: 200 }]; }],
  ["persisted checker failure", f => { f.after.state.stateJson.lastCheckerPassed = false; }],
  ["missing native terminal", f => { f.result.result.result.executionTrace.events = []; }],
  ["terminal error after partial completion", f => { f.result.result.result.executionTrace.events.push({ type: "error", status: "error" }); }],
  ["terminal error hidden before completion", f => { f.result.result.result.executionTrace.events.unshift({ type: "error", status: "error" }); }],
  ["second domain attempt", f => { f.after.state.stateJson.lastAttemptsUsed = 2; }],
  ["output different from persistent report", f => { f.result.result.output = "invented replacement"; }],
  ["tool budget exceeded", f => { f.result.result.result.executionTrace.toolCallCount = 13; }],
  ["native completed without runtime terminal audit", f => { f.events.shift(); }],
  ["runtime cleanup failed", f => { f.events[0].metadata.runtimeTerminal.cleanupStatus = "failed"; }],
  ["duplicate runtime terminal", f => { f.result.result.result.executionTrace.runtimeTerminalCount = 2; }],
  ["runtime terminal from another Loop", f => { f.events[0].metadata.scope.loopId = "other-loop"; }],
  ["trace terminal contradicts persisted runtime receipt", f => { f.result.result.result.executionTrace.runtimeTerminal.status = "failed"; }],
  ["runtime terminal persisted after completion", f => { f.events[0].seq = 12; }],
  ["contradictory underlying runtime status", f => { f.events[0].metadata.runtimeTerminal.runtimeStatus = "failed"; }],
  ["terminal trace explicitly marked failed", f => { f.result.result.result.executionTrace.events[0].status = "error"; }],
]) test(`actual task rejects ${name}`, () => { const f = completed(); mutate(f); assert.equal(completedRealTask(f), false); });

function corrected() {
  const canonical = { id: "new", content: "all scope and applicability preserved", confidence: 25, status: "active" };
  const correction = { result: { newMemory: { id: "new" } }, expectedVersion: "bmrv1:current", request: { content: canonical.content } };
  const context = { memoryRecall: { backend: "brain", contextPack: { selected: [{ id: "new", revisionVersion: "bmrv1:current" }] } },
    memoryContext: { taskRelevantMemories: [{ ...canonical, revisionVersion: "bmrv1:current", reasons: ["warning:owner_statement_control_feedback_not_verified_fact", "relevant_recent_revision", "reserved_relevant_revision"] }] } };
  return { canonical, correction, context };
}
test("current correction carries real confidence status and protected warnings", () => {
  const f = corrected(); assert.equal(currentCorrectionQualifiers(f.context, f.correction, "old", f.canonical), true);
});
for (const [name, mutate] of [
  ["ranking score substituted as confidence", f => { f.context.memoryContext.taskRelevantMemories[0].confidence = 98; }],
  ["active invented as verified", f => { f.context.memoryContext.taskRelevantMemories[0].status = "verified"; }],
  ["missing owner feedback warning", f => { f.context.memoryContext.taskRelevantMemories[0].reasons.shift(); }],
  ["missing reserve provenance", f => { f.context.memoryContext.taskRelevantMemories[0].reasons.pop(); }],
  ["stale selected revision", f => { f.context.memoryRecall.contextPack.selected[0].revisionVersion = "bmrv1:old"; }],
]) test(`current qualifiers reject ${name}`, () => {
  const f = corrected(); mutate(f); assert.equal(currentCorrectionQualifiers(f.context, f.correction, "old", f.canonical), false);
});

function lineage() {
  const event = { id: "accepted-r1", type: "working_memory_updated", seq: 10, createdAt: "2026-10-18T02:00:00.000Z",
    metadata: { receiptAuthority: "runtime", mode: "apply", status: "ready_for_projection", version: 1, policyIdentity: { version: 1, hash: "p" },
      state: { openQuestions: ["Which current version applies?"] } } };
  const first = { before: { workshopId: "work" }, result: { loopRunId: "r1" }, events: [event] };
  const checkpoint = { sourceRunId: "r1", checkpointEventId: event.id, version: 1, policyIdentity: event.metadata.policyIdentity,
    createdAt: event.createdAt, expiresAt: "2026-10-19T02:00:00.000Z", history: { facts: [], hypotheses: [], openQuestions: [...event.metadata.state.openQuestions], nextAction: null },
    chain: { depth: 0, viaRunIds: [], assertionsSuppressed: true } };
  checkpoint.chain.rootHash = canonicalHash({ workshopId: "work", sourceRunId: "r1", checkpointEventId: event.id, metadata: event.metadata, expiresAt: checkpoint.expiresAt });
  const second = { result: { loopRunId: "r2" }, events: [{ type: "working_memory_continuity_loaded", seq: 20,
    metadata: { receiptAuthority: "runtime", status: "inherited", currentRunId: "r2", checkpoint: structuredClone(checkpoint) } }] };
  const chained = structuredClone(checkpoint); chained.chain.depth = 1; chained.chain.viaRunIds = ["r2"];
  return { first, second, checkpoint, chained };
}
test("R2 binds exact fresh R1 checkpoint independently", () => { const f = lineage(); assert.equal(exactResumeParent(f.checkpoint, f.first, f.first), true); });
test("R3 can preserve R1 root through exact persisted R2 inheritance", () => { const f = lineage(); assert.equal(exactResumeParent(f.chained, f.second, f.first), true); });
for (const [name, mutate] of [
  ["old D root plus a parent name", f => { f.chained.sourceRunId = "old-d"; }],
  ["wrong parent ordering", f => { f.chained.chain.viaRunIds.unshift("old-d"); f.chained.chain.depth++; }],
  ["refreshed TTL", f => { f.chained.expiresAt = "2026-10-20T02:00:00.000Z"; }],
  ["changed root question", f => { f.chained.history.openQuestions.push("injected"); }],
  ["mutated persisted parent", f => { f.second.events[0].metadata.checkpoint.chain.rootHash = "forged"; }],
  ["root hash invented consistently in parent and child", f => { f.second.events[0].metadata.checkpoint.chain.rootHash = "forged"; f.chained.chain.rootHash = "forged"; }],
]) test(`exact inheritance rejects ${name}`, () => { const f = lineage(); mutate(f); assert.equal(exactResumeParent(f.chained, f.second, f.first), false); });

function failedE2() {
  return { round: "E2", failure: null, result: { loopRunId: "failed-e2", result: { status: "error", error: "[data_inspection_failed] stream400" } },
    providerRequests: [{ kind: "other-model", responseStatus: null, error: "TimeoutError" }, { kind: "working-memory-agent", responseStatus: 200, error: null }],
    events: [{ type: "tool_error", body: "[data_inspection_failed]" }], after: { state: { stateJson: { lastLoopRunId: "failed-e2", lastJobStatus: "error",
      lastVerificationPassed: false, lastCheckerPassed: false, lastOutcomeAction: "fail", lastAttemptsUsed: 1 } } } };
}
test("prior failed E2 includes independent auxiliary timeout without hiding either failure", () => assert.equal(preservedFailedE2(failedE2()), true));
test("HTTP200 alone never authorizes continuing a falsely successful E2", () => {
  const f = failedE2(); f.result.result.status = "success"; assert.equal(preservedFailedE2(f), false);
});
test("resume freeze includes provider helpers and runtime but excludes only evaluator sources", () => {
  assert.deepEqual(resumeFrozenSources({ "apps/web/scripts/verify-memory-continuity-resume.mjs": "audit", "apps/web/scripts/prove-memory-continuity.ts": "runner",
    "packages/ai/src/agent/runtime/pi-provider-terminal.ts": "terminal", "packages/ai/src/agent/runtime/pi-stream-diagnostics.ts": "diagnostics" }), {
    "apps/web/scripts/prove-memory-continuity.ts": "runner", "packages/ai/src/agent/runtime/pi-provider-terminal.ts": "terminal", "packages/ai/src/agent/runtime/pi-stream-diagnostics.ts": "diagnostics" });
});

function provider() { return { payload: { model: "original-actual-model", messages: [] }, request: { model: "original-actual-model", endpointHash: "original-endpoint" },
  expected: { actualModel: "original-actual-model", actualEndpointHash: "original-endpoint", protocol: "openai-completions" } }; }
test("same actual main model is bound independently of unchanged workshop settings", () => {
  const f = provider(); assert.equal(sameActualMainIdentity(f.payload, f.request, f.expected), true);
});
for (const [name, mutate] of [
  ["winning env model changed", f => { f.payload.model = "different-model"; f.request.model = "different-model"; }],
  ["request record contradicts payload", f => { f.request.model = "different-model"; }],
  ["endpoint changed", f => { f.request.endpointHash = "new-endpoint"; }],
  ["protocol changed", f => { f.expected.protocol = "openai-responses"; }],
  ["missing actual model", f => { delete f.payload.model; }],
]) test(`actual main identity rejects ${name}`, () => { const f = provider(); mutate(f); assert.equal(sameActualMainIdentity(f.payload, f.request, f.expected), false); });

function orderedEvidence() {
  const scope = { workshopId: "work", loopId: "loop", loopRunId: "run" };
  return { call: { ...scope, type: "tool_call", seq: 1, createdAt: "2026-10-18T01:00:00Z", metadata: { runtimeTrace: true, toolUseId: "call" } },
    result: { ...scope, type: "tool_result", seq: 2, createdAt: "2026-10-18T01:00:01Z", metadata: { runtimeTrace: true, toolUseId: "call", traceType: "tool_result", traceStatus: "completed", toolName: "workshopGetMemoryEvidence" } },
    prepared: { ...scope, type: "working_memory_projected", seq: 3, createdAt: "2026-10-18T01:00:02Z", metadata: { receiptAuthority: "runtime", status: "provider_request_prepared" } } };
}
test("typed evidence result must be actually completed before its containing dispatch preparation", () => {
  const f = orderedEvidence(); assert.equal(completedEvidenceResultOrder(f.call, f.result, f.prepared, "call"), true);
});
for (const [name, mutate] of [
  ["Pi-domain completion lacking actual trace status", f => { delete f.result.metadata.traceStatus; delete f.result.metadata.traceType; }],
  ["mismatched actual tool call", f => { f.result.metadata.toolUseId = "old-call"; }],
  ["result recorded after prepared payload", f => { f.result.seq = 4; }],
  ["result timestamp after prepared payload", f => { f.result.createdAt = "2026-10-18T01:00:03Z"; }],
  ["result belongs to another run", f => { f.result.loopRunId = "other-run"; }],
  ["result before actual call", f => { f.result.seq = 0; }],
]) test(`typed evidence order rejects ${name}`, () => { const f = orderedEvidence(); mutate(f); assert.equal(completedEvidenceResultOrder(f.call, f.result, f.prepared, "call"), false); });

function fresh() {
  const binding = { sourceEventId: "source", contentHash: "a".repeat(64), evidenceId: "ev", offset: 0, contentLength: 20, totalChars: 30, sourceVersion: "sha256:source" };
  const catalog = { toolCallId: "read-call", toolName: "webReadPage", referenceEligible: true, sourceIdentityStatus: "reported", contentHash: "b".repeat(64), sourceIdentity: binding };
  return { before: { workshopId: "work", loopId: "loop" }, result: { loopRunId: "run" }, events: [
    { id: "source", type: "source_checked", seq: 1, workshopId: "work", loopId: "loop", loopRunId: "run",
      metadata: { receiptAuthority: "runtime", ok: true, toolName: "webReadPage", toolUseId: "read-call", ...binding } },
    { id: "log", type: "working_memory_updated", seq: 2, metadata: { receiptAuthority: "runtime", mode: "apply", status: "ready_for_projection", version: 1,
      policyIdentity: { hash: "policy" }, evidenceCatalog: [catalog], state: { openQuestions: ["next"], facts: [{ evidenceIds: ["read-call"] }] } } },
    { id: "prepared", type: "working_memory_projected", seq: 3, metadata: { receiptAuthority: "runtime", status: "provider_request_prepared", version: 1,
      policyIdentity: { hash: "policy" }, evidenceCatalog: [structuredClone(catalog)] } },
  ], providerRequests: [{ kind: "working-memory-agent", hostPrepared: { eventId: "prepared", seq: 3, version: 1 }, responseStatus: 200, error: null }] };
}
test("new R1 checkpoint has real fresh exact-scope source and subsequent actual projection", () => assert.equal(freshSourceCheckpoint(fresh()), true));
for (const [name, mutate] of [
  ["source from old run", f => { f.events[0].loopRunId = "old-run"; }],
  ["tampered snapshot window", f => { f.events[0].metadata.offset = 10; }],
  ["changed projection source hash", f => { f.events[2].metadata.evidenceCatalog[0].contentHash = "c".repeat(64); }],
  ["no actual post-LOG dispatch", f => { f.providerRequests = []; }],
  ["clear after source-bound LOG", f => { f.events.push({ type: "working_memory_restored", seq: 4, metadata: { receiptAuthority: "runtime" } }); }],
]) test(`fresh checkpoint rejects ${name}`, () => { const f = fresh(); mutate(f); assert.equal(freshSourceCheckpoint(f), false); });
