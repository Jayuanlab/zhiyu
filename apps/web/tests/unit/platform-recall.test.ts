import { describe, expect, it, vi } from "vitest";
import {
  PLATFORM_INFORMATION_REGISTRY,
  recallPlatformInformationForUser,
} from "@/lib/ai/platform-recall";
import type { BrainMemory } from "@/lib/brain/types";
import { listBrainSnapshotsForUser } from "@/lib/ai/brain-read-tools";
import type { listKnowledgeBaseDocumentsForUser } from "@/lib/ai/knowledge-base-documents";

function memory(input: Partial<BrainMemory>): BrainMemory {
  return {
    id: "memory-1",
    userId: "user-1",
    scope: { type: "global" },
    ownerType: "chat",
    ownerId: "user-1",
    memoryType: "fact",
    subject: "Architecture",
    content: "Work owns the control boundary.",
    status: "verified",
    confidence: 90,
    evidenceRefs: ["brain-observation:obs-1"],
    tags: ["system_architecture"],
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    metadata: {
      catalog: "architecture-v1",
      topic: "work-boundary",
      sourcePath: "docs/architecture/zhiyu-control-architecture-contract.md",
      sourceHash: "abc",
    },
    ...input,
  };
}

describe("platform recall", () => {
  it.each([
    { name: "automatic current anchor", fixed: false, readAt: "2026-10-03T01:00:00.053Z", state: "eligible" },
    { name: "explicit current anchor", fixed: true, readAt: "2026-10-03T01:00:00.053Z", state: "future" },
    { name: "old observation", fixed: false, readAt: "2026-10-03T00:50:00.000Z", state: "stale" },
  ])("preserves freshness boundaries for $name after an asynchronous read", async ({ fixed, readAt, state }) => {
    const id = "3c4be88b-947f-465d-9ce3-aff28891d274";
    const start = "2026-10-03T01:00:00.000Z";
    vi.useFakeTimers();
    vi.setSystemTime(start);
    try {
      const result = await recallPlatformInformationForUser({ userId: "owner", question: `current record ${id}`,
        sections: ["registry"], ...(fixed ? { requestedTimePolicy: { mode: "current" as const, now: start, maxAgeMs: 300000 } } : {}) }, {
        readRecords: vi.fn(async () => {
          await Promise.resolve();
          vi.setSystemTime("2026-10-03T01:00:00.100Z");
          return { requestedIds: [id], requestedNames: [], records: [{ source: "interactionNotes", id, fields: { id, content: "saved note" } }],
            failedSources: [], missingIds: [], freshness: "live_read" as const, observedAt: readAt, instruction: "Owner records" };
        }),
        checkEvidence: vi.fn(async () => ({ provider: "typesafe" as const, mode: "off" as const, status: "disabled" as const, elapsedMs: 0 })),
        inspectWork: vi.fn(), listLoops: vi.fn(), listArchitectureMemories: vi.fn(), listSnapshots: vi.fn(), listGrants: vi.fn(),
        listKnowledgeDocuments: vi.fn(), listToolCapabilities: vi.fn(),
      });
      expect(result.evidenceTime.policy).toMatchObject({ mode: "current", now: fixed ? start : "2026-10-03T01:00:00.100Z" });
      expect(result.evidenceTime.checks).toContainEqual(expect.objectContaining({ evidenceId: `interactionNotes:${id}`, state }));
    } finally { vi.useRealTimers(); }
  });
  it("keeps original multi-part obligations when the model narrows its record query", async () => {
    const id = "3c4be88b-947f-465d-9ce3-aff28891d274";
    const question = id;
    const readRecords = vi.fn(async () => ({ requestedIds: [id], requestedNames: [],
      records: [{ source: "loops", id, fields: { id, triggerConfig: { type: "manual" } } }], failedSources: [], missingIds: [],
      freshness: "live_read" as const, observedAt: new Date().toISOString(), instruction: "Owner records" }));
    const result = await recallPlatformInformationForUser({ userId: "owner", question,
      originalQuestion: `Loop ${id} 何时触发、能做哪些动作、如何审核？`, sections: ["registry"] }, {
      readRecords, inspectWork: vi.fn(), listLoops: vi.fn(), listArchitectureMemories: vi.fn(), listSnapshots: vi.fn(), listGrants: vi.fn(),
      listKnowledgeDocuments: vi.fn(), listToolCapabilities: vi.fn(),
    });
    expect(readRecords).toHaveBeenCalledExactlyOnceWith({ userId: "owner", question });
    expect(result.answerCoverage.obligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestedFields: ["triggerConfig"], status: "evidence_available" }),
      expect.objectContaining({ requestedFields: ["actionPolicy"], missingFields: ["actionPolicy"] }),
      expect.objectContaining({ requestedFields: ["approvalPolicy", "boundaryPolicy"], status: "unobserved" }),
    ]));
  });
  it("uses a scoped change-event reader instead of treating a Work ID as an event ID", async () => {
    const question = "自选股猎手最近被修改过吗，时间是什么时候，修改了哪些内容";
    const readChanges = vi.fn(async () => ({ status: "read" as const, observedAt: "2026-09-24T00:00:00Z",
      workshop: { id: "3153b95e-df02-4d31-9949-04f19e4eb8d4", name: "自选股猎手", updatedAt: "2026-09-14T21:52:57Z" },
      events: [{ id: "event-1", seq: 1, type: "configuration_updated", title: "池子检查要求已更新",
        body: "新增前检查容量", createdAt: "2026-09-14T20:00:18Z" }],
      coverage: { returnedCount: 1, hasMore: false, nextBeforeSeq: null, scope: "owner_visible_workshop_change_events",
        order: "event_sequence_descending", warning: "bounded" } }));
    const result = await recallPlatformInformationForUser({ userId: "owner", question, sections: ["changes"], limit: 8 }, {
      readChanges: readChanges as any, inspectWork: vi.fn(), listLoops: vi.fn(), listSnapshots: vi.fn(), listGrants: vi.fn(),
      listArchitectureMemories: vi.fn(), listKnowledgeDocuments: vi.fn(), listToolCapabilities: vi.fn(),
    });
    expect(readChanges).toHaveBeenCalledExactlyOnceWith({ userId: "owner", question, limit: 8 });
    expect(result.data.changes).toMatchObject({ status: "read", events: [{ type: "configuration_updated" }] });
    expect(result.ok).toBe(true);
  });
  it("uses a resolved owner-visible Work to list its Loops despite an exact name hit", async () => {
    const workId = "3153b95e-df02-4d31-9949-04f19e4eb8d4";
    const listLoops = vi.fn(async () => ({ ok: true, data: { success: true,
      workshopId: workId, loops: [{ id: "780bf494-0095-4b8a-8d0b-3c6dd4996858", workshopId: workId }] },
      text: "loops", isError: false }));
    const result = await recallPlatformInformationForUser({ userId: "owner",
      question: "“自选股猎手”现在运行情况？", sections: ["loops"] }, {
      readRecords: vi.fn(async () => ({ requestedIds: [], requestedNames: ["自选股猎手"],
        records: [{ source: "workshops", id: workId, fields: { id: workId, name: "自选股猎手" } },
          { source: "brainMemories", id: "unrelated", fields: { id: "unrelated", content: "large unrelated history" } }],
        failedSources: [], missingIds: [], freshness: "live_read" as const,
        observedAt: "2026-09-24T00:00:00Z", instruction: "Owner records" })),
      inspectWork: vi.fn(), listLoops: listLoops as any, listSnapshots: vi.fn(), listGrants: vi.fn(),
      listArchitectureMemories: vi.fn(), listKnowledgeDocuments: vi.fn(), listToolCapabilities: vi.fn(),
    });
    expect(listLoops).toHaveBeenCalledExactlyOnceWith({ userId: "owner", workshopId: workId,
      includeArchived: false, limit: 32 });
    expect(result.data.loops).toMatchObject({ data: { loops: [{ workshopId: workId }] } });
    expect(result.data.loops).not.toHaveProperty("text");
    expect(result.data.records).toMatchObject({ selectionScope: "owner_visible_work_identity_for_scoped_loop_list",
      records: [{ source: "workshops" }] });
  });
  it("automatically reads runtime for an exact owner-visible Loop ID", async () => {
    const loopId = "780bf494-0095-4b8a-8d0b-3c6dd4996858";
    const readRuntime = vi.fn(async () => ({ status: "no_active_linked_execution_observed" as const,
      provider: "workshop_execution_leases" as const, loopId,
      observedAt: "2026-09-24T00:00:00Z", maximumHeartbeatAgeMs: 120000,
      linkedExecution: null, warning: "No active linked execution observed." }));
    const result = await recallPlatformInformationForUser({ userId: "owner", question: `Loop ${loopId} 现在是否在运行？` }, {
      readRecords: vi.fn(async () => ({ requestedIds: [loopId], requestedNames: [],
        records: [{ source: "loops", id: loopId, fields: { id: loopId, status: "active" } },
          { source: "loopStates", id: loopId, fields: { loopId, currentPhase: "error" } }],
        failedSources: [], missingIds: [], freshness: "live_read" as const,
        observedAt: "2026-09-24T00:00:00Z", instruction: "Owner records" })),
      readRuntime: readRuntime as any, inspectWork: vi.fn(), listSnapshots: vi.fn(), listGrants: vi.fn(),
      listLoops: vi.fn(), listArchitectureMemories: vi.fn(), listKnowledgeDocuments: vi.fn(),
      listToolCapabilities: vi.fn(),
    });
    expect(readRuntime).toHaveBeenCalledExactlyOnceWith({ userId: "owner", loopId });
    expect(result.data.runtimeObservation).toMatchObject({ status: "no_active_linked_execution_observed" });
    expect(result.claimBoundary.currentExecutor).toMatchObject({ status: "not_observed",
      observationStatus: "no_active_linked_execution_observed" });
  });
  it("does not guess a runtime target when two exact Loop IDs are requested", async () => {
    const first = "780bf494-0095-4b8a-8d0b-3c6dd4996858";
    const second = "3c4be88b-947f-465d-9ce3-aff28891d274";
    const readRuntime = vi.fn();
    const result = await recallPlatformInformationForUser({ userId: "owner",
      question: `Loop ${first} 和 ${second} 现在是否在运行？` }, {
      readRecords: vi.fn(async () => ({ requestedIds: [first, second], requestedNames: [],
        records: [first, second].map(id => ({ source: "loops", id, fields: { id, status: "active" } })),
        failedSources: [], missingIds: [], freshness: "live_read" as const,
        observedAt: "2026-09-24T00:00:00Z", instruction: "Owner records" })),
      readRuntime: readRuntime as any, inspectWork: vi.fn(), listSnapshots: vi.fn(), listGrants: vi.fn(),
      listLoops: vi.fn(), listArchitectureMemories: vi.fn(), listKnowledgeDocuments: vi.fn(),
      listToolCapabilities: vi.fn(),
    });
    expect(readRuntime).not.toHaveBeenCalled();
    expect(result.data.runtimeObservation).toMatchObject({ status: "multiple_loop_targets_unread",
      pendingReads: [{ loopId: first }, { loopId: second }] });
    expect(result.claimBoundary.currentExecutor).toMatchObject({ status: "not_observed",
      observationStatus: "multiple_loop_targets_unread" });
    expect("runtimeReadPlan" in result ? result.runtimeReadPlan : undefined).toMatchObject({ status: "runtime_reads_required",
      pendingReads: [{ loopId: first }, { loopId: second }] });
  });
  it("marks a failed explicit runtime read as unavailable, not an absent executor", async () => {
    const loopId = "780bf494-0095-4b8a-8d0b-3c6dd4996858";
    const result = await recallPlatformInformationForUser({ userId: "owner", runtimeRead: { loopId } }, {
      readRuntime: vi.fn(async () => { throw Error("database unavailable"); }),
      inspectWork: vi.fn(), listSnapshots: vi.fn(), listGrants: vi.fn(), listLoops: vi.fn(),
      listArchitectureMemories: vi.fn(), listKnowledgeDocuments: vi.fn(), listToolCapabilities: vi.fn(),
    });
    expect(result.isError).toBe(true);
    expect(result.data.runtimeObservation).toMatchObject({ status: "source_unavailable" });
    expect(result.claimBoundary.currentExecutor).toMatchObject({ status: "not_observed", observationStatus: "source_unavailable" });
  });
  it("marks an automatic runtime source failure without hiding the available historical record", async () => {
    const loopId = "780bf494-0095-4b8a-8d0b-3c6dd4996858";
    const id = "ac8466bc-213d-8042-a70c-0e7241117ae1";
    const result = await recallPlatformInformationForUser({ userId: "owner", question: `运行 ${id} 的此刻执行器状态？` }, {
      readRecords: vi.fn(async () => ({ requestedIds: [id], requestedNames: [],
        records: [{ source: "loopRuns", id, fields: { id, loopId, status: "blocked" } }],
        failedSources: [], missingIds: [], freshness: "live_read" as const,
        observedAt: "2026-09-24T00:00:00Z", instruction: "Owner records" })),
      readRuntime: vi.fn(async () => { throw Error("database unavailable"); }),
      inspectWork: vi.fn(), listSnapshots: vi.fn(), listGrants: vi.fn(), listLoops: vi.fn(),
      listArchitectureMemories: vi.fn(), listKnowledgeDocuments: vi.fn(), listToolCapabilities: vi.fn(),
    });
    expect(result.ok).toBe(false);
    expect(result.data.records).toMatchObject({ records: [{ source: "loopRuns", id }] });
    expect(result.data.runtimeObservation).toMatchObject({ status: "source_unavailable" });
    expect(result.claimBoundary.currentExecutor).toMatchObject({ status: "not_observed", observationStatus: "source_unavailable" });
  });
  it("automatically reads runtime evidence for a current executor question tied to an exact run", async () => {
    const loopId = "780bf494-0095-4b8a-8d0b-3c6dd4996858";
    const id = "ac8466bc-213d-8042-a70c-0e7241117ae1";
    const readRuntime = vi.fn(async () => ({ status: "no_active_linked_execution_observed" as const,
      provider: "workshop_execution_leases" as const, loopId,
      observedAt: "2026-09-23T12:00:00Z", maximumHeartbeatAgeMs: 120000,
      linkedExecution: null, warning: "No active linked execution observed." }));
    const result = await recallPlatformInformationForUser({ userId: "owner", question: `运行 ${id} 的此刻执行器状态？` }, {
      readRecords: vi.fn(async () => ({ requestedIds: [id], requestedNames: [],
        records: [{ source: "loopRuns", id, fields: { id, loopId, status: "blocked" } }],
        failedSources: [], missingIds: [], freshness: "live_read" as const,
        observedAt: "2026-09-23T12:00:00Z", instruction: "Owner records" })),
      readRuntime: readRuntime as any, inspectWork: vi.fn(), listSnapshots: vi.fn(), listGrants: vi.fn(),
      listLoops: vi.fn(), listArchitectureMemories: vi.fn(), listKnowledgeDocuments: vi.fn(),
      listToolCapabilities: vi.fn(),
    });
    expect(readRuntime).toHaveBeenCalledWith({ userId: "owner", loopId });
    expect(result.data.runtimeObservation).toMatchObject({ status: "no_active_linked_execution_observed" });
    expect(result.claimBoundary.currentExecutor).toMatchObject({ status: "not_observed",
      observationStatus: "no_active_linked_execution_observed" });
  });
  it("exposes an owner-scoped later-run query without calling status recovery proven", async () => {
    const loopId = "780bf494-0095-4b8a-8d0b-3c6dd4996858";
    const afterRunId = "ac8466bc-213d-8042-a70c-0e7241117ae1";
    const readTimeline = vi.fn(async () => ({ status: "read" as const, loopId, afterRunId, runs: [],
      completionGate: "timeline_window_complete" as const, coverage: { hasMore: false, nextCursorRunId: null } }));
    const result = await recallPlatformInformationForUser({ userId: "owner", timelineRead: { loopId, afterRunId } }, {
      readTimeline: readTimeline as any, inspectWork: vi.fn(), listSnapshots: vi.fn(), listGrants: vi.fn(), listLoops: vi.fn(),
      listArchitectureMemories: vi.fn(), listKnowledgeDocuments: vi.fn(), listToolCapabilities: vi.fn(),
    });
    expect(readTimeline).toHaveBeenCalledWith({ userId: "owner", loopId, afterRunId });
    expect(result.data.timeline).toMatchObject({ status: "read", runs: [] });
    expect(result.completionGate).toBe("timeline_window_complete");
  });
  it.each(["后来恢复了吗", "失败后有没有新的运行，故障修复了吗"]) ("automatically reads a bounded owner-scoped timeline for %s", async suffix => {
    const loopId = "780bf494-0095-4b8a-8d0b-3c6dd4996858";
    const id = "ac8466bc-213d-8042-a70c-0e7241117ae1";
    const result = await recallPlatformInformationForUser({ userId: "owner", question: `运行 ${id} ${suffix}` }, {
      readRecords: vi.fn(async () => ({ requestedIds: [id], requestedNames: [], records: [{ source: "loopRuns", id, fields: { id, loopId, status: "blocked" } }],
        failedSources: [], missingIds: [], freshness: "live_read" as const, observedAt: "2026-09-23T00:00:00Z", instruction: "Owner records" })),
      readTimeline: vi.fn(async () => ({ status: "read" as const, loopId, afterRunId: id, runs: [],
        completionGate: "timeline_window_complete" as const, coverage: { hasMore: false, nextCursorRunId: null } })) as any,
      inspectWork: vi.fn(), listSnapshots: vi.fn(), listGrants: vi.fn(), listLoops: vi.fn(), listArchitectureMemories: vi.fn(),
      listKnowledgeDocuments: vi.fn(), listToolCapabilities: vi.fn(),
    });
    expect(result.data.timeline).toMatchObject({ status: "read", runs: [] });
    expect(result.completionGate).toMatchObject({ status: "timeline_window_complete" });
    expect(result.claimBoundary).toMatchObject({ laterRuns: { status: "none_observed_at_read_time" },
      currentExecutor: { status: "not_observed" }, repair: { status: "not_established_by_timeline_or_persisted_state" } });
  });
  it("requires continuation before a partial record page can be called complete", async () => {
    const id = "3c4be88b-947f-465d-9ce3-aff28891d274";
    const readRecord = vi.fn(async () => ({ status: "read" as const, source: "loopRuns", id,
      content: "{\"source\":", contentHash: "hash-1", offset: 0, nextOffset: 8000,
      truncated: true, totalCharacters: 12000 }));
    const result = await recallPlatformInformationForUser({ userId: "owner", recordRead: { source: "loopRuns", id, expectedHash: "hash-1" } }, {
      readRecord: readRecord as any, inspectWork: vi.fn(), listSnapshots: vi.fn(), listGrants: vi.fn(), listLoops: vi.fn(),
      listArchitectureMemories: vi.fn(), listKnowledgeDocuments: vi.fn(), listToolCapabilities: vi.fn(),
    });
    expect(result.completionGate).toMatchObject({ status: "record_read_continuation_required",
      nextRead: { source: "loopRuns", id, offset: 8000, expectedHash: "hash-1" } });
    expect(JSON.parse(result.text).completionGate.status).toBe("record_read_continuation_required");
    expect(readRecord).toHaveBeenCalledWith({ userId: "owner", source: "loopRuns", id, expectedHash: "hash-1" });
  });
  it("marks an exact projected record as pending when the question asks for its omitted verification", async () => {
    const id = "3c4be88b-947f-465d-9ce3-aff28891d274";
    const result = await recallPlatformInformationForUser({ userId: "owner", question: `请展开 ${id} 的验证结果` }, {
      readRecords: vi.fn(async () => ({ requestedIds: [id], requestedNames: [], records: [{ source: "loopRuns", id, fields: { id, status: "blocked", verificationResult: { detail: "x".repeat(3000) } } }],
        failedSources: [], missingIds: [], freshness: "live_read" as const, observedAt: "2026-09-23T00:00:00Z", instruction: "Owner records" })),
      inspectWork: vi.fn(), listSnapshots: vi.fn(), listGrants: vi.fn(), listLoops: vi.fn(), listArchitectureMemories: vi.fn(),
      listKnowledgeDocuments: vi.fn(), listToolCapabilities: vi.fn(),
    });
    expect(result.completionGate).toMatchObject({ status: "exact_record_read_required", pendingReads: [{ source: "loopRuns", id, offset: 0 }] });
    expect(JSON.parse(result.text).completionGate).toMatchObject({ status: "exact_record_read_required" });
  });
  it("defaults an exact ID question to owner-checked records instead of broad live sections", async () => {
    const id = "3c4be88b-947f-465d-9ce3-aff28891d274";
    const listSnapshots = vi.fn();
    const inspectWork = vi.fn();
    const result = await recallPlatformInformationForUser({ userId: "owner", question: `请核对 ${id}` }, {
      readRecords: vi.fn(async () => ({ requestedIds: [id], requestedNames: [], records: [{ source: "loopRuns", id, fields: { id, status: "blocked" } }],
        failedSources: [], missingIds: [], freshness: "live_read" as const, observedAt: "2026-09-23T00:00:00Z", instruction: "Owner records" })),
      inspectWork, listSnapshots, listGrants: vi.fn(), listLoops: vi.fn(), listArchitectureMemories: vi.fn(),
      listKnowledgeDocuments: vi.fn(), listToolCapabilities: vi.fn(),
    });
    expect(result.sections).toEqual([]);
    expect(result.data.records).toMatchObject({ records: [{ source: "loopRuns", id }] });
    expect(listSnapshots).not.toHaveBeenCalled();
    expect(inspectWork).not.toHaveBeenCalled();
  });
  it("bounds snapshot discovery and keeps exact-version expansion under the same owner", async () => {
    const snapshots = Array.from({ length: 6 }, (_, i) => ({
      id: `00000000-0000-4000-8000-00000000000${i}`,
      userId: "owner", scope: { type: "global" as const }, snapshotType: "work_state",
      content: { error: "context window", payload: "x".repeat(30000) },
      sourceMemoryIds: [], metadata: { tail: `private-tail-${i}` }, createdAt: "2026-09-19T00:00:00.000Z",
    }));
    const listSnapshots = vi.fn(async () => snapshots);
    const result = await recallPlatformInformationForUser({ userId: "owner", sections: ["brain"], limit: 100 }, {
      listSnapshots, listGrants: vi.fn(async () => []), inspectWork: vi.fn(), listLoops: vi.fn(),
      listArchitectureMemories: vi.fn(), listKnowledgeDocuments: vi.fn(), listToolCapabilities: vi.fn(),
    });
    expect(listSnapshots).toHaveBeenCalledWith({ userId: "owner", limit: 6 });
    const brain = result.data.brain as any;
    expect(brain.snapshots).toHaveLength(5);
    expect(brain.snapshotCoverage).toMatchObject({ hasMore: true, returnedCount: 5, limit: 5 });
    expect(JSON.stringify(brain).length).toBeLessThan(11000);
    expect(result.text).not.toContain("private-tail-");
    expect(result.text).not.toContain(snapshots[5].id);
    expect(brain.snapshots[0]).not.toHaveProperty("content");
    const read = brain.snapshots[0].read;
    const exactReader = vi.fn(async () => [snapshots[0]]);
    const expanded = await listBrainSnapshotsForUser({ userId: "owner", ...read, listSnapshots: exactReader });
    expect(expanded.data).toMatchObject({ status: "read", contentHash: read.expectedHash });
    expect(exactReader).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner", snapshotId: snapshots[0].id, limit: 1 }));
    const changed = await listBrainSnapshotsForUser({ userId: "owner", ...read,
      listSnapshots: vi.fn(async () => [{ ...snapshots[0], content: { error: "changed", payload: "" } }]) });
    expect(changed.data).toMatchObject({ status: "version_changed", content: "" });
  });
  it("cannot turn a trusted historical request into live counts by rewriting the tool query", async () => {
    const readStatistics = vi.fn();
    const result = await recallPlatformInformationForUser({ userId: "u", question: "current memory count", sections: ["registry"],
      requestedTimePolicy: { mode: "unresolved", reason: "Original question requests an unidentified historical snapshot" } }, {
      readStatistics, inspectWork: vi.fn(), listLoops: vi.fn(), listArchitectureMemories: vi.fn(), listSnapshots: vi.fn(), listGrants: vi.fn(), listKnowledgeDocuments: vi.fn(), listToolCapabilities: vi.fn(),
    });
    expect(readStatistics).not.toHaveBeenCalled();
    expect(result.data.statistics).toMatchObject({ status: "unsupported_time", results: [] });
    expect(result.evidenceTime.checks).toContainEqual(expect.objectContaining({ evidenceId: "statistics", state: "unknown" }));
  });
  it.each(["截至快照，车间心跳表中有记录吗？", "截至 2026-09-19T00:00:00Z，有多少条记忆？"])("does not substitute current counts for historical statistics: %s", async question => {
    const readStatistics = vi.fn();
    const result = await recallPlatformInformationForUser({ userId: "user-1", question, sections: ["registry"] }, {
      readStatistics, inspectWork: vi.fn(), listLoops: vi.fn(), listArchitectureMemories: vi.fn(), listSnapshots: vi.fn(), listGrants: vi.fn(), listKnowledgeDocuments: vi.fn(), listToolCapabilities: vi.fn(),
    });
    expect(readStatistics).not.toHaveBeenCalled();
    expect(result.data.statistics).toMatchObject({ status: "unsupported_time", results: [], capabilityScope: "this_current_statistics_reader_only" });
    expect(result.evidenceTime.checks).toContainEqual(expect.objectContaining({ evidenceId: "statistics", state: "unknown" }));
    expect(JSON.parse(result.text).data.statistics).not.toHaveProperty("observedAt");
  });
  it.each(["shadow", "active"] as const)("keeps all architecture evidence in %s mode", async mode => {
    const result = await recallPlatformInformationForUser({ userId: "user-1", question: "Architecture", sections: ["architecture"] }, {
      checkEvidence: vi.fn(async () => ({ provider: "typesafe" as const, mode, status: "ok" as const, elapsedMs: 1, relevance: [{ id: "a", score: 0.1 }, { id: "b", score: 0.9 }], coverage: [{ question: "Architecture", support: 0.2 }] })),
      listArchitectureMemories: vi.fn(async () => [memory({ id: "a" }), memory({ id: "b" })]),
      listSnapshots: vi.fn(), listGrants: vi.fn(), inspectWork: vi.fn(), listLoops: vi.fn(), listKnowledgeDocuments: vi.fn(), listToolCapabilities: vi.fn(),
    });
    const memories = (result.data.architecture as { memories: Array<{ id: string }> }).memories;
    expect(memories.map(memory => memory.id)).toEqual(mode === "active" ? ["b", "a"] : ["a", "b"]);
    expect(result.text.includes('"support"')).toBe(mode === "active");
    expect(result.evidenceCheck.status).toBe("ok");
  });
  it("uses exact child records instead of interpreting every UUID as a Work ID", async () => {
    const id = "3c4be88b-947f-465d-9ce3-aff28891d274";
    const inspectWork = vi.fn();
    const listLoops = vi.fn();
    const readRecords = vi.fn(async () => ({ requestedIds: [id], requestedNames: [], records: [{ source: "loopRuns", id, fields: { id, status: "blocked", error: "context limit" } }], failedSources: [], missingIds: [], freshness: "live_read", observedAt: new Date().toISOString(), instruction: "Use exact evidence" }));
    const result = await recallPlatformInformationForUser({ userId: "user-1", question: id, sections: ["works", "loops"] }, {
      readRecords, inspectWork, listLoops, listArchitectureMemories: vi.fn(), listSnapshots: vi.fn(), listGrants: vi.fn(), listKnowledgeDocuments: vi.fn(), listToolCapabilities: vi.fn(),
    });
    expect(readRecords).toHaveBeenCalledWith({ userId: "user-1", question: id });
    expect(inspectWork).not.toHaveBeenCalled();
    expect(listLoops).not.toHaveBeenCalled();
    expect(result.data.records).toMatchObject({ records: [{ source: "loopRuns", fields: { status: "blocked" } }] });
  });

  it("does not pass a historical snapshot off as current even when just read", async () => {
    const id = "3c4be88b-947f-465d-9ce3-aff28891d274";
    const result = await recallPlatformInformationForUser({ userId: "user-1", question: `${id} 当前状态是什么？`, sections: ["registry"] }, {
      readRecords: vi.fn(async () => ({ requestedIds: [id], requestedNames: [], records: [{ source: "brainStateSnapshots", id, fields: { createdAt: "2026-09-01T00:00:00Z", status: "ready" } }], failedSources: [], missingIds: [], freshness: "live_read", observedAt: new Date().toISOString(), instruction: "Exact evidence" })),
      inspectWork: vi.fn(), listLoops: vi.fn(), listArchitectureMemories: vi.fn(), listSnapshots: vi.fn(), listGrants: vi.fn(), listKnowledgeDocuments: vi.fn(), listToolCapabilities: vi.fn(),
    });
    expect(result.evidenceCheck.status).toBe("disabled");
    expect(result.evidenceTime).toMatchObject({ policy: { mode: "current" }, checks: [{ state: "unknown" }] });
    expect(JSON.parse(result.text).evidenceTime.checks[0].state).toBe("unknown");
    expect(result.data.records).toMatchObject({ records: [{ fields: { status: "ready" } }] });
  });

  it("exposes source failures while retaining evidence from working sources", async () => {
    const id = "3c4be88b-947f-465d-9ce3-aff28891d274";
    const result = await recallPlatformInformationForUser({ userId: "user-1", question: id, sections: ["registry"] }, {
      readRecords: vi.fn(async () => ({ requestedIds: [id], requestedNames: [], records: [{ source: "loops", id, fields: { status: "paused" } }], failedSources: ["loopStates"], missingIds: [], freshness: "live_read", observedAt: "now", instruction: "partial evidence" })),
      inspectWork: vi.fn(), listLoops: vi.fn(), listArchitectureMemories: vi.fn(), listSnapshots: vi.fn(), listGrants: vi.fn(), listKnowledgeDocuments: vi.fn(), listToolCapabilities: vi.fn(),
    });
    expect(result.ok).toBe(false);
    expect(result.warnings.join(" ")).toContain("records");
    expect(result.data.records).toMatchObject({ records: [{ fields: { status: "paused" } }], failedSources: ["loopStates"] });
  });
  it("ranks relevant architecture before applying the response limit", async () => {
    const result = await recallPlatformInformationForUser({ userId: "user-1", question: "provider timeout", sections: ["architecture"], limit: 1 }, {
      listArchitectureMemories: vi.fn(async () => [memory({ id: "irrelevant" }), memory({ id: "provider", subject: "provider timeout", content: "The provider request timeout is configurable." })]),
      listSnapshots: vi.fn(), listGrants: vi.fn(), inspectWork: vi.fn(), listLoops: vi.fn(), listKnowledgeDocuments: vi.fn(), listToolCapabilities: vi.fn(),
    });
    expect(result.data.architecture).toMatchObject({ memories: [{ id: "provider" }] });
  });
  it("keeps a source registry for the main platform information layers", () => {
    expect(PLATFORM_INFORMATION_REGISTRY.map((item) => item.id)).toEqual([
      "architecture_contracts",
      "work_control_models",
      "loop_tasks",
      "workshop_changes",
      "brain_state",
      "knowledge_base",
      "tool_manifest",
    ]);
    expect(
      PLATFORM_INFORMATION_REGISTRY.every((item) => item.permission.length > 0),
    ).toBe(true);
  });

  it("aggregates registry, architecture, Work, Loop, Brain, knowledge, and tool state", async () => {
    const document = {
      id: "doc-1", fileName: "plan.md", contentType: "text/markdown", sizeBytes: 1024, totalChunks: 2,
      uploadedAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z",
    };
    const documentRevision = `ragmeta1:${'a'.repeat(64)}`;
    const knowledgeFixture = {
      ok: true, isError: false,
      status: 'observed', provider: 'postgres', hasMore: false, coverage: 'bounded_owner_metadata_only',
      countSemantics: 'returned_documents_not_total_inventory', warning: 'Metadata is a retrieval lead, not loaded body evidence.',
      sourceUse: { source: 'rag-document-metadata', records: [{ id: document.id, revision: documentRevision,
        projection: { kind: 'metadata', document } }] },
      documents: [{ ...document, revision: documentRevision,
        originControl: { kind: 'independent_saved_text', originalBinaryVerified: false, correctionTarget: 'rag_document' } }],
      count: 1, returnedCount: 1, text: 'plan.md metadata',
    } satisfies Awaited<ReturnType<typeof listKnowledgeBaseDocumentsForUser>>;
    const adapters = {
      listArchitectureMemories: vi.fn(async () => [
        memory({ id: "arch-1" }),
        memory({
          id: "preference-1",
          tags: ["personal"],
          metadata: {},
          content: "Not architecture.",
        }),
      ]),
      listSnapshots: vi.fn(async () => [
        {
          id: "snapshot-1",
          userId: "user-1",
          scope: { type: "global" as const },
          snapshotType: "work_state",
          content: { ready: true },
          sourceMemoryIds: [],
          metadata: {},
          createdAt: "2026-09-19T00:00:00.000Z",
        },
      ]),
      listGrants: vi.fn(async () => [
        {
          id: "grant-1",
          userId: "user-1",
          subjectType: "work" as const,
          scope: { type: "global" as const },
          permissions: ["reference" as const],
        },
      ]),
      inspectWork: vi.fn(async () => ({
        ok: true,
        target: null,
        targetResolution: "not_requested" as const,
        sourceCoverage: { configuration: 'exact_stored_work_version', loopBindings: 'memory_source_unregistered',
          feedback: 'memory_source_unregistered', warning: 'Derived summaries withheld.' },
        listingCoverage: { limit: 100, returned: 1, completeness: "complete" },
        work: null,
        workshops: [
          {
            id: "work-1",
            name: "Research",
            status: "active",
            autonomyLevel: "draft",
          },
        ],
        instruction: "Read the control contract before proposing changes.",
      })),
      listLoops: vi.fn(async () => ({
        ok: true,
        data: {
          success: true,
          loops: [
            {
              id: "loop-1",
              name: "Daily review",
              description: null,
              goal: "Review state",
              status: "active",
              workshopId: "work-1",
              trigger: { type: "manual" },
              updatedAt: "2026-09-19T00:00:00.000Z",
              createdAt: "2026-09-19T00:00:00.000Z",
            },
          ],
        },
        text: "loops",
        isError: false,
      })),
      listKnowledgeDocuments: vi.fn(async () => knowledgeFixture),
      listToolCapabilities: vi.fn(() => ({
        ok: true,
        manifestApiVersion: "openzhiyu.ai/v1alpha1",
        manifestKind: "Workshop",
        tools: [
          {
            name: "platformRecall",
            displayName: "Platform recall",
            description: "Read platform state.",
            capabilities: ["memory_read" as const],
            risk: "low" as const,
            availability: "allow" as const,
            decisionReason: "Read-only.",
          },
        ],
        skills: [],
        application: { availableInCurrentTurn: false, workshopUrl: "/workshop", reviewCreatesWorkshop: false },
        workflow: [],
      })),
    };

    const result = await recallPlatformInformationForUser(
      {
        userId: "user-1",
        question: "How does memory know the platform?",
        sections: [
          "registry",
          "architecture",
          "works",
          "loops",
          "brain",
          "knowledge",
          "tools",
        ],
        limit: 5,
      },
      adapters,
    );

    expect(result.ok).toBe(true);
    expect(result.data.architecture).toMatchObject({
      count: 1,
      memories: [
        {
          id: "arch-1",
          sourcePath: "docs/architecture/zhiyu-control-architecture-contract.md",
        },
      ],
    });
    expect(result.data.works).toMatchObject({
      workshops: [{ id: "work-1" }],
    });
    expect(result.data.brain).toMatchObject({
      snapshots: [{ id: "snapshot-1" }],
      grants: [{ id: "grant-1" }],
    });
    expect(result.data.knowledge).toMatchObject({
      documents: [{ id: "doc-1" }],
    });
    expect(result.data.tools).toMatchObject({
      scope: "platform_manifest_catalog_not_current_permissions",
      catalog: { tools: [{ name: "platformRecall" }] },
    });
    expect(result.warnings.join(" ")).toContain("Live sections");
    expect(adapters.listArchitectureMemories).toHaveBeenCalledWith({
      userId: "user-1",
      statuses: ["active", "verified"],
      memoryTypes: ["fact", "boundary", "system"],
      ownerType: "chat",
      limit: 100,
    });
  });

  it("returns partial data and explicit warnings when a source is unavailable", async () => {
    const result = await recallPlatformInformationForUser(
      {
        userId: "user-1",
        sections: ["registry", "loops"],
      },
      {
        listArchitectureMemories: vi.fn(),
        listSnapshots: vi.fn(),
        listGrants: vi.fn(),
        inspectWork: vi.fn(),
        listLoops: vi.fn(async () => {
          throw new Error("database unavailable");
        }),
        listKnowledgeDocuments: vi.fn(),
        listToolCapabilities: vi.fn(),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.data.registry).toEqual(PLATFORM_INFORMATION_REGISTRY);
    expect(result.data.loops).toMatchObject({
      ok: false,
      error: "database unavailable",
    });
    expect(result.warnings).toContain("Some sections failed to load: loops.");
  });

  it("expands a target Work when the question contains its UUID", async () => {
    const inspectWork = vi.fn(async () => ({
      ok: true,
      target: {
        id: "44861dfc-916f-431f-899b-364ca54f0aa1",
        name: "AI 知识博主",
        mission: "持续生产和复盘 AI 知识内容",
        status: "active",
        autonomyLevel: "auto",
        boundaryPolicy: {},
        modelConfig: {},
        updatedAt: new Date("2026-09-19T00:00:00.000Z"),
      },
      work: {
        id: "44861dfc-916f-431f-899b-364ca54f0aa1",
        name: "AI 知识博主",
        mission: "持续生产和复盘 AI 知识内容",
        status: "active",
        autonomyLevel: "auto",
        boundaryPolicy: {},
        modelConfig: {},
      },
      workshops: [],
      instruction: "Read the control contract before proposing changes.",
    }));

    const result = await recallPlatformInformationForUser(
      {
        userId: "user-1",
        question:
          "查询记录 44861dfc-916f-431f-899b-364ca54f0aa1（AI 知识博主）的使命和当前状态",
        sections: ["works"],
      },
      {
        listArchitectureMemories: vi.fn(),
        listSnapshots: vi.fn(),
        listGrants: vi.fn(),
        inspectWork: inspectWork as any,
        listLoops: vi.fn(),
        listKnowledgeDocuments: vi.fn(),
        listToolCapabilities: vi.fn(),
      },
    );

    expect(inspectWork).toHaveBeenCalledWith({
      userId: "user-1",
      workshopId: "44861dfc-916f-431f-899b-364ca54f0aa1",
    });
    expect(result.data.works).toMatchObject({
      work: {
        name: "AI 知识博主",
        mission: "持续生产和复盘 AI 知识内容",
        status: "active",
      },
    });
  });
});
