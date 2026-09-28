import type { Bot, Insight } from "@/lib/db/schema";
import {
  deleteInsightsByIds,
  getInsightByIdForUser,
  insertInsightRecords,
  updateInsightById,
} from "@/lib/db/queries";
import {
  createBot,
  getBotsByUserId,
} from "@/lib/db/bot-queries";
import type { GeneratedInsightPayload } from "@/lib/insights/types";
import type { WorkshopJson } from "./types";
import type { WorkshopInsightChangeAction } from "./insight-change-proposals";

type BotListResult = Awaited<ReturnType<typeof getBotsByUserId>>;

type InsightRecord = {
  insight: Insight;
  bot: Bot;
};

export type AppliedWorkshopInsightChange = {
  applied: true;
  action: WorkshopInsightChangeAction;
  insightId: string;
  botId: string;
};

export type WorkshopInsightChangeApplyDependencies = {
  getInsightByIdForUser?: typeof getInsightByIdForUser;
  insertInsightRecords?: typeof insertInsightRecords;
  updateInsightById?: typeof updateInsightById;
  deleteInsightsByIds?: typeof deleteInsightsByIds;
  getBotsByUserId?: typeof getBotsByUserId;
  createBot?: typeof createBot;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
    : undefined;
}

function valueOrExisting<T>(change: Record<string, unknown>, key: string, existing: T): T {
  return Object.hasOwn(change, key) ? (change[key] as T) : existing;
}

function safeObjectOrNull<T>(value: unknown, fallback: T | null): T | null {
  if (value === null) return null;
  if (Array.isArray(value) || isRecord(value) || typeof value === "string") {
    return value as T;
  }
  return fallback;
}

function safeArrayOrNull<T>(value: unknown, fallback: T[] | null): T[] | null {
  if (value === null) return null;
  return Array.isArray(value) ? (value as T[]) : fallback;
}

function dateValue(value: unknown, fallback: Date | string | number | null) {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return fallback ?? new Date();
}

function dateObject(value: unknown, fallback: Date = new Date()) {
  const date = dateValue(value, fallback);
  return date instanceof Date ? date : new Date(date);
}

function normalizeImportance(value: unknown, fallback = "medium") {
  const text = stringValue(value).toLowerCase();
  return text || fallback;
}

function normalizeUrgency(value: unknown, fallback = "medium") {
  const text = stringValue(value).toLowerCase();
  return text || fallback;
}

async function ensureManualBot(
  userId: string,
  deps: Required<
    Pick<WorkshopInsightChangeApplyDependencies, "getBotsByUserId" | "createBot">
  >,
) {
  const bots: BotListResult = await deps.getBotsByUserId({
    id: userId,
    limit: null,
    startingAfter: null,
    endingBefore: null,
    onlyEnable: false,
  });
  const manualBot = bots.bots.find((bot) => bot.adapter === "manual");
  if (manualBot) return manualBot.id;

  return deps.createBot({
    name: "My Bot",
    userId,
    description: "Default bot for manual insights",
    adapter: "manual",
    adapterConfig: {},
    enable: true,
  });
}

function buildCreatedPayload(input: {
  botId: string;
  requestedChange: Record<string, unknown>;
  fallbackTitle?: string | null;
  reason: string;
}) {
  const title = stringValue(
    input.requestedChange.title,
    stringValue(input.fallbackTitle, ""),
  );
  if (!title) {
    throw new Error("Insight create proposal requires a title.");
  }

  return {
    botId: input.botId,
    dedupeKey: null,
    taskLabel: stringValue(input.requestedChange.taskLabel, "insight"),
    title,
    description: stringValue(input.requestedChange.description, input.reason),
    importance: normalizeImportance(input.requestedChange.importance),
    urgency: normalizeUrgency(input.requestedChange.urgency),
    platform: stringValue(input.requestedChange.platform, "manual"),
    account: stringValue(input.requestedChange.account) || null,
    groups: stringArray(input.requestedChange.groups) ?? [],
    categories: stringArray(input.requestedChange.categories) ?? [],
    people: stringArray(input.requestedChange.people) ?? [],
    time: dateObject(input.requestedChange.time),
    details: safeArrayOrNull(input.requestedChange.details, null),
    timeline: safeArrayOrNull(input.requestedChange.timeline, null),
    insights: safeObjectOrNull(input.requestedChange.insights, null),
    actionRequired: Boolean(input.requestedChange.actionRequired),
    myTasks: safeArrayOrNull(input.requestedChange.myTasks, null),
    waitingForMe: safeArrayOrNull(input.requestedChange.waitingForMe, null),
    waitingForOthers: safeArrayOrNull(input.requestedChange.waitingForOthers, null),
    clarifyNeeded: Boolean(input.requestedChange.clarifyNeeded),
    learning: stringValue(input.requestedChange.learning) || null,
    experimentIdeas: safeArrayOrNull(input.requestedChange.experimentIdeas, null),
    executiveSummary: stringValue(input.requestedChange.executiveSummary) || null,
    riskFlags: safeArrayOrNull(input.requestedChange.riskFlags, null),
    strategic: safeObjectOrNull(input.requestedChange.strategic, null),
    client: stringValue(input.requestedChange.client) || null,
    projectName: stringValue(input.requestedChange.projectName) || null,
    nextMilestone: stringValue(input.requestedChange.nextMilestone) || null,
    dueDate: stringValue(input.requestedChange.dueDate) || null,
    paymentInfo: stringValue(input.requestedChange.paymentInfo) || null,
    entity: stringValue(input.requestedChange.entity) || null,
    why: stringValue(input.requestedChange.why) || null,
    historySummary: safeObjectOrNull(input.requestedChange.historySummary, null),
    roleAttribution: safeObjectOrNull(input.requestedChange.roleAttribution, null),
    alerts: safeArrayOrNull(input.requestedChange.alerts, null),
    topKeywords: stringArray(input.requestedChange.topKeywords) ?? [],
    topEntities: stringArray(input.requestedChange.topEntities) ?? [],
    buyerSignals: stringArray(input.requestedChange.buyerSignals) ?? [],
    followUps: safeArrayOrNull(input.requestedChange.followUps, null),
    nextActions: safeArrayOrNull(input.requestedChange.nextActions, null),
    actionRequiredDetails: safeObjectOrNull(
      input.requestedChange.actionRequiredDetails,
      null,
    ),
  } satisfies GeneratedInsightPayload & { botId: string };
}

