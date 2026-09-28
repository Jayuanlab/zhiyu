import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { loopRuns, loops } from "@/lib/db/schema";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const maxPageSize = 8;

export type LoopRunTimelineInput = {
  userId: string;
  loopId: string;
  afterRunId: string;
  cursorRunId?: string;
  limit?: number;
};
type RunPosition = { id: string; loopId: string; createdAt: Date; status: string; startedAt?: Date | null; completedAt?: Date | null; error?: string | null };
type Readers = {
  ownsLoop: (userId: string, loopId: string) => Promise<boolean>;
  getRun: (loopId: string, runId: string) => Promise<RunPosition | null>;
  listAfter: (loopId: string, position: { createdAt: Date; id: string }, limit: number) => Promise<RunPosition[]>;
};

const readers: Readers = {
  ownsLoop: async (userId, loopId) => {
    const rows = await db.select({ id: loops.id }).from(loops).where(and(eq(loops.id, loopId), eq(loops.userId, userId))).limit(1);
    return rows.length > 0;
  },
  getRun: async (loopId, runId) => {
    const rows = await db.select({ id: loopRuns.id, loopId: loopRuns.loopId, createdAt: loopRuns.createdAt,
      status: loopRuns.status, startedAt: loopRuns.startedAt, completedAt: loopRuns.completedAt, error: loopRuns.error })
      .from(loopRuns).where(and(eq(loopRuns.loopId, loopId), eq(loopRuns.id, runId))).limit(1);
    return rows[0] ?? null;
  },
  listAfter: async (loopId, position, limit) => db.select({ id: loopRuns.id, loopId: loopRuns.loopId,
    createdAt: loopRuns.createdAt, status: loopRuns.status, startedAt: loopRuns.startedAt,
    completedAt: loopRuns.completedAt, error: loopRuns.error })
    .from(loopRuns).where(and(eq(loopRuns.loopId, loopId),
      // Compare with the database's original timestamp precision, not a Date
      // round-trip that can move a microsecond-precision anchor behind itself.
      sql`(${loopRuns.createdAt}, ${loopRuns.id}) > (select anchor.created_at, anchor.id from loop_runs anchor where anchor.id = ${position.id} and anchor.loop_id = ${loopId})`))
    .orderBy(asc(loopRuns.createdAt), asc(loopRuns.id)).limit(limit),
};

function positionAfter(a: RunPosition, b: RunPosition) {
  return a.createdAt.getTime() > b.createdAt.getTime()
    || (a.createdAt.getTime() === b.createdAt.getTime() && a.id > b.id);
}

/** A bounded owner-scoped successor query, not a historical state verdict. */
export async function readLoopRunTimelineForOwner(input: LoopRunTimelineInput, source: Readers = readers) {
  if (!uuid.test(input.loopId) || !uuid.test(input.afterRunId) || input.cursorRunId && !uuid.test(input.cursorRunId)) {
    throw Error("Invalid Loop or run ID");
  }
  const limit = typeof input.limit === "number" && Number.isFinite(input.limit)
    ? Math.max(1, Math.min(maxPageSize, Math.trunc(input.limit))) : maxPageSize;
  if (!await source.ownsLoop(input.userId, input.loopId)) return { status: "loop_not_found_in_scope" as const,
    warning: "No owner-visible Loop. No run search was performed." };
  const anchor = await source.getRun(input.loopId, input.afterRunId);
  if (!anchor) return { status: "anchor_not_found_in_scope" as const,
    warning: "The baseline run is not part of this owner-visible Loop. No later-run conclusion is available." };
  const cursor = input.cursorRunId ? await source.getRun(input.loopId, input.cursorRunId) : anchor;
  if (!cursor || input.cursorRunId && !positionAfter(cursor, anchor)) return { status: "invalid_timeline_cursor" as const,
    warning: "The continuation run is missing or not later than the baseline run in this Loop." };
  const rows = await source.listAfter(input.loopId, { createdAt: cursor.createdAt, id: cursor.id }, limit + 1);
  if (rows.some((row, index) => row.loopId !== input.loopId || row.id === anchor.id || row.id === cursor.id
    || !positionAfter(row, cursor) || index > 0 && !positionAfter(row, rows[index - 1]))) {
    return { status: "invalid_timeline_page" as const,
      warning: "The source returned the baseline, cursor, or an unordered row; later-run presence was not established." };
  }
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const runs = page.map(row => ({ id: row.id, loopId: row.loopId, status: row.status,
    createdAt: row.createdAt.toISOString(), startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null, error: row.error ?? null,
    read: { source: "loopRuns", id: row.id, offset: 0 } }));
  return { status: "read" as const, loopId: input.loopId, afterRunId: input.afterRunId,
    baseline: { id: anchor.id, createdAt: anchor.createdAt.toISOString(), status: anchor.status },
    cursorRunId: input.cursorRunId ?? null, observedAt: new Date().toISOString(),
    ordering: "createdAt_asc_id_asc", runs,
    coverage: { returnedCount: runs.length, hasMore, nextCursorRunId: hasMore ? page.at(-1)?.id ?? null : null,
      completeness: hasMore ? "bounded_page" : "reached_end_of_owner_visible_runs_at_read_time" },
    completionGate: hasMore ? "timeline_continuation_required" : "timeline_window_complete",
    warning: "Run creation order is not completion order. A later run's status, even completed, does not by itself prove the earlier failure was repaired; inspect that run's verificationResult. This is a live owner-scoped query, not a historical validity interval. New or backfilled runs can change later reads." };
}
