import { searchSimilarChunks, type SearchResult } from "@/lib/ai/rag/langchain-service";
import { searchKnowledgeKeywordsForOwner } from "./knowledge-keyword-search";
import { evidenceWindow } from "./evidence-window";
import { listOwnerRagSources, readOwnerRagSource, requireRagOwner, resolveOwnerRagSearch, type RagSourceProjection } from "@/lib/memory/evidence/rag";
import { admitMemorySourceUse } from "@/lib/memory/sources/registration";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";

export function safeKnowledgeDocumentLimit(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(100, Math.trunc(value))) : 50;
}
export function safeKnowledgeSearchLimit(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(20, Math.trunc(value))) : 5;
}
type SourceRecord = { id: string; revision: string; projection: RagSourceProjection };
function sourceUse(records: SourceRecord[], source: "rag-document" | "rag-document-metadata" = "rag-document") { return { source, records }; }
function failed(error: unknown) {
  const code = error instanceof MemoryModuleError ? error.code : "memory_source_unavailable";
  const data = { status: "unavailable", code, provider: "postgres", detail: "owner_rag_source", coverage: "unavailable",
    warning: "Knowledge source coverage is unavailable, NOT empty. Use a fresh owner reader or reindex a controlled source; no legacy URL or wider owner scope was used." };
  return { ok: false as const, isError: true as const, text: JSON.stringify(data), data };
}
export async function listKnowledgeBaseDocumentsForUser(input: { userId: string; workId?: string; limit?: number; listSources?: typeof listOwnerRagSources }) {
  try {
    requireRagOwner(input.userId, input.workId);
    const result = await (input.listSources ?? listOwnerRagSources)({ userId: input.userId, limit: safeKnowledgeDocumentLimit(input.limit) });
    const records = result.records.map(record => ({ id: record.id, revision: record.revision, projection: { kind: "metadata" as const, document: record.document } }));
    await admitMemorySourceUse({ userId: input.userId, workId: input.workId, ...sourceUse(records, "rag-document-metadata") });
    const documents = result.records.map(record => ({ ...record.document, revision: record.revision, originControl: record.originControl }));
    const data = { status: documents.length ? "observed" : "not_found_in_owner_scope", provider: "postgres", documents,
      count: documents.length, returnedCount: documents.length, hasMore: result.hasMore,
      coverage: "bounded_owner_metadata_only", countSemantics: "returned_documents_not_total_inventory",
      warning: "Document names are retrieval leads. A listed document is not loaded evidence; use its exact owner source reader." };
    return { ok: true as const, isError: false as const, text: JSON.stringify(data), ...data, sourceUse: sourceUse(records, "rag-document-metadata") };
  } catch (error) { return failed(error); }
}
/** The legacy name is retained, but every actual model read is an explicit bounded version window. */
export async function getKnowledgeBaseDocumentContentForUser(input: { userId: string; workId?: string; documentId: string; offset?: number; expectedHash?: string;
  readSource?: typeof readOwnerRagSource }) {
  try {
    requireRagOwner(input.userId, input.workId);
    const record = await (input.readSource ?? readOwnerRagSource)({ userId: input.userId, documentId: input.documentId });
    const page = evidenceWindow(record.content, input.offset ?? 0, input.expectedHash);
    const records: SourceRecord[] = page.status === "read" ? [{ id: record.id, revision: record.revision,
      projection: { kind: "document_window", start: page.offset, end: page.offset + page.content.length, content: page.content, contentHash: page.contentHash } }] : [];
    await admitMemorySourceUse({ userId: input.userId, workId: input.workId, ...sourceUse(records) });
    const data = { ...page, source: "rag-document", documentId: record.id, documentName: record.document.fileName, revision: record.revision,
      totalChunks: record.document.totalChunks, retrievedAt: new Date().toISOString(), scope: "authenticated_owner_document",
      representation: "parsed_text_not_original", originalBinaryVerified: false, originControl: record.originControl };
    return { ok: page.status === "read", isError: page.status !== "read", text: JSON.stringify(data), data, sourceUse: sourceUse(records) };
  } catch (error) { return failed(error); }
}
export async function searchKnowledgeBaseForUser(input: { userId: string; workId?: string; query: string; limit?: number; documentIds?: string[];
  embeddingsAuthToken?: string; searchChunks?: typeof searchSimilarChunks; searchKeywords?: typeof searchKnowledgeKeywordsForOwner; resolveSources?: typeof resolveOwnerRagSearch }) {
  try {
    requireRagOwner(input.userId, input.workId);
    const limit = safeKnowledgeSearchLimit(input.limit);
    let candidates: Array<Omit<SearchResult, "similarity"> & { similarity?: number }>, degraded = false, terms: string[] = [];
    try {
      candidates = await (input.searchChunks ?? searchSimilarChunks)(input.userId, input.query, { limit, threshold: 0.5, documentIds: input.documentIds }, input.embeddingsAuthToken);
    } catch (error) {
      if (error instanceof MemoryModuleError) throw error;
      const fallback = await (input.searchKeywords ?? searchKnowledgeKeywordsForOwner)({ userId: input.userId, query: input.query, documentIds: input.documentIds, limit });
      candidates = fallback.results; terms = fallback.terms; degraded = true;
    }
    const resolved = await (input.resolveSources ?? resolveOwnerRagSearch)({ userId: input.userId, results: candidates });
    const records = resolved.records.map(record => ({ id: record.id, revision: record.revision, projection: { kind: "chunks" as const,
      documentName: record.document.fileName, chunks: resolved.results.filter(row => row.documentId === record.id)
        .map(row => ({ id: row.chunkId, start: 0, end: row.content.length, content: row.content })) } }));
    await admitMemorySourceUse({ userId: input.userId, workId: input.workId, ...sourceUse(records) });
    const data = { provider: degraded ? "database_keyword_fallback" : "owner_revalidated_semantic_search", status: degraded ? "degraded" : "observed",
      reason: degraded ? "semantic_search_unavailable" : null, coverage: "bounded_owner_chunks_not_exhaustive", observedAt: new Date().toISOString(),
      terms, count: resolved.results.length, results: resolved.results, representation: "parsed_text_not_original", originalBinaryVerified: false,
      origins: resolved.records.map(record => ({ documentId: record.id, originControl: record.originControl })),
      warning: "Matched chunks were re-read from exact owner rows. Zero matches do not prove documents or facts do not exist. Parsed text is not original binary evidence." };
    return { ok: true as const, isError: false as const, text: JSON.stringify(data), data, sourceUse: sourceUse(records) };
  } catch (error) { return failed(error); }
}
