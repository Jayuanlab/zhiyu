import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  clearInteractionGraphMock,
  clearInteractionWikiItemsMock,
  getInteractionEventsByIdsMock,
  listInteractionEventsMock,
  listInteractionGraphSnapshotMock,
  listInteractionWikiMock,
  processInteractionEventsMock,
  insertBrainMemoryReviewMock,
  upsertBrainMemoryMock,
  updateInteractionMemoryStatusMock,
  updateInteractionTaskStatusMock,
} = vi.hoisted(() => ({
  clearInteractionGraphMock: vi.fn(),
  clearInteractionWikiItemsMock: vi.fn(),
  getInteractionEventsByIdsMock: vi.fn(),
  listInteractionEventsMock: vi.fn(),
  listInteractionGraphSnapshotMock: vi.fn(),
  listInteractionWikiMock: vi.fn(),
  processInteractionEventsMock: vi.fn(),
  insertBrainMemoryReviewMock: vi.fn(),
  upsertBrainMemoryMock: vi.fn(),
  updateInteractionMemoryStatusMock: vi.fn(),
  updateInteractionTaskStatusMock: vi.fn(),
}));

vi.mock("@/lib/interactions/service", () => ({
  clearInteractionWikiItems: clearInteractionWikiItemsMock,
  getInteractionEventsByIds: getInteractionEventsByIdsMock,
  listInteractionEvents: listInteractionEventsMock,
  listInteractionWiki: listInteractionWikiMock,
  updateInteractionMemoryStatus: updateInteractionMemoryStatusMock,
  updateInteractionTaskStatus: updateInteractionTaskStatusMock,
}));

vi.mock("@/lib/interactions/processor", () => ({
  processInteractionEvents: processInteractionEventsMock,
}));

vi.mock("@/lib/interactions/graph", () => ({
  clearInteractionGraph: clearInteractionGraphMock,
  listInteractionGraphSnapshot: listInteractionGraphSnapshotMock,
}));

vi.mock("@/lib/memory/revision/legacy-storage", () => ({
  insertBrainMemoryReview: insertBrainMemoryReviewMock,
  upsertBrainMemory: upsertBrainMemoryMock,
}));

import {
  getOwnerContext,
  getOwnerContextEvidence,
  listOwnerContextCandidates,
  listOwnerKnowledge,
  processOwnerContextMessages,
  resetOwnerKnowledge,
  reviewOwnerContextCandidate,
} from "@/lib/owner-context/service";

