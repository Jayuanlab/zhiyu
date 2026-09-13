import type { WorkSummarySnapshot } from "@/lib/work-runtime/types";

const SUMMARY_EVENT_LIMIT = 20;
const SUMMARY_EVENT_BODY_CHARS = 320;
const SUMMARY_METADATA_KEYS = [
  "kind",
  "status",
  "provider",
  "source",
  "sourceName",
  "toolName",
  "symbol",
  "symbols",
  "warning",
  "error",
  "reason",
  "risk",
  "riskLevel",
  "proposalId",
  "sourceProposalEventId",
  "proposalEventId",
  "draftId",
  "workModelVersion",
  "workVersionAfter",
];

export type WorkshopSummaryPageState = WorkSummarySnapshot["detail"] & {
  dashboard: WorkSummarySnapshot["dashboard"];
  interfaceVersion: WorkSummarySnapshot["interfaceVersion"];
  generatedAt: string;
  eventWindow: { firstSeq: number | null; lastSeq: number | null; hasMore: boolean };
  meta: {
    hit: boolean;
    stale: boolean;
    refreshing: boolean;
    warnings: string[];
    cache?: {
      hit: boolean;
      stale: boolean;
      refreshing: boolean;
      fetchedAt: string;
      expiresAt: string;
    };
  };
};

export const WORKSHOP_SUMMARY_PAGE_STATE_TTL_MS = 10_000;
export const WORKSHOP_SUMMARY_PAGE_STATE_STALE_TTL_MS = 2 * 60_000;

export function workshopSummaryPageStateKey(workshopId: string) {
  return `workshop:${workshopId}:summary:v5`;
}

export function workshopSummaryPageStateTtlMs() {
  const configured = Number(process.env.WORKSHOP_SUMMARY_PAGE_STATE_TTL_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : WORKSHOP_SUMMARY_PAGE_STATE_TTL_MS;
}

export function workshopSummaryPageStateStaleTtlMs() {
  const configured = Number(
    process.env.WORKSHOP_SUMMARY_PAGE_STATE_STALE_TTL_MS,
  );
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : WORKSHOP_SUMMARY_PAGE_STATE_STALE_TTL_MS;
}

export function summarySnapshotToPageState(
  snapshot: WorkSummarySnapshot,
): WorkshopSummaryPageState {
  const events = snapshot.detail.events
    .slice(-SUMMARY_EVENT_LIMIT)
    .map(compactSummaryEvent) as WorkSummarySnapshot["detail"]["events"];
  const dashboard = {
    ...snapshot.dashboard,
    recentEvents: events as WorkSummarySnapshot["dashboard"]["recentEvents"],
  };

  return {
    ...snapshot.detail,
    events,
    dashboard,
    interfaceVersion: snapshot.interfaceVersion,
    generatedAt: snapshot.generatedAt,
    eventWindow: {
      firstSeq: (events[0] as {seq?: number} | undefined)?.seq ?? null,
      lastSeq: (events.at(-1) as {seq?: number} | undefined)?.seq ?? null,
      hasMore: snapshot.detail.events.length > events.length,
    },
    meta: {
      hit: false,
      stale: false,
      refreshing: false,
      warnings: [],
    },
  };
}

function compactText(value: unknown, maxChars: number) {
  if (typeof value !== "string") return null;
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}

function compactMetadata(value: unknown) {
  const source =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const metadata: Record<string, unknown> = {};
  for (const key of SUMMARY_METADATA_KEYS) {
    if (source[key] !== undefined) metadata[key] = source[key];
  }
  return metadata;
}

function compactSummaryEvent(value: unknown) {
  const event =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    id: event.id,
    workshopId: event.workshopId,
    runId: event.runId ?? null,
    loopId: event.loopId ?? null,
    loopRunId: event.loopRunId ?? null,
    seq: event.seq,
    type: event.type,
    title: event.title,
    body: compactText(event.body, SUMMARY_EVENT_BODY_CHARS),
    metadata: compactMetadata(event.metadata),
    visibility: event.visibility,
    createdAt: event.createdAt,
  };
}

export function withWorkshopSummaryCacheMeta(input: {
  value: WorkshopSummaryPageState;
  stale: boolean;
  refreshing: boolean;
  generatedAt: Date;
  expiresAt: Date;
  warning?: string;
}): WorkshopSummaryPageState {
  const warnings = [...input.value.meta.warnings];
  if (input.warning) warnings.unshift(input.warning);
  if (input.stale) {
    warnings.unshift(
      "workshop summary page-state snapshot is stale; refreshing in background",
    );
  }

  return {
    ...input.value,
    meta: {
      ...input.value.meta,
      hit: true,
      stale: input.stale || input.value.meta.stale,
      refreshing:
        input.refreshing || input.stale || input.value.meta.refreshing,
      warnings: Array.from(new Set(warnings)),
      cache: {
        hit: true,
        stale: input.stale,
        refreshing: input.refreshing || input.stale,
        fetchedAt: input.generatedAt.toISOString(),
        expiresAt: input.expiresAt.toISOString(),
      },
    },
  };
}
