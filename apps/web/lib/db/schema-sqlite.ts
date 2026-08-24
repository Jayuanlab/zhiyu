/**
 * SQLite-compatible schema definitions
 * Converts PostgreSQL types to SQLite equivalents:
 * - uuid() → text()
 * - timestamp → integer (Unix timestamp in milliseconds)
 * - jsonb → text (JSON string)
 * - array() → text (JSON array string)
 * - boolean → integer (0/1)
 * - numeric/decimal → text
 */

import { sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";
import type { DetailData, TimelineData } from "../ai/subagents/insights";

// ============================================================================
// Core Tables
// ============================================================================

export const user = sqliteTable("User", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  password: text("password"),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
      updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .default(sql`(unixepoch() * 1000)`),
  firstLoginAt: integer("first_login_at", { mode: "timestamp" }),
  lastLoginAt: integer("last_login_at", { mode: "timestamp" }),
  finishOnboarding: integer("finish_on_boarding", { mode: "boolean" })
    .notNull()
    .default(sql`0`),
  sessionVersion: integer("session_version").notNull().default(1),
});

export type User = InferSelectModel<typeof user>;

export const passwordResetToken = sqliteTable(
  "PasswordResetToken",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    tokenKey: uniqueIndex("PasswordResetToken_token_key").on(table.token),
    userIdx: index("PasswordResetToken_user_idx").on(table.userId),
  }),
);

export type PasswordResetToken = InferSelectModel<typeof passwordResetToken>;

export const chat = sqliteTable("Chat", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  title: text("title").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id),
  visibility: text("visibility").notNull().default("private"),
});

export type Chat = InferSelectModel<typeof chat>;

export const chatInsights = sqliteTable(
  "chat_insights",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    chatId: text("chat_id")
      .notNull()
      .references(() => chat.id, { onDelete: "cascade" }),
    insightId: text("insight_id")
      .notNull()
      .references(() => insight.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    uniqueChatInsight: uniqueIndex("chat_insights_chat_insight_idx").on(
      table.chatId,
      table.insightId,
    ),
    chatIdx: index("chat_insights_chat_idx").on(table.chatId),
    insightIdx: index("chat_insights_insight_idx").on(table.insightId),
  }),
);

export type ChatInsight = InferSelectModel<typeof chatInsights>;
export type InsertChatInsight = InferInsertModel<typeof chatInsights>;

export const message = sqliteTable("Message_v2", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  chatId: text("chatId")
    .notNull()
    .references(() => chat.id),
  role: text("role").notNull(),
  parts: text("parts").notNull(), // JSON string
  attachments: text("attachments").notNull(), // JSON string
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  metadata: text("metadata"), // JSON string
});

export type DBMessage = InferSelectModel<typeof message>;

export const vote = sqliteTable(
  "Vote_v2",
  {
    chatId: text("chatId")
      .notNull()
      .references(() => chat.id),
    messageId: text("messageId")
      .notNull()
      .references(() => message.id),
    isUpvoted: integer("isUpvoted", { mode: "boolean" }).notNull(),
  },
  (table) => {
    return {
      pk: primaryKey({ columns: [table.chatId, table.messageId] }),
    };
  },
);

export type Vote = InferSelectModel<typeof vote>;

export const stream = sqliteTable("Stream", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  chatId: text("chatId").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});

export type Stream = InferSelectModel<typeof stream>;

// ============================================================================
// Platform Integrations
// ============================================================================

export const integrationAccounts = sqliteTable(
  "platform_accounts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("userId")
      .notNull()
      .references(() => user.id),
    platform: text("platform").notNull(),
    externalId: text("external_id").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status").notNull().default("active"),
    metadata: text("metadata"), // JSON string
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    encryptionKeyId: text("encryption_key_id"),
    lastRotatedAt: integer("last_rotated_at", { mode: "timestamp" }),
    rotationCount: integer("rotation_count").notNull().default(0),
    keyVersion: integer("key_version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    uniqueUserPlatformExternal: uniqueIndex(
      "platform_accounts_user_platform_external_id_idx",
    ).on(table.userId, table.platform, table.externalId),
    userLookup: index("platform_accounts_user_idx").on(table.userId),
  }),
);

export type IntegrationAccount = InferSelectModel<typeof integrationAccounts>;
export type InsertIntegrationAccount = InferInsertModel<
  typeof integrationAccounts
>;

// Credential Rotation History - stores previous credentials during rotation
export const credentialRotationHistory = sqliteTable(
  "credential_rotation_history",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    accountId: text("account_id")
      .notNull()
      .references(() => integrationAccounts.id, { onDelete: "cascade" }),
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    encryptionKeyId: text("encryption_key_id"),
    rotatedAt: integer("rotated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    rotatedBy: text("rotated_by"),
    reason: text("reason"),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    accountIdx: index("credential_rotation_history_account_idx").on(
      table.accountId,
    ),
    expiresIdx: index("credential_rotation_history_expires_idx").on(
      table.expiresAt,
    ),
  }),
);

export type CredentialRotationHistory = InferSelectModel<
  typeof credentialRotationHistory
>;
export type InsertCredentialRotationHistory = InferInsertModel<
  typeof credentialRotationHistory
>;

// Credential Access Log - audit log for credential operations
export const credentialAccessLog = sqliteTable(
  "credential_access_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    accountId: text("account_id")
      .notNull()
      .references(() => integrationAccounts.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    accessedAt: integer("accessed_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    metadata: text("metadata"), // JSON string
    success: integer("success", { mode: "boolean" }).notNull().default(true),
    errorMessage: text("error_message"),
  },
  (table) => ({
    accountIdx: index("credential_access_log_account_idx").on(table.accountId),
    userIdx: index("credential_access_log_user_idx").on(table.userId),
    actionIdx: index("credential_access_log_action_idx").on(table.action),
  }),
);

export type CredentialAccessLog = InferSelectModel<typeof credentialAccessLog>;
export type InsertCredentialAccessLog = InferInsertModel<
  typeof credentialAccessLog
>;

export const integrationCatalog = sqliteTable(
  "integration_catalog",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    slug: text("slug").notNull(),
    integrationId: text("integration_id").notNull(),
    integrationType: text("integration_type").notNull(),
    category: text("category").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    url: text("url").notNull(),
    logoUrl: text("logo_url"),
    config: text("config").default("{}"), // JSON string
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    slugUnique: uniqueIndex("integration_catalog_slug_idx").on(table.slug),
  }),
);

export type IntegrationCatalogEntry = InferSelectModel<
  typeof integrationCatalog
>;

// ============================================================================
// RSS Subscriptions
// ============================================================================

export const rssSubscriptions = sqliteTable(
  "rss_subscriptions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    catalogId: text("catalog_id").references(() => integrationCatalog.id, {
      onDelete: "set null",
    }),
    integrationAccountId: text("integration_account_id").references(
      () => integrationAccounts.id,
      { onDelete: "set null" },
    ),
    sourceUrl: text("source_url").notNull(),
    title: text("title"),
    category: text("category"),
    status: text("status").notNull().default("active"),
    sourceType: text("source_type").notNull().default("custom"),
    etag: text("etag"),
    lastModified: text("last_modified"),
    lastFetchedAt: integer("last_fetched_at", { mode: "timestamp" }),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    userSourceUnique: uniqueIndex("rss_subscriptions_user_url_idx").on(
      table.userId,
      table.sourceUrl,
    ),
  }),
);

export type RssSubscription = InferSelectModel<typeof rssSubscriptions>;

export const rssItems = sqliteTable(
  "rss_items",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => rssSubscriptions.id, { onDelete: "cascade" }),
    guidHash: text("guid_hash").notNull(),
    title: text("title"),
    summary: text("summary"),
    content: text("content"),
    link: text("link"),
    publishedAt: integer("published_at", { mode: "timestamp" }),
    fetchedAt: integer("fetched_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    status: text("status").notNull().default("pending"),
    metadata: text("metadata"), // JSON string
  },
  (table) => ({
    subscriptionGuidUnique: uniqueIndex("rss_items_subscription_guid_idx").on(
      table.subscriptionId,
      table.guidHash,
    ),
    publishedIdx: index("rss_items_published_idx").on(table.publishedAt),
  }),
);

export type RssItem = InferSelectModel<typeof rssItems>;
export type InsertRssItem = InferInsertModel<typeof rssItems>;

// ============================================================================
// Bot
// ============================================================================

