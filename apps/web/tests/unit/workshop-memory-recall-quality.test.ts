import { beforeEach, describe, expect, it, vi } from "vitest";

const listBrainContextLogsForQualityMock = vi.hoisted(() => vi.fn());
const listMemoryRecallFeedbackMock = vi.hoisted(() => vi.fn());
const getWorkshopMock = vi.hoisted(() => vi.fn());
const listWorkshopEventsMock = vi.hoisted(() => vi.fn());
const listWorkshopsMock = vi.hoisted(() => vi.fn());
const syncMemoryRecallQualityReviewItemsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/brain/repository", () => ({
  listBrainContextLogsForQuality: listBrainContextLogsForQualityMock,
}));

vi.mock("@/lib/db/queries", () => ({
  listMemoryRecallFeedback: listMemoryRecallFeedbackMock,
}));

vi.mock("@/lib/workshops/service", () => ({
  getWorkshop: getWorkshopMock,
  listWorkshopEvents: listWorkshopEventsMock,
  listWorkshops: listWorkshopsMock,
}));

vi.mock("@/lib/workshops/review-items", () => ({
  syncWorkshopMemoryRecallQualityReviewItems:
    syncMemoryRecallQualityReviewItemsMock,
}));

import { inspectWorkshopMemoryRecallQuality } from "@/lib/workshops/memory-recall-quality";

