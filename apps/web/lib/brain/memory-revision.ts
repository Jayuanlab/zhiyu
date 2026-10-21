/** Compatibility only; actual implementations live in Memory capabilities. */
export { getBrainMemoryRevisionVersion } from "@/lib/memory/revision/version";
export type { BrainMemoryRevisionOperation, BrainMemoryRevisionAuthority, BrainMemoryRevisionRequest, BrainMemoryRevisionReceipt, BrainMemoryRevisionResult, BrainMemoryRevisionHistoryItem } from "@/lib/memory/revision/revision";
export { BrainMemoryRevisionError, parseBrainMemoryRevisionRequest, getBrainMemoryForRevision, reviseBrainMemory } from "@/lib/memory/revision/revision";
