/** Compatibility only; actual implementations live in Memory capabilities. */
export { acquireMemoryWriteAdvisoryLock as acquireBrainWriteAdvisoryLock } from "@/lib/memory/kernel/locks";
export { memoryWriteRowLockOptions as brainWriteRowLockOptions, getMemoryCanonicalWriteLockKey as getBrainMemoryCanonicalWriteLockKey } from "@/lib/memory/revision/locks";
