import { and, eq } from "drizzle-orm";
import type { ObservationStore } from "../../../../../../packages/memory/src/ports";
import { db } from "@/lib/db/client";
import { user } from "@/lib/db/schema";
import {
  memoryOperationReceipts,
  memoryReadReceipts,
} from "@/lib/memory/adapters/postgres/receipt-schema";
import {
  insertObservationInTransaction,
  lockObservationCommand,
  readObservation,
} from "@/lib/memory/adapters/postgres/observations";
import { hashObservation } from "@/lib/memory/ingestion/observations";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";
import type { MemoryResultMeta } from "@/lib/memory/contracts";
import { toCore, fromCore, generalRef } from "../../observation-codec";
import { assertZhiyuObservationIdentity } from "../../identity";
export function createZhiyuObservationStore(
  owner: string,
  resultMeta: MemoryResultMeta,
): ObservationStore {
  return {
    provider: "postgres",
    transaction: (work) =>
      db.transaction(async (tx) =>
        work({
          async authorize(i) {
            assertZhiyuObservationIdentity(i, owner);
            const [principal] = await tx
              .select({ id: user.id })
              .from(user)
              .where(eq(user.id, owner))
              .for("share");
            if (!principal)
              throw new MemoryModuleError(
                "memory_access_denied",
                403,
                "Owner identity is no longer available",
              );
          },
          lockCommand: (_i, c) => lockObservationCommand(tx, owner, c),
          async command(_i, c) {
            const [r] = await tx
              .select()
              .from(memoryOperationReceipts)
              .where(
                and(
                  eq(memoryOperationReceipts.userId, owner),
                  eq(memoryOperationReceipts.commandId, c),
                ),
              )
              .limit(1);
            return r
              ? {
                  requestHash: r.requestHash,
                  receipt: {
                    id: r.id,
                    commandId: r.commandId,
                    ref: generalRef(owner, {
                      record: { kind: "observation", id: r.observationId },
                      revision: r.revision,
                    }),
                    createdAt: r.createdAt.toISOString(),
                  },
                }
              : null;
          },
          async observation(_n, id) {
            const r = await readObservation(tx, owner, id);
            return r ? toCore(r) : null;
          },
          async append(_i, r) {
            const original = fromCore(r),
              input = { ...original, createdAt: undefined };
            const { observation } = await insertObservationInTransaction(
              tx,
              { ...input, contentHash: hashObservation(input) },
              true,
            );
            return toCore(observation);
          },
          async saveCommand(_i, r) {
            const [saved] = await tx
              .insert(memoryOperationReceipts)
              .values({
                id: r.receipt.id,
                userId: owner,
                commandId: r.receipt.commandId,
                requestHash: r.requestHash,
                observationId: r.receipt.ref.record.id,
                revision: r.receipt.ref.value,
                createdAt: new Date(r.receipt.createdAt),
                traceId: resultMeta.traceId,
                contractVersion: resultMeta.contractVersion,
                implementationVersion: resultMeta.implementationVersion,
              })
              .returning();
            if (!saved)
              throw Error("Observation audit receipt was not persisted");
            return { ...r.receipt, createdAt: saved.createdAt.toISOString() };
          },
          async saveRead(_i, r) {
            const [saved] = await tx
              .insert(memoryReadReceipts)
              .values({
                id: r.id,
                userId: owner,
                purpose: r.purpose,
                observationId: r.ref.record.id,
                revision: r.ref.value,
                actualRange: r.actualRange,
                totalLength: r.totalLength,
                createdAt: new Date(r.createdAt),
                traceId: resultMeta.traceId,
                contractVersion: resultMeta.contractVersion,
                implementationVersion: resultMeta.implementationVersion,
              })
              .returning();
            if (!saved)
              throw Error("Observation read receipt was not persisted");
            return { ...r, createdAt: saved.createdAt.toISOString() };
          },
        }),
      ),
  };
}
