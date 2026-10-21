export type ObservationRecord = {
  id: string; userId: string; sourceType: string; sourceId: string;
  sourceEventId?: string; observedAt: string; content: string; contentHash: string;
  trustLevel: string; metadata: Record<string, unknown>; createdAt: string;
};
export type ObservationInput = {
  id?: string; userId: string; sourceType: string; sourceId: string;
  sourceEventId?: string | null; observedAt: string | Date; content: string;
  contentHash: string; trustLevel?: string; metadata?: Record<string, unknown>;
};
export type RecordRef = { kind: "observation"; id: string };
export type VersionRef = { record: RecordRef; revision: string };
export type ObservationAppendCommand = {
  kind: "observation.append"; commandId: string; sourceId: string;
  observedAt: string; content: string; metadata?: Record<string, unknown>;
};
export type EvidenceRange = { start: number; end: number };
export type MemoryReadQuery =
  | { purpose: "evidence"; ref: VersionRef; range: EvidenceRange }
  | { purpose: "current"; ref: RecordRef }
  | import("./query-contracts").DiscoveryReadQuery
  | import("./query-contracts").ContextRecallReadQuery
  | import("./artifact-contracts").ArtifactCurrentReadQuery
  | import("./artifact-contracts").ArtifactEvidenceReadQuery;
export type MemoryResultMeta = {
  traceId: string; contractVersion: "memory-observation.v1" | "memory-state.v1" | "memory-revision.v1" | "memory-query.v1" | "memory-artifact.v1";
  implementationVersion: "memory-t1.v1" | "memory-t2.v1" | "memory-t3.v1" | "memory-t4.v1" | "memory-t5.v1"; provider: "postgres";
  detail: string; warnings: string[];
};
export type OperationReceipt = {
  id: string; commandId: string; ref: VersionRef; createdAt: string;
};
export type ReadReceipt = {
  id: string; purpose: "current" | "evidence"; ref: VersionRef;
  actualRange: EvidenceRange & { unit: "unicode_code_points" };
  totalLength: number; createdAt: string;
};
export type ObservationSubmitResult = {
  status: "committed"; replayed: boolean; observation: ObservationRecord;
  ref: VersionRef; receipt: OperationReceipt; meta: MemoryResultMeta;
};
export type ObservationReadResult =
  | { status: "ok"; content: string; ref: VersionRef; receipt: ReadReceipt; meta: MemoryResultMeta }
  | { status: "not_found" | "unavailable"; code: string; meta: MemoryResultMeta };

export type StateRecordRef = { kind: "interaction_task"; id: string }
  | { kind: "scenario_state"; scenarioType: import("./kernel/scenario-identity").ScenarioType; scenarioKey: string };
export type StateVersionRef = { record: StateRecordRef; revision: string };
export type StateReadReceipt = { id: string; purpose: "current"; ref: StateVersionRef; createdAt: string };
export type CurrentStateReadQuery = { purpose: "current"; ref: StateRecordRef };
export type CurrentStateReadResult =
  | { status: "ok"; record: import("@/lib/db/schema").InteractionTask | import("./records/scenario-record").ScenarioSnapshotRecord;
      ref: StateVersionRef; receipt: StateReadReceipt; meta: MemoryResultMeta }
  | { status: "not_found" | "unavailable"; code: string; meta: MemoryResultMeta };

export type RevisionStateRecordRef = { kind: "memory"; id: string }
  | { kind: "memory_dependencies"; entityKind: "wiki_note" | "interaction_task" | "loop"; entityId: string };
export type RevisionStateVersionRef = { record: RevisionStateRecordRef; revision: string };
export type RevisionStateReadQuery = { purpose: "current"; ref: RevisionStateRecordRef };
export type CurrentMemoryRecord = import("./kernel/memory-types").BrainMemory & { revisionVersion: string };
export type CurrentMemoryDependenciesRecord = import("./revision/dependency-check").MemoryDependencySnapshot & { id: string; verified: boolean };
export type RevisionStateReadResult =
  | { status: "ok"; record: CurrentMemoryRecord | CurrentMemoryDependenciesRecord; ref: RevisionStateVersionRef;
      receipt: { id: string; purpose: "current"; ref: RevisionStateVersionRef; createdAt: string }; meta: MemoryResultMeta }
  | { status: "not_found" | "unavailable"; code: string; meta: MemoryResultMeta };