export const bot = sqliteTable("Bot", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("userId")
    .notNull()
    .references(() => user.id),
  platformAccountId: text("platform_account_id").references(
    () => integrationAccounts.id,
    {
      onDelete: "cascade",
    },
  ),
  name: text("name").notNull(),
  description: text("description").notNull(),
  adapter: text("adapter").notNull(),
  adapterConfig: text("adapter_config").notNull(), // JSON string
  enable: integer("enable", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type Bot = InferSelectModel<typeof bot>;

// ============================================================================
// Insight
// ============================================================================

type HistorySummary = {
  title: string;
  content: string;
};

type StrategicAnalysis = {
  relationship: string;
  opportunity: string;
  risk: string;
};

type Strategic = StrategicAnalysis;

type Action = InsightAction;

type Stakeholder = InsightStakeholder;

type Task = InsightTaskItem;

type RiskFlag = InsightRiskFlag;

type ActionRequiredDetails = InsightActionRequirementDetails;

type StoredInsight = {
  category: string;
  value: string;
  confidence: number;
  evidence?: string[];
  byRole?: string | null;
};

type InsightStakeholder = {
  name: string;
  role?: string | null;
};

type InsightTopVoice = {
  user: string;
  influenceScore: number;
};

export type InsightAction = {
  action?: string | null;
  owner?: string | null;
  eta?: string | null;
  reason?: string | null;
  confidence?: number | null;
  byRole?: string | null;
};

type InsightSource = {
  platform?: string | null;
  snippet: string;
  link?: string | null;
};

type InsightActionRequirementDetails = {
  who?: string | null;
  what?: string | null;
  when?: string | null;
};

export type InsightTaskStatus =
  | "pending"
  | "completed"
  | "blocked"
  | "delegated";

export type InsightTaskItem = {
  id?: string | null;
  title?: string | null;
  context?: string | null;
  owner?: string | null;
  ownerType?: string | null;
  requester?: string | null;
  requesterId?: string | null;
  responder?: string | null;
  responderId?: string | null;
  deadline?: string | null;
  rawDeadline?: string | null;
  followUpAt?: string | null;
  followUpNote?: string | null;
  lastFollowUpAt?: string | null;
  acknowledgedAt?: string | null;
  priority?: string | null;
  status?: InsightTaskStatus | null;
  confidence?: number | null;
  labels?: string[] | null;
  sourceDetailIds?: string[] | null;
  watchers?: string[] | null;
};

type InsightPriority =
  | string
  | {
      value: string;
      reason?: string | null;
    };

type InsightExperimentIdea = {
  idea: string;
  goal?: string | null;
  method?: string | null;
  expectedSignal?: string | null;
};

export type InsightRiskFlag = {
  issue: string;
  owner?: string | null;
  eta?: string | null;
  impact?: string | null;
  confidence?: number | null;
};

type InsightFollowUp = {
  action: string;
  reason?: string | null;
  confidence?: number | null;
};

type InsightRoleAttribution = {
  winner?: string[];
  conflicts?: Array<{
    field: string;
    candidates: Array<{
      role: string;
      value?: unknown;
      confidence?: number | null;
    }>;
    resolvedBy?: string | null;
  }>;
};

type InsightAlert = {
  code: string;
  message: string;
  insightId?: string | null;
};

export const insight = sqliteTable("Insight", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  botId: text("botId").notNull(),
  dedupeKey: text("dedupe_key"),
  taskLabel: text("taskLabel").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  importance: text("importance").notNull(),
  urgency: text("urgency").notNull(),
  platform: text("platform"),
  account: text("account"),
  groups: text("groups").notNull().default("[]").$type<string[]>(), // JSON array string
  people: text("people").notNull().default("[]").$type<string[]>(), // JSON array string
  time: integer("time", { mode: "timestamp" }).notNull(),
  details: text("details").$type<DetailData[] | null>(), // JSON string
  timeline: text("timeline").$type<TimelineData[] | null>(), // JSON string
  insights: text("insights").$type<StoredInsight[] | null>(), // JSON string
  trendDirection: text("trend_direction"),
  trendConfidence: text("trend_confidence").$type<number | null>(), // Numeric as text
  sentiment: text("sentiment"),
  sentimentConfidence: text("sentiment_confidence").$type<number | null>(), // Numeric as text
  intent: text("intent"),
  trend: text("trend"),
  issueStatus: text("issue_status"),
  communityTrend: text("community_trend"),
  duplicateFlag: integer("duplicate_flag", { mode: "boolean" }),
  impactLevel: text("impact_level"),
  resolutionHint: text("resolution_hint"),
  topKeywords: text("top_keywords").default("[]").$type<string[]>(), // JSON array string
  topEntities: text("top_entities").default("[]").$type<string[]>(), // JSON array string
  topVoices: text("top_voices").$type<InsightTopVoice[] | null>(), // JSON string
  sources: text("sources").$type<InsightSource[] | null>(), // JSON string
  sourceConcentration: text("source_concentration"),
  buyerSignals: text("buyer_signals").default("[]").$type<string[]>(), // JSON array string
  stakeholders: text("stakeholders").$type<InsightStakeholder[] | null>(), // JSON string
  contractStatus: text("contract_status"),
  signalType: text("signal_type"),
  confidence: text("confidence").$type<number | null>(), // Numeric as text
  scope: text("scope"),
  nextActions: text("next_actions").$type<InsightAction[] | null>(), // JSON string
  followUps: text("follow_ups").$type<InsightFollowUp[] | null>(), // JSON string
  actionRequired: integer("action_required", { mode: "boolean" }),
  actionRequiredDetails: text(
    "action_required_details",
  ).$type<InsightActionRequirementDetails | null>(), // JSON string
  isUnreplied: integer("is_unreplied", { mode: "boolean" }).default(false),
  myTasks: text("my_tasks").$type<InsightTaskItem[] | null>(), // JSON string
  waitingForMe: text("waiting_for_me").$type<InsightTaskItem[] | null>(), // JSON string
  waitingForOthers: text("waiting_for_others").$type<
    InsightTaskItem[] | null
  >(), // JSON string
  clarifyNeeded: integer("clarify_needed", { mode: "boolean" }),
  categories: text("categories").default("[]").$type<string[]>(), // JSON array string
  learning: text("learning"),
  priority: text("priority").$type<InsightPriority | null>(), // JSON string
  experimentIdeas: text("experiment_ideas").$type<
    InsightExperimentIdea[] | null
  >(), // JSON string
  executiveSummary: text("executive_summary"),
  riskFlags: text("risk_flags").$type<InsightRiskFlag[] | null>(), // JSON string
  client: text("client"),
  projectName: text("project_name"),
  nextMilestone: text("next_milestone"),
  dueDate: text("due_date"),
  paymentInfo: text("payment_info"),
  entity: text("entity"),
  why: text("why"),
  historySummary: text("history_summary").$type<HistorySummary | null>(), // JSON string
  strategic: text("strategic").$type<Strategic | null>(), // JSON string
  roleAttribution: text(
    "role_attribution",
  ).$type<InsightRoleAttribution | null>(), // JSON string
  alerts: text("alerts").$type<InsightAlert[] | null>(), // JSON string
  compactedIntoInsightId: text("compacted_into_insight_id"),
  pendingDeletionAt: integer("pending_deletion_at", { mode: "timestamp" }),
  isArchived: integer("is_archived", { mode: "boolean" })
    .notNull()
    .default(false),
  isFavorited: integer("is_favorited", { mode: "boolean" })
    .notNull()
    .default(false),
  archivedAt: integer("archived_at", { mode: "timestamp" }),
  favoritedAt: integer("favorited_at", { mode: "timestamp" }),
  // Temporal validity - enables time-travel queries
  validFrom: integer("valid_from", { mode: "timestamp" }),
  validTo: integer("valid_to", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  timelineVersion: integer("timeline_version").notNull().default(1),
  lastTimelineUpdate: integer("last_timeline_update", { mode: "timestamp" }),
});

export type Insight = InferSelectModel<typeof insight>;
export type InsertInsight = InferInsertModel<typeof insight>;

export const insightEmbeddings = sqliteTable(
  "insight_embeddings",
  {
    insightId: text("insight_id")
      .primaryKey()
      .references(() => insight.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => bot.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    embedding: text("embedding").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    embeddingDimensions: integer("embedding_dimensions").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    userIdx: index("insight_embeddings_user_idx").on(table.userId),
    botIdx: index("insight_embeddings_bot_idx").on(table.botId),
    modelIdx: index("insight_embeddings_model_idx").on(table.embeddingModel),
    updatedAtIdx: index("insight_embeddings_updated_at_idx").on(
      table.updatedAt,
    ),
  }),
);

export type InsightEmbedding = InferSelectModel<typeof insightEmbeddings>;
export type InsertInsightEmbedding = InferInsertModel<typeof insightEmbeddings>;

export const insightCompactionLinks = sqliteTable(
  "insight_compaction_links",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    compactedInsightId: text("compacted_insight_id")
      .notNull()
      .references(() => insight.id, { onDelete: "cascade" }),
    sourceInsightId: text("source_insight_id")
      .notNull()
      .references(() => insight.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    uniqueCompactedSource: uniqueIndex(
      "insight_compaction_links_compacted_source_idx",
    ).on(table.compactedInsightId, table.sourceInsightId),
    userIdx: index("insight_compaction_links_user_idx").on(table.userId),
    compactedIdx: index("insight_compaction_links_compacted_idx").on(
      table.compactedInsightId,
    ),
    sourceIdx: index("insight_compaction_links_source_idx").on(
      table.sourceInsightId,
    ),
  }),
);

export type InsightCompactionLink = InferSelectModel<
  typeof insightCompactionLinks
>;
export type InsertInsightCompactionLink = InferInsertModel<
  typeof insightCompactionLinks
>;
// ============================================================================
// Insight Notes
// ============================================================================

// Insight Notes Table
// Stores user notes/comments on insights
export const insightNotes = sqliteTable("insight_notes", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  insightId: text("insight_id")
    .notNull()
    .references(() => insight.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id),
  content: text("content").notNull(),
  source: text("source", {
    enum: ["manual", "ai_conversation"],
  })
    .notNull()
    .default("manual"),
  sourceMessageId: text("source_message_id"), // Optional: reference to message if from AI conversation
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type InsightNote = InferSelectModel<typeof insightNotes>;
export type InsertInsightNote = InferInsertModel<typeof insightNotes>;

// ============================================================================
// Insight Brief Categories
// ============================================================================

// Insight Brief Categories Table
// Stores user's manual category assignments for insights in Brief panel
export const insightBriefCategories = sqliteTable(
  "insight_brief_categories",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    insightId: text("insight_id")
      .notNull()
      .references(() => insight.id, { onDelete: "cascade" }),
    category: text("category", {
      enum: ["urgent", "important", "monitor", "archive"],
    }).notNull(),
    dedupeKey: text("dedupe_key"), // For exact matching similar insights
    title: text("title"), // For fuzzy matching similar insights
    assignedAt: integer("assigned_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    source: text("source", { enum: ["manual", "auto", "unpinned"] })
      .notNull()
      .default("manual"),
  },
  (table) => ({
    uniqueUserInsight: uniqueIndex(
      "insight_brief_categories_user_insight_idx",
    ).on(table.userId, table.insightId),
    userIdx: index("insight_brief_categories_user_idx").on(table.userId),
    dedupeKeyIdx: index("insight_brief_categories_dedupe_idx").on(
      table.dedupeKey,
    ),
    categoryIdx: index("insight_brief_categories_category_idx").on(
      table.category,
    ),
    assignedAtIdx: index("insight_brief_categories_assigned_at_idx").on(
      table.assignedAt,
    ),
  }),
);

export type InsightBriefCategory = InferSelectModel<
  typeof insightBriefCategories
>;
export type InsertInsightBriefCategory = InferInsertModel<
  typeof insightBriefCategories
>;

// ============================================================================
// Insight Documents
// ============================================================================

// Insight Documents Table
// Associates documents with insights
export const insightDocuments = sqliteTable("insight_documents", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  insightId: text("insight_id")
    .notNull()
    .references(() => insight.id, { onDelete: "cascade" }),
  documentId: text("document_id")
    .notNull()
    .references(() => ragDocuments.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type InsightDocument = InferSelectModel<typeof insightDocuments>;
export type InsertInsightDocument = InferInsertModel<typeof insightDocuments>;

// ============================================================================
// Insight Settings & Filters
// ============================================================================

export const userInsightSettings = sqliteTable("user_insight_settings", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("userId")
    .notNull()
    .references(() => user.id),
  focusPeople: text("focus_people").notNull().default("[]"), // JSON array string
  focusTopics: text("focus_topics").notNull().default("[]"), // JSON array string
  language: text("language").notNull().default(""),
  refreshIntervalMinutes: integer("refresh_interval_minutes")
    .notNull()
    .default(60),
  aiSoulPrompt: text("ai_soul_prompt"),
  /** User manually filled industry (JSON array string), max 4 items */
  identityIndustries: text("identity_industries"),
  /** User manually filled work description, max 5000 characters */
  identityWorkDescription: text("identity_work_description"),
  lastMessageProcessedAt: integer("last_message_processed_at", {
    mode: "timestamp",
  }),
  lastActiveAt: integer("last_active_at", { mode: "timestamp" }),
  lastInsightMaintenanceRunAt: integer("last_insight_maintenance_run_at", {
    mode: "timestamp",
  }),
  lastInsightEmbeddingDreamRunAt: integer(
    "last_insight_embedding_dream_run_at",
    {
      mode: "timestamp",
    },
  ),
  activityTier: text("activity_tier").notNull().default("low"),
  lastUpdated: integer("last_updated", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type DBInsightSettings = InferSelectModel<typeof userInsightSettings>;
export type DBInsertInsightSettings = InferInsertModel<
  typeof userInsightSettings
>;

export const userLlmApiSettings = sqliteTable(
  "user_llm_api_settings",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    providerType: text("provider_type")
      .$type<"openai_compatible" | "anthropic_compatible">()
      .notNull(),
    apiKeyEncrypted: text("api_key_encrypted"),
    encryptionKeyId: text("encryption_key_id"),
    baseUrl: text("base_url"),
    model: text("model"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    uniqueUserProvider: uniqueIndex(
      "user_llm_api_settings_user_provider_idx",
    ).on(table.userId, table.providerType),
    userIdx: index("user_llm_api_settings_user_idx").on(table.userId),
  }),
);

export type UserLlmApiSettings = InferSelectModel<typeof userLlmApiSettings>;
export type InsertUserLlmApiSettings = InferInsertModel<
  typeof userLlmApiSettings
>;

const KNOWN_ACTIVITY_TIERS = new Set(["high", "medium", "low", "dormant"]);

export const insightTimelineHistory = sqliteTable(
  "insight_timeline_history",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    insightId: text("insight_id")
      .notNull()
      .references(() => insight.id, { onDelete: "cascade" }),
    timelineEventId: text("timeline_event_id").notNull(),
    version: integer("version").notNull(),
    eventTime: text("event_time"), // Numeric as text
    summary: text("summary").notNull(),
    label: text("label").notNull(),
    changeType: text("change_type").notNull(),
    changeReason: text("change_reason").notNull(),
    changedBy: text("changed_by").notNull().default("system"),
    previousSnapshot: text("previous_snapshot").$type<Record<
      string,
      unknown
    > | null>(), // JSON object
    diffSummary: text("diff_summary"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    sourceMessageId: text("source_message_id"),
  },
  (table) => ({
    insightIdIdx: index("timeline_history_insight_idx").on(table.insightId),
    timelineEventIdIdx: index("timeline_history_event_idx").on(
      table.timelineEventId,
    ),
    createdAtIdx: index("timeline_history_created_idx").on(table.createdAt),
    insightEventIdx: index("timeline_history_insight_event_idx").on(
      table.insightId,
      table.timelineEventId,
    ),
  }),
);

export type InsightTimelineHistory = InferSelectModel<
  typeof insightTimelineHistory
>;
export type InsertInsightTimelineHistory = InferInsertModel<
  typeof insightTimelineHistory
>;

// Insight Processing Failures
export const insightProcessingFailures = sqliteTable(
  "insight_processing_failures",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    botId: text("bot_id")
      .notNull()
      .references(() => bot.id, { onDelete: "cascade" }),
    groupName: text("group_name").notNull(),
    failureCount: integer("failure_count").notNull().default(1),
    status: text("status").notNull().default("pending"), // pending | retrying | skipped
    lastError: text("last_error"),
    lastAttemptedAt: integer("last_attempted_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    processedSince: integer("processed_since").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    // Unique constraint: one record per bot per group
    uniqueBotGroup: uniqueIndex("insight_failures_bot_group_idx").on(
      table.botId,
      table.groupName,
    ),
    // Query optimization: fast lookup for retry candidates
    botStatusIdx: index("insight_failures_bot_status_idx").on(
      table.botId,
      table.status,
    ),
    // Cleanup optimization: find expired failure records
    attemptedAtIdx: index("insight_failures_attempted_idx").on(
      table.lastAttemptedAt,
    ),
  }),
);

export type InsightProcessingFailure = InferSelectModel<
  typeof insightProcessingFailures
>;
export type InsertInsightProcessingFailure = InferInsertModel<
  typeof insightProcessingFailures
>;

// ============================================================================
// Helper Functions (ported from PG schema)
// ============================================================================

function normalizeActivityTier(
  tier?: string | null,
): "high" | "medium" | "low" | "dormant" {
  if (tier && KNOWN_ACTIVITY_TIERS.has(tier)) {
    return tier as "high" | "medium" | "low" | "dormant";
  }
  return "low";
}

export type InsightSettings = {
  id?: string;
  userId: string;
  focusPeople: string[];
  focusTopics: string[];
  language: string;
  refreshIntervalMinutes: number;
  aiSoulPrompt: string | null;
  identityIndustries: string[] | null;
  identityWorkDescription: string | null;
  lastMessageProcessedAt: Date | null;
  lastActiveAt: Date | null;
  lastInsightMaintenanceRunAt?: Date | null;
  lastInsightEmbeddingDreamRunAt?: Date | null;
  activityTier: "high" | "medium" | "low" | "dormant";
  lastUpdated: Date;
};

export function parseInsightSettings(
  dbSettings: DBInsightSettings,
): InsightSettings {
  return {
    id: dbSettings.id,
    userId: dbSettings.userId,
    focusPeople: Array.isArray(dbSettings.focusPeople)
      ? dbSettings.focusPeople
      : JSON.parse(dbSettings.focusPeople),
    focusTopics: Array.isArray(dbSettings.focusTopics)
      ? dbSettings.focusTopics
      : JSON.parse(dbSettings.focusTopics),
    language: dbSettings.language,
    refreshIntervalMinutes: dbSettings.refreshIntervalMinutes ?? 30,
    aiSoulPrompt: dbSettings.aiSoulPrompt ?? null,
    identityIndustries:
      dbSettings.identityIndustries != null
        ? (JSON.parse(dbSettings.identityIndustries) as string[])
        : null,
    identityWorkDescription: dbSettings.identityWorkDescription ?? null,
    lastMessageProcessedAt: dbSettings.lastMessageProcessedAt ?? null,
    lastActiveAt: dbSettings.lastActiveAt ?? null,
    lastInsightMaintenanceRunAt: dbSettings.lastInsightMaintenanceRunAt ?? null,
    lastInsightEmbeddingDreamRunAt:
      dbSettings.lastInsightEmbeddingDreamRunAt ?? null,
    activityTier: normalizeActivityTier(dbSettings.activityTier),
    lastUpdated: dbSettings.lastUpdated,
  };
}

export function serializeInsightSettings(
  settings: InsightSettings,
): Omit<DBInsertInsightSettings, "id" | "lastUpdated"> {
  return {
    userId: settings.userId,
    focusPeople: JSON.stringify(settings.focusPeople),
    focusTopics: JSON.stringify(settings.focusTopics),
    language: settings.language,
    refreshIntervalMinutes: settings.refreshIntervalMinutes,
    aiSoulPrompt: settings.aiSoulPrompt ?? null,
    identityIndustries:
      settings.identityIndustries != null &&
      settings.identityIndustries.length > 0
        ? JSON.stringify(settings.identityIndustries)
        : null,
    identityWorkDescription: settings.identityWorkDescription ?? null,
    lastMessageProcessedAt: settings.lastMessageProcessedAt,
    lastActiveAt: settings.lastActiveAt,
    lastInsightMaintenanceRunAt: settings.lastInsightMaintenanceRunAt,
    lastInsightEmbeddingDreamRunAt: settings.lastInsightEmbeddingDreamRunAt,
    activityTier: settings.activityTier,
  };
}

// ============================================================================
// RAG (Retrieval-Augmented Generation) Tables
// ============================================================================

export const ragDocuments = sqliteTable("rag_documents", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  totalChunks: integer("total_chunks").notNull().default(0),
  blobPath: text("blob_path"), // Path to the original binary file (e.g., Vercel Blob URL or local file path)
  uploadedAt: integer("uploaded_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  metadata: text("metadata"), // JSON string
});

export type RAGDocument = InferSelectModel<typeof ragDocuments>;
export type InsertRAGDocument = InferInsertModel<typeof ragDocuments>;

export const ragChunks = sqliteTable(
  "rag_chunks",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => ragDocuments.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    embedding: text("embedding"), // JSON array string for vector, nullable for skipEmbeddings mode
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    metadata: text("metadata"), // JSON string
  },
  (table) => ({
    documentIdIdx: index("rag_chunks_document_idx").on(table.documentId),
    userIdx: index("rag_chunks_user_idx").on(table.userId),
    documentChunkIdx: uniqueIndex("rag_chunks_doc_chunk_idx").on(
      table.documentId,
      table.chunkIndex,
    ),
  }),
);

export type RAGChunk = InferSelectModel<typeof ragChunks>;
export type InsertRAGChunk = InferInsertModel<typeof ragChunks>;

// ============================================================================
// Missing Tables (converted from PostgreSQL schema)
// ============================================================================

// User Subscriptions
export const userSubscriptions = sqliteTable(
  "user_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    planName: text("plan_name").notNull(),
    startDate: integer("start_date", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    endDate: integer("end_date", { mode: "timestamp" }),
    isActive: integer("is_active", { mode: "boolean" }).default(true),
    autoRenew: integer("auto_renew", { mode: "boolean" }).default(true),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripeCustomerId: text("stripe_customer_id"),
    stripePriceId: text("stripe_price_id"),
    status: text("status").default("incomplete").notNull(),
    billingCycle: text("billing_cycle"),
    lastPaymentDate: integer("last_payment_date", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    affiliateId: text("affiliate_id"),
    affiliateCode: text("affiliate_code"),
    affiliateCommissionRate: text("affiliate_commission_rate"), // numeric as text
  },
  (table) => ({
    uniqueUserSubscription: uniqueIndex("unique_user_subscription").on(
      table.userId,
      table.isActive,
    ),
  }),
);

export type UserSubscription = InferSelectModel<typeof userSubscriptions>;
export type InsertUserSubscription = InferInsertModel<typeof userSubscriptions>;

// Insight Filters
export const insightFilters = sqliteTable(
  "insight_filters",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    color: text("color"),
    icon: text("icon"),
    sortOrder: integer("sort_order").notNull().default(0),
    isPinned: integer("is_pinned", { mode: "boolean" })
      .notNull()
      .default(false),
    isArchived: integer("is_archived", { mode: "boolean" })
      .notNull()
      .default(false),
    source: text("source").notNull().default("user"),
    definition: text("definition").notNull(), // JSON string
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    userSlugIdx: uniqueIndex("insight_filters_user_slug_idx").on(
      table.userId,
      table.slug,
    ),
    userIdx: index("insight_filters_user_idx").on(table.userId),
  }),
);

export type DBInsightFilter = InferSelectModel<typeof insightFilters>;
export type DBInsertInsightFilter = InferInsertModel<typeof insightFilters>;

// Insight Tabs
export const insightTabs = sqliteTable(
  "insight_tabs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    icon: text("icon"),
    filterIds: text("filter_ids").$type<string[]>(), // JSON array string
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    userIdIdx: index("insight_tabs_user_idx").on(table.userId),
  }),
);

