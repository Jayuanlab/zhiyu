import { db } from "@/lib/db/client";
import type { DrizzleDB } from "@/lib/db/types";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import { currentExecutionWriteContext } from "@/lib/work-runtime/execution-write-context";
import { withExecutionFence } from "@/lib/work-runtime/execution-fence";
import { ExecutionLeaseError } from "@/lib/work-runtime/execution-errors";
import { withWorkshopEventTransaction } from "@/lib/workshops/event-write";

type Append = Parameters<Parameters<typeof withWorkshopEventTransaction>[0]>[1];
type Context = { db: DrizzleDB; append?: Append };
/** Raw storage is fenced without invoking cognitive/business dependency checks. */
export async function withObservationTransaction<T>(userId: string, work: (context: Context) => Promise<T>): Promise<T> {
  const lease = resolveExecutionLease();
  if (!lease) return db.transaction((store: DrizzleDB) => work({ db: store }));
  if (lease.userId !== userId) throw new ExecutionLeaseError("invalid_lease");
  return withExecutionFence<Context, T>(lease, work, {
    currentContext: currentExecutionWriteContext,
    transaction: callback => withWorkshopEventTransaction((store, append) => callback({ db: store, append })),
  });
}
export async function appendObservationExecutionAudit(context: Context, userId: string, id: string) {
  const lease = resolveExecutionLease();
  if (!lease) return;
  if (lease.userId !== userId || !context.append) throw new ExecutionLeaseError("invalid_lease");
  await context.append({ workshopId: lease.workshopId, runId: lease.runId,
    type: "brain_record_written", title: "Observation recorded", visibility: "debug",
    metadata: { recordType: "observation", recordId: id, actorId: lease.userId,
      execution: { workerId: lease.workerId, token: lease.token }, implementation: "memory-t1.v1" } });
}
