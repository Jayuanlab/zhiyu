import { searchSimilarChunks } from "@/lib/ai/rag/langchain-service";
import { searchInsightsSemantically } from "@/lib/insights/search";
import type { BrainMemory } from "@/lib/brain";
import type { BrainContextTraceSummary } from "@/lib/brain/context";

export type UnifiedMemorySearchSource =
  | "memory"
  | "insights"
  | "knowledge"
  | "interactions"
  | "graph";

export interface UnifiedMemorySearchResult {
  type: "memory" | "insight" | "knowledge" | "interaction" | "graph";
  id: string;
  content: string;
  similarity: number;
  metadata: Record<string, unknown>;
}

export type UnifiedMemoryResultSemantics =
  | "canonical_context_candidate"
  | "legacy_discovery"
  | "evidence_source"
  | "derived_index"
  | "fallback_evidence";

export interface UnifiedMemorySearchWarning {
  source: UnifiedMemorySearchSource;
  code: string;
  message: string;
}

export type UnifiedMemorySearchSourceStatus = {
  source: UnifiedMemorySearchSource;
  status: "ok" | "degraded" | "unavailable";
  elapsedMs: number;
  resultCount: number;
  warningCount: number;
  semantics: UnifiedMemoryResultSemantics;
};

export interface UnifiedMemorySearchInput {
  userId: string;
  query: string;
  sources?: UnifiedMemorySearchSource[];
  limit?: number;
  threshold?: number;
  authToken?: string;
  /**
   * @deprecated Ignored. Raw connected-channel message search is no longer part
   * of the current unified memory product path.
   */
  includeLegacyMemory?: boolean;
  includeArchivedInsights?: boolean;
  botIds?: string[];
  documentIds?: string[];
}

export interface UnifiedMemorySearchOutput {
  query: string;
  sources: UnifiedMemorySearchSource[];
  resultKind:
    | "canonical_context"
    | "mixed_context"
    | "legacy_discovery"
    | "empty";
  sourceSemantics: Record<UnifiedMemorySearchSource, UnifiedMemoryResultSemantics>;
  sourceStatuses: UnifiedMemorySearchSourceStatus[];
  contextTrace?: BrainContextTraceSummary;
  results: UnifiedMemorySearchResult[];
  count: number;
  warnings: UnifiedMemorySearchWarning[];
}

const DEFAULT_LIMIT = 10;
const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_SOURCES: UnifiedMemorySearchSource[] = ["memory"];
const ALL_SOURCES: UnifiedMemorySearchSource[] = [
  "memory",
  "insights",
  "knowledge",
  "interactions",
  "graph",
];
const SOURCE_SET = new Set<UnifiedMemorySearchSource>(ALL_SOURCES);
const SOURCE_SEMANTICS: Record<
  UnifiedMemorySearchSource,
  UnifiedMemoryResultSemantics
> = {
  memory: "canonical_context_candidate",
  insights: "legacy_discovery",
  knowledge: "evidence_source",
  interactions: "legacy_discovery",
  graph: "derived_index",
};

function sortWarningsBySourceOrder(
  warnings: UnifiedMemorySearchWarning[],
  sources: UnifiedMemorySearchSource[],
): UnifiedMemorySearchWarning[] {
  const sourceOrder = new Map(
    sources.map((source, index) => [source, index] as const),
  );
  return [...warnings].sort(
    (a, b) =>
      (sourceOrder.get(a.source) ?? Number.MAX_SAFE_INTEGER) -
        (sourceOrder.get(b.source) ?? Number.MAX_SAFE_INTEGER) ||
      a.code.localeCompare(b.code),
  );
}

function emptySourceStatuses(
  sources: UnifiedMemorySearchSource[],
): UnifiedMemorySearchSourceStatus[] {
  return sources.map((source) => ({
    source,
    status: "ok",
    elapsedMs: 0,
    resultCount: 0,
    warningCount: 0,
    semantics: SOURCE_SEMANTICS[source],
  }));
}

type SourceSearchResult = {
  source: UnifiedMemorySearchSource;
  results: UnifiedMemorySearchResult[];
  warnings: UnifiedMemorySearchWarning[];
  elapsedMs: number;
};