export type DBInsightTab = InferSelectModel<typeof insightTabs>;
export type DBInsertInsightTab = InferInsertModel<typeof insightTabs>;

// User Categories
export const userCategories = sqliteTable(
  "user_categories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    color: text("color"),
    icon: text("icon"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    userIdIdx: index("user_categories_user_idx").on(table.userId),
    userIdNameIdx: uniqueIndex("user_categories_user_name_idx").on(
      table.userId,
      table.name,
    ),
  }),
);

export type DBUserCategory = InferSelectModel<typeof userCategories>;
export type DBInsertUserCategory = InferInsertModel<typeof userCategories>;

// User Contacts
export const userContacts = sqliteTable(
  "user_meta_contacts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    contactId: text("contact_id").notNull(),
    contactName: text("contact_name").notNull(),
    type: text("contact_type"),
    botId: text("bot_id"),
    contactMeta: text("contact_meta"), // JSON string
  },
  (table) => ({
    uniqueUserContact: uniqueIndex("unique_user_contact").on(
      table.userId,
      table.botId,
      table.contactName,
    ),
  }),
);

export type UserContact = InferSelectModel<typeof userContacts>;
export type InsertUserContact = InferInsertModel<typeof userContacts>;

/** DingTalk inbound message cache (Insight), aligned with PostgreSQL table name */
export const dingtalkBotInsightMessages = sqliteTable(
  "dingtalk_bot_insight_messages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    botId: text("bot_id")
      .notNull()
      .references(() => bot.id),
    chatId: text("chat_id").notNull(),
    msgId: text("msg_id").notNull(),
    senderId: text("sender_id"),
    senderName: text("sender_name"),
    text: text("text").notNull(),
    tsSec: integer("ts_sec").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    uniqBotMsgId: uniqueIndex("dingtalk_bot_insight_msg_bot_msgid_idx").on(
      table.botId,
      table.msgId,
    ),
    lookupIdx: index("dingtalk_bot_insight_msg_lookup_idx").on(
      table.userId,
      table.botId,
      table.chatId,
      table.tsSec,
    ),
  }),
);

export type DingtalkBotInsightMessage = InferSelectModel<
  typeof dingtalkBotInsightMessages
>;

// Feedback
export const feedback = sqliteTable(
  "feedback",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }), // Optional: supports anonymous feedback
    contactEmail: text("contact_email"), // Optional: contact email for anonymous users
    content: text("content").notNull(),
    type: text("type").notNull(), // 'bug', 'feature', 'improvement', 'general'
    title: text("title").notNull(),
    description: text("description").notNull(),
    status: text("status").notNull().default("open"), // 'open', 'in_progress', 'resolved', 'closed'
    priority: text("priority").default("medium"), // 'low', 'medium', 'high', 'urgent'
    source: text("source").default("web"), // 'web', 'desktop', 'api'
    systemInfo: text("system_info"), // JSON string: System info (platform, version, etc.)
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    userIdIdx: index("feedback_user_idx").on(table.userId),
    statusIdx: index("feedback_status_idx").on(table.status),
  }),
);

export type Feedback = InferSelectModel<typeof feedback>;
export type InsertFeedback = InferInsertModel<typeof feedback>;

// Survey
export const survey = sqliteTable(
  "survey",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    industry: text("industry").notNull(), // Industry
    role: text("role").notNull(), // Role
    roles: text("roles").default("[]"), // Multi-role selection, JSON array string
    otherRole: text("other_role"), // Other role
    size: text("size").notNull(), // Company size
    communicationTools: text("communication_tools").notNull().default("[]"), // Communication tools, JSON array string
    dailyMessages: text("daily_messages").notNull(), // Daily message volume
    challenges: text("challenges").notNull().default("[]"), // Pain points/issues, JSON array string
    workDescription: text("work_description"), // Work description
    submittedAt: integer("submitted_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`), // Submission time
  },
  (table) => ({
    userIdIdx: index("survey_user_idx").on(table.userId),
  }),
);

export type Survey = InferSelectModel<typeof survey>;
export type InsertSurvey = InferInsertModel<typeof survey>;

// Report Events
export const reportEvents = sqliteTable(
  "report_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    cadence: text("cadence").notNull().default("weekly"),
    sourceType: text("source_type").notNull(),
    provider: text("provider").notNull(),
    sourceId: text("source_id").notNull(),
    occurredAt: integer("occurred_at", { mode: "timestamp" }).notNull(),
    importance: text("importance").notNull().default("medium"),
    topicKey: text("topic_key"),
    summary: text("summary").notNull(),
    metadata: text("metadata"), // JSON string
    ingestedAt: integer("ingested_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    weekBucket: text("week_bucket").notNull(), // Date as ISO string
    monthBucket: text("month_bucket"), // Date as ISO string
    dedupeHash: text("dedupe_hash").notNull(),
  },
  (table) => ({
    uniqueEvent: uniqueIndex("report_events_user_source_idx").on(
      table.userId,
      table.sourceType,
      table.sourceId,
    ),
    dedupe: uniqueIndex("report_events_dedupe_idx").on(
      table.userId,
      table.dedupeHash,
    ),
    weekIdx: index("report_events_user_week_idx").on(
      table.userId,
      table.weekBucket,
    ),
  }),
);

export type ReportEvent = InferSelectModel<typeof reportEvents>;
export type InsertReportEvent = InferInsertModel<typeof reportEvents>;

// User Email Preferences
export const userEmailPreferences = sqliteTable(
  "user_email_preferences",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    marketingOptIn: integer("marketing_opt_in", { mode: "boolean" })
      .notNull()
      .default(sql`1`),
    marketingOptedOutAt: integer("marketing_opted_out_at", {
      mode: "timestamp",
    }),
    unsubscribeToken: text("unsubscribe_token").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    lastEmailSentAt: integer("last_email_sent_at", { mode: "timestamp" }),
  },
  (table) => ({
    uniqueUnsubscribeToken: uniqueIndex(
      "user_email_preferences_unsubscribe_token_key",
    ).on(table.unsubscribeToken),
  }),
);

export type UserEmailPreferences = InferSelectModel<
  typeof userEmailPreferences
>;

// Marketing Email Log
export const marketingEmailLog = sqliteTable(
  "marketing_email_log",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    stage: text("stage").notNull(),
    template: text("template").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status").notNull().default("sent"),
    error: text("error"),
    metadata: text("metadata"), // JSON string
    sentAt: integer("sent_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    dedupe: uniqueIndex("marketing_email_log_dedupe_idx").on(
      table.userId,
      table.dedupeKey,
    ),
    stageIdx: index("marketing_email_log_stage_idx").on(
      table.stage,
      table.sentAt,
    ),
  }),
);

export type MarketingEmailLog = InferSelectModel<typeof marketingEmailLog>;

// Weekly Reports
export const weeklyReports = sqliteTable(
  "weekly_reports",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    cadence: text("cadence").notNull().default("weekly"),
    rangeStart: text("range_start").notNull(), // Date as ISO string
    rangeEnd: text("range_end").notNull(), // Date as ISO string
    status: text("status").notNull().default("draft"),
    structuredPayload: text("structured_payload").notNull(), // JSON string
    markdown: text("markdown").notNull(),
    generatedAt: integer("generated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    editedAt: integer("edited_at", { mode: "timestamp" }),
    sentAt: integer("sent_at", { mode: "timestamp" }),
    sourceStats: text("source_stats"), // JSON string
    modelVersion: text("model_version").notNull(),
    checksum: text("checksum"),
  },
  (table) => ({
    uniqueRange: uniqueIndex("weekly_reports_user_role_range_idx").on(
      table.userId,
      table.role,
      table.rangeStart,
      table.cadence,
    ),
    rangeIdx: index("weekly_reports_range_idx").on(
      table.userId,
      table.rangeStart,
      table.rangeEnd,
    ),
  }),
);

export type WeeklyReport = InferSelectModel<typeof weeklyReports>;
export type InsertWeeklyReport = InferInsertModel<typeof weeklyReports>;

// Weekly Report Revisions
export const weeklyReportRevisions = sqliteTable(
  "weekly_report_revisions",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id")
      .notNull()
      .references(() => weeklyReports.id, { onDelete: "cascade" }),
    snapshotType: text("snapshot_type").notNull().default("system"),
    payload: text("payload").notNull(), // JSON string
    markdown: text("markdown").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    reportIdx: index("weekly_report_revisions_report_idx").on(table.reportId),
  }),
);

export type WeeklyReportRevision = InferSelectModel<
  typeof weeklyReportRevisions
>;
export type InsertWeeklyReportRevision = InferInsertModel<
  typeof weeklyReportRevisions
>;

// People Graph Snapshot
export const peopleGraphSnapshot = sqliteTable(
  "people_graph_snapshot",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    nodes: text("nodes").notNull(), // JSON string
    edges: text("edges").notNull(), // JSON string
    context: text("context").notNull().default(""),
    windowDays: integer("window_days").notNull().default(90),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    uniq: uniqueIndex("people_graph_snapshot_user_idx").on(table.userId),
  }),
);

export type DBPeopleGraphSnapshot = InferSelectModel<
  typeof peopleGraphSnapshot
>;
export type DBInsertPeopleGraphSnapshot = InferInsertModel<
  typeof peopleGraphSnapshot
>;

// Person Custom Fields
export const personCustomFields = sqliteTable(
  "person_custom_fields",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    personId: text("person_id").notNull(),
    fields: text("fields").notNull().default("{}"), // JSON string
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    uniq: uniqueIndex("person_custom_fields_user_person_idx").on(
      table.userId,
      table.personId,
    ),
  }),
);

export type DBPersonCustomFields = InferSelectModel<typeof personCustomFields>;
export type DBInsertPersonCustomFields = InferInsertModel<
  typeof personCustomFields
>;

// User Roles
export const userRoles = sqliteTable(
  "user_roles",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    roleKey: text("role_key").notNull(), // Role key like 'admin', 'user', 'moderator', etc.
    source: text("source").notNull(), // Where this role came from: 'profile', 'inferred', etc.
    confidence: text("confidence").notNull().default("0.5").$type<number>(), // Confidence score as text (SQLite doesn't have numeric type)
    firstDetectedAt: integer("first_detected_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    lastConfirmedAt: integer("last_confirmed_at", { mode: "timestamp" }),
    evidence: text("evidence"), // JSON string for evidence object
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    userIdIdx: index("user_roles_user_idx").on(table.userId, table.roleKey), // Aligned with PG: composite index
    uniqueRole: uniqueIndex("user_roles_unique").on(
      // Aligned with PG: includes source
      table.userId,
      table.roleKey,
      table.source,
    ),
  }),
);

export type UserRole = InferSelectModel<typeof userRoles>;
export type InsertUserRole = InferInsertModel<typeof userRoles>;

// Telegram Accounts
export const telegramAccounts = sqliteTable(
  "telegram_accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    telegramUserId: text("telegram_user_id").notNull(),
    telegramChatId: text("telegram_chat_id").notNull(),
    username: text("username"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    languageCode: text("language_code"),
    isBot: integer("is_bot", { mode: "boolean" }).notNull().default(false),
    linkedAt: integer("linked_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    lastCommandAt: integer("last_command_at", { mode: "timestamp" }),
  },
  (table) => ({
    uniqueTelegramUser: uniqueIndex("telegram_accounts_telegram_user_idx").on(
      table.telegramUserId,
    ),
    telegramUserPerUser: uniqueIndex(
      "telegram_accounts_user_and_telegram_idx",
    ).on(table.userId, table.telegramUserId),
    telegramUserLookup: index("telegram_accounts_user_idx").on(table.userId),
  }),
);

export type TelegramAccount = InferSelectModel<typeof telegramAccounts>;
export type InsertTelegramAccount = InferInsertModel<typeof telegramAccounts>;

// WhatsApp Accounts
export const whatsappAccounts = sqliteTable(
  "whatsapp_accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    whatsappUserId: text("whatsapp_user_id").notNull(), // Phone number
    username: text("username"),
    pushName: text("push_name"),
    linkedAt: integer("linked_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    lastCommandAt: integer("last_command_at", { mode: "timestamp" }),
  },
  (table) => ({
    uniqueWhatsappUser: uniqueIndex("whatsapp_accounts_whatsapp_user_idx").on(
      table.whatsappUserId,
    ),
    whatsappUserPerUser: uniqueIndex(
      "whatsapp_accounts_user_and_whatsapp_idx",
    ).on(table.userId, table.whatsappUserId),
    whatsappUserLookup: index("whatsapp_accounts_user_idx").on(table.userId),
  }),
);

export type WhatsAppAccount = InferSelectModel<typeof whatsappAccounts>;
export type InsertWhatsAppAccount = InferInsertModel<typeof whatsappAccounts>;

// Discord Accounts
export const discordAccounts = sqliteTable(
  "discord_accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    discordUserId: text("discord_user_id").notNull(),
    discordGuildId: text("discord_guild_id"),
    discordChannelId: text("discord_channel_id"),
    username: text("username"),
    globalName: text("global_name"),
    linkedAt: integer("linked_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    lastCommandAt: integer("last_command_at", { mode: "timestamp" }),
  },
  (table) => ({
    uniqueDiscordUser: uniqueIndex("discord_accounts_discord_user_idx").on(
      table.discordUserId,
    ),
    discordUserPerUser: uniqueIndex("discord_accounts_user_and_discord_idx").on(
      table.userId,
      table.discordUserId,
    ),
    discordUserLookup: index("discord_accounts_user_idx").on(table.userId),
  }),
);

export type DiscordAccount = InferSelectModel<typeof discordAccounts>;
export type InsertDiscordAccount = InferInsertModel<typeof discordAccounts>;

// ============================================================================
// Quota & Credits
// ============================================================================

// User Free Quota
export const userFreeQuota = sqliteTable(
  "user_free_quota",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    totalQuota: integer("total_quota").notNull().default(100), // Default free tier quota
    usedQuota: integer("used_quota").notNull().default(0),
    lastAdjustedAt: integer("last_adjusted_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    uniqueUser: uniqueIndex("unique_free_user").on(table.userId),
  }),
);

