import "server-only";

import { createInteractionProcessingJob } from "@/lib/interactions/processing-jobs";
import {
  listInteractionEvents,
  markInteractionEventsProcessed,
  recordWechatNewMessages,
  type RecordWechatMessagesResult,
} from "@/lib/interactions/service";
import type { InteractionEvent } from "@/lib/db/schema";
import {
  listInteractionSourcePolicies,
  type InteractionSourcePolicyValue,
} from "./source-policies";
import {
  isInteractionEventAllowedBySourcePolicy,
  processingModeForSourcePolicy,
  sourcePolicyMentionAliases,
  type InteractionProcessingMode,
} from "./source-policy-runtime";

export type InteractionIngestionReason =
  | "scheduled"
  | "manual"
  | "startup"
  | "source_policy_changed";

export type InteractionIngestionLastResult = Pick<
  RecordWechatMessagesResult,
  "insertedCount" | "duplicateCount" | "eventCount" | "sourceResults"
> & {
  processingJobsCreated: number;
  queuedEventCount: number;
};

export type InteractionIngestionStatus = {
  isEnabled: boolean;
  isRunning: boolean;
  intervalMs: number;
  nextRunAt: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastStatus: "idle" | "running" | "success" | "error";
  lastReason: InteractionIngestionReason | null;
  lastError: string | null;
  lastResult: InteractionIngestionLastResult | null;
  runCount: number;
};

type MutableStatus = Omit<
  InteractionIngestionStatus,
  "nextRunAt" | "lastStartedAt" | "lastCompletedAt"
> & {
  nextRunAt: Date | null;
  lastStartedAt: Date | null;
  lastCompletedAt: Date | null;
};

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const ACTIVE_POLICIES = new Set<InteractionSourcePolicyValue>([
  "sync",
  "summary",
  "mention_only",
]);
const states = new Map<string, MutableStatus>();

function configuredIntervalMs() {
  const configured = Number(process.env.KNOWLEDGE_PIPELINE_INGESTION_INTERVAL_MS);
  if (Number.isFinite(configured) && configured >= MIN_INTERVAL_MS) {
    return Math.trunc(configured);
  }
  return DEFAULT_INTERVAL_MS;
}

function isIngestionEnabled() {
  return process.env.KNOWLEDGE_PIPELINE_INGESTION_DISABLED !== "true";
}

function initialState(now = new Date()): MutableStatus {
  return {
    isEnabled: isIngestionEnabled(),
    isRunning: false,
    intervalMs: configuredIntervalMs(),
    nextRunAt: now,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastStatus: "idle",
    lastReason: null,
    lastError: null,
    lastResult: null,
    runCount: 0,
  };
}

function getMutableStatus(userId?: string) {
  const key = userId || "__default__";
  const existing = states.get(key);
  if (existing) {
    existing.isEnabled = isIngestionEnabled();
    existing.intervalMs = configuredIntervalMs();
    return existing;
  }
  const created = initialState();
  states.set(key, created);
  return created;
}

function serializeStatus(status: MutableStatus): InteractionIngestionStatus {
  return {
    ...status,
    nextRunAt: status.nextRunAt?.toISOString() ?? null,
    lastStartedAt: status.lastStartedAt?.toISOString() ?? null,
    lastCompletedAt: status.lastCompletedAt?.toISOString() ?? null,
  };
}

function sourceIdForEvent(event: InteractionEvent) {
  return event.conversationId ?? event.conversationName;
}

async function hasEnabledWechatSources(userId: string) {
  const policies = await listInteractionSourcePolicies({
    userId,
    platform: "wechat",
  });
  return policies.some(
    (policy) => policy.enabled && ACTIVE_POLICIES.has(policy.policy),
  );
}

async function enqueueProcessingJobs(input: {
  userId: string;
  events: InteractionEvent[];
}) {
  const policies = await listInteractionSourcePolicies({
    userId: input.userId,
    platform: "wechat",
  });
  const enabledPolicyBySource = new Map(
    policies
      .filter((policy) => policy.enabled && policy.policy !== "ignore")
      .map((policy) => [policy.sourceId, policy]),
  );
  const hasExplicitAllow = policies.some(
    (policy) => policy.enabled && ACTIVE_POLICIES.has(policy.policy),
  );
  const grouped = new Map<InteractionProcessingMode, string[]>();

  for (const event of input.events) {
    const sourceId = sourceIdForEvent(event);
    const policy = enabledPolicyBySource.get(sourceId);
    if (hasExplicitAllow && !policy) continue;
    const policyValue = policy?.policy ?? "sync";
    if (
      !isInteractionEventAllowedBySourcePolicy({
        policy: policyValue,
        event,
        mentionAliases: sourcePolicyMentionAliases({
          metadata: policy?.metadata,
        }),
      })
    ) {
      continue;
    }
    const mode = processingModeForSourcePolicy(policyValue);
    grouped.set(mode, [...(grouped.get(mode) ?? []), event.id]);
  }

  let jobsCreated = 0;
  let queuedEventCount = 0;
  for (const [processingMode, eventIds] of grouped) {
    const uniqueIds = [...new Set(eventIds)];
    if (uniqueIds.length === 0) continue;
    await createInteractionProcessingJob({
      userId: input.userId,
      eventIds: uniqueIds,
      processingMode,
    });
    await markInteractionEventsProcessed({
      userId: input.userId,
      ids: uniqueIds,
      status: "processing",
    });
    jobsCreated += 1;
    queuedEventCount += uniqueIds.length;
  }

  return { jobsCreated, queuedEventCount };
}

