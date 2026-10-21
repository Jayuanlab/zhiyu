import { describe, expect, it } from "vitest";
import type { InteractionScenarioSnapshotDraft } from "@/lib/interactions/scenarios";
import { mergeInteractionScenarioState, scenarioStateBatchHash } from "@/lib/interactions/scenario-state";

const task = (id: string, status = "candidate") => ({ id, title: id, status, sourceEventIds: [`event-${id}`] });
function draft(tasks = [task("a")], key = "alpha"): InteractionScenarioSnapshotDraft {
  return { scenarioType: "project", scenarioKey: key, title: key,
    sourceItemIds: tasks.map(item => item.id), sourceEventIds: tasks.flatMap(item => item.sourceEventIds), sourceMemoryIds: [],
    content: { interfaceVersion: "wechat-scenario-state.v1", scenarioType: "project", scenarioKey: key, title: key,
      summary: "batch", currentState: "batch", openLoops: tasks.filter(item => !["done", "dismissed", "deleted"].includes(item.status)),
      taskUpdates: tasks, notes: [], memories: [], sourceEventIds: tasks.flatMap(item => item.sourceEventIds) },
    metadata: { observedAt: "2026-10-20T01:00:00.000Z", scenarioType: "project", scenarioKey: key } };
}
function previous(value: ReturnType<typeof mergeInteractionScenarioState>) { return { id: "snapshot-1", ...value }; }