export type UserFreeQuota = InferSelectModel<typeof userFreeQuota>;

// User Monthly Quota
export const userMonthlyQuota = sqliteTable(
  "user_monthly_quota",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    year: integer("year").notNull(), // Year (e.g., 2024)
    month: integer("month").notNull(), // Month (1-12)
    totalQuota: integer("total_quota").notNull(), // Monthly total quota (based on subscription plan)
    usedQuota: integer("used_quota").notNull().default(0), // Monthly used quota
    isRefreshed: integer("is_refreshed", { mode: "boolean" }).default(false), // Flag: whether monthly refresh is completed
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    // Unique index: one user can only have one record per month
    uniqueUserMonth: uniqueIndex("unique_user_month").on(
      table.userId,
      table.year,
      table.month,
    ),
  }),
);

export type UserMonthlyQuota = InferSelectModel<typeof userMonthlyQuota>;

// User Reward Events
export const userRewardEvents = sqliteTable(
  "user_reward_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    rewardType: text("reward_type").notNull(),
    status: text("status").notNull().default("available"),
    creditsGranted: integer("credits_granted").notNull().default(0),
    triggerReference: text("trigger_reference"),
    metadata: text("metadata"), // JSON string
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    grantedAt: integer("granted_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    userIdIdx: index("user_reward_events_user_idx").on(table.userId),
    statusIdx: index("user_reward_events_status_idx").on(table.status),
    rewardTypeUnique: uniqueIndex("user_reward_unique_type").on(
      // Aligned with PG
      table.userId,
      table.rewardType,
    ),
  }),
);

export type UserRewardEvent = InferSelectModel<typeof userRewardEvents>;

// User Credit Ledger
export const userCreditLedger = sqliteTable(
  "user_credit_ledger",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(), // Aligned with PG: Positive = credit, Negative = debit
    balanceAfter: integer("balance_after"), // Aligned with PG: allowed to be null
    source: text("source").notNull().default("reward"), // Aligned with PG
    rewardEventId: text("reward_event_id").references(
      () => userRewardEvents.id,
    ), // Aligned with PG
    metadata: text("metadata"), // JSON string
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    userIdIdx: index("user_credit_ledger_user_idx").on(table.userId),
    userIdCreatedAtIdx: index("user_credit_ledger_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
  }),
);

export type UserCreditLedger = InferSelectModel<typeof userCreditLedger>;

// ============================================================================
// Presentation Types
// ============================================================================

export type PresentationTemplateType =
  | "weekly_deck"
  | "project_status"
  | "product_proposal"
  | "account_review"
  | "ops_review"
  | "executive_deck"
  | "pitch"
  | "custom";

export type PresentationJobStatus =
  | "queued"
  | "collecting_sources"
  | "structuring_layers"
  | "preparing_prompt"
  | "gamma_generating"
  | "downloading_artifacts"
  | "ready"
  | "failed"
  | "cancelled";

export type PresentationRequestedFormat = "pptx" | "pdf" | "html";

export type PresentationProgressStepId =
  | "collect_sources"
  | "structure_layers"
  | "reasoning"
  | "prepare_prompt"
  | "gamma_generate"
  | "download_artifacts";

export type PresentationProgressStepStatus = "pending" | "active" | "complete";

export type PresentationJobProgressStep = {
  id: PresentationProgressStepId;
  label: string;
  status: PresentationProgressStepStatus;
  startedAt?: string | null;
  completedAt?: string | null;
};

export type PresentationJobProgress = {
  stage: PresentationJobStatus;
  percent: number;
  steps: PresentationJobProgressStep[];
};

export type PresentationSourceFilters = {
  channels?: string[];
  files?: string[];
  tasks?: string[];
} | null;

export type PresentationStyleProfile = Record<string, unknown> | null;

export type PresentationGammaStatus = {
  status?: string | null;
  gammaUrl?: string | null;
  credits?: {
    deducted?: number | null;
    remaining?: number | null;
  } | null;
  message?: string | null;
} | null;

export type PresentationEventLayerItem = {
  id: string;
  occurredAt: string;
  title: string;
  summary: string;
  category:
    | "highlight"
    | "decision"
    | "risk"
    | "dependency"
    | "request"
    | "milestone";
  importance: "low" | "medium" | "high";
  source: { provider: string; channel?: string; url?: string };
  relatedTasks?: Array<{ id?: string; title?: string; status?: string }>;
  tags?: string[];
};

export type PresentationKnowledgeLayerNode = {
  id: string;
  topic: string;
  problem: string;
  opportunity?: string;
  insights: string[];
  metrics?: Array<{ label: string; value: string; delta?: string }>;
  supportingEvents: string[];
};

export type PresentationReasoningLayerItem = {
  id: string;
  conclusion: string;
  rationale: string[];
  risks?: string[];
  nextSteps?: string[];
  tone: "sales" | "support" | "community" | "executive" | "personal";
};

export type PresentationSlideBlock =
  | string
  | PresentationEventLayerItem[]
  | PresentationKnowledgeLayerNode[]
  | PresentationReasoningLayerItem[];

export type PresentationSlideDefinition = {
  id: string;
  templateSlot:
    | "cover"
    | "highlights"
    | "timeline"
    | "events"
    | "problems"
    | "opportunities"
    | "reasoning"
    | "plan"
    | "risks"
    | "attachments";
  title: string;
  layout: "title-bullets" | "two-column" | "timeline" | "table" | "summary";
  blocks: Array<{
    type: "text" | "timeline" | "table" | "image";
    content: PresentationSlideBlock;
  }>;
};

export type PresentationOutlinePayload = {
  eventLayer: PresentationEventLayerItem[];
  knowledgeLayer: PresentationKnowledgeLayerNode[];
  reasoningLayer: PresentationReasoningLayerItem[];
  slides: PresentationSlideDefinition[];
  timeline?: Record<string, unknown> | null;
  sourceStats?: Record<string, unknown>;
  modelVersion?: string;
};

// ============================================================================
// Presentation Tables
// ============================================================================

export const presentationJobs = sqliteTable(
  "presentation_jobs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    templateType: text("template_type").notNull(),
    cadence: text("cadence").notNull().default("weekly"),
    timeRangeStart: text("time_range_start").notNull(), // Date as ISO string
    timeRangeEnd: text("time_range_end").notNull(), // Date as ISO string
    status: text("status").notNull().default("queued"),
    progress: text("progress"), // JSON string
    sourceFilters: text("source_filters"), // JSON string
    styleProfile: text("style_profile"), // JSON string
    requestedFormats: text("requested_formats")
      .notNull()
      .default('["pptx"]')
      .$type<string[]>(), // JSON array string
    gammaGenerationId: text("gamma_generation_id"),
    gammaTemplateId: text("gamma_template_id"),
    gammaStatus: text("gamma_status"), // JSON string
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    startedAt: integer("started_at", { mode: "timestamp" }),
    completedAt: integer("completed_at", { mode: "timestamp" }),
  },
  (table) => ({
    userIdx: index("presentation_jobs_user_idx").on(
      table.userId,
      table.createdAt,
    ),
    statusIdx: index("presentation_jobs_status_idx").on(table.status),
  }),
);

export type PresentationJob = InferSelectModel<typeof presentationJobs>;
export type InsertPresentationJob = InferInsertModel<typeof presentationJobs>;

export const presentationOutlines = sqliteTable(
  "presentation_outlines",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => presentationJobs.id, { onDelete: "cascade" }),
    eventLayer: text("event_layer").notNull(), // JSON string
    knowledgeLayer: text("knowledge_layer").notNull(), // JSON string
    reasoningLayer: text("reasoning_layer").notNull(), // JSON string
    slides: text("slides").notNull(), // JSON string
    timeline: text("timeline"), // JSON string
    sourceStats: text("source_stats"), // JSON string
    modelVersion: text("model_version").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    jobIdx: index("presentation_outlines_job_idx").on(table.jobId),
  }),
);

export type PresentationOutline = InferSelectModel<typeof presentationOutlines>;
export type InsertPresentationOutline = InferInsertModel<
  typeof presentationOutlines
>;

// User File Usage tracking
export const userFileUsage = sqliteTable("user_file_usage", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  usedBytes: integer("used_bytes").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type UserFileUsage = InferSelectModel<typeof userFileUsage>;

// User Files (needed for presentation artifacts)
export const userFiles = sqliteTable(
  "user_files",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    chatId: text("chat_id").references(() => chat.id, {
      onDelete: "set null",
    }),
    messageId: text("message_id").references(() => message.id, {
      onDelete: "set null",
    }),
    blobUrl: text("blob_url").notNull(),
    blobPathname: text("blob_pathname").notNull(),
    storageProvider: text("storage_provider").notNull().default("vercel_blob"),
    providerFileId: text("provider_file_id"),
    providerMetadata: text("provider_metadata"), // JSON string
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    savedAt: integer("saved_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    userIdx: index("user_files_user_idx").on(table.userId),
    providerPathIdx: uniqueIndex("user_files_provider_path_idx").on(
      table.storageProvider,
      table.blobPathname,
    ),
  }),
);

export type UserFile = InferSelectModel<typeof userFiles>;

export const presentationArtifacts = sqliteTable(
  "presentation_artifacts",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => presentationJobs.id, { onDelete: "cascade" }),
    format: text("format").notNull(),
    fileId: text("file_id")
      .notNull()
      .references(() => userFiles.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("gamma"),
    gammaExportUrl: text("gamma_export_url"),
    checksum: text("checksum"),
    sizeBytes: integer("size_bytes"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    jobFormatIdx: uniqueIndex("presentation_artifacts_job_format_idx").on(
      table.jobId,
      table.format,
    ),
  }),
);

export type PresentationArtifact = InferSelectModel<
  typeof presentationArtifacts
>;
export type InsertPresentationArtifact = InferInsertModel<
  typeof presentationArtifacts
>;

// ============================================================================
// SCHEDULED JOBS SYSTEM (SQLite version)
// ============================================================================

// Scheduled jobs table - stores cron jobs and scheduled tasks
export const scheduledJobs = sqliteTable(
  "scheduled_jobs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),

    // Schedule configuration
    scheduleType: text("schedule_type").notNull().default("cron"), // cron | interval | once
    cronExpression: text("cron_expression"), // for type=cron
    intervalMinutes: integer("interval_minutes"), // for type=interval
    scheduledAt: integer("scheduled_at", { mode: "timestamp" }), // for type=once

    // Job configuration
    jobType: text("job_type").notNull().default("custom"), // agent | webhook | insight_refresh | custom
    jobConfig: text("job_config")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(), // JSON object

    // Execution settings
    enabled: integer("enabled", { mode: "boolean" })
      .notNull()
      .default(sql`1`),
    timezone: text("timezone").notNull().default("UTC"),

    // State tracking
    lastRunAt: integer("last_run_at", { mode: "timestamp" }),
    nextRunAt: integer("next_run_at", { mode: "timestamp" }),
    lastStatus: text("last_status"), // success | error | running | pending
    lastError: text("last_error"),
    runCount: integer("run_count").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),

    // Timestamps
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    userIdx: index("scheduled_jobs_user_idx").on(table.userId),
    enabledIdx: index("scheduled_jobs_enabled_idx").on(table.enabled),
    nextRunAtIdx: index("scheduled_jobs_next_run_idx").on(table.nextRunAt),
    userEnabledIdx: index("scheduled_jobs_user_enabled_idx").on(
      table.userId,
      table.enabled,
    ),
  }),
);

export type ScheduledJob = InferSelectModel<typeof scheduledJobs>;
export type InsertScheduledJob = InferInsertModel<typeof scheduledJobs>;

// Job execution history table - logs each job execution
export const jobExecutions = sqliteTable(
  "job_executions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    jobId: text("job_id")
      .notNull()
      .references(() => scheduledJobs.id, { onDelete: "cascade" }),

    // Execution details
    status: text("status").notNull(), // success | error | timeout
    startedAt: integer("started_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    completedAt: integer("completed_at", { mode: "timestamp" }),
    durationMs: integer("duration_ms"),

    // Result data
    result: text("result").$type<Record<string, unknown> | null>(), // JSON object
    error: text("error"), // Error message if failed
    output: text("output"), // Text output/logs

    // Metadata
    triggeredBy: text("triggered_by").notNull().default("scheduler"), // scheduler | manual | api
  },
  (table) => ({
    jobIdIdx: index("job_executions_job_idx").on(table.jobId),
    startedAtIdx: index("job_executions_started_at_idx").on(table.startedAt),
    statusIdx: index("job_executions_status_idx").on(table.status),
  }),
);

export type JobExecution = InferSelectModel<typeof jobExecutions>;
export type InsertJobExecution = InferInsertModel<typeof jobExecutions>;

// Loop Runtime tables
export const loops = sqliteTable(
  "loops",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workshopId: text("workshop_id").references(() => workshops.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    description: text("description"),
    goal: text("goal").notNull(),
    status: text("status").notNull().default("active"),
    triggerConfig: text("trigger_config")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    contextConfig: text("context_config")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    actionPolicy: text("action_policy")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    verificationConfig: text("verification_config")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    approvalPolicy: text("approval_policy")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    retryPolicy: text("retry_policy")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    escalationPolicy: text("escalation_policy")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    userIdx: index("loops_user_idx").on(table.userId),
    statusIdx: index("loops_status_idx").on(table.status),
    userStatusIdx: index("loops_user_status_idx").on(
      table.userId,
      table.status,
    ),
    workshopIdx: index("loops_workshop_idx").on(table.workshopId),
    workshopStatusIdx: index("loops_workshop_status_idx").on(
      table.workshopId,
      table.status,
    ),
    updatedAtIdx: index("loops_updated_at_idx").on(table.updatedAt),
  }),
);

export type Loop = InferSelectModel<typeof loops>;
export type InsertLoop = InferInsertModel<typeof loops>;

export const loopRuns = sqliteTable(
  "loop_runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    loopId: text("loop_id")
      .notNull()
      .references(() => loops.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("running"),
    triggerReason: text("trigger_reason").$type<Record<string, unknown>>(),
    startedAt: integer("started_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    completedAt: integer("completed_at", { mode: "timestamp" }),
    inputSnapshot: text("input_snapshot").$type<Record<string, unknown>>(),
    outputSummary: text("output_summary"),
    verificationResult: text("verification_result").$type<
      Record<string, unknown>
    >(),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    loopIdx: index("loop_runs_loop_idx").on(table.loopId),
    statusIdx: index("loop_runs_status_idx").on(table.status),
    startedAtIdx: index("loop_runs_started_at_idx").on(table.startedAt),
    loopStartedAtIdx: index("loop_runs_loop_started_at_idx").on(
      table.loopId,
      table.startedAt,
    ),
  }),
);

