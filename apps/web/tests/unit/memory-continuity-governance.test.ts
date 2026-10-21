import { describe, expect, it, vi } from "vitest";
import { buildContinuityRuntimeBinding, type ContinuityRuntimeBinding } from "@/lib/memory/continuity/runtime-binding";
import { loadWorkingMemoryContinuity, type WorkingMemoryContinuityInput, type WorkingMemoryContinuityReaders,
  type WorkingMemoryContinuityRun } from "@/lib/memory/continuity/working-memory";
import { prepareBusinessCheckpoint, verifyBusinessCheckpointReceipt } from "@/lib/memory/continuity/business-checkpoint";
import { createStateSnapshot } from "@/lib/memory/continuity/state-snapshots";
import { BrainMemoryUpdateError } from "@/lib/memory/kernel/reference-errors";
import { BrainMemoryUpdateError as LegacyUpdateError } from "@/lib/brain/memory-update-common";
import { stateSnapshotRevisionVersion, type StateSnapshotRecord } from "@/lib/memory/records/state-snapshots";
import { promotionEvents, promotionUserId as userId, promotionWorkId as workshopId, promotionRunId as sourceRunId } from "../fixtures/working-memory-promotion";

const currentRunId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", loopId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const now = new Date("2026-10-13T01:00:00Z"), policyIdentity = { version: "memact-automem.v1", hash: "c".repeat(64) };
function binding(runId: string, patch: Partial<Parameters<typeof buildContinuityRuntimeBinding>[0]> = {}) {
  return buildContinuityRuntimeBinding({ userId, workshopId, runId, loopId: null, runtime: { engine: "pi", adapter: "pi-agent-harness" },
    workshopConfig: { mission: "Read primary sources", boundaryPolicy: { externalWrite: "deny" }, modelConfig: { model: "fixture" } },
    allowedToolNames: ["webReadPage"], deniedToolNames: ["sendMessage"], policyIdentity, applicabilityHash: null, ...patch });
}
function fixture(current = binding(currentRunId)) {
  const stored = binding(sourceRunId), events = promotionEvents();
  events[1].metadata.runtimeBinding = stored;
  events[1].metadata.state = { facts: [{ text: "OLD_ASSERTION", evidenceIds: ["read-1"] }],
    hypotheses: [], openQuestions: ["Which current source should be checked?"], nextAction: { text: "OLD_ACTION", evidenceIds: ["read-1"] },
    summary: "OLD_SUMMARY_MUST_NOT_LOAD", progress: "OLD_PROGRESS_MUST_NOT_LOAD" };
  const source: WorkingMemoryContinuityRun = { id: sourceRunId, userId, workshopId, loopId: null, status: "completed",
    createdAt: "2026-10-12T23:59:00Z", completedAt: "2026-10-13T00:01:00Z", events };
  const readers: WorkingMemoryContinuityReaders = { ownsScope: vi.fn(async () => true),
    listPredecessors: vi.fn(async () => [source]), loadEvents: vi.fn(async () => events), loadRuntimeBinding: vi.fn(async () => stored) };
  const input: WorkingMemoryContinuityInput = { userId, workshopId, currentRunId, scope: { kind: "parent_run", parentRunId: sourceRunId },
    policyIdentity, runtimeBinding: current, now, verifySources: async sources => sources.map(item => ({
      sourceEventId: item.sourceEventId, toolCallId: item.toolCallId, status: "current" })) };
  return { stored, source, events, readers, input };
}