function buildUpdatedPayload(record: InsightRecord, requestedChange: Record<string, unknown>) {
  const existing = record.insight as Insight & Record<string, unknown>;
  return {
    dedupeKey: existing.dedupeKey ?? null,
    taskLabel: stringValue(
      valueOrExisting(requestedChange, "taskLabel", existing.taskLabel),
      "insight",
    ),
    title: stringValue(valueOrExisting(requestedChange, "title", existing.title), existing.title),
    description: stringValue(
      valueOrExisting(requestedChange, "description", existing.description),
      existing.description,
    ),
    importance: normalizeImportance(
      valueOrExisting(requestedChange, "importance", existing.importance),
      stringValue(existing.importance, "medium"),
    ),
    urgency: normalizeUrgency(
      valueOrExisting(requestedChange, "urgency", existing.urgency),
      stringValue(existing.urgency, "medium"),
    ),
    platform: valueOrExisting(requestedChange, "platform", existing.platform) as string | null,
    account: valueOrExisting(requestedChange, "account", existing.account) as string | null,
    groups: stringArray(valueOrExisting(requestedChange, "groups", existing.groups)) ?? [],
    people: stringArray(valueOrExisting(requestedChange, "people", existing.people)) ?? [],
    time: dateValue(valueOrExisting(requestedChange, "time", existing.time), existing.time),
    details: safeArrayOrNull(valueOrExisting(requestedChange, "details", existing.details), existing.details as any),
    timeline: safeArrayOrNull(valueOrExisting(requestedChange, "timeline", existing.timeline), existing.timeline as any),
    insights: valueOrExisting(requestedChange, "insights", existing.insights) as any,
    trendDirection: valueOrExisting(requestedChange, "trendDirection", existing.trendDirection) as string | null,
    trendConfidence: valueOrExisting(requestedChange, "trendConfidence", existing.trendConfidence) as number | null,
    sentiment: valueOrExisting(requestedChange, "sentiment", existing.sentiment) as string | null,
    sentimentConfidence: valueOrExisting(requestedChange, "sentimentConfidence", existing.sentimentConfidence) as number | null,
    intent: valueOrExisting(requestedChange, "intent", existing.intent) as string | null,
    trend: valueOrExisting(requestedChange, "trend", existing.trend) as string | null,
    issueStatus: valueOrExisting(requestedChange, "issueStatus", existing.issueStatus) as string | null,
    communityTrend: valueOrExisting(requestedChange, "communityTrend", existing.communityTrend) as string | null,
    duplicateFlag: valueOrExisting(requestedChange, "duplicateFlag", existing.duplicateFlag) as boolean | null,
    impactLevel: valueOrExisting(requestedChange, "impactLevel", existing.impactLevel) as string | null,
    resolutionHint: valueOrExisting(requestedChange, "resolutionHint", existing.resolutionHint) as string | null,
    topKeywords: stringArray(valueOrExisting(requestedChange, "topKeywords", existing.topKeywords)) ?? [],
    topEntities: stringArray(valueOrExisting(requestedChange, "topEntities", existing.topEntities)) ?? [],
    topVoices: valueOrExisting(requestedChange, "topVoices", existing.topVoices) as any,
    sources: valueOrExisting(requestedChange, "sources", existing.sources) as any,
    sourceConcentration: valueOrExisting(requestedChange, "sourceConcentration", existing.sourceConcentration) as string | null,
    buyerSignals: stringArray(valueOrExisting(requestedChange, "buyerSignals", existing.buyerSignals)) ?? [],
    stakeholders: valueOrExisting(requestedChange, "stakeholders", existing.stakeholders) as any,
    contractStatus: valueOrExisting(requestedChange, "contractStatus", existing.contractStatus) as string | null,
    signalType: valueOrExisting(requestedChange, "signalType", existing.signalType) as string | null,
    confidence: valueOrExisting(requestedChange, "confidence", existing.confidence) as number | null,
    scope: valueOrExisting(requestedChange, "scope", existing.scope) as string | null,
    nextActions: valueOrExisting(requestedChange, "nextActions", existing.nextActions) as any,
    followUps: valueOrExisting(requestedChange, "followUps", existing.followUps) as any,
    actionRequired: valueOrExisting(requestedChange, "actionRequired", existing.actionRequired) as boolean | null,
    actionRequiredDetails: valueOrExisting(requestedChange, "actionRequiredDetails", existing.actionRequiredDetails) as any,
    myTasks: valueOrExisting(requestedChange, "myTasks", existing.myTasks) as any,
    waitingForMe: valueOrExisting(requestedChange, "waitingForMe", existing.waitingForMe) as any,
    waitingForOthers: valueOrExisting(requestedChange, "waitingForOthers", existing.waitingForOthers) as any,
    clarifyNeeded: valueOrExisting(requestedChange, "clarifyNeeded", existing.clarifyNeeded) as boolean | null,
    categories: stringArray(valueOrExisting(requestedChange, "categories", existing.categories)) ?? [],
    learning: valueOrExisting(requestedChange, "learning", existing.learning) as string | null,
    experimentIdeas: valueOrExisting(requestedChange, "experimentIdeas", existing.experimentIdeas) as any,
    executiveSummary: valueOrExisting(requestedChange, "executiveSummary", existing.executiveSummary) as string | null,
    riskFlags: valueOrExisting(requestedChange, "riskFlags", existing.riskFlags) as any,
    strategic: valueOrExisting(requestedChange, "strategic", existing.strategic) as any,
    client: valueOrExisting(requestedChange, "client", existing.client) as string | null,
    projectName: valueOrExisting(requestedChange, "projectName", existing.projectName) as string | null,
    nextMilestone: valueOrExisting(requestedChange, "nextMilestone", existing.nextMilestone) as string | null,
    dueDate: valueOrExisting(requestedChange, "dueDate", existing.dueDate) as string | null,
    paymentInfo: valueOrExisting(requestedChange, "paymentInfo", existing.paymentInfo) as string | null,
    entity: valueOrExisting(requestedChange, "entity", existing.entity) as string | null,
    why: valueOrExisting(requestedChange, "why", existing.why) as string | null,
    historySummary: valueOrExisting(requestedChange, "historySummary", existing.historySummary) as any,
    roleAttribution: valueOrExisting(requestedChange, "roleAttribution", existing.roleAttribution) as any,
    alerts: valueOrExisting(requestedChange, "alerts", existing.alerts) as any,
  } satisfies GeneratedInsightPayload;
}