describe("incremental scenario state", () => {
  it("preserves an earlier open task when an unrelated new batch arrives", () => {
    const first = mergeInteractionScenarioState({ draft: draft() });
    const second = mergeInteractionScenarioState({ previous: previous(first), draft: draft([task("b")]) });
    expect(second.content.openLoops.map(item => item.id)).toEqual(["a", "b"]);
    expect(second.content.previousSnapshotId).toBe("snapshot-1");
    expect(second.content.revision).toBe(2);
    expect(second.content.sourceEventIds).toEqual(["event-a", "event-b"]);
    expect(first.content.openLoops).toHaveLength(1);
  });
  it.each(["done", "dismissed", "deleted"])("closes only the same task id with %s", status => {
    const first = mergeInteractionScenarioState({ draft: draft([task("a"), task("b")]) });
    const second = mergeInteractionScenarioState({ previous: previous(first), draft: draft([task("a", status)]) });
    expect(second.content.openLoops.map(item => item.id)).toEqual(["b"]);
    expect(second.content.closedLoops).toEqual([task("a", status)]);
    const third = mergeInteractionScenarioState({ previous: previous(second), draft: draft([task("c")]) });
    expect(third.content.closedLoops).toEqual([task("a", status)]);
  });
  it("retains earlier notes and memories, with explicit unverified authority", () => {
    const a = draft(); a.content.notes = [{ id: "n", title: "note", content: "earlier evidence", sourceEventIds: ["event-a"] }];
    a.content.memories = [{ id: "m", subject: "subject", content: "estimate", confidence: 90, sourceEventIds: ["event-a"] }];
    const second = mergeInteractionScenarioState({ previous: previous(mergeInteractionScenarioState({ draft: a })), draft: draft([task("b")]) });
    expect(second.content.notes).toEqual(a.content.notes);
    expect(second.content.memories).toEqual(a.content.memories);
    expect(second.content.authority).toBe("model_estimate_unverified");
    expect(second.content.verification).toBe("business_state_not_verified");
    expect(second.content.currentState).toBe(second.content.summary);
  });
  it("rejects wrong typed identity and conflicting same-id delta", () => {
    const first = previous(mergeInteractionScenarioState({ draft: draft() }));
    expect(() => mergeInteractionScenarioState({ previous: first, draft: draft([], "other") })).toThrow(/identity/);
    expect(() => mergeInteractionScenarioState({ draft: draft([task("a"), task("a", "done")]) })).toThrow(/Conflicting/);
  });
  it("rejects item sources outside the declared batch and discloses legacy coverage", () => {
    const bad = draft(); bad.content.taskUpdates![0].sourceEventIds = ["undeclared"];
    expect(() => mergeInteractionScenarioState({ draft: bad })).toThrow(/declared source/);
    const legacy = { id: "legacy", content: { ...draft().content }, metadata: {} };
    const merged = mergeInteractionScenarioState({ previous: legacy, draft: draft([task("b")]) });
    expect(merged.metadata.historicalCoverage).toBe("legacy_snapshot_coverage_unknown");
  });
  it("hashes replay independently of processing time and source ordering", () => {
    const a = draft([task("a"), task("b")]); const b = draft([task("b"), task("a")]);
    b.metadata.observedAt = "2026-10-21T01:00:00.000Z";
    expect(scenarioStateBatchHash(a)).toBe(scenarioStateBatchHash(b));
    b.content.taskUpdates![0].status = "done";
    expect(scenarioStateBatchHash(a)).not.toBe(scenarioStateBatchHash(b));
  });
  it("does not silently discard history at the capacity bound", () => {
    expect(() => mergeInteractionScenarioState({ draft: draft(Array.from({ length: 5_001 }, (_, index) => task(String(index)))) })).toThrow(/capacity/);
  });
  it("keeps a closed task closed when a different late source batch estimates it as open", () => {
    const closed = draft([task("a", "done")]);
    closed.content.taskUpdates![0].sourceObservedAt = "2026-10-20T02:00:00.000Z";
    const late = draft([task("a")]); late.content.taskUpdates![0].sourceObservedAt = "2026-10-20T01:00:00.000Z";
    const result = mergeInteractionScenarioState({ previous: previous(mergeInteractionScenarioState({ draft: closed })), draft: late });
    expect(result.content.openLoops).toEqual([]); expect(result.content.closedLoops[0].status).toBe("done");
    expect(result.content.taskConflicts[0].reason).toBe("late_source_update");
  });
  it("allows reopening only from a newer host-read business task state", () => {
    const closed = draft([task("a", "done")]);
    Object.assign(closed.content.taskUpdates![0], { stateAuthority: "business_task_record", stateObservedAt: "2026-10-20T02:00:00.000Z" });
    const old = previous(mergeInteractionScenarioState({ draft: closed }));
    const guess = mergeInteractionScenarioState({ previous: old, draft: draft([task("a")]) });
    expect(guess.content.openLoops).toEqual([]);
    const reopened = draft([task("a")]);
    Object.assign(reopened.content.taskUpdates![0], { stateAuthority: "business_task_record", stateObservedAt: "2026-10-20T03:00:00.000Z" });
    expect(mergeInteractionScenarioState({ previous: old, draft: reopened }).content.openLoops).toHaveLength(1);
  });
  it("rejects a late lower business revision even when its timestamp is later", () => {
    const closed = draft([task("a", "done")]);
    Object.assign(closed.content.taskUpdates![0], { stateAuthority: "business_task_record", stateRevision: 5, stateObservedAt: "2026-10-20T02:00:00.000Z" });
    const late = draft([task("a")]);
    Object.assign(late.content.taskUpdates![0], { stateAuthority: "business_task_record", stateRevision: 4, stateObservedAt: "2026-10-21T02:00:00.000Z" });
    const value = mergeInteractionScenarioState({ previous: previous(mergeInteractionScenarioState({ draft: closed })), draft: late });
    expect(value.content.openLoops).toEqual([]);
    expect(value.content.closedLoops[0].stateRevision).toBe(5);
    expect(value.content.taskConflicts).toContainEqual(expect.objectContaining({ reason: "late_business_task_revision", previousRevision: 5, incomingRevision: 4 }));
  });
  it("uses a higher business revision despite clock regression and rejects equal-version conflicts", () => {
    const before = draft([task("a")]);
    Object.assign(before.content.taskUpdates![0], { stateAuthority: "business_task_record", stateRevision: 0, stateObservedAt: "2026-10-21T02:00:00.000Z" });
    const old = previous(mergeInteractionScenarioState({ draft: before }));
    const closed = draft([task("a", "done")]);
    Object.assign(closed.content.taskUpdates![0], { stateAuthority: "business_task_record", stateRevision: 1, stateObservedAt: "2026-10-20T02:00:00.000Z" });
    const value = mergeInteractionScenarioState({ previous: old, draft: closed });
    expect(value.content.openLoops).toEqual([]);
    expect(value.content.closedLoops[0].stateRevision).toBe(1);
    closed.content.taskUpdates![0].stateRevision = 0;
    const conflict = mergeInteractionScenarioState({ previous: old, draft: closed });
    expect(conflict.content.openLoops[0].status).toBe("candidate");
    expect(conflict.content.taskConflicts[0].reason).toBe("same_business_task_revision_conflict");
  });
  it("keeps a versioned terminal state against missing revisions and model estimates", () => {
    const closed = draft([task("a", "done")]);
    Object.assign(closed.content.taskUpdates![0], { stateAuthority: "business_task_record", stateRevision: 0 });
    const old = previous(mergeInteractionScenarioState({ draft: closed }));
    const unversioned = draft([task("a")]);
    Object.assign(unversioned.content.taskUpdates![0], { stateAuthority: "business_task_record", stateObservedAt: "2099-01-01T00:00:00.000Z" });
    expect(mergeInteractionScenarioState({ previous: old, draft: unversioned }).content.openLoops).toEqual([]);
    expect(mergeInteractionScenarioState({ previous: old, draft: draft([task("a")]) }).content.openLoops).toEqual([]);
  });
  it("accepts host revision zero over a legacy model estimate and rejects forged or invalid revisions", () => {
    const legacy = previous(mergeInteractionScenarioState({ draft: draft([task("a", "done")]) }));
    const current = draft([task("a")]);
    Object.assign(current.content.taskUpdates![0], { stateAuthority: "business_task_record", stateRevision: 0 });
    expect(mergeInteractionScenarioState({ previous: legacy, draft: current }).content.openLoops[0].stateRevision).toBe(0);
    const forged = draft(); forged.content.taskUpdates![0].stateRevision = 1;
    expect(() => mergeInteractionScenarioState({ draft: forged })).toThrow(/host business authority/);
    current.content.taskUpdates![0].stateRevision = -1;
    expect(() => mergeInteractionScenarioState({ draft: current })).toThrow(/nonnegative/);
  });
});
