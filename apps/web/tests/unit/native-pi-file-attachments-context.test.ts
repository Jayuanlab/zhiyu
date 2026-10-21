import { describe, expect, it, vi } from "vitest";
import { buildNativePiFileAttachmentsContext, isNativePiReadOnlyFileAttachment, isNativePiReadOnlyTextAttachment } from "@/lib/ai/native-pi-file-attachments-context";
describe("native Pi file source registration", () => {
  it("keeps media classification separate from source read authority", () => {
    expect(isNativePiReadOnlyTextAttachment({ name: "notes.md", mimeType: "text/markdown" })).toBe(true);
    expect(isNativePiReadOnlyTextAttachment({ name: "data.json", mimeType: "application/json" })).toBe(true);
    expect(isNativePiReadOnlyTextAttachment({ name: "report.pdf", mimeType: "application/pdf" })).toBe(false);
    expect(isNativePiReadOnlyFileAttachment({ name: "report.pdf", mimeType: "application/pdf" })).toBe(true);
    expect(isNativePiReadOnlyFileAttachment({ name: "proposal.docx" })).toBe(true);
  });
  it.each(["PRIVATE_INLINE_BODY", "data:text/plain;base64,UFJJVkFURV9CT0RZ", "https://legacy.invalid/private.txt"])("does not decode or return an unregistered payload: %s", async data => {
    const parseDocumentText = vi.fn(), parsePdfText = vi.fn();
    const context = await buildNativePiFileAttachmentsContext([{ name: "private.pdf", mimeType: "application/pdf", data }], { parseDocumentText, parsePdfText });
    expect(context).toContain("memory_source_unregistered"); expect(context).not.toContain(data); expect(context).not.toContain("PRIVATE_BODY");
    expect(parseDocumentText).not.toHaveBeenCalled(); expect(parsePdfText).not.toHaveBeenCalled();
  });
  it("returns no source note for an empty attachment set", async () => { expect(await buildNativePiFileAttachmentsContext([])).toBe(""); });
});
