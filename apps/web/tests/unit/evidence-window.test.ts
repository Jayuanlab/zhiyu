import { describe, expect, it, vi } from "vitest";
import { evidenceWindow } from "@/lib/ai/evidence-window";
import { getKnowledgeBaseDocumentContentForUser } from "@/lib/ai/knowledge-base-documents";

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
    const getFullContent = vi.fn();
    const result = await getKnowledgeBaseDocumentContentForUser({ userId: "owner", documentId: "other", offset: 0,
      getDocumentById: async () => ({ id: "other", fileName: "private", userId: "other" }), getFullContent });
    expect(result.ok).toBe(false);
    expect(getFullContent).not.toHaveBeenCalled();
  });
  it("returns provenance and explicit version change through the owner adapter", async () => {
    const input = { userId: "owner", documentId: "d", offset: 0,
      getDocumentById: async () => ({ id: "d", fileName: "source", userId: "owner" }),
      getFullContent: async () => ({ documentId: "d", content: "a".repeat(9000), totalChunks: 2 }) };
    const first = await getKnowledgeBaseDocumentContentForUser(input);
    const page = JSON.parse(first.text);
    expect(page).toMatchObject({ documentId: "d", documentName: "source", nextOffset: 8000, truncated: true });
    const changed = await getKnowledgeBaseDocumentContentForUser({ ...input, offset: 8000, expectedHash: page.contentHash,
      getFullContent: async () => ({ documentId: "d", content: "new version", totalChunks: 1 }) });
    expect(changed).toMatchObject({ ok: false, isError: true });
    expect(JSON.parse(changed.text).status).toBe("version_changed");
  });
});
