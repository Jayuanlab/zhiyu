import { ragSourceRecord, type RagDocumentRow } from "@/lib/memory/evidence/rag-record";
export const ragOwner = "00000000-0000-4000-8000-000000000010", ragDocumentId = "00000000-0000-4000-8000-000000000001", ragChunkId = "00000000-0000-4000-8000-000000000002";
export function ragFixture(content = "literal evidence", overrides: Partial<RagDocumentRow> = {}) {
  const document: RagDocumentRow = { id: ragDocumentId, userId: ragOwner, fileName: "source.txt", contentType: "text/plain", sizeBytes: Buffer.byteLength(content),
    totalChunks: 1, blobPath: "https://legacy.invalid/never-fetch", uploadedAt: new Date("2026-10-20T00:00:00Z"), updatedAt: new Date("2026-10-20T00:00:00Z"), ...overrides };
  const chunk = { id: ragChunkId, documentId: document.id, userId: document.userId, chunkIndex: 0, content, createdAt: document.uploadedAt };
  return { document, chunk, record: ragSourceRecord(document, [chunk]) };
}
