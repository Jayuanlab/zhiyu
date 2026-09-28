import type { BrainRequesterType } from "./types";
import {summarizeEvidenceQuality} from './evidence-quality-summary';

export const BRAIN_RECALL_FEEDBACK_OUTCOMES = [
  "used",
  "irrelevant",
  "missing",
  "too_broad",
  "too_narrow",
  "missed_boundary",
  "wrong_scope",
  "stale_state",
  "stale",
  "incorrect",
  "conflicting",
] as const;

export type BrainRecallFeedbackOutcome =
  (typeof BRAIN_RECALL_FEEDBACK_OUTCOMES)[number];

export type BrainRecallQualityLog = {
  evidenceReadAudit?:unknown;
  id: string;
  requesterType: BrainRequesterType;
  requesterId: string | null;
  selectedMemoryIds: string[];
  deniedCount: number;
  omittedCount: number;
  duplicateCanonicalGroupCount: number;
  recallProfileIds: string[];
  recallProfileIssueCount: number;
  recallPlannerMode: "llm" | "fallback_rules" | "jev" | "unknown";
  recallPlannerWarningCount: number;
  recallRouteCounts: Record<string, number>;
  createdAt: string;
};

export type BrainRecallQualityFeedback = {
  associationStatus?: 'verified_context' | 'unlinked' | 'legacy_unverified';
  contextLogId: string | null;
  workshopId: string;
  outcome: BrainRecallFeedbackOutcome;
  createdAt: string;
};

export type BrainRecallTraceQualitySummary = {
  traceCount: number;
  selectedMemoryCount: number;
  omittedMemoryCount: number;
  deniedMemoryCount: number;
  noEvidenceSelectedCount: number;
  warningCount: number;
  topSelectedMemoryTypes: Array<{ value: string; count: number }>;
  topSelectedCanonicalKinds: Array<{ value: string; count: number }>;
  topSelectedReasons: Array<{ value: string; count: number }>;
  topOmittedReasons: Array<{ value: string; count: number }>;
  topDeniedReasons: Array<{ value: string; count: number }>;
  topOmittedMemoryIds: Array<{ value: string; count: number }>;
  topDeniedMemoryIds: Array<{ value: string; count: number }>;
};

export type BrainRecallTraceQualityInput = {
  contextLogId?: string | null;
  requesterType?: BrainRequesterType | null;
  requesterId?: string | null;
  workshopId?: string | null;
  loopId?: string | null;
  runId?: string | null;
  loopRunId?: string | null;
  trace: unknown;
};

export type BrainRecallTraceQualityByRequester =
  BrainRecallTraceQualitySummary & {
    requesterType: BrainRequesterType | "unknown";
    requesterId: string | null;
    issueScore: number;
  };

export type BrainRecallTraceQualityByLoop =
  BrainRecallTraceQualitySummary & {
    workshopId: string | null;
    loopId: string | null;
    issueScore: number;
  };

export type BrainRecallTraceQualityByRun =
  BrainRecallTraceQualitySummary & {
    workshopId: string | null;
    loopId: string | null;
    runId: string | null;
    loopRunId: string | null;
    issueScore: number;
  };

export type BrainRecallFeedbackTraceDiagnosis = {
  workshopId: string | null;
  loopId: string | null;
  runId?: string | null;
  loopRunId?: string | null;
  feedbackCount: number;
  diagnosticScore: number;
  feedbackOutcomes: Partial<Record<BrainRecallFeedbackOutcome, number>>;
  traceQuality: BrainRecallTraceQualitySummary;
};

