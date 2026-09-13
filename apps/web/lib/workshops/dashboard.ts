import type {
  LoopRun,
  LoopState,
  Workshop,
  WorkshopEvent,
  WorkshopHeartbeat,
  WorkshopMemory,
  WorkshopOutboxItem,
  WorkshopRun,
  WorkshopSource,
} from "@/lib/db/schema";
import {
  listLatestLoopRunsByLoopId,
  listLoopStatesByLoopId,
  listLoopsForWorkshop,
} from "@/lib/loops/service";
import {
  summarizeLoop,
  type LoopDashboardStatus,
  type LoopDashboardSummary,
} from "@/lib/loops/dashboard";
import {
  countWorkshopDashboardMetrics,
  getWorkshop,
  getWorkshopHeartbeat,
  listWorkshopEvents,
  listWorkshopOutboxByStatuses,
  listWorkshops,
} from "./service";
import {
  getCachedWorkshopDashboard,
  markWorkshopDashboardRefreshing,
  setCachedWorkshopDashboard,
} from "./dashboard-cache";
import {
  summarizeWorkshopEventForList,
  summarizeWorkshopEventsForList,
} from "./event-summary";
import { syncWorkshopLoopBlockerReviewItems } from "./review-items";
import { latestWorkshopConclusion } from "./conclusion";
import { classifyOutbox, isPendingLoopActivation, OUTBOX_ATTENTION_STATUSES, readWorkStatusProjection, workStatusFromCounts, type WorkStatusProjection } from "./status-projection";

export type WorkshopDashboardStatus =
  | "active"
  | "paused"
  | "archived"
  | "blocked"
  | "needs_approval"
  | "error";

export interface WorkshopDashboardCounts {
  loops: number;
  activeLoops: number;
  pendingLoopProposals: number;
  pendingOutbox: number;
  pendingApprovals: number;
  blockedLoops: number;
  errorLoops: number;
  outboxDrafts?: number;
  outboxReady?: number;
  outboxBlocked?: number;
  outboxUnknown?: number;
  outboxSending?: number;
  outboxApprovals?: number;
  attentionCount?: number;
  sources: number;
  memories: number;
  directives: number;
}

export interface WorkshopNextWork {
  source: "heartbeat" | "loop" | null;
  at: string | null;
  label: string;
}

export interface WorkshopContextCostSummary {
  recentReportCount: number;
  estimatedInputCostUsd: number | null;
  avgEstimatedPromptTokens: number | null;
  latestReport: {
    eventId: string;
    createdAt: string;
    profile: string | null;
    modelTier: string | null;
    modelSource: string | null;
    model: string | null;
    toolProfile: string | null;
    promptChars: number | null;
    estimatedPromptTokens: number | null;
    estimatedInputCostUsd: number | null;
  } | null;
  largestSection: {
    name: string;
    chars: number;
    estimatedTokens: number;
  } | null;
  profileCounts: Record<string, number>;
  modelTierCounts: Record<string, number>;
  toolProfileCounts: Record<string, number>;
  sectionStats: Array<{
    name: string;
    reportCount: number;
    totalChars: number;
    avgChars: number;
    maxChars: number;
    avgEstimatedTokens: number;
    maxEstimatedTokens: number;
    overBudgetCount: number;
    latestChars: number | null;
    latestEstimatedTokens: number | null;
    latestOverBudget: boolean | null;
    latestPromptShare: number | null;
  }>;
}

export interface WorkshopDashboardSummary {
  workshop: Workshop;
  status: WorkshopDashboardStatus;
  counts: WorkshopDashboardCounts;
  nextWork: WorkshopNextWork;
  contextCost: WorkshopContextCostSummary;
  recentFinding: WorkshopEvent | null;
  latestEvent: WorkshopEvent | null;
  latestConclusion?: WorkshopEvent | null;
  pendingOutbox: WorkshopOutboxItem[];
  pendingLoopProposals: LoopDashboardSummary[];
  blockedLoops: LoopDashboardSummary[];
}

export interface WorkshopDashboard extends WorkshopDashboardSummary {
  projection?: Omit<WorkStatusProjection, "counts">;
  loops: LoopDashboardSummary[];
  recentEvents: WorkshopEvent[];
  outbox: WorkshopOutboxItem[];
  memories: WorkshopMemory[];
  sources: WorkshopSource[];
  runs: WorkshopRun[];
  heartbeat: WorkshopHeartbeat | null;
}

