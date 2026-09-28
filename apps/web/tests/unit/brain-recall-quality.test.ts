import { describe, expect, it } from "vitest";
import {
  buildBrainRecallQualityReport,
  buildBrainRecallTraceQualityByRequester,
  buildBrainRecallTraceQualitySummary,
} from "@/lib/brain";

describe("brain recall quality", () => {
  it("aggregates recall telemetry without exposing task or memory content", () => {
    const report = buildBrainRecallQualityReport({
      logs: [
        {
          id: "log-1",
          requesterType: "work",
          requesterId: "work-a",
          selectedMemoryIds: ["memory-1"],
          deniedCount: 1,
          omittedCount: 0,
          duplicateCanonicalGroupCount: 0,
          recallProfileIds: ["profile-a"],
          recallProfileIssueCount: 0,
          recallPlannerMode: "llm",
          recallPlannerWarningCount: 0,
          recallRouteCounts: { brain_memory: 1, evidence_read: 1 },
          createdAt: "2026-08-11T00:00:00.000Z",
        },
        {
          id: "log-2",
          requesterType: "work",
          requesterId: "work-a",
          selectedMemoryIds: [],
          deniedCount: 0,
          omittedCount: 2,
          duplicateCanonicalGroupCount: 1,
          recallProfileIds: [],
          recallProfileIssueCount: 1,
          recallPlannerMode: "fallback_rules",
          recallPlannerWarningCount: 1,
          recallRouteCounts: { brain_memory: 1 },
          createdAt: "2026-08-11T01:00:00.000Z",
        },
      ],
      feedback: [
        {
          contextLogId: "log-1",
          workshopId: "work-a",
          outcome: "used",
          associationStatus: 'verified_context',
          createdAt: "2026-08-11T02:00:00.000Z",
        },
        {
          contextLogId: "log-2",
          workshopId: "work-a",
          outcome: "too_narrow",
          associationStatus: 'verified_context',
          createdAt: "2026-08-11T03:00:00.000Z",
        },
        {
          contextLogId: "log-2",
          workshopId: "work-a",
          outcome: "too_broad",
          associationStatus: 'verified_context',
          createdAt: "2026-08-11T03:30:00.000Z",
        },
        {
          contextLogId: "log-2",
          workshopId: "work-a",
          outcome: "missed_boundary",
          associationStatus: 'verified_context',
          createdAt: "2026-08-11T04:00:00.000Z",
        },
      ],
      contextTraces: [
        {
          contextLogId: "log-1",
          requesterType: "work",
          requesterId: "work-a",
          workshopId: "work-a",
          loopId: "loop-a",
          runId: "run-a",
          trace: {
          interfaceVersion: "brain-context-trace.v1",
          selected: [
            {
              id: "memory-1",
              memoryType: "lesson",
              canonicalKind: "lesson",
              reasons: ["keyword_match", "profile_match"],
              evidenceRefCount: 0,
            },
          ],
          omitted: [
            { id: "memory-2", reason: "duplicate_canonical_group" },
          ],
          denied: [{ id: "memory-3", reason: "scope_denied" }],
          warnings: [{ code: "potential_state_conflict" }],
          },
        },
      ],
    });

    expect(report.summary).toMatchObject({
      recallCount: 2,
      emptyRecallCount: 1,
      selectedMemoryCount: 1,
      deniedMemoryCount: 1,
      omittedMemoryCount: 2,
      duplicateCanonicalGroupCount: 1,
      profileIssueCount: 1,
      recallPlannerWarningCount: 1,
      feedbackCount: 4,
    });
    expect(report.feedbackOutcomes).toMatchObject({
      used: 1,
      too_narrow: 1,
      too_broad: 1,
      missed_boundary: 1,
    });
    expect(report.assessments.observability).toMatchObject({
      canAssessMissingRecall: true,
      canAssessRanking: true,
    });
    expect(report.plannerModeCounts).toEqual({
      jev: 0,
      llm: 1,
      fallback_rules: 1,
      unknown: 0,
    });
    expect(report.routeUsage).toEqual([
      { route: "brain_memory", count: 2 },
      { route: "evidence_read", count: 1 },
    ]);
    expect(report.profileUsage).toEqual([{ id: "profile-a", count: 1 }]);
    expect(report.byRequester[0]).toMatchObject({
      requesterId: "work-a",
      recallCount: 2,
      emptyRecallCount: 1,
      duplicateCanonicalGroupCount: 1,
    });
    expect(report.traceQuality).toMatchObject({
      traceCount: 1,
      selectedMemoryCount: 1,
      omittedMemoryCount: 1,
      deniedMemoryCount: 1,
      noEvidenceSelectedCount: 1,
      warningCount: 1,
    });
    expect(report.traceQuality.topOmittedReasons).toEqual([
      { value: "duplicate_canonical_group", count: 1 },
    ]);
    expect(report.traceQualityByRequester[0]).toMatchObject({
      requesterType: "work",
      requesterId: "work-a",
      traceCount: 1,
      issueScore: 8,
    });
    expect(report.traceQualityByLoop[0]).toMatchObject({
      workshopId: "work-a",
      loopId: "loop-a",
      traceCount: 1,
      issueScore: 8,
    });
    expect(report.traceQualityByRun[0]).toMatchObject({
      workshopId: "work-a",
      loopId: "loop-a",
      runId: "run-a",
      traceCount: 1,
      issueScore: 8,
    });
    expect(report.feedbackTraceDiagnosticsByLoop[0]).toMatchObject({
      workshopId: "work-a",
      loopId: "loop-a",
      feedbackCount: 1,
      diagnosticScore: 0,
      feedbackOutcomes: { used: 1 },
      traceQuality: expect.objectContaining({
        traceCount: 1,
        noEvidenceSelectedCount: 1,
      }),
    });
    expect(JSON.stringify(report)).not.toContain("memory-1");
  });

  it("does not treat access-policy filtering as evidence of a missing grant", () => {
    const report = buildBrainRecallQualityReport({
      logs: [
        {
          id: "log-1",
          requesterType: "work",
          requesterId: "work-a",
          selectedMemoryIds: ["selected-memory"],
          deniedCount: 348,
          omittedCount: 0,
          duplicateCanonicalGroupCount: 0,
          recallProfileIds: [],
          recallProfileIssueCount: 0,
          recallPlannerMode: "unknown",
          recallPlannerWarningCount: 0,
          recallRouteCounts: {},
          createdAt: "2026-08-11T00:00:00.000Z",
        },
      ],
      feedback: [],
    });

    expect(report.assessments.accessBoundary).toMatchObject({
      filteredCandidateCount: 348,
      status: "policy_enforced",
      grantGapEvidence: "insufficient",
      eligibleForGrantProposal: false,
    });
    expect(report.assessments.observability).toMatchObject({
      feedbackStatus: "unobserved",
      canAssessMissingRecall: false,
      canAssessRanking: false,
    });
  });

  it("summarizes ContextPack trace reasons without memory content", () => {
    const traceQuality = buildBrainRecallTraceQualitySummary({
      contextTraces: [
        {
          selected: [
            {
              id: "memory-a",
              memoryType: "boundary",
              canonicalKind: "boundary",
              contentPreview: "do not expose",
              reasons: ["pinned_boundary"],
              evidenceRefCount: 1,
            },
            {
              id: "memory-b",
              memoryType: "lesson",
              canonicalKind: "lesson",
              contentPreview: "do not expose either",
              reasons: ["semantic_match", "semantic_match"],
              evidenceRefCount: 0,
            },
          ],
          omitted: [
            { id: "memory-c", reason: "duplicate_canonical_group" },
            { id: "memory-c", reason: "duplicate_canonical_group" },
          ],
          denied: [{ id: "memory-d", reason: "scope_denied" }],
          warnings: [{ code: "potential_state_conflict" }],
        },
      ],
    });

    expect(traceQuality).toMatchObject({
      traceCount: 1,
      selectedMemoryCount: 2,
      omittedMemoryCount: 2,
      deniedMemoryCount: 1,
      noEvidenceSelectedCount: 1,
      warningCount: 1,
    });
    expect(traceQuality.topSelectedCanonicalKinds).toEqual([
      { value: "boundary", count: 1 },
      { value: "lesson", count: 1 },
    ]);
    expect(traceQuality.topSelectedReasons).toEqual([
      { value: "semantic_match", count: 2 },
      { value: "pinned_boundary", count: 1 },
    ]);
    expect(traceQuality.topOmittedMemoryIds).toEqual([
      { value: "memory-c", count: 2 },
    ]);
    expect(JSON.stringify(traceQuality)).not.toContain("do not expose");
  });

  it("groups ContextPack trace quality by requester", () => {
    const byRequester = buildBrainRecallTraceQualityByRequester({
      contextTraces: [
        {
          requesterType: "work",
          requesterId: "work-risky",
          trace: {
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
            denied: [{ id: "memory-b", reason: "scope_denied" }],
            warnings: [{ code: "potential_state_conflict" }],
          },
        },
        {
          requesterType: "work",
          requesterId: "work-clean",
          trace: {
            selected: [
              {
                memoryType: "boundary",
                canonicalKind: "boundary",
                reasons: ["pinned_boundary"],
                evidenceRefCount: 1,
              },
            ],
            omitted: [],
            denied: [],
            warnings: [],
          },
        },
      ],
    });

    expect(byRequester[0]).toMatchObject({
      requesterType: "work",
      requesterId: "work-risky",
      traceCount: 1,
      noEvidenceSelectedCount: 1,
      issueScore: 8,
    });
    expect(byRequester[1]).toMatchObject({
      requesterId: "work-clean",
      issueScore: 0,
    });
  });

  it("groups ContextPack trace quality by loop and run", () => {
    const report = buildBrainRecallQualityReport({
      logs: [],
      feedback: [],
      contextTraces: [
        {
          requesterType: "work",
          requesterId: "work-a",
          workshopId: "work-a",
          loopId: "loop-risky",
          runId: "work-run-1",
          trace: {
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
            warnings: [{ code: "potential_state_conflict" }],
          },
        },
        {
          requesterType: "work",
          requesterId: "work-a",
          workshopId: "work-a",
          loopId: "loop-clean",
          loopRunId: "loop-run-1",
          trace: {
            selected: [
              {
                memoryType: "boundary",
                canonicalKind: "boundary",
                reasons: ["pinned_boundary"],
                evidenceRefCount: 1,
              },
            ],
            omitted: [],
            denied: [],
            warnings: [],
          },
        },
      ],
    });

    expect(report.traceQualityByLoop[0]).toMatchObject({
      workshopId: "work-a",
      loopId: "loop-risky",
      traceCount: 1,
      noEvidenceSelectedCount: 1,
      issueScore: 6,
    });
    expect(report.traceQualityByLoop[1]).toMatchObject({
      loopId: "loop-clean",
      issueScore: 0,
    });
    expect(report.traceQualityByRun).toHaveLength(2);
    expect(report.traceQualityByRun[0]).toMatchObject({
      loopId: "loop-risky",
      runId: "work-run-1",
      loopRunId: null,
      issueScore: 6,
    });
    expect(report.traceQualityByRun[1]).toMatchObject({
      loopId: "loop-clean",
      runId: null,
      loopRunId: "loop-run-1",
      issueScore: 0,
    });
  });

  it("correlates feedback outcomes with loop and run trace reasons by context log", () => {
    const report = buildBrainRecallQualityReport({
      logs: [],
      feedback: [
        {
          contextLogId: "ctx-risky",
          workshopId: "work-a",
          outcome: "too_broad",
          associationStatus: 'verified_context',
          createdAt: "2026-08-11T01:00:00.000Z",
        },
        {
          contextLogId: "ctx-risky",
          workshopId: "work-a",
          outcome: "irrelevant",
          associationStatus: 'verified_context',
          createdAt: "2026-08-11T01:01:00.000Z",
        },
        {
          contextLogId: "ctx-unmatched",
          workshopId: "work-a",
          outcome: "missing",
          createdAt: "2026-08-11T01:02:00.000Z",
        },
      ],
      contextTraces: [
        {
          contextLogId: "ctx-risky",
          requesterType: "work",
          requesterId: "work-a",
          workshopId: "work-a",
          loopId: "loop-risky",
          loopRunId: "loop-run-risky",
          trace: {
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
      ],
    });

    expect(report.feedbackOutcomes).toMatchObject({
      too_broad: 1,
      irrelevant: 1,
      missing: 1,
    });
    expect(report.feedbackTraceDiagnosticsByLoop).toHaveLength(1);
    expect(report.feedbackTraceDiagnosticsByLoop[0]).toMatchObject({
      workshopId: "work-a",
      loopId: "loop-risky",
      feedbackCount: 2,
      diagnosticScore: 6,
      feedbackOutcomes: {
        too_broad: 1,
        irrelevant: 1,
      },
      traceQuality: expect.objectContaining({
        traceCount: 2,
        noEvidenceSelectedCount: 2,
        topOmittedReasons: [
          { value: "duplicate_canonical_group", count: 2 },
        ],
      }),
    });
    expect(report.feedbackTraceDiagnosticsByRun[0]).toMatchObject({
      loopId: "loop-risky",
      runId: null,
      loopRunId: "loop-run-risky",
      feedbackCount: 2,
    });
  });
});
