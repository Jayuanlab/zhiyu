import { unregisteredFileSource } from "@/lib/memory/evidence/unregistered-file";
export interface NativePiFileAttachmentContextItem { name: string; mimeType?: string | null; data?: string | null }
export const NATIVE_PI_TEXT_ATTACHMENT_TOTAL_CHAR_LIMIT = 16000;
export const NATIVE_PI_TEXT_ATTACHMENT_PER_FILE_CHAR_LIMIT = 6000;
const textTypes = new Set(["application/json", "application/ld+json", "application/xml", "application/yaml", "application/x-yaml", "application/toml", "application/csv", "text/csv", "text/markdown"]);
const textExtensions = new Set(["txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "yaml", "yml", "xml", "toml", "log"]);
const documentTypes = new Set(["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);
const type = (item: Pick<NativePiFileAttachmentContextItem, "mimeType">) => (item.mimeType ?? "").toLowerCase().split(";")[0].trim();
const extension = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase();
/** Media classification grants no permission to read or send a body. */
export function isNativePiReadOnlyTextAttachment(item: Pick<NativePiFileAttachmentContextItem, "name" | "mimeType">) {
  return type(item).startsWith("text/") || textTypes.has(type(item)) || textExtensions.has(extension(item.name));
}
export function isNativePiReadOnlyFileAttachment(item: Pick<NativePiFileAttachmentContextItem, "name" | "mimeType">) {
  return isNativePiReadOnlyTextAttachment(item) || documentTypes.has(type(item)) || ["pdf", "doc", "docx"].includes(extension(item.name));
}
export async function buildNativePiFileAttachmentsContext(attachments: NativePiFileAttachmentContextItem[], _options: {
  totalCharLimit?: number; perFileCharLimit?: number;
  parseDocumentText?: (buffer: Buffer, attachment: NativePiFileAttachmentContextItem, contentType: string) => Promise<string>;
  parsePdfText?: (buffer: Buffer, attachment: NativePiFileAttachmentContextItem) => Promise<string> } = {}): Promise<string> {
  if (!attachments.length) return "";
  // An old inline data/base64/URL field has no durable owner/host/source binding.
  // Import bytes through the managed artifact path before source use instead.
  return `[Stored source gap: ${JSON.stringify(unregisteredFileSource("unregistered-inline-file"))}]\n\n`;
}