export type LoopRun = InferSelectModel<typeof loopRuns>;
export type InsertLoopRun = InferInsertModel<typeof loopRuns>;

export const loopStates = sqliteTable("loop_states", {
  loopId: text("loop_id")
    .primaryKey()
    .references(() => loops.id, { onDelete: "cascade" }),
  currentPhase: text("current_phase").notNull().default("idle"),
  memorySummary: text("memory_summary"),
  openQuestions: text("open_questions")
    .notNull()
    .default("[]")
    .$type<unknown[]>(),
  lastObservation: text("last_observation"),
  nextAction: text("next_action"),
  blockedReason: text("blocked_reason"),
  stateJson: text("state_json")
    .notNull()
    .default("{}")
    .$type<Record<string, unknown>>(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type LoopState = InferSelectModel<typeof loopStates>;
export type InsertLoopState = InferInsertModel<typeof loopStates>;

export const loopApprovalRequests = sqliteTable(
  "loop_approval_requests",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    loopId: text("loop_id")
      .notNull()
      .references(() => loops.id, { onDelete: "cascade" }),
    loopRunId: text("loop_run_id")
      .notNull()
      .references(() => loopRuns.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    source: text("source").notNull().default("tool_gate"),
    actionName: text("action_name").notNull(),
    capability: text("capability"),
    reason: text("reason"),
    message: text("message"),
    toolInput: text("tool_input").$type<Record<string, unknown>>(),
    actionPayload: text("action_payload").$type<Record<string, unknown>>(),
    resolvedBy: text("resolved_by").references(() => user.id, {
      onDelete: "set null",
    }),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
    resolutionNote: text("resolution_note"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    userStatusIdx: index("loop_approval_requests_user_status_idx").on(
      table.userId,
      table.status,
    ),
    loopIdx: index("loop_approval_requests_loop_idx").on(table.loopId),
    runIdx: index("loop_approval_requests_run_idx").on(table.loopRunId),
    createdAtIdx: index("loop_approval_requests_created_at_idx").on(
      table.createdAt,
    ),
  }),
);

export type LoopApprovalRequest = InferSelectModel<
  typeof loopApprovalRequests
>;
export type InsertLoopApprovalRequest = InferInsertModel<
  typeof loopApprovalRequests
>;

// Interaction Memory
export const interactionEvents = sqliteTable(
  "interaction_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    source: text("source").notNull(),
    conversationId: text("conversation_id"),
    conversationName: text("conversation_name").notNull(),
    conversationType: text("conversation_type").notNull().default("unknown"),
    senderId: text("sender_id"),
    senderName: text("sender_name"),
    senderDisplayName: text("sender_display_name"),
    direction: text("direction").notNull().default("unknown"),
    contentType: text("content_type").notNull().default("unknown"),
    content: text("content").notNull().default(""),
    contentPreview: text("content_preview").notNull().default(""),
    messageTime: integer("message_time", { mode: "timestamp" }).notNull(),
    collectedAt: integer("collected_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    sourceMessageId: text("source_message_id"),
    sourceSequence: text("source_sequence"),
    sourceRaw: text("source_raw")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    dedupeKey: text("dedupe_key").notNull(),
    processedStatus: text("processed_status").notNull().default("new"),
    importance: text("importance").notNull().default("unknown"),
    requiresReply: integer("requires_reply", { mode: "boolean" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    userPlatformDedupeIdx: uniqueIndex(
      "interaction_events_user_platform_dedupe_idx",
    ).on(table.userId, table.platform, table.dedupeKey),
    userMessageTimeIdx: index("interaction_events_user_message_time_idx").on(
      table.userId,
      table.messageTime,
    ),
    userStatusIdx: index("interaction_events_user_status_idx").on(
      table.userId,
      table.processedStatus,
    ),
    conversationIdx: index("interaction_events_conversation_idx").on(
      table.userId,
      table.platform,
      table.conversationId,
    ),
  }),
);

export type InteractionEvent = InferSelectModel<typeof interactionEvents>;
export type InsertInteractionEvent = InferInsertModel<typeof interactionEvents>;

export const interactionThreads = sqliteTable(
  "interaction_threads",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    conversationId: text("conversation_id").notNull(),
    conversationName: text("conversation_name").notNull(),
    conversationType: text("conversation_type").notNull().default("unknown"),
    lastMessageAt: integer("last_message_at", { mode: "timestamp" }).notNull(),
    lastCollectedAt: integer("last_collected_at", {
      mode: "timestamp",
    }).notNull(),
    unreadCount: integer("unread_count").notNull().default(0),
    pendingReplyCount: integer("pending_reply_count").notNull().default(0),
    lastEventId: text("last_event_id").references(() => interactionEvents.id, {
      onDelete: "set null",
    }),
    summary: text("summary"),
    metadata: text("metadata")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    userConversationIdx: uniqueIndex(
      "interaction_threads_user_conversation_idx",
    ).on(table.userId, table.platform, table.conversationId),
    userLastMessageIdx: index("interaction_threads_user_last_message_idx").on(
      table.userId,
      table.lastMessageAt,
    ),
  }),
);

export type InteractionThread = InferSelectModel<typeof interactionThreads>;
export type InsertInteractionThread = InferInsertModel<typeof interactionThreads>;

export const interactionProcessingJobs = sqliteTable(
  "interaction_processing_jobs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    eventId: text("event_id").references(() => interactionEvents.id, {
      onDelete: "set null",
    }),
    threadId: text("thread_id").references(() => interactionThreads.id, {
      onDelete: "set null",
    }),
    eventIds: text("event_ids").notNull().default("[]").$type<string[]>(),
    processingMode: text("processing_mode").notNull().default("full"),
    jobType: text("job_type").notNull().default("summarize_thread"),
    status: text("status").notNull().default("pending"),
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    scheduledAt: integer("scheduled_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    startedAt: integer("started_at", { mode: "timestamp" }),
    completedAt: integer("completed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    userStatusScheduledIdx: index(
      "interaction_processing_jobs_user_status_scheduled_idx",
    ).on(table.userId, table.status, table.scheduledAt),
    eventIdx: index("interaction_processing_jobs_event_idx").on(table.eventId),
    threadIdx: index("interaction_processing_jobs_thread_idx").on(
      table.threadId,
    ),
  }),
);

export type InteractionProcessingJob = InferSelectModel<
  typeof interactionProcessingJobs
>;
export type InsertInteractionProcessingJob = InferInsertModel<
  typeof interactionProcessingJobs
>;

export const interactionNotes = sqliteTable(
  "interaction_notes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    eventId: text("event_id").references(() => interactionEvents.id, {
      onDelete: "set null",
    }),
    threadId: text("thread_id").references(() => interactionThreads.id, {
      onDelete: "set null",
    }),
    noteType: text("note_type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    confidence: integer("confidence").notNull().default(50),
    model: text("model"),
    sourceEventIds: text("source_event_ids")
      .notNull()
      .default("[]")
      .$type<string[]>(),
    metadata: text("metadata")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    userCreatedAtIdx: index("interaction_notes_user_created_at_idx").on(
      table.userId,
      table.createdAt,
    ),
    userTypeIdx: index("interaction_notes_user_type_idx").on(
      table.userId,
      table.noteType,
    ),
    eventIdx: index("interaction_notes_event_idx").on(table.eventId),
    threadIdx: index("interaction_notes_thread_idx").on(table.threadId),
  }),
);

export type InteractionNote = InferSelectModel<typeof interactionNotes>;
export type InsertInteractionNote = InferInsertModel<typeof interactionNotes>;

export const interactionTasks = sqliteTable(
  "interaction_tasks",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    eventId: text("event_id").references(() => interactionEvents.id, {
      onDelete: "set null",
    }),
    threadId: text("thread_id").references(() => interactionThreads.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("candidate"),
    dueAt: integer("due_at", { mode: "timestamp" }),
    assigneeName: text("assignee_name"),
    requesterName: text("requester_name"),
    sourceEventIds: text("source_event_ids")
      .notNull()
      .default("[]")
      .$type<string[]>(),
    confidence: integer("confidence").notNull().default(50),
    metadata: text("metadata")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    userStatusIdx: index("interaction_tasks_user_status_idx").on(
      table.userId,
      table.status,
    ),
    userCreatedAtIdx: index("interaction_tasks_user_created_at_idx").on(
      table.userId,
      table.createdAt,
    ),
    eventIdx: index("interaction_tasks_event_idx").on(table.eventId),
    threadIdx: index("interaction_tasks_thread_idx").on(table.threadId),
  }),
);

export type InteractionTask = InferSelectModel<typeof interactionTasks>;
export type InsertInteractionTask = InferInsertModel<typeof interactionTasks>;

export const interactionMemories = sqliteTable(
  "interaction_memories",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    memoryType: text("memory_type").notNull(),
    subject: text("subject").notNull(),
    content: text("content").notNull(),
    status: text("status").notNull().default("candidate"),
    confidence: integer("confidence").notNull().default(50),
    tags: text("tags").notNull().default("[]").$type<string[]>(),
    sourceEventIds: text("source_event_ids")
      .notNull()
      .default("[]")
      .$type<string[]>(),
    lastVerifiedAt: integer("last_verified_at", { mode: "timestamp" }),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    metadata: text("metadata")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    userStatusIdx: index("interaction_memories_user_status_idx").on(
      table.userId,
      table.status,
    ),
    userSubjectIdx: index("interaction_memories_user_subject_idx").on(
      table.userId,
      table.subject,
    ),
    userTypeIdx: index("interaction_memories_user_type_idx").on(
      table.userId,
      table.memoryType,
    ),
  }),
);

export type InteractionMemory = InferSelectModel<typeof interactionMemories>;
export type InsertInteractionMemory = InferInsertModel<
  typeof interactionMemories
>;

export const memoryGraphEntities = sqliteTable(
  "memory_graph_entities",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scope: text("scope").notNull().default("interaction"),
    source: text("source").notNull().default("interaction_processor"),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    entityType: text("entity_type").notNull().default("other"),
    aliases: text("aliases").notNull().default("[]").$type<string[]>(),
    description: text("description"),
    metadata: text("metadata")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    userScopeNameIdx: uniqueIndex("memory_graph_entities_user_scope_name_idx").on(
      table.userId,
      table.scope,
      table.entityType,
      table.normalizedName,
    ),
    userScopeTypeIdx: index("memory_graph_entities_user_scope_type_idx").on(
      table.userId,
      table.scope,
      table.entityType,
    ),
  }),
);

export type MemoryGraphEntity = InferSelectModel<typeof memoryGraphEntities>;
export type InsertMemoryGraphEntity = InferInsertModel<
  typeof memoryGraphEntities
>;

export const memoryGraphRelations = sqliteTable(
  "memory_graph_relations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scope: text("scope").notNull().default("interaction"),
    source: text("source").notNull().default("interaction_processor"),
    subjectEntityId: text("subject_entity_id")
      .notNull()
      .references(() => memoryGraphEntities.id, { onDelete: "cascade" }),
    objectEntityId: text("object_entity_id")
      .notNull()
      .references(() => memoryGraphEntities.id, { onDelete: "cascade" }),
    relationType: text("relation_type").notNull(),
    claim: text("claim").notNull(),
    claimHash: text("claim_hash").notNull(),
    confidence: integer("confidence").notNull().default(60),
    evidenceStrength: text("evidence_strength").notNull().default("medium"),
    status: text("status").notNull().default("active"),
    metadata: text("metadata")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    userScopeClaimIdx: uniqueIndex("memory_graph_relations_user_scope_claim_idx").on(
      table.userId,
      table.scope,
      table.subjectEntityId,
      table.objectEntityId,
      table.relationType,
      table.claimHash,
    ),
    userScopeUpdatedIdx: index("memory_graph_relations_user_scope_updated_idx").on(
      table.userId,
      table.scope,
      table.updatedAt,
    ),
    subjectIdx: index("memory_graph_relations_subject_idx").on(
      table.subjectEntityId,
    ),
    objectIdx: index("memory_graph_relations_object_idx").on(
      table.objectEntityId,
    ),
  }),
);

export type MemoryGraphRelation = InferSelectModel<typeof memoryGraphRelations>;
export type InsertMemoryGraphRelation = InferInsertModel<
  typeof memoryGraphRelations
>;

export const memoryGraphEvidence = sqliteTable(
  "memory_graph_evidence",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    relationId: text("relation_id")
      .notNull()
      .references(() => memoryGraphRelations.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull().default("interaction_event"),
    sourceId: text("source_id").notNull(),
    eventId: text("event_id").references(() => interactionEvents.id, {
      onDelete: "set null",
    }),
    quote: text("quote"),
    metadata: text("metadata")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    relationSourceIdx: uniqueIndex("memory_graph_evidence_relation_source_idx").on(
      table.relationId,
      table.sourceType,
      table.sourceId,
    ),
    userSourceIdx: index("memory_graph_evidence_user_source_idx").on(
      table.userId,
      table.sourceType,
      table.sourceId,
    ),
  }),
);

export type MemoryGraphEvidence = InferSelectModel<typeof memoryGraphEvidence>;
export type InsertMemoryGraphEvidence = InferInsertModel<
  typeof memoryGraphEvidence
>;

export const brainObservations = sqliteTable(
  "brain_observations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    sourceEventId: text("source_event_id"),
    observedAt: integer("observed_at", { mode: "timestamp" }).notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    trustLevel: text("trust_level").notNull().default("raw"),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    userObservedIdx: index("brain_observations_user_observed_idx").on(
      table.userId,
      table.observedAt,
    ),
    sourceUniqueIdx: uniqueIndex("brain_observations_source_unique_idx").on(
      table.userId,
      table.sourceType,
      table.sourceId,
    ),
    contentHashIdx: index("brain_observations_content_hash_idx").on(
      table.userId,
      table.contentHash,
    ),
  }),
);
export type BrainObservation = InferSelectModel<typeof brainObservations>;
export type InsertBrainObservation = InferInsertModel<typeof brainObservations>;

export const brainMemories = sqliteTable(
  "brain_memories",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id"),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    memoryType: text("memory_type").notNull(),
    subject: text("subject").notNull(),
    content: text("content").notNull(),
    status: text("status").notNull().default("candidate"),
    confidence: integer("confidence").notNull().default(50),
    canonicalKind: text("canonical_kind"),
    canonicalGroupId: text("canonical_group_id"),
    evidenceRefs: text("evidence_refs").notNull().default("[]"),
    tags: text("tags").notNull().default("[]"),
    metadata: text("metadata").notNull().default("{}"),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    supersedes: text("supersedes").notNull().default("[]"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    userScopeStatusIdx: index("brain_memories_user_scope_status_idx").on(
      table.userId,
      table.scopeType,
      table.scopeId,
      table.status,
    ),
    ownerIdx: index("brain_memories_owner_idx").on(
      table.userId,
      table.ownerType,
      table.ownerId,
    ),
    subjectIdx: index("brain_memories_subject_idx").on(
      table.userId,
      table.memoryType,
      table.subject,
    ),
    updatedIdx: index("brain_memories_updated_idx").on(
      table.userId,
      table.updatedAt,
    ),
    canonicalGroupIdx: index("brain_memories_canonical_group_idx").on(
      table.userId,
      table.ownerType,
      table.ownerId,
      table.scopeType,
      table.scopeId,
      table.canonicalGroupId,
    ),
    canonicalKindIdx: index("brain_memories_canonical_kind_idx").on(
      table.userId,
      table.canonicalKind,
      table.status,
    ),
  }),
);
export type BrainMemoryRow = InferSelectModel<typeof brainMemories>;
export type InsertBrainMemoryRow = InferInsertModel<typeof brainMemories>;

