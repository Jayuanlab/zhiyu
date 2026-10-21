import { createHash } from "node:crypto";
import { db, withDatabaseTransaction } from "@/lib/db/client";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import { MemoryModuleError } from "../kernel/errors";
import { lockContextOwnerForShare } from "../adapters/postgres/context-logs";
import { readSourceRecordForShare } from "../adapters/postgres/source-records";
import { revalidateRagSourceInTransaction } from "../adapters/postgres/rag";
import { admitExactUse } from "../context/exact-use-admission";
import { registerExactUseForDispatch, exactUseRegistrationRequired } from "../context/dispatch";
import { currentExactUseReaderPolicy } from "../context/exact-use";
import { PLATFORM_SOURCE_DEFINITIONS, memorySourceSemantics, type MemorySourceKind } from "./catalog";
import { sourceValue } from "./records";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
/** Owner UI and model callers share physical authorization and durable read
 * admission. UI reads do not create a synthetic model dispatch scope. */
export async function readOwnerSource(input: { userId: string; source: MemorySourceKind; id: string; offset?: number; expectedHash?: string; expectedRevision?: string }) {
  if (resolveExecutionLease() || currentExactUseReaderPolicy()?.requester.type && currentExactUseReaderPolicy()?.requester.type !== "chat")
    throw new MemoryModuleError("memory_source_scope_unverified", 403, "This exact source entry is owner-only");
  if (!uuid.test(input.userId) || !uuid.test(input.id) || !Number.isSafeInteger(input.offset ?? 0) || (input.offset ?? 0) < 0)
    throw new MemoryModuleError("invalid_memory_request", 400, "Invalid source reference or window");
  return withDatabaseTransaction(async () => {
    const store = db;
    await lockContextOwnerForShare(store, input.userId);
    const policy = { requester: { type: "chat" as const, userId: input.userId }, accessMode: "owner_override" as const, purpose: "owner_source_evidence_read" };
    let content: string;
    let ragControl: Record<string, unknown> = {};
    let record: { id: string; revision?: string; projection: unknown };
    if (input.source === "rag-document" || input.source === "rag-document-metadata") {
      const actual = await revalidateRagSourceInTransaction(store, { userId: input.userId, documentId: input.id, metadataOnly: input.source === 'rag-document-metadata' });
      ragControl = { representation: 'stored_parsed_rag_text', originalBinaryVerified: false, originControl: actual.originControl };
      content = actual.metadataOnly ? JSON.stringify(actual.document) : actual.content;
      record = { id: input.id, revision: actual.revision, projection: actual.metadataOnly ? { kind: 'metadata', document: actual.document } : null };
    } else {
      const definition = PLATFORM_SOURCE_DEFINITIONS.find(item => item[0] === input.source);
      if (!definition) throw new MemoryModuleError("invalid_memory_request", 400, "Unsupported source kind");
      const actual = await readSourceRecordForShare(store, { requester: policy.requester, source: input.source, id: input.id });
      if (!actual) throw new MemoryModuleError("memory_source_not_found", 404, "Source unavailable");
      const published = input.source === 'workshopSources' && actual.row.type === 'file' ? actual.projectionRow : actual.row;
      const fields = Object.fromEntries(definition[3].split(" ").filter(key => Object.hasOwn(published, key)).map(key => [key, sourceValue(published[key])]));
      content = JSON.stringify(fields);
      record = { id: input.id, revision: actual.revision, projection: fields };
    }
    const contentHash = createHash("sha256").update(content).digest("hex");
    if (input.expectedHash && input.expectedHash !== contentHash) throw new MemoryModuleError("memory_source_version_changed", 409, "Source changed; restart the evidence window");
    const start = input.offset ?? 0;
    if (start > content.length || start > 0 && /[\uDC00-\uDFFF]/.test(content[start] ?? "") && /[\uD800-\uDBFF]/.test(content[start - 1]))
      throw new MemoryModuleError("invalid_memory_request", 400, "Invalid source window boundary");
    let end = Math.min(content.length, start + 8000);
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]) && /[\uDC00-\uDFFF]/.test(content[end])) end--;
    const body = content.slice(start, end);
    if (input.source === "rag-document") record.projection = { kind: "document_window", start, end, content: body, contentHash };
    const canonical = ["brainMemories", "brainObservations", "brainStateSnapshots"].includes(input.source);
    const proof = await admitExactUse({ ...policy, ...(canonical
      ? { publishedRecords: [{ source: input.source as "brainMemories" | "brainObservations" | "brainStateSnapshots", id: input.id, fields: record.projection as Record<string, unknown> }] }
      : { sources: [{ ...record, source: input.source }] }) });
    const revision = proof.refs.find(ref => ref.id === input.id)?.revision;
    if (input.expectedRevision && revision !== input.expectedRevision) throw new MemoryModuleError("memory_source_version_changed", 409, "Source authority or stored version changed; restart the evidence window");
    if (exactUseRegistrationRequired()) registerExactUseForDispatch(proof);
    return { schemaVersion: "memory-source-evidence.v1" as const, source: input.source, id: input.id,
      ...ragControl,
      revision, receiptId: proof.receiptId,
      semantics: memorySourceSemantics(input.source), status: "read" as const, content: body, contentHash,
      actualRange: { unit: "utf16" as const, start, end }, totalCharacters: content.length, nextOffset: end < content.length ? end : null,
      coverage: "published_fields_window" as const, complete: false as const,
      warning: "This is stored evidence observed at read time. It does not prove current executor activity or completeness of a collection." };
  }).catch(error => {
    if (error instanceof MemoryModuleError) throw error;
    throw new MemoryModuleError('memory_source_unavailable', 503, 'Stored source authorization, version or its audit could not be verified');
  });
}
