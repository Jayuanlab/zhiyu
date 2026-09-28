import { describe, expect, it, vi } from "vitest";
import { searchKnowledgeBaseForUser } from "@/lib/ai/knowledge-base-documents";
import { knowledgeSearchTerms } from "@/lib/ai/knowledge-keyword-search";
describe("knowledge source failure recovery", () => {
  it("falls back within the same owner and document scope, never fabricating vector scores", async () => {
    const lexical = vi.fn(async () => ({ terms: ["memory"], results: [{ chunkId: "c", documentId: "d", documentName: "doc", chunkIndex: 0, content: "literal evidence" }] }));
    const result = await searchKnowledgeBaseForUser({ userId: "owner", query: "memory", documentIds: ["d"],
      searchChunks: vi.fn(async () => { throw Error("embedding unavailable"); }), searchKeywords: lexical });
    expect(lexical).toHaveBeenCalledWith({ userId: "owner", query: "memory", documentIds: ["d"], limit: 5 });
    expect(result).toMatchObject({ ok: true, data: { provider: "database_keyword_fallback", status: "degraded", count: 1 } });
    expect(result.text).not.toContain('"similarity"');
  });
  it("keeps both failed sources distinct from a successful zero-hit search", async () => {
    const result = await searchKnowledgeBaseForUser({ userId: "owner", query: "q", searchChunks: vi.fn(async () => { throw Error("offline"); }), searchKeywords: vi.fn(async () => { throw Error("offline"); }) });
    expect(result).toMatchObject({ ok: false, isError: true });
    expect(result.text).toContain("NOT empty");
  });
  it("uses bounded literal search terms", () => {
    expect(knowledgeSearchTerms("请查询知识库中关于智能体记忆的文档")).toContain("记忆");
    expect(knowledgeSearchTerms("a ".repeat(100))).toEqual([]);
  });
});