export const brainMemoryReviews = sqliteTable(
  "brain_memory_reviews",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    memoryId: text("memory_id")
      .notNull()
      .references(() => brainMemories.id, { onDelete: "cascade" }),
    reviewerType: text("reviewer_type").notNull(),
    reviewerId: text("reviewer_id"),
    decision: text("decision").notNull(),
    reason: text("reason"),
    evidenceRefs: text("evidence_refs").notNull().default("[]"),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    memoryIdx: index("brain_memory_reviews_memory_idx").on(table.memoryId),
    userCreatedIdx: index("brain_memory_reviews_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
  }),
);
export type BrainMemoryReview = InferSelectModel<typeof brainMemoryReviews>;
export type InsertBrainMemoryReview = InferInsertModel<
  typeof brainMemoryReviews
>;

export const brainStateSnapshots = sqliteTable(
  "brain_state_snapshots",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id"),
    snapshotType: text("snapshot_type").notNull(),
    content: text("content").notNull().default("{}"),
    sourceMemoryIds: text("source_memory_ids").notNull().default("[]"),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    scopeCreatedIdx: index("brain_state_snapshots_scope_created_idx").on(
      table.userId,
      table.scopeType,
      table.scopeId,
      table.createdAt,
    ),
  }),
);
export type BrainStateSnapshot = InferSelectModel<typeof brainStateSnapshots>;
export type InsertBrainStateSnapshot = InferInsertModel<
  typeof brainStateSnapshots
>;

export const brainAccessGrants = sqliteTable(
  "brain_access_grants",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id"),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id"),
    permissions: text("permissions").notNull().default("[]"),
    memoryTypes: text("memory_types").notNull().default("[]"),
    reason: text("reason"),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    subjectScopeIdx: index("brain_access_grants_subject_scope_idx").on(
      table.userId,
      table.subjectType,
      table.subjectId,
      table.scopeType,
      table.scopeId,
    ),
  }),
);
export type BrainAccessGrantRow = InferSelectModel<typeof brainAccessGrants>;
export type InsertBrainAccessGrantRow = InferInsertModel<
  typeof brainAccessGrants
>;

export const brainContextLogs = sqliteTable(
  "brain_context_logs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    requesterType: text("requester_type").notNull(),
    requesterId: text("requester_id"),
    taskIntent: text("task_intent"),
    selectedMemoryIds: text("selected_memory_ids").notNull().default("[]"),
    denied: text("denied").notNull().default("[]"),
    omitted: text("omitted").notNull().default("[]"),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    requesterCreatedIdx: index("brain_context_logs_requester_created_idx").on(
      table.userId,
      table.requesterType,
      table.requesterId,
      table.createdAt,
    ),
  }),
);
export type BrainContextLog = InferSelectModel<typeof brainContextLogs>;
export type InsertBrainContextLog = InferInsertModel<typeof brainContextLogs>;

export const interactionSourcePolicies = sqliteTable(
  "interaction_source_policies",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    sourceId: text("source_id").notNull(),
    sourceName: text("source_name").notNull(),
    sourceType: text("source_type").notNull().default("unknown"),
    policy: text("policy").notNull().default("sync"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    priority: integer("priority").notNull().default(0),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
    metadata: text("metadata")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    userPlatformSourceIdx: uniqueIndex(
      "interaction_source_policies_user_platform_source_idx",
    ).on(table.userId, table.platform, table.sourceId),
    userPlatformPolicyIdx: index(
      "interaction_source_policies_user_platform_policy_idx",
    ).on(table.userId, table.platform, table.policy),
    userUpdatedAtIdx: index("interaction_source_policies_user_updated_at_idx").on(
      table.userId,
      table.updatedAt,
    ),
  }),
);

export type InteractionSourcePolicy = InferSelectModel<
  typeof interactionSourcePolicies
>;
export type InsertInteractionSourcePolicy = InferInsertModel<
  typeof interactionSourcePolicies
>;

// Work Workshops
export const workshops = sqliteTable(
  "workshops",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mission: text("mission").notNull(),
    status: text("status").notNull().default("active"),
    autonomyLevel: text("autonomy_level").notNull().default("draft"),
    boundaryPolicy: text("boundary_policy")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    modelConfig: text("model_config")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    userIdx: index("workshops_user_idx").on(table.userId),
    userStatusIdx: index("workshops_user_status_idx").on(
      table.userId,
      table.status,
    ),
    updatedAtIdx: index("workshops_updated_at_idx").on(table.updatedAt),
  }),
);

export type Workshop = InferSelectModel<typeof workshops>;
export type InsertWorkshop = InferInsertModel<typeof workshops>;

export const workshopWorkVersions = sqliteTable(
  "workshop_work_versions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workshopId: text("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    source: text("source").notNull().default("manual_update"),
    changeEventId: text("change_event_id"),
    snapshot: text("snapshot")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    patch: text("patch")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    createdBy: text("created_by").notNull().default("system"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    workshopVersionIdx: uniqueIndex("workshop_work_versions_workshop_version_idx").on(
      table.workshopId,
      table.version,
    ),
    workshopCreatedAtIdx: index("workshop_work_versions_workshop_created_at_idx").on(
      table.workshopId,
      table.createdAt,
    ),
    changeEventIdx: index("workshop_work_versions_change_event_idx").on(
      table.changeEventId,
    ),
  }),
);

export type WorkshopWorkVersion = InferSelectModel<typeof workshopWorkVersions>;
export type InsertWorkshopWorkVersion = InferInsertModel<
  typeof workshopWorkVersions
>;

export const quantTradePlans = sqliteTable(
  "quant_trade_plans",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workshopId: text("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    runId: text("run_id"),
    loopId: text("loop_id"),
    loopRunId: text("loop_run_id"),
    sourceEventId: text("source_event_id"),
    planDate: text("plan_date").notNull(),
    horizon: text("horizon").notNull().default("next_day"),
    status: text("status").notNull().default("active"),
    code: text("code").notNull(),
    name: text("name"),
    action: text("action").notNull(),
    side: text("side"),
    quantity: integer("quantity"),
    targetPrice: real("target_price"),
    triggerCondition: text("trigger_condition").notNull(),
    invalidation: text("invalidation"),
    rationale: text("rationale").notNull(),
    priority: text("priority").notNull().default("normal"),
    executionStatus: text("execution_status").notNull().default("pending"),
    orderId: text("order_id"),
    blockerReason: text("blocker_reason"),
    completionNote: text("completion_note"),
    sourceDecision: text("source_decision")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    metadata: text("metadata")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    plannedAt: integer("planned_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    dueAt: integer("due_at", { mode: "timestamp" }),
    executedAt: integer("executed_at", { mode: "timestamp" }),
    reviewedAt: integer("reviewed_at", { mode: "timestamp" }),
    supersededBy: text("superseded_by"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    workshopPlanDateIdx: index("quant_trade_plans_workshop_plan_date_idx").on(
      table.workshopId,
      table.planDate,
    ),
    workshopStatusIdx: index("quant_trade_plans_workshop_status_idx").on(
      table.workshopId,
      table.status,
      table.executionStatus,
    ),
    workshopCodeIdx: index("quant_trade_plans_workshop_code_idx").on(
      table.workshopId,
      table.code,
      table.planDate,
    ),
  }),
);

export type QuantTradePlan = InferSelectModel<typeof quantTradePlans>;
export type InsertQuantTradePlan = InferInsertModel<typeof quantTradePlans>;

export const quantTrendStateSnapshots = sqliteTable(
  "quant_trend_state_snapshots",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workshopId: text("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    runId: text("run_id"),
    loopId: text("loop_id"),
    loopRunId: text("loop_run_id"),
    sourceEventId: text("source_event_id"),
    code: text("code").notNull(),
    name: text("name"),
    tradeDate: text("trade_date"),
    benchmarkCode: text("benchmark_code"),
    lifecycleState: text("lifecycle_state").notNull(),
    trendPhase: text("trend_phase"),
    trendScore: real("trend_score"),
    rsRank: integer("rs_rank"),
    rsPercentile: real("rs_percentile"),
    rsScore: real("rs_score"),
    relativeReturn60d: real("relative_return_60d"),
    trailingStop: real("trailing_stop"),
    hardStop: real("hard_stop"),
    stopAction: text("stop_action"),
    controlAction: text("control_action"),
    tradeAllowed: integer("trade_allowed", { mode: "boolean" })
      .notNull()
      .default(false),
    dataQualityStatus: text("data_quality_status").notNull().default("unknown"),
    snapshot: text("snapshot")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    workshopCodeCreatedAtIdx: index(
      "quant_trend_state_snapshots_workshop_code_created_at_idx",
    ).on(table.workshopId, table.code, table.createdAt),
    workshopTradeDateIdx: index(
      "quant_trend_state_snapshots_workshop_trade_date_idx",
    ).on(table.workshopId, table.tradeDate),
    sourceEventCodeIdx: uniqueIndex(
      "quant_trend_state_snapshots_source_event_code_idx",
    ).on(table.sourceEventId, table.code),
  }),
);

export type QuantTrendStateSnapshot = InferSelectModel<
  typeof quantTrendStateSnapshots
>;
export type InsertQuantTrendStateSnapshot = InferInsertModel<
  typeof quantTrendStateSnapshots
>;

export const quantTrendStrategySamples = sqliteTable(
  "quant_trend_strategy_samples",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workshopId: text("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => quantTrendStateSnapshots.id, { onDelete: "cascade" }),
    sourceEventId: text("source_event_id"),
    code: text("code").notNull(),
    name: text("name"),
    tradeDate: text("trade_date"),
    lifecycleState: text("lifecycle_state").notNull(),
    trendPhase: text("trend_phase"),
    controlAction: text("control_action"),
    observedPrice: real("observed_price"),
    observedAt: integer("observed_at", { mode: "timestamp" }).notNull(),
    evaluationAt: integer("evaluation_at", { mode: "timestamp" }),
    latestPrice: real("latest_price"),
    returnPct: real("return_pct"),
    horizonDays: integer("horizon_days").notNull().default(0),
    holdingQuantity: integer("holding_quantity").notNull().default(0),
    realizedPnl: real("realized_pnl").notNull().default(0),
    outcomeStatus: text("outcome_status").notNull().default("open"),
    exitReason: text("exit_reason"),
    result: text("result")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    snapshotIdx: uniqueIndex("quant_trend_strategy_samples_snapshot_idx").on(
      table.snapshotId,
    ),
    workshopCodeObservedAtIdx: index(
      "quant_trend_strategy_samples_workshop_code_observed_at_idx",
    ).on(table.workshopId, table.code, table.observedAt),
    workshopOutcomeIdx: index(
      "quant_trend_strategy_samples_workshop_outcome_idx",
    ).on(table.workshopId, table.outcomeStatus),
  }),
);

export type QuantTrendStrategySample = InferSelectModel<
  typeof quantTrendStrategySamples
>;
export type InsertQuantTrendStrategySample = InferInsertModel<
  typeof quantTrendStrategySamples
>;

export const workshopHeartbeats = sqliteTable(
  "workshop_heartbeats",
  {
    workshopId: text("workshop_id")
      .primaryKey()
      .references(() => workshops.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    mode: text("mode").notNull().default("suggested"),
    nextWakeupAt: integer("next_wakeup_at", { mode: "timestamp" }),
    lastWakeupAt: integer("last_wakeup_at", { mode: "timestamp" }),
    lastHeartbeatAt: integer("last_heartbeat_at", { mode: "timestamp" }),
    schedulerStatus: text("scheduler_status").notNull().default("idle"),
    schedulerError: text("scheduler_error"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    leaseUntil: integer("lease_until", { mode: "timestamp" }),
    heartbeatPolicy: text("heartbeat_policy")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    enabledNextWakeupIdx: index("workshop_heartbeats_enabled_next_wakeup_idx").on(
      table.enabled,
      table.nextWakeupAt,
    ),
    statusIdx: index("workshop_heartbeats_status_idx").on(table.schedulerStatus),
    leaseIdx: index("workshop_heartbeats_lease_idx").on(table.leaseUntil),
  }),
);

export type WorkshopHeartbeat = InferSelectModel<typeof workshopHeartbeats>;
export type InsertWorkshopHeartbeat = InferInsertModel<typeof workshopHeartbeats>;

export const workshopRuns = sqliteTable(
  "workshop_runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workshopId: text("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("running"),
    triggerReason: text("trigger_reason").$type<Record<string, unknown>>(),
    ccSessionId: text("cc_session_id"),
    inputSnapshot: text("input_snapshot").$type<Record<string, unknown>>(),
    outputSummary: text("output_summary"),
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    completedAt: integer("completed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    workshopIdx: index("workshop_runs_workshop_idx").on(table.workshopId),
    statusIdx: index("workshop_runs_status_idx").on(table.status),
    startedAtIdx: index("workshop_runs_started_at_idx").on(table.startedAt),
  }),
);

export type WorkshopRun = InferSelectModel<typeof workshopRuns>;
export type InsertWorkshopRun = InferInsertModel<typeof workshopRuns>;

export const workshopEvents = sqliteTable(
  "workshop_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workshopId: text("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => workshopRuns.id, {
      onDelete: "set null",
    }),
    loopId: text("loop_id").references(() => loops.id, {
      onDelete: "set null",
    }),
    loopRunId: text("loop_run_id").references(() => loopRuns.id, {
      onDelete: "set null",
    }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    metadata: text("metadata")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    visibility: text("visibility").notNull().default("user"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    workshopSeqIdx: uniqueIndex("workshop_events_workshop_seq_idx").on(
      table.workshopId,
      table.seq,
    ),
    workshopCreatedAtIdx: index("workshop_events_workshop_created_at_idx").on(
      table.workshopId,
      table.createdAt,
    ),
    workshopTypeSeqIdx: index("workshop_events_workshop_type_seq_idx").on(
      table.workshopId,
      table.type,
      table.seq,
    ),
    runIdx: index("workshop_events_run_idx").on(table.runId),
    loopIdx: index("workshop_events_loop_idx").on(table.loopId),
    loopRunIdx: index("workshop_events_loop_run_idx").on(table.loopRunId),
  }),
);

export type WorkshopEvent = InferSelectModel<typeof workshopEvents>;
export type InsertWorkshopEvent = InferInsertModel<typeof workshopEvents>;

export const workshopReviewItems = sqliteTable(
  "workshop_review_items",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workshopId: text("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    sourceEventId: text("source_event_id").references(() => workshopEvents.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    title: text("title").notNull(),
    summary: text("summary"),
    riskLevel: text("risk_level"),
    metadata: text("metadata")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  },
  (table) => ({
    workshopStatusIdx: index("workshop_review_items_workshop_status_idx").on(
      table.workshopId,
      table.status,
      table.createdAt,
    ),
    sourceEventIdx: uniqueIndex(
      "workshop_review_items_source_event_idx",
    ).on(table.sourceEventId),
  }),
);

