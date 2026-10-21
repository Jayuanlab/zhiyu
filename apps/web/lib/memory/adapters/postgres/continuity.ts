import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { loopRuns, loops, workshopEvents, workshopRuns, workshops, type WorkshopEvent as StoredWorkshopEvent } from "@/lib/db/schema";
import { deserializeJson } from "@/lib/db/serialization";
import type { WorkingMemoryContinuityInput, WorkingMemoryContinuityReaders, WorkingMemoryContinuityRun } from "../../continuity/working-memory";
import type { WorkshopEvent } from "@/lib/workshops/run-history-types";
import { stableJson } from "../../records/observations";

type Header = Omit<WorkingMemoryContinuityRun, "events" | "eventsTruncated">;
async function readRun(input: WorkingMemoryContinuityInput, sourceRunId: string): Promise<Header | null> {
  if (input.scope.kind === "loop") {
    const [row] = await db.select({ id: loopRuns.id, status: loopRuns.status, createdAt: loopRuns.createdAt,
      completedAt: loopRuns.completedAt, loopId: loopRuns.loopId, userId: loops.userId, workshopId: loops.workshopId })
      .from(loopRuns).innerJoin(loops, eq(loopRuns.loopId, loops.id)).where(and(eq(loops.userId, input.userId),
        eq(loops.workshopId, input.workshopId), eq(loops.id, input.scope.loopId), eq(loopRuns.id, sourceRunId))).limit(1);
    return row ?? null;
  }
  const [row] = await db.select({ id: workshopRuns.id, status: workshopRuns.status, createdAt: workshopRuns.createdAt,
    completedAt: workshopRuns.completedAt, userId: workshops.userId, workshopId: workshopRuns.workshopId })
    .from(workshopRuns).innerJoin(workshops, eq(workshopRuns.workshopId, workshops.id))
    .where(and(eq(workshops.userId, input.userId), eq(workshops.id, input.workshopId), eq(workshopRuns.id, sourceRunId))).limit(1);
  return row ? { ...row, loopId: null } : null;
}

/** Exact stored run/event reads; no service imports, fallback to another Work,
 * scheduler calls or implied approval of historical model assertions. */
export const postgresWorkingMemoryContinuityReaders: WorkingMemoryContinuityReaders = {
  async ownsScope(input) {
    const [owned] = await db.select({ id: workshops.id }).from(workshops)
      .where(and(eq(workshops.id, input.workshopId), eq(workshops.userId, input.userId))).limit(1);
    if (!owned) return false;
    if (input.scope.kind !== "loop") return true;
    const [loop] = await db.select({ id: loops.id }).from(loops).where(and(eq(loops.userId, input.userId),
      eq(loops.workshopId, input.workshopId), eq(loops.id, input.scope.loopId))).limit(1);
    return !!loop;
  },
  async listPredecessors(input) {
    if (input.scope.kind === "loop") return db.select({ id: loopRuns.id, status: loopRuns.status, createdAt: loopRuns.createdAt,
      completedAt: loopRuns.completedAt, loopId: loopRuns.loopId, userId: loops.userId, workshopId: loops.workshopId })
      .from(loopRuns).innerJoin(loops, eq(loopRuns.loopId, loops.id)).where(and(eq(loops.userId, input.userId),
        eq(loops.workshopId, input.workshopId), eq(loops.id, input.scope.loopId), ne(loopRuns.id, input.currentRunId)))
      .orderBy(desc(loopRuns.createdAt), desc(loopRuns.id)).limit(2);
    const row = await readRun(input, input.scope.parentRunId);
    return row ? [row] : [];
  },
  async loadEvents(input, sourceRunId, limit): Promise<WorkshopEvent[]> {
    const rows: StoredWorkshopEvent[] = await db.select().from(workshopEvents).where(and(eq(workshopEvents.workshopId, input.workshopId),
      input.scope.kind === "loop" ? and(eq(workshopEvents.loopId, input.scope.loopId), eq(workshopEvents.loopRunId, sourceRunId))
        : and(eq(workshopEvents.runId, sourceRunId), isNull(workshopEvents.loopId), isNull(workshopEvents.loopRunId))))
      .orderBy(asc(workshopEvents.seq)).limit(limit);
    return rows.map(row => ({ ...row, metadata: deserializeJson(row.metadata) as Record<string, unknown>,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt) }));
  },
  loadRun: readRun,
  async loadRuntimeBinding(input, sourceRunId) {
    const rows: Array<{ snapshot_json: unknown }> = await db.execute(sql`SELECT s.snapshot_json FROM workshop_runtime_snapshots s
      JOIN workshops w ON w.id=s.workshop_id
      WHERE w.user_id=${input.userId}::uuid AND s.workshop_id=${input.workshopId}::uuid
        AND ${input.scope.kind === "loop" ? sql`s.loop_id=${input.scope.loopId}::uuid AND s.loop_run_id=${sourceRunId}::uuid`
          : sql`s.run_id=${sourceRunId}::uuid AND s.loop_id IS NULL AND s.loop_run_id IS NULL`} LIMIT 17`);
    if (!rows.length || rows.length > 16) return null;
    const bindings = rows.map(row => {
      const saved = row.snapshot_json as Record<string, unknown>, extra = saved?.extra as Record<string, unknown> | undefined;
      return saved?.schemaVersion === 'agent-runtime-run-snapshot.v1' ? extra?.continuityBinding : null;
    });
    if (bindings.some(value => !value || typeof value !== 'object' || Array.isArray(value))) return null;
    const unique = new Set(bindings.map(value => stableJson(value)));
    return unique.size === 1 ? bindings[0] : null;
  },
};
