import type { Workshop, WorkshopMemory } from "@/lib/db/schema";
import type { DrizzleDB } from "@/lib/db/types";
import { workshopMemoryToBrainMemory } from "../records/workshop-memory";
import { brainMemoryToInsertRow } from "../records/memory-record";
import { MemoryIdentityConflict } from "../kernel/reference-errors";
import { acquireMemoryWriteAdvisoryLock } from "../kernel/locks";
import { getMemoryCanonicalWriteLockKey, memoryWriteRowLockOptions } from "./locks";
import { insertMissingWorkshopMirrorRow, readWorkshopMirrorForUpdate } from "../adapters/postgres/workshop-mirror";

/** Called only inside the already-authorized Work business transaction. The
 * original domain validation, lease and audit stay with its caller. Never
 * upsert an existing source: revised/retired rows remain owned by revision. */
export async function ensureWorkshopMemoryMirrorInTransaction(store: DrizzleDB, input: { workshop: Workshop; memory: WorkshopMemory }) {
  const memory = workshopMemoryToBrainMemory(input), row = brainMemoryToInsertRow(memory);
  await acquireMemoryWriteAdvisoryLock(store, getMemoryCanonicalWriteLockKey(memory));
  await insertMissingWorkshopMirrorRow(store, row);
  const current = await readWorkshopMirrorForUpdate(store, memory.id, memoryWriteRowLockOptions());
  if (!current || current.userId !== row.userId || current.ownerType !== row.ownerType || current.ownerId !== row.ownerId
    || current.scopeType !== row.scopeType || current.scopeId !== row.scopeId) throw new MemoryIdentityConflict();
}
