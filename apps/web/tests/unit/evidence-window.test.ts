import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db/client", () => ({ db: { transaction: vi.fn() } }));
vi.mock("@/lib/ai/rag/langchain-service", () => ({ searchSimilarChunks: vi.fn() }));
vi.mock("@/lib/memory/sources/registration", () => ({ admitMemorySourceUse: vi.fn() }));
import { evidenceWindow } from "@/lib/ai/evidence-window";
import { getKnowledgeBaseDocumentContentForUser } from "@/lib/ai/knowledge-base-documents";
import { ragFixture, ragOwner, ragDocumentId } from "../fixtures/rag-source";

describe("versioned document evidence", () => {
  it("reconstructs bounded windows without omissions and rejects mixed versions", () => {
    const content = "记忆证据🙂".repeat(4000);
    let rebuilt = "", offset = 0;
    const hash = evidenceWindow(content).contentHash;
    for (;;) {
      const page = evidenceWindow(content, offset, hash);
      rebuilt += page.content;
      expect(page.content.length).toBeLessThanOrEqual(8000);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    expect(rebuilt).toBe(content);
    expect(evidenceWindow(content + "changed", 8000, hash)).toMatchObject({ status: "version_changed", content: "", nextOffset: null });
  });
  it("rejects invalid and out-of-range offsets", () => {
    for (const offset of [-1, 0.5, NaN, Infinity, 5]) expect(() => evidenceWindow("abc", offset)).toThrow();
    expect(evidenceWindow("", 0)).toMatchObject({ status: "read", content: "", nextOffset: null });
  });
  it("checks ownership before reading any document text", async () => {
    const readSource = vi.fn();
    const result = await getKnowledgeBaseDocumentContentForUser({ userId: ragOwner, workId: ragDocumentId, documentId: ragDocumentId, offset: 0, readSource });
    expect(result.ok).toBe(false);
    expect(readSource).not.toHaveBeenCalled();
  });
  it("returns provenance and explicit version change through the owner adapter", async () => {
    const input = { userId: ragOwner, documentId: ragDocumentId, offset: 0,
      readSource: async () => ragFixture("a".repeat(9000)).record };
    const first = await getKnowledgeBaseDocumentContentForUser(input);
    const page = JSON.parse(first.text);
    expect(page).toMatchObject({ documentId: ragDocumentId, documentName: "source.txt", nextOffset: 8000, truncated: true });
    const changed = await getKnowledgeBaseDocumentContentForUser({ ...input, offset: 8000, expectedHash: page.contentHash,
      readSource: async () => ragFixture("new version").record });
    expect(changed).toMatchObject({ ok: false, isError: true });
    expect(JSON.parse(changed.text).status).toBe("version_changed");
  });
});
