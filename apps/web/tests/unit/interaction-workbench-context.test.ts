vi.mock("@/lib/interactions/digest-projection", () => ({readWechatDigestProjection: vi.fn()}));
import { readWechatDigestProjection } from "@/lib/interactions/digest-projection";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/brain/service", () => ({
  getBrainMemory: vi.fn(),
  listBrainSnapshots: vi.fn(),
}));

vi.mock("@/lib/knowledge-pipeline/source-policies", () => ({
  listInteractionSourcePolicies: vi.fn(),
}));

vi.mock("@/lib/interactions/service", () => ({
  getInteractionEventsByIds: vi.fn(),
  listInteractionEvents: vi.fn(),
  listInteractionWiki: vi.fn(),
}));

import { getBrainMemory, listBrainSnapshots } from "@/lib/brain/service";
import { listInteractionSourcePolicies } from "@/lib/knowledge-pipeline/source-policies";
import {
  getInteractionEventsByIds,
  listInteractionEvents,
  listInteractionWiki,
} from "@/lib/interactions/service";
import {
  buildWechatTodoDigest,
  getWechatMemoryEvidence,
  getWechatScenarioContext,
} from "@/lib/interactions/workbench-context";

const mockedListSourcePolicies = vi.mocked(listInteractionSourcePolicies);
const mockedListWiki = vi.mocked(listInteractionWiki);
const mockedListEvents = vi.mocked(listInteractionEvents);
const mockedListSnapshots = vi.mocked(listBrainSnapshots);
const mockedGetEventsByIds = vi.mocked(getInteractionEventsByIds);
const mockedGetBrainMemory = vi.mocked(getBrainMemory);

function sourcePolicy(sourceId: string, allowedWorkIds: string[]) {
  return {
    id: `policy-${sourceId}`,
    userId: "user-1",
    platform: "wechat",
    sourceId,
    sourceName: sourceId,
    sourceType: "group",
    policy: "sync",
    enabled: true,
    priority: 0,
    lastSeenAt: null,
    metadata: { allowedWorkIds },
    createdAt: new Date("2026-09-03T00:00:00.000Z"),
    updatedAt: new Date("2026-09-03T00:00:00.000Z"),
  } as const;
}

function event(id: string, conversationId: string) {
  return {
    id,
    userId: "user-1",
    platform: "wechat",
    conversationId,
    requiresReply: true,
    importance: "high",
    occurredAt: new Date("2026-09-03T00:00:00.000Z"),
    createdAt: new Date("2026-09-03T00:00:00.000Z"),
    updatedAt: new Date("2026-09-03T00:00:00.000Z"),
  } as any;
}

describe("interaction workbench context", () => {
  it("does not expose a combined memory when only some of its evidence is allowed", async () => {
    mockedGetBrainMemory.mockResolvedValue({id: "mixed", userId: "user-1", evidenceRefs: ["event-allowed", "event-blocked"]} as any);
    mockedGetEventsByIds.mockResolvedValue([event("event-allowed", "allowed-chat"),event("event-blocked", "blocked-chat")]);
    const result = await getWechatMemoryEvidence({userId:"user-1", memoryId:"mixed", requesterWorkId:"work-1"});
    expect(result.memory).toBeNull();
    expect(result.events.map(item => item.id)).toEqual(["event-allowed"]);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mockedListSourcePolicies.mockResolvedValue([
      sourcePolicy("allowed-chat", ["work-1"]),
      sourcePolicy("blocked-chat", ["other-work"]),
    ]);
  });

  it("passes source scope to the aggregate and retains total counts independent of returned rows", async () => {
    const group = (items: unknown[]) => ({items, total: 150, returned: items.length, hasMore: true, cursor: "12"});
    vi.mocked(readWechatDigestProjection).mockResolvedValue({
      asOf: "2026-09-06T00:00:00Z", lastSourceObservedAt: null, lastSourceCollectedAt: null,
      tasks: group([{id: "task-allowed", title: "task", status: "candidate", metadata: {}, dueAt: null}]),
      risks: group([{id: "risk-allowed"}]), replies: group([]), memories: group([]),
    } as any);
    const digest = await buildWechatTodoDigest({userId: "user-1", requesterWorkId: "work-1", limit: 12});
    expect(readWechatDigestProjection).toHaveBeenCalledWith(expect.objectContaining({userId: "user-1", allowedConversationIds: ["allowed-chat"], limit: 12}));
    expect(digest.counts.pendingTasks).toBe(150);
    expect(digest.attentionItems[0].kind).toBe("risk");
    expect(digest.pagination.pendingTasks.returned).toBe(1);
  });

  it("filters scenario snapshots through their original source events", async () => {
    mockedListSnapshots.mockResolvedValue([
      {
        id: "snapshot-allowed",
        content: {
          scenarioType: "project",
          scenarioKey: "alpha",
          sourceEventIds: ["event-allowed"],
        },
        metadata: {},
      },
      {
        id: "snapshot-blocked",
        content: {
          scenarioType: "project",
          scenarioKey: "beta",
          sourceEventIds: ["event-blocked"],
        },
        metadata: {},
      },
    ] as any);
    mockedGetEventsByIds.mockResolvedValue([
      event("event-allowed", "allowed-chat"),
      event("event-blocked", "blocked-chat"),
    ]);

    const context = await getWechatScenarioContext({
      userId: "user-1",
      requesterWorkId: "work-1",
    });

    expect(context.scenarios.map((scenario) => scenario.id)).toEqual([
      "snapshot-allowed",
    ]);
  });

  it("does not return a Brain memory when its WeChat evidence is denied", async () => {
    mockedGetBrainMemory.mockResolvedValue({
      id: "brain-memory-1",
      userId: "user-1",
      evidenceRefs: ["event-blocked"],
    } as any);
    mockedGetEventsByIds.mockResolvedValue([event("event-blocked", "blocked-chat")]);

    const evidence = await getWechatMemoryEvidence({
      userId: "user-1",
      memoryId: "brain-memory-1",
      requesterWorkId: "work-1",
    });

    expect(evidence.memory).toBeNull();
    expect(evidence.events).toEqual([]);
    expect(evidence.unresolvedEventIds).toEqual(["event-blocked"]);
  });
});
