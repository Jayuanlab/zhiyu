/** Compatibility only; actual implementations live in Memory capabilities. */
export { rethrowMemoryWriteError as rethrowBrainMemoryWriteError, withMemoryRecordWrite as withBrainRecordWrite, withMemoryWrite as withBrainMemoryWrite, withMemoryTransaction as withBrainMemoryTransaction } from "@/lib/memory/revision/transaction";
export { MemoryIdentityConflict as BrainMemoryIdentityConflict } from "@/lib/memory/kernel/reference-errors";