export type WorkshopReviewItem = InferSelectModel<typeof workshopReviewItems>;
export type InsertWorkshopReviewItem = InferInsertModel<
  typeof workshopReviewItems
>;

// Harness evolution
export const harnessComponents = sqliteTable(
  "harness_components",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id").notNull().default("platform"),
    componentKey: text("component_key").notNull(),
    componentType: text("component_type").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceRef: text("source_ref").notNull(),
    owner: text("owner").notNull(),
    mutability: text("mutability").notNull(),
    riskLevel: text("risk_level").notNull(),
    currentRevisionId: text("current_revision_id"),
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    scopeKeyIdx: uniqueIndex("harness_components_scope_key_idx").on(
      table.scopeType,
      table.scopeId,
      table.componentKey,
    ),
    scopeTypeIdx: index("harness_components_scope_type_idx").on(
      table.scopeType,
      table.scopeId,
      table.componentType,
    ),
  }),
);
export type HarnessComponentRow = InferSelectModel<typeof harnessComponents>;
export type InsertHarnessComponentRow = InferInsertModel<
  typeof harnessComponents
>;

export const harnessComponentRevisions = sqliteTable(
  "harness_component_revisions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    componentId: text("component_id")
      .notNull()
      .references(() => harnessComponents.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    schemaVersion: text("schema_version")
      .notNull()
      .default("harness-component.v1"),
    parentRevisionId: text("parent_revision_id"),
    content: text("content")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    checksum: text("checksum").notNull(),
    sourceVersion: text("source_version").notNull(),
    sourceWorkVersionId: text("source_work_version_id").references(
      () => workshopWorkVersions.id,
      { onDelete: "set null" },
    ),
    platformVersion: text("platform_version"),
    createdBy: text("created_by").notNull().default("system"),
    changeProposalId: text("change_proposal_id"),
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    componentRevisionIdx: uniqueIndex(
      "harness_component_revisions_component_revision_idx",
    ).on(table.componentId, table.revision),
    componentChecksumIdx: uniqueIndex(
      "harness_component_revisions_component_checksum_idx",
    ).on(table.componentId, table.checksum),
    proposalIdx: index("harness_component_revisions_proposal_idx").on(
      table.changeProposalId,
    ),
  }),
);
export type HarnessComponentRevisionRow = InferSelectModel<
  typeof harnessComponentRevisions
>;
export type InsertHarnessComponentRevisionRow = InferInsertModel<
  typeof harnessComponentRevisions
>;

export const workHarnessSnapshots = sqliteTable(
  "work_harness_snapshots",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workshopId: text("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    workVersionId: text("work_version_id")
      .notNull()
      .references(() => workshopWorkVersions.id, { onDelete: "cascade" }),
    platformVersion: text("platform_version").notNull(),
    componentSetHash: text("component_set_hash").notNull(),
    modelRuntime: text("model_runtime")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    policySummary: text("policy_summary")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    status: text("status").notNull().default("active"),
    resolvedAt: integer("resolved_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    identityIdx: uniqueIndex("work_harness_snapshots_identity_idx").on(
      table.workshopId,
      table.workVersionId,
      table.platformVersion,
      table.componentSetHash,
    ),
    workshopResolvedIdx: index(
      "work_harness_snapshots_workshop_resolved_idx",
    ).on(table.workshopId, table.resolvedAt),
  }),
);
export type WorkHarnessSnapshotRow = InferSelectModel<
  typeof workHarnessSnapshots
>;
export type InsertWorkHarnessSnapshotRow = InferInsertModel<
  typeof workHarnessSnapshots
>;

export const workHarnessSnapshotItems = sqliteTable(
  "work_harness_snapshot_items",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => workHarnessSnapshots.id, { onDelete: "cascade" }),
    componentId: text("component_id")
      .notNull()
      .references(() => harnessComponents.id, { onDelete: "restrict" }),
    revisionId: text("revision_id")
      .notNull()
      .references(() => harnessComponentRevisions.id, {
        onDelete: "restrict",
      }),
    componentOrder: integer("component_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    snapshotComponentIdx: uniqueIndex(
      "work_harness_snapshot_items_snapshot_component_idx",
    ).on(table.snapshotId, table.componentId),
    revisionIdx: index("work_harness_snapshot_items_revision_idx").on(
      table.revisionId,
    ),
  }),
);
export type WorkHarnessSnapshotItemRow = InferSelectModel<
  typeof workHarnessSnapshotItems
>;
export type InsertWorkHarnessSnapshotItemRow = InferInsertModel<
  typeof workHarnessSnapshotItems
>;

export const workRunEvidenceBundles = sqliteTable(
  "work_run_evidence_bundles",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workshopId: text("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    workshopRunId: text("workshop_run_id").references(() => workshopRuns.id, {
      onDelete: "set null",
    }),
    loopId: text("loop_id").references(() => loops.id, {
      onDelete: "set null",
    }),
    loopRunId: text("loop_run_id").references(() => loopRuns.id, {
      onDelete: "set null",
    }),
    workVersionId: text("work_version_id")
      .notNull()
      .references(() => workshopWorkVersions.id, { onDelete: "restrict" }),
    harnessSnapshotId: text("harness_snapshot_id")
      .notNull()
      .references(() => workHarnessSnapshots.id, { onDelete: "restrict" }),
    componentSetHash: text("component_set_hash").notNull(),
    runtimeSummary: text("runtime_summary")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    observationSummary: text("observation_summary")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    actionSummary: text("action_summary")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    outcomeSummary: text("outcome_summary")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    evidenceRefs: text("evidence_refs").notNull().default("[]").$type<unknown[]>(),
    captureStatus: text("capture_status").notNull().default("capturing"),
    completeness: text("completeness").notNull().default("partial"),
    warnings: text("warnings").notNull().default("[]").$type<unknown[]>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    loopRunIdx: uniqueIndex("work_run_evidence_bundles_loop_run_idx").on(
      table.loopRunId,
      table.harnessSnapshotId,
    ),
    workshopRunIdx: uniqueIndex(
      "work_run_evidence_bundles_workshop_run_idx",
    ).on(table.workshopRunId, table.harnessSnapshotId),
    workshopCreatedIdx: index(
      "work_run_evidence_bundles_workshop_created_idx",
    ).on(table.workshopId, table.createdAt),
  }),
);
export type WorkRunEvidenceBundleRow = InferSelectModel<
  typeof workRunEvidenceBundles
>;
export type InsertWorkRunEvidenceBundleRow = InferInsertModel<
  typeof workRunEvidenceBundles
>;

export const workRunDiagnostics = sqliteTable(
  "work_run_diagnostics",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    evidenceBundleId: text("evidence_bundle_id")
      .notNull()
      .references(() => workRunEvidenceBundles.id, { onDelete: "cascade" }),
    analyzerVersion: text("analyzer_version").notNull(),
    failureClasses: text("failure_classes").notNull().default("[]").$type<unknown[]>(),
    symptoms: text("symptoms").notNull().default("[]").$type<unknown[]>(),
    rootCauseCandidates: text("root_cause_candidates")
      .notNull()
      .default("[]")
      .$type<unknown[]>(),
    targetComponentTypes: text("target_component_types")
      .notNull()
      .default("[]")
      .$type<unknown[]>(),
    confidence: integer("confidence").notNull().default(0),
    evidenceRefs: text("evidence_refs").notNull().default("[]").$type<unknown[]>(),
    status: text("status").notNull().default("pending"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    evidenceIdx: index("work_run_diagnostics_evidence_idx").on(
      table.evidenceBundleId,
    ),
  }),
);
export type WorkRunDiagnosticRow = InferSelectModel<typeof workRunDiagnostics>;
export type InsertWorkRunDiagnosticRow = InferInsertModel<
  typeof workRunDiagnostics
>;

export const workEvaluationSuites = sqliteTable(
  "work_evaluation_suites",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    ownerType: text("owner_type").notNull(),
    workRole: text("work_role").notNull(),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("draft"),
    metricPolicy: text("metric_policy")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    holdoutPolicy: text("holdout_policy")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    roleVersionIdx: uniqueIndex("work_evaluation_suites_role_version_idx").on(
      table.userId,
      table.workRole,
      table.version,
    ),
  }),
);
export type WorkEvaluationSuiteRow = InferSelectModel<
  typeof workEvaluationSuites
>;
export type InsertWorkEvaluationSuiteRow = InferInsertModel<
  typeof workEvaluationSuites
>;

export const workEvaluationScenarios = sqliteTable(
  "work_evaluation_scenarios",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    suiteId: text("suite_id")
      .notNull()
      .references(() => workEvaluationSuites.id, { onDelete: "cascade" }),
    scenarioKey: text("scenario_key").notNull(),
    name: text("name").notNull(),
    mode: text("mode").notNull(),
    tags: text("tags").notNull().default("[]").$type<unknown[]>(),
    riskTier: text("risk_tier").notNull().default("normal"),
    fixtureRef: text("fixture_ref").notNull(),
    preconditions: text("preconditions")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    taskIntent: text("task_intent").notNull(),
    expectedArtifacts: text("expected_artifacts")
      .notNull()
      .default("[]")
      .$type<unknown[]>(),
    hardInvariants: text("hard_invariants").notNull().default("[]").$type<unknown[]>(),
    forbiddenActions: text("forbidden_actions")
      .notNull()
      .default("[]")
      .$type<unknown[]>(),
    metrics: text("metrics").notNull().default("[]").$type<unknown[]>(),
    repetitions: integer("repetitions").notNull().default(1),
    timeoutMs: integer("timeout_ms").notNull().default(60000),
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    suiteKeyIdx: uniqueIndex("work_evaluation_scenarios_suite_key_idx").on(
      table.suiteId,
      table.scenarioKey,
    ),
  }),
);
export type WorkEvaluationScenarioRow = InferSelectModel<
  typeof workEvaluationScenarios
>;
export type InsertWorkEvaluationScenarioRow = InferInsertModel<
  typeof workEvaluationScenarios
>;

export const workEvaluationCampaigns = sqliteTable(
  "work_evaluation_campaigns",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workshopId: text("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    suiteId: text("suite_id")
      .notNull()
      .references(() => workEvaluationSuites.id, { onDelete: "restrict" }),
    baselineWorkVersionId: text("baseline_work_version_id")
      .notNull()
      .references(() => workshopWorkVersions.id, { onDelete: "restrict" }),
    candidateWorkVersionId: text("candidate_work_version_id").references(
      () => workshopWorkVersions.id,
      { onDelete: "set null" },
    ),
    baselineHarnessSnapshotId: text("baseline_harness_snapshot_id")
      .notNull()
      .references(() => workHarnessSnapshots.id, { onDelete: "restrict" }),
    candidateHarnessSnapshotId: text("candidate_harness_snapshot_id")
      .notNull()
      .references(() => workHarnessSnapshots.id, { onDelete: "restrict" }),
    changeProposalId: text("change_proposal_id"),
    status: text("status").notNull().default("pending"),
    runtimeContract: text("runtime_contract")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    budget: text("budget")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    summary: text("summary")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    startedAt: integer("started_at", { mode: "timestamp" }),
    completedAt: integer("completed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    workshopCreatedIdx: index(
      "work_evaluation_campaigns_workshop_created_idx",
    ).on(table.workshopId, table.createdAt),
    proposalIdx: index("work_evaluation_campaigns_proposal_idx").on(
      table.changeProposalId,
    ),
  }),
);
export type WorkEvaluationCampaignRow = InferSelectModel<
  typeof workEvaluationCampaigns
>;
export type InsertWorkEvaluationCampaignRow = InferInsertModel<
  typeof workEvaluationCampaigns
>;

export const workEvaluationRuns = sqliteTable(
  "work_evaluation_runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => workEvaluationCampaigns.id, { onDelete: "cascade" }),
    scenarioId: text("scenario_id")
      .notNull()
      .references(() => workEvaluationScenarios.id, { onDelete: "restrict" }),
    cohort: text("cohort").notNull(),
    repetition: integer("repetition").notNull().default(1),
    status: text("status").notNull().default("pending"),
    score: real("score"),
    metrics: text("metrics")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    evidenceBundleId: text("evidence_bundle_id").references(
      () => workRunEvidenceBundles.id,
      { onDelete: "set null" },
    ),
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp" }),
    completedAt: integer("completed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    campaignScenarioIdx: uniqueIndex(
      "work_evaluation_runs_campaign_scenario_idx",
    ).on(table.campaignId, table.scenarioId, table.cohort, table.repetition),
  }),
);
export type WorkEvaluationRunRow = InferSelectModel<typeof workEvaluationRuns>;
export type InsertWorkEvaluationRunRow = InferInsertModel<
  typeof workEvaluationRuns
>;

export const workHarnessChangeProposals = sqliteTable(
  "work_harness_change_proposals",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workshopId: text("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    scope: text("scope").notNull().default("work"),
    affectedWorkIds: text("affected_work_ids").notNull().default("[]").$type<unknown[]>(),
    baseWorkVersionId: text("base_work_version_id")
      .notNull()
      .references(() => workshopWorkVersions.id, { onDelete: "restrict" }),
    baseHarnessSnapshotId: text("base_harness_snapshot_id")
      .notNull()
      .references(() => workHarnessSnapshots.id, { onDelete: "restrict" }),
    baseComponentSetHash: text("base_component_set_hash").notNull(),
    proposedBy: text("proposed_by").notNull(),
    status: text("status").notNull().default("proposed"),
    riskLevel: text("risk_level").notNull(),
    failurePattern: text("failure_pattern").notNull(),
    evidenceRefs: text("evidence_refs").notNull().default("[]").$type<unknown[]>(),
    rootCauseHypothesis: text("root_cause_hypothesis").notNull(),
    predictedFixes: text("predicted_fixes").notNull().default("[]").$type<unknown[]>(),
    predictedRegressions: text("predicted_regressions")
      .notNull()
      .default("[]")
      .$type<unknown[]>(),
    successMetrics: text("success_metrics").notNull().default("[]").$type<unknown[]>(),
    evaluationSuiteId: text("evaluation_suite_id").references(
      () => workEvaluationSuites.id,
      { onDelete: "set null" },
    ),
    evaluationScenarioIds: text("evaluation_scenario_ids")
      .notNull()
      .default("[]")
      .$type<unknown[]>(),
    evaluationWindow: text("evaluation_window")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    rollbackPlan: text("rollback_plan")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    attributionLimited: integer("attribution_limited", { mode: "boolean" })
      .notNull()
      .default(false),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    workshopStatusIdx: index(
      "work_harness_change_proposals_workshop_status_idx",
    ).on(table.workshopId, table.status, table.createdAt),
  }),
);
export type WorkHarnessChangeProposalRow = InferSelectModel<
  typeof workHarnessChangeProposals
>;
export type InsertWorkHarnessChangeProposalRow = InferInsertModel<
  typeof workHarnessChangeProposals
>;

export const workHarnessChangeItems = sqliteTable(
  "work_harness_change_items",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => workHarnessChangeProposals.id, { onDelete: "cascade" }),
    componentId: text("component_id")
      .notNull()
      .references(() => harnessComponents.id, { onDelete: "restrict" }),
    componentType: text("component_type").notNull(),
    beforeRevisionId: text("before_revision_id")
      .notNull()
      .references(() => harnessComponentRevisions.id, {
        onDelete: "restrict",
      }),
    afterRevisionId: text("after_revision_id").references(
      () => harnessComponentRevisions.id,
      { onDelete: "set null" },
    ),
    patch: text("patch")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    rationale: text("rationale").notNull(),
    groupKey: text("group_key"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    proposalIdx: index("work_harness_change_items_proposal_idx").on(
      table.proposalId,
    ),
  }),
);
export type WorkHarnessChangeItemRow = InferSelectModel<
  typeof workHarnessChangeItems