export function isBrainRecallFeedbackOutcome(
  value: unknown,
): value is BrainRecallFeedbackOutcome {
  return BRAIN_RECALL_FEEDBACK_OUTCOMES.includes(
    value as BrainRecallFeedbackOutcome,
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function increment(map: Map<string, number>, value: unknown) {
  const text = cleanString(value);
  if (!text) return;
  map.set(text, (map.get(text) ?? 0) + 1);
}

function topEntries(map: Map<string, number>, limit = 8) {
  return [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, limit);
}

function traceRecordFromInput(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  const wrappedTrace = asRecord(record.trace);
  return Object.keys(wrappedTrace).length > 0 ? wrappedTrace : record;
}

export function buildBrainRecallTraceQualitySummary(input: {
  contextTraces: unknown[];
}): BrainRecallTraceQualitySummary {
  const selectedMemoryTypes = new Map<string, number>();
  const selectedCanonicalKinds = new Map<string, number>();
  const selectedReasons = new Map<string, number>();
  const omittedReasons = new Map<string, number>();
  const deniedReasons = new Map<string, number>();
  const omittedMemoryIds = new Map<string, number>();
  const deniedMemoryIds = new Map<string, number>();
  let selectedMemoryCount = 0;
  let omittedMemoryCount = 0;
  let deniedMemoryCount = 0;
  let noEvidenceSelectedCount = 0;
  let warningCount = 0;

  for (const trace of input.contextTraces) {
    const record = traceRecordFromInput(trace);
    for (const selectedItem of asArray(record.selected)) {
      const selected = asRecord(selectedItem);
      selectedMemoryCount += 1;
      increment(selectedMemoryTypes, selected.memoryType);
      increment(selectedCanonicalKinds, selected.canonicalKind);
      for (const reason of asArray(selected.reasons)) {
        increment(selectedReasons, reason);
      }
      const evidenceRefCount =
        typeof selected.evidenceRefCount === "number"
          ? selected.evidenceRefCount
          : 0;
      if (evidenceRefCount <= 0) noEvidenceSelectedCount += 1;
    }
    for (const omittedItem of asArray(record.omitted)) {
      const omitted = asRecord(omittedItem);
      omittedMemoryCount += 1;
      increment(omittedReasons, omitted.reason);
      increment(omittedMemoryIds, omitted.id);
    }
    for (const deniedItem of asArray(record.denied)) {
      const denied = asRecord(deniedItem);
      deniedMemoryCount += 1;
      increment(deniedReasons, denied.reason);
      increment(deniedMemoryIds, denied.id);
    }
    warningCount += asArray(record.warnings).length;
  }

  return {
    traceCount: input.contextTraces.length,
    selectedMemoryCount,
    omittedMemoryCount,
    deniedMemoryCount,
    noEvidenceSelectedCount,
    warningCount,
    topSelectedMemoryTypes: topEntries(selectedMemoryTypes),
    topSelectedCanonicalKinds: topEntries(selectedCanonicalKinds),
    topSelectedReasons: topEntries(selectedReasons),
    topOmittedReasons: topEntries(omittedReasons),
    topDeniedReasons: topEntries(deniedReasons),
    topOmittedMemoryIds: topEntries(omittedMemoryIds),
    topDeniedMemoryIds: topEntries(deniedMemoryIds),
  };
}

function traceRequesterFromInput(value: unknown): {
  requesterType: BrainRequesterType | "unknown";
  requesterId: string | null;
} {
  const record = asRecord(value);
  const requesterType =
    record.requesterType === "chat" ||
    record.requesterType === "work" ||
    record.requesterType === "loop" ||
    record.requesterType === "tool" ||
    record.requesterType === "system"
      ? record.requesterType
      : "unknown";
  return {
    requesterType,
    requesterId: cleanString(record.requesterId),
  };
}

function traceScopeFromInput(value: unknown): {
  contextLogId: string | null;
  workshopId: string | null;
  loopId: string | null;
  runId: string | null;
  loopRunId: string | null;
} {
  const record = asRecord(value);
  return {
    contextLogId: cleanString(record.contextLogId),
    workshopId: cleanString(record.workshopId),
    loopId: cleanString(record.loopId),
    runId: cleanString(record.runId),
    loopRunId: cleanString(record.loopRunId),
  };
}

function feedbackOutcomeWeight(outcome: BrainRecallFeedbackOutcome) {
  switch (outcome) {
    case "missing":
    case "missed_boundary":
    case "wrong_scope":
    case "incorrect":
    case "conflicting":
      return 5;
    case "irrelevant":
    case "too_broad":
    case "too_narrow":
    case "stale_state":
    case "stale":
      return 3;
    case "used":
      return 0;
    default:
      return 1;
  }
}

function traceIssueScore(summary: BrainRecallTraceQualitySummary) {
  return (
    summary.omittedMemoryCount * 2 +
    summary.deniedMemoryCount * 2 +
    summary.noEvidenceSelectedCount * 3 +
    summary.warningCount
  );
}

export function buildBrainRecallTraceQualityByRequester(input: {
  contextTraces: Array<unknown | BrainRecallTraceQualityInput>;
}): BrainRecallTraceQualityByRequester[] {
  const groups = new Map<
    string,
    {
      requesterType: BrainRequesterType | "unknown";
      requesterId: string | null;
      traces: unknown[];
    }
  >();

  for (const item of input.contextTraces) {
    const requester = traceRequesterFromInput(item);
    const key = `${requester.requesterType}:${requester.requesterId ?? ""}`;
    const group = groups.get(key) ?? { ...requester, traces: [] };
    group.traces.push(item);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      const summary = buildBrainRecallTraceQualitySummary({
        contextTraces: group.traces,
      });
      return {
        requesterType: group.requesterType,
        requesterId: group.requesterId,
        issueScore: traceIssueScore(summary),
        ...summary,
      };
    })
    .sort(
      (a, b) =>
        b.issueScore - a.issueScore ||
        b.traceCount - a.traceCount ||
        `${a.requesterType}:${a.requesterId ?? ""}`.localeCompare(
          `${b.requesterType}:${b.requesterId ?? ""}`,
        ),
    )
    .slice(0, 10);
}

export function buildBrainRecallTraceQualityByLoop(input: {
  contextTraces: Array<unknown | BrainRecallTraceQualityInput>;
}): BrainRecallTraceQualityByLoop[] {
  const groups = new Map<
    string,
    {
      workshopId: string | null;
      loopId: string | null;
      traces: unknown[];
    }
  >();

  for (const item of input.contextTraces) {
    const scope = traceScopeFromInput(item);
    if (!scope.loopId) continue;
    const key = `${scope.workshopId ?? ""}:${scope.loopId}`;
    const group = groups.get(key) ?? {
      workshopId: scope.workshopId,
      loopId: scope.loopId,
      traces: [],
    };
    group.traces.push(item);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      const summary = buildBrainRecallTraceQualitySummary({
        contextTraces: group.traces,
      });
      return {
        workshopId: group.workshopId,
        loopId: group.loopId,
        issueScore: traceIssueScore(summary),
        ...summary,
      };
    })
    .sort(
      (a, b) =>
        b.issueScore - a.issueScore ||
        b.traceCount - a.traceCount ||
        `${a.workshopId ?? ""}:${a.loopId ?? ""}`.localeCompare(
          `${b.workshopId ?? ""}:${b.loopId ?? ""}`,
        ),
    )
    .slice(0, 10);
}

