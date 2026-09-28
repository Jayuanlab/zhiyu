import { buildBrainContextFromMemoryRequest } from "@/lib/brain/service";
import {
  searchUnifiedMemory,
  type UnifiedMemorySearchOutput,
  type UnifiedMemorySearchSource,
} from "@/lib/memory/unified-search";

type BrainContextResult = Awaited<
  ReturnType<typeof buildBrainContextFromMemoryRequest>
>;

export const UNIFIED_MEMORY_SOURCES = [
  "memory",
  "insights",
  "knowledge",
  "interactions",
  "graph",
] as const satisfies UnifiedMemorySearchSource[];

export type UnifiedMemoryToolSource = (typeof UNIFIED_MEMORY_SOURCES)[number];

export interface UnifiedMemoryToolInput {
  userId: string;
  /** Set only by the trusted Work runtime; never accepted from model tool arguments. */
  workId?: string;
  query: string;
  sources?: UnifiedMemoryToolSource[];
  limit?: number;
  threshold?: number;
  botIds?: string[];
  documentIds?: string[];
  includeArchivedInsights?: boolean;
  brainSourceKinds?: string[];
  brainPrivacyClasses?: string[];
  brainExcludePrivacyClasses?: string[];
  brainRiskLevels?: string[];
  brainScenarioKeys?: string[];
  embeddingsAuthToken?: string;
}

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
  results: UnifiedMemorySearchOutput["results"],
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
        item.canonicalKind === "boundary" || item.memoryType === "boundary"
          ? "Role: control_constraint. Apply this rule only in its owning scope; its presence is NOT evidence that the user's subject was answered. A trading rule does not explain the memory system."
          : "Role: candidate_answer_evidence. Check subject relevance and source validity before citing.",
        `facets=${JSON.stringify(item.facets ?? {})}`,
        `reasons=${item.reasons.join(", ")}`,
        item.warnings?.length ? `warnings=${item.warnings.join(", ")}` : "",
        content,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n---\n\n");
}

function getHitSourceSummary(results: UnifiedMemorySearchOutput["results"]) {
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

export function normalizeUnifiedMemorySources(
  sources: unknown,
): UnifiedMemoryToolSource[] | undefined {
  if (!Array.isArray(sources)) return undefined;
  const allowed = new Set<string>(UNIFIED_MEMORY_SOURCES);
  const normalized = sources.filter(
    (source): source is UnifiedMemoryToolSource =>
      typeof source === "string" && allowed.has(source),
  );
  return normalized;
}

export function safeUnifiedMemoryLimit(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(20, Math.trunc(value)))
    : 8;
}

export function safeUnifiedMemoryThreshold(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(-1, Math.min(1, value))
    : 0.35;
}

function emptyLegacyDiscovery(query: string): UnifiedMemorySearchOutput {
  return {
    query,
    sources: [],
    resultKind: "empty",
    sourceSemantics: {
      memory: "canonical_context_candidate",
      insights: "legacy_discovery",
      knowledge: "evidence_source",
      interactions: "legacy_discovery",
      graph: "derived_index",
    },
    sourceStatuses: [],
    results: [],
    count: 0,
    warnings: [],
  };
}

export async function searchUnifiedMemoryForUser(
  input: UnifiedMemoryToolInput,
) {
  try {
    const limit = safeUnifiedMemoryLimit(input.limit);
    const threshold = safeUnifiedMemoryThreshold(input.threshold);
    let brainContext: BrainContextResult | null = null;
    let brainContextError: string | null = null;
    try {
      if (!input.sources || input.sources.includes("memory")) {
      brainContext = await buildBrainContextFromMemoryRequest({
        requester: {
          type: input.workId ? "work" : "chat",
          userId: input.userId,
          id: input.workId ?? "searchUnifiedMemory",
        },
        accessMode: input.workId ? "strict" : "owner_override",
        discoverySources: input.workId ? [] : input.sources?.filter((source): source is "knowledge" | "graph" => source === "knowledge" || source === "graph"),
        taskIntent: input.query,
        platformState: {
          platform: "chat",
          phase: "tool_memory_search",
          riskLevel: "normal",
        },
        action: {
          kind: "answer",
          description: "Search long-term memory for the current chat tool call.",
        },
        maxItems: limit,
        memoryLimit: 200,
        sourceFilters: {
          sourceKinds: input.brainSourceKinds,
          privacyClasses: input.brainPrivacyClasses,
          excludePrivacyClasses: input.brainExcludePrivacyClasses,
          riskLevels: input.brainRiskLevels,
          scenarioKeys: input.brainScenarioKeys,
        },
        metadata: {
          source: "searchUnifiedMemory",
          requestedSources: input.sources ?? null,
          brainSourceFilters: {
            sourceKinds: input.brainSourceKinds ?? null,
            privacyClasses: input.brainPrivacyClasses ?? null,
            excludePrivacyClasses: input.brainExcludePrivacyClasses ?? null,
            riskLevels: input.brainRiskLevels ?? null,
            scenarioKeys: input.brainScenarioKeys ?? null,
          },
        },
      });
      }
    } catch (error) {
      brainContextError = error instanceof Error ? error.message : String(error);
    }

    const requestedLegacySources = input.sources?.filter(
      (source) => source !== "memory",
    );
    const shouldRunLegacyDiscovery =
      (requestedLegacySources?.length ?? 0) > 0 ||
      (!input.sources && (brainContext?.items.length ?? 0) === 0);
    const result = shouldRunLegacyDiscovery && !input.workId
      ? await searchUnifiedMemory({
          userId: input.userId,
          query: input.query,
          sources:
            requestedLegacySources && requestedLegacySources.length > 0
              ? requestedLegacySources
              : ["insights", "knowledge", "interactions", "graph"],
          limit,
          threshold,
          botIds: input.botIds,
          documentIds: input.documentIds,
          includeArchivedInsights: input.includeArchivedInsights ?? false,
          authToken: input.embeddingsAuthToken,
        })
      : emptyLegacyDiscovery(input.query);
    if (shouldRunLegacyDiscovery && input.workId) result.warnings.push({ source: "memory", code: "scoped_discovery_unavailable", message: "Owner-wide legacy discovery is unavailable to scoped Work recall; no broader source was read." });
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
      `Scoped memory recall for: ${input.query}`,
      input.sources && !input.sources.includes("memory") ? "Brain ContextPack: not requested; no personal memory read."
        : `Brain ContextPack: selected=${brainContext?.selection.selectedCount ?? 0}; denied=${brainContext?.selection.deniedCount ?? 0}; omitted=${brainContext?.selection.omittedCount ?? 0}; planner=${brainContext?.recallPlan.mode ?? "unavailable"}`,
      (brainContext?.selection.deniedCount ?? 0) > 0 ? "Coverage is restricted by access policy. Denied records were not read; do not infer their contents or claim the information does not exist." : "",
      "A search miss is not proof that a fact or document does not exist. Source errors mean unavailable coverage, not zero results.",
      "Recall may reserve boundary/control memories even when they do not answer the query. Do not report a question as covered just because control constraints were returned. If only unrelated constraints are present, explicitly report the topic gap and request another authorized source.",
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
      ok: true,
      text,
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
      ok: false,
      isError: true,
      text: `Failed to search semantic memory: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
