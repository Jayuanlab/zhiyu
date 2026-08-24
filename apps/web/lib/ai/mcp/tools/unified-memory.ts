/**
 * Semantic memory tool - searchUnifiedMemory
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Session } from "next-auth";
import { searchUnifiedMemory } from "@/lib/memory/unified-search";
import { buildBrainContextFromMemoryRequest } from "@/lib/brain/service";

type BrainContextResult = Awaited<
  ReturnType<typeof buildBrainContextFromMemoryRequest>
>;

const memorySourceSchema = z.enum([
  "memory",
  "insights",
  "knowledge",
  "interactions",
  "graph",
]);

function formatMetadata(metadata: Record<string, unknown>): string {
  const compact: Record<string, unknown> = {};
  for (const key of [
    "source",
    "platform",
    "botId",
    "channel",
    "person",
    "timestamp",
    "documentName",
    "title",
    "memoryStage",
    "memoryType",
    "subject",
    "status",
    "scope",
    "ownerType",
    "ownerId",
    "evidenceRefs",
    "sourceEventIds",
    "relationType",
    "object",
    "evidence",
    "confidence",
    "evidenceStrength",
  ]) {
    if (metadata[key] !== undefined) {
      compact[key] = metadata[key];
    }
  }
  return Object.keys(compact).length > 0 ? JSON.stringify(compact) : "{}";
}

function formatUnifiedMemoryResults(
  results: Awaited<ReturnType<typeof searchUnifiedMemory>>["results"],
): string {
  if (results.length === 0) {
    return "No relevant memory results found.";
  }

  return results
    .map((result, index) => {
      const content =
        result.content.length > 1200
          ? `${result.content.slice(0, 1200)}...`
          : result.content;
      return [
        `[${index + 1}] ${result.type} score=${result.similarity.toFixed(3)} id=${result.id}`,
        `metadata: ${formatMetadata(result.metadata)}`,
        content,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

function formatBrainContextResults(brainContext: BrainContextResult | null) {
  if (!brainContext || brainContext.items.length === 0) {
    return "No Brain ContextPack memories selected.";
  }
  return brainContext.items
    .map((item, index) => {
      const content =
        item.content.length > 1200
          ? `${item.content.slice(0, 1200)}...`
          : item.content;
      return [
        `[${index + 1}] brain_context score=${item.score.toFixed(1)} id=${item.id}`,
        `canonicalKind=${item.canonicalKind ?? "unknown"} memoryType=${item.memoryType}`,
        `reasons=${item.reasons.join(", ")}`,
        content,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

function getHitSourceSummary(
  results: Awaited<ReturnType<typeof searchUnifiedMemory>>["results"],
) {
  const stats = results.reduce<
    Record<string, { count: number; maxScore: number; totalScore: number }>
  >((acc, result) => {
    const current = acc[result.type] ?? {
      count: 0,
      maxScore: Number.NEGATIVE_INFINITY,
      totalScore: 0,
    };
    current.count += 1;
    current.maxScore = Math.max(current.maxScore, result.similarity);
    current.totalScore += result.similarity;
    acc[result.type] = current;
    return acc;
  }, {});

  const hitSourceScores = Object.fromEntries(
    Object.entries(stats).map(([source, sourceStats]) => [
      source,
      {
        count: sourceStats.count,
        maxScore: Number(sourceStats.maxScore.toFixed(3)),
        avgScore: Number(
          (sourceStats.totalScore / sourceStats.count).toFixed(3),
        ),
      },
    ]),
  );

  return {
    hitSources: Object.keys(stats),
    hitSourceCounts: Object.fromEntries(
      Object.entries(stats).map(([source, sourceStats]) => [
        source,
        sourceStats.count,
      ]),
    ),
    hitSourceScores,
  };
}

function previewLogContent(content: string, maxLength = 220): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > maxLength
    ? `${compact.slice(0, maxLength)}...`
    : compact;
}

function pickLogMetadata(metadata: Record<string, unknown>) {
  const keys = [
    "source",
    "platform",
    "channel",
    "person",
    "timestamp",
    "title",
    "documentName",
    "memoryType",
    "subject",
    "status",
    "scope",
    "ownerType",
    "evidenceRefs",
    "relationType",
    "object",
    "evidenceStrength",
  ];
  return Object.fromEntries(
    keys
      .filter((key) => metadata[key] !== undefined)
      .map((key) => [key, metadata[key]]),
  );
}

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

        let brainContext: BrainContextResult | null = null;
        let brainContextError: string | null = null;
        try {
          brainContext = await buildBrainContextFromMemoryRequest({
            requester: {
              type: "chat",
              userId: session.user.id,
              id: "searchUnifiedMemory",
            },
            taskIntent: args.query,
            platformState: {
              platform: "chat",
              phase: "tool_memory_search",
              riskLevel: "normal",
            },
            action: {
              kind: "answer",
              description:
                "Search long-term memory for the current chat tool call.",
            },
            maxItems: args.limit,
            memoryLimit: 200,
            metadata: {
              source: "searchUnifiedMemory",
              requestedSources: args.sources ?? null,
            },
          });
        } catch (error) {
          brainContextError =
            error instanceof Error ? error.message : String(error);
        }

        const requestedLegacySources = args.sources?.filter(
          (source) => source !== "memory",
        );
        const shouldRunLegacyDiscovery =
          (requestedLegacySources?.length ?? 0) > 0 ||
          (brainContext?.items.length ?? 0) === 0;
        const result = shouldRunLegacyDiscovery
          ? await searchUnifiedMemory({
              userId: session.user.id,
              query: args.query,
              sources:
                requestedLegacySources && requestedLegacySources.length > 0
                  ? requestedLegacySources
                  : ["insights", "knowledge", "interactions", "graph"],
              limit: args.limit,
              threshold: args.threshold,
              botIds: args.botIds,
              documentIds: args.documentIds,
              includeArchivedInsights: args.includeArchivedInsights,
              authToken: embeddingsAuthToken,
            })
          : {
              query: args.query,
              sources: [],
              resultKind: "empty" as const,
              sourceSemantics: {
                memory: "canonical_context_candidate" as const,
                insights: "legacy_discovery" as const,
                knowledge: "evidence_source" as const,
                interactions: "legacy_discovery" as const,
                graph: "derived_index" as const,
              },
              sourceStatuses: [],
              results: [],
              count: 0,
              warnings: [],
            };
        const { hitSources, hitSourceCounts, hitSourceScores } =
          getHitSourceSummary(result.results);

        console.log("[SemanticMemoryTool] search completed", {
          query: result.query,
          requestedSources: result.sources,
          hitSources,
          hitSourceCounts,
          hitSourceScores,
          count: result.count,
          warnings: result.warnings.map((warning) => ({
            source: warning.source,
            code: warning.code,
          })),
          topResults: result.results.slice(0, 5).map((item) => ({
            type: item.type,
            id: item.id,
            similarity: Number(item.similarity.toFixed(3)),
            metadata: pickLogMetadata(item.metadata),
            contentPreview: previewLogContent(item.content),
          })),
        });

        const text = [
          `Brain-first memory recall for: ${args.query}`,
          `Brain ContextPack: selected=${brainContext?.selection.selectedCount ?? 0}; denied=${brainContext?.selection.deniedCount ?? 0}; omitted=${brainContext?.selection.omittedCount ?? 0}; planner=${brainContext?.recallPlan.mode ?? "unavailable"}`,
          brainContext?.recallPlan.routes?.length
            ? `Recall routes: ${brainContext.recallPlan.routes
                .filter((route) => route.enabled)
                .map((route) => `${route.route}:${route.purpose}`)
                .join(", ")}`
            : "",
          brainContextError ? `Brain recall error: ${brainContextError}` : "",
          "",
          formatBrainContextResults(brainContext),
          "",
          `Legacy discovery sources: ${result.sources.join(", ") || "none"}; count=${result.count}`,
          `Legacy hit sources: ${hitSources.length > 0 ? hitSources.join(", ") : "none"}`,
          result.warnings.length > 0
            ? `Warnings: ${result.warnings
                .map((warning) => `${warning.source}:${warning.code}`)
                .join(", ")}`
            : "",
          "",
          formatUnifiedMemoryResults(result.results),
        ]
          .filter(Boolean)
          .join("\n");

        return {
          content: [
            {
              type: "text" as const,
              text,
            },
          ],
          data: {
            brainContext,
            brainExplanation: brainContext?.explanation ?? null,
            brainRouteResults: brainContext?.routeResults ?? [],
            brainContextError,
            legacyDiscovery: result,
          },
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
