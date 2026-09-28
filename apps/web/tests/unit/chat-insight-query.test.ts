import { describe, expect, it, vi } from "vitest";
import { queryChatInsightsForUser } from "@/lib/ai/chat-insight-query";

function createInsight(id: string, title: string) {
  return {
    id,
    title,
    description: `${title} summary`,
    time: new Date("2026-09-14T00:00:00.000Z"),
    details: [],
  };
}

describe("chat insight query adapter", () => {
  it("queries owner bots, filters by keyword, and paginates insights", async () => {
    const getBots = vi.fn(async () => ({
      bots: [{ id: "bot-1" }],
    }));
    const getStoredInsights = vi.fn(async () => ({
      insights: [
        createInsight("insight-1", "Project Alpha"),
        createInsight("insight-2", "Project Beta"),
      ],
    }));
    const getNotesAndDocuments = vi.fn(async () => new Map());
    const getChats = vi.fn(async () => ["chat-1"]);

    const result = await queryChatInsightsForUser({
      userId: "user-1",
      keyword: "Alpha",
      page: 1,
      pageSize: 1,
      getBots: getBots as never,
      getStoredInsights: getStoredInsights as never,
      getNotesAndDocuments: getNotesAndDocuments as never,
      getChats: getChats as never,
    });

    expect(getBots).toHaveBeenCalledWith({
      id: "user-1",
      limit: null,
      startingAfter: null,
      endingBefore: null,
      onlyEnable: false,
    });
    expect(getStoredInsights).toHaveBeenCalledWith({
      ids: ["bot-1"],
      days: 1,
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        success: true,
        insights: [
          {
            id: "insight-1",
            title: "Project Alpha",
            relatedChatIds: ["chat-1"],
          },
        ],
        pagination: {
          page: 1,
          pageSize: 1,
          totalCount: 1,
          totalPages: 1,
          hasMore: false,
        },
      },
    });
    expect(result.text).toContain("Project Alpha");
  });

  it("queries selected insight ids directly with owner scope", async () => {
    const getBots = vi.fn(async () => ({
      bots: [{ id: "bot-1" }],
    }));
    const getInsightsByIds = vi.fn(async () => [
      {
        insight: createInsight("insight-1", "Focused insight"),
      },
    ]);
    const getNotesAndDocuments = vi.fn(async () => new Map());
    const getChats = vi.fn(async () => []);

    const result = await queryChatInsightsForUser({
      userId: "user-1",
      insightIds: ["insight-1"],
      withDetail: "true",
      getBots: getBots as never,
      getInsightsByIds: getInsightsByIds as never,
      getNotesAndDocuments: getNotesAndDocuments as never,
      getChats: getChats as never,
    });

    expect(getInsightsByIds).toHaveBeenCalledWith({
      userId: "user-1",
      insightIds: ["insight-1"],
    });
    expect(result.data?.insights).toEqual([
      {
        insight: expect.objectContaining({
          id: "insight-1",
          title: "Focused insight",
        }),
        notes: [],
        documents: [],
        relatedChatIds: [],
      },
    ]);
  });
});
