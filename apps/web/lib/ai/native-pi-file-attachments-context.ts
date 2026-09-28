export interface NativePiFileAttachmentContextItem {
  name: string;
  mimeType?: string | null;
  data?: string | null;
}

export const NATIVE_PI_TEXT_ATTACHMENT_TOTAL_CHAR_LIMIT = 16000;
export const NATIVE_PI_TEXT_ATTACHMENT_PER_FILE_CHAR_LIMIT = 6000;

const TEXT_ATTACHMENT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/csv",
  "text/csv",
  "text/markdown",
]);

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".csv",
  ".tsv",
  ".yaml",
  ".yml",
  ".xml",
  ".toml",
  ".log",
]);

const PARSEABLE_DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const PARSEABLE_DOCUMENT_EXTENSIONS = new Set([".pdf", ".doc", ".docx"]);

function contentTypeForParseableDocument(
  attachment: Pick<NativePiFileAttachmentContextItem, "name" | "mimeType">,
): string | null {
  const mimeType = getAttachmentMimeType(attachment);
  if (PARSEABLE_DOCUMENT_MIME_TYPES.has(mimeType)) return mimeType;
  const extension = getFileExtension(attachment.name);
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".doc") return "application/msword";
  if (extension === ".docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return null;
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 42)).trimEnd()}\n[truncated at ${limit} characters]`;
}

function getFileExtension(name: string): string {
  const index = name.lastIndexOf(".");
  if (index < 0) return "";
  return name.slice(index).toLowerCase();
}

function getAttachmentMimeType(
  attachment: Pick<NativePiFileAttachmentContextItem, "mimeType">,
): string {
  return (attachment.mimeType ?? "").toLowerCase().split(";")[0].trim();
}

function escapeAttribute(value: string): string {
  return value.replace(/[<>"&]/g, (char) => {
    switch (char) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      case "&":
        return "&amp;";
      default:
        return char;
    }
  });
}

export function isNativePiReadOnlyTextAttachment(
  attachment: Pick<NativePiFileAttachmentContextItem, "name" | "mimeType">,
): boolean {
  const mimeType = getAttachmentMimeType(attachment);
  if (mimeType.startsWith("text/")) return true;
  if (TEXT_ATTACHMENT_MIME_TYPES.has(mimeType)) return true;
  return TEXT_ATTACHMENT_EXTENSIONS.has(getFileExtension(attachment.name));
}

export function isNativePiReadOnlyFileAttachment(
  attachment: Pick<NativePiFileAttachmentContextItem, "name" | "mimeType">,
): boolean {
  if (isNativePiReadOnlyTextAttachment(attachment)) return true;
  const mimeType = getAttachmentMimeType(attachment);
  return (
    PARSEABLE_DOCUMENT_MIME_TYPES.has(mimeType) ||
    PARSEABLE_DOCUMENT_EXTENSIONS.has(getFileExtension(attachment.name))
  );
}

function decodeAttachmentData(data: string): string {
  const dataUrlMatch = data.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!dataUrlMatch) return data;

  const isBase64 = Boolean(dataUrlMatch[2]);
  const payload = dataUrlMatch[3] ?? "";
  if (isBase64) {
    return Buffer.from(payload, "base64").toString("utf8");
  }
  return decodeURIComponent(payload);
}

function decodeAttachmentBuffer(data: string): Buffer {
  const dataUrlMatch = data.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!dataUrlMatch) return Buffer.from(data, "base64");

  const isBase64 = Boolean(dataUrlMatch[2]);
  const payload = dataUrlMatch[3] ?? "";
  return isBase64
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");
}

async function defaultParseDocumentText(
  buffer: Buffer,
  attachment: NativePiFileAttachmentContextItem,
  contentType: string,
): Promise<string> {
  const { parseFile } = await import("@/lib/ai/rag/parsers");
  const parsed = await parseFile(buffer, contentType);
  return parsed.text;
}

function extractedAsLabel(contentType: string): string {
  if (contentType === "application/pdf") return "pdf_text";
  if (
    contentType === "application/msword" ||
    contentType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "word_text";
  }
  return "document_text";
}

export async function buildNativePiFileAttachmentsContext(
  attachments: NativePiFileAttachmentContextItem[],
  options: {
    totalCharLimit?: number;
    perFileCharLimit?: number;
    parseDocumentText?: (
      buffer: Buffer,
      attachment: NativePiFileAttachmentContextItem,
      contentType: string,
    ) => Promise<string>;
    parsePdfText?: (buffer: Buffer, attachment: NativePiFileAttachmentContextItem) => Promise<string>;
  } = {},
): Promise<string> {
  const totalCharLimit =
    options.totalCharLimit ?? NATIVE_PI_TEXT_ATTACHMENT_TOTAL_CHAR_LIMIT;
  const perFileCharLimit =
    options.perFileCharLimit ?? NATIVE_PI_TEXT_ATTACHMENT_PER_FILE_CHAR_LIMIT;
  const parseDocumentText =
    options.parseDocumentText ??
    (options.parsePdfText
      ? (buffer: Buffer, attachment: NativePiFileAttachmentContextItem, contentType: string) =>
          contentType === "application/pdf"
            ? options.parsePdfText!(buffer, attachment)
            : defaultParseDocumentText(buffer, attachment, contentType)
      : defaultParseDocumentText);

  const fileContexts = (
    await Promise.all(
      attachments.filter(isNativePiReadOnlyFileAttachment).map(async (attachment) => {
        const parseableContentType = contentTypeForParseableDocument(attachment);
        if (parseableContentType) {
          try {
            const buffer = decodeAttachmentBuffer(attachment.data ?? "");
            const parsedText = (
              await parseDocumentText(buffer, attachment, parseableContentType)
            ).trim();
            if (!parsedText) {
              return `<file name="${escapeAttribute(attachment.name)}" mimeType="${escapeAttribute(attachment.mimeType ?? parseableContentType)}" warning="no_text_extracted"></file>`;
            }
            return [
              `<file name="${escapeAttribute(attachment.name)}" mimeType="${escapeAttribute(attachment.mimeType ?? parseableContentType)}" extractedAs="${extractedAsLabel(parseableContentType)}">`,
              truncateText(parsedText, perFileCharLimit),
              "</file>",
            ].join("\n");
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            return `<file name="${escapeAttribute(attachment.name)}" mimeType="${escapeAttribute(attachment.mimeType ?? parseableContentType)}" warning="document_text_extraction_failed">${escapeAttribute(message)}</file>`;
          }
        }

      let decoded = "";
      try {
        decoded = decodeAttachmentData(attachment.data ?? "").trim();
      } catch {
        return "";
      }
      if (!decoded) return "";

      const content = truncateText(decoded, perFileCharLimit);
      return [
        `<file name="${escapeAttribute(attachment.name)}" mimeType="${escapeAttribute(attachment.mimeType ?? "unknown")}">`,
        content,
        "</file>",
      ].join("\n");
      }),
    )
  )
    .filter(Boolean);

  if (fileContexts.length === 0) return "";

  const body = truncateText(fileContexts.join("\n\n"), totalCharLimit);
  return `[System Note: The following user file attachments are included as read-only text context for Pi. These files have not been saved to the workspace for Pi, and this context does not grant file read, write, edit, shell, MCP, or external action permissions.\n\n${body}\n]\n\n`;
}
