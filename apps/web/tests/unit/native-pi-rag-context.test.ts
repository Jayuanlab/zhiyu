import { describe, expect, it } from "vitest";
import { buildNativePiRagContext } from "@/lib/ai/native-pi-rag-context";

describe("native Pi RAG context", () => {
  it("builds ordered read-only document context from chunks", () => {
    const context = buildNativePiRagContext(
      [
        {
          id: "doc-1",
          name: "Strategy.md",
          chunks: [
            { chunkIndex: 2, content: "Second chunk" },
            { chunkIndex: 1, content: "First chunk" },
          ],
        },
      ],
      { perDocumentCharLimit: 1000 },
    );

    expect(context).toContain("read-only knowledge documents");
    expect(context).toContain("## Document 1: Strategy.md");
    expect(context.indexOf("First chunk")).toBeLessThan(
      context.indexOf("Second chunk"),
    );
  });

  it("truncates long documents and omits empty documents", () => {
    const context = buildNativePiRagContext(
      [
        {
          id: "empty",
          name: "Empty.md",
          chunks: [],
        },
        {
          id: "long",
          name: "Long.md",
          chunks: [{ chunkIndex: 1, content: "abcdef" }],
        },
      ],
      { perDocumentCharLimit: 3 },
    );

    expect(context).not.toContain("Empty.md");
    expect(context).toContain("abc");
    expect(context).toContain("[truncated at 3 characters]");
  });
});
