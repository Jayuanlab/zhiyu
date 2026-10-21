import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ admit: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: { transaction: vi.fn() } }));
vi.mock("@/lib/ai/rag/langchain-service", () => ({ searchSimilarChunks: vi.fn() }));
vi.mock("@/lib/memory/sources/registration", () => ({ admitMemorySourceUse: mocks.admit }));
import { searchKnowledgeBaseForUser, listKnowledgeBaseDocumentsForUser, getKnowledgeBaseDocumentContentForUser } from "@/lib/ai/knowledge-base-documents";
import { ragSourceRecord } from "@/lib/memory/evidence/rag-record";
import { knowledgeSearchTerms } from "@/lib/ai/knowledge-keyword-search";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";
import { ragChunkId, ragDocumentId, ragFixture, ragOwner } from "../fixtures/rag-source";
describe("knowledge source failure recovery", () => {
  beforeEach(() => vi.clearAllMocks());
  it("falls back within the same owner/document scope and revalidates before emitting chunks", async () => {
    const { record } = ragFixture(); const rows = [{ chunkId: ragChunkId, documentId: ragDocumentId, documentName: record.document.fileName, chunkIndex: 0, content: record.content }];
    const lexical = vi.fn(async () => ({ terms: ["memory"], results: rows }));
    const result = await searchKnowledgeBaseForUser({ userId: ragOwner, query: "memory", documentIds: [ragDocumentId],
      searchChunks: vi.fn(async () => { throw Error("embedding unavailable"); }), searchKeywords: lexical,
      resolveSources: async () => ({ records: [record], results: rows.map(row => ({ ...row, revision: record.revision, truncated: false })) }) });
    expect(lexical).toHaveBeenCalledWith({ userId: ragOwner, query: "memory", documentIds: [ragDocumentId], limit: 5 });
    expect(result).toMatchObject({ ok: true, data: { provider: "database_keyword_fallback", status: "degraded", count: 1 } });
    expect(result.text).not.toContain('"similarity"'); expect(mocks.admit).toHaveBeenCalledWith(expect.objectContaining({ source: "rag-document", records: [expect.objectContaining({ revision: record.revision })] }));
  });
  it("does not broaden or fall back after a permission/source authority failure", async () => {
    const lexical = vi.fn(); const result = await searchKnowledgeBaseForUser({ userId: ragOwner, query: "private", searchKeywords: lexical,
      searchChunks: vi.fn(async () => { throw new MemoryModuleError("memory_access_denied", 403, "denied"); }) });
    expect(result.ok).toBe(false); expect(lexical).not.toHaveBeenCalled(); expect(result.text).not.toContain("denied source body");
  });
  it("does not return cached text when authority re-read or required admission fails", async () => {
    const { record } = ragFixture("PRIVATE_BODY"), rows = [{ chunkId: ragChunkId, documentId: ragDocumentId, documentName: record.document.fileName, chunkIndex: 0, content: record.content, similarity: 0.9 }];
    mocks.admit.mockRejectedValueOnce(new Error("synthetic-required-receipt"));
    const result = await searchKnowledgeBaseForUser({ userId: ragOwner, query: "private", searchChunks: async () => rows,
      resolveSources: async () => ({ records: [record], results: rows.map(row => ({ ...row, revision: record.revision, truncated: false })) }) });
    expect(result.ok).toBe(false); expect(result.text).not.toContain("PRIVATE_BODY"); expect(result.text).toContain("NOT empty");
  });
  it("rejects Work before invoking semantic or keyword providers", async () => {
    const search = vi.fn(), lexical = vi.fn(); const result = await searchKnowledgeBaseForUser({ userId: ragOwner, workId: ragDocumentId, query: "q", searchChunks: search, searchKeywords: lexical });
    expect(result).toMatchObject({ ok: false, data: { code: "memory_source_scope_unverified" } }); expect(search).not.toHaveBeenCalled(); expect(lexical).not.toHaveBeenCalled();
  });
  it("registers metadata and body with distinct typed source identities in the normal list then read flow", async () => {
    const { record, document } = ragFixture(), metadata = ragSourceRecord(document, [], true);
    const listing = await listKnowledgeBaseDocumentsForUser({ userId: ragOwner, listSources: async () => ({ records: [metadata], hasMore: false }) });
    const body = await getKnowledgeBaseDocumentContentForUser({ userId: ragOwner, documentId: ragDocumentId, readSource: async () => record });
    expect(listing.ok).toBe(true); expect(body.ok).toBe(true);
    expect(mocks.admit.mock.calls.map(([input]) => input.source)).toEqual(["rag-document-metadata", "rag-document"]);
    expect(listing.text).not.toContain("https://legacy.invalid"); expect(body.text).toContain('"originalBinaryVerified":false');
  });
  it("keeps both failed sources distinct from a successful zero-hit search", async () => {
    const result = await searchKnowledgeBaseForUser({ userId: ragOwner, query: "q", searchChunks: vi.fn(async () => { throw Error("offline"); }), searchKeywords: vi.fn(async () => { throw Error("offline"); }) });
    expect(result).toMatchObject({ ok: false, isError: true }); expect(result.text).toContain("NOT empty");
  });
  it("uses bounded literal search terms", () => { expect(knowledgeSearchTerms("\u8bf7\u67e5\u8be2\u77e5\u8bc6\u5e93\u4e2d\u5173\u4e8e\u667a\u80fd\u4f53\u8bb0\u5fc6\u7684\u6587\u6863")).toContain("\u8bb0\u5fc6"); expect(knowledgeSearchTerms("a ".repeat(100))).toEqual([]); });
});
