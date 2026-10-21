import { describe, it, expect } from "vitest";
import { classifyNewRecord, inferRecordClass, makeRecordLifecycle, memoryRecallOmitReason, recordLifecycleView } from "@/lib/memory/records/lifecycle";
import { buildBrainContextPack } from "@/lib/memory/context/pack";
import { memoryIsDependencyCurrent } from "@/lib/memory/revision/dependencies-common";
import type { BrainMemory } from "@/lib/memory/kernel/memory-types";
const now = new Date("2026-10-21T00:00:00Z");
function memory(patch: Partial<BrainMemory> = {}): BrainMemory {
  return { id: "11111111-1111-4111-a111-111111111111", userId: "owner", scope: { type: "work", workId: "work" }, ownerType: "work", ownerId: "work",
    memoryType: "insight", subject: "Research", content: "2026-10-02 研究检查点（第十轮）：tools and pending questions", status: "active", confidence: 90,
    evidenceRefs: ["event-1"], tags: ["checkpoint", "research-state"], createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z", ...patch };
}
describe("memory record lifecycle", () => {
  it("routes authored checkpoints away from long-term memory without rewriting raw evidence", () => {
    const before = memory(), after = classifyNewRecord(before);
    expect(inferRecordClass(before).recordClass).toBe("run_record");
    expect(after.content).toBe(before.content); expect(after.status).toBe("active"); expect(after.updatedAt).toBe(before.updatedAt);
    expect(recordLifecycleView(after, now)).toMatchObject({ recordClass: "run_record", phase: "archived", usableUntil: "2026-10-09T00:00:00.000Z", recallEligible: false });
  });
  it("does not classify a technical lesson by keyword, date or checkpoint tag alone", () => {
    expect(inferRecordClass(memory({ content: "A checkpoint must bind its source version before recovery.", tags: ["checkpoint"] })).recordClass).toBe("long_term");
    expect(inferRecordClass(memory({ content: "2026-10-02 checkpoint security lesson", tags: [] })).recordClass).toBe("long_term");
    expect(inferRecordClass(memory({ ownerType: "chat" })).recordClass).toBe("long_term");
  });
  it("recognizes dated operational audit receipts without requiring a checkpoint tag", () => {
    expect(inferRecordClass(memory({ content: "2026-10-14 每日 Harness 质量审计：仍被阻断。", tags: ["harness-quality", "daily-audit", "blocked"] })).recordClass).toBe("run_record");
    expect(inferRecordClass(memory({ content: "2026-09 智能体恢复与长程架构研究检查点（首轮基线）", tags: ["checkpoint"] })).recordClass).toBe("run_record");
    expect(inferRecordClass(memory({ content: "2026-08-17 阈值复核达成并创建提案", tags: ["threshold-review"] })).recordClass).toBe("run_record");
    expect(inferRecordClass(memory({ content: "Change proposal 2026-08-17 (missing-memory)", tags: ["recall-quality", "change-proposal"] })).recordClass).toBe("run_record");
    expect(inferRecordClass(memory({ content: "An audit should retain explicit denial evidence.", tags: ["daily-audit"] })).recordClass).toBe("long_term");
  });
  it("never automatically weakens a restriction", () => {
    expect(memoryRecallOmitReason(memory({ memoryType: "boundary" }))).toBeNull();
    expect(memoryRecallOmitReason(memory({ metadata: { canonicalKind: "boundary" } }))).toBeNull();
  });
  it("requires the joint fixture identity and provenance before isolating an acceptance record", () => {
    const test = memory({ subject: "Memory continuity acceptance a70c4191 / acceptance.policy", content: "memory-continuity-acceptance; exercise",
      metadata: { facets: { notebookKey: "acceptance.policy" }, workingMemoryPromotion: { commandId: "memory-continuity:example:promote" } } });
    expect(inferRecordClass(test).recordClass).toBe("acceptance_record");
    expect(recordLifecycleView(test, now).phase).toBe("audit_only");
    expect(inferRecordClass({ ...test, metadata: {} }).recordClass).toBe("run_record");
  });
  it("excludes operational and acceptance records even from discovery and candidate-inclusive packs", () => {
    const run = classifyNewRecord(memory()), acceptance = memory({ id: "test", metadata: { recordLifecycle: makeRecordLifecycle(memory(), "acceptance_record", "fixture", now, "owner") } });
    const fact = memory({ id: "fact", memoryType: "preference", tags: [], content: "Use concise summaries" });
    const pack = buildBrainContextPack({ memories: [run, acceptance, fact], requester: { type: "chat", userId: "owner" }, taskIntent: "summaries", accessMode: "owner_override", applicabilityMode: "discovery", includeCandidates: true, now });
    expect(pack.items.map(item => item.id)).toEqual(["fact"]);
    expect(pack.omitted).toEqual(expect.arrayContaining([{ id: run.id, reason: "record_class:run_record" }, { id: "test", reason: "record_class:acceptance_record" }]));
    expect(memoryIsDependencyCurrent(run, now)).toBe(false); expect(memoryIsDependencyCurrent(fact, now)).toBe(true);
  });
  it("keeps a live seven-day window separate from model recall eligibility", () => {
    const note = memory({ createdAt: "2026-10-20T00:00:00Z" });
    expect(recordLifecycleView(note, now).phase).toBe("continuity_window"); expect(memoryRecallOmitReason(note)).toBe("record_class:run_record");
  });
  it("honors an explicit owner correction to class while failing closed on malformed lifecycle", () => {
    const note = memory();
    note.metadata = { recordLifecycle: makeRecordLifecycle(note, "long_term", "extracted verified conclusion", now, "command") };
    expect(memoryRecallOmitReason(note)).toBeNull();
    note.metadata.recordLifecycle = { schemaVersion: "unknown", recordClass: "long_term" };
    expect(memoryRecallOmitReason(note)).toBe("record_lifecycle_invalid");
  });
});
