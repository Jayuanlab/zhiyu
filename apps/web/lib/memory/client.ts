import { createZhiyuObservationClient } from "@/lib/memory-zhiyu/observations";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import { memoryOperationReceipts, memoryReadReceipts } from "./adapters/postgres/receipt-schema";
import { isObservationTimestamp } from "./ingestion/observation-time";
import { ownerId } from "./kernel/access";
import { createOwnerContext } from "./kernel/identity";
import { memoryInvalid, MemoryModuleError } from "./kernel/errors";
import type { EvidenceRange, MemoryResultMeta, ObservationAppendCommand, ObservationReadResult,
  ObservationSubmitResult, OperationReceipt, ReadReceipt, RecordRef, VersionRef, CurrentStateReadResult, RevisionStateReadResult } from "./contracts";
import type { RevisionCommandResult } from "./revision/owner-commands";
import type { MemoryQueryReadResult } from "./query-contracts";
import type { ArtifactCommandResult, ArtifactReadResult } from "./artifact-contracts";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) memoryInvalid("An object is required");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) memoryInvalid("Unexpected memory request field");
}
function text(value: unknown, max: number, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) memoryInvalid(`Invalid ${name}`);
  return value;
}
function ref(value: unknown): RecordRef {
  const item = object(value); keys(item, ["kind", "id"]);
  if (item.kind !== "observation" || typeof item.id !== "string" || !uuid.test(item.id)) memoryInvalid("Invalid observation reference");
  return { kind: "observation", id: item.id.toLowerCase() };
}
function version(value: unknown): VersionRef {
  const item = object(value); keys(item, ["record", "revision"]);
  if (typeof item.revision !== "string" || !/^obsrv1:[a-f0-9]{64}$/.test(item.revision)) memoryInvalid("A fixed observation version is required");
  return { record: ref(item.record), revision: item.revision };
}
function range(value: unknown): EvidenceRange {
  const item = object(value); keys(item, ["start", "end"]);
  if (!Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) || (item.start as number) < 0
    || (item.end as number) < (item.start as number) || (item.end as number) - (item.start as number) > 8192) memoryInvalid("Invalid evidence window (maximum 8192 code points)");
  return { start: item.start as number, end: item.end as number };
}
function parseCommand(value: unknown): ObservationAppendCommand {
  const item = object(value); keys(item, ["kind", "commandId", "sourceId", "observedAt", "content", "metadata"]);
  if (item.kind !== "observation.append") throw new MemoryModuleError("unsupported_memory_command", 422, "This command is not available in the observation module");
  const commandId = text(item.commandId, 200, "commandId").trim(), sourceId = text(item.sourceId, 2048, "sourceId").trim();
  const observedAt = text(item.observedAt, 64, "observedAt");
  if (!isObservationTimestamp(observedAt)) memoryInvalid("observedAt must be a real calendar date with an explicit ISO timezone");
  const content = text(item.content, 262144, "content");
  if (Buffer.byteLength(content, "utf8") > 262144) memoryInvalid("Observation content exceeds the byte budget");
  let metadata: Record<string, unknown> = {};
  if (item.metadata !== undefined) {
    const input = object(item.metadata);
    try {
      const encoded = JSON.stringify(input);
      if (encoded.length > 16384) memoryInvalid("Observation metadata exceeds the budget");
      metadata = JSON.parse(encoded);
    } catch (error) { if (error instanceof MemoryModuleError) throw error; memoryInvalid("Metadata must be JSON serializable"); }
  }
  return { kind: "observation.append", commandId, sourceId, observedAt: new Date(observedAt).toISOString(), content, metadata };
}
function storageError(error: unknown): never {
  let cause = error;
  for (let depth = 0; depth < 8 && cause && typeof cause === "object"; depth++) {
    if (["42P01", "42703"].includes((cause as { code?: string }).code ?? "")) throw new MemoryModuleError("memory_storage_not_ready", 503, "Memory storage requires the application migration");
    const next = (cause as { cause?: unknown }).cause;
    if (next === cause) break; cause = next;
  }
  throw error;
}

/** Only server code may construct this from an authenticated owner session.
 * Work/Loop execution cannot upgrade its user ID into an owner capability. */
