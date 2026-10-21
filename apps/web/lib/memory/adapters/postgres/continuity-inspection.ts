import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { workshops, loops, workshopEvents } from "@/lib/db/schema";

export const CONTINUITY_INSPECTION_TYPES = ["working_memory_updated", "working_memory_restored", "working_memory_continuity_loaded",
  "working_memory_projected", "working_memory_usage", "working_memory_rejected", "loop_business_checkpoint_saved", "business_checkpoint_loaded"];
export type ContinuityInspectionEvent = { id: string; runId: string | null; loopId: string | null; loopRunId: string | null;
  createdAt: Date | string; type: string; status: unknown; reason: unknown; schemaVersion: unknown; runtimeBinding: unknown;
  sourceRunId: unknown; guidanceStatus: unknown; usageStatus: unknown; usageSource: unknown; persistenceError: unknown; truncated: unknown };
type InspectionRows = { works: Array<{ id: string; name: string }>; hasMore: boolean }
  | { work: { id: string; name: string }; events: ContinuityInspectionEvent[]; hasMore: boolean } | null;

/** Fixed owner/scope predicates and fixed scalar projections only. No summaries,
 * checkpoint state, event bodies or newly invented read receipts are returned. */
export async function readContinuityInspection(input: { userId: string; workshopId?: string; loopId?: string; limit: number }): Promise<InspectionRows> {
  if (!input.workshopId) {
    const rows: Array<{ id: string; name: string }> = await db.select({ id: workshops.id, name: workshops.name }).from(workshops)
      .where(eq(workshops.userId, input.userId)).orderBy(desc(workshops.updatedAt), workshops.id).limit(input.limit + 1);
    return { works: rows.slice(0, input.limit), hasMore: rows.length > input.limit };
  }
  return db.transaction(async store => {
    const [work] = await store.select({ id: workshops.id, name: workshops.name }).from(workshops)
      .where(and(eq(workshops.userId, input.userId), eq(workshops.id, input.workshopId))).for("share");
    if (!work) return null;
    if (input.loopId) {
      const [loop] = await store.select({ id: loops.id }).from(loops)
        .where(and(eq(loops.userId, input.userId), eq(loops.workshopId, input.workshopId), eq(loops.id, input.loopId))).for("share");
      if (!loop) return null;
    }
    const metadata = workshopEvents.metadata;
    const events: ContinuityInspectionEvent[] = await store.select({ id: workshopEvents.id, runId: workshopEvents.runId,
      loopId: workshopEvents.loopId, loopRunId: workshopEvents.loopRunId, createdAt: workshopEvents.createdAt, type: workshopEvents.type,
      status: sql` ${metadata}->>'status'`, reason: sql`coalesce(${metadata}->>'reason',${metadata}->>'code')`,
      schemaVersion: sql`${metadata}->>'schemaVersion'`, runtimeBinding: sql`${metadata}->'runtimeBinding'`,
      sourceRunId: sql`coalesce(${metadata}->>'sourceRunId',${metadata}->'checkpoint'->>'sourceRunId',${metadata}->'scope'->>'parentRunId')`,
      guidanceStatus: sql`${metadata}->'guidanceAdmission'->>'status'`, usageStatus: sql`${metadata}->>'usageStatus'`,
      usageSource: sql`${metadata}->>'source'`, persistenceError: sql`${metadata}->>'persistenceError'`, truncated: sql`${metadata}->'__truncated'`,
    }).from(workshopEvents).where(and(eq(workshopEvents.workshopId, input.workshopId),
      input.loopId ? eq(workshopEvents.loopId, input.loopId) : undefined,
      inArray(workshopEvents.type, CONTINUITY_INSPECTION_TYPES), sql`${metadata}->>'receiptAuthority'='runtime'`))
      .orderBy(desc(workshopEvents.seq)).limit(input.limit + 1);
    return { work: { id: String(work.id), name: String(work.name) }, events: events.slice(0, input.limit), hasMore: events.length > input.limit };
  });
}