>;
export type InsertWorkHarnessChangeItemRow = InferInsertModel<
  typeof workHarnessChangeItems
>;

export const workEvolutionVerdicts = sqliteTable(
  "work_evolution_verdicts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => workHarnessChangeProposals.id, { onDelete: "cascade" }),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => workEvaluationCampaigns.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    fixedScenarios: text("fixed_scenarios").notNull().default("[]").$type<unknown[]>(),
    regressedScenarios: text("regressed_scenarios")
      .notNull()
      .default("[]")
      .$type<unknown[]>(),
    unexpectedChanges: text("unexpected_changes")
      .notNull()
      .default("[]")
      .$type<unknown[]>(),
    predictionAccuracy: text("prediction_accuracy")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    recommendedAction: text("recommended_action").notNull(),
    evidenceRefs: text("evidence_refs").notNull().default("[]").$type<unknown[]>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    proposalCampaignIdx: uniqueIndex(
      "work_evolution_verdicts_proposal_campaign_idx",
    ).on(table.proposalId, table.campaignId),
  }),
);
export type WorkEvolutionVerdictRow = InferSelectModel<
  typeof workEvolutionVerdicts
>;
export type InsertWorkEvolutionVerdictRow = InferInsertModel<
  typeof workEvolutionVerdicts
>;

export const workshopSources = sqliteTable(
  "workshop_sources",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workshopId: text("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    name: text("name").notNull(),
    uri: text("uri"),
    content: text("content"),
    config: text("config")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastCheckedAt: integer("last_checked_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    workshopIdx: index("workshop_sources_workshop_idx").on(table.workshopId),
    typeIdx: index("workshop_sources_type_idx").on(table.type),
  }),
);

export type WorkshopSource = InferSelectModel<typeof workshopSources>;
export type InsertWorkshopSource = InferInsertModel<typeof workshopSources>;

export const workshopDirectives = sqliteTable(
  "workshop_directives",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workshopId: text("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => workshopRuns.id, {
      onDelete: "set null",
    }),
    content: text("content").notNull(),
    priority: integer("priority").notNull().default(0),
    scope: text("scope").notNull().default("current_run"),
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    workshopStatusIdx: index("workshop_directives_workshop_status_idx").on(
      table.workshopId,
      table.status,
    ),
    runIdx: index("workshop_directives_run_idx").on(table.runId),
  }),
);

export type WorkshopDirective = InferSelectModel<typeof workshopDirectives>;
export type InsertWorkshopDirective = InferInsertModel<
  typeof workshopDirectives
>;

export const workshopMemories = sqliteTable(
  "workshop_memories",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workshopId: text("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    confidence: integer("confidence").notNull().default(50),
    tags: text("tags").notNull().default("[]").$type<string[]>(),
    sourceEventIds: text("source_event_ids")
      .notNull()
      .default("[]")
      .$type<string[]>(),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    workshopKindIdx: index("workshop_memories_workshop_kind_idx").on(
      table.workshopId,
      table.kind,
    ),
    createdAtIdx: index("workshop_memories_created_at_idx").on(table.createdAt),
  }),
);

export type WorkshopMemory = InferSelectModel<typeof workshopMemories>;
export type InsertWorkshopMemory = InferInsertModel<typeof workshopMemories>;

export const workshopOutbox = sqliteTable(
  "workshop_outbox",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workshopId: text("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => workshopRuns.id, {
      onDelete: "set null",
    }),
    channel: text("channel").notNull().default("wechat_desktop"),
    recipientName: text("recipient_name"),
    message: text("message").notNull(),
    status: text("status").notNull().default("draft"),
    confidence: integer("confidence").notNull().default(50),
    riskLevel: text("risk_level").notNull().default("medium"),
    sourceEventIds: text("source_event_ids")
      .notNull()
      .default("[]")
      .$type<string[]>(),
    boundaryResult: text("boundary_result")
      .notNull()
      .default("{}")
      .$type<Record<string, unknown>>(),
    sentAt: integer("sent_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => ({
    workshopStatusIdx: index("workshop_outbox_workshop_status_idx").on(
      table.workshopId,
      table.status,
    ),
    runIdx: index("workshop_outbox_run_idx").on(table.runId),
  }),
);

export type WorkshopOutboxItem = InferSelectModel<typeof workshopOutbox>;
export type InsertWorkshopOutboxItem = InferInsertModel<typeof workshopOutbox>;

// Characters
export const characters = sqliteTable("characters", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  avatarConfig: text("avatar_config").default(JSON.stringify({})),
  jobId: text("job_id")
    .notNull()
    .unique()
    .references(() => scheduledJobs.id, { onDelete: "cascade" }),
  insightId: text("insight_id")
    .notNull()
    .unique()
    .references(() => insight.id, { onDelete: "set null" }),
  status: text("status").notNull().default("active"),
  lastExecutionAt: integer("last_execution_at", { mode: "timestamp" }),
  lastExecutionStatus: text("last_execution_status"),
  sources: text("sources").default(JSON.stringify([])),
  topics: text("topics").default(JSON.stringify([])),
  notificationChannels: text("notification_channels").default(
    JSON.stringify([]),
  ),
  systemNotification: integer("system_notification", { mode: "boolean" })
    .notNull()
    .default(sql`1`),
  systemType: text("system_type"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type Character = InferSelectModel<typeof characters>;
export type InsertCharacter = InferInsertModel<typeof characters>;

// ============================================================================
// Weight Management Tables
// ============================================================================

// Insight Weights Table (SQLite)
// Stores weight-related data for insights (separate table for cleaner separation)
export const insightWeights = sqliteTable(
  "insight_weights",
  {
    id: text("id").primaryKey(),
    insightId: text("insight_id").references(() => insight.id, {
      onDelete: "cascade",
    }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    customWeightMultiplier: integer("custom_weight_multiplier")
      .notNull()
      .default(1),
    lastViewedAt: integer("last_viewed_at", { mode: "timestamp" }).notNull(),
    lastRankCalculatedAt: integer("last_rank_calculated_at", {
      mode: "timestamp",
    }).notNull(),
    currentEventRank: integer("current_event_rank").notNull().default(0),
    accessCountTotal: integer("access_count_total").notNull().default(0),
    accessCount7d: integer("access_count_7d").notNull().default(0),
    accessCount30d: integer("access_count_30d").notNull().default(0),
    lastAccessedAt: integer("last_accessed_at", { mode: "timestamp" }),
    lastWeightAdjustmentReason: text("last_weight_adjustment_reason"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    uniqueInsightUser: uniqueIndex("weights_insight_user_idx").on(
      table.insightId,
      table.userId,
    ),
    insightIdx: index("weights_insight_idx").on(table.insightId),
    userIdx: index("weights_user_idx").on(table.userId),
    lastViewedIdx: index("weights_last_viewed_idx").on(table.lastViewedAt),
    accessCount30dIdx: index("weights_access_count_30d_idx").on(
      table.userId,
      table.accessCount30d,
    ),
    lastAccessedIdx: index("weights_last_accessed_idx").on(
      table.userId,
      table.lastAccessedAt,
    ),
  }),
);

export type InsightWeight = InferSelectModel<typeof insightWeights>;
export type InsertInsightWeight = InferInsertModel<typeof insightWeights>;

// Insight Weight History Table (SQLite)
// Tracks all weight adjustments for insights
export const insightWeightHistory = sqliteTable(
  "insight_weight_history",
  {
    id: text("id").primaryKey(),
    insightId: text("insight_id").references(() => insight.id, {
      onDelete: "cascade",
    }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    adjustmentType: text("adjustment_type").notNull(),
    weightBefore: text("weight_before").notNull(),
    weightAfter: text("weight_after").notNull(),
    weightDelta: text("weight_delta").notNull(),
    customMultiplierBefore: text("custom_multiplier_before"),
    customMultiplierAfter: text("custom_multiplier_after"),
    reason: text("reason").notNull(),
    context: text("context").$type<string | null>(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    insightIdx: index("weight_history_insight_idx").on(
      table.insightId,
      table.createdAt,
    ),
    userIdx: index("weight_history_user_idx").on(table.userId, table.createdAt),
    typeIdx: index("weight_history_type_idx").on(
      table.adjustmentType,
      table.createdAt,
    ),
  }),
);

export type InsightWeightHistory = InferSelectModel<
  typeof insightWeightHistory
>;
export type InsertInsightWeightHistory = InferInsertModel<
  typeof insightWeightHistory
>;

// Insight View History Table (SQLite)
// Tracks user views of insights
export const insightViewHistory = sqliteTable(
  "insight_view_history",
  {
    id: text("id").primaryKey(),
    insightId: text("insight_id").references(() => insight.id, {
      onDelete: "cascade",
    }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    viewDurationSeconds: integer("view_duration_seconds"),
    viewSource: text("view_source").notNull(),
    viewContext: text("view_context").$type<string | null>(),
    viewedAt: integer("viewed_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    uniqueInsightUserTime: uniqueIndex("view_history_insight_user_time_idx").on(
      table.insightId,
      table.userId,
      table.viewedAt,
    ),
    insightUserIdx: index("view_history_insight_user_idx").on(
      table.insightId,
      table.userId,
      table.viewedAt,
    ),
    userTimeIdx: index("view_history_user_time_idx").on(
      table.userId,
      table.viewedAt,
    ),
  }),
);

export type InsightViewHistory = InferSelectModel<typeof insightViewHistory>;
export type InsertInsightViewHistory = InferInsertModel<
  typeof insightViewHistory
>;

// Insight Weight Config Table (SQLite)
// Stores weight configuration (global and per-user)
export const insightWeightConfig = sqliteTable(
  "insight_weight_config",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    configKey: text("config_key").notNull(),
    configValue: text("config_value").notNull(),
    description: text("description"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    uniqueUserKey: uniqueIndex("weight_config_user_key_idx").on(
      table.userId,
      table.configKey,
    ),
  }),
);

export type InsightWeightConfig = InferSelectModel<typeof insightWeightConfig>;
export type InsertInsightWeightConfig = InferInsertModel<
  typeof insightWeightConfig
>;

// ============================================================================
// Living Connections Tables (Hebbian potentiation)
// ============================================================================

// Insight Connections Table (SQLite)
// Tracks Hebbian potentiation - connections between insights that strengthen when co-accessed
export const insightConnections = sqliteTable(
  "insight_connections",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    insightIdA: text("insight_id_a")
      .notNull()
      .references(() => insight.id, { onDelete: "cascade" }),
    insightIdB: text("insight_id_b")
      .notNull()
      .references(() => insight.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    strength: integer("strength").notNull().default(0.1), // Stored as integer (multiply by 1000000 for precision)
    coAccessCount: integer("co_access_count").notNull().default(0),
    lastStrengthenedAt: integer("last_strengthened_at", { mode: "timestamp" }),
    stability: integer("stability").notNull().default(1.0), // Stored as integer (multiply by 10000 for precision)
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    uniqueConnection: uniqueIndex("insight_connection_unique_idx").on(
      table.insightIdA,
      table.insightIdB,
      table.userId,
    ),
    userIdx: index("insight_connection_user_idx").on(table.userId),
    insightAIdx: index("insight_connection_insight_a_idx").on(table.insightIdA),
    insightBIdx: index("insight_connection_insight_b_idx").on(table.insightIdB),
    strengthIdx: index("insight_connection_strength_idx").on(
      table.userId,
      table.strength,
    ),
    lastStrengthenedIdx: index("insight_connection_last_strengthened_idx").on(
      table.userId,
      table.lastStrengthenedAt,
    ),
  }),
);

export type InsightConnection = InferSelectModel<typeof insightConnections>;
export type InsertInsightConnection = InferInsertModel<
  typeof insightConnections
>;

// ============================================================================
// Entity Registry Tables
// ============================================================================

// Entity Registry Table (SQLite)
// Tracks entities (people, groups, concepts) as first-class citizens
export const entities = sqliteTable(
  "entities",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(), // "person" | "group" | "concept" | "project" | "company"
    canonicalName: text("canonical_name").notNull(),
    aliases: text("aliases").notNull().default("[]").$type<string[]>(), // JSON array
    disambiguationContext: text("disambiguation_context"),
    sourceBotIds: text("source_bot_ids")
      .notNull()
      .default("[]")
      .$type<string[]>(), // JSON array
    insightCount: integer("insight_count").notNull().default(0),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    isPinned: integer("is_pinned", { mode: "boolean" })
      .notNull()
      .default(false),
    isIgnored: integer("is_ignored", { mode: "boolean" })
      .notNull()
      .default(false),
    notes: text("notes"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    uniqueEntity: uniqueIndex("entity_unique_idx").on(
      table.userId,
      table.entityType,
      table.canonicalName,
    ),
    userIdx: index("entity_user_idx").on(table.userId),
    typeIdx: index("entity_type_idx").on(table.entityType),
    nameSearchIdx: index("entity_name_search_idx").on(table.canonicalName),
    lastSeenIdx: index("entity_last_seen_idx").on(
      table.userId,
      table.lastSeenAt,
    ),
  }),
);

export type Entity = InferSelectModel<typeof entities>;
export type InsertEntity = InferInsertModel<typeof entities>;

// Insight-Entity Junction Table (SQLite)
// Links insights to entities with roles
export const insightEntities = sqliteTable(
  "insight_entities",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    insightId: text("insight_id")
      .notNull()
      .references(() => insight.id, { onDelete: "cascade" }),
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // "subject" | "object" | "mentioned"
    confidence: integer("confidence").notNull().default(0.5), // Stored as integer (0-10000)
    textSpan: text("text_span"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    uniqueInsightEntity: uniqueIndex("insight_entity_unique_idx").on(
      table.insightId,
      table.entityId,
    ),
    insightIdx: index("insight_entity_insight_idx").on(table.insightId),
    entityIdx: index("insight_entity_entity_idx").on(table.entityId),
    roleIdx: index("insight_entity_role_idx").on(table.role),
  }),
);

export type InsightEntity = InferSelectModel<typeof insightEntities>;
export type InsertInsightEntity = InferInsertModel<typeof insightEntities>;

export const pageStateSnapshots = sqliteTable(
  "page_state_snapshots",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull().$type<Record<string, unknown>>(),
    meta: text("meta").notNull().$type<Record<string, unknown>>(),
    generatedAt: integer("generated_at", { mode: "timestamp" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    staleUntil: integer("stale_until", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    userKeyIdx: uniqueIndex("page_state_snapshots_user_key_idx").on(
      table.userId,
      table.key,
    ),
    userExpiryIdx: index("page_state_snapshots_user_expiry_idx").on(
      table.userId,
      table.expiresAt,
    ),
    staleUntilIdx: index("page_state_snapshots_stale_until_idx").on(
      table.staleUntil,
    ),
  }),
);

export type PageStateSnapshot = InferSelectModel<typeof pageStateSnapshots>;
export type InsertPageStateSnapshot = InferInsertModel<
  typeof pageStateSnapshots
>;
