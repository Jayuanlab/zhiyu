import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { db } from "@/lib/db/client";
import { brainObservations, type BrainObservation } from "@/lib/db/schema";
import type { DrizzleDB } from "@/lib/db/types";
import type { ObservationInput } from "../../contracts";
import { observationFromRow, observationToInsertRow } from "../../records/observations";
import { withObservationTransaction, appendObservationExecutionAudit } from "../../kernel/transaction";
import { MemoryModuleError } from "../../kernel/errors";

export async function insertObservationInTransaction(store: DrizzleDB, input: ObservationInput, strict = false) {
  const [created] = await store.insert(brainObservations).values(observationToInsertRow(input)).onConflictDoNothing().returning();
  if (created) return { observation: observationFromRow(created as BrainObservation), written: true };
  const lookup = store.select().from(brainObservations).where(and(eq(brainObservations.userId, input.userId),
    eq(brainObservations.sourceType, input.sourceType), eq(brainObservations.sourceId, input.sourceId)));
  const [row] = strict ? await lookup.for("share") : await lookup.limit(1);
  if (!row) throw new MemoryModuleError("observation_identity_conflict", 409, "Observation identity conflict");
  const observation = observationFromRow(row as BrainObservation);
  if (strict && (observation.content !== input.content || observation.observedAt !== new Date(input.observedAt).toISOString()
    || observation.sourceEventId !== (input.sourceEventId ?? undefined) || observation.trustLevel !== (input.trustLevel ?? "raw")
    || !isDeepStrictEqual(observation.metadata, input.metadata ?? {}))) {
    throw new MemoryModuleError("observation_source_conflict", 409, "Source identity already refers to a different observation");
  }
  return { observation, written: false };
}
export async function upsertObservation(input: ObservationInput) {
  return withObservationTransaction(input.userId, async context => {
    const result = await insertObservationInTransaction(context.db, input);
    if (result.written) await appendObservationExecutionAudit(context, input.userId, result.observation.id);
    return result.observation;
  });
}
export async function readObservation(store: DrizzleDB, userId: string, id: string) {
  const [row] = await store.select().from(brainObservations).where(and(eq(brainObservations.userId, userId), eq(brainObservations.id, id))).for("share");
  return row ? observationFromRow(row as BrainObservation) : null;
}
export async function listObservationsForUser(input: { userId: string; limit?: number; sourceTypes?: string[] }) {
  const conditions = [eq(brainObservations.userId, input.userId)];
  if (input.sourceTypes?.length) conditions.push(inArray(brainObservations.sourceType, input.sourceTypes));
  const rows = await db.select().from(brainObservations).where(and(...conditions)).orderBy(desc(brainObservations.observedAt)).limit(input.limit ?? 200);
  return (rows as BrainObservation[]).map(observationFromRow);
}
export async function lockObservationCommand(store: DrizzleDB, userId: string, commandId: string) {
  await store.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["memory-observation.v1", userId, commandId])},0))`);
}
