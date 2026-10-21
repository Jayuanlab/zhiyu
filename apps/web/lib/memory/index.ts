// Explicit public capabilities. Storage adapters and trusted identity issuers stay internal.
export { createOwnerMemoryClient } from "./client";
export { createObservation, listObservations } from "./ingestion/observations";
export { resolveEvidenceRefs } from "./evidence/reader";
export { groupResolvedEvidenceRoots } from "./evidence/lineage";
export type { ObservationAppendCommand, ObservationRecord, RecordRef, VersionRef,
  EvidenceRange, MemoryReadQuery, ObservationReadResult, ObservationSubmitResult,
  StateRecordRef, StateVersionRef, CurrentStateReadQuery, CurrentStateReadResult } from "./contracts";
export type { RevisionStateRecordRef, RevisionStateVersionRef, RevisionStateReadQuery, RevisionStateReadResult,
  CurrentMemoryRecord, CurrentMemoryDependenciesRecord } from "./contracts";
export type { RevisionCommandKind, RevisionCommandResult, RevisionOutcome } from "./revision/owner-commands";
export type { DiscoveryReadQuery, ContextRecallReadQuery, DiscoveryReadResult, ContextRecallReadResult,
  MemoryQueryReadResult, MemoryContextPack, ContextEntry, QueryReadReceipt } from "./query-contracts";
export type { ArtifactRecordRef, ArtifactVersionRef, ArtifactCommand, ArtifactCommandResult, ArtifactCurrentReadQuery,
  ArtifactEvidenceReadQuery, ArtifactReadResult } from "./artifact-contracts";
