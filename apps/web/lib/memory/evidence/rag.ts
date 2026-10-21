import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { ragDocuments, user } from "@/lib/db/schema.pg";
import { requireRagOwner, revalidateRagSourceInTransaction } from "../adapters/postgres/rag";
import type { RagSourceRecord } from "./rag-record";
import { MemoryModuleError } from "../kernel/errors";
export { requireRagOwner, revalidateRagSourceInTransaction, admitRagSourceProjectionInTransaction } from "../adapters/postgres/rag";
export { assertRagSourceProjection } from "./rag-record";
export type { RagSourceRecord, RagSourceProjection } from "./rag-record";

export async function readOwnerRagSource(input: { userId: string; documentId: string; metadataOnly?: boolean; revision?: string }): Promise<RagSourceRecord> {
  requireRagOwner(input.userId);
  return db.transaction(store => revalidateRagSourceInTransaction(store, input));
}
export async function listOwnerRagSources(input: { userId: string; limit: number }): Promise<{ records: RagSourceRecord[]; hasMore: boolean }> {
  requireRagOwner(input.userId);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new MemoryModuleError("invalid_memory_request", 400, "Invalid RAG metadata limit");
  return db.transaction(async store => {
    const [principal] = await store.select({ id: user.id }).from(user).where(eq(user.id, input.userId)).for("share");
    if (!principal) throw new MemoryModuleError("memory_access_denied", 403, "Owner identity unavailable");
    const rows: Array<typeof ragDocuments.$inferSelect> = await store.select().from(ragDocuments).where(eq(ragDocuments.userId, input.userId))
      .orderBy(desc(ragDocuments.uploadedAt), desc(ragDocuments.id)).limit(input.limit + 1).for("share");
    const records: RagSourceRecord[] = [];
    for (const row of rows.slice(0, input.limit)) records.push(await revalidateRagSourceInTransaction(store, { userId: input.userId, documentId: row.id, metadataOnly: true }));
    return { records, hasMore: rows.length > input.limit };
  });
}
type RagSearchCandidate = { chunkId: string; documentId: string; documentName: string; content: string; chunkIndex: number; similarity?: number };
/** Vectors and keyword hits are leads. Re-read their actual owner rows before delivering text. */
export async function resolveOwnerRagSearch(input: { userId: string; results: RagSearchCandidate[] }) {
  requireRagOwner(input.userId);
  if (input.results.length > 20) throw new MemoryModuleError("invalid_memory_request", 400, "Too many RAG candidates");
  const ids = [...new Set(input.results.map(row => row.documentId))].sort();
  const records = await db.transaction(async store => {
    const result: RagSourceRecord[] = [];
    for (const documentId of ids) result.push(await revalidateRagSourceInTransaction(store, { userId: input.userId, documentId }));
    return result;
  });
  const results = input.results.map(candidate => {
    const record = records.find(row => row.id === candidate.documentId), chunk = record?.chunks.find(row => row.id === candidate.chunkId);
    if (!record || !chunk || chunk.chunkIndex !== candidate.chunkIndex || chunk.content !== candidate.content || record.document.fileName !== candidate.documentName)
      throw new MemoryModuleError("memory_source_version_changed", 503, "A cached RAG candidate does not match its current owner source; refresh or reindex before using it");
    return { ...candidate, content: chunk.content.slice(0, 3000), truncated: chunk.content.length > 3000, revision: record.revision };
  });
  return { records, results };
}