async function runSourceSearch(
  source: UnifiedMemorySearchSource,
  search: (
    warnings: UnifiedMemorySearchWarning[],
  ) => Promise<UnifiedMemorySearchResult[]>,
): Promise<SourceSearchResult> {
  const startedAt = Date.now();
  const warnings: UnifiedMemorySearchWarning[] = [];
  const results = await search(warnings);
  return {
    source,
    results,
    warnings,
    elapsedMs: Date.now() - startedAt,
  };
}

function buildSourceStatuses(
  sources: UnifiedMemorySearchSource[],
  sourceResults: SourceSearchResult[],
): UnifiedMemorySearchSourceStatus[] {
  const resultBySource = new Map(
    sourceResults.map((result) => [result.source, result] as const),
  );

  return sources.map((source) => {
    const result = resultBySource.get(source);
    const resultCount = result?.results.length ?? 0;
    const warningCount = result?.warnings.length ?? 0;
    return {
      source,
      status:
        warningCount === 0
          ? "ok"
          : resultCount > 0
            ? "degraded"
            : "unavailable",
      elapsedMs: result?.elapsedMs ?? 0,
      resultCount,
      warningCount,
      semantics: SOURCE_SEMANTICS[source],
    };
  });
}

function getUnifiedMemoryResultKind(
  sources: UnifiedMemorySearchSource[],
): UnifiedMemorySearchOutput["resultKind"] {
  if (sources.length === 0) {
    return "empty";
  }
  const includesCanonical = sources.includes("memory");
  const includesLegacyOrEvidence = sources.some((source) => source !== "memory");
  if (includesCanonical && includesLegacyOrEvidence) {
    return "mixed_context";
  }
  if (includesCanonical) {
    return "canonical_context";
  }
  return "legacy_discovery";
}

function getUnavailableWarningMessage(
  error: unknown,
  fallbackMessage: string,
): string {
  const message = error instanceof Error ? error.message : "";
  const lowerMessage = message.toLowerCase();

  if (
    lowerMessage.includes("type \"vector\" does not exist") ||
    lowerMessage.includes("extension \"vector\"") ||
    lowerMessage.includes("pgvector")
  ) {
    return "Raw message semantic search is unavailable because the vector extension is not enabled.";
  }

  return fallbackMessage;
}

function getErrorMessage(error: unknown, fallbackMessage: string): string {
  if (!(error instanceof Error) || !error.message) {
    return fallbackMessage;
  }

  const message = error.message.trim();
  if (!message) return fallbackMessage;

  if (message.includes("Failed query:")) {
    const lowerMessage = message.toLowerCase();
    if (
      lowerMessage.includes("different vector dimensions") ||
      lowerMessage.includes("vector dimensions")
    ) {
      return "Semantic search is unavailable because stored embeddings have a different vector dimension.";
    }
    return fallbackMessage;
  }

  const withoutParams = message.split("\nparams:")[0]?.trim() ?? message;
  return withoutParams.length > 500
    ? `${withoutParams.slice(0, 500)}...`
    : withoutParams;
}

export function normalizeUnifiedMemorySearchSources(
  sources: unknown,
): UnifiedMemorySearchSource[] {
  if (!Array.isArray(sources) || sources.length === 0) {
    return [...DEFAULT_SOURCES];
  }

  const normalized = sources
    .filter((source): source is string => typeof source === "string")
    .map((source) => source.trim().toLowerCase())
    .filter((source): source is UnifiedMemorySearchSource =>
      SOURCE_SET.has(source as UnifiedMemorySearchSource),
    );

  return normalized.length > 0
    ? Array.from(new Set(normalized))
    : [...DEFAULT_SOURCES];
}

export function clampUnifiedMemorySearchLimit(limit: unknown): number {
  const parsed =
    typeof limit === "number" ? limit : Number(limit ?? DEFAULT_LIMIT);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(50, Math.max(1, Math.floor(parsed)));
}

export function clampUnifiedMemorySearchThreshold(threshold: unknown): number {
  const parsed =
    typeof threshold === "number"
      ? threshold
      : Number(threshold ?? DEFAULT_THRESHOLD);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_THRESHOLD;
  }
  return Math.min(1, Math.max(-1, parsed));
}

export function mergeUnifiedMemorySearchResults(
  results: UnifiedMemorySearchResult[],
  limit: number,
): UnifiedMemorySearchResult[] {
  return [...results]
    .sort((a, b) => {
      const scoreDelta = b.similarity - a.similarity;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return a.type.localeCompare(b.type) || a.id.localeCompare(b.id);
    })
    .slice(0, limit);
}

