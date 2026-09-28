import {
  formatSearchResultsForLLM,
  getDocument,
  getDocumentFullContent,
  getUserDocuments,
  searchSimilarChunks,
} from "@/lib/ai/rag/langchain-service";
import { searchKnowledgeKeywordsForOwner } from "./knowledge-keyword-search";
import { evidenceWindow } from "./evidence-window";

type KnowledgeDocument = {
  id: string;
  fileName: string;
  contentType?: string | null;
  sizeBytes?: number | string | null;
  totalChunks?: number | null;
  uploadedAt?: Date | string | null;
};

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function safeKnowledgeDocumentLimit(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(100, Math.trunc(value)))
    : 50;
}

export function safeKnowledgeSearchLimit(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(20, Math.trunc(value)))
    : 5;
}

export async function listKnowledgeBaseDocumentsForUser(input: {
  userId: string;
  limit?: number;
  getDocuments?: (userId: string) => Promise<KnowledgeDocument[]>;
}) {
  const limit = safeKnowledgeDocumentLimit(input.limit);
  const documents: KnowledgeDocument[] = await (input.getDocuments ??
    getUserDocuments)(input.userId);

  if (documents.length === 0) {
    return {
      ok: true,
      text: "Your knowledge base is empty. You haven't uploaded any documents yet. You can upload documents using the file upload feature in chat.",
      documents: [],
      count: 0,
      returnedCount: 0,
    };
  }

  const formattedDocuments = documents.slice(0, limit).map((doc: KnowledgeDocument) => ({
    id: doc.id,
    fileName: doc.fileName,
    contentType: doc.contentType,
    sizeBytes: Number(doc.sizeBytes ?? 0),
    totalChunks: Number(doc.totalChunks ?? 0),
    uploadedAt: doc.uploadedAt,
  }));
  const docList = formattedDocuments
    .map(
      (document: (typeof formattedDocuments)[number], index: number) =>
        `${index + 1}. **${document.fileName}** (${formatFileSize(document.sizeBytes)}, ${document.totalChunks} chunks, ${
          document.uploadedAt ? formatDate(document.uploadedAt) : "unknown date"
        })`,
    )
    .join("\n");
  const header = `You have **${documents.length}** document(s) in your knowledge base:\n\n`;
  const footer =
    documents.length > limit
      ? `\n\n_Showing ${limit} of ${documents.length} documents. Upload more documents to expand your knowledge base._`
      : "";

  return {
    ok: true,
    text: header + docList + footer,
    documents: formattedDocuments,
    count: documents.length,
    returnedCount: formattedDocuments.length,
  };
}

export async function getKnowledgeBaseDocumentContentForUser(input: {
  userId: string;
  documentId: string;
  offset?: number;
  expectedHash?: string;
  getDocumentById?: (documentId: string) => Promise<(KnowledgeDocument & { userId?: string }) | undefined | null>;
  getFullContent?: (
    documentId: string,
  ) => Promise<{ documentId: string; content: string; totalChunks: number }>;
}) {
  const document = await (input.getDocumentById ?? getDocument)(
    input.documentId,
  );

  if (!document) {
    return {
      ok: false,
      isError: true,
      text: "Document not found.",
      data: {
        code: "document_not_found",
        documentId: input.documentId,
      },
    };
  }

  if (document.userId !== input.userId) {
    return {
      ok: false,
      isError: true,
      text: "Unauthorized: you don't have access to this document.",
      data: {
        code: "document_forbidden",
        documentId: input.documentId,
      },
    };
  }

  const result = await (input.getFullContent ?? getDocumentFullContent)(
    input.documentId,
  );

  if (input.offset !== undefined || input.expectedHash !== undefined) {
    const page = evidenceWindow(result.content, input.offset ?? 0, input.expectedHash);
    const data = { ...page, documentId: result.documentId, documentName: document.fileName,
      totalChunks: result.totalChunks, retrievedAt: new Date().toISOString(), scope: "authenticated_owner_document" };
    return { ok: page.status === "read", isError: page.status !== "read", text: JSON.stringify(data), data };
  }

  return {
    ok: true,
    text: result.content,
    data: {
      documentId: result.documentId,
      documentName: document.fileName,
      totalChunks: result.totalChunks,
      contentLength: result.content.length,
      message: `Successfully retrieved full content of "${document.fileName}" (${result.totalChunks} chunks, ${result.content.length} characters).`,
    },
  };
}

export async function searchKnowledgeBaseForUser(input: {
  userId: string;
  query: string;
  limit?: number;
  documentIds?: string[];
  embeddingsAuthToken?: string;
  searchChunks?: typeof searchSimilarChunks;
  formatResults?: typeof formatSearchResultsForLLM;
  searchKeywords?: typeof searchKnowledgeKeywordsForOwner;
}) {
  try {
    const limit = safeKnowledgeSearchLimit(input.limit);
    const search = input.searchChunks ?? searchSimilarChunks;
    const results = await search(
      input.userId,
      input.query,
      {
        limit,
        threshold: 0.5,
        documentIds: input.documentIds,
      },
      input.embeddingsAuthToken,
    );

    if (results.length === 0) {
      return {
        ok: true,
        text:
          input.documentIds && input.documentIds.length > 0
            ? "No relevant information found in the specified documents."
            : "No relevant information found in your strategy memory. Try uploading documents or rephrase your question.",
        data: {
          results: [],
          count: 0,
        },
      };
    }

    const formattedContent = (input.formatResults ?? formatSearchResultsForLLM)(
      results,
    );

    return {
      ok: true,
      text: formattedContent,
      data: {
        results: results.map((result: any) => ({
          documentName: result.documentName,
          content: result.content,
          similarity: result.similarity,
          chunkIndex: result.chunkIndex,
        })),
        count: results.length,
      },
    };
  } catch (error) {
    try {
      const fallback = await (input.searchKeywords ?? searchKnowledgeKeywordsForOwner)({ userId: input.userId,
        query: input.query, documentIds: input.documentIds, limit: safeKnowledgeSearchLimit(input.limit) });
      const data = { provider: "database_keyword_fallback", status: "degraded", reason: "semantic_search_unavailable",
        coverage: "bounded_keyword_search_not_exhaustive", observedAt: new Date().toISOString(), terms: fallback.terms,
        count: fallback.results.length, results: fallback.results.map(row => ({ ...row, content: row.content.slice(0, 3000), truncated: row.content.length > 3000 })),
        warning: "Semantic search failed; only literal keyword matching was available. No semantic score is claimed. Zero matches do not prove documents or facts do not exist. Use document IDs to expand source evidence." };
      return { ok: true, text: JSON.stringify(data), data };
    } catch {
      // Retain a source failure rather than claiming an empty knowledge base.
    }
    return {
      ok: false,
      isError: true,
      text: "Knowledge-base search failed. Coverage is unavailable, NOT empty; do not claim that documents do not exist. Inspect the source error or use an authorized document listing/read to recover.",
      data: {
        error: error instanceof Error ? error.message : "Unknown error",
      },
    };
  }
}
