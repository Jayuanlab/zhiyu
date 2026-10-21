import { findPendingBrainMemoryUpdates } from "../revision/proposals";
import { getBrainMemoryRevisionVersion } from "../revision/version";
import type { BrainMemory } from "../kernel/memory-types";

/** Read-only recall annotation. Stored versions and evidence are never rewritten. */
export async function annotatePendingMemoryUpdates(memories: BrainMemory[]): Promise<BrainMemory[]> {
  const grouped = new Map<string, BrainMemory[]>();
  for (const memory of memories) grouped.set(memory.userId, [...(grouped.get(memory.userId) ?? []), memory]);
  const pendingIds = new Set<string>();
  for (const [userId, rows] of grouped) {
    for (let start = 0; start < rows.length; start += 100) {
      const batch = rows.slice(start, start + 100), byId = new Map(batch.map(memory => [memory.id, memory]));
      const pending = await findPendingBrainMemoryUpdates({ userId, baseMemoryIds: [...byId.keys()] });
      for (const item of pending) {
        const base = byId.get(item.targetMemoryId);
        if (!base || item.expectedBaseVersion !== getBrainMemoryRevisionVersion(base)) continue;
        pendingIds.add(base.id);
      }
    }
  }
  return memories.map(memory => {
    if (!pendingIds.has(memory.id)) return memory;
    return { ...memory, metadata: { ...memory.metadata,
      pendingMemoryUpdate: { requiresOwnerDecision: true, basis: "current_stored_version" },
    } };
  });
}
