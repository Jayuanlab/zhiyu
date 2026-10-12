import { getBrainMemoryCanonicalMetadata } from "./canonical";
import type { BrainMemory } from "./types";
import { sql } from "drizzle-orm";
import type { DrizzleDB } from "@/lib/db/types";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import { BrainMemoryWriteBusy } from "./write-errors";

/** A leased business fence may already hold source SHARE rows. Waiting for a
 * writer advisory lock would invert canonical-before-row order. Fail explicitly
 * and let the outer transaction release those source rows instead. */
export async function acquireBrainWriteAdvisoryLock(store: DrizzleDB, key: string) {
  if (!resolveExecutionLease()) {
    await store.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`);
    return;
  }
  const rows = await store.execute(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key},0)) AS acquired`);
  if (rows[0]?.acquired !== true) throw new BrainMemoryWriteBusy();
}

/** Two leased gates can both hold SHARE on A and B, then write different rows.
 * A nonblocking row upgrade prevents that independent-canonical lock cycle. */
export function brainWriteRowLockOptions(): { noWait: true } | undefined {
  return resolveExecutionLease() ? { noWait: true } : undefined;
}

export function getBrainMemoryCanonicalWriteLockKey(memory: BrainMemory): string {
  const scopeId = memory.scope.type === "global" ? null
    : memory.scope.type === "workspace" ? memory.scope.workspaceId
    : memory.scope.type === "workshop" ? memory.scope.workshopId : memory.scope.workId;
  return JSON.stringify(["brain-memory-canonical-write.v1", memory.userId, memory.scope.type,
    scopeId, memory.ownerType, memory.ownerId, getBrainMemoryCanonicalMetadata(memory).canonicalGroupId]);
}
