import { createHash } from "node:crypto";
import { platformRecordFieldAvailability, platformRecordRelatedReads } from "./platform-record-semantics";

export type LinkedEntityCapture = {
  fields: Record<string, unknown>;
  sourceHash?: string;
  evidenceId?: string;
  status?: undefined;
  captureMetadataGap?: "capture_metadata_not_bound";
};
export type LinkedEntityReadFailure = { status: "duplicate_rows" | "identity_mismatch" };
export type LinkedEntityReader = (id: string) => Promise<LinkedEntityCapture | LinkedEntityReadFailure | null>;
export type LinkedEntityCaptureMetadata = { ownerId: string; id: string; sourceHash?: string; evidenceId?: string };
export type LinkedEntityGap = { via: string; status: string; id?: string; field?: string };
const identityFields = ["id", "name", "entityType", "createdAt"] as const;
const publishedFields = ["id", "name", "entityType", "description", "createdAt"] as const;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const limits = { id: 40, name: 256, entityType: 128, createdAt: 100 };

/** The caller has already applied the fixed owner predicate. Do not select a
 * preferred row when the exact ID is ambiguous, even if the fields agree. */
export function selectLinkedEntityRow(id: string, rows: Record<string, unknown>[]): LinkedEntityCapture | LinkedEntityReadFailure | null {
  if (!rows.length) return null;
  const matching = rows.filter(row => Object.hasOwn(row, "id") && row.id === id);
  if (matching.length > 1) return { status: "duplicate_rows" };
  if (matching.length !== 1) return { status: "identity_mismatch" };
  return { fields: matching[0] };
}

/** Only a caller with an already checked parent may supply the fixed owner reader.
 * The projection reads identity fields, never proves a claim or reads original events. */
