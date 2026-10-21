import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { buildBrainRecallTraceQualitySummary } from "@/lib/memory/governance/recall-quality";

export type ReviewWorkObservations = {
  windowDays: 7;
  sampleCount: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  eventIds: string[];
  warningCount: number | null;
  noEvidenceSelectedCount: number | null;
  duplicateOmittedCount: number | null;
};

type TraceRow = { id: string; created_at: Date | string; trace: unknown };

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return record(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function timestamp(value: Date | string) {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** The caller must authorize the Work first. This reads only its own trace sample. */
export async function loadReviewWorkObservations(workId: string): Promise<ReviewWorkObservations> {
  const rows = await db.execute(sql`
    SELECT id, created_at,
      CASE WHEN metadata #>> '{memoryRecall,contextPack,interfaceVersion}' = 'brain-context-trace.v1'
        THEN metadata #> '{memoryRecall,contextPack}'
        ELSE metadata -> 'contextPack' END AS trace
    FROM workshop_events
    WHERE workshop_id = ${workId}::uuid
      AND created_at >= now() - interval '7 days'
      AND created_at <= now()
      AND (metadata #>> '{memoryRecall,contextPack,interfaceVersion}' = 'brain-context-trace.v1'
        OR metadata #>> '{contextPack,interfaceVersion}' = 'brain-context-trace.v1')
    ORDER BY created_at DESC, id DESC
    LIMIT 50
  `) as TraceRow[];
  const traces = rows.map(row => record(row.trace));
  const hasSample = traces.length > 0;
  const validTraces = traces.every(trace => trace.interfaceVersion === "brain-context-trace.v1");
  // Missing trace fields are not observed zeroes. Keep each count independently
  // unknown if any sampled trace cannot establish that count.
  const knownWarnings = hasSample && validTraces && traces.every(trace =>
    Array.isArray(trace.warnings) && trace.warnings.every(item => {
      if (typeof item === "string") return item.trim().length > 0;
      const warning = record(item);
      return [warning.code, warning.message].some(value => typeof value === "string" && value.trim().length > 0);
    }));
  const knownEvidence = hasSample && validTraces && traces.every(trace =>
    Array.isArray(trace.selected) && trace.selected.every(item => {
      const count = record(item).evidenceRefCount;
      return typeof count === "number" && Number.isInteger(count) && count >= 0;
    }));
  const knownDuplicates = hasSample && validTraces && traces.every(trace =>
    Array.isArray(trace.omitted) && trace.omitted.every(item => {
      const reason = record(item).reason;
      return typeof reason === "string" && reason.trim().length > 0;
    }));
  const summary = buildBrainRecallTraceQualitySummary({ contextTraces: traces });
  // Use the full omitted set, not the helper's top-eight reason ranking.
  const duplicates = buildBrainRecallTraceQualitySummary({ contextTraces: traces.map(trace => ({
    omitted: Array.isArray(trace.omitted)
      ? trace.omitted.filter(item => record(item).reason === "duplicate_canonical_group") : [],
  })) });
  const times = rows.map(row => timestamp(row.created_at));
  const allTimesKnown = times.length > 0 && times.every((time): time is string => time !== null);
  const sortedTimes = allTimesKnown ? times.sort() : [];
  return {
    windowDays: 7,
    sampleCount: rows.length,
    firstEventAt: sortedTimes[0] ?? null,
    lastEventAt: sortedTimes.at(-1) ?? null,
    eventIds: rows.map(row => row.id),
    warningCount: knownWarnings ? summary.warningCount : null,
    noEvidenceSelectedCount: knownEvidence ? summary.noEvidenceSelectedCount : null,
    duplicateOmittedCount: knownDuplicates ? duplicates.omittedMemoryCount : null,
  };
}
