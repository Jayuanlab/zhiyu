import { listBrainContextLogsForQuality } from "@/lib/memory/context/audit";
import { listMemoryRecallFeedback } from "@/lib/db/queries";
import {
  buildBrainRecallQualityReport,
  isBrainRecallFeedbackOutcome,
  type BrainRecallQualityFeedback,
} from "@/lib/memory/governance/recall-quality";
import type { Workshop, WorkshopEvent } from "@/lib/db/schema";
import { getWorkshop, listWorkshopEvents, listWorkshops } from "./service";
import { syncWorkshopMemoryRecallQualityReviewItems } from "./review-items";

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return asRecord(parsed);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(value: unknown, keys: string[]) {
  const record = asRecord(value);
  for (const key of keys) {
    const item = record[key];
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return null;
}

function feedbackFromEvent(
  event: WorkshopEvent,
  since: Date,
): BrainRecallQualityFeedback[] {
  if (
    event.type !== "memory_recall_feedback" ||
    new Date(event.createdAt) < since
  ) {
    return [];
  }
  const metadata = asRecord(event.metadata);
  if (!isBrainRecallFeedbackOutcome(metadata.outcome)) return [];
  return [
    {
      associationStatus: 'legacy_unverified',
      contextLogId:
        typeof metadata.contextLogId === "string" ? metadata.contextLogId : null,
      workshopId: event.workshopId,
      outcome: metadata.outcome,
      createdAt: new Date(event.createdAt).toISOString(),
    },
  ];
}

function contextPackTraceFromEvent(event: WorkshopEvent, since: Date) {
  if (new Date(event.createdAt) < since) return [];
  const metadata = asRecord(event.metadata);
  const memoryRecall = asRecord(metadata.memoryRecall);
  const contextPack = memoryRecall.contextPack ?? metadata.contextPack;
  const contextLogId =
    typeof memoryRecall.contextLogId === "string" &&
    memoryRecall.contextLogId.trim()
      ? memoryRecall.contextLogId.trim()
      : typeof metadata.contextLogId === "string" && metadata.contextLogId.trim()
        ? metadata.contextLogId.trim()
        : null;
  const record = asRecord(contextPack);
  return record.interfaceVersion === "brain-context-trace.v1"
    ? [
        {
          contextLogId,
          requesterType: "work" as const,
          requesterId: event.workshopId,
          workshopId: event.workshopId,
          loopId:
            typeof event.loopId === "string" && event.loopId.trim()
              ? event.loopId
              : null,
          runId:
            typeof event.runId === "string" && event.runId.trim()
              ? event.runId
              : null,
          loopRunId:
            typeof event.loopRunId === "string" && event.loopRunId.trim()
              ? event.loopRunId
              : null,
          trace: record,
        },
      ]
    : [];
}

function feedbackFromPlatformRecord(
  item: { systemInfo: unknown; createdAt: Date | string },
  since: Date,
): BrainRecallQualityFeedback[] {
  if (new Date(item.createdAt) < since) return [];
  const systemInfo = asRecord(item.systemInfo);
  if (systemInfo.kind !== "memory_recall_feedback") return [];
  if (!isBrainRecallFeedbackOutcome(systemInfo.outcome)) return [];
  return [
    {
      associationStatus: systemInfo.associationStatus === 'verified_context' || systemInfo.associationStatus === 'unlinked'
        ? systemInfo.associationStatus : 'legacy_unverified',
      contextLogId:
        typeof systemInfo.contextLogId === "string"
          ? systemInfo.contextLogId
          : null,
      workshopId:
        typeof systemInfo.workshopId === "string"
          ? systemInfo.workshopId
          : "platform",
      outcome: systemInfo.outcome,
      createdAt: new Date(item.createdAt).toISOString(),
    },
  ];
}

export async function inspectWorkshopMemoryRecallQuality(input: {
  userId: string;
  workshopId: string;
  days?: number;
  maxContextLogs?: number;
  requireStewardRole?: boolean;
  syncReviewItems?: boolean;
}) {
  const days = Math.max(1, Math.min(30, Math.trunc(input.days ?? 7)));
  const maxContextLogs = Math.max(
    10,
    Math.min(2_000, Math.trunc(input.maxContextLogs ?? 500)),
  );
  const workshop = await getWorkshop(input.userId, input.workshopId);
  if (!workshop) throw new Error("Workshop not found");
  const role = firstString(workshop.modelConfig, ["role", "persona"]);
  if (input.requireStewardRole && role !== "memory_recall_steward") {
    throw new Error(
      "Only a memory_recall_steward Work may inspect aggregate recall quality.",
    );
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
  const logs = (
    await listBrainContextLogsForQuality({
      userId: input.userId,
      limit: maxContextLogs,
    })
  ).filter((log) => new Date(log.createdAt) >= since);
  const workshops = await listWorkshops(input.userId, 100);
  const eventGroups = await Promise.all(
    workshops.map((item: Workshop) =>
      listWorkshopEvents(item.id, {
        limit: 200,
        order: "latest",
      }),
    ),
  );
  const feedback = eventGroups
    .flat()
    .flatMap((event) => feedbackFromEvent(event, since));
  const platformFeedbackRecords = await listMemoryRecallFeedback({
    userId: input.userId,
    since,
    limit: 500,
  });
  const platformFeedback = platformFeedbackRecords.flatMap((item) =>
    feedbackFromPlatformRecord(item, since),
  );
  const contextTraces = eventGroups
    .flat()
    .flatMap((event) => contextPackTraceFromEvent(event, since));
  // Persist the same observation window and scope that the owner receives.
  // This is a user-wide sample; attaching a review to a Work does not establish
  // that this Work's own runs are affected by an aggregate finding.
  const report = {
    ...buildBrainRecallQualityReport({
      logs,
      feedback: [...feedback, ...platformFeedback],
      contextTraces,
    }),
    period: {
      days,
      since: since.toISOString(),
      generatedAt: new Date().toISOString(),
    },
    scope: {
      kind: "user_memory_recall_sample" as const,
      reportWorkshopId: input.workshopId,
      includesOtherWorkshops: true as const,
    },
  };
  let reviewItemSync:
    | { status: "skipped" | "synced"; error: null }
    | { status: "failed"; error: string } = {
    status: "skipped",
    error: null,
  };
  if (input.syncReviewItems) throw new Error("Use the explicit memory quality review synchronization command");
  return {
    ...report,
    coverage: {
      workshops: workshops.length,
      contextLogs: logs.length,
      feedbackEvents: feedback.length + platformFeedback.length,
      workshopFeedbackEvents: feedback.length,
      platformFeedbackEvents: platformFeedback.length,
      contextTraceEvents: contextTraces.length,
      contextLogLimitReached: logs.length >= maxContextLogs,
      workshopLimitReached: workshops.length >= 100,
      interpretation:
        "Workshop count is inventory coverage, not an execution-health denominator. A Workshop without a context log in this window is unobserved.",
    },
    auditGuardrails: {
      firstWindowIsBaselineOnly: true,
      recurringIssueRequiresPriorComparableWindow: true,
      accessFilteredCountAloneMayNotTriggerGrantProposal: true,
      noContextLogMeans: "unobserved",
    },
    reviewItemSync,
  };
}

/** Explicit owner maintenance command; inspection itself never writes review items. */
export async function synchronizeWorkshopMemoryRecallQualityReviews(input: {
  userId: string; workshopId: string; days?: number; maxContextLogs?: number;
}) {
  const report = await inspectWorkshopMemoryRecallQuality({ ...input, syncReviewItems: false });
  await syncWorkshopMemoryRecallQualityReviewItems({ workshopId: input.workshopId, report });
  return { ...report, reviewItemSync: { status: "synced" as const, error: null } };
}
