/**
 * Semantic memory tool - searchUnifiedMemory
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Session } from "next-auth";
import { searchUnifiedMemoryForUser } from "@/lib/ai/unified-memory-tool";

const memorySourceSchema = z.enum([
  "memory",
  "insights",
  "knowledge",
  "interactions",
  "graph",
]);

/**
 * Create the semantic memory search tool.
 */
export function createUnifiedMemorySearchTool(
  session: Session,
  embeddingsAuthToken?: string,
) {
  return tool(
    "searchUnifiedMemory",
    [
      "Brain-first memory recall and legacy discovery tool. It first asks the unified Brain memory platform to plan recall, apply permissions, deduplicate canonical memories, and return a ContextPack. It can also run legacy multi-source discovery for documents, insights, graph, and fallback evidence.",
      "",
      "**Use this when:**",
      "- User asks about remembered context, past conversations, uploaded documents, knowledge base content, raw/original messages, extracted insights, tasks, projects, people, decisions, risks, owners, next actions, or preferences",
      "- User asks something like 'what do you remember about...', 'what did we discuss...', 'find anything about...'",
      "- User asks document/PDF/knowledge questions and the relevant source may be uploaded knowledge",
      "- The relevant source is unclear or may span memory, insights, knowledge, and Owner Context",
      "",
      "**Search strategy:**",
      "- Treat the returned brainContext as the authoritative long-term memory projection.",
      "- Treat legacyDiscovery results as evidence discovery or fallback, not canonical long-term memory.",
      "- Start with no sources unless the user explicitly needs documents, insights, graph, or fallback evidence.",
      "- Use sources=['insights'] for summarized tasks, todos, priorities, and extracted events",
      "- Use sources=['knowledge'] for uploaded documents and strategy memory",
      "- Use sources=['interactions'] for confirmed facts remembered from external channels such as WeChat",
      "- Use sources=['graph'] for people, projects, commitments, risks, decisions, contradictions, and evidence-linked relationship context",
      "- Use a concise natural-language query; semantic search works better than long prompt dumps",
      "- Use narrower keyword/exact-match tools after this tool if semantic results are missing or a literal phrase lookup is needed",
    ].join("\n"),
    {
      query: z.string().describe("Natural-language memory search query."),
      sources: z
        .array(memorySourceSchema)
        .optional()
        .describe(
          "Sources to search: memory, insights, knowledge, interactions, graph. Defaults to all sources.",
        ),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(20)
        .default(8)
        .describe("Maximum number of results to return. Default is 8."),
      threshold: z.coerce
        .number()
        .min(-1)
        .max(1)
        .default(0.35)
        .describe(
          "Similarity threshold. Lower values improve recall. Default is 0.35.",
        ),
      botIds: z
        .array(z.string())
        .optional()
        .describe("Optional bot IDs to restrict raw memory/insight search."),
      documentIds: z
        .array(z.string())
        .optional()
        .describe("Optional document IDs to restrict knowledge search."),
      includeArchivedInsights: z
        .boolean()
        .default(false)
        .describe("Whether to include archived insights."),
      brainSourceKinds: z
        .array(z.string())
        .optional()
        .describe(
          "Optional Brain facet filter, for example ['wechat'] to recall only WeChat-derived long-term memory.",
        ),
      brainPrivacyClasses: z
        .array(z.string())
        .optional()
        .describe(
          "Optional allowed Brain privacy classes, for example ['normal'].",
        ),
      brainExcludePrivacyClasses: z
        .array(z.string())
        .optional()
        .describe(
          "Optional Brain privacy classes to exclude, for example ['private','sensitive','regulated'].",
        ),
      brainRiskLevels: z
        .array(z.string())
        .optional()
        .describe("Optional allowed Brain risk levels, for example ['low']."),
      brainScenarioKeys: z
        .array(z.string())
        .optional()
        .describe(
          "Optional Brain scenario facet keys, for example ['project:contract-alpha'] or ['contract-alpha'].",
        ),
    },
    async (args) => {
      try {
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

        const result = await searchUnifiedMemoryForUser({
          userId: session.user.id,
          query: args.query,
          sources: args.sources,
          limit: args.limit,
          threshold: args.threshold,
          botIds: args.botIds,
          documentIds: args.documentIds,
          includeArchivedInsights: args.includeArchivedInsights,
          brainSourceKinds: args.brainSourceKinds,
          brainPrivacyClasses: args.brainPrivacyClasses,
          brainExcludePrivacyClasses: args.brainExcludePrivacyClasses,
          brainRiskLevels: args.brainRiskLevels,
          brainScenarioKeys: args.brainScenarioKeys,
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
              text: `Failed to search semantic memory: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