export function buildBrainRecallTraceQualityByRun(input: {
  contextTraces: Array<unknown | BrainRecallTraceQualityInput>;
}): BrainRecallTraceQualityByRun[] {
  const groups = new Map<
    string,
    {
      workshopId: string | null;
      loopId: string | null;
      runId: string | null;
      loopRunId: string | null;
      traces: unknown[];
    }
  >();

  for (const item of input.contextTraces) {
    const scope = traceScopeFromInput(item);
    if (!scope.runId && !scope.loopRunId) continue;
    const key = [
      scope.workshopId ?? "",
      scope.loopId ?? "",
      scope.runId ?? "",
      scope.loopRunId ?? "",
    ].join(":");
    const group = groups.get(key) ?? { ...scope, traces: [] };
    group.traces.push(item);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      const summary = buildBrainRecallTraceQualitySummary({
        contextTraces: group.traces,
      });
      return {
        workshopId: group.workshopId,
        loopId: group.loopId,
        runId: group.runId,
        loopRunId: group.loopRunId,
        issueScore: traceIssueScore(summary),
        ...summary,
      };
    })
    .sort(
      (a, b) =>
        b.issueScore - a.issueScore ||
        b.traceCount - a.traceCount ||
        `${a.workshopId ?? ""}:${a.loopId ?? ""}:${a.runId ?? ""}:${
          a.loopRunId ?? ""
        }`.localeCompare(
          `${b.workshopId ?? ""}:${b.loopId ?? ""}:${b.runId ?? ""}:${
            b.loopRunId ?? ""
          }`,
        ),
    )
    .slice(0, 10);
}

