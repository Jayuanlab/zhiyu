/** Compatibility only; actual implementations live in Memory capabilities. */
export { BrainMemoryUpdateError } from "@/lib/memory/kernel/reference-errors";
export type { BrainMemoryUpdateRequest } from "@/lib/memory/revision/proposals";
export { parseBrainMemoryUpdateRequest, createBrainMemoryUpdateProposalInTransaction, proposeBrainMemoryUpdate, getBrainMemoryUpdate, listBrainMemoryUpdates, findPendingBrainMemoryUpdates, decideBrainMemoryUpdate } from "@/lib/memory/revision/proposals";