const PENDING_OUTBOX_STATUSES = new Set(OUTBOX_ATTENTION_STATUSES);

const FINDING_EVENT_TYPES = new Set([
  "source_checked",
  "memory_written",
  "loop_run_completed",
  "observation",
  "hypothesis",
  "decision",
]);

const DEFAULT_DASHBOARD_SLOW_LOG_MS = 500;
const dashboardRefreshes = new Map<string, Promise<WorkshopDashboard | null>>();

type DashboardTrace = Record<string, number | string | boolean>;

function shouldTraceDashboard(durationMs: number) {
  if (process.env.WORKSHOP_DASHBOARD_TRACE === "1") return true;

  const threshold = Number(process.env.WORKSHOP_DASHBOARD_SLOW_LOG_MS);
  const slowLogMs =
    Number.isFinite(threshold) && threshold >= 0
      ? threshold
      : DEFAULT_DASHBOARD_SLOW_LOG_MS;
  return durationMs >= slowLogMs;
}

async function timedDashboardStep<T>(
  trace: DashboardTrace,
  label: string,
  task: Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await task;
  } finally {
    trace[`${label}Ms`] = Date.now() - startedAt;
  }
}

function logDashboardTrace(input: {
  workshopId: string;
  cacheHit: boolean;
  trace: DashboardTrace;
  totalMs: number;
}) {
  if (!shouldTraceDashboard(input.totalMs)) return;

  console.info("[WorkshopDashboard] snapshot", {
    workshopId: input.workshopId,
    cacheHit: input.cacheHit,
    totalMs: input.totalMs,
    ...input.trace,
  });
}