function buildContextTraceIndex(input: {
  contextTraces: Array<unknown | BrainRecallTraceQualityInput>;
}) {
  const index = new Map<
    string,
    {
      scope: ReturnType<typeof traceScopeFromInput>;
      trace: unknown;
    }
  >();
  for (const item of input.contextTraces) {
    const scope = traceScopeFromInput(item);
    if (!scope.contextLogId) continue;
    index.set(scope.contextLogId, {
      scope,
      trace: item,
    });
  }
  return index;
}

function buildBrainRecallFeedbackTraceDiagnostics(input: {
  contextTraces: Array<unknown | BrainRecallTraceQualityInput>;
  feedback: BrainRecallQualityFeedback[];
  groupBy: "loop" | "run";
}): BrainRecallFeedbackTraceDiagnosis[] {
  const traceByContextLogId = buildContextTraceIndex({
    contextTraces: input.contextTraces,
  });
  const groups = new Map<
    string,
    {
      workshopId: string | null;
      loopId: string | null;
      runId: string | null;
      loopRunId: string | null;
      feedbackCount: number;
      diagnosticScore: number;
      feedbackOutcomes: Partial<Record<BrainRecallFeedbackOutcome, number>>;
      traces: unknown[];
    }
  >();

  for (const feedback of input.feedback) {
    if (!feedback.contextLogId) continue;
    const matched = traceByContextLogId.get(feedback.contextLogId);
    if (!matched) continue;
    const { scope } = matched;
    if (!scope.loopId) continue;
    if (input.groupBy === "run" && !scope.runId && !scope.loopRunId) continue;
    const key =
      input.groupBy === "loop"
        ? `${scope.workshopId ?? ""}:${scope.loopId}`
        : [
            scope.workshopId ?? "",
            scope.loopId ?? "",
            scope.runId ?? "",
            scope.loopRunId ?? "",
          ].join(":");
    const group = groups.get(key) ?? {
      workshopId: scope.workshopId,
      loopId: scope.loopId,
      runId: input.groupBy === "run" ? scope.runId : null,
      loopRunId: input.groupBy === "run" ? scope.loopRunId : null,
      feedbackCount: 0,
      diagnosticScore: 0,
      feedbackOutcomes: {},
      traces: [],
    };
    group.feedbackCount += 1;
    group.diagnosticScore += feedbackOutcomeWeight(feedback.outcome);
    group.feedbackOutcomes[feedback.outcome] =
      (group.feedbackOutcomes[feedback.outcome] ?? 0) + 1;
    group.traces.push(matched.trace);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({
      workshopId: group.workshopId,
      loopId: group.loopId,
      runId: input.groupBy === "run" ? group.runId : undefined,
      loopRunId: input.groupBy === "run" ? group.loopRunId : undefined,
      feedbackCount: group.feedbackCount,
      diagnosticScore: group.diagnosticScore,
      feedbackOutcomes: group.feedbackOutcomes,
      traceQuality: buildBrainRecallTraceQualitySummary({
        contextTraces: group.traces,
      }),
    }))
    .sort(
      (a, b) =>
        b.diagnosticScore - a.diagnosticScore ||
        b.feedbackCount - a.feedbackCount ||
        `${a.workshopId ?? ""}:${a.loopId ?? ""}:${a.runId ?? ""}:${
          a.loopRunId ?? ""
        }`.localeCompare(
          `${b.workshopId ?? ""}:${b.loopId ?? ""}:${b.runId ?? ""}:${
            b.loopRunId ?? ""
          }`,
        ),
    )
    .slice(0, 10);
}

