import { createHash } from "node:crypto";
import type { ObservationInput } from "../contracts";
import { MemoryModuleError } from "../kernel/errors";
import { upsertObservation, listObservationsForUser } from "../adapters/postgres/observations";

export function hashObservation(input: Pick<ObservationInput, "sourceType" | "sourceId" | "observedAt" | "content">) {
  return createHash("sha256").update(JSON.stringify({ sourceType: input.sourceType, sourceId: input.sourceId,
    observedAt: input.observedAt instanceof Date ? input.observedAt.toISOString() : input.observedAt, content: input.content })).digest("hex");
}
/** Compatibility ingestion for trusted existing sources. Owner HTTP uses the stricter command contract. */
export async function createObservation(input: Omit<ObservationInput, "id" | "contentHash">) {
  if (input.sourceType === "owner_memory_correction_intent") throw new MemoryModuleError("reserved_correction_observation", 400,
    "Use the owner correction draft command to record correction intent");
  return upsertObservation({ ...input, contentHash: hashObservation(input) });
}
export const listObservations = listObservationsForUser;
