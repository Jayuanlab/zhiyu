import { describe, expect, it, vi } from "vitest";
import { applyWorkshopInsightChangeProposal } from "@/lib/workshops/insight-change-apply";

const baseInsight = {
  id: "insight-1",
  botId: "bot-1",
  dedupeKey: null,
  taskLabel: "insight",
  title: "Old title",
  description: "Old description",
  importance: "medium",
  urgency: "medium",
  platform: "manual",
  account: null,
  groups: [],
  people: [],
  time: new Date("2026-09-14T00:00:00.000Z"),
  details: null,
  timeline: null,
  insights: null,
  trendDirection: null,
  trendConfidence: null,
  sentiment: null,
  sentimentConfidence: null,
  intent: null,
  trend: null,
  issueStatus: null,
  communityTrend: null,
  duplicateFlag: null,
  impactLevel: null,
  resolutionHint: null,
  topKeywords: [],
  topEntities: [],
  topVoices: null,
  sources: null,
  sourceConcentration: null,
  buyerSignals: [],
  stakeholders: null,
  contractStatus: null,
  signalType: null,
  confidence: null,
  scope: null,
  nextActions: null,
  followUps: null,
  actionRequired: false,
  actionRequiredDetails: null,
  myTasks: null,
  waitingForMe: null,
  waitingForOthers: null,
  clarifyNeeded: false,
  categories: [],
  learning: null,
  priority: null,
  experimentIdeas: null,
  executiveSummary: null,
  riskFlags: null,
  strategic: null,
  client: null,
  projectName: null,
  nextMilestone: null,
  dueDate: null,
  paymentInfo: null,
  entity: null,
  why: null,
  historySummary: null,
  roleAttribution: null,
  alerts: null,
} as any;

describe("workshop Insight change proposal application", () => {
  it("creates a reviewed Insight proposal under the user's manual bot", async () => {
    const getBotsByUserId = vi.fn(async () => ({
      bots: [{ id: "manual-bot", adapter: "manual" }],
      hasMore: false,
    }));
    const createBot = vi.fn();
    const insertInsightRecords = vi.fn(async () => ["created-insight"]);

    const result = await applyWorkshopInsightChangeProposal(
      {
        userId: "user-1",
        action: "create",
        proposedTitle: "Prepare client demo",
        reason: "Owner approved the proposed reminder.",
        requestedChange: {
          description: "Prepare a concise demo checklist.",
          importance: "high",
          urgency: "medium",
          groups: ["求职"],
        },
      },
      {
        getBotsByUserId: getBotsByUserId as never,
        createBot: createBot as never,
        insertInsightRecords: insertInsightRecords as never,
      },
    );

    expect(createBot).not.toHaveBeenCalled();
    expect(insertInsightRecords).toHaveBeenCalledWith([
      expect.objectContaining({
        botId: "manual-bot",
        title: "Prepare client demo",
        description: "Prepare a concise demo checklist.",
        importance: "high",
        groups: ["求职"],
      }),
    ]);
    expect(result).toEqual({
      applied: true,
      action: "create",
      insightId: "created-insight",
      botId: "manual-bot",
    });
  });

  it("modifies only after loading the target Insight through the current user boundary", async () => {
    const getInsightByIdForUser = vi.fn(async () => ({
      insight: baseInsight,
      bot: { id: "bot-1" },
    }));
    const updateInsightById = vi.fn(async (input) => ({
      ...baseInsight,
      ...input.payload,
      id: input.insightId,
    }));

    const result = await applyWorkshopInsightChangeProposal(
      {
        userId: "user-1",
        action: "modify",
        targetInsightId: "insight-1",
        reason: "Owner approved the title update.",
        requestedChange: {
          title: "New title",
          description: "New description",
        },
      },
      {
        getInsightByIdForUser: getInsightByIdForUser as never,
        updateInsightById: updateInsightById as never,
      },
    );

    expect(getInsightByIdForUser).toHaveBeenCalledWith({
      userId: "user-1",
      insightId: "insight-1",
    });
    expect(updateInsightById).toHaveBeenCalledWith({
      insightId: "insight-1",
      botId: "bot-1",
      payload: expect.objectContaining({
        title: "New title",
        description: "New description",
        importance: "medium",
      }),
    });
    expect(result).toEqual({
      applied: true,
      action: "modify",
      insightId: "insight-1",
      botId: "bot-1",
    });
  });

  it("deletes only after the target Insight is verified for the current user", async () => {
    const getInsightByIdForUser = vi.fn(async () => ({
      insight: baseInsight,
      bot: { id: "bot-1" },
    }));
    const deleteInsightsByIds = vi.fn(async () => undefined);

    const result = await applyWorkshopInsightChangeProposal(
      {
        userId: "user-1",
        action: "delete",
        targetInsightId: "insight-1",
        reason: "Owner approved deletion.",
      },
      {
        getInsightByIdForUser: getInsightByIdForUser as never,
        deleteInsightsByIds: deleteInsightsByIds as never,
      },
    );

    expect(getInsightByIdForUser).toHaveBeenCalledWith({
      userId: "user-1",
      insightId: "insight-1",
    });
    expect(deleteInsightsByIds).toHaveBeenCalledWith({ ids: ["insight-1"] });
    expect(result).toEqual({
      applied: true,
      action: "delete",
      insightId: "insight-1",
      botId: "bot-1",
    });
  });
});
