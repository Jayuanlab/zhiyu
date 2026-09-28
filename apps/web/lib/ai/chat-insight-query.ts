import {
  getBotsByUserId,
  getInsightChats,
  getInsightsByIdsForUser,
  getInsightsWithNotesAndDocuments,
  getStoredInsightsByBotIds,
} from "@/lib/db/queries";
import {
  type InsightFilterDefinition,
  insightFilterDefinitionSchema,
} from "@/lib/insights/filter-schema";
import { filterInsights } from "@/lib/insights/filter-utils";
import { formatInsight } from "@/lib/ai/mcp/tools/shared";

type InsightsNotesDocumentsMap = Awaited<
  ReturnType<typeof getInsightsWithNotesAndDocuments>
>;

type ChatInsightQueryDeps = {
  getBots?: typeof getBotsByUserId;
  getStoredInsights?: typeof getStoredInsightsByBotIds;
  getInsightsByIds?: typeof getInsightsByIdsForUser;
  getNotesAndDocuments?: typeof getInsightsWithNotesAndDocuments;
  getChats?: typeof getInsightChats;
};

export type ChatInsightQueryInput = ChatInsightQueryDeps & {
  userId: string;
  withDetail?: boolean | string;
  days?: number;
  searchMode?: "basic" | "comprehensive";
  keyword?: string | string[];
  insightIds?: string[];
  page?: number;
  pageSize?: number;
  filterDefinition?: unknown;
};

function normalizeWithDetail(value: boolean | string | undefined) {
  if (typeof value === "string") {
    return ["true", "yes", "1", "important", "on"].includes(
      value.toLowerCase(),
    );
  }
  return value ?? false;
}

function safePositiveInteger(value: unknown, fallback: number, max?: number) {
  const next =
    typeof value === "number" && Number.isFinite(value)
      ? Math.trunc(value)
      : fallback;
  const positive = Math.max(1, next);
  return typeof max === "number" ? Math.min(max, positive) : positive;
}

function normalizeKeywordValues(keyword: string | string[]) {
  if (Array.isArray(keyword)) return keyword;
  if (keyword.startsWith("[") && keyword.endsWith("]")) {
    try {
      const parsed = JSON.parse(keyword);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return [keyword];
    }
  }
  return [keyword];
}

function buildEffectiveFilterDefinition(input: {
  keyword?: string | string[];
  filterDefinition?: unknown;
}) {
  if (!input.keyword || input.filterDefinition) return input.filterDefinition;
  return {
    match: "any" as const,
    conditions: [
      {
        kind: "keyword",
        values: normalizeKeywordValues(input.keyword),
        match: "any" as const,
      },
    ],
  };
}

function parseInsightFilter(input: {
  filterDefinition?: unknown;
  searchMode: "basic" | "comprehensive";
}) {
  const effectiveFilterDefinition = input.filterDefinition;
  let parsedFilter: InsightFilterDefinition | null = null;
  try {
    if (effectiveFilterDefinition) {
      let repairedFilter = effectiveFilterDefinition as Record<string, any>;

      if (typeof repairedFilter === "string") {
        repairedFilter = JSON.parse(repairedFilter);
      }

      if (!repairedFilter.conditions && repairedFilter.keyword) {
        repairedFilter = {
          match: "any" as const,
          conditions: [
            {
              kind: "keyword",
              values: Array.isArray(repairedFilter.keyword)
                ? repairedFilter.keyword
                : [repairedFilter.keyword],
              match: "any" as const,
            },
          ],
        };
      }

      if (!repairedFilter.conditions || repairedFilter.conditions.length === 0) {
        return null;
      }

      if (
        Array.isArray(repairedFilter.conditions) &&
        repairedFilter.conditions.length > 0 &&
        typeof repairedFilter.conditions[0] === "string"
      ) {
        repairedFilter = {
          ...repairedFilter,
          conditions: repairedFilter.conditions.map((condition: any) => ({
            kind: "keyword",
            values: Array.isArray(condition) ? condition : [condition],
            match: "any" as const,
          })),
        };
      }

      parsedFilter = insightFilterDefinitionSchema.parse(repairedFilter);
    }
  } catch (error) {
    console.warn("[chatInsight] Invalid insight filter", error);
  }

  if (parsedFilter && input.searchMode === "basic") {
    return {
      ...parsedFilter,
      conditions: parsedFilter.conditions.map((condition) => {
        if (condition.kind !== "keyword") return condition;
        return {
          ...condition,
          fields: [
            "title",
            "description",
            "groups",
            "people",
            "details",
            "sources",
            "insight_keywords",
          ] as (
            | "title"
            | "description"
            | "groups"
            | "people"
            | "details"
            | "sources"
            | "insight_keywords"
          )[],
        };
      }),
    };
  }

  return parsedFilter;
}