export async function platformLinkedEntityIdentities(
  source: string,
  parentFields: Record<string, unknown>,
  readEntity: LinkedEntityReader,
  scope: "authenticated_owner_exact_source" | "frozen_owner_linked_capture",
) {
  if (source !== "memoryGraphRelations" && source !== "memory_graph_relations") return undefined;
  if (scope !== "authenticated_owner_exact_source" && scope !== "frozen_owner_linked_capture") throw Error("Invalid linked identity scope");
  const gaps: LinkedEntityGap[] = [];
  for (const via of ["subjectEntityId", "objectEntityId"]) {
    const aliases = [via, via.replace(/[A-Z]/g, value => "_" + value.toLowerCase())]
      .filter(alias => Object.hasOwn(parentFields, alias));
    const values = aliases.map(alias => parentFields[alias]);
    if (!aliases.length) gaps.push({ via, status: "missing_link" });
    else if (values.every(value => value === null)) gaps.push({ via, status: "not_recorded_link" });
    else if (values.some(value => typeof value !== "string" || !uuid.test(value)) ||
        new Set(values.map(value => (value as string).toLowerCase())).size !== 1)
      gaps.push({ via, status: aliases.length > 1 ? "conflicting_aliases" : "invalid_link" });
  }
  // Reuse the strict scalar alias/UUID/dedup contract; never discover more IDs.
  const refs = platformRecordRelatedReads(source, parentFields).refs.slice(0, 2);
  const entities: Array<{
    source: "memoryGraphEntities"; id: string; via: string; status: "read" | "partial";
    fields: Record<string, unknown>; fieldAvailability: Record<string, string>;
    contentHash: string; sourceHash?: string; evidenceId?: string;
    rawRead: { source: "memoryGraphEntities"; id: string; offset: 0; expectedHash: string };
    rawRecordComplete: false;
  }> = [];
  for (const ref of refs) {
    try {
      const captured = await readEntity(ref.id);
      if (!captured) { gaps.push({ via: ref.via, id: ref.id, status: "not_found_in_scope" }); continue; }
      if (captured.status) { gaps.push({ via: ref.via, id: ref.id, status: captured.status }); continue; }
      const fields = captured.fields;
      if (!Object.hasOwn(fields, "id") || fields.id !== ref.id) {
        gaps.push({ via: ref.via, id: ref.id, status: "identity_mismatch" }); continue;
      }
      const published = Object.fromEntries(publishedFields.filter(field => Object.hasOwn(fields, field))
        .map(field => [field, fields[field]]));
      const contentHash = createHash("sha256").update(JSON.stringify({
        source: "memoryGraphEntities", id: ref.id, fields: published,
      })).digest("hex");
      const shown: Record<string, unknown> = {};
      const startGap = gaps.length;
      if (captured.captureMetadataGap) gaps.push({ via: ref.via, id: ref.id, status: captured.captureMetadataGap });
      for (const field of identityFields) {
        const value = published[field];
        if (value === undefined) { gaps.push({ via: ref.via, id: ref.id, field, status: "missing_field" }); continue; }
        if (value === null) {
          shown[field] = null;
          gaps.push({ via: ref.via, id: ref.id, field, status: "not_recorded" });
          continue;
        }
        if (typeof value !== "string" && !(field === "createdAt" && value instanceof Date)) {
          gaps.push({ via: ref.via, id: ref.id, field, status: "invalid_field" }); continue;
        }
        if (value instanceof Date && !Number.isFinite(value.getTime())) {
          gaps.push({ via: ref.via, id: ref.id, field, status: "invalid_field" }); continue;
        }
        const serialized = JSON.stringify(value);
        if (serialized.length > limits[field]) {
          gaps.push({ via: ref.via, id: ref.id, field, status: "oversize" }); continue;
        }
        shown[field] = value;
      }
      const evidenceId = typeof captured.evidenceId === "string" && JSON.stringify(captured.evidenceId).length <= 200
        ? captured.evidenceId : undefined;
      if (typeof captured.evidenceId === "string" && evidenceId === undefined)
        gaps.push({ via: ref.via, id: ref.id, field: "evidenceId", status: "oversize" });
      entities.push({
        source: "memoryGraphEntities", id: ref.id, via: ref.via,
        status: gaps.length === startGap ? "read" : "partial", fields: shown,
        fieldAvailability: platformRecordFieldAvailability(Object.fromEntries(publishedFields
          .map(field => [field, published[field]])), shown),
        contentHash,
        ...(typeof captured.sourceHash === "string" && /^[a-f0-9]{64}$/.test(captured.sourceHash)
          ? { sourceHash: captured.sourceHash } : {}),
        ...(evidenceId !== undefined ? { evidenceId } : {}),
        rawRead: { source: "memoryGraphEntities", id: ref.id, offset: 0, expectedHash: contentHash },
        rawRecordComplete: false,
      });
    } catch {
      // No raw error message, provider URL or other owner's row is returned.
      gaps.push({ via: ref.via, id: ref.id, status: "query_error" });
    }
  }
  const result = {
    schemaVersion: "platform-linked-entity-identities.v1" as const,
    status: gaps.length ? "partial" as const : "read" as const,
    representation: "bounded_identity_fields" as const,
    scope, ownershipCheck: "repeated_for_each_entity" as const,
    entities, gaps,
    doesNotEstablish: ["claim_truth", "original_observation_read", "action_authority"],
  };
  if (JSON.stringify(result).length <= 3000) return result;
  // An unexpectedly large metadata combination must not enlarge the tool budget.
  return { ...result, status: "partial" as const,
    entities: entities.map(entity => {
      const fields: Record<string, unknown> = { id: entity.id };
      return { ...entity, status: "partial" as const, fields,
      fieldAvailability: Object.fromEntries(Object.entries(entity.fieldAvailability)
        .map(([field, state]) => [field, field === "id" || state !== "shown" ? state : "present_unread"])) };
    }),
    gaps: [{ via: "linkedEntities", status: "projection_over_budget" }],
  };
}