export function createOwnerMemoryClient(userId: string) {
  const context = createOwnerContext(userId);
  function authorize() {
    if (resolveExecutionLease()) throw new MemoryModuleError("memory_owner_context_required", 403, "Owner operations cannot run with a Work capability");
    if (process.env.TAURI_MODE === "true" || process.env.IS_TAURI === "true") throw new MemoryModuleError("unsupported_memory_storage", 422, "This receipt contract currently requires PostgreSQL");
    return ownerId(context);
  }
  function meta(detail: string): MemoryResultMeta {
    return { traceId: randomUUID(), contractVersion: "memory-observation.v1", implementationVersion: "memory-t1.v1",
      provider: "postgres", detail, warnings: [] };
  }
  return {
    async submit(value: unknown): Promise<ObservationSubmitResult | RevisionCommandResult | ArtifactCommandResult> {
      const owner = authorize();
      if (value && typeof value === "object" && !Array.isArray(value) && "kind" in value && typeof value.kind === "string" && value.kind.startsWith("artifact.")) {
        const artifacts = await import("./artifacts/service");
        try {
          if (value.kind === "artifact.begin") return await artifacts.beginArtifact(owner, value);
          if (value.kind === "artifact.seal") return await artifacts.sealArtifact(owner, value);
          if (value.kind === "artifact.activate") return await artifacts.activateArtifact(owner, value);
          if (value.kind === "artifact.cleanup") return await artifacts.cleanupArtifact(owner, value);
          memoryInvalid("Unsupported artifact command");
        } catch (error) { return storageError(error); }
      }
      if (value && typeof value === "object" && !Array.isArray(value) && ["candidate.submit", "memory.review", "memory.propose", "memory.decide", "memory.revise", "dependencies.bind"].includes(String((value as Record<string, unknown>).kind))) {
        try { return await (await import("./revision/owner-commands")).submitOwnerRevisionCommand(owner, value); }
        catch (error) { return storageError(error); }
      }
      const command = parseCommand(value), resultMeta = meta("owner_observation_append");
      try { return await createZhiyuObservationClient(owner, resultMeta).submit(command); } catch (error) { return storageError(error); }
    },
    async read(value: unknown): Promise<ObservationReadResult | CurrentStateReadResult | RevisionStateReadResult | MemoryQueryReadResult | ArtifactReadResult> {
      const owner = authorize(), query = object(value);
      const locator = query.ref && typeof query.ref === "object" && !Array.isArray(query.ref) ? query.ref as Record<string, unknown> : undefined;
      const fixedRecord = locator?.record && typeof locator.record === "object" && !Array.isArray(locator.record) ? locator.record as Record<string, unknown> : undefined;
      if (locator?.kind === "artifact" || fixedRecord?.kind === "artifact") {
        try { return await (await import("./artifacts/owner-query")).readOwnerArtifact(owner, query); }
        catch (error) { return storageError(error); }
      }
      if (query.purpose === "discover" || query.purpose === "recall") {
        try { return await (await import("./retrieval/owner-query")).readOwnerMemoryQuery(owner, query); }
        catch (error) { return storageError(error); }
      }
      keys(query, ["purpose", "ref", "range"]);
      if (query.purpose !== "current" && query.purpose !== "evidence") throw new MemoryModuleError("unsupported_memory_purpose", 422, "Supported purposes are current, evidence, discover and recall");
      if (query.purpose === "current" && query.range !== undefined) memoryInvalid("Current reads do not accept an evidence window");
      if (query.purpose === "current" && ["interaction_task", "scenario_state"].includes(String(object(query.ref).kind))) {
        try { return await (await import("./records/current-state")).readCurrentState(owner, query.ref); }
        catch (error) { return storageError(error); }
      }
      if (query.purpose === "current" && ["memory", "memory_dependencies"].includes(String(object(query.ref).kind))) {
        try { return await (await import("./revision/owner-read")).readOwnerRevisionState(owner, query.ref); }
        catch (error) { return storageError(error); }
      }
      const fixedRef = query.purpose === "evidence" ? version(query.ref) : undefined;
      const target = fixedRef?.record ?? ref(query.ref), window = query.purpose === "evidence" ? range(query.range) : undefined;
      const resultMeta = meta("exact_observation_read");
      try { return await createZhiyuObservationClient(owner, resultMeta).read(query.purpose === "evidence"
        ? { purpose: "evidence", ref: fixedRef!, range: window! } : { purpose: "current", ref: target }); } catch (error) { return storageError(error); }
    },
    async explain(value: unknown) {
      const owner = authorize(), query = object(value); keys(query, ["receiptId"]);
      if (typeof query.receiptId !== "string" || !uuid.test(query.receiptId)) memoryInvalid("Invalid receipt ID");
      const receiptId = query.receiptId;
      try {
        const [operation] = await db.select().from(memoryOperationReceipts).where(and(eq(memoryOperationReceipts.userId, owner), eq(memoryOperationReceipts.id, query.receiptId))).limit(1);
        if (operation) return { status: "ok" as const, type: "operation" as const, historical: true,
          implementation: { traceId: operation.traceId, contractVersion: operation.contractVersion, implementationVersion: operation.implementationVersion },
          receipt: { id: operation.id, commandId: operation.commandId, ref: { record: { kind: "observation", id: operation.observationId }, revision: operation.revision }, createdAt: operation.createdAt.toISOString() } };
        const [read] = await db.select().from(memoryReadReceipts).where(and(eq(memoryReadReceipts.userId, owner), eq(memoryReadReceipts.id, query.receiptId))).limit(1);
        return read ? { status: "ok" as const, type: "read" as const, historical: true,
          implementation: { traceId: read.traceId, contractVersion: read.contractVersion, implementationVersion: read.implementationVersion },
          receipt: { id: read.id, purpose: read.purpose,
          ref: { record: { kind: "observation", id: read.observationId }, revision: read.revision }, actualRange: read.actualRange,
          totalLength: Number(read.totalLength), createdAt: read.createdAt.toISOString() } } : await (async () => {
            const state = await (await import("./records/current-state")).explainCurrentStateRead(owner, receiptId);
            if (state.status !== "not_found") return state;
            const revision = await (await import("./revision/owner-commands")).explainRevisionCommand(owner, receiptId);
            if (revision.status !== "not_found") return revision;
            const queryReceipt = await (await import("./adapters/postgres/query-receipts")).explainQueryRead(owner, receiptId);
            if (queryReceipt.status !== "not_found") return queryReceipt;
            const artifact = await (await import("./artifacts/service")).explainArtifactReceipt(owner, receiptId);
            return artifact.status !== "not_found" ? artifact : (await import("./sources/inspection")).explainMemorySourceReceipt(owner, receiptId);
          })();
      } catch (error) { return storageError(error); }
    },
  };
}
