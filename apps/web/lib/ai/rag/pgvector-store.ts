/**
 * PGVector Store — app-side re-export layer.
 * Wires app-specific parseFile and estimateTokens into the @openzhiyu/rag package.
 */

import { parseFile } from "@/lib/files/parsers";
import { estimateTokens } from "@/lib/ai";
import { configurePGVector } from "@openzhiyu/rag/pgvector-store";

// Configure with app-specific dependencies
configurePGVector({
  parseFile: async (buffer, contentType, userId) => {
    const result = await parseFile(buffer, contentType, undefined, userId);
    return {
      text: result.text,
      metadata: result.metadata as Record<string, unknown>,
    };
  },
  estimateTokens,
});

// Re-export everything from package
export {
  getPGVectorStore,
  processDocumentWithPGVector,
  searchWithPGVector,
  deleteDocumentsFromPGVector,
  getDocumentCount,
  listUserDocuments,
} from "@openzhiyu/rag/pgvector-store";
