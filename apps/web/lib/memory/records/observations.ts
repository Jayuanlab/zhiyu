import { createHash } from "node:crypto";
import type { BrainObservation, InsertBrainObservation } from "@/lib/db/schema";
import { deserializeJson, serializeJson } from "@/lib/db/serialization";
import type { ObservationInput, ObservationRecord, VersionRef } from "../contracts";

export function observationToInsertRow(input: ObservationInput): InsertBrainObservation {
  return { id: input.id, userId: input.userId, sourceType: input.sourceType, sourceId: input.sourceId,
    sourceEventId: input.sourceEventId ?? null, observedAt: input.observedAt instanceof Date ? input.observedAt : new Date(input.observedAt),
    content: input.content, contentHash: input.contentHash, trustLevel: input.trustLevel ?? "raw",
    metadata: serializeJson(input.metadata ?? {}) } as InsertBrainObservation;
}
function iso(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid stored observation timestamp");
  return date.toISOString();
}
export function observationFromRow(row: BrainObservation): ObservationRecord {
  return { id: row.id, userId: row.userId, sourceType: row.sourceType, sourceId: row.sourceId,
    sourceEventId: typeof row.sourceEventId === "string" ? row.sourceEventId : undefined,
    observedAt: iso(row.observedAt), content: row.content, contentHash: row.contentHash, trustLevel: row.trustLevel,
    metadata: deserializeJson(row.metadata) as Record<string, unknown>, createdAt: iso(row.createdAt) };
}
export function observationVersion(observation: ObservationRecord): VersionRef {
  // Hash actual stored content, including provenance; never trust a legacy contentHash as the version.
  const revision = createHash("sha256").update(JSON.stringify(["observation.v1", observation.id, observation.userId,
    observation.sourceType, observation.sourceId, observation.sourceEventId ?? null, observation.observedAt,
    observation.content, observation.trustLevel, stableJson(observation.metadata)])).digest("hex");
  return { record: { kind: "observation", id: observation.id }, revision: `obsrv1:${revision}` };
}
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}