describe("owner context service", () => {
  beforeEach(() => {
    listInteractionWikiMock.mockReset();
    listInteractionEventsMock.mockReset();
    listInteractionGraphSnapshotMock.mockReset();
    clearInteractionGraphMock.mockReset();
    clearInteractionWikiItemsMock.mockReset();
    getInteractionEventsByIdsMock.mockReset();
    processInteractionEventsMock.mockReset();
    insertBrainMemoryReviewMock.mockReset();
    upsertBrainMemoryMock.mockReset();
    updateInteractionMemoryStatusMock.mockReset();
    updateInteractionTaskStatusMock.mockReset();

    listInteractionWikiMock.mockResolvedValue({
      notes: [
        {
          id: "note-1",
          title: "Project background",
          body: "Alice asked for the first proposal on Friday.",
          confidence: 80,
          sourceEventIds: ["event-1"],
          metadata: { generatedBy: "llm" },
          createdAt: "2026-07-28T01:00:00.000Z",
        },
      ],
      tasks: [
        {
          id: "task-1",
          title: "Send proposal to Alice",
          description: "Send the first draft before Friday.",
          status: "candidate",
          confidence: 75,
          sourceEventIds: ["event-1"],
          createdAt: "2026-07-28T01:05:00.000Z",
        },
      ],
      memories: [
        {
          id: "memory-1",
          memoryType: "person",
          subject: "Alice",
          content: "Alice prefers structured proposals first.",
          status: "confirmed",
          confidence: 90,
          tags: ["preference"],
          sourceEventIds: ["event-1"],
          createdAt: "2026-07-28T01:10:00.000Z",
        },
        {
          id: "memory-2",
          memoryType: "project",
          subject: "Owner Context",
          content: "WeChat messages should become workspace context.",
          status: "candidate",
          confidence: 70,
          tags: ["product"],
          sourceEventIds: ["event-2"],
          createdAt: "2026-07-28T01:20:00.000Z",
        },
      ],
    });
    listInteractionEventsMock.mockResolvedValue([
      {
        id: "event-1",
        platform: "wechat",
        conversationId: "wx-1",
        conversationName: "Alice",
        conversationType: "person",
        senderName: "Alice",
        contentPreview: "Please send the proposal before Friday.",
        messageTime: "2026-07-28T00:58:00.000Z",
        collectedAt: "2026-07-28T01:00:00.000Z",
        processedStatus: "processed",
        importance: "high",
      },
    ]);
    listInteractionGraphSnapshotMock.mockResolvedValue({
      entities: [
        {
          id: "entity-1",
          name: "Alice",
          entityType: "person",
          aliases: [],
          firstSeenAt: "2026-07-28T00:58:00.000Z",
          lastSeenAt: "2026-07-28T01:00:00.000Z",
        },
        {
          id: "entity-2",
          name: "Owner Context",
          entityType: "project",
          aliases: [],
          firstSeenAt: "2026-07-28T00:58:00.000Z",
          lastSeenAt: "2026-07-28T01:00:00.000Z",
        },
      ],
      relations: [
        {
          id: "relation-1",
          relationType: "asked_for",
          claim: "Alice asked for the proposal by Friday.",
          confidence: 85,
          status: "active",
          firstSeenAt: "2026-07-28T00:58:00.000Z",
          updatedAt: "2026-07-28T01:00:00.000Z",
        },
      ],
      evidence: [],
      stats: {
        entityCount: 2,
        relationCount: 1,
        activeRelationCount: 1,
        evidenceCount: 0,
      },
    });
    clearInteractionWikiItemsMock.mockResolvedValue({
      deletedNotes: 1,
      deletedTasks: 1,
      deletedMemories: 2,
      deletedCount: 4,
    });
    clearInteractionGraphMock.mockResolvedValue({
      deletedGraphEntities: 2,
      deletedGraphRelations: 1,
      deletedGraphEvidence: 3,
      deletedGraphCount: 6,
    });
    updateInteractionTaskStatusMock.mockResolvedValue({
      id: "task-1",
      title: "Send proposal to Alice",
      description: "Send the first draft before Friday.",
      status: "confirmed",
      confidence: 75,
      sourceEventIds: ["event-1"],
      createdAt: "2026-07-28T01:05:00.000Z",
    });
    updateInteractionMemoryStatusMock.mockResolvedValue({
      id: "memory-2",
      memoryType: "project",
      subject: "Owner Context",
      content: "WeChat messages should become workspace context.",
      status: "dismissed",
      confidence: 70,
      tags: ["product"],
      sourceEventIds: ["event-2"],
      createdAt: "2026-07-28T01:20:00.000Z",
    });
    processInteractionEventsMock.mockResolvedValue({
      mode: "llm",
      processedEventIds: ["event-1"],
      notes: [],
      tasks: [],
      memories: [],
    });
    getInteractionEventsByIdsMock.mockResolvedValue([
      {
        id: "event-1",
        conversationName: "Alice",
        contentPreview: "Please send the proposal before Friday.",
      },
    ]);
    upsertBrainMemoryMock.mockResolvedValue({});
    insertBrainMemoryReviewMock.mockResolvedValue({});
  });

  it("projects legacy interaction data into owner context", async () => {
    const context = await getOwnerContext({
      userId: "user-1",
      scene: "workshop",
      maxItems: 50,
    });

    expect(context.scene).toBe("workshop");
    expect(context.stats.confirmedMemoryCount).toBe(1);
    expect(context.confirmedMemories).toHaveLength(1);
    expect(context.confirmedMemories[0]?.title).toBe("Alice");
    expect(context.candidates.map((item) => item.id)).toEqual([
      "memory-2",
      "task-1",
    ]);
    expect(context.conversations[0]).toMatchObject({
      conversationId: "wx-1",
      conversationName: "Alice",
      messageCount: 1,
    });
    expect(context.graph.people[0]?.title).toBe("Alice");
    expect(context.graph.projects[0]?.title).toBe("Owner Context");
  });

  it("returns a dashboard with a stable interface version", async () => {
    const dashboard = await listOwnerKnowledge({
      userId: "user-1",
      limit: 20,
    });

    expect(dashboard.interfaceVersion).toBe("owner-context.v1");
    expect(dashboard.stats.rawEventCount).toBe(1);
  });

  it("lists owner context candidates for workshop review", async () => {
    listInteractionWikiMock.mockResolvedValueOnce({
      notes: [],
      tasks: [
        {
          id: "task-1",
          title: "Send proposal to Alice",
          description: "Send the first draft before Friday.",
          status: "candidate",
          confidence: 75,
          sourceEventIds: ["event-1"],
          createdAt: "2026-07-28T01:05:00.000Z",
        },
      ],
      memories: [
        {
          id: "memory-2",
          memoryType: "project",
          subject: "Owner Context",
          content: "WeChat messages should become workspace context.",
          status: "candidate",
          confidence: 70,
          tags: ["product"],
          sourceEventIds: ["event-2"],
          createdAt: "2026-07-28T01:20:00.000Z",
        },
      ],
    });

    const result = await listOwnerContextCandidates({
      userId: "user-1",
      limit: 20,
    });

    expect(listInteractionWikiMock).toHaveBeenCalledWith({
      userId: "user-1",
      limit: 20,
      statuses: ["candidate"],
    });
    expect(result.stats).toMatchObject({
      taskCount: 1,
      memoryCount: 1,
      totalCount: 2,
    });
  });

  it("reviews task and memory candidates through the adapter", async () => {
    await expect(
      reviewOwnerContextCandidate({
        userId: "user-1",
        kind: "task",
        id: "task-1",
        decision: "confirmed",
      }),
    ).resolves.toMatchObject({
      kind: "task",
      decision: "confirmed",
      item: { id: "task-1", state: "confirmed" },
    });
    expect(updateInteractionTaskStatusMock).toHaveBeenCalledWith({
      userId: "user-1",
      id: "task-1",
      status: "confirmed",
    });
    expect(upsertBrainMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "legacy-interaction-task:task-1",
        userId: "user-1",
        scope: { type: "global" },
        ownerType: "chat",
        ownerId: "user-1",
        memoryType: "task",
        status: "verified",
        subject: "Send proposal to Alice",
        evidenceRefs: ["event-1"],
      }),
    );
    expect(insertBrainMemoryReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        memoryId: "legacy-interaction-task:task-1",
        reviewerType: "chat",
        reviewerId: "user-1",
        decision: "confirmed",
        evidenceRefs: ["event-1"],
        metadata: expect.objectContaining({
          source: "owner_context_review",
          legacyKind: "task",
          legacyId: "task-1",
        }),
      }),
    );

    await expect(
      reviewOwnerContextCandidate({
        userId: "user-1",
        kind: "memory",
        id: "memory-2",
        decision: "dismissed",
      }),
    ).resolves.toMatchObject({
      kind: "memory",
      decision: "dismissed",
      item: { id: "memory-2", state: "dismissed" },
    });
    expect(updateInteractionMemoryStatusMock).toHaveBeenCalledWith({
      userId: "user-1",
      id: "memory-2",
      status: "dismissed",
    });
    expect(upsertBrainMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "legacy-interaction-memory:memory-2",
        userId: "user-1",
        scope: { type: "global" },
        ownerType: "chat",
        ownerId: "user-1",
        memoryType: "fact",
        status: "deleted",
        subject: "Owner Context",
        evidenceRefs: ["event-2"],
      }),
    );
    expect(insertBrainMemoryReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        memoryId: "legacy-interaction-memory:memory-2",
        reviewerType: "chat",
        reviewerId: "user-1",
        decision: "dismissed",
        evidenceRefs: ["event-2"],
        metadata: expect.objectContaining({
          source: "owner_context_review",
          legacyKind: "memory",
          legacyId: "memory-2",
        }),
      }),
    );
  });

  it("keeps legacy owner context review usable when Brain review logging fails", async () => {
    upsertBrainMemoryMock.mockRejectedValueOnce(new Error("brain unavailable"));

    await expect(
      reviewOwnerContextCandidate({
        userId: "user-1",
        kind: "task",
        id: "task-1",
        decision: "confirmed",
      }),
    ).resolves.toMatchObject({
      kind: "task",
      decision: "confirmed",
      item: { id: "task-1", state: "confirmed" },
    });
    expect(updateInteractionTaskStatusMock).toHaveBeenCalledWith({
      userId: "user-1",
      id: "task-1",
      status: "confirmed",
    });
  });

  it("delegates workshop processing and evidence reads", async () => {
    await processOwnerContextMessages({
      userId: "user-1",
      eventIds: ["event-1"],
      processingMode: "summary_only",
    });
    expect(processInteractionEventsMock).toHaveBeenCalledWith({
      userId: "user-1",
      eventIds: ["event-1"],
      fallbackToSummary: undefined,
      processingMode: "summary_only",
    });

    await getOwnerContextEvidence({
      userId: "user-1",
      eventIds: ["event-1"],
    });
    expect(getInteractionEventsByIdsMock).toHaveBeenCalledWith({
      userId: "user-1",
      ids: ["event-1"],
    });
  });

  it("resets derived owner knowledge through the legacy adapter", async () => {
    await expect(
      resetOwnerKnowledge({ userId: "user-1", reason: "test_reset" }),
    ).resolves.toEqual({
      deletedNotes: 1,
      deletedTasks: 1,
      deletedMemories: 2,
      deletedGraphEntities: 2,
      deletedGraphRelations: 1,
      deletedGraphEvidence: 3,
      deletedGraphCount: 6,
      deletedCount: 10,
    });
    expect(clearInteractionWikiItemsMock).toHaveBeenCalledWith({
      userId: "user-1",
      reason: "test_reset",
    });
    expect(clearInteractionGraphMock).toHaveBeenCalledWith({
      userId: "user-1",
    });
  });
});
