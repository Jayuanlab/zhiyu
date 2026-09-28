import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { ragChunks, ragDocuments } from "@/lib/db/schema";

export function knowledgeSearchTerms(query: string): string[] {
  const stop = new Set(["请", "通过", "查询", "知识库", "文档", "关于", "提供", "找到", "不要", "其他", "来源", "代替", "the", "and", "for", "with", "from"]);
  return [...new Set([...new Intl.Segmenter("zh", { granularity: "word" }).segment(query)]
    .filter(part => part.isWordLike).map(part => part.segment.toLowerCase())
    .filter(term => term.length >= 2 && !stop.has(term)))].slice(0, 12);
}
export async function searchKnowledgeKeywordsForOwner(input: { userId: string; query: string; documentIds?: string[]; limit: number }) {
  const terms = knowledgeSearchTerms(input.query);
  if (!terms.length) return { terms, results: [] };
  const matches = terms.map(term => {
    const pattern = `%${term.replace(/[\\%_]/g, value => `\\${value}`)}%`;
    return sql`lower(${ragChunks.content}) like ${pattern} escape '\\'`;
  });
  const conditions = [eq(ragChunks.userId, input.userId), eq(ragDocuments.userId, input.userId), or(...matches)!];
  if (input.documentIds?.length) conditions.push(inArray(ragChunks.documentId, input.documentIds));
  const results = await db.select({ chunkId: ragChunks.id, documentId: ragChunks.documentId,
    documentName: ragDocuments.fileName, chunkIndex: ragChunks.chunkIndex, content: ragChunks.content })
    .from(ragChunks).innerJoin(ragDocuments, eq(ragChunks.documentId, ragDocuments.id))
    .where(and(...conditions)).orderBy(asc(ragChunks.documentId), asc(ragChunks.chunkIndex)).limit(input.limit);
  return { terms, results: results as Array<{ chunkId: string; documentId: string; documentName: string; chunkIndex: number; content: string }> };
}
