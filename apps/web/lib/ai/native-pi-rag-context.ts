export interface NativePiRagDocumentContext {
  id: string;
  name: string;
  chunks: Array<{
    chunkIndex: number;
    content: string;
  }>;
}

export const NATIVE_PI_RAG_DOCUMENT_CHAR_LIMIT = 12000;

function truncateText(value: string, limit: number) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit).trimEnd()}\n[truncated at ${limit} characters]`;
}

export function buildNativePiRagContext(
  documents: NativePiRagDocumentContext[],
  options?: { perDocumentCharLimit?: number },
) {
  const limit =
    options?.perDocumentCharLimit ?? NATIVE_PI_RAG_DOCUMENT_CHAR_LIMIT;
  const sections = documents
    .filter((document) => document.chunks.length > 0)
    .map((document, index) => {
      const orderedContent = [...document.chunks]
        .sort((a, b) => a.chunkIndex - b.chunkIndex)
        .map((chunk) => chunk.content)
        .join("\n\n");
      return `## Document ${index + 1}: ${document.name}\nID: ${document.id}\n\n${truncateText(orderedContent, limit)}`;
    });

  if (sections.length === 0) return "";

  return `[System Note: The user selected the following read-only knowledge documents. Use only the quoted document content below when answering questions about these files. If the answer is not present, say that the selected documents do not contain enough information.\n\n${sections.join("\n\n---\n\n")}\n]\n\n`;
}