function isoTime(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function parseTime(value: Date | string | null | undefined): number {
  const iso = isoTime(value);
  if (!iso) return Number.POSITIVE_INFINITY;
  const timestamp = new Date(iso).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

function isPendingOutbox(item: WorkshopOutboxItem) {
  return classifyOutbox(item) !== null;
}

function isPendingLoopProposal(loop: LoopDashboardSummary) {
  return isPendingLoopActivation(loop.stateJson);
}

function latestByTime<T>(
  items: T[],
  pickTime: (item: T) => Date | string | null | undefined,
): T | null {
  return (
    [...items].sort((a, b) => parseTime(pickTime(b)) - parseTime(pickTime(a)))[0] ??
    null
  );
}

function isOwnerPrimaryEvent(event: WorkshopEvent) {
  return (
    event.type === "loop_run_completed" ||
    event.type === "decision" ||
    event.type === "agent_text"
  );
}

function countLoopsByStatus(
  loops: LoopDashboardSummary[],
  status: LoopDashboardStatus,
) {
  return loops.filter((loop) => loop.dashboardStatus === status).length;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function incrementCount(target: Record<string, number>, key: string | null) {
  if (!key) return;
  target[key] = (target[key] ?? 0) + 1;
}

export function summarizeWorkshopContextCost(
  events: WorkshopEvent[],
): WorkshopContextCostSummary {
  const reports = events
    .filter((event) => event.type === "context_budget_report")
    .map((event) => ({
      event,
      metadata: asRecord(event.metadata),
    }));
  const profileCounts: Record<string, number> = {};
  const modelTierCounts: Record<string, number> = {};
  const toolProfileCounts: Record<string, number> = {};
  let totalEstimatedInputCostUsd = 0;
  let hasEstimatedInputCost = false;
  let totalEstimatedPromptTokens = 0;
  let promptTokenReportCount = 0;
  let largestSection: WorkshopContextCostSummary["largestSection"] = null;
  const sectionStatsByName = new Map<
    string,
    {
      name: string;
      reportCount: number;
      totalChars: number;
      maxChars: number;
      totalEstimatedTokens: number;
      maxEstimatedTokens: number;
      overBudgetCount: number;
      latestChars: number | null;
      latestEstimatedTokens: number | null;
      latestOverBudget: boolean | null;
      latestPromptShare: number | null;
    }
  >();

  for (const report of reports) {
    const metadata = report.metadata;
    incrementCount(profileCounts, stringValue(metadata.profile));
    incrementCount(modelTierCounts, stringValue(metadata.modelTier));
    incrementCount(toolProfileCounts, stringValue(metadata.toolProfile));

    const estimatedInputCostUsd = numberValue(metadata.estimatedInputCostUsd);
    if (estimatedInputCostUsd !== null) {
      totalEstimatedInputCostUsd += estimatedInputCostUsd;
      hasEstimatedInputCost = true;
    }

    const estimatedPromptTokens = numberValue(metadata.estimatedPromptTokens);
    if (estimatedPromptTokens !== null) {
      totalEstimatedPromptTokens += estimatedPromptTokens;
      promptTokenReportCount += 1;
    }

    const sections = Array.isArray(metadata.largestSections)
      ? metadata.largestSections
      : [];
    const topSection = asRecord(sections[0]);
    const sectionChars = numberValue(topSection.chars);
    if (
      sectionChars !== null &&
      (!largestSection || sectionChars > largestSection.chars)
    ) {
      largestSection = {
        name: stringValue(topSection.name) ?? "unknown",
        chars: sectionChars,
        estimatedTokens: numberValue(topSection.estimatedTokens) ?? 0,
      };
    }

    const promptChars = numberValue(metadata.promptChars);
    const allSections = Array.isArray(metadata.sections)
      ? metadata.sections
      : [];
    for (const section of allSections) {
      const sectionRecord = asRecord(section);
      const name = stringValue(sectionRecord.name) ?? "unknown";
      const chars = numberValue(sectionRecord.chars) ?? 0;
      const estimatedTokens = numberValue(sectionRecord.estimatedTokens) ?? 0;
      const overBudget = sectionRecord.overBudget === true;
      const existing =
        sectionStatsByName.get(name) ??
        {
          name,
          reportCount: 0,
          totalChars: 0,
          maxChars: 0,
          totalEstimatedTokens: 0,
          maxEstimatedTokens: 0,
          overBudgetCount: 0,
          latestChars: null,
          latestEstimatedTokens: null,
          latestOverBudget: null,
          latestPromptShare: null,
        };
      existing.reportCount += 1;
      existing.totalChars += chars;
      existing.maxChars = Math.max(existing.maxChars, chars);
      existing.totalEstimatedTokens += estimatedTokens;
      existing.maxEstimatedTokens = Math.max(
        existing.maxEstimatedTokens,
        estimatedTokens,
      );
      if (overBudget) existing.overBudgetCount += 1;
      existing.latestChars = chars;
      existing.latestEstimatedTokens = estimatedTokens;
      existing.latestOverBudget = overBudget;
      existing.latestPromptShare =
        promptChars && promptChars > 0 ? chars / promptChars : null;
      sectionStatsByName.set(name, existing);
    }
  }

  const latest = reports[reports.length - 1] ?? null;
  const latestMetadata = latest ? latest.metadata : {};
  const latestCreatedAt = isoTime(latest?.event.createdAt) ?? "";
  return {
    recentReportCount: reports.length,
    estimatedInputCostUsd: hasEstimatedInputCost
      ? totalEstimatedInputCostUsd
      : null,
    avgEstimatedPromptTokens:
      promptTokenReportCount > 0
        ? Math.round(totalEstimatedPromptTokens / promptTokenReportCount)
        : null,
    latestReport: latest
      ? {
          eventId: latest.event.id,
          createdAt: latestCreatedAt,
          profile: stringValue(latestMetadata.profile),
          modelTier: stringValue(latestMetadata.modelTier),
          modelSource: stringValue(latestMetadata.modelSource),
          model: stringValue(latestMetadata.model),
          toolProfile: stringValue(latestMetadata.toolProfile),
          promptChars: numberValue(latestMetadata.promptChars),
          estimatedPromptTokens: numberValue(
            latestMetadata.estimatedPromptTokens,
          ),
          estimatedInputCostUsd: numberValue(
            latestMetadata.estimatedInputCostUsd,
          ),
        }
      : null,
    largestSection,
    profileCounts,
    modelTierCounts,
    toolProfileCounts,
    sectionStats: Array.from(sectionStatsByName.values())
      .map((section) => ({
        ...section,
        avgChars:
          section.reportCount > 0
            ? Math.round(section.totalChars / section.reportCount)
            : 0,
        avgEstimatedTokens:
          section.reportCount > 0
            ? Math.round(section.totalEstimatedTokens / section.reportCount)
            : 0,
      }))
      .sort((left, right) => {
        const leftLatest = left.latestEstimatedTokens ?? 0;
        const rightLatest = right.latestEstimatedTokens ?? 0;
        return rightLatest - leftLatest || right.maxChars - left.maxChars;
      }),
  };
}

export function deriveWorkshopDashboardStatus(input: {
  workshop: Pick<Workshop, "status">;
  loops: LoopDashboardSummary[];
  pendingOutbox?: WorkshopOutboxItem[];
  pendingOutboxCount?: number;
  pendingApprovalCount?: number;
  heartbeat: WorkshopHeartbeat | null;
}): WorkshopDashboardStatus {
  return workStatusFromCounts(input.workshop.status, {
    errorLoops: countLoopsByStatus(input.loops, "error"),
    blockedLoops: countLoopsByStatus(input.loops, "blocked"),
    pendingApprovals: input.pendingApprovalCount ?? (countLoopsByStatus(input.loops, "needs_approval") +
      (input.pendingOutbox ?? []).filter(item => classifyOutbox(item) === "approval").length),
    outboxBlocked: (input.pendingOutbox ?? []).filter(item => classifyOutbox(item) === "blocked").length,
    outboxUnknown: (input.pendingOutbox ?? []).filter(item => classifyOutbox(item) === "unknown").length,
  }, Boolean(input.heartbeat?.schedulerError || input.heartbeat?.schedulerStatus === "error"));
}

export function deriveWorkshopNextWork(input: {
  heartbeat: WorkshopHeartbeat | null;
  loops: LoopDashboardSummary[];
}): WorkshopNextWork {
  const candidates: Array<{
    source: "heartbeat" | "loop";
    at: string;
    label: string;
  }> = [];

  const heartbeatAt = isoTime(input.heartbeat?.nextWakeupAt);
  if (heartbeatAt) {
    candidates.push({
      source: "heartbeat",
      at: heartbeatAt,
      label: "车间心跳唤醒",
    });
  }

  for (const loop of input.loops) {
    if (!loop.nextScheduledRunAt || loop.status !== "active") continue;
    candidates.push({
      source: "loop",
      at: loop.nextScheduledRunAt,
      label: loop.name,
    });
  }

  const next = candidates.sort((a, b) => parseTime(a.at) - parseTime(b.at))[0];
  return next ?? { source: null, at: null, label: "暂无已安排的下一次工作" };
}

export function buildWorkshopDashboard(input: {
  workshop: Workshop;
  loops: LoopDashboardSummary[];
  events: WorkshopEvent[];
  outbox?: WorkshopOutboxItem[];
  memories?: WorkshopMemory[];
  sources?: WorkshopSource[];
  runs?: WorkshopRun[];
  heartbeat: WorkshopHeartbeat | null;
  pendingOutboxCount?: number;
  memoriesCount?: number;
  sourcesCount?: number;
  directivesCount?: number;
  statusProjection?: WorkStatusProjection;
}): WorkshopDashboard {
  const outbox = input.outbox ?? [];
  const memories = input.memories ?? [];
  const sources = input.sources ?? [];
  const pendingOutbox = outbox.filter(isPendingOutbox);
  const pendingOutboxCount = input.pendingOutboxCount ?? pendingOutbox.length;
  const pendingLoopProposals = input.loops.filter(isPendingLoopProposal);
  const blockedLoops = input.loops.filter((loop) =>
    ["blocked", "error"].includes(loop.dashboardStatus),
  );
  const recentFinding =
    [...input.events]
      .reverse()
      .find((event) => FINDING_EVENT_TYPES.has(event.type)) ?? null;
  const contextCost = summarizeWorkshopContextCost(input.events);
  const counts = {
      loops: input.loops.length,
      activeLoops: input.loops.filter((loop) => loop.status === "active").length,
      pendingLoopProposals: pendingLoopProposals.length,
      pendingOutbox: pendingOutboxCount,
      pendingApprovals: countLoopsByStatus(input.loops, "needs_approval") + outbox.filter(item => classifyOutbox(item) === "approval").length,
      blockedLoops: countLoopsByStatus(input.loops, "blocked"),
      errorLoops: countLoopsByStatus(input.loops, "error"),
      sources: input.sourcesCount ?? sources.length,
      memories: input.memoriesCount ?? memories.length,
      directives: input.directivesCount ?? 0,
      outboxDrafts: outbox.filter(item => classifyOutbox(item) === "draft").length,
      outboxReady: outbox.filter(item => classifyOutbox(item) === "ready").length,
      outboxBlocked: outbox.filter(item => classifyOutbox(item) === "blocked").length,
      outboxUnknown: outbox.filter(item => classifyOutbox(item) === "unknown").length,
      outboxSending: outbox.filter(item => classifyOutbox(item) === "sending").length,
      outboxApprovals: outbox.filter(item => classifyOutbox(item) === "approval").length,
      ...input.statusProjection?.counts,
  };
  const attentionCount = counts.pendingApprovals - counts.outboxApprovals + counts.blockedLoops + counts.errorLoops + counts.pendingOutbox;
  return {
    workshop: input.workshop,
    status: workStatusFromCounts(input.workshop.status, counts, Boolean(input.heartbeat?.schedulerError || input.heartbeat?.schedulerStatus === "error")),
    counts: {...counts, attentionCount},
    ...(input.statusProjection ? {projection: {version: input.statusProjection.version, asOf: input.statusProjection.asOf, eventCursor: input.statusProjection.eventCursor}} : {}),
    nextWork: deriveWorkshopNextWork({
      heartbeat: input.heartbeat,
      loops: input.loops,
    }),
    contextCost,
    recentFinding,
    latestConclusion: latestWorkshopConclusion(input.events),
    latestEvent:
      latestByTime(
        input.events.filter(isOwnerPrimaryEvent),
        (event) => event.createdAt,
      ) ?? latestByTime(input.events, (event) => event.createdAt),
    pendingOutbox,
    pendingLoopProposals,
    blockedLoops,
    loops: input.loops,
    recentEvents: [],
    outbox: [],
    memories: [],
    sources: [],
    runs: [],
    heartbeat: null,
  };
}

export async function getWorkshopDashboard(input: {
  userId: string;
  workshopId: string;
  refresh?: boolean;
}): Promise<WorkshopDashboard | null> {
  const startedAt = Date.now();
  const trace: DashboardTrace = {};
  const cached = getCachedWorkshopDashboard(input);
  if (cached && !input.refresh) {
    if (cached.stale) {
      refreshWorkshopDashboardInBackground(input);
    }
    logDashboardTrace({
      workshopId: input.workshopId,
      cacheHit: true,
      trace,
      totalMs: Date.now() - startedAt,
    });
    return cached.dashboard;
  }

  const key = dashboardRefreshKey(input);
  const existingRefresh = dashboardRefreshes.get(key);
  if (existingRefresh) {
    return existingRefresh;
  }

  const refresh = loadWorkshopDashboard(input, startedAt, trace);
  dashboardRefreshes.set(key, refresh);
  try {
    return await refresh;
  } finally {
    if (dashboardRefreshes.get(key) === refresh) {
      dashboardRefreshes.delete(key);
    }
  }
}

function dashboardRefreshKey(input: { userId: string; workshopId: string }) {
  return `${input.userId}:${input.workshopId}`;
}

function refreshWorkshopDashboardInBackground(input: {
  userId: string;
  workshopId: string;
}) {
  const key = dashboardRefreshKey(input);
  if (dashboardRefreshes.has(key)) return;
  const startedAt = Date.now();
  const trace: DashboardTrace = {};
  const refresh = loadWorkshopDashboard(input, startedAt, trace).catch(
    (error) => {
      console.warn("[WorkshopDashboard] background refresh failed", {
        workshopId: input.workshopId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    },
  );
  dashboardRefreshes.set(key, refresh);
  markWorkshopDashboardRefreshing({ ...input, refreshing: refresh });
  refresh.finally(() => {
    if (dashboardRefreshes.get(key) === refresh) {
      dashboardRefreshes.delete(key);
    }
  });
}

async function loadWorkshopDashboard(
  input: {
    userId: string;
    workshopId: string;
  },
  startedAt: number,
  trace: DashboardTrace,
): Promise<WorkshopDashboard | null> {
  const workshop = await timedDashboardStep(
    trace,
    "workshop",
    getWorkshop(input.userId, input.workshopId),
  );
  if (!workshop) {
    logDashboardTrace({
      workshopId: input.workshopId,
      cacheHit: false,
      trace,
      totalMs: Date.now() - startedAt,
    });
    return null;
  }

  const [
    loops,
    events,
    outbox,
    metrics,
    heartbeat,
    statusProjection,
  ] = await Promise.all([
    timedDashboardStep(
      trace,
      "loops",
      listLoopsForWorkshop({
        userId: input.userId,
        workshopId: input.workshopId,
        limit: 200,
      }),
    ),
    timedDashboardStep(
      trace,
      "events",
      listWorkshopEvents(input.workshopId, { limit: 100, order: "latest" }),
    ),
    timedDashboardStep(
      trace,
      "outbox",
      listWorkshopOutboxByStatuses(
        input.workshopId,
        [...PENDING_OUTBOX_STATUSES],
        500,
      ),
    ),
    timedDashboardStep(
      trace,
      "metrics",
      countWorkshopDashboardMetrics(input.workshopId),
    ),
    timedDashboardStep(
      trace,
      "heartbeat",
      getWorkshopHeartbeat(input.workshopId),
    ),
    readWorkStatusProjection({ userId: input.userId, workId: input.workshopId }),
  ]);
  if (!statusProjection) return null;
  const loopIds = loops.map((loop) => loop.id);
  const [statesByLoopId, latestRunsByLoopId] = await Promise.all([
    timedDashboardStep(trace, "loopStates", listLoopStatesByLoopId(loopIds)),
    timedDashboardStep(
      trace,
      "latestLoopRuns",
      listLatestLoopRunsByLoopId(loopIds),
    ),
  ]);
  const summarizeStartedAt = Date.now();
  const loopSummaries = loops.map((loop) =>
    summarizeLoop({
      loop,
      state: (statesByLoopId.get(loop.id) as LoopState | undefined) ?? null,
      latestRun:
        (latestRunsByLoopId.get(loop.id) as LoopRun | undefined) ?? null,
    }),
  );
  trace.summarizeLoopsMs = Date.now() - summarizeStartedAt;
  trace.loopCount = loops.length;
  trace.eventCount = events.length;
  trace.pendingOutboxRows = outbox.length;
  const workshopEvents = events as WorkshopEvent[];

  const summarizedEvents = summarizeWorkshopEventsForList(workshopEvents, {
    maxBodyChars: 500,
  });
  const fullLatestEvent = latestByTime(
    workshopEvents,
    (event) => event.createdAt,
  );
  const dashboardEvents = fullLatestEvent
    ? summarizedEvents.map((event) =>
        event.id === fullLatestEvent.id
          ? summarizeWorkshopEventForList(fullLatestEvent, {
              preserveBody: true,
            })
          : event,
      )
    : summarizedEvents;

  const dashboard = buildWorkshopDashboard({
    workshop,
    loops: loopSummaries,
    events: dashboardEvents,
    outbox,
    memoriesCount: metrics.memories,
    sourcesCount: metrics.sources,
    heartbeat,
    directivesCount: metrics.directives,
    statusProjection,
  });
  await timedDashboardStep(
    trace,
    "reviewItems",
    syncWorkshopLoopBlockerReviewItems({
      workshopId: input.workshopId,
      loops: loopSummaries,
    }).catch((error) => {
      console.warn("[WorkshopDashboard] failed to sync loop blocker review items", {
        workshopId: input.workshopId,
        error: error instanceof Error ? error.message : String(error),
      });
    }),
  );
  setCachedWorkshopDashboard({ ...input, dashboard });
  logDashboardTrace({
    workshopId: input.workshopId,
    cacheHit: false,
    trace,
    totalMs: Date.now() - startedAt,
  });
  return dashboard;
}

export async function listWorkshopDashboard(input: {
  userId: string;
  limit?: number;
}): Promise<WorkshopDashboardSummary[]> {
  const workshops: Workshop[] = await listWorkshops(
    input.userId,
    input.limit ?? 100,
  );
  const dashboards = await Promise.all(
    workshops.map((workshop) =>
      getWorkshopDashboard({
        userId: input.userId,
        workshopId: workshop.id,
      }),
    ),
  );
  return dashboards.filter(
    (dashboard): dashboard is WorkshopDashboard => Boolean(dashboard),
  );
}
