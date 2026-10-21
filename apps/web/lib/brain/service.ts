/** Compatibility only; actual implementations live in Memory capabilities. */
export { createBrainStateSnapshot, listBrainSnapshots, catalogBrainSnapshots } from "@/lib/memory/continuity/state-snapshots";
export { listBrainMemory, getBrainMemory, listBrainReviews, listBrainCandidates } from "@/lib/memory/retrieval/queries";
export { createObservation as createBrainObservation, listObservations as listBrainObservations } from "@/lib/memory/ingestion/observations";
export { writeMemory as writeBrainMemory, createMemoryCandidate as createBrainMemoryCandidate, reviewMemory as reviewBrainMemory } from "@/lib/memory/revision/writes";
export { buildBrainContextForRequester, buildBrainContextFromMemoryRequest, attachSelectedEvidenceReadResults } from "@/lib/memory/retrieval/recall";
export type { BrainRecallRouteResult } from "@/lib/memory/retrieval/recall";
export { createBrainAccessGrant as grantBrainAccess, deleteBrainAccessGrant as revokeBrainAccess } from "@/lib/memory/governance/access-grants";
export { listBrainAccessGrantsForUser as listBrainGrants } from "@/lib/memory/adapters/postgres/memory-records";