function toKnowledgeResult(result: {
  chunkId: string;
  documentId: string;
  documentName: string;
  content: string;
  similarity: number;
  chunkIndex: number;
}): UnifiedMemorySearchResult {
  return {
    type: "knowledge",
    id: result.chunkId,
    content: result.content,
    similarity: result.similarity,
    metadata: {
      sourceSemantics: "evidence_source",
      documentId: result.documentId,
      documentName: result.documentName,
      chunkIndex: result.chunkIndex,
    },
  };
}

async function searchConfirmedInteractionMemories(input: {
  userId: string;
  query: string;
  limit: number;
  threshold: number;
}): Promise<UnifiedMemorySearchResult[]> {
  const { searchInteractionMemories } =
    await import("@/lib/interactions/service");
  const threshold = Math.min(Math.max(input.threshold, 0.05), 0.7);
  const results = await searchInteractionMemories({
    userId: input.userId,
    query: input.query,
    limit: input.limit,
    statuses: ["confirmed"],
  });

  return results
    .filter((result) => result.score >= threshold)
    .map(({ memory, score }) => ({
      type: "interaction" as const,
      id: memory.id,
      content: `${memory.subject}: ${memory.content}`,
      similarity: score,
      metadata: {
        sourceSemantics: "legacy_discovery",
        source: "interaction_memory",
        platform: "wechat",
        memoryType: memory.memoryType,
        subject: memory.subject,
        status: memory.status,
        tags: memory.tags,
        sourceEventIds: memory.sourceEventIds,
        confidence: memory.confidence,
        lastVerifiedAt: memory.lastVerifiedAt,
        createdAt: memory.createdAt,
      },
    }));
}

async function searchInteractionGraphResults(input: {
  userId: string;
  query: string;
  limit: number;
}): Promise<UnifiedMemorySearchResult[]> {
  const { searchInteractionGraph } = await import("@/lib/interactions/graph");
  const results = await searchInteractionGraph({
    userId: input.userId,
    query: input.query,
    limit: input.limit,
  });
  return results.map((result) => ({
    type: "graph" as const,
    id: result.relation.id,
    content: result.content,
    similarity: result.score,
    metadata: {
      sourceSemantics: "derived_index",
      source: "memory_graph",
      relationType: result.relation.relationType,
      subject: {
        id: result.subject.id,
        name: result.subject.name,
        entityType: result.subject.entityType,
      },
      object: {
        id: result.object.id,
        name: result.object.name,
        entityType: result.object.entityType,
      },
      evidence: result.evidence.map((item) => ({
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        eventId: item.eventId,
      })),
      confidence: result.relation.confidence,
      evidenceStrength: result.relation.evidenceStrength,
      updatedAt: result.relation.updatedAt,
    },
  }));
}

function hasEmbeddingProviderConfig(authToken?: string): boolean {
  if (process.env.EMBEDDING_PROVIDER?.trim().toLowerCase() === "local") {
    return true;
  }
  return Boolean(
    authToken ||
    process.env.OPENAI_EMBEDDINGS_API_KEY ||
    process.env.DASHSCOPE_API_KEY ||
    process.env.BAILIAN_API_KEY ||
    process.env.ALIBABA_CLOUD_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    process.env.LLM_API_KEY,
  );
}

async function embedQuery(
  query: string,
  authToken?: string,
): Promise<number[]> {
  if (!hasEmbeddingProviderConfig(authToken)) {
    throw new Error("Embedding provider API key is not configured");
  }

  const { UniversalEmbeddings } =
    await import("@openzhiyu/rag/universal-embeddings");
  const embeddings = new UniversalEmbeddings(authToken);
  return embeddings.embedQuery(query);
}

function extractSearchTerms(query: string): string[] {
  const normalized = query.toLowerCase().normalize("NFKC");
  const latin = normalized.match(/[a-z0-9_]{2,}/g) ?? [];
  const hanRuns = normalized.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  const chinese: string[] = [];
  for (const run of hanRuns) {
    const chars = [...run];
    for (const size of [2, 3, 4]) {
      for (let index = 0; index <= chars.length - size; index += 1) {
        chinese.push(chars.slice(index, index + size).join(""));
      }
    }
  }
  return Array.from(new Set([...latin, ...chinese])).slice(0, 24);
}

