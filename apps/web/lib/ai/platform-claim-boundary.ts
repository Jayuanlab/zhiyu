import type { PlatformRecord } from "./platform-record-reader";

type Timeline = { status: string; observedAt?: string; runs?: Array<{ id: string }>; coverage?: { hasMore?: boolean } };

/** Claims this bounded read can support; no semantic scoring of model prose. */
export function buildPlatformClaimBoundary(records: PlatformRecord[], timeline?: Timeline,
  runtime?: { status: string; observedAt?: string; [key: string]: unknown }) {
  const states = records.filter(record => record.source === "loopStates").map(record => ({
    source: record.source, id: record.id,
    lastPersistedAt: record.fields.updatedAt ?? null,
    lastPersistedPhase: record.fields.currentPhase ?? null,
  }));
  const unreadFields = records.flatMap(record => {
    const availability = (record as PlatformRecord & { fieldAvailability?: Record<string, string> }).fieldAvailability;
    return Object.entries(availability ?? {}).filter(([, state]) => state === "present_unread")
      .map(([field]) => `${record.source}:${record.id}:${field}`);
  });
  const laterRuns = timeline?.status === "read"
    ? { status: timeline.runs?.length ? "some_observed_in_page" : timeline.coverage?.hasMore ? "none_in_this_page_more_unread" : "none_observed_at_read_time",
        observedAt: timeline.observedAt ?? null, hasMore: timeline.coverage?.hasMore ?? null }
    : { status: timeline ? "query_failed_or_incomplete" : "not_queried", observedAt: null, hasMore: null };
  return { version: "platform-claim-boundary.v1", scope: "this_bounded_platform_recall_only",
    laterRuns,
    currentExecutor: { status: runtime?.status === "active_lease_recent_heartbeat" ? runtime.status : "not_observed",
      observationStatus: runtime?.status ?? "not_queried", observedAt: runtime?.observedAt ?? null,
      lastPersistedStates: states,
      instruction: runtime?.status === "active_lease_recent_heartbeat"
        ? "A matching lease with recent heartbeat was observed at read time. Say exactly that; do not claim the process remains alive now or that the action succeeded."
        : "Report the last persisted state and its updatedAt. A missing active linked execution is only a database-time observation; lease and heartbeat were not inspected and have no observed value in this result. Do not infer that the executor is probably not running, idle, blocked, stalled, or waiting for intervention; do not infer the cause from an old error." },
    repair: { status: "not_established_by_timeline_or_persisted_state",
      instruction: "A completed status, an old error phase, or an empty later-run list cannot by itself establish whether the underlying fault was repaired." },
    unreadFields,
    actionExecution: { status: "not_established_by_permission_decisions",
      instruction: "An allow decision proves permission only. Claim an action occurred or changed external state only from its execution result." } };
}
