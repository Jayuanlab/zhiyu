import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { bindClient } from "../../../../packages/memory/src/host";
import {
  PROTOCOL,
  MemoryError,
  type Observation,
  type VersionRef as GeneralVersion,
} from "../../../../packages/memory/src/index";
import type { ObservationStore } from "../../../../packages/memory/src/ports";
import { db } from "@/lib/db/client";
import { user } from "@/lib/db/schema";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
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
import {
  observationVersion,
  stableJson,
} from "@/lib/memory/records/observations";
import type {
  ObservationRecord,
  ObservationAppendCommand,
  VersionRef,
  ObservationSubmitResult,
  MemoryResultMeta,
  ObservationReadResult,
  EvidenceRange,
  RecordRef,
} from "@/lib/memory/contracts";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";

const sourceId = "zhiyu.observations",
  extension = "zhiyu.legacy.v1";
function toCore(r: ObservationRecord): Observation {
  return {
    namespace: { tenantId: r.userId, projectId: "zhiyu" },
    id: r.id,
    source: {
      sourceId,
      externalId: r.sourceId,
      ...(r.sourceEventId ? { version: r.sourceEventId } : {}),
    },
    observedAt: r.observedAt,
    ingestedAt: r.createdAt,
    content: r.content,
    contentHash: r.contentHash,
    provenance: { kind: r.sourceType, trustLevel: r.trustLevel },
    extensions: { [extension]: r.metadata },
  };
}
function fromCore(r: Observation): ObservationRecord {
  return {
    id: r.id,
    userId: r.namespace.tenantId,
    sourceType: r.provenance.kind,
    sourceId: r.source.externalId,
    sourceEventId: r.source.version,
    observedAt: r.observedAt,
    createdAt: r.ingestedAt,
    content: r.content,
    contentHash: r.contentHash,
    trustLevel: r.provenance.trustLevel,
    metadata: r.extensions[extension] as Record<string, unknown>,
  };
}
const legacyRef = (r: GeneralVersion): VersionRef => ({
  record: { kind: "observation", id: r.record.id },
  revision: r.value,
});
const generalRef = (owner: string, r: VersionRef): GeneralVersion => ({
  record: { tenantId: owner, projectId: "zhiyu", ...r.record },
  scheme: "obsrv1",
  value: r.revision,
});
/** Trusted fixed-project mapping. It deliberately does not bootstrap generic tables in the daily database. */
export function createZhiyuObservationClient(
  owner: string,
  resultMeta: MemoryResultMeta,
) {
  const store: ObservationStore = {
    provider: "postgres",
    transaction: (work) =>
      db.transaction(async (tx) =>
        work({
          async authorize(i) {
            if (
              resolveExecutionLease() ||
              i.principalId !== owner ||
              i.namespace.tenantId !== owner ||
              i.namespace.projectId !== "zhiyu"
            )
              throw new MemoryModuleError(
                "memory_access_denied",
                403,
                "Owner identity is required",
              );
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
  const client = bindClient(
    {
      store,
      sources: [
        {
          id: sourceId,
          adapterVersion: "zhiyu-observation.g1",
          kind: "manual",
          trustLevel: "raw",
          validateExtensions: () => {},
        },
      ],
      format: {
        commandHash: (c) =>
          createHash("sha256")
            .update(
              stableJson({
                kind: "observation.append",
                commandId: c.commandId,
                sourceId: c.payload.source.externalId,
                observedAt: c.payload.observedAt,
                content: c.payload.content,
                metadata: c.payload.extensions?.[extension] ?? {},
              }),
            )
            .digest("hex"),
        version: (r) => generalRef(owner, observationVersion(fromCore(r))),
      },
    },
    {
      namespace: { tenantId: owner, projectId: "zhiyu" },
      principalId: owner,
      traceId: resultMeta.traceId,
    },
  );
  async function translate<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof MemoryError) {
        const codes: Record<string, string> = {
          idempotency_conflict: "memory_command_conflict",
          receipt_source_unavailable: "memory_receipt_source_unavailable",
          invalid_request: "invalid_memory_request",
        };
        throw new MemoryModuleError(
          codes[error.code] ?? error.code,
          error.status,
          error.message,
        );
      }
      throw error;
    }
  }
  return {
    async submit(
      command: ObservationAppendCommand,
    ): Promise<ObservationSubmitResult> {
      return translate(async () => {
        const r = await client.execute({
          protocolVersion: PROTOCOL,
          kind: command.kind,
          commandId: command.commandId,
          payload: {
            source: { sourceId, externalId: command.sourceId },
            observedAt: command.observedAt,
            content: command.content,
            extensions: { [extension]: command.metadata ?? {} },
          },
        });
        const ref = legacyRef(r.ref);
        return {
          status: "committed",
          replayed: r.replayed,
          observation: fromCore(r.observation),
          ref,
          receipt: { ...r.receipt, ref },
          meta: resultMeta,
        };
      });
    },
    async read(
      query:
        | { purpose: "current"; ref: RecordRef }
        | { purpose: "evidence"; ref: VersionRef; range: EvidenceRange },
    ): Promise<ObservationReadResult> {
      return translate(async () => {
        const q =
          query.purpose === "current"
            ? {
                purpose: "current",
                ref: { tenantId: owner, projectId: "zhiyu", ...query.ref },
              }
            : {
                purpose: "evidence",
                ref: generalRef(owner, query.ref),
                range: { ...query.range, unit: "unicode_code_points" },
              };
        const r = await client.read(q);
        if (r.status !== "ok") {
          if (r.status === "committed")
            throw Error("Unexpected command receipt");
          return { ...r, meta: resultMeta };
        }
        const ref = legacyRef(r.ref);
        return {
          status: "ok",
          content: r.content,
          ref,
          receipt: { ...r.receipt, ref },
          meta: resultMeta,
        };
      });
    },
  };
}