async function attachInsightContext(input: {
  userId: string;
  insights: Array<ReturnType<typeof formatInsight>>;
  getNotesAndDocuments: typeof getInsightsWithNotesAndDocuments;
  getChats: typeof getInsightChats;
  wrapInsight?: boolean;
}) {
  let insightsNotesDocumentsMap: InsightsNotesDocumentsMap = new Map();
  if (input.insights.length > 0) {
    try {
      insightsNotesDocumentsMap = await input.getNotesAndDocuments({
        userId: input.userId,
        insightIds: input.insights.map((insight) => insight.id),
      });
    } catch (error) {
      console.error(
        "[chatInsight] Failed to fetch notes and documents for insights:",
        error,
      );
    }
  }

  const insightsChatsMap = new Map<string, string[]>();
  if (input.insights.length > 0) {
    try {
      const chatIdsResults = await Promise.all(
        input.insights.map(async (insight) => ({
          insightId: insight.id,
          chatIds: await input.getChats({ insightId: insight.id }),
        })),
      );
      chatIdsResults.forEach(({ insightId, chatIds }) => {
        insightsChatsMap.set(insightId, chatIds);
      });
    } catch (error) {
      console.error(
        "[chatInsight] Failed to fetch related chat IDs for insights:",
        error,
      );
    }
  }

  return input.insights.map((insight) => {
    const data = insightsNotesDocumentsMap.get(insight.id);
    if (input.wrapInsight) {
      return {
        insight,
        notes: data?.notes || [],
        documents: data?.documents || [],
        relatedChatIds: insightsChatsMap.get(insight.id) || [],
      };
    }
    return {
      ...insight,
      notes: data?.notes || [],
      documents: data?.documents || [],
      relatedChatIds: insightsChatsMap.get(insight.id) || [],
    };
  });
}

export async function queryChatInsightsForUser(
  input: ChatInsightQueryInput,
) {
  try {
    const withDetail = normalizeWithDetail(input.withDetail);
    const days = safePositiveInteger(input.days, 7);
    const page = safePositiveInteger(input.page, 1);
    const pageSize = safePositiveInteger(input.pageSize, 30, 50);
    const searchMode = input.searchMode ?? "basic";
    const getBots = input.getBots ?? getBotsByUserId;
    const getStoredInsights = input.getStoredInsights ?? getStoredInsightsByBotIds;
    const getInsightsByIds = input.getInsightsByIds ?? getInsightsByIdsForUser;
    const getNotesAndDocuments =
      input.getNotesAndDocuments ?? getInsightsWithNotesAndDocuments;
    const getChats = input.getChats ?? getInsightChats;

    const effectiveFilterDefinition = buildEffectiveFilterDefinition({
      keyword: input.keyword,
      filterDefinition: input.filterDefinition,
    });
    const parsedFilter = parseInsightFilter({
      filterDefinition: effectiveFilterDefinition,
      searchMode,
    });

    const bots = await getBots({
      id: input.userId,
      limit: null,
      startingAfter: null,
      endingBefore: null,
      onlyEnable: false,
    });

    if (bots.bots.length === 0) {
      const data = {
        insights: [],
        pagination: {
          page,
          pageSize,
          totalCount: 0,
          totalPages: 0,
          hasMore: false,
          hasPrevious: false,
        },
      };
      return {
        ok: true,
        text: "No bots found for the user",
        data,
      };
    }

    if (input.insightIds && input.insightIds.length > 0) {
      const insightsByIds = await getInsightsByIds({
        userId: input.userId,
        insightIds: input.insightIds,
      });
      const formattedInsights = insightsByIds.map((item) =>
        formatInsight(item.insight, withDetail),
      );
      const insights = await attachInsightContext({
        userId: input.userId,
        insights: formattedInsights,
        getNotesAndDocuments,
        getChats,
        wrapInsight: true,
      });
      const data = {
        insights,
        pagination: {
          page: 1,
          pageSize: input.insightIds.length,
          totalCount: input.insightIds.length,
          totalPages: 1,
          hasMore: false,
          hasPrevious: false,
        },
      };
      return {
        ok: true,
        text: JSON.stringify(insights, null, 2),
        data,
      };
    }

    const { insights: insightItems } = await getStoredInsights({
      ids: bots.bots.map((bot) => bot.id),
      days: Math.min(1, days),
    });

    let notFound = false;
    let filteredInsights = insightItems;
    if (parsedFilter) {
      filteredInsights = filterInsights(insightItems, parsedFilter);
      if (filteredInsights.length === 0) {
        filteredInsights = [];
        notFound = true;
      }
    }

    const formattedInsights = filteredInsights.map((item) =>
      formatInsight(item, withDetail),
    );
    const insightsWithContext = await attachInsightContext({
      userId: input.userId,
      insights: formattedInsights,
      getNotesAndDocuments,
      getChats,
    });

    const totalCount = insightsWithContext.length;
    const startIndex = (page - 1) * pageSize;
    const paginatedInsights = insightsWithContext.slice(
      startIndex,
      startIndex + pageSize,
    );
    const totalPages = Math.ceil(totalCount / pageSize);
    const data = {
      success: paginatedInsights.length > 0,
      message:
        paginatedInsights.length > 0
          ? `Successfully retrieved ${paginatedInsights.length} insight(s) (page ${page} of ${totalPages})`
          : notFound
            ? "No insights match the specified filter criteria. Try using different or broader search terms."
            : "Zhiyu has not yet completed your history message aggregation, please add more integrations and try again later",
      insights: paginatedInsights,
      pagination: {
        page,
        pageSize,
        totalCount,
        totalPages,
        hasMore: page < totalPages,
        hasPrevious: page > 1,
        notFound,
      },
    };

    return {
      ok: true,
      text: JSON.stringify(data, null, 2),
      data,
    };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
