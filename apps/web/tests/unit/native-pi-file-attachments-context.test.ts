import { describe, expect, it } from "vitest";
import {
  buildNativePiFileAttachmentsContext,
  isNativePiReadOnlyFileAttachment,
  isNativePiReadOnlyTextAttachment,
} from "@/lib/ai/native-pi-file-attachments-context";

describe("native Pi file attachments context", () => {
  it("allows text-like attachments as read-only context", () => {
    expect(
      isNativePiReadOnlyTextAttachment({
        name: "notes.md",
        mimeType: "text/markdown",
      }),
    ).toBe(true);
    expect(
      isNativePiReadOnlyTextAttachment({
        name: "data.json",
        mimeType: "application/json",
      }),
    ).toBe(true);
  });

  it("rejects binary attachments from Pi read-only text context", () => {
    expect(
      isNativePiReadOnlyTextAttachment({
        name: "report.pdf",
        mimeType: "application/pdf",
      }),
    ).toBe(false);
    expect(
      isNativePiReadOnlyFileAttachment({
        name: "report.pdf",
        mimeType: "application/pdf",
      }),
    ).toBe(true);
    expect(
      isNativePiReadOnlyFileAttachment({
        name: "proposal.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).toBe(true);
  });

  it("decodes data URLs and builds a no-file-tools system note", async () => {
    const context = await buildNativePiFileAttachmentsContext([
      {
        name: "notes.txt",
        mimeType: "text/plain",
        data: `data:text/plain;base64,${Buffer.from("hello attachment").toString("base64")}`,
      },
    ]);

    expect(context).toContain("read-only text context");
    expect(context).toContain("have not been saved to the workspace");
    expect(context).toContain("does not grant file read, write, edit");
    expect(context).toContain("hello attachment");
  });

  it("extracts PDFs as read-only text context without granting file tools", async () => {
    const context = await buildNativePiFileAttachmentsContext(
      [
        {
          name: "report.pdf",
          mimeType: "application/pdf",
          data: `data:application/pdf;base64,${Buffer.from("fake pdf").toString("base64")}`,
        },
      ],
      {
        parsePdfText: async (buffer) =>
          `parsed pdf text: ${buffer.toString("utf8")}`,
      },
    );

    expect(context).toContain('extractedAs="pdf_text"');
    expect(context).toContain("parsed pdf text: fake pdf");
    expect(context).toContain("does not grant file read, write, edit");
  });

  it("extracts Word documents as read-only text context", async () => {
    const context = await buildNativePiFileAttachmentsContext(
      [
        {
          name: "proposal.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          data: `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${Buffer.from("fake docx").toString("base64")}`,
        },
      ],
      {
        parseDocumentText: async (buffer, _attachment, contentType) =>
          `parsed ${contentType}: ${buffer.toString("utf8")}`,
      },
    );

    expect(context).toContain('extractedAs="word_text"');
    expect(context).toContain(
      "parsed application/vnd.openxmlformats-officedocument.wordprocessingml.document: fake docx",
    );
    expect(context).toContain("does not grant file read, write, edit");
  });

  it("surfaces PDF extraction failures as warnings", async () => {
    const context = await buildNativePiFileAttachmentsContext(
      [
        {
          name: "broken.pdf",
          mimeType: "application/pdf",
          data: "not-a-pdf",
        },
      ],
      {
        parsePdfText: async () => {
          throw new Error("bad pdf");
        },
      },
    );

    expect(context).toContain('warning="document_text_extraction_failed"');
    expect(context).toContain("bad pdf");
  });

  it("truncates long text attachments", async () => {
    const context = await buildNativePiFileAttachmentsContext(
      [
        {
          name: "large.log",
          mimeType: "text/plain",
          data: "x".repeat(100),
        },
      ],
      { perFileCharLimit: 40, totalCharLimit: 200 },
    );

    expect(context).toContain("[truncated at 40 characters]");
  });
});
