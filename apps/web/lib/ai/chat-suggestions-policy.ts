// Shared, static UI/API policy. No user profile, source body or cached model text.
export const CHAT_SUGGESTIONS_SOURCE_WARNING =
  "当前显示固定建议；旧洞察与个人资料尚未准入，个性化建议已暂停。";

export const FIXED_CHAT_SUGGESTIONS = [
  { id: "suggest_fixed_1", title: "帮我梳理当前任务", emoji: "📋", type: "role_based" as const,
    reasoning: "Fixed prompt; no saved personal source used", related_insight_ids: [] },
  { id: "suggest_fixed_2", title: "我想整理一份资料", emoji: "📄", type: "role_based" as const,
    reasoning: "Fixed prompt; no saved personal source used", related_insight_ids: [] },
  { id: "suggest_fixed_3", title: "帮我制定下一步计划", emoji: "💡", type: "role_based" as const,
    reasoning: "Fixed prompt; no saved personal source used", related_insight_ids: [] },
];
