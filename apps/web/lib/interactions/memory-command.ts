import { and, eq, inArray } from "drizzle-orm";
import { db, withDatabaseTransaction } from "@/lib/db/client";
import { brainMemories, interactionEvents, type InteractionMemory } from "@/lib/db/schema";
import type { DrizzleDB } from "@/lib/db/types";
import { brainMemoryFromRow } from "@/lib/memory/records/memory-record";
import { getBrainMemoryCanonicalMetadata } from "@/lib/memory/kernel/memory-canonical";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import { withExecutionBusinessWrite, ExecutionLeaseError } from "@/lib/work-runtime/execution-lease";
import { withExecutionWriteContext } from "@/lib/work-runtime/execution-write-context";
import { deserializeJson } from "@/lib/db/serialization";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const INTERACTION_MEMORY_ALIAS_PREFIX = "legacy-interaction-memory:";

export function interactionMemorySourceId(id: string) {
  const sourceId = id.startsWith(INTERACTION_MEMORY_ALIAS_PREFIX) ? id.slice(INTERACTION_MEMORY_ALIAS_PREFIX.length) : id;
  if (!UUID.test(sourceId)) throw new Error("Invalid interaction memory identifier");
  return sourceId;
}

/** All legacy/canonical writes and their existing audit hooks share this command. */
export async function withInteractionMemoryCommand<T>(userId: string, write: (store: DrizzleDB) => Promise<T>): Promise<T> {
  const lease = resolveExecutionLease();
  if (!lease) return withDatabaseTransaction(() => write(db));
  if (lease.userId !== userId) throw new ExecutionLeaseError("invalid_lease");
  return withExecutionBusinessWrite(lease, context =>
    withExecutionWriteContext(lease, context, () => write(context.db)));
}

export async function assertInteractionMemorySources(store: DrizzleDB, userId: string, ids: string[]) {
  const sourceEventIds = [...new Set(ids.map(id => id.trim()).filter(Boolean))];
  if (!sourceEventIds.length) throw new Error("sourceEventIds are required");
  if (sourceEventIds.some(id => !UUID.test(id))) throw new Error("Interaction memory sources require exact raw event identifiers");
  const query = store.select({ id: interactionEvents.id }).from(interactionEvents)
    .where(and(eq(interactionEvents.userId, userId), inArray(interactionEvents.id, sourceEventIds)));
  const rows = await (typeof query.for === "function" ? query.for("share") : query);
  if (rows.length !== sourceEventIds.length) throw new Error("Some sourceEventIds are missing or not accessible");
  return sourceEventIds;
}

/** UUID shape alone is never proof that a Brain record mirrors this source. */
export async function requireInteractionMemoryTarget(store: DrizzleDB, userId: string, id: string, legacy?: InteractionMemory,
  options: { verifySources?: boolean } = {}) {
  const rawMetadata = deserializeJson(legacy?.metadata);
  const metadata = rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)
    ? rawMetadata as Record<string, unknown> : {};
  const targetId = typeof metadata.brainMemoryId === "string" ? interactionMemorySourceId(metadata.brainMemoryId) : interactionMemorySourceId(id);
  const query = store.select().from(brainMemories)
    .where(and(eq(brainMemories.userId, userId), eq(brainMemories.id, targetId)));
  const [row] = await (typeof query.for === "function" ? query.for("update") : query);
  if (!row) throw new Error("Interaction Brain memory is unavailable; no legacy status was changed");
  const memory = brainMemoryFromRow(row);
  const canonical = getBrainMemoryCanonicalMetadata(memory);
  const linked = legacy
    ? canonical.derivedRefs.some(ref => ref.source === "interaction_memory" && ref.id === legacy.id && ref.relation === "mirrors")
    : canonical.derivedRefs.some(ref => ref.source === "interaction_event" && memory.evidenceRefs.includes(ref.id)
      || ref.source === "interaction_memory" && ref.id === id && ref.relation === "mirrors");
  if (memory.id !== targetId || memory.userId !== userId || memory.ownerType !== "chat" || memory.ownerId !== userId || memory.scope.type !== "global" || !linked) {
    throw new Error("Interaction Brain memory does not match the owner and source linkage");
  }
  if (options.verifySources !== false) await assertInteractionMemorySources(store, userId, memory.evidenceRefs);
  return memory;
}

/** Bounded owner discovery is only a lead; callers still validate typed source linkage. */
export async function listInteractionCleanupCandidates(store: DrizzleDB, userId: string) {
  const query = store.select().from(brainMemories).where(and(eq(brainMemories.userId, userId),
    eq(brainMemories.ownerType, "chat"), eq(brainMemories.ownerId, userId), eq(brainMemories.scopeType, "global"),
    inArray(brainMemories.status, ["candidate", "active", "verified", "weakened"])))
    .orderBy(brainMemories.id).limit(501);
  const rows = await (typeof query.for === "function" ? query.for("update") : query);
  if (rows.length > 500) throw new Error("Interaction cleanup discovery exceeds its bounded scope; no records were deleted");
  return rows.map(brainMemoryFromRow);
}