async function collectProcessableEvents(input: {
  userId: string;
  insertedEvents: InteractionEvent[];
}) {
  const pendingEvents = await listInteractionEvents({
    userId: input.userId,
    platform: "wechat",
    statuses: ["new"],
    limit: 500,
  });
  return [
    ...new Map(
      [...input.insertedEvents, ...pendingEvents].map((event) => [
        event.id,
        event,
      ]),
    ).values(),
  ];
}

export function getInteractionIngestionStatus(userId?: string) {
  return serializeStatus(getMutableStatus(userId));
}

export function shouldRunInteractionIngestion(userId: string, now = new Date()) {
  const status = getMutableStatus(userId);
  if (!status.isEnabled || status.isRunning) return false;
  if (!status.nextRunAt) return true;
  return status.nextRunAt.getTime() <= now.getTime();
}

export async function runInteractionIngestion(input: {
  signal?: AbortSignal;
  userId: string;
  reason: InteractionIngestionReason;
  limit?: number;
  force?: boolean;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  input.signal?.throwIfAborted();
  const status = getMutableStatus(input.userId);
  if (!status.isEnabled) return serializeStatus(status);
  if (status.isRunning) return serializeStatus(status);
  if (!input.force && !shouldRunInteractionIngestion(input.userId, now)) {
    return serializeStatus(status);
  }

  status.isRunning = true;
  status.lastStatus = "running";
  status.lastReason = input.reason;
  status.lastStartedAt = now;
  status.lastError = null;

  try {
    if (!(await hasEnabledWechatSources(input.userId))) {
      const completedAt = new Date();
      status.isRunning = false;
      status.lastStatus = "success";
      status.lastCompletedAt = completedAt;
      status.nextRunAt = new Date(completedAt.getTime() + status.intervalMs);
      status.runCount += 1;
      status.lastResult = {
        insertedCount: 0,
        duplicateCount: 0,
        eventCount: 0,
        sourceResults: [],
        processingJobsCreated: 0,
        queuedEventCount: 0,
      };
      return serializeStatus(status);
    }

    const result = await recordWechatNewMessages({
      signal: input.signal,
      userId: input.userId,
      limit: input.limit ?? 50,
    });
    const processableEvents = await collectProcessableEvents({
      userId: input.userId,
      insertedEvents: result.insertedEvents,
    });
    const queued = await enqueueProcessingJobs({
      userId: input.userId,
      events: processableEvents,
    });
    const completedAt = new Date();
    status.isRunning = false;
    const degraded=result.sourceResults?.some(source=>source.warning);
    status.lastStatus = degraded ? "error" : "success";
    status.lastError = degraded ? "wechat_sources_partially_unavailable" : null;
    status.lastCompletedAt = completedAt;
    status.nextRunAt = new Date(completedAt.getTime() + status.intervalMs);
    status.runCount += 1;
    status.lastResult = {
      insertedCount: result.insertedCount,
      duplicateCount: result.duplicateCount,
      eventCount: result.eventCount,
      sourceResults: result.sourceResults,
      processingJobsCreated: queued.jobsCreated,
      queuedEventCount: queued.queuedEventCount,
    };
  } catch (error) {
    const completedAt = new Date();
    status.isRunning = false;
    status.lastStatus = "error";
    status.lastCompletedAt = completedAt;
    status.nextRunAt = new Date(completedAt.getTime() + status.intervalMs);
    status.lastError = error instanceof Error ? error.message : String(error);
    status.runCount += 1;
  }

  return serializeStatus(status);
}

export async function runDueInteractionIngestion(input: {
  signal?: AbortSignal;
  userId?: string;
  now?: Date;
}) {
  if (!input.userId) return getInteractionIngestionStatus(input.userId);
  if (!shouldRunInteractionIngestion(input.userId, input.now)) {
    return getInteractionIngestionStatus(input.userId);
  }
  return runInteractionIngestion({
    signal: input.signal,
    userId: input.userId,
    reason: "scheduled",
    now: input.now,
  });
}
