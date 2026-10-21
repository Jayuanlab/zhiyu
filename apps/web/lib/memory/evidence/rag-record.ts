import { createHash } from "node:crypto";
import { stableJson } from "../records/observations";
import { MemoryModuleError } from "../kernel/errors";

export const MAX_RAG_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_RAG_SOURCE_CHUNKS = 2048;
export type RagDocumentRow = { id: string; userId: string; fileName: string; contentType: string; sizeBytes: number;
  totalChunks: number; blobPath: string | null; uploadedAt: Date; updatedAt: Date };
export type RagChunkRow = { id: string; documentId: string; userId: string; chunkIndex: number; content: string; createdAt: Date };
export type RagDocumentView = { id: string; fileName: string; contentType: string; sizeBytes: number; totalChunks: number; uploadedAt: string; updatedAt: string };
export type RagOriginControl = { kind: "managed_artifact"; ref: { record: { kind: "artifact"; id: string }; revision: string }; objectBodyReread: false }
  | { kind: "independent_saved_text"; originalBinaryVerified: false; correctionTarget: "rag_document" };
export type RagSourceRecord = { id: string; revision: string; document: RagDocumentView; chunks: RagChunkRow[]; content: string; metadataOnly: boolean; originControl: RagOriginControl;
  representation: "parsed_text_not_original"; originalBinaryVerified: false };
export type RagSourceProjection =
  | { kind: "metadata"; document: RagDocumentView }
  | { kind: "document_window"; start: number; end: number; content: string; contentHash: string }
  | { kind: "chunks"; documentName: string; chunks: Array<{ id: string; start: number; end: number; content: string }> };
const digest = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
const unavailable = () => new MemoryModuleError("memory_source_unavailable", 503, "The stored RAG source is incomplete, changed or outside the bounded reader; read a fresh owner source or reindex it");
export function ragDocumentView(row: RagDocumentRow): RagDocumentView {
  return { id: row.id, fileName: row.fileName, contentType: row.contentType, sizeBytes: row.sizeBytes, totalChunks: row.totalChunks,
    uploadedAt: row.uploadedAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
export function ragSourceRecord(row: RagDocumentRow, chunks: RagChunkRow[], metadataOnly = false,
  originControl: RagOriginControl = { kind: "independent_saved_text", originalBinaryVerified: false, correctionTarget: "rag_document" }): RagSourceRecord {
  const document = ragDocumentView(row);
  if (!Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 0 || !Number.isSafeInteger(row.totalChunks) || row.totalChunks < 0) throw unavailable();
  if (/^artifact:/i.test(row.blobPath ?? "") && (originControl.kind !== "managed_artifact" || row.blobPath?.toLowerCase() !== `artifact:${originControl.ref.record.id}`)) throw unavailable();
  if (!metadataOnly && (!Number.isSafeInteger(row.totalChunks) || row.totalChunks < 1 || row.totalChunks > MAX_RAG_SOURCE_CHUNKS
    || chunks.length !== row.totalChunks || chunks.some((chunk, index) => chunk.documentId !== row.id || chunk.userId !== row.userId || chunk.chunkIndex !== index)
    || chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.content, "utf8"), Math.max(0, chunks.length - 1) * 2) > MAX_RAG_SOURCE_BYTES)) throw unavailable();
  const revision = `${metadataOnly ? "ragmeta1" : "ragdoc1"}:${digest({ document: { ...document, userId: row.userId, blobPath: row.blobPath }, originControl,
    chunks: metadataOnly ? [] : chunks.map(chunk => ({ ...chunk, createdAt: chunk.createdAt.toISOString() })) })}`;
  return { id: row.id, revision, document, chunks: metadataOnly ? [] : chunks, content: metadataOnly ? "" : chunks.map(chunk => chunk.content).join("\n\n"), metadataOnly, originControl,
    representation: "parsed_text_not_original", originalBinaryVerified: false };
}
/** Every delivered character is matched to an exact explicit range, never an arbitrary prefix. */
export function assertRagSourceProjection(record: RagSourceRecord, value: unknown): asserts value is RagSourceProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const projection = value as Record<string, unknown>;
  const allowed = projection.kind === "metadata" ? ["kind", "document"] : projection.kind === "document_window"
    ? ["kind", "start", "end", "content", "contentHash"] : ["kind", "documentName", "chunks"];
  if (Object.keys(projection).some(key => !allowed.includes(key))) throw unavailable();
  const windowMatches = (content: string, item: Record<string, unknown>) => typeof item.content === "string" && Number.isSafeInteger(item.start)
    && Number.isSafeInteger(item.end) && Number(item.start) >= 0 && Number(item.end) >= Number(item.start)
    && Number(item.end) <= content.length && content.slice(Number(item.start), Number(item.end)) === item.content;
  if (projection.kind === "metadata") { if (stableJson(projection.document) !== stableJson(record.document)) throw unavailable(); return; }
  if (record.metadataOnly) throw unavailable();
  if (projection.kind === "document_window") {
    if (!windowMatches(record.content, projection) || projection.contentHash !== createHash("sha256").update(record.content).digest("hex")) throw unavailable();
    return;
  }
  if (projection.kind !== "chunks" || projection.documentName !== record.document.fileName || !Array.isArray(projection.chunks)
    || !projection.chunks.length || projection.chunks.length > 20) throw unavailable();
  const seen = new Set<string>();
  for (const item of projection.chunks) {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string" || seen.has(item.id)
      || Object.keys(item).some(key => !["id", "start", "end", "content"].includes(key))) throw unavailable();
    const current = record.chunks.find(chunk => chunk.id === item.id); if (!current || !windowMatches(current.content, item)) throw unavailable();
    seen.add(item.id);
  }
}
