import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { ragChunks, ragDocuments, user } from "@/lib/db/schema.pg";
import type { DrizzleDB } from "@/lib/db/types";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import { MemoryModuleError } from "../../kernel/errors";
import { MAX_RAG_SOURCE_BYTES, MAX_RAG_SOURCE_CHUNKS, assertRagSourceProjection, ragSourceRecord, type RagSourceProjection, type RagChunkRow } from "../../evidence/rag-record";
import { artifactRef, lockArtifact } from "./artifacts";
import type { RagOriginControl } from "../../evidence/rag-record";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function requireRagOwner(userId: string, workId?: string) {
  if (workId || resolveExecutionLease()) throw new MemoryModuleError("memory_source_scope_unverified", 403, "RAG sources have no registered Work binding; owner identity cannot authorize a Work read");
  if (!uuid.test(userId)) throw new MemoryModuleError("memory_access_denied", 403, "Owner identity unavailable");
  if (process.env.IS_TAURI === "true") throw new MemoryModuleError("memory_source_provider_unavailable", 503, "This native RAG provider has not adopted exact-source admission");
}
/** Locks parent and chunk metadata before fetching bounded bodies. No vector or URL is authoritative. */
export async function revalidateRagSourceInTransaction(store: DrizzleDB, input: { userId: string; documentId: string; revision?: string; metadataOnly?: boolean }) {
  requireRagOwner(input.userId); if (!uuid.test(input.documentId)) throw new MemoryModuleError("invalid_memory_request", 400, "Invalid RAG document reference");
  if (input.revision !== undefined && !/^rag(?:meta|doc)1:[a-f0-9]{64}$/.test(input.revision)) throw new MemoryModuleError("invalid_memory_request", 400, "A fixed RAG source version is required");
  const [principal] = await store.select({ id: user.id }).from(user).where(eq(user.id, input.userId)).for("share");
  if (!principal) throw new MemoryModuleError("memory_access_denied", 403, "Owner identity unavailable");
  const [document]: Array<typeof ragDocuments.$inferSelect> = await store.select().from(ragDocuments).where(and(eq(ragDocuments.id, input.documentId), eq(ragDocuments.userId, input.userId))).for("share");
  if (!document) throw new MemoryModuleError("memory_source_not_found", 404, "Source unavailable");
  let originControl: RagOriginControl = { kind: "independent_saved_text", originalBinaryVerified: false, correctionTarget: "rag_document" };
  if (typeof document.blobPath === "string" && /^artifact:/i.test(document.blobPath)) {
    const artifactId = document.blobPath.slice("artifact:".length).toLowerCase();
    if (!uuid.test(artifactId)) throw new MemoryModuleError("memory_source_origin_unavailable", 503, "The controlled original file reference is invalid; correct the RAG document source");
    const manifest = await lockArtifact(store, input.userId, artifactId, "share");
    if (!manifest || manifest.state !== "active") throw new MemoryModuleError("memory_source_origin_unavailable", 503, "The controlled original is no longer active for this owner; this RAG text was withheld");
    originControl = { kind: "managed_artifact", ref: artifactRef(manifest), objectBodyReread: false };
  }
  const metadataOnly = input.metadataOnly === true || input.revision?.startsWith("ragmeta1:") === true;
  let chunks: RagChunkRow[] = [];
  if (!metadataOnly) {
    const indexes: Array<{ id: string; bytes: string | number }> = await store.select({ id: ragChunks.id, bytes: sql<string>`octet_length(${ragChunks.content})` }).from(ragChunks)
      .where(and(eq(ragChunks.documentId, document.id), eq(ragChunks.userId, input.userId))).orderBy(asc(ragChunks.chunkIndex)).limit(MAX_RAG_SOURCE_CHUNKS + 1).for("share");
    const bytes = indexes.reduce((sum, chunk) => sum + Number(chunk.bytes), Math.max(0, indexes.length - 1) * 2);
    if (indexes.length !== document.totalChunks || !indexes.length || indexes.length > MAX_RAG_SOURCE_CHUNKS || !Number.isSafeInteger(bytes) || bytes > MAX_RAG_SOURCE_BYTES)
      throw new MemoryModuleError("memory_source_unavailable", 503, "The RAG source is incomplete or exceeds the bounded reader; reindex or import a smaller controlled source");
    chunks = await store.select({ id: ragChunks.id, documentId: ragChunks.documentId, userId: ragChunks.userId, chunkIndex: ragChunks.chunkIndex,
      content: ragChunks.content, createdAt: ragChunks.createdAt }).from(ragChunks).where(and(eq(ragChunks.userId, input.userId), eq(ragChunks.documentId, document.id), inArray(ragChunks.id, indexes.map(row => row.id))))
      .orderBy(asc(ragChunks.chunkIndex)).for("share");
  }
  const record = ragSourceRecord(document, chunks, metadataOnly, originControl);
  if (input.revision && input.revision !== record.revision) throw new MemoryModuleError("memory_source_version_changed", 503, "The exact RAG source changed; read a fresh owner version");
  return record;
}
export async function admitRagSourceProjectionInTransaction(store: DrizzleDB, input: { userId: string; documentId: string; revision: string; projection: RagSourceProjection | unknown }) {
  const record = await revalidateRagSourceInTransaction(store, input); assertRagSourceProjection(record, input.projection); return record;
}