function scoreBrainMemorySearch(input: {
  memory: BrainMemory;
  query: string;
}): number {
  const terms = extractSearchTerms(input.query);
  const haystack = [
    input.memory.memoryType,
    input.memory.subject,
    input.memory.content,
    ...(input.memory.tags ?? []),
  ]
    .join(" ")
    .toLowerCase();
  const normalizedQuery = input.query.trim().toLowerCase();
  const exactQueryMatch =
    normalizedQuery.length >= 2 && haystack.includes(normalizedQuery) ? 1 : 0;
  const matchedTerms = terms.filter((term) => haystack.includes(term)).length;
  const relevance =
    terms.length > 0 ? matchedTerms / terms.length : exactQueryMatch;
  const confidence = Math.min(100, Math.max(0, input.memory.confidence)) / 100;
  const statusBonus =
    input.memory.status === "verified"
      ? 0.08
      : input.memory.status === "active"
        ? 0.04
        : input.memory.status === "weakened"
          ? -0.08
          : 0;
  const typeBonus =
    input.memory.memoryType === "boundary"
      ? 0.06
      : input.memory.memoryType === "plan"
        ? 0.04
        : 0;

  return Math.min(
    1,
    Math.max(0, relevance * 0.5 + confidence * 0.42 + statusBonus + typeBonus),
  );
}

async function searchBrainMemoryResults(input: {
  userId: string;
  query: string;
  limit: number;
  threshold: number;
}): Promise<{
  results: UnifiedMemorySearchResult[];
  contextTrace: BrainContextTraceSummary;
}> {
  const {
    buildBrainContextPack,
    listBrainMemoriesForUser,
    summarizeBrainContextPackForTrace,
  } = await import("@/lib/brain");
  const memories = await listBrainMemoriesForUser({
    userId: input.userId,
    limit: Math.max(input.limit * 8, 80),
    statuses: ["active", "verified", "weakened"],
    searchTerms: extractSearchTerms(input.query),
    reserveRevisions: true,
    includePendingUpdates: true,
  });
  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
  const pack = buildBrainContextPack({
    memories,
    requester: {
      type: "chat",
      userId: input.userId,
      id: "unified-memory-search",
    },
    accessMode: "owner_override",
    taskIntent: input.query,
    maxItems: Math.max(input.limit * 4, 20),
  });

  const results: UnifiedMemorySearchResult[] = [];
  for (const item of pack.items) {
    const memory = memoryById.get(item.id);
    if (!memory) continue;
    const similarity = scoreBrainMemorySearch({
      memory,
      query: input.query,
    });
    if (similarity < input.threshold) continue;
    results.push({
      type: "memory",
      id: memory.id,
      content: `${memory.subject}: ${memory.content}`,
      similarity,
      metadata: {
        sourceSemantics: "canonical_context_candidate",
        source: "brain_memory",
        memoryType: memory.memoryType,
        subject: memory.subject,
        status: memory.status,
        scope: memory.scope,
        ownerType: memory.ownerType,
        ownerId: memory.ownerId,
        confidence: memory.confidence,
        evidenceRefs: memory.evidenceRefs,
        tags: memory.tags ?? [],
        createdAt: memory.createdAt,
        updatedAt: memory.updatedAt,
        pendingMemoryUpdate: memory.metadata?.pendingMemoryUpdate ?? null,
        warnings: item.warnings ?? [],
      },
    });
  }

  return {
    results: results
      .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id))
      .slice(0, input.limit),
    contextTrace: summarizeBrainContextPackForTrace(pack),
  };
}

