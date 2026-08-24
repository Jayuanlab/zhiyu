import { describe, expect, it } from "vitest";
import {
  buildRunEvidenceBundle,
  diagnoseRunEvidence,
} from "@/lib/harness-evolution";

function evidence(overrides: Record<string, unknown> = {}) {
  return buildRunEvidenceBundle({
    id: "evidence-1",
    userId: "user-1",
    workId: "work-1",
    workRunId: null,
    loopId: "loop-1",
    loopRunId: "loop-run-1",
    workVersionId: "version-1",
    harnessSnapshotId: "snapshot-1",
    componentSetHash: "hash-1",
    runtime: {
      model: "test-model",
      startedAt: "2026-08-12T00:00:00.000Z",
      completedAt: "2026-08-12T00:00:10.000Z",
      durationMs: 10000,
      tokenUsage: { input: 100, output: 20 },
      attemptCount: 1,
    },
    observations: {
      sourceEventIds: ["event-1"],
      freshness: "fresh",
      providerWarnings: [],
    },
    actions: {
      toolCallCount: 1,
      toolNames: ["workshopSearchMemory"],
      deniedCount: 0,
      approvalCount: 0,
      externalActionCount: 0,
    },
    outcome: {
      status: "success",
      verifierPassed: true,
      requiredFieldsMissing: [],
      artifacts: [{ type: "decision", id: "event-2" }],
      errorClass: null,
    },
    evidenceRefs: [
      {
        kind: "workshop_event",
        id: "event-1",
        claim: "Current source was checked.",
        observedAt: "2026-08-12T00:00:01.000Z",
        freshness: "fresh",
        integrity: "verified",
      },
    ],
    captureStatus: "finalized",
    createdAt: "2026-08-12T00:00:10.000Z",
    ...overrides,
  });
}

describe("run evidence", () => {
  it("treats denied candidates as policy enforcement, not a missing grant", () => {
    const bundle = evidence({
      actions: {
        toolCallCount: 1,
        toolNames: ["workshopSearchMemory"],
        deniedCount: 348,
        approvalCount: 0,
        externalActionCount: 0,
      },
    });

    const diagnosis = diagnoseRunEvidence({ bundle, recallFeedback: [] });

    expect(diagnosis.failureClasses).toContain("access_denied_expected");
    expect(diagnosis.failureClasses).not.toContain(
      "access_grant_gap_confirmed",
    );
    expect(diagnosis.status).toBe("completed");
  });

  it("requires explicit missing feedback and owner confirmation for a grant gap", () => {
    const bundle = evidence({
      actions: {
        toolCallCount: 1,
        toolNames: ["workshopSearchMemory"],
        deniedCount: 12,
        approvalCount: 0,
        externalActionCount: 0,
      },
    });

    const diagnosis = diagnoseRunEvidence({
      bundle,
      recallFeedback: ["missing"],
      ownerConfirmedCrossScopeNeed: true,
    });

    expect(diagnosis.failureClasses).toContain("access_grant_gap_confirmed");
    expect(diagnosis.failureClasses).not.toContain("access_denied_expected");
  });

  it("marks stale observations and missing source integrity without hiding them", () => {
    const bundle = evidence({
      observations: {
        sourceEventIds: ["event-missing"],
        freshness: "stale",
        providerWarnings: ["quote provider fallback"],
      },
      evidenceRefs: [
        {
          kind: "workshop_event",
          id: "event-missing",
          claim: "Quote source could not be verified.",
          observedAt: null,
          freshness: "stale",
          integrity: "missing",
        },
      ],
    });

    const diagnosis = diagnoseRunEvidence({ bundle, recallFeedback: [] });

    expect(bundle.completeness).toBe("partial");
    expect(bundle.warnings).toEqual(
      expect.arrayContaining([
        "Observation data is stale.",
        "One or more evidence references are missing.",
        "quote provider fallback",
      ]),
    );
    expect(diagnosis.failureClasses).toContain("data_stale");
    expect(diagnosis.status).toBe("inconclusive");
  });

  it("maps specific recall feedback into memory failure classes", () => {
    const diagnosis = diagnoseRunEvidence({
      bundle: evidence(),
      recallFeedback: ["too_narrow", "too_broad", "stale_state"],
    });

    expect(diagnosis.failureClasses).toEqual(
      expect.arrayContaining([
        "memory_missing",
        "memory_irrelevant",
        "memory_stale",
      ]),
    );
  });
});
