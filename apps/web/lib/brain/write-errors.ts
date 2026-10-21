/** Compatibility only; actual implementations live in Memory capabilities. */
export { MemoryReferenceError as BrainReferenceError, MemoryWriteBusy as BrainMemoryWriteBusy, assertMemoryReferenceIds as assertBrainReferenceIds } from "@/lib/memory/kernel/reference-errors";
export { MemoryRevisionProtected as BrainMemoryRevisionProtected } from "@/lib/memory/revision/legacy-errors";
