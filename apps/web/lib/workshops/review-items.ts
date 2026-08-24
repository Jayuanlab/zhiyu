import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { deserializeJson, serializeJson } from "@/lib/db/serialization";
import {
  workshopEvents,
  workshopReviewItems,
  type WorkshopEvent,
  type WorkshopOutboxItem,
  type WorkshopReviewItem,
} from "@/lib/db/schema";
import type { LoopDashboardSummary } from "@/lib/loops/dashboard";

export type WorkshopReviewItemKind =
  | "watchlist_proposal"
  | "agent_change_proposal"
  | "memory_recall_change_plan"
  | "memory_recall_governance_proposal"
  | "permission_boundary"
  | "service_error"
  | "memory_recall_quality"
  | "loop_blocker";

export type WorkshopReviewItemStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "dismissed"
  | "superseded";

function record(value: unknown): Record<string, unknown> {
  const parsed = deserializeJson(value as any);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function serializeRecord(value: Record<string, unknown>) {
  return serializeJson(value) as Record<string, unknown>;
}

function normalizeReviewItem<T extends WorkshopReviewItem>(item: T): T {
  return {
    ...item,
    metadata: record(item.metadata),
  };
}

function normalizeEvent<T extends WorkshopEvent>(event: T): T {
  return {
    ...event,
    metadata: record(event.metadata),
  };
}

function riskLevel(value: unknown) {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : null;
}

function compactBody(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > 320 ? `${trimmed.slice(0, 317)}...` : trimmed;
}

function countFromRecord(record: Record<string, unknown>, keys: string[]) {
  return keys.reduce((sum, key) => {
    const value = record[key];
    return sum + (typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function serviceErrorKey(event: WorkshopEvent) {
  const metadata = record(event.metadata);
  const toolName = stringValue(metadata.toolName);
  const scope = event.loopId ?? event.loopRunId ?? event.runId ?? event.workshopId;
  return [event.type, scope, toolName ?? event.title].join(":");
}

function loopBlockerSummary(loop: LoopDashboardSummary) {
  return compactBody(
    [
      loop.blockedReason,
      loop.nextAction,
      loop.latestRun?.error,
      loop.latestRun?.outputSummary,
      loop.latestRun?.modelCheckerReason,
      loop.goal,
    ]
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .join("\n"),
  );
}

function boundaryResult(value: unknown) {
  const root = record(value);
  return record(root.boundary);
}

function boundaryText(outbox: WorkshopOutboxItem) {
  const boundary = boundaryResult(outbox.boundaryResult);
  const violations = Array.isArray(boundary.violations)
    ? boundary.violations.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      )
    : [];
  const warnings = Array.isArray(boundary.warnings)
    ? boundary.warnings.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      )
    : [];
  return compactBody(
    [
      ...violations,
      ...warnings,
      outbox.recipientName ? `Recipient: ${outbox.recipientName}` : null,
      outbox.message,
    ]
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .join("\n"),
  );
}

export function buildWorkshopReviewItemFromLoopBlocker(input: {
  workshopId: string;
  loop: LoopDashboardSummary;
}) {
  const { loop } = input;
  if (loop.dashboardStatus !== "blocked" && loop.dashboardStatus !== "error") {
    return null;
  }

  return {
    workshopId: input.workshopId,
    sourceEventId: null,
    kind: "loop_blocker" as const,
    status: "pending" as const,
    title: loop.name,
    summary: loopBlockerSummary(loop),
    riskLevel: loop.dashboardStatus === "error" ? "high" : "medium",
    metadata: {
      loopId: loop.id,
      loopStatus: loop.status,
      dashboardStatus: loop.dashboardStatus,
      currentPhase: loop.currentPhase,
      latestRunId: loop.latestRun?.id ?? null,
      latestRunStatus: loop.latestRun?.status ?? null,
      blockedReason: loop.blockedReason,
      nextAction: loop.nextAction,
      schedulerStatus: loop.schedulerStatus,
    },
  };
}

export function buildWorkshopReviewItemFromProposalEvent(event: WorkshopEvent) {
  const metadata = record(event.metadata);

  if (event.type === "workshop_agent_change_proposed") {
    return {
      workshopId: event.workshopId,
      sourceEventId: event.id,
      kind: "agent_change_proposal" as const,
      status: "pending" as const,
      title: event.title,
      summary: compactBody(event.body),
      riskLevel: riskLevel(metadata.riskLevel),
      metadata: {
        sourceEventType: event.type,
        proposalKind: metadata.kind ?? "workshop_agent_change_proposal",
        changedFields: Array.isArray(metadata.changedFields)
          ? metadata.changedFields
          : [],
        proposedBy: metadata.proposedBy ?? null,
        workModelVersion: metadata.workModelVersion ?? null,
      },
    };
  }

  if (
    event.type === "memory_recall_change_plan_proposed" &&
    metadata.kind === "memory_recall_change_plan" &&
    metadata.status === "pending_approval"
  ) {
    return {
      workshopId: event.workshopId,
      sourceEventId: event.id,
      kind: "memory_recall_change_plan" as const,
      status: "pending" as const,
      title: event.title,
      summary: compactBody(event.body),
      riskLevel: riskLevel(metadata.riskLevel) ?? "medium",
      metadata: {
        sourceEventType: event.type,
        proposalKind: metadata.kind,
        planId: metadata.planId ?? null,
        planKind: metadata.planKind ?? null,
        sourceProposalEventId: metadata.sourceProposalEventId ?? null,
        sourceProposalReviewItemId: metadata.sourceProposalReviewItemId ?? null,
        sourceResolutionEventId: metadata.sourceResolutionEventId ?? null,
        issueKind: metadata.issueKind ?? null,
        governanceAction: metadata.governanceAction ?? null,
        dryRunSteps: Array.isArray(metadata.dryRunSteps)
          ? metadata.dryRunSteps
          : [],
        rollbackPlan: Array.isArray(metadata.rollbackPlan)
          ? metadata.rollbackPlan
          : [],
        evidenceHints: Array.isArray(metadata.evidenceHints)
          ? metadata.evidenceHints
          : [],
        blockedActions: Array.isArray(metadata.blockedActions)
          ? metadata.blockedActions
          : [],
        executionMode: "dry_run_plan",
        requiresOwnerApproval: true,
        automaticPolicyChange: false,
      },
    };
  }

  if (
    event.type === "memory_recall_governance_proposed" &&
    metadata.kind === "memory_recall_governance_proposal" &&
    metadata.status === "pending_approval"
  ) {
    return {
      workshopId: event.workshopId,
      sourceEventId: event.id,
      kind: "memory_recall_governance_proposal" as const,
      status: "pending" as const,
      title: event.title,
      summary: compactBody(event.body),
      riskLevel: riskLevel(metadata.riskLevel) ?? "medium",
      metadata: {
        sourceEventType: event.type,
        proposalKind: metadata.kind,
        proposalId: metadata.proposalId ?? null,
        sourceReviewItemId: metadata.sourceReviewItemId ?? null,
        issueKind: metadata.issueKind ?? null,
        governanceAction: metadata.governanceAction ?? null,
        governanceActionDetail: metadata.governanceActionDetail ?? null,
        evidenceHints: Array.isArray(metadata.evidenceHints)
          ? metadata.evidenceHints
          : [],
        blockedActions: Array.isArray(metadata.blockedActions)
          ? metadata.blockedActions
          : [],
        automaticPolicyChange: false,
      },
    };
  }

  if (
    event.type === "watchlist_proposal" &&
    metadata.kind === "watchlist_change_proposal" &&
    metadata.status === "pending_approval" &&
    metadata.approvalRequired !== false
  ) {
    return {
      workshopId: event.workshopId,
      sourceEventId: event.id,
      kind: "watchlist_proposal" as const,
      status: "pending" as const,
      title: event.title,
      summary: compactBody(event.body),
      riskLevel: riskLevel(metadata.riskLevel) ?? "medium",
      metadata: {
        sourceEventType: event.type,
        proposalKind: metadata.kind,
        proposalId: metadata.proposalId ?? null,
        before: Array.isArray(metadata.before) ? metadata.before : [],
        after: Array.isArray(metadata.after) ? metadata.after : [],
        add: Array.isArray(metadata.add) ? metadata.add : [],
        remove: Array.isArray(metadata.remove) ? metadata.remove : [],
      },
    };
  }

  return null;
}

export function buildWorkshopReviewItemFromOutboxBoundary(input: {
  workshopId: string;
  outbox: WorkshopOutboxItem;
  sourceEventId?: string | null;
}) {
  if (input.outbox.status !== "blocked") return null;

  const boundary = boundaryResult(input.outbox.boundaryResult);
  const violations = Array.isArray(boundary.violations)
    ? boundary.violations.filter((item): item is string => typeof item === "string")
    : [];
  const warnings = Array.isArray(boundary.warnings)
    ? boundary.warnings.filter((item): item is string => typeof item === "string")
    : [];
  const root = record(input.outbox.boundaryResult);

  return {
    workshopId: input.workshopId,
    sourceEventId: input.sourceEventId ?? null,
    kind: "permission_boundary" as const,
    status: "pending" as const,
    title: input.outbox.recipientName
      ? `Outbox boundary blocked: ${input.outbox.recipientName}`
      : "Outbox boundary blocked",
    summary: boundaryText(input.outbox),
    riskLevel: input.outbox.riskLevel === "high" ? "high" : "medium",
    metadata: {
      sourceEventType: input.sourceEventId ? "outbox_blocked" : null,
      outboxId: input.outbox.id,
      channel: input.outbox.channel,
      recipientName: input.outbox.recipientName,
      outboxStatus: input.outbox.status,
      confidence: input.outbox.confidence,
      riskLevel: input.outbox.riskLevel,
      violations,
      warnings,
      loopId: typeof root.loopId === "string" ? root.loopId : null,
      loopRunId: typeof root.loopRunId === "string" ? root.loopRunId : null,
    },
  };
}

export function buildWorkshopReviewItemFromServiceErrorEvent(
  event: WorkshopEvent,
) {
  if (
    event.visibility === "debug" ||
    !["tool_error", "work_outbox_send_failed", "outbox_auto_send_failed"].includes(
      event.type,
    )
  ) {
    return null;
  }

  const metadata = record(event.metadata);
  const toolName = stringValue(metadata.toolName);
  const error =
    stringValue(metadata.error) ??
    stringValue(record(metadata.result).error) ??
    compactBody(event.body);

  return {
    workshopId: event.workshopId,
    sourceEventId: event.id,
    kind: "service_error" as const,
    status: "pending" as const,
    title: toolName ? `Service error: ${toolName}` : event.title,
    summary: compactBody(error ?? event.body ?? event.title),
    riskLevel: "medium",
    metadata: {
      sourceEventType: event.type,
      serviceKey: serviceErrorKey(event),
      toolName,
      runId: event.runId,
      loopId: event.loopId,
      loopRunId: event.loopRunId,
      error,
    },
  };
}

type MemoryRecallQualityReportForReview = {
  summary?: {
    duplicateCanonicalGroupCount?: number;
  };
  feedbackOutcomes?: Record<string, unknown>;
  feedbackTraceDiagnosticsByLoop?: MemoryRecallFeedbackTraceDiagnosisForReview[];
  feedbackTraceDiagnosticsByRun?: MemoryRecallFeedbackTraceDiagnosisForReview[];
  traceQuality?: {
    noEvidenceSelectedCount?: number;
    warningCount?: number;
    topOmittedReasons?: Array<{ value: string; count: number }>;
    topDeniedReasons?: Array<{ value: string; count: number }>;
  };
  period?: {
    days?: number;
    since?: string;
    generatedAt?: string;
  };
};

type MemoryRecallFeedbackTraceDiagnosisForReview = {
  workshopId?: string | null;
  loopId?: string | null;
  runId?: string | null;
  loopRunId?: string | null;
  feedbackCount?: number;
  diagnosticScore?: number;
  feedbackOutcomes?: Record<string, unknown>;
  traceQuality?: {
    noEvidenceSelectedCount?: number;
    warningCount?: number;
    topOmittedReasons?: Array<{ value: string; count: number }>;
    topDeniedReasons?: Array<{ value: string; count: number }>;
    topSelectedReasons?: Array<{ value: string; count: number }>;
  };
};

type MemoryRecallQualityReviewIssueKind =
  | "missing_or_too_narrow"
  | "ranking_or_scope"
  | "freshness"
  | "no_evidence_selected"
  | "trace_warnings"
  | "duplicate_canonical_groups";

type MemoryRecallQualityGovernanceAdvice = {
  recommendedActions: string[];
  evidenceHints: string[];
  blockedActions: string[];
};

const MEMORY_RECALL_GOVERNANCE_ADVICE: Record<
  MemoryRecallQualityReviewIssueKind,
  MemoryRecallQualityGovernanceAdvice
> = {
  missing_or_too_narrow: {
    recommendedActions: [
      "Review requester intent and recall profile scope.",
      "Check whether required memories were denied by boundary policy before proposing any grant.",
      "Add or repair evidence-backed canonical memories if the source facts are missing.",
    ],
    evidenceHints: [
      "feedbackOutcomes.missing",
      "feedbackOutcomes.too_narrow",
      "feedbackOutcomes.missed_boundary",
      "traceQuality.topDeniedReasons",
    ],
    blockedActions: [
      "Do not widen access policy from filtered counts alone.",
      "Do not inject raw history into prompts as a shortcut.",
    ],
  },
  ranking_or_scope: {
    recommendedActions: [
      "Inspect top selected reasons and requester-specific recall parameters.",
      "Reclassify memories whose canonical kind or subject does not match the requester task.",
      "Tune deduplication or ranking rules before increasing context size.",
    ],
    evidenceHints: [
      "feedbackOutcomes.irrelevant",
      "feedbackOutcomes.too_broad",
      "feedbackOutcomes.wrong_scope",
      "traceQuality.topSelectedReasons",
    ],
    blockedActions: [
      "Do not solve irrelevant recall by sending more candidates to the prompt.",
    ],
  },
  freshness: {
    recommendedActions: [
      "Review whether stale memories should be superseded, downgraded to evidence, or refreshed from source.",
      "Check source freshness and replacement rules for the affected canonical group.",
    ],
    evidenceHints: [
      "feedbackOutcomes.stale",
      "feedbackOutcomes.stale_state",
      "memory.updatedAt",
      "source.lastObservedAt",
    ],
    blockedActions: [
      "Do not delete old memories without preserving audit history or replacement evidence.",
    ],
  },
  no_evidence_selected: {
    recommendedActions: [
      "Attach source evidence references to selected canonical memories.",
      "Downgrade memories that cannot be traced back to source observations.",
      "Require evidence-backed recall for high-impact requester tasks.",
    ],
    evidenceHints: [
      "traceQuality.noEvidenceSelectedCount",
      "traceQuality.topOmittedReasons",
      "selected.evidenceRefCount",
    ],
    blockedActions: [
      "Do not promote unevidenced summaries into long-term canonical memory.",
    ],
  },
  trace_warnings: {
    recommendedActions: [
      "Inspect trace warnings and group them by requester before changing recall rules.",
      "Repair planner fallback or degraded source warnings if they recur.",
    ],
    evidenceHints: [
      "traceQuality.warningCount",
      "traceQualityByRequester",
      "sourceStatuses.warningCount",
    ],
    blockedActions: [
      "Do not hide degraded sources as successful recall.",
    ],
  },
  duplicate_canonical_groups: {
    recommendedActions: [
      "Merge or link duplicate canonical groups after confirming they represent the same fact.",
      "Tune deduplication keys so repeated facts do not inflate prompt context.",
      "Keep the original source evidence attached to the surviving canonical memory.",
    ],
    evidenceHints: [
      "summary.duplicateCanonicalGroupCount",
      "traceQuality.topSelectedCanonicalKinds",
      "canonicalGroupId",
    ],
    blockedActions: [
      "Do not bulk merge memories without source evidence and rollback notes.",
    ],
  },
};

function topReasonSummary(
  reasons: Array<{ value: string; count: number }> | undefined,
) {
  const usable = (reasons ?? [])
    .filter((item) => item.value && item.count > 0)
    .slice(0, 3);
  if (usable.length === 0) return null;
  return usable.map((item) => `${item.value} (${item.count})`).join(", ");
}

function topFeedbackOutcomeSummary(outcomes: Record<string, unknown> | undefined) {
  const entries = Object.entries(outcomes ?? {})
    .map(([outcome, count]) => ({
      outcome,
      count: typeof count === "number" && Number.isFinite(count) ? count : 0,
    }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count || a.outcome.localeCompare(b.outcome))
    .slice(0, 4);
  return entries.length > 0
    ? entries.map((item) => `${item.outcome} (${item.count})`).join(", ")
    : null;
}

function diagnosisTopReason(
  diagnosis: MemoryRecallFeedbackTraceDiagnosisForReview,
) {
  const trace = diagnosis.traceQuality ?? {};
  return (
    topReasonSummary(trace.topOmittedReasons) ??
    topReasonSummary(trace.topDeniedReasons) ??
    topReasonSummary(trace.topSelectedReasons)
  );
}

function diagnosisPreview(
  diagnosis: MemoryRecallFeedbackTraceDiagnosisForReview,
) {
  const loopId = stringValue(diagnosis.loopId);
  const runId = stringValue(diagnosis.loopRunId) ?? stringValue(diagnosis.runId);
  const feedbackCount =
    typeof diagnosis.feedbackCount === "number" ? diagnosis.feedbackCount : 0;
  const diagnosticScore =
    typeof diagnosis.diagnosticScore === "number"
      ? diagnosis.diagnosticScore
      : 0;
  const topOutcomes = topFeedbackOutcomeSummary(diagnosis.feedbackOutcomes);
  const topReason = diagnosisTopReason(diagnosis);
  return {
    workshopId: stringValue(diagnosis.workshopId),
    loopId,
    runId,
    feedbackCount,
    diagnosticScore,
    topOutcomes,
    topReason,
    noEvidenceSelectedCount:
      typeof diagnosis.traceQuality?.noEvidenceSelectedCount === "number"
        ? diagnosis.traceQuality.noEvidenceSelectedCount
        : 0,
    warningCount:
      typeof diagnosis.traceQuality?.warningCount === "number"
        ? diagnosis.traceQuality.warningCount
        : 0,
  };
}

function diagnosisMatchesIssueKind(
  diagnosis: MemoryRecallFeedbackTraceDiagnosisForReview,
  issueKind: MemoryRecallQualityReviewIssueKind,
) {
  const outcomes = diagnosis.feedbackOutcomes ?? {};
  const trace = diagnosis.traceQuality ?? {};
  if (issueKind === "missing_or_too_narrow") {
    return (
      countFromRecord(outcomes, ["missing", "too_narrow", "missed_boundary"]) >
        0 ||
      (trace.topDeniedReasons ?? []).some((item) => item.count > 0)
    );
  }
  if (issueKind === "ranking_or_scope") {
    return (
      countFromRecord(outcomes, [
        "irrelevant",
        "too_broad",
        "wrong_scope",
        "incorrect",
        "conflicting",
      ]) > 0
    );
  }
  if (issueKind === "freshness") {
    return countFromRecord(outcomes, ["stale", "stale_state"]) > 0;
  }
  if (issueKind === "no_evidence_selected") {
    return (
      typeof trace.noEvidenceSelectedCount === "number" &&
      trace.noEvidenceSelectedCount > 0
    );
  }
  if (issueKind === "trace_warnings") {
    return typeof trace.warningCount === "number" && trace.warningCount > 0;
  }
  if (issueKind === "duplicate_canonical_groups") {
    return (trace.topOmittedReasons ?? []).some(
      (item) => item.value === "duplicate_canonical_group" && item.count > 0,
    );
  }
  return false;
}

function topDiagnosisPreviewsForIssue(input: {
  report: MemoryRecallQualityReportForReview;
  issueKind: MemoryRecallQualityReviewIssueKind;
}) {
  const loops = (input.report.feedbackTraceDiagnosticsByLoop ?? [])
    .filter((item) => diagnosisMatchesIssueKind(item, input.issueKind))
    .slice(0, 4)
    .map(diagnosisPreview);
  const runs = (input.report.feedbackTraceDiagnosticsByRun ?? [])
    .filter((item) => diagnosisMatchesIssueKind(item, input.issueKind))
    .slice(0, 4)
    .map(diagnosisPreview);
  return { loops, runs };
}

function diagnosisActionKind(issueKind: MemoryRecallQualityReviewIssueKind) {
  if (issueKind === "ranking_or_scope") return "dedupe_recall_ranking_scope";
  if (issueKind === "missing_or_too_narrow") {
    return "dedupe_recall_missing_scope";
  }
  if (issueKind === "duplicate_canonical_groups") {
    return "dedupe_canonical_group_review";
  }
  if (issueKind === "no_evidence_selected") {
    return "dedupe_evidence_attachment_review";
  }
  if (issueKind === "freshness") return "dedupe_freshness_review";
  return "dedupe_trace_warning_review";
}

function diagnosisScopeLabel(input: {
  loops: ReturnType<typeof diagnosisPreview>[];
  runs: ReturnType<typeof diagnosisPreview>[];
}) {
  const loopIds = input.loops
    .map((item) => item.loopId)
    .filter((item): item is string => Boolean(item))
    .slice(0, 2);
  const runIds = input.runs
    .map((item) => item.runId)
    .filter((item): item is string => Boolean(item))
    .slice(0, 2);
  const parts = [
    loopIds.length > 0 ? `loops ${loopIds.join(", ")}` : null,
    runIds.length > 0 ? `runs ${runIds.join(", ")}` : null,
  ].filter((item): item is string => Boolean(item));
  return parts.length > 0 ? parts.join("; ") : "affected loop/run diagnostics";
}

function diagnosisGovernanceAction(input: {
  issueKind: MemoryRecallQualityReviewIssueKind;
  diagnosis: {
    loops: ReturnType<typeof diagnosisPreview>[];
    runs: ReturnType<typeof diagnosisPreview>[];
  };
}) {
  if (input.diagnosis.loops.length === 0 && input.diagnosis.runs.length === 0) {
    return null;
  }
  const scope = diagnosisScopeLabel(input.diagnosis);
  const label = `Create deduplicated ${input.issueKind} governance proposal for ${scope}.`;
  return {
    label,
    actionKind: diagnosisActionKind(input.issueKind),
    issueKind: input.issueKind,
    affectedLoops: input.diagnosis.loops,
    affectedRuns: input.diagnosis.runs,
    automaticPolicyChange: false,
    requiresOwnerApproval: true,
  };
}

function buildMemoryRecallQualityIssue(input: {
  workshopId: string;
  issueKind: MemoryRecallQualityReviewIssueKind;
  count: number;
  riskLevel: "low" | "medium" | "high";
  title: string;
  summary: string;
  report: MemoryRecallQualityReportForReview;
}) {
  const advice = MEMORY_RECALL_GOVERNANCE_ADVICE[input.issueKind];
  const diagnosis = topDiagnosisPreviewsForIssue({
    report: input.report,
    issueKind: input.issueKind,
  });
  const diagnosisAction = diagnosisGovernanceAction({
    issueKind: input.issueKind,
    diagnosis,
  });
  const diagnosisActions = diagnosisAction
    ? [
        diagnosisAction.label,
        "Compare feedback outcomes with trace reasons to decide whether the fix is ranking, scope, evidence, freshness, or boundary.",
      ]
    : [];
  const diagnosisEvidenceHints =
    diagnosis.loops.length > 0 || diagnosis.runs.length > 0
      ? [
          "feedbackTraceDiagnosticsByLoop",
          "feedbackTraceDiagnosticsByRun",
          "contextLogId",
        ]
      : [];
  return {
    workshopId: input.workshopId,
    sourceEventId: null,
    kind: "memory_recall_quality" as const,
    status: "pending" as const,
    title: input.title,
    summary: compactBody(input.summary),
    riskLevel: input.riskLevel,
    metadata: {
      issueKind: input.issueKind,
      issueCount: input.count,
      periodDays: input.report.period?.days ?? null,
      periodSince: input.report.period?.since ?? null,
      generatedAt: input.report.period?.generatedAt ?? null,
      source: "memory_recall_quality_report",
      automaticPolicyChange: false,
      recommendedActions: [...diagnosisActions, ...advice.recommendedActions],
      evidenceHints: [...diagnosisEvidenceHints, ...advice.evidenceHints],
      blockedActions: advice.blockedActions,
      feedbackTraceDiagnostics: diagnosis,
      governanceActionDetails: diagnosisAction ? [diagnosisAction] : [],
    },
  };
}

export function buildWorkshopReviewItemsFromMemoryRecallQuality(input: {
  workshopId: string;
  report: MemoryRecallQualityReportForReview;
}) {
  const feedback = input.report.feedbackOutcomes ?? {};
  const trace = input.report.traceQuality ?? {};
  const summary = input.report.summary ?? {};
  const items: Array<ReturnType<typeof buildMemoryRecallQualityIssue>> = [];

  const missingCount = countFromRecord(feedback, [
    "missing",
    "too_narrow",
    "missed_boundary",
  ]);
  if (missingCount > 0) {
    items.push(
      buildMemoryRecallQualityIssue({
        workshopId: input.workshopId,
        issueKind: "missing_or_too_narrow",
        count: missingCount,
        riskLevel: "high",
        title: "Memory recall may be missing required context",
        summary:
          "User feedback indicates missing, too-narrow, or boundary-related recall. Review the recall profile, evidence coverage, and access boundary before changing prompts.",
        report: input.report,
      }),
    );
  }

  const rankingCount = countFromRecord(feedback, [
    "irrelevant",
    "too_broad",
    "wrong_scope",
    "incorrect",
    "conflicting",
  ]);
  if (rankingCount > 0) {
    items.push(
      buildMemoryRecallQualityIssue({
        workshopId: input.workshopId,
        issueKind: "ranking_or_scope",
        count: rankingCount,
        riskLevel: "medium",
        title: "Memory recall ranking or scope needs review",
        summary:
          "User feedback indicates irrelevant, too-broad, wrong-scope, incorrect, or conflicting recall. Check classification, deduplication, and requester-specific recall parameters.",
        report: input.report,
      }),
    );
  }

  const freshnessCount = countFromRecord(feedback, ["stale", "stale_state"]);
  if (freshnessCount > 0) {
    items.push(
      buildMemoryRecallQualityIssue({
        workshopId: input.workshopId,
        issueKind: "freshness",
        count: freshnessCount,
        riskLevel: "medium",
        title: "Memory recall freshness needs review",
        summary:
          "User feedback indicates stale recall. Review source freshness, memory replacement rules, and whether old state should be downgraded to evidence.",
        report: input.report,
      }),
    );
  }

  const noEvidenceCount =
    typeof trace.noEvidenceSelectedCount === "number"
      ? trace.noEvidenceSelectedCount
      : 0;
  if (noEvidenceCount > 0) {
    items.push(
      buildMemoryRecallQualityIssue({
        workshopId: input.workshopId,
        issueKind: "no_evidence_selected",
        count: noEvidenceCount,
        riskLevel: "medium",
        title: "Selected memories are missing evidence links",
        summary: [
          "ContextPack trace selected memories without evidence references.",
          topReasonSummary(trace.topOmittedReasons)
            ? `Top omitted reasons: ${topReasonSummary(trace.topOmittedReasons)}.`
            : null,
        ]
          .filter((item): item is string => Boolean(item))
          .join(" "),
        report: input.report,
      }),
    );
  }

  const warningCount =
    typeof trace.warningCount === "number" ? trace.warningCount : 0;
  if (warningCount > 0) {
    items.push(
      buildMemoryRecallQualityIssue({
        workshopId: input.workshopId,
        issueKind: "trace_warnings",
        count: warningCount,
        riskLevel: "low",
        title: "Memory recall trace emitted warnings",
        summary: [
          "ContextPack trace emitted warnings during recall.",
          topReasonSummary(trace.topDeniedReasons)
            ? `Top denied reasons: ${topReasonSummary(trace.topDeniedReasons)}.`
            : null,
        ]
          .filter((item): item is string => Boolean(item))
          .join(" "),
        report: input.report,
      }),
    );
  }

  const duplicateCount =
    typeof summary.duplicateCanonicalGroupCount === "number"
      ? summary.duplicateCanonicalGroupCount
      : 0;
  if (duplicateCount > 0) {
    items.push(
      buildMemoryRecallQualityIssue({
        workshopId: input.workshopId,
        issueKind: "duplicate_canonical_groups",
        count: duplicateCount,
        riskLevel: "medium",
        title: "Memory recall has duplicate canonical groups",
        summary:
          "Recall logs show duplicate canonical groups. Review canonical grouping and deduplication so repeated facts do not inflate prompt context.",
        report: input.report,
      }),
    );
  }

  return items;
}

export async function syncWorkshopMemoryRecallQualityReviewItems(input: {
  workshopId: string;
  report: MemoryRecallQualityReportForReview;
}) {
  const items = buildWorkshopReviewItemsFromMemoryRecallQuality(input);
  const activeIssueKinds = new Set(
    items
      .map((item) => stringValue(item.metadata.issueKind))
      .filter((issueKind): issueKind is string => Boolean(issueKind)),
  );
  const pendingItems = await listPendingWorkshopReviewItems(input.workshopId);
  const pendingMemoryItems = pendingItems.filter(
    (item) => item.kind === "memory_recall_quality",
  );
  const pendingByIssueKind = new Map(
    pendingMemoryItems
      .map((item) => [stringValue(record(item.metadata).issueKind), item] as const)
      .filter(
        (entry): entry is readonly [string, WorkshopReviewItem] =>
          Boolean(entry[0]),
      ),
  );
  const now = new Date();

  for (const item of items) {
    const issueKind = stringValue(item.metadata.issueKind);
    if (!issueKind) continue;
    const existing = pendingByIssueKind.get(issueKind);
    if (existing) {
      await db
        .update(workshopReviewItems)
        .set({
          title: item.title,
          summary: item.summary,
          riskLevel: item.riskLevel,
          metadata: serializeRecord(item.metadata),
          updatedAt: now,
        })
        .where(eq(workshopReviewItems.id, existing.id))
        .returning();
      continue;
    }

    await db.insert(workshopReviewItems).values({
      workshopId: item.workshopId,
      sourceEventId: item.sourceEventId,
      kind: item.kind,
      status: item.status,
      title: item.title,
      summary: item.summary,
      riskLevel: item.riskLevel,
      metadata: serializeRecord(item.metadata),
      createdAt: now,
      updatedAt: now,
    });
  }

  await Promise.all(
    pendingMemoryItems
      .filter((item) => {
        const issueKind = stringValue(record(item.metadata).issueKind);
        return issueKind ? !activeIssueKinds.has(issueKind) : true;
      })
      .map((item) =>
        resolveWorkshopReviewItem({
          workshopId: input.workshopId,
          itemId: item.id,
          status: "superseded",
          metadata: {
            issueKind: record(item.metadata).issueKind,
            reason:
              "Memory recall quality issue is no longer present in the latest report.",
          },
        }),
      ),
  );
}

export async function upsertWorkshopReviewItemFromProposalEvent(
  event: WorkshopEvent,
) {
  const item = buildWorkshopReviewItemFromProposalEvent(event);
  if (!item) return null;

  const now = new Date();
  const [row] = await db
    .insert(workshopReviewItems)
    .values({
      workshopId: item.workshopId,
      sourceEventId: item.sourceEventId,
      kind: item.kind,
      status: item.status,
      title: item.title,
      summary: item.summary,
      riskLevel: item.riskLevel,
      metadata: serializeRecord(item.metadata),
      createdAt: event.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: workshopReviewItems.sourceEventId,
      set: {
        kind: item.kind,
        title: item.title,
        summary: item.summary,
        riskLevel: item.riskLevel,
        metadata: serializeRecord(item.metadata),
        updatedAt: now,
      },
    })
    .returning();

  return row ? normalizeReviewItem(row as WorkshopReviewItem) : null;
}

export async function upsertWorkshopPermissionBoundaryReviewItem(input: {
  workshopId: string;
  outbox: WorkshopOutboxItem;
  sourceEventId?: string | null;
}) {
  const item = buildWorkshopReviewItemFromOutboxBoundary(input);
  if (!item) return null;

  const now = new Date();
  const pendingItems = await listPendingWorkshopReviewItems(input.workshopId);
  const existing = pendingItems.find(
    (candidate) =>
      candidate.kind === "permission_boundary" &&
      record(candidate.metadata).outboxId === input.outbox.id,
  );

  if (existing) {
    const [row] = await db
      .update(workshopReviewItems)
      .set({
        sourceEventId: item.sourceEventId ?? existing.sourceEventId,
        title: item.title,
        summary: item.summary,
        riskLevel: item.riskLevel,
        metadata: serializeRecord(item.metadata),
        updatedAt: now,
      })
      .where(eq(workshopReviewItems.id, existing.id))
      .returning();

    return row ? normalizeReviewItem(row as WorkshopReviewItem) : null;
  }

  const [row] = await db
    .insert(workshopReviewItems)
    .values({
      workshopId: item.workshopId,
      sourceEventId: item.sourceEventId,
      kind: item.kind,
      status: item.status,
      title: item.title,
      summary: item.summary,
      riskLevel: item.riskLevel,
      metadata: serializeRecord(item.metadata),
      createdAt: input.outbox.updatedAt ?? now,
      updatedAt: now,
    })
    .returning();

  return row ? normalizeReviewItem(row as WorkshopReviewItem) : null;
}

export async function upsertWorkshopServiceErrorReviewItem(event: WorkshopEvent) {
  const item = buildWorkshopReviewItemFromServiceErrorEvent(event);
  if (!item) return null;

  const now = new Date();
  const pendingItems = await listPendingWorkshopReviewItems(event.workshopId);
  const existing = pendingItems.find(
    (candidate) =>
      candidate.kind === "service_error" &&
      record(candidate.metadata).serviceKey === item.metadata.serviceKey,
  );

  if (existing) {
    const [row] = await db
      .update(workshopReviewItems)
      .set({
        sourceEventId: item.sourceEventId,
        title: item.title,
        summary: item.summary,
        riskLevel: item.riskLevel,
        metadata: serializeRecord(item.metadata),
        updatedAt: now,
      })
      .where(eq(workshopReviewItems.id, existing.id))
      .returning();

    return row ? normalizeReviewItem(row as WorkshopReviewItem) : null;
  }

  const [row] = await db
    .insert(workshopReviewItems)
    .values({
      workshopId: item.workshopId,
      sourceEventId: item.sourceEventId,
      kind: item.kind,
      status: item.status,
      title: item.title,
      summary: item.summary,
      riskLevel: item.riskLevel,
      metadata: serializeRecord(item.metadata),
      createdAt: event.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: workshopReviewItems.sourceEventId,
      set: {
        kind: item.kind,
        title: item.title,
        summary: item.summary,
        riskLevel: item.riskLevel,
        metadata: serializeRecord(item.metadata),
        updatedAt: now,
      },
    })
    .returning();

  return row ? normalizeReviewItem(row as WorkshopReviewItem) : null;
}

export async function resolveWorkshopReviewItemBySourceEvent(input: {
  workshopId: string;
  sourceEventId: string;
  status: Exclude<WorkshopReviewItemStatus, "pending">;
  metadata?: Record<string, unknown>;
}) {
  const now = new Date();
  const [row] = await db
    .update(workshopReviewItems)
    .set({
      status: input.status,
      resolvedAt: now,
      updatedAt: now,
      metadata: serializeRecord({
        ...(input.metadata ?? {}),
        resolvedFromSourceEventId: input.sourceEventId,
      }),
    })
    .where(
      and(
        eq(workshopReviewItems.workshopId, input.workshopId),
        eq(workshopReviewItems.sourceEventId, input.sourceEventId),
      ),
    )
    .returning();

  return row ? normalizeReviewItem(row as WorkshopReviewItem) : null;
}

export async function resolveWorkshopReviewItem(input: {
  workshopId: string;
  itemId: string;
  status: Exclude<WorkshopReviewItemStatus, "pending">;
  metadata?: Record<string, unknown>;
}) {
  const now = new Date();
  const [existing] = (await db
    .select()
    .from(workshopReviewItems)
    .where(
      and(
        eq(workshopReviewItems.workshopId, input.workshopId),
        eq(workshopReviewItems.id, input.itemId),
      ),
    )
    .limit(1)) as WorkshopReviewItem[];
  const existingMetadata = existing ? record(existing.metadata) : {};
  const [row] = await db
    .update(workshopReviewItems)
    .set({
      status: input.status,
      resolvedAt: now,
      updatedAt: now,
      metadata: serializeRecord({
        ...existingMetadata,
        ...(input.metadata ?? {}),
        resolution: {
          status: input.status,
          ...(input.metadata ?? {}),
          resolvedAt: now.toISOString(),
        },
        resolvedReviewItemId: input.itemId,
      }),
    })
    .where(
      and(
        eq(workshopReviewItems.workshopId, input.workshopId),
        eq(workshopReviewItems.id, input.itemId),
      ),
    )
    .returning();

  return row ? normalizeReviewItem(row as WorkshopReviewItem) : null;
}

export async function resolveWorkshopServiceErrorGroupReviewItems(input: {
  workshopId: string;
  itemId: string;
  status: Exclude<WorkshopReviewItemStatus, "pending">;
  metadata?: Record<string, unknown>;
}) {
  const pendingItems = await listPendingWorkshopReviewItems(input.workshopId);
  const anchor = pendingItems.find(
    (candidate) =>
      candidate.id === input.itemId && candidate.kind === "service_error",
  );
  const serviceKey = anchor ? record(anchor.metadata).serviceKey : null;
  if (typeof serviceKey !== "string" || serviceKey.length === 0) return [];

  const group = pendingItems.filter(
    (candidate) =>
      candidate.kind === "service_error" &&
      record(candidate.metadata).serviceKey === serviceKey,
  );

  const resolved = await Promise.all(
    group.map((item) =>
      resolveWorkshopReviewItem({
        workshopId: input.workshopId,
        itemId: item.id,
        status: input.status,
        metadata: {
          ...(input.metadata ?? {}),
          serviceKey,
          serviceErrorGroupAnchorId: input.itemId,
        },
      }),
    ),
  );
  return resolved.filter((item): item is WorkshopReviewItem => Boolean(item));
}

export async function resolveWorkshopLoopBlockerReviewItem(input: {
  workshopId: string;
  loopId: string;
  status: Exclude<WorkshopReviewItemStatus, "pending">;
  metadata?: Record<string, unknown>;
}) {
  const pendingItems = await listPendingWorkshopReviewItems(input.workshopId);
  const item = pendingItems.find(
    (candidate) =>
      candidate.kind === "loop_blocker" &&
      record(candidate.metadata).loopId === input.loopId,
  );
  if (!item) return null;

  return resolveWorkshopReviewItem({
    workshopId: input.workshopId,
    itemId: item.id,
    status: input.status,
    metadata: {
      ...(input.metadata ?? {}),
      loopId: input.loopId,
    },
  });
}

export async function resolveWorkshopPermissionBoundaryReviewItem(input: {
  workshopId: string;
  outboxId: string;
  status: Exclude<WorkshopReviewItemStatus, "pending">;
  metadata?: Record<string, unknown>;
}) {
  const pendingItems = await listPendingWorkshopReviewItems(input.workshopId);
  const item = pendingItems.find(
    (candidate) =>
      candidate.kind === "permission_boundary" &&
      record(candidate.metadata).outboxId === input.outboxId,
  );
  if (!item) return null;

  return resolveWorkshopReviewItem({
    workshopId: input.workshopId,
    itemId: item.id,
    status: input.status,
    metadata: {
      ...(input.metadata ?? {}),
      outboxId: input.outboxId,
    },
  });
}

export async function syncWorkshopLoopBlockerReviewItems(input: {
  workshopId: string;
  loops: LoopDashboardSummary[];
}) {
  const pendingItems = await listPendingWorkshopReviewItems(input.workshopId);
  const pendingLoopItems = pendingItems.filter(
    (item) => item.kind === "loop_blocker",
  );
  const pendingByLoopId = new Map(
    pendingLoopItems
      .map((item) => [record(item.metadata).loopId, item] as const)
      .filter(
        (entry): entry is readonly [string, WorkshopReviewItem] =>
          typeof entry[0] === "string" && entry[0].length > 0,
      ),
  );
  const activeLoopIds = new Set<string>();
  const now = new Date();

  for (const loop of input.loops) {
    const item = buildWorkshopReviewItemFromLoopBlocker({
      workshopId: input.workshopId,
      loop,
    });
    if (!item) continue;
    activeLoopIds.add(loop.id);
    const existing = pendingByLoopId.get(loop.id);
    if (existing) {
      await db
        .update(workshopReviewItems)
        .set({
          title: item.title,
          summary: item.summary,
          riskLevel: item.riskLevel,
          metadata: serializeRecord(item.metadata),
          updatedAt: now,
        })
        .where(eq(workshopReviewItems.id, existing.id));
      continue;
    }

    await db.insert(workshopReviewItems).values({
      workshopId: item.workshopId,
      sourceEventId: item.sourceEventId,
      kind: item.kind,
      status: item.status,
      title: item.title,
      summary: item.summary,
      riskLevel: item.riskLevel,
      metadata: serializeRecord(item.metadata),
      createdAt: now,
      updatedAt: now,
    });
  }

  await Promise.all(
    pendingLoopItems
      .filter((item) => {
        const loopId = record(item.metadata).loopId;
        return typeof loopId === "string" && !activeLoopIds.has(loopId);
      })
      .map((item) =>
        resolveWorkshopReviewItem({
          workshopId: input.workshopId,
          itemId: item.id,
          status: "superseded",
          metadata: {
            loopId: record(item.metadata).loopId,
            reason: "Loop is no longer blocked in the latest dashboard snapshot.",
          },
        }),
      ),
  );
}

export async function listPendingWorkshopReviewItems(workshopId: string) {
  const rows = (await db
    .select()
    .from(workshopReviewItems)
    .where(
      and(
        eq(workshopReviewItems.workshopId, workshopId),
        eq(workshopReviewItems.status, "pending"),
      ),
    )
    .orderBy(desc(workshopReviewItems.createdAt))
    .limit(200)) as WorkshopReviewItem[];

  return rows.map((row: WorkshopReviewItem) => normalizeReviewItem(row));
}

export async function listWorkshopReviewItemsForSourceEvents(
  workshopId: string,
  sourceEventIds: string[],
) {
  const ids = sourceEventIds.filter(Boolean);
  if (ids.length === 0) return [];

  const rows = (await db
    .select()
    .from(workshopReviewItems)
    .where(
      and(
        eq(workshopReviewItems.workshopId, workshopId),
        inArray(workshopReviewItems.sourceEventId, ids),
      ),
    )) as WorkshopReviewItem[];

  return rows.map((row: WorkshopReviewItem) => normalizeReviewItem(row));
}

export async function listPendingWorkshopReviewSourceEvents(workshopId: string) {
  const items = await listPendingWorkshopReviewItems(workshopId);
  const sourceEventIds = items
    .map((item) => item.sourceEventId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  if (sourceEventIds.length === 0) return [];

  const rows = (await db
    .select()
    .from(workshopEvents)
    .where(
      and(
        eq(workshopEvents.workshopId, workshopId),
        inArray(workshopEvents.id, sourceEventIds),
      ),
    )) as WorkshopEvent[];

  const byId = new Map<string, WorkshopEvent>(
    rows.map((row: WorkshopEvent) => {
      const event = normalizeEvent(row);
      return [event.id, event] as const;
    }),
  );

  return sourceEventIds
    .map((id: string) => byId.get(id))
    .filter((event): event is WorkshopEvent => Boolean(event));
}
