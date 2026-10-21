import type {
  Observation,
  VersionRef as GeneralVersion,
} from "../../../../packages/memory/src/index";
import type { ObservationRecord, VersionRef } from "@/lib/memory/contracts";
export const sourceId = "zhiyu.observations";
export const extension = "zhiyu.legacy.v1";
export function toCore(r: ObservationRecord): Observation {
  return {
    namespace: { tenantId: r.userId, projectId: "zhiyu" },
    id: r.id,
    source: {
      sourceId,
      externalId: r.sourceId,
      ...(r.sourceEventId ? { version: r.sourceEventId } : {}),
    },
    observedAt: r.observedAt,
    ingestedAt: r.createdAt,
    content: r.content,
    contentHash: r.contentHash,
    provenance: { kind: r.sourceType, trustLevel: r.trustLevel },
    extensions: { [extension]: r.metadata },
  };
}
export function fromCore(r: Observation): ObservationRecord {
  return {
    id: r.id,
    userId: r.namespace.tenantId,
    sourceType: r.provenance.kind,
    sourceId: r.source.externalId,
    sourceEventId: r.source.version,
    observedAt: r.observedAt,
    createdAt: r.ingestedAt,
    content: r.content,
    contentHash: r.contentHash,
    trustLevel: r.provenance.trustLevel,
    metadata: r.extensions[extension] as Record<string, unknown>,
  };
}
export const legacyRef = (r: GeneralVersion): VersionRef => ({
  record: { kind: "observation", id: r.record.id },
  revision: r.value,
});
export const generalRef = (owner: string, r: VersionRef): GeneralVersion => ({
  record: { tenantId: owner, projectId: "zhiyu", ...r.record },
  scheme: "obsrv1",
  value: r.revision,
});
