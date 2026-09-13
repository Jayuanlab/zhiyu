import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import type { DrizzleDB } from "@/lib/db/types";
import { workshopEvents, type WorkshopEvent } from "@/lib/db/schema";
import { publishWorkshopEvent } from "./event-bus";
import type { AppendWorkshopEventInput } from "./types";

type AppendEvent = (input: AppendWorkshopEventInput) => Promise<WorkshopEvent>;
type WriteSavepoint = <T>(work: () => Promise<T>) => Promise<T>;

/** State and its events commit together; notifications can only follow commit. */
export async function withWorkshopEventTransaction<T>(
  work: (tx: DrizzleDB, append: AppendEvent, savepoint: WriteSavepoint) => Promise<T>,
): Promise<T> {
  if (process.env.TAURI_MODE === "true" || process.env.IS_TAURI === "true") {
    throw new Error("Transactional workshop events require PostgreSQL");
  }
  const committed: WorkshopEvent[] = [];
  const result = await db.transaction(async (tx: DrizzleDB) => {
    let scopeNumber = 0;
    const savepoint: WriteSavepoint = async (attempt) => {
      const name = `work_write_${++scopeNumber}`;
      const eventCount = committed.length;
      await tx.execute(sql.raw(`SAVEPOINT ${name}`));
      try {
        const value = await attempt();
        await tx.execute(sql.raw(`RELEASE SAVEPOINT ${name}`));
        return value;
      } catch (error) {
        await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${name}`));
        await tx.execute(sql.raw(`RELEASE SAVEPOINT ${name}`));
        committed.length = eventCount;
        throw error;
      }
    };
    return work(tx, async (input) => {
    // Lazy initialization also supports a newly created Work. ON CONFLICT makes
    // two first writers converge on the same counter row.
    await tx.execute(sql`
      INSERT INTO workshop_event_counters (workshop_id, last_seq)
      SELECT ${input.workshopId}::uuid,
        COALESCE((SELECT max(seq) FROM workshop_events WHERE workshop_id = ${input.workshopId}::uuid), 0)
      WHERE NOT EXISTS (SELECT 1 FROM workshop_event_counters WHERE workshop_id = ${input.workshopId}::uuid)
      ON CONFLICT (workshop_id) DO NOTHING
    `);
    const rows = await tx.execute(sql`
      UPDATE workshop_event_counters SET last_seq = last_seq + 1
      WHERE workshop_id = ${input.workshopId}::uuid RETURNING last_seq
    `);
    if (!rows[0]) throw new Error("Workshop event counter missing");
    const [event] = await tx.insert(workshopEvents).values({
      id: crypto.randomUUID(), workshopId: input.workshopId,
      runId: input.runId ?? null, loopId: input.loopId ?? null,
      loopRunId: input.loopRunId ?? null, seq: Number(rows[0].last_seq),
      type: input.type, title: input.title, body: input.body ?? null,
      metadata: input.metadata ?? {}, visibility: input.visibility ?? "user",
      createdAt: new Date(),
    }).returning();
    if (!event) throw new Error("Workshop event insert returned no row");
    committed.push(event as WorkshopEvent);
    return event as WorkshopEvent;
    }, savepoint);
  });
  for (const event of committed) {
    try { publishWorkshopEvent(event); }
    catch (error) {
      // Durable polling recovers this notification. Do not report a committed
      // transaction as failed and encourage a duplicate command retry.
      console.warn("[WorkshopEvents] committed event notification failed", {eventId: event.id, workshopId: event.workshopId, error: error instanceof Error ? error.message : String(error)});
    }
  }
  return result;
}
