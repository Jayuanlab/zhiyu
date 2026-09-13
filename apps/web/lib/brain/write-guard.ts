import { db } from "@/lib/db/client";
import type { DrizzleDB } from "@/lib/db/types";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import { withExecutionWrite } from "@/lib/work-runtime/execution-lease";
import { ExecutionLeaseError } from "@/lib/work-runtime/execution-errors";
import type { BrainMemory } from "./types";

export class BrainMemoryIdentityConflict extends Error {
  readonly code = "memory_identity_conflict";
  constructor() {
    super("Brain memory identity conflict");
  }
}

/** Guard database-only auxiliary writes without treating the execution lease as
 * a resource grant. Reused immutable observations do not emit another write. */
export async function withBrainRecordWrite<T>(
  userId: string,
  recordType: "observation" | "snapshot" | "context_log" | "review",
  write: (store: DrizzleDB) => Promise<{id: string; result: T; written?: boolean}>,
): Promise<T> {
  const lease = resolveExecutionLease();
  if (!lease) return db.transaction(async store => (await write(store)).result);
  if (lease.userId !== userId) throw new ExecutionLeaseError("invalid_lease");
  return withExecutionWrite(lease, async ({db: store, append}) => {
    const record = await write(store);
    if (record.written !== false) await append({
      workshopId: lease.workshopId, runId: lease.runId,
      type: "brain_record_written", title: "Brain 记录写入完成", visibility: "debug",
      metadata: {recordType, recordId: record.id, actorId: lease.userId,
        execution: {workerId: lease.workerId, token: lease.token}},
    });
    return record.result;
  });
}

/** Resource permissions remain the service's responsibility. A lease is not a
 * new grant: it binds this database write to the active worker and user. */
export async function withBrainMemoryWrite<T>(
  memory: BrainMemory,
  write: (store: DrizzleDB) => Promise<T>,
): Promise<T> {
  return withBrainMemoryTransaction(memory.userId, async (store) => ({
    memory,
    result: await write(store),
  }));
}

/** The callback performs database work only and returns the committed memory
 * state used for the execution audit. */
export async function withBrainMemoryTransaction<T>(
  userId: string,
  write: (store: DrizzleDB) => Promise<{ memory: BrainMemory; result: T }>,
): Promise<T> {
  const lease = resolveExecutionLease();
  if (!lease) return db.transaction(async (store) => (await write(store)).result);
  if (userId !== lease.userId) throw new ExecutionLeaseError("invalid_lease");
  return withExecutionWrite(lease, async ({ db: store, append }) => {
    const { memory, result } = await write(store);
    if (memory.userId !== userId) throw new ExecutionLeaseError("invalid_lease");
    await append({
      workshopId: lease.workshopId,
      runId: lease.runId,
      type: "brain_memory_written",
      title: "记忆写入完成",
      visibility: "debug",
      metadata: {
        actorId: lease.userId,
        memoryId: memory.id,
        scope: memory.scope,
        ownerType: memory.ownerType,
        ownerId: memory.ownerId,
        status: memory.status,
        execution: { workerId: lease.workerId, token: lease.token },
      },
    });
    return result;
  });
}