describe("Memory continuity governance", () => {
  it("binds configuration separately from the immutable strategy ID and actual run origin", async () => {
    expect(binding(sourceRunId).configHash).toBe(binding(currentRunId).configHash);
    const f = fixture(), before = structuredClone(f.events);
    const result = await loadWorkingMemoryContinuity(f.input, f.readers);
    expect(result.status).toBe("inherited");
    expect(result.checkpoint?.runtimeBinding?.runId).toBe(sourceRunId);
    expect(result.checkpoint?.history.facts[0]?.text).toBe("OLD_ASSERTION");
    expect(result.checkpoint?.authority).toBe("historical-model-authored-unverified");
    expect(f.events).toEqual(before);
    expect(JSON.stringify(result)).not.toContain("OLD_SUMMARY_MUST_NOT_LOAD");
    expect(JSON.stringify(result)).not.toContain("OLD_PROGRESS_MUST_NOT_LOAD");
  });

  it.each([
    { allowedToolNames: ["anotherReader"] }, { deniedToolNames: ["webReadPage"] },
    { requiresApprovalToolNames: ["webReadPage"] }, { applicabilityHash: "d".repeat(64) },
    { workshopConfig: { mission: "Different role" } }, { runtime: { engine: "pi", adapter: "pi-agent-core" } },
    { runtime: { engine: "pi", adapter: "pi-agent-harness", model: "different-resolved-model" } },
    { runtime: { engine: "pi", adapter: "pi-agent-harness", protocol: "openai-completions" } },
  ])("rejects saved configuration or permission boundary changes: %j", async patch => {
    const f = fixture(binding(currentRunId, patch));
    expect(await loadWorkingMemoryContinuity(f.input, f.readers)).toMatchObject({ status: "skipped", reason: "continuity_runtime_changed", checkpoint: null });
  });

  it("rejects a claimed runtime binding without the actual saved run projection", async () => {
    const f = fixture(); f.readers.loadRuntimeBinding = vi.fn(async () => null);
    expect((await loadWorkingMemoryContinuity(f.input, f.readers)).reason).toBe("continuity_binding_unavailable");
    delete f.events[1].metadata.runtimeBinding;
    expect((await loadWorkingMemoryContinuity(f.input, f.readers)).reason).toBe("continuity_runtime_changed");
  });

  it.each(["unknown", "denied", "failure", "absent"])("withholds all assertion/action/free text when source permission is %s", async mode => {
    const f = fixture();
    f.input.verifySources = mode === "absent" ? undefined : async sources => {
      if (mode === "failure") throw new Error("private source or audit failure");
      return sources.map(source => ({ sourceEventId: source.sourceEventId, toolCallId: source.toolCallId, status: mode === "denied" ? "denied" : "unknown" }));
    };
    const result = await loadWorkingMemoryContinuity(f.input, f.readers);
    expect(result).toMatchObject({ status: "inherited", reason: "current_sources_unverified_questions_only", checkpoint: {
      history: { facts: [], hypotheses: [], openQuestions: ["Which current source should be checked?"], nextAction: null }, sourceRefs: [],
      chain: { assertionsSuppressed: true } } });
    expect(JSON.stringify(result)).not.toMatch(/OLD_ASSERTION|OLD_ACTION|OLD_SUMMARY|OLD_PROGRESS|private source/);
    expect(f.events[1].metadata.state).toMatchObject({ summary: "OLD_SUMMARY_MUST_NOT_LOAD" });
  });

  it("does not inherit questions when Work, Loop or saved run origin is wrong", async () => {
    const f = fixture();
    const forged: ContinuityRuntimeBinding = { ...f.stored, runId: currentRunId };
    f.events[1].metadata.runtimeBinding = forged;
    expect((await loadWorkingMemoryContinuity(f.input, f.readers)).status).toBe("skipped");
    expect((await loadWorkingMemoryContinuity({ ...f.input, workshopId: loopId }, f.readers)).reason).toBe("source_scope_mismatch");
    const other = binding(currentRunId, { loopId });
    expect((await loadWorkingMemoryContinuity({ ...f.input, runtimeBinding: other }, f.readers)).status).toBe("skipped");
  });

  it("requires the actual matching run binding when saving and recovering business progress", () => {
    const old = binding(sourceRunId, { loopId }), current = binding(currentRunId, { loopId });
    const prepared = prepareBusinessCheckpoint({ userId, workshopId, loopId, runId: sourceRunId, runtimeBinding: old,
      report: { checkpoint: { nextQuestions: ["Verify current state"] } }, verificationPassed: false, now });
    expect(prepared.status).toBe("saved"); if (prepared.status !== "saved") throw Error("missing checkpoint");
    const state = { ...prepared.state, receiptEventId: "receipt" }, event = { id: "receipt", workshopId, runId: sourceRunId, loopId,
      loopRunId: sourceRunId, type: "loop_business_checkpoint_saved", metadata: { receiptAuthority: "runtime", ...prepared } };
    expect(verifyBusinessCheckpointReceipt(state, { userId, workshopId, loopId, runtimeBinding: current, now }, event)).not.toBeNull();
    expect(verifyBusinessCheckpointReceipt(state, { userId, workshopId, loopId, runtimeBinding: binding(currentRunId, { loopId, allowedToolNames: [] }), now }, event)).toBeNull();
    expect(prepareBusinessCheckpoint({ userId, workshopId, loopId, runId: currentRunId, runtimeBinding: old,
      report: { checkpoint: { nextQuestions: ["Verify"] } }, verificationPassed: false, now }).status).toBe("omitted");
  });

  it.each(["memory_auto_update_policy", "memory_dependency_registry", "memory_dependency_change", "memory_correction_draft", "wechat_scenario_state"])("preserves reserved snapshot protection and error identity: %s", async snapshotType => {
    expect(BrainMemoryUpdateError).toBe(LegacyUpdateError);
    await expect(createStateSnapshot({ userId, scope: { type: "global" }, snapshotType, content: {} })).rejects.toBeInstanceOf(LegacyUpdateError);
  });

  it("versions the complete stored snapshot instead of only its ID and timestamp", () => {
    const snapshot: StateSnapshotRecord = { id: sourceRunId, userId, scope: { type: "work", workId: workshopId },
      snapshotType: "checkpoint", content: { a: 1, b: 2 }, sourceMemoryIds: [], metadata: {}, createdAt: now.toISOString() };
    const version = stateSnapshotRevisionVersion(snapshot);
    expect(stateSnapshotRevisionVersion({ ...snapshot, content: { b: 2, a: 1 } })).toBe(version);
    expect(stateSnapshotRevisionVersion({ ...snapshot, content: { a: 2 } })).not.toBe(version);
    expect(stateSnapshotRevisionVersion({ ...snapshot, metadata: { revoked: true } })).not.toBe(version);
  });
});
