type WorkshopEventLike = {
  type: string;
  body?: string | null;
  metadata?: Record<string, unknown> | null;
};

const ACTION_METADATA_EVENT_TYPES = new Set([
  "working_memory_updated",
  "working_memory_rejected",
  "working_memory_restored",
  "working_memory_projected",
  "watchlist_proposal",
  "watchlist_proposal_applied",
  "watchlist_proposal_rejected",
  "workshop_agent_change_proposed",
  "workshop_agent_change_applied",
  "workshop_agent_change_rejected",
  "workshop_agent_change_superseded",
  "workshop_insight_change_proposed",
  "workshop_insight_change_proposal_approved",
  "workshop_insight_change_proposal_rejected",
  "workshop_loop_change_proposed",
  "workshop_loop_change_proposal_approved",
  "workshop_loop_change_proposal_rejected",
  "video_review_approved",
  "video_review_rejected",
  "video_review_regenerate_requested",
]);

const METADATA_SUMMARY_KEYS = [
  "final",
  "kind",
  "status",
  "provider",
  "source",
  "sourceName",
  "sourceType",
  "toolName",
  "symbol",
  "symbols",
  "warning",
  "warnings",
  "error",
  "errors",
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

function jsonByteLength(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength;
}

function truncateText(value: string | null | undefined, maxChars: number) {
  if (!value || value.length <= maxChars) return value ?? null;
  return `${value.slice(0, maxChars)}...`;
}

function shouldPreserveEventMetadata(event: WorkshopEventLike) {
  if (ACTION_METADATA_EVENT_TYPES.has(event.type)) return true;
  const kind = event.metadata?.kind;
  return (
    kind === "watchlist_change_proposal" ||
    kind === "agent_change_proposal" ||
    kind === "loop_change_proposal" ||
    kind === "video_review"
  );
}

function compactMetadata(metadata: Record<string, unknown>) {
  const compact: Record<string, unknown> = {};
  for (const key of METADATA_SUMMARY_KEYS) {
    if (metadata[key] !== undefined) {
      compact[key] = metadata[key];
    }
  }
  compact.__truncated = true;
  compact.__originalMetadataBytes = jsonByteLength(metadata);
  return compact;
}

export function summarizeWorkshopEventForList<T extends WorkshopEventLike>(
  event: T,
  options: {
    maxBodyChars?: number;
    maxMetadataBytes?: number;
    preserveBody?: boolean;
  } = {},
): T {
  const maxBodyChars = options.maxBodyChars ?? 1200;
  const maxMetadataBytes = options.maxMetadataBytes ?? 1200;
  const metadata =
    event.metadata && typeof event.metadata === "object" ? event.metadata : {};
  const metadataBytes = jsonByteLength(metadata);

  return {
    ...event,
    body: options.preserveBody
      ? (event.body ?? null)
      : truncateText(event.body, maxBodyChars),
    metadata:
      shouldPreserveEventMetadata(event) || metadataBytes <= maxMetadataBytes
        ? metadata
        : compactMetadata(metadata),
  };
}

export function summarizeWorkshopEventsForList<T extends WorkshopEventLike>(
  events: T[],
  options: {
    maxBodyChars?: number;
    maxMetadataBytes?: number;
    preserveBody?: boolean;
  } = {},
): T[] {
  return events.map((event) => summarizeWorkshopEventForList(event, options));
}
