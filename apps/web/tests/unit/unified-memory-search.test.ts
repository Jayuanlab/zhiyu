import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getRawMessageManagerMock,
  isRawMessageStorageAvailableMock,
  queryMessagesMock,
  isRawMessageChromaEnabledMock,
  searchRawMessagesWithChromaMock,
  searchInsightsSemanticallyMock,
  searchMessagesSemanticallyMock,
  searchSimilarChunksMock,
  searchInteractionMemoriesMock,
  searchInteractionGraphMock,
  listBrainMemoriesForUserMock,
  universalEmbedQueryMock,
} = vi.hoisted(() => ({
  getRawMessageManagerMock: vi.fn(),
  isRawMessageStorageAvailableMock: vi.fn(),
  queryMessagesMock: vi.fn(),
  isRawMessageChromaEnabledMock: vi.fn(),
  searchRawMessagesWithChromaMock: vi.fn(),
  searchInsightsSemanticallyMock: vi.fn(),
  searchMessagesSemanticallyMock: vi.fn(),
  searchSimilarChunksMock: vi.fn(),
  searchInteractionMemoriesMock: vi.fn(),
  searchInteractionGraphMock: vi.fn(),
  listBrainMemoriesForUserMock: vi.fn(),
  universalEmbedQueryMock: vi.fn(),
}));

vi.mock("@/lib/memory/raw-message-store", () => ({
  getRawMessageManager: getRawMessageManagerMock,
  isRawMessageStorageAvailable: isRawMessageStorageAvailableMock,
}));

vi.mock("@/lib/memory/chroma-memory-index", () => ({
  isRawMessageChromaEnabled: isRawMessageChromaEnabledMock,
  searchRawMessagesWithChroma: searchRawMessagesWithChromaMock,
}));

vi.mock("@openzhiyu/rag/universal-embeddings", () => ({
  UniversalEmbeddings: vi.fn().mockImplementation(function (this: {
    embedQuery: typeof universalEmbedQueryMock;
  }) {
    this.embedQuery = universalEmbedQueryMock;
  }),
}));

vi.mock("@/lib/insights/search", () => ({
  searchInsightsSemantically: searchInsightsSemanticallyMock,
}));

vi.mock("@/lib/ai/rag/langchain-service", () => ({
  searchSimilarChunks: searchSimilarChunksMock,
}));

vi.mock("@/lib/interactions/service", () => ({
  searchInteractionMemories: searchInteractionMemoriesMock,
}));

vi.mock("@/lib/interactions/graph", () => ({
  searchInteractionGraph: searchInteractionGraphMock,
}));

vi.mock("@/lib/brain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/brain")>();
  return {
    ...actual,
    listBrainMemoriesForUser: listBrainMemoriesForUserMock,
  };
});

import {
  clampUnifiedMemorySearchLimit,
  clampUnifiedMemorySearchThreshold,
  mergeUnifiedMemorySearchResults,
  normalizeUnifiedMemorySearchSources,
  searchUnifiedMemory,
  type UnifiedMemorySearchResult,
} from "@/lib/memory/unified-search";