export async function searchUnifiedMemory(
  input: UnifiedMemorySearchInput,
): Promise<UnifiedMemorySearchOutput> {
  const query = input.query.trim();
  const sources = normalizeUnifiedMemorySearchSources(input.sources);
  const limit = clampUnifiedMemorySearchLimit(input.limit);
  const threshold = clampUnifiedMemorySearchThreshold(input.threshold);
  const warnings: UnifiedMemorySearchWarning[] = [];
  const results: UnifiedMemorySearchResult[] = [];
  let contextTrace: BrainContextTraceSummary | undefined;
  let queryEmbeddingPromise: Promise<number[]> | undefined;

  if (!query) {
    return {
      query,
      sources,
      resultKind: getUnifiedMemoryResultKind(sources),
      sourceSemantics: SOURCE_SEMANTICS,
      sourceStatuses: emptySourceStatuses(sources),
      results: [],
      count: 0,
      warnings: sortWarningsBySourceOrder(warnings, sources),
    };
  }

  const getQueryEmbedding = () => {
    queryEmbeddingPromise ??= embedQuery(query, input.authToken);
    return queryEmbeddingPromise;
  };

  const searchTasks: Array<Promise<SourceSearchResult>> = [];

  if (sources.includes("memory")) {
    searchTasks.push(
      runSourceSearch("memory", async (sourceWarnings) => {
        let brainResults: UnifiedMemorySearchResult[] = [];
        try {
          const brainSearch = await searchBrainMemoryResults({
            userId: input.userId,
            query,
            limit,
            threshold,
          });
          brainResults = brainSearch.results;
          contextTrace = brainSearch.contextTrace;
        } catch (error) {
          sourceWarnings.push({
            source: "memory",
            code: "brain_memory_unavailable",
            message:
              error instanceof Error
                ? error.message
                : "Brain memory search is not available.",
          });
        }

        return brainResults;
      }),
    );
  }

  if (sources.includes("insights")) {
    searchTasks.push(
      runSourceSearch("insights", async (sourceWarnings) => {
        try {
          const insightResults = await searchInsightsSemantically({
            userId: input.userId,
            query,
            queryEmbedding: await getQueryEmbedding(),
            limit,
            threshold,
            botIds: input.botIds,
            includeArchived: input.includeArchivedInsights,
            authToken: input.authToken,
          });
          return insightResults.map((result) => ({
            ...result,
            metadata: {
              ...result.metadata,
              sourceSemantics: "legacy_discovery",
            },
          }));
        } catch (error) {
          sourceWarnings.push({
            source: "insights",
            code: "insight_semantic_unavailable",
            message: getErrorMessage(
              error,
              "Insight semantic search is not available.",
            ),
          });
          return [];
        }
      }),
    );
  }

  if (sources.includes("knowledge")) {
    searchTasks.push(
      runSourceSearch("knowledge", async (sourceWarnings) => {
        try {
          const knowledgeResults = await searchSimilarChunks(
            input.userId,
            query,
            {
              limit,
              threshold,
              documentIds: input.documentIds,
              queryEmbedding: await getQueryEmbedding(),
            },
            input.authToken,
          );
          return knowledgeResults.map(toKnowledgeResult);
        } catch (error) {
          sourceWarnings.push({
            source: "knowledge",
            code: "knowledge_semantic_unavailable",
            message: getErrorMessage(
              error,
              "Knowledge semantic search is not available.",
            ),
          });
          return [];
        }
      }),
    );
  }

  if (sources.includes("interactions")) {
    searchTasks.push(
      runSourceSearch("interactions", async (sourceWarnings) => {
        try {
          return await searchConfirmedInteractionMemories({
            userId: input.userId,
            query,
            limit,
            threshold,
          });
        } catch (error) {
          sourceWarnings.push({
            source: "interactions",
            code: "interaction_memory_unavailable",
            message: getErrorMessage(
              error,
              "Interaction memory search is not available.",
            ),
          });
          return [];
        }
      }),
    );
  }

  if (sources.includes("graph")) {
    searchTasks.push(
      runSourceSearch("graph", async (sourceWarnings) => {
        try {
          return await searchInteractionGraphResults({
            userId: input.userId,
            query,
            limit,
          });
        } catch (error) {
          sourceWarnings.push({
            source: "graph",
            code: "memory_graph_unavailable",
            message:
              error instanceof Error
                ? error.message
                : "Memory graph search is not available.",
          });
          return [];
        }
      }),
    );
  }

  const sourceResults = await Promise.all(searchTasks);
  warnings.push(...sourceResults.flatMap((result) => result.warnings));
  results.push(...sourceResults.flatMap((result) => result.results));

  const merged = mergeUnifiedMemorySearchResults(results, limit);
  return {
    query,
    sources,
    resultKind: getUnifiedMemoryResultKind(sources),
    sourceSemantics: SOURCE_SEMANTICS,
    sourceStatuses: buildSourceStatuses(sources, sourceResults),
    contextTrace,
    results: merged,
    count: merged.length,
    warnings: sortWarningsBySourceOrder(warnings, sources),
  };
}
