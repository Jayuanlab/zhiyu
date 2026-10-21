import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import { getBrainMemoryCanonicalMetadata } from "./canonical";
import type { BrainMemory } from "../kernel/memory-types";

export { acquireMemoryWriteAdvisoryLock,
  acquireMemoryWriteAdvisoryLock as acquireBrainWriteAdvisoryLock } from "../kernel/locks";

/** Leased gates can hold SHARE rows for multiple canonical groups. A nonblocking
 * upgrade prevents a cross-group row-lock cycle. */
export function memoryWriteRowLockOptions(): { noWait: true } | undefined {
  return resolveExecutionLease() ? { noWait: true } : undefined;
}

export function getMemoryCanonicalWriteLockKey(memory: BrainMemory): string {
  const scopeId = memory.scope.type === "global" ? null
    : memory.scope.type === "workspace" ? memory.scope.workspaceId
    : memory.scope.type === "workshop" ? memory.scope.workshopId : memory.scope.workId;
  // Keep the existing lock namespace so old and new callers serialize together.
  return JSON.stringify(["brain-memory-canonical-write.v1", memory.userId, memory.scope.type,
    scopeId, memory.ownerType, memory.ownerId, getBrainMemoryCanonicalMetadata(memory).canonicalGroupId]);
}

export { memoryWriteRowLockOptions as brainWriteRowLockOptions,
  getMemoryCanonicalWriteLockKey as getBrainMemoryCanonicalWriteLockKey };