export function buildBrainRecallQualityReport(input: {
  logs: BrainRecallQualityLog[];
  feedback: BrainRecallQualityFeedback[];
  contextTraces?: Array<unknown | BrainRecallTraceQualityInput>;
}) {
  const feedbackOutcomes = Object.fromEntries(
    BRAIN_RECALL_FEEDBACK_OUTCOMES.map((outcome) => [outcome, 0]),
  ) as Record<BrainRecallFeedbackOutcome, number>;
  const verifiedFeedback = input.feedback.filter(item => item.associationStatus === 'verified_context' && Boolean(item.contextLogId));
  const verifiedFeedbackOutcomes = Object.fromEntries(
    BRAIN_RECALL_FEEDBACK_OUTCOMES.map(outcome => [outcome, 0]),
  ) as Record<BrainRecallFeedbackOutcome, number>;
  for (const item of verifiedFeedback) verifiedFeedbackOutcomes[item.outcome] += 1;
  const contextIds = new Set(input.logs.map(log => log.id));
  const feedbackQuality = {
    scope: 'sampled_feedback' as const,
    sampledFeedbackCount: input.feedback.length,
    verifiedContextCount: verifiedFeedback.length,
    unlinkedCount: input.feedback.filter(item => item.associationStatus === 'unlinked' && !item.contextLogId).length,
    legacyUnverifiedCount: input.feedback.filter(item => !item.associationStatus || item.associationStatus === 'legacy_unverified').length,
    invalidAssociationCount: input.feedback.filter(item =>
      (item.associationStatus === 'verified_context' && !item.contextLogId) ||
      (item.associationStatus === 'unlinked' && Boolean(item.contextLogId))).length,
    verifiedContextInLogSampleCount: verifiedFeedback.filter(item => contextIds.has(item.contextLogId!)).length,
    verifiedContextOutsideLogSampleCount: verifiedFeedback.filter(item => !contextIds.has(item.contextLogId!)).length,
    verifiedAssociationRate: input.feedback.length ? verifiedFeedback.length / input.feedback.length : null,
    interpretation: 'Association verification is not human label accuracy. Missing sampled logs may be outside the time/size window or deleted. Legacy and unlinked opinions do not establish traceable recall quality.',
  };
  const profileCounts = new Map<string, number>();
  const requesterCounts = new Map<
    string,
    {
      requesterType: BrainRequesterType;
      requesterId: string | null;
      recallCount: number;
      emptyRecallCount: number;
      deniedMemoryCount: number;
      omittedMemoryCount: number;
      duplicateCanonicalGroupCount: number;
    }
  >();
  const plannerModeCounts = {
    jev: 0,
    llm: 0,
    fallback_rules: 0,
    unknown: 0,
  };
  const routeCounts = new Map<string, number>();

  for (const log of input.logs) {
    for (const [route, count] of Object.entries(log.recallRouteCounts)) {
      routeCounts.set(route, (routeCounts.get(route) ?? 0) + count);
    }
    for (const profileId of log.recallProfileIds) {
      profileCounts.set(profileId, (profileCounts.get(profileId) ?? 0) + 1);
    }
    const key = `${log.requesterType}:${log.requesterId ?? ""}`;
    const current = requesterCounts.get(key) ?? {
      requesterType: log.requesterType,
      requesterId: log.requesterId,
      recallCount: 0,
      emptyRecallCount: 0,
      deniedMemoryCount: 0,
      omittedMemoryCount: 0,
      duplicateCanonicalGroupCount: 0,
    };
    current.recallCount += 1;
    current.emptyRecallCount += log.selectedMemoryIds.length === 0 ? 1 : 0;
    current.deniedMemoryCount += log.deniedCount;
    current.omittedMemoryCount += log.omittedCount;
    current.duplicateCanonicalGroupCount += log.duplicateCanonicalGroupCount;
    requesterCounts.set(key, current);
    plannerModeCounts[log.recallPlannerMode] += 1;
  }

  for (const feedback of input.feedback) {
    feedbackOutcomes[feedback.outcome] += 1;
  }

  const recallCount = input.logs.length;
  const emptyRecallCount = input.logs.filter(
    (log) => log.selectedMemoryIds.length === 0,
  ).length;
  const deniedMemoryCount = input.logs.reduce(
    (sum, log) => sum + log.deniedCount,
    0,
  );
  const feedbackCount = input.feedback.length;
  const traceQuality = buildBrainRecallTraceQualitySummary({
    contextTraces: input.contextTraces ?? [],
  });
  const traceQualityByRequester = buildBrainRecallTraceQualityByRequester({
    contextTraces: input.contextTraces ?? [],
  });
  const traceQualityByLoop = buildBrainRecallTraceQualityByLoop({
    contextTraces: input.contextTraces ?? [],
  });
  const traceQualityByRun = buildBrainRecallTraceQualityByRun({
    contextTraces: input.contextTraces ?? [],
  });
  const feedbackTraceDiagnosticsByLoop =
    buildBrainRecallFeedbackTraceDiagnostics({
      contextTraces: input.contextTraces ?? [],
      feedback: verifiedFeedback,
      groupBy: "loop",
    });
  const feedbackTraceDiagnosticsByRun =
    buildBrainRecallFeedbackTraceDiagnostics({
      contextTraces: input.contextTraces ?? [],
      feedback: verifiedFeedback,
      groupBy: "run",
    });

  return {
    interfaceVersion: "brain-recall-quality.v1" as const,
    evidenceQuality:summarizeEvidenceQuality(input.logs),
    feedbackQuality,
    verifiedFeedbackOutcomes,
    summary: {
      recallCount,
      emptyRecallCount,
      emptyRecallRate: recallCount > 0 ? emptyRecallCount / recallCount : 0,
      selectedMemoryCount: input.logs.reduce(
        (sum, log) => sum + log.selectedMemoryIds.length,
        0,
      ),
      deniedMemoryCount,
      omittedMemoryCount: input.logs.reduce(
        (sum, log) => sum + log.omittedCount,
        0,
      ),
      duplicateCanonicalGroupCount: input.logs.reduce(
        (sum, log) => sum + log.duplicateCanonicalGroupCount,
        0,
      ),
      profileIssueCount: input.logs.reduce(
        (sum, log) => sum + log.recallProfileIssueCount,
        0,
      ),
      recallPlannerWarningCount: input.logs.reduce(
        (sum, log) => sum + log.recallPlannerWarningCount,
        0,
      ),
      feedbackCount,
    },
    assessments: {
      accessBoundary: {
        filteredCandidateCount: deniedMemoryCount,
        status:
          deniedMemoryCount > 0
            ? ("policy_enforced" as const)
            : ("no_filtering_observed" as const),
        grantGapEvidence: "insufficient" as const,
        eligibleForGrantProposal: false,
        interpretation:
          "Access-filtered candidates show that policy enforcement ran. This count alone does not prove that a grant is missing.",
        requiredGrantProposalEvidence: [
          "explicit missing-recall feedback tied to an intended task",
          "owner-confirmed cross-scope need",
          "a narrow proposed scope with regression cases and rollback",
        ],
      },
      observability: {
        feedbackStatus:
          feedbackCount > 0 ? ("observed" as const) : ("unobserved" as const),
        canAssessMissingRecall:
          verifiedFeedbackOutcomes.missing > 0 ||
          verifiedFeedbackOutcomes.too_narrow > 0 ||
          verifiedFeedbackOutcomes.missed_boundary > 0,
        canAssessRanking:
          verifiedFeedbackOutcomes.used > 0 ||
          verifiedFeedbackOutcomes.irrelevant > 0 ||
          verifiedFeedbackOutcomes.too_broad > 0 ||
          verifiedFeedbackOutcomes.wrong_scope > 0,
        canAssessFreshness:
          verifiedFeedbackOutcomes.stale > 0 || verifiedFeedbackOutcomes.stale_state > 0,
        interpretation:
          feedbackCount > 0
            ? "Feedback exists; traceable assessments use only verified context associations and recorded outcomes, not accuracy estimates."
            : "No recall feedback was recorded, so missing recall, ranking quality, freshness, and correctness are not assessable.",
      },
    },
    feedbackOutcomes,
    traceQuality,
    traceQualityByRequester,
    traceQualityByLoop,
    traceQualityByRun,
    feedbackTraceDiagnosticsByLoop,
    feedbackTraceDiagnosticsByRun,
    plannerModeCounts,
    routeUsage: [...routeCounts.entries()]
      .map(([route, count]) => ({ route, count }))
      .sort((a, b) => b.count - a.count || a.route.localeCompare(b.route)),
    profileUsage: [...profileCounts.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    byRequester: [...requesterCounts.values()].sort(
      (a, b) =>
        b.recallCount - a.recallCount ||
        `${a.requesterType}:${a.requesterId ?? ""}`.localeCompare(
          `${b.requesterType}:${b.requesterId ?? ""}`,
        ),
    ),
  };
}
