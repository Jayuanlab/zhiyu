/**
 * Search Knowledge tools - searchKnowledgeBase, getFullDocumentContent, listKnowledgeBaseDocuments
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Session } from "next-auth";
import {
  getKnowledgeBaseDocumentContentForUser,
  listKnowledgeBaseDocumentsForUser,
  searchKnowledgeBaseForUser,
} from "@/lib/ai/knowledge-base-documents";

/**
 * Create the search knowledge tools
 */
export function createSearchKnowledgeTools(
  session: Session,
  embeddingsAuthToken?: string,
) {
  return [
    // searchKnowledgeBase tool
    tool(
      "searchKnowledgeBase",
      [
        "Search the user's strategy memory for relevant information.",
        "This includes uploaded documents AND the user's focus settings (people of interest, topics of interest, etc.).",
        "",
        "**MUST USE** when:",
        "1) User asks about their documents, files, or uploaded content",
        "2) User asks questions related to their focus people, topics, or strategy",
        "",
        "**⭐ SEARCH STRATEGY - IMPORTANT:**",
        "- When searching, use MULTIPLE SEPARATE keywords instead of a single long phrase",
        "- Try different keyword combinations if first search doesn't find results",
        "- Examples:",
        "  ❌ BAD: query='Zhiyu PR feature new' (too specific, won't match)",
        "  ✅ GOOD: Try query='PR', then query='Zhiyu', then query='feature', then query='new' (multiple searches)",
        "",
        "Examples:",
        "- 'What's in this document?'",
        "- 'What do I care about?'",
        "- 'What are my priorities?'",
        "- 'What do you know about X?' → Try query='X', then query='related topic'",
        "- 'Find information about Y' → Try query='Y', then query='broader term'",
        "- 'Zhiyu PR feature progress' → Try query='PR', then query='Zhiyu', then query='feature' (multiple searches)",
        "",
        "Use this tool BEFORE answering questions about user's content or preferences.",
      ].join("\n"),
      {
        query: z
          .string()
          .describe(
            "The search query to find relevant information in the user's strategy memory",
          ),
        limit: z.coerce
          .number()
          .min(1)
          .max(20)
          .default(5)
          .describe(
            "Maximum number of relevant chunks to retrieve (default: 5, max: 20)",
          ),
        documentIds: z
          .array(z.string())
          .optional()
          .describe(
            "Optional: specific document IDs to search within. If not provided, searches all documents.",
          ),
      },
      async (args) => {
        try {
          const { query, limit = 5, documentIds } = args;

          // Validate user session
          if (!session?.user?.id) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Unauthorized: invalid user session",
                },
              ],
              isError: true,
            };
          }

          const userId = session.user.id;

          const result = await searchKnowledgeBaseForUser({
            userId,
            query,
            limit,
            documentIds,
            embeddingsAuthToken,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: result.text,
              },
            ],
            data: result.data,
            isError: result.isError,
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No results found in knowledge base.",
              },
            ],
            data: {
              error: error instanceof Error ? error.message : "Unknown error",
            },
            isError: true,
          };
        }
      },
    ),

    // getFullDocumentContent tool
    tool(
      "getFullDocumentContent",
      [
        "Get the COMPLETE full text content of a document.",
        "",
        "Use this when the user asks to:",
        "- Summarize a document",
        "- Explain 'what's in this document'",
        "- Analyze the entire document content",
        "",
        "This provides ALL chunks concatenated together, not just relevant excerpts.",
        "Best for small documents or summarization tasks.",
      ].join("\n"),
      {
        documentId: z
          .string()
          .describe("The ID of the document to retrieve full content for"),
      },
      async (args) => {
        try {
          const { documentId } = args;

          // Validate user session
          if (!session?.user?.id) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Unauthorized: invalid user session",
                },
              ],
              isError: true,
            };
          }

          const userId = session.user.id;

          const result = await getKnowledgeBaseDocumentContentForUser({
            userId,
            documentId,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: result.text,
              },
            ],
            data: result.data,
            isError: result.isError,
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Failed to retrieve document content.",
              },
            ],
            data: {
              error: error instanceof Error ? error.message : "Unknown error",
            },
            isError: true,
          };
        }
      },
    ),

    // listKnowledgeBaseDocuments tool
    tool(
      "listKnowledgeBaseDocuments",
      [
        "List all documents in the user's knowledge base.",
        "",
        "Use this when:",
        "- User asks 'what documents do I have', 'list my files', 'show me my knowledge base'",
        "- User wants to see what files are available in their strategy memory",
        "- User wants to know what documents they can search or analyze",
        "",
        "This returns a list of all uploaded documents with their metadata (name, size, upload date, chunk count).",
        "After listing, user can ask to search specific documents or get full content of a particular document.",
      ].join("\n"),
      {
        limit: z.coerce
          .number()
          .min(1)
          .max(100)
          .default(50)
          .describe(
            "Maximum number of documents to return (default: 50, max: 100)",
          ),
      },
      async (args) => {
        try {
          const { limit = 50 } = args;

          // Validate user session
          if (!session?.user?.id) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Unauthorized: invalid user session",
                },
              ],
              isError: true,
            };
          }

          const userId = session.user.id;

          const result = await listKnowledgeBaseDocumentsForUser({
            userId,
            limit,
          });
          if (!result.ok) return { content: [{ type: "text" as const, text: result.text }], data: result.data, isError: true };

          return {
            content: [
              {
                type: "text" as const,
                text: result.text,
              },
            ],
            data: {
              documents: result.documents,
              count: result.count,
              returnedCount: result.returnedCount,
            },
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Failed to list knowledge base documents.",
              },
            ],
            data: {
              error: error instanceof Error ? error.message : "Unknown error",
            },
            isError: true,
          };
        }
      },
    ),
  ];
}
