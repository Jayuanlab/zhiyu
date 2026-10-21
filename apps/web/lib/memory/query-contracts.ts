import type { BrainMemoryStatus, BrainMemoryType } from "./kernel/memory-types";
import type { StateRecordRef, StateVersionRef, VersionRef, MemoryResultMeta } from "./contracts";
import type { InformationNeed } from "./retrieval/information-needs";

export type DiscoveryReadQuery = { purpose: "discover"; query: string; limit?: number; cursor?: string;
  filters?: { memoryTypes?: BrainMemoryType[]; statuses?: BrainMemoryStatus[] } };
export type ContextRecallReadQuery = { purpose: "recall"; taskIntent: string; needs?: InformationNeed[];
  maxTokens?: number; currentRefs?: StateRecordRef[] };
export type QueryVersionRef = { record: { kind: "memory"; id: string }; revision: string } | VersionRef | StateVersionRef;
export type QueryReadReceipt = { id: string; purpose: "discover" | "recall"; createdAt: string };
export type DiscoveryItem = { id: string; subject: string; content: string; memoryType: BrainMemoryType; status: BrainMemoryStatus;
  ref: QueryVersionRef; evidenceRefs: string[]; updatedAt: string; expiresAt?: string; truncated: boolean;
  useSemantics: "discovery_only"; receipt: QueryReadReceipt };
export type ContextEntry = { ref: QueryVersionRef; content: string; subject: string;
  useSemantics: "saved_interpretation" | "safety_constraint" | "authoritative_current_state" | "raw_observation";
  freshness: { asOf: string; observedAt?: string; basis: string }; receipt: { id: string; kind: string };
  evidenceRefs?: string[]; truncated?: boolean; truncationReason?: string };
export type MemoryContextPack = { interfaceVersion: "memory-context.v1"; contextLogId: string;
  currentStates: ContextEntry[]; historicalEvidence: ContextEntry[]; interpretations: ContextEntry[]; constraints: ContextEntry[];
  openQuestions: Array<{ code: string; detail: string }>;
  budget: { maxTokens: number; usedUpperBound: number; unit: "utf8_bytes_upper_bound"; truncated: boolean };
  coverage: { discovery: false; candidateCoverage: "bounded"; dependencyCoverage: "registered_edges_only";
    independentBusinessVerification: false; exactHistoricalEvidence: "observation_only" } };
export type DiscoveryReadResult = { status: "ok" | "empty"; purpose: "discover"; items: DiscoveryItem[]; nextCursor: string | null;
  receipt: QueryReadReceipt; meta: MemoryResultMeta; coverage: { recordKinds: ["memory"]; complete: false; limit: number } };
export type ContextRecallReadResult = { status: "ok" | "empty"; purpose: "recall"; pack: MemoryContextPack;
  receipt: QueryReadReceipt; meta: MemoryResultMeta }
  | { status: "unavailable"; purpose: "recall"; code: string; meta: MemoryResultMeta };
export type MemoryQueryReadResult = DiscoveryReadResult | ContextRecallReadResult;