describe("unified memory search", () => {
  beforeEach(() => {
    getRawMessageManagerMock.mockReset();
    isRawMessageStorageAvailableMock.mockReset();
    queryMessagesMock.mockReset();
    isRawMessageChromaEnabledMock.mockReset();
    searchRawMessagesWithChromaMock.mockReset();
    searchInsightsSemanticallyMock.mockReset();
    searchMessagesSemanticallyMock.mockReset();
    searchSimilarChunksMock.mockReset();
    searchInteractionMemoriesMock.mockReset();
    searchInteractionGraphMock.mockReset();
    listBrainMemoriesForUserMock.mockReset();
    universalEmbedQueryMock.mockReset();

    isRawMessageStorageAvailableMock.mockReturnValue(false);
    getRawMessageManagerMock.mockResolvedValue({
      queryMessages: queryMessagesMock,
      searchMessagesSemantically: searchMessagesSemanticallyMock,
    });
    queryMessagesMock.mockResolvedValue([]);
    isRawMessageChromaEnabledMock.mockReturnValue(false);
    searchRawMessagesWithChromaMock.mockResolvedValue([]);
    searchInsightsSemanticallyMock.mockResolvedValue([]);
    searchMessagesSemanticallyMock.mockResolvedValue([]);
    searchSimilarChunksMock.mockResolvedValue([]);
    searchInteractionMemoriesMock.mockResolvedValue([]);
    searchInteractionGraphMock.mockResolvedValue([]);
    listBrainMemoriesForUserMock.mockResolvedValue([]);
    universalEmbedQueryMock.mockResolvedValue([0.1, 0.2]);
    delete process.env.OPENAI_EMBEDDINGS_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.BAILIAN_API_KEY;
    delete process.env.ALIBABA_CLOUD_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.LLM_API_KEY;
    process.env.RAW_MESSAGE_VECTOR_STORE_BACKEND = undefined;
    process.env.MEMORY_VECTOR_STORE_BACKEND = undefined;
    process.env.VECTOR_STORE_BACKEND = undefined;
  });

  it("normalizes sources and clamps numeric options", () => {
    expect(normalizeUnifiedMemorySearchSources(undefined)).toEqual([
      "memory",
    ]);
    expect(
      normalizeUnifiedMemorySearchSources([
        "insights",
        "unknown",
        "knowledge",
        "insights",
      ]),
    ).toEqual(["insights", "knowledge"]);
    expect(clampUnifiedMemorySearchLimit(1000)).toBe(50);
    expect(clampUnifiedMemorySearchLimit("0")).toBe(1);
    expect(clampUnifiedMemorySearchThreshold(2)).toBe(1);
    expect(clampUnifiedMemorySearchThreshold("-2")).toBe(-1);
  });

  it("merges results by similarity with stable tie breaking", () => {
    const results: UnifiedMemorySearchResult[] = [
      {
        type: "knowledge",
        id: "k1",
        content: "knowledge",
        similarity: 0.8,
        metadata: {},
      },
      {
        type: "insight",
        id: "i1",
        content: "insight",
        similarity: 0.9,
        metadata: {},
      },
      {
        type: "memory",
        id: "m1",
        content: "memory",
        similarity: 0.8,
        metadata: {},
      },
    ];

    expect(
      mergeUnifiedMemorySearchResults(results, 2).map(
        (result) => `${result.type}:${result.id}`,
      ),
    ).toEqual(["insight:i1", "knowledge:k1"]);
  });

  it("searches insights, knowledge, confirmed interaction memories, and graph context", async () => {
    searchInsightsSemanticallyMock.mockResolvedValue([
      {
        type: "insight",
        id: "insight-1",
        content: "User liked project feedback",
        similarity: 0.91,
        metadata: {
          botId: "bot-1",
        },
      },
    ]);
    searchSimilarChunksMock.mockResolvedValue([
      {
        chunkId: "chunk-1",
        documentId: "doc-1",
        documentName: "Project.md",
        content: "Feedback notes",
        similarity: 0.86,
        chunkIndex: 2,
      },
    ]);
    searchInteractionMemoriesMock.mockResolvedValue([
      {
        memory: {
          id: "interaction-1",
          userId: "user-1",
          memoryType: "person",
          subject: "Alice",
          content: "Alice prefers project feedback before Friday standup",
          status: "confirmed",
          confidence: 88,
          tags: ["wechat", "feedback"],
          sourceEventIds: ["event-1"],
          lastVerifiedAt: null,
          expiresAt: null,
          metadata: {},
          createdAt: new Date("2026-07-08T01:00:00.000Z"),
          updatedAt: new Date("2026-07-08T01:00:00.000Z"),
        },
        score: 0.89,
      },
    ]);
    searchInteractionGraphMock.mockResolvedValue([
      {
        relation: {
          id: "relation-1",
          userId: "user-1",
          scope: "interaction",
          source: "interaction_processor",
          subjectEntityId: "entity-alice",
          objectEntityId: "entity-project",
          relationType: "commitment",
          claim: "Alice promised to send project feedback before Friday",
          claimHash: "hash",
          confidence: 82,
          evidenceStrength: "high",
          status: "active",
          metadata: {},
          firstSeenAt: new Date("2026-07-08T01:00:00.000Z"),
          lastSeenAt: new Date("2026-07-08T01:00:00.000Z"),
          createdAt: new Date("2026-07-08T01:00:00.000Z"),
          updatedAt: new Date("2026-07-08T01:00:00.000Z"),
        },
        subject: {
          id: "entity-alice",
          userId: "user-1",
          scope: "interaction",
          source: "interaction_processor",
          name: "Alice",
          normalizedName: "alice",
          entityType: "person",
          aliases: ["Alice"],
          description: null,
          metadata: {},
          firstSeenAt: new Date("2026-07-08T01:00:00.000Z"),
          lastSeenAt: new Date("2026-07-08T01:00:00.000Z"),
          createdAt: new Date("2026-07-08T01:00:00.000Z"),
          updatedAt: new Date("2026-07-08T01:00:00.000Z"),
        },
        object: {
          id: "entity-project",
          userId: "user-1",
          scope: "interaction",
          source: "interaction_processor",
          name: "Project",
          normalizedName: "project",
          entityType: "topic",
          aliases: ["Project"],
          description: null,
          metadata: {},
          firstSeenAt: new Date("2026-07-08T01:00:00.000Z"),
          lastSeenAt: new Date("2026-07-08T01:00:00.000Z"),
          createdAt: new Date("2026-07-08T01:00:00.000Z"),
          updatedAt: new Date("2026-07-08T01:00:00.000Z"),
        },
        evidence: [
          {
            id: "evidence-1",
            userId: "user-1",
            relationId: "relation-1",
            sourceType: "interaction_event",
            sourceId: "event-1",
            eventId: "event-1",
            quote: "before Friday",
            metadata: {},
            createdAt: new Date("2026-07-08T01:00:00.000Z"),
          },
        ],
        score: 0.88,
        content:
          "Alice -[commitment]-> Project\nAlice promised to send project feedback before Friday\n证据: event-1",
      },
    ]);

    const output = await searchUnifiedMemory({
      userId: "user-1",
      query: "project feedback",
      sources: ["memory", "insights", "knowledge", "interactions", "graph"],
      limit: 10,
      threshold: 0.7,
      authToken: "token",
      botIds: ["bot-1"],
      documentIds: ["doc-1"],
    });

    expect(searchInsightsSemanticallyMock).toHaveBeenCalledWith({
      userId: "user-1",
      query: "project feedback",
      queryEmbedding: [0.1, 0.2],
      limit: 10,
      threshold: 0.7,
      botIds: ["bot-1"],
      includeArchived: undefined,
      authToken: "token",
    });
    expect(searchSimilarChunksMock).toHaveBeenCalledWith(
      "user-1",
      "project feedback",
      {
        limit: 10,
        threshold: 0.7,
        documentIds: ["doc-1"],
        queryEmbedding: [0.1, 0.2],
      },
      "token",
    );
    expect(searchInteractionMemoriesMock).toHaveBeenCalledWith({
      userId: "user-1",
      query: "project feedback",
      limit: 10,
      statuses: ["confirmed"],
    });
    expect(searchInteractionGraphMock).toHaveBeenCalledWith({
      userId: "user-1",
      query: "project feedback",
      limit: 10,
    });
    expect(universalEmbedQueryMock).toHaveBeenCalledTimes(1);
    expect(output.results.map((result) => result.type)).toEqual([
      "insight",
      "interaction",
      "graph",
      "knowledge",
    ]);
    expect(output.resultKind).toBe("mixed_context");
    expect(output.sourceSemantics).toMatchObject({
      memory: "canonical_context_candidate",
      insights: "legacy_discovery",
      knowledge: "evidence_source",
      interactions: "legacy_discovery",
      graph: "derived_index",
    });
    expect(output.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "knowledge",
          metadata: expect.objectContaining({
            sourceSemantics: "evidence_source",
          }),
        }),
        expect.objectContaining({
          type: "graph",
          metadata: expect.objectContaining({
            sourceSemantics: "derived_index",
          }),
        }),
      ]),
    );
    expect(output.warnings).toEqual([]);
    expect(output.sourceStatuses).toEqual([
      expect.objectContaining({
        source: "memory",
        status: "ok",
        resultCount: 0,
        warningCount: 0,
        semantics: "canonical_context_candidate",
      }),
      expect.objectContaining({
        source: "insights",
        status: "ok",
        resultCount: 1,
        warningCount: 0,
        semantics: "legacy_discovery",
      }),
      expect.objectContaining({
        source: "knowledge",
        status: "ok",
        resultCount: 1,
        warningCount: 0,
        semantics: "evidence_source",
      }),
      expect.objectContaining({
        source: "interactions",
        status: "ok",
        resultCount: 1,
        warningCount: 0,
        semantics: "legacy_discovery",
      }),
      expect.objectContaining({
        source: "graph",
        status: "ok",
        resultCount: 1,
        warningCount: 0,
        semantics: "derived_index",
      }),
    ]);
  });

  it("does not return candidate interaction memories before owner confirmation", async () => {
    searchInteractionMemoriesMock.mockResolvedValue([
      {
        memory: {
          id: "interaction-confirmed",
          userId: "user-1",
          memoryType: "project",
          subject: "Phoenix",
          content: "Phoenix weekly update should include risk owners",
          status: "confirmed",
          confidence: 91,
          tags: ["wechat"],
          sourceEventIds: ["event-1"],
          lastVerifiedAt: null,
          expiresAt: null,
          metadata: {},
          createdAt: new Date("2026-07-08T01:00:00.000Z"),
          updatedAt: new Date("2026-07-08T01:00:00.000Z"),
        },
        score: 0.92,
      },
    ]);

    const output = await searchUnifiedMemory({
      userId: "user-1",
      query: "Phoenix risk owners",
      sources: ["interactions"],
      limit: 5,
      threshold: 0.35,
    });

    expect(searchInteractionMemoriesMock).toHaveBeenCalledWith({
      userId: "user-1",
      query: "Phoenix risk owners",
      limit: 5,
      statuses: ["confirmed"],
    });
    expect(output.results).toEqual([
      expect.objectContaining({
        type: "interaction",
        id: "interaction-confirmed",
        content: "Phoenix: Phoenix weekly update should include risk owners",
        metadata: expect.objectContaining({
          source: "interaction_memory",
          status: "confirmed",
          sourceEventIds: ["event-1"],
        }),
      }),
    ]);
  });

  it("keeps unified memory search usable when graph search is unavailable", async () => {
    searchInteractionGraphMock.mockRejectedValue(
      new Error("no such table: memory_graph_relations"),
    );

    const output = await searchUnifiedMemory({
      userId: "user-1",
      query: "Phoenix risk owners",
      sources: ["graph"],
      limit: 5,
      threshold: 0.35,
    });

    expect(searchInteractionGraphMock).toHaveBeenCalledWith({
      userId: "user-1",
      query: "Phoenix risk owners",
      limit: 5,
    });
    expect(output.results).toEqual([]);
    expect(output.warnings).toEqual([
      {
        source: "graph",
        code: "memory_graph_unavailable",
        message: "no such table: memory_graph_relations",
      },
    ]);
    expect(output.sourceStatuses).toEqual([
      expect.objectContaining({
        source: "graph",
        status: "unavailable",
        resultCount: 0,
        warningCount: 1,
      }),
    ]);
  });

  it("keeps unified memory search usable when legacy semantic sources fail", async () => {
    searchInsightsSemanticallyMock.mockRejectedValue(
      new Error("insight pgvector dimension mismatch"),
    );
    searchSimilarChunksMock.mockRejectedValue(
      new Error("rag pgvector dimension mismatch"),
    );
    searchInteractionMemoriesMock.mockRejectedValue(
      new Error("interaction memory table unavailable"),
    );

    const output = await searchUnifiedMemory({
      userId: "user-1",
      query: "project feedback",
      sources: ["insights", "knowledge", "interactions"],
      limit: 5,
      threshold: 0.35,
      authToken: "token",
    });

    expect(output.results).toEqual([]);
    expect(output.warnings).toEqual([
      {
        source: "insights",
        code: "insight_semantic_unavailable",
        message: "insight pgvector dimension mismatch",
      },
      {
        source: "knowledge",
        code: "knowledge_semantic_unavailable",
        message: "rag pgvector dimension mismatch",
      },
      {
        source: "interactions",
        code: "interaction_memory_unavailable",
        message: "interaction memory table unavailable",
      },
    ]);
    expect(output.sourceStatuses).toEqual([
      expect.objectContaining({
        source: "insights",
        status: "unavailable",
        resultCount: 0,
        warningCount: 1,
      }),
      expect.objectContaining({
        source: "knowledge",
        status: "unavailable",
        resultCount: 0,
        warningCount: 1,
      }),
      expect.objectContaining({
        source: "interactions",
        status: "unavailable",
        resultCount: 0,
        warningCount: 1,
      }),
    ]);
  });

  it("searches raw memory semantically without invoking legacy keyword lookup", async () => {
    isRawMessageStorageAvailableMock.mockReturnValue(true);
    searchMessagesSemanticallyMock.mockResolvedValue([
      {
        type: "memory",
        id: "message-1",
        content: "Raw project feedback",
        similarity: 0.93,
        metadata: {
          userId: "user-1",
          botId: "bot-1",
          platform: "slack",
        },
      },
    ]);

    const output = await searchUnifiedMemory({
      userId: "user-1",
      query: "project feedback",
      sources: ["memory"],
      limit: 5,
      threshold: 0.6,
      authToken: "token",
      includeLegacyMemory: true,
      botIds: ["bot-1"],
    });

    expect(universalEmbedQueryMock).toHaveBeenCalledWith("project feedback");
    expect(queryMessagesMock).not.toHaveBeenCalled();
    expect(searchMessagesSemanticallyMock).toHaveBeenCalledWith({
      userId: "user-1",
      queryEmbedding: [0.1, 0.2],
      limit: 5,
      threshold: 0.6,
      botId: "bot-1",
    });
    expect(output.warnings).toEqual([]);
    expect(output.results.map((result) => result.id)).toEqual(["message-1"]);
    expect(output.results[0]).toMatchObject({
      type: "memory",
      id: "message-1",
      content: "Raw project feedback",
      metadata: {
        userId: "user-1",
        botId: "bot-1",
        platform: "slack",
      },
    });
    expect(output.results[0]?.similarity).toBe(0.93);
  });

  it("uses reviewed Brain memories as the primary memory search source", async () => {
    listBrainMemoriesForUserMock.mockResolvedValue([
      {
        id: "brain-plan-1",
        userId: "user-1",
        scope: { type: "workshop", workshopId: "trader" },
        ownerType: "work",
        ownerId: "trader-work",
        memoryType: "plan",
        subject: "Alpha rotation plan",
        content: "Alpha contract risk should drive the next trading review.",
        status: "verified",
        confidence: 94,
        evidenceRefs: ["event-1"],
        tags: ["alpha", "trading"],
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T01:00:00.000Z",
      },
      {
        id: "brain-candidate-1",
        userId: "user-1",
        scope: { type: "workshop", workshopId: "trader" },
        ownerType: "work",
        ownerId: "trader-work",
        memoryType: "fact",
        subject: "Unreviewed note",
        content: "Alpha candidate should stay hidden.",
        status: "candidate",
        confidence: 99,
        evidenceRefs: [],
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T01:00:00.000Z",
      },
    ]);

    const output = await searchUnifiedMemory({
      userId: "user-1",
      query: "Alpha contract risk",
      sources: ["memory"],
      limit: 5,
      threshold: 0.7,
    });

    expect(listBrainMemoriesForUserMock).toHaveBeenCalledWith({
      userId: "user-1",
      limit: 80,
      statuses: ["active", "verified", "weakened"],
      searchTerms: ["alpha", "contract", "risk"],
    });
    expect(universalEmbedQueryMock).not.toHaveBeenCalled();
    expect(output.warnings).toEqual([]);
    expect(output.resultKind).toBe("canonical_context");
    expect(output.results).toEqual([
      expect.objectContaining({
        type: "memory",
        id: "brain-plan-1",
        content:
          "Alpha rotation plan: Alpha contract risk should drive the next trading review.",
        metadata: expect.objectContaining({
          source: "brain_memory",
          memoryType: "plan",
          status: "verified",
          confidence: 94,
          evidenceRefs: ["event-1"],
        }),
      }),
    ]);
    expect(output.contextTrace).toMatchObject({
      interfaceVersion: "brain-context-trace.v1",
      selection: expect.objectContaining({
        selectedCount: 1,
        deniedCount: 0,
      }),
      selected: [
        expect.objectContaining({
          id: "brain-plan-1",
          subject: "Alpha rotation plan",
          memoryType: "plan",
          evidenceRefCount: 1,
        }),
      ],
    });
  });

  it("keeps default memory search on canonical Brain without raw legacy fallback", async () => {
    isRawMessageStorageAvailableMock.mockReturnValue(true);
    listBrainMemoriesForUserMock.mockResolvedValue([]);
    searchMessagesSemanticallyMock.mockResolvedValue([
      {
        id: "raw-message-1",
        content: "Raw legacy result",
        similarity: 0.95,
        metadata: { sourceSemantics: "fallback_evidence" },
      },
    ]);

    const output = await searchUnifiedMemory({
      userId: "user-1",
      query: "legacy fallback should stay off",
      sources: ["memory"],
      limit: 5,
      threshold: 0.3,
      authToken: "token",
    });

    expect(universalEmbedQueryMock).not.toHaveBeenCalled();
    expect(searchMessagesSemanticallyMock).not.toHaveBeenCalled();
    expect(output.resultKind).toBe("canonical_context");
    expect(output.results).toEqual([]);
    expect(output.warnings).toEqual([]);
  });

  it("uses Bailian embedding config to activate raw memory semantic search", async () => {
    process.env.DASHSCOPE_API_KEY = "sk-test";
    isRawMessageStorageAvailableMock.mockReturnValue(true);
    searchMessagesSemanticallyMock.mockResolvedValue([
      {
        id: "message-bailian",
        content: "Bailian-backed semantic memory result",
        similarity: 0.91,
        metadata: {
          userId: "user-1",
          platform: "wechat",
          sourceSemantics: "fallback_evidence",
        },
      },
    ]);

    const output = await searchUnifiedMemory({
      userId: "user-1",
      query: "wechat project memory",
      sources: ["memory"],
      limit: 3,
      threshold: 0.5,
      includeLegacyMemory: true,
    });

    expect(universalEmbedQueryMock).toHaveBeenCalledWith(
      "wechat project memory",
    );
    expect(searchMessagesSemanticallyMock).toHaveBeenCalledWith({
      userId: "user-1",
      queryEmbedding: [0.1, 0.2],
      limit: 3,
      threshold: 0.5,
    });
    expect(output.results).toEqual([
      {
        type: "memory",
        id: "message-bailian",
        content: "Bailian-backed semantic memory result",
        similarity: 0.91,
        metadata: {
          userId: "user-1",
          platform: "wechat",
          sourceSemantics: "fallback_evidence",
        },
      },
    ]);
  });

  it("covers #71 cross-source semantic indexing across memory, insights, and knowledge", async () => {
    isRawMessageStorageAvailableMock.mockReturnValue(true);
    searchMessagesSemanticallyMock.mockImplementation(
      async (input: { botId?: string }) => {
        if (input.botId === "bot-a") {
          return [
            {
              id: "memory-a",
              content: "Raw memory: Alpha contract risk and core equipment",
              similarity: 0.94,
              metadata: {
                userId: "user-1",
                botId: "bot-a",
                platform: "feishu",
              },
            },
          ];
        }
        if (input.botId === "bot-b") {
          return [
            {
              id: "memory-b",
              content: "Raw memory: Beta project related follow-up",
              similarity: 0.72,
              metadata: {
                userId: "user-1",
                botId: "bot-b",
                platform: "slack",
              },
            },
          ];
        }
        return [];
      },
    );
    searchInsightsSemanticallyMock.mockResolvedValue([
      {
        type: "insight",
        id: "insight-top",
        content: "Insight: Alpha has highest delivery risk",
        similarity: 0.97,
        metadata: {
          botId: "bot-a",
          title: "Alpha risk",
        },
      },
      {
        type: "insight",
        id: "insight-low",
        content: "Insight: low score should lose the global top-N cutoff",
        similarity: 0.65,
        metadata: {
          botId: "bot-b",
          title: "Low score",
        },
      },
    ]);
    searchSimilarChunksMock.mockResolvedValue([
      {
        chunkId: "chunk-alpha",
        documentId: "doc-alpha",
        documentName: "Alpha.md",
        content: "Knowledge: Alpha core equipment list",
        similarity: 0.91,
        chunkIndex: 3,
      },
    ]);

    const output = await searchUnifiedMemory({
      userId: "user-1",
      query: "Alpha contract risk and core equipment",
      sources: ["memory", "insights", "knowledge"],
      limit: 4,
      threshold: 0.6,
      authToken: "token",
      includeLegacyMemory: true,
      botIds: ["bot-a", "bot-b"],
      documentIds: ["doc-alpha"],
    });

    expect(universalEmbedQueryMock).toHaveBeenCalledWith(
      "Alpha contract risk and core equipment",
    );
    expect(searchMessagesSemanticallyMock).toHaveBeenCalledTimes(2);
    expect(searchMessagesSemanticallyMock).toHaveBeenNthCalledWith(1, {
      userId: "user-1",
      queryEmbedding: [0.1, 0.2],
      limit: 4,
      threshold: 0.6,
      botId: "bot-a",
    });
    expect(searchMessagesSemanticallyMock).toHaveBeenNthCalledWith(2, {
      userId: "user-1",
      queryEmbedding: [0.1, 0.2],
      limit: 4,
      threshold: 0.6,
      botId: "bot-b",
    });
    expect(queryMessagesMock).not.toHaveBeenCalled();
    expect(searchInsightsSemanticallyMock).toHaveBeenCalledWith({
      userId: "user-1",
      query: "Alpha contract risk and core equipment",
      queryEmbedding: [0.1, 0.2],
      limit: 4,
      threshold: 0.6,
      botIds: ["bot-a", "bot-b"],
      includeArchived: undefined,
      authToken: "token",
    });
    expect(searchSimilarChunksMock).toHaveBeenCalledWith(
      "user-1",
      "Alpha contract risk and core equipment",
      {
        limit: 4,
        threshold: 0.6,
        documentIds: ["doc-alpha"],
        queryEmbedding: [0.1, 0.2],
      },
      "token",
    );
    expect(universalEmbedQueryMock).toHaveBeenCalledTimes(1);

    // This is the important #71 behavior: three isolated sources come back
    // through one semantic result contract and are globally ranked by score.
    expect(output).toMatchObject({
      query: "Alpha contract risk and core equipment",
      sources: ["memory", "insights", "knowledge"],
      count: 4,
      warnings: [],
    });
    expect(
      output.results.map((result) => `${result.type}:${result.id}`),
    ).toEqual([
      "insight:insight-top",
      "memory:memory-a",
      "knowledge:chunk-alpha",
      "memory:memory-b",
    ]);
    expect(output.results[2]).toMatchObject({
      type: "knowledge",
      id: "chunk-alpha",
      metadata: {
        documentId: "doc-alpha",
        documentName: "Alpha.md",
        chunkIndex: 3,
      },
    });
  });

  it("does not use database semantic fallback when Chroma returns no matches", async () => {
    isRawMessageStorageAvailableMock.mockReturnValue(true);
    isRawMessageChromaEnabledMock.mockReturnValue(true);
    process.env.RAW_MESSAGE_VECTOR_STORE_BACKEND = "chroma";

    const output = await searchUnifiedMemory({
      userId: "user-1",
      query: "no chroma match",
      sources: ["memory"],
      limit: 5,
      threshold: 0.7,
      authToken: "token",
      includeLegacyMemory: true,
    });

    expect(searchRawMessagesWithChromaMock).toHaveBeenCalledWith({
      userId: "user-1",
      queryEmbedding: [0.1, 0.2],
      limit: 5,
      threshold: 0.7,
      botId: undefined,
    });
    expect(searchMessagesSemanticallyMock).not.toHaveBeenCalled();
    expect(output.results).toEqual([]);
  });

  it("falls back to database semantic search when Chroma raw memory search fails", async () => {
    isRawMessageStorageAvailableMock.mockReturnValue(true);
    isRawMessageChromaEnabledMock.mockReturnValue(true);
    process.env.RAW_MESSAGE_VECTOR_STORE_BACKEND = "chroma";
    searchRawMessagesWithChromaMock.mockRejectedValue(
      new Error("Chroma temporarily unavailable"),
    );
    searchMessagesSemanticallyMock.mockResolvedValue([
      {
        id: "db-semantic-memory",
        content: "Database vector fallback result",
        similarity: 0.88,
        metadata: {
          userId: "user-1",
          botId: "bot-1",
          sourceSemantics: "fallback_evidence",
        },
      },
    ]);

    const output = await searchUnifiedMemory({
      userId: "user-1",
      query: "fallback memory",
      sources: ["memory"],
      limit: 5,
      threshold: 0.7,
      authToken: "token",
      includeLegacyMemory: true,
      botIds: ["bot-1"],
    });

    expect(searchRawMessagesWithChromaMock).toHaveBeenCalledWith({
      userId: "user-1",
      queryEmbedding: [0.1, 0.2],
      limit: 5,
      threshold: 0.7,
      botId: "bot-1",
    });
    expect(searchMessagesSemanticallyMock).toHaveBeenCalledWith({
      userId: "user-1",
      queryEmbedding: [0.1, 0.2],
      limit: 5,
      threshold: 0.7,
      botId: "bot-1",
    });
    expect(output.results).toEqual([
      {
        type: "memory",
        id: "db-semantic-memory",
        content: "Database vector fallback result",
        similarity: 0.88,
        metadata: {
          userId: "user-1",
          botId: "bot-1",
          sourceSemantics: "fallback_evidence",
        },
      },
    ]);
  });

  it("keeps Brain memory results when raw message semantic search is unavailable", async () => {
    isRawMessageStorageAvailableMock.mockReturnValue(true);
    searchMessagesSemanticallyMock.mockRejectedValue(
      new Error('type "vector" does not exist'),
    );
    listBrainMemoriesForUserMock.mockResolvedValue([
      {
        id: "brain-plan-1",
        userId: "user-1",
        scope: { type: "global" },
        ownerType: "chat",
        ownerId: "user-1",
        memoryType: "plan",
        subject: "Alpha plan",
        content: "Alpha risk review should continue.",
        status: "verified",
        confidence: 95,
        evidenceRefs: [],
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T01:00:00.000Z",
      },
    ]);

    const output = await searchUnifiedMemory({
      userId: "user-1",
      query: "Alpha risk review",
      sources: ["memory"],
      limit: 5,
      threshold: 0.3,
      authToken: "token",
      includeLegacyMemory: true,
    });

    expect(output.results.map((result) => result.id)).toEqual(["brain-plan-1"]);
    expect(output.warnings).toEqual([
      {
        source: "memory",
        code: "raw_message_semantic_unavailable",
        message:
          "Raw message semantic search is unavailable because the vector extension is not enabled.",
      },
    ]);
    expect(output.sourceStatuses).toEqual([
      expect.objectContaining({
        source: "memory",
        status: "degraded",
        resultCount: 1,
        warningCount: 1,
      }),
    ]);
  });
});
