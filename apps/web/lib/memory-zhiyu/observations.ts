import { createHash } from "node:crypto";
import { bindClient } from "../../../../packages/memory/src/host";
import { PROTOCOL, MemoryError } from "../../../../packages/memory/src/index";
import {
  observationVersion,
  stableJson,
} from "@/lib/memory/records/observations";
import type {
  ObservationAppendCommand,
  VersionRef,
  ObservationSubmitResult,
  MemoryResultMeta,
  ObservationReadResult,
  EvidenceRange,
  RecordRef,
} from "@/lib/memory/contracts";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";
import {
  sourceId,
  extension,
  toCore,
  fromCore,
  generalRef,
  legacyRef,
} from "./observation-codec";
import { createZhiyuObservationStore } from "./adapters/postgres/observations";
import { zhiyuObservationSources } from "./sources/observations";
/** Trusted fixed-project mapping. It deliberately does not bootstrap generic tables in the daily database. */
export function createZhiyuObservationClient(
  owner: string,
  resultMeta: MemoryResultMeta,
) {
  const store = createZhiyuObservationStore(owner, resultMeta);
  const client = bindClient(
    {
      store,
      sources: zhiyuObservationSources,
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
