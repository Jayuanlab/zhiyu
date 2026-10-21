import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import type { DrizzleDB } from "@/lib/db/types";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import { currentExecutionWriteContext } from "@/lib/work-runtime/execution-write-context";
import { withExecutionFence, type ExecutionLease } from "@/lib/work-runtime/execution-fence";
import { ExecutionLeaseError } from "@/lib/work-runtime/execution-errors";
import { withWorkshopEventTransaction } from "@/lib/workshops/event-write";
import type { BrainMemory } from "../kernel/memory-types";
import { MemoryWriteBusy, MemoryIdentityConflict } from "../kernel/reference-errors";
export { MemoryIdentityConflict } from "../kernel/reference-errors";
import { assertMemoryDependenciesCurrentInTransaction } from "./dependency-check";

type Append = Parameters<Parameters<typeof withWorkshopEventTransaction>[0]>[1];
type WriteContext = { db: DrizzleDB; append: Append };

/** Drizzle can wrap lock errors. Always reject the command so its host rolls
 * back both the state change and audit events. */
export function rethrowMemoryWriteError(error: unknown): never {
  let cause: unknown = error;
  if (resolveExecutionLease()) for (let depth = 0; depth < 8 && cause && typeof cause === "object"; depth++) {
    if ((cause as { code?: unknown }).code === "55P03") throw new MemoryWriteBusy();
    const next = (cause as { cause?: unknown }).cause;
    if (next === cause) break;
    cause = next;
  }
  throw error;
}

/** A lease fences the active Work/run; a linked Loop additionally rechecks its
 * registered memory dependencies under the very same transaction locks. */
async function withLeasedWrite<T>(lease: ExecutionLease, business: boolean, write: (context: WriteContext) => Promise<T>): Promise<T> {
  const execute = () => withExecutionFence<WriteContext, T>(lease, async context => {
    if (business) {
      const links = await context.db.execute(sql`SELECT loop_id FROM workshop_loop_executions WHERE run_id=${lease.runId}::uuid AND workshop_id=${lease.workshopId}::uuid AND active`);
      if (links[0]) await assertMemoryDependenciesCurrentInTransaction(context.db, {
        userId: lease.userId, entityKind: "loop", entityId: String(links[0].loop_id),
      });
    }
    return write(context);
  }, {
    currentContext: currentExecutionWriteContext,
    transaction: callback => withWorkshopEventTransaction((store, append) => callback({ db: store, append })),
  });
  if (!business) return execute();
  try { return await execute(); } catch (error) { return rethrowMemoryWriteError(error); }
}

/** Auxiliary records keep their previous fencing distinction: snapshots are
 * business writes; observations, context logs and reviews use the raw fence. */
export async function withMemoryRecordWrite<T>(
  userId: string,
  recordType: "observation" | "snapshot" | "context_log" | "review",
  write: (store: DrizzleDB) => Promise<{ id: string; result: T; written?: boolean }>,
): Promise<T> {
  const lease = resolveExecutionLease();
  if (!lease) return db.transaction(async store => (await write(store)).result);
  if (lease.userId !== userId) throw new ExecutionLeaseError("invalid_lease");
  return withLeasedWrite(lease, recordType === "snapshot", async ({ db: store, append }) => {
    const record = await write(store);
    if (record.written !== false) await append({
      workshopId: lease.workshopId, runId: lease.runId,
      type: "brain_record_written", title: "Brain 记录写入完成", visibility: "debug",
      metadata: { recordType, recordId: record.id, actorId: lease.userId,
        execution: { workerId: lease.workerId, token: lease.token } },
    });
    return record.result;
  });
}

/** Resource permissions remain the caller's responsibility; a lease is not a grant. */
export async function withMemoryWrite<T>(memory: BrainMemory, write: (store: DrizzleDB) => Promise<T>): Promise<T> {
  return withMemoryTransaction(memory.userId, async store => ({ memory, result: await write(store) }));
}

/** The database-only callback and the returned record must belong to the same
 * user as the server-held execution capability. */
export async function withMemoryTransaction<T>(
  userId: string,
  write: (store: DrizzleDB) => Promise<{ memory: BrainMemory; result: T; written?: boolean }>,
): Promise<T> {
  const lease = resolveExecutionLease();
  if (!lease) return db.transaction(async store => (await write(store)).result);
  if (userId !== lease.userId) throw new ExecutionLeaseError("invalid_lease");
  try {
    return await withLeasedWrite(lease, true, async ({ db: store, append }) => {
      const { memory, result, written } = await write(store);
      if (memory.userId !== userId) throw new ExecutionLeaseError("invalid_lease");
      if (written !== false) await append({
        workshopId: lease.workshopId, runId: lease.runId,
        type: "brain_memory_written", title: "记忆写入完成", visibility: "debug",
        metadata: { actorId: lease.userId, memoryId: memory.id, scope: memory.scope,
          ownerType: memory.ownerType, ownerId: memory.ownerId, status: memory.status,
          execution: { workerId: lease.workerId, token: lease.token } },
      });
      return result;
    });
  } catch (error) { return rethrowMemoryWriteError(error); }
}

// Historical names are aliases of the same functions and constructor.
export {
  rethrowMemoryWriteError as rethrowBrainMemoryWriteError, MemoryIdentityConflict as BrainMemoryIdentityConflict,
  withMemoryRecordWrite as withBrainRecordWrite, withMemoryWrite as withBrainMemoryWrite,
  withMemoryTransaction as withBrainMemoryTransaction,
};