describe("workshop memory recall quality", () => {
  beforeEach(() => {
    listBrainContextLogsForQualityMock.mockReset();
    listMemoryRecallFeedbackMock.mockReset();
    getWorkshopMock.mockReset();
    listWorkshopEventsMock.mockReset();
    listWorkshopsMock.mockReset();
    syncMemoryRecallQualityReviewItemsMock.mockReset();

    getWorkshopMock.mockResolvedValue({
      id: "workshop-1",
      modelConfig: { role: "memory_recall_steward" },
    });
    listBrainContextLogsForQualityMock.mockResolvedValue([]);
    listMemoryRecallFeedbackMock.mockResolvedValue([]);
    listWorkshopsMock.mockResolvedValue([{ id: "workshop-1" }]);
    listWorkshopEventsMock.mockResolvedValue([]);
    syncMemoryRecallQualityReviewItemsMock.mockResolvedValue(undefined);
  });

  it("includes platform-level memory recall feedback in quality reports", async () => {
    listMemoryRecallFeedbackMock.mockResolvedValue([
      {
        id: "feedback-1",
        createdAt: new Date(),
        systemInfo: {
          kind: "memory_recall_feedback",
          outcome: "irrelevant",
          contextLogId: "context-log-1",
        },
      },
      {
        id: "feedback-ignored",
        createdAt: new Date(),
        systemInfo: {
          kind: "remote_feedback",
          outcome: "irrelevant",
        },
      },
    ]);

    const report = await inspectWorkshopMemoryRecallQuality({
      userId: "user-1",
      workshopId: "workshop-1",
      days: 7,
      requireStewardRole: true,
    });

    expect(listMemoryRecallFeedbackMock).toHaveBeenCalledWith({
      userId: "user-1",
      since: expect.any(Date),
      limit: 500,
    });
    expect(report.summary.feedbackCount).toBe(1);
    expect(report.feedbackOutcomes.irrelevant).toBe(1);
    expect(report.coverage.feedbackEvents).toBe(1);
    expect(report.coverage.workshopFeedbackEvents).toBe(0);
    expect(report.coverage.platformFeedbackEvents).toBe(1);
    expect(report.assessments.observability.feedbackStatus).toBe("observed");
    expect(report.assessments.observability.canAssessRanking).toBe(true);
    expect(report.reviewItemSync).toEqual({ status: "skipped", error: null });
    expect(syncMemoryRecallQualityReviewItemsMock).not.toHaveBeenCalled();
  });

  it("can sync memory recall quality issues into review items", async () => {
    const report = await inspectWorkshopMemoryRecallQuality({
      userId: "user-1",
      workshopId: "workshop-1",
      days: 7,
      requireStewardRole: true,
      syncReviewItems: true,
    });

    expect(syncMemoryRecallQualityReviewItemsMock).toHaveBeenCalledWith({
      workshopId: "workshop-1",
      report: expect.objectContaining({
        interfaceVersion: "brain-recall-quality.v1",
      }),
    });
    expect(report.reviewItemSync).toEqual({ status: "synced", error: null });
  });

  it("groups workshop ContextPack traces by loop and run", async () => {
    listWorkshopEventsMock.mockResolvedValue([
      {
        id: "event-1",
        workshopId: "workshop-1",
        runId: "work-run-1",
        loopId: "loop-1",
        loopRunId: "loop-run-1",
        type: "work_completed",
        title: "Work completed",
        body: null,
        metadata: {
          memoryRecall: {
            contextLogId: "context-log-1",
            contextPack: {
              interfaceVersion: "brain-context-trace.v1",
              selected: [
                {
                  memoryType: "lesson",
                  canonicalKind: "lesson",
                  reasons: ["semantic_match"],
                  evidenceRefCount: 0,
                },
              ],
              omitted: [
                { id: "memory-a", reason: "duplicate_canonical_group" },
              ],
              denied: [],
              warnings: [],
            },
          },
        },
        createdAt: new Date().toISOString(),
      },
    ]);

    const report = await inspectWorkshopMemoryRecallQuality({
      userId: "user-1",
      workshopId: "workshop-1",
      days: 7,
      requireStewardRole: true,
    });

    expect(report.traceQualityByLoop[0]).toMatchObject({
      workshopId: "workshop-1",
      loopId: "loop-1",
      traceCount: 1,
      noEvidenceSelectedCount: 1,
    });
    expect(report.traceQualityByRun[0]).toMatchObject({
      workshopId: "workshop-1",
      loopId: "loop-1",
      runId: "work-run-1",
      loopRunId: "loop-run-1",
    });
    expect(report.coverage.contextTraceEvents).toBe(1);
  });

  it("correlates platform feedback with workshop trace dimensions by context log", async () => {
    listMemoryRecallFeedbackMock.mockResolvedValue([
      {
        id: "feedback-1",
        createdAt: new Date(),
        systemInfo: {
          kind: "memory_recall_feedback",
          outcome: "too_broad",
          contextLogId: "context-log-1",
          workshopId: "workshop-1",
        },
      },
    ]);
    listWorkshopEventsMock.mockResolvedValue([
      {
        id: "event-1",
        workshopId: "workshop-1",
        runId: null,
        loopId: "loop-1",
        loopRunId: "loop-run-1",
        type: "work_completed",
        title: "Work completed",
        body: null,
        metadata: {
          memoryRecall: {
            contextLogId: "context-log-1",
            contextPack: {
              interfaceVersion: "brain-context-trace.v1",
              selected: [
                {
                  memoryType: "lesson",
                  canonicalKind: "lesson",
                  reasons: ["semantic_match"],
                  evidenceRefCount: 0,
                },
              ],
              omitted: [],
              denied: [],
              warnings: [],
            },
          },
        },
        createdAt: new Date().toISOString(),
      },
    ]);

    const report = await inspectWorkshopMemoryRecallQuality({
      userId: "user-1",
      workshopId: "workshop-1",
      days: 7,
      requireStewardRole: true,
    });

    expect(report.feedbackTraceDiagnosticsByLoop[0]).toMatchObject({
      workshopId: "workshop-1",
      loopId: "loop-1",
      feedbackCount: 1,
      diagnosticScore: 3,
      feedbackOutcomes: { too_broad: 1 },
      traceQuality: expect.objectContaining({
        traceCount: 1,
        noEvidenceSelectedCount: 1,
      }),
    });
    expect(report.feedbackTraceDiagnosticsByRun[0]).toMatchObject({
      loopId: "loop-1",
      loopRunId: "loop-run-1",
      feedbackCount: 1,
    });
  });
});