export async function applyWorkshopInsightChangeProposal(
  input: {
    userId: string;
    action: WorkshopInsightChangeAction;
    targetInsightId?: string | null;
    proposedTitle?: string | null;
    requestedChange?: WorkshopJson | null;
    reason: string;
  },
  dependencies: WorkshopInsightChangeApplyDependencies = {},
): Promise<AppliedWorkshopInsightChange> {
  const deps = {
    getInsightByIdForUser,
    insertInsightRecords,
    updateInsightById,
    deleteInsightsByIds,
    getBotsByUserId,
    createBot,
    ...dependencies,
  };
  const requestedChange = isRecord(input.requestedChange)
    ? input.requestedChange
    : {};

  if (input.action === "create") {
    const botId = await ensureManualBot(input.userId, deps);
    const payload = buildCreatedPayload({
      botId,
      requestedChange,
      fallbackTitle: input.proposedTitle,
      reason: input.reason,
    });
    const [insightId] = await deps.insertInsightRecords([payload as any]);
    if (!insightId) {
      throw new Error("Insight create proposal did not return a created insight id.");
    }
    return { applied: true, action: input.action, insightId, botId };
  }

  const targetInsightId = stringValue(input.targetInsightId);
  if (!targetInsightId) {
    throw new Error(`${input.action} proposal requires targetInsightId.`);
  }

  const record = await deps.getInsightByIdForUser({
    userId: input.userId,
    insightId: targetInsightId,
  });
  if (!record) {
    throw new Error("Target insight not found or not owned by the current user.");
  }

  if (input.action === "delete") {
    await deps.deleteInsightsByIds({ ids: [targetInsightId] });
    return {
      applied: true,
      action: input.action,
      insightId: targetInsightId,
      botId: record.bot.id,
    };
  }

  const payload = buildUpdatedPayload(record, requestedChange);
  const updated = await deps.updateInsightById({
    insightId: targetInsightId,
    botId: record.bot.id,
    payload,
  });
  return {
    applied: true,
    action: input.action,
    insightId: updated.id,
    botId: record.bot.id,
  };
}
