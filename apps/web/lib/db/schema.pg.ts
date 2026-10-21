import { sql, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import {
  pgTable,
  varchar,
  timestamp,
  json,
  uuid,
  text,
  primaryKey,
  foreignKey,
  boolean,
  jsonb,
  uniqueIndex,
  unique,
  integer,
  numeric,
  index,
  bigint,
  bigserial,
  real,
  type AnyPgColumn,
  check,
} from "drizzle-orm/pg-core";
import type { DetailData, TimelineData } from "../ai/subagents/insights";
import type { ContactMeta } from "@openzhiyu/integrations/contacts";
import type { InsightFilter } from "@/lib/insights/filter-schema";
import type { TaskPlan } from "@openzhiyu/ai/agent/types";

export const user = pgTable("User", {
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  email: varchar("email", { length: 64 }).notNull(),
  password: varchar("password", { length: 64 }),
  name: varchar("name", { length: 64 }),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  firstLoginAt: timestamp("first_login_at", { withTimezone: true }),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  finishOnboarding: boolean("finish_on_boarding").notNull().default(false),
  sessionVersion: integer("session_version").notNull().default(1),
});

export type User = InferSelectModel<typeof user>;

export const passwordResetToken = pgTable(
  "PasswordResetToken",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: varchar("token", { length: 128 }).notNull(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    tokenKey: uniqueIndex("PasswordResetToken_token_key").on(table.token),
    userIdx: index("PasswordResetToken_user_idx").on(table.userId),
  }),
);

export type PasswordResetToken = InferSelectModel<typeof passwordResetToken>;

export const nativeAgentPlans = pgTable(
  "native_agent_plans",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    planId: text("plan_id").notNull(),
    planJson: jsonb("plan_json").$type<TaskPlan>().notNull(),
    originalPrompt: text("original_prompt").notNull(),
    workDir: text("work_dir"),
    taskId: text("task_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    ownerPlanIdx: uniqueIndex("native_agent_plans_owner_plan_idx").on(
      table.ownerId,
      table.planId,
    ),
    planIdIdx: index("native_agent_plans_plan_id_idx").on(table.planId),
    expiresIdx: index("native_agent_plans_expires_idx").on(table.expiresAt),
  }),
);

export type NativeAgentPlanRow = InferSelectModel<typeof nativeAgentPlans>;
export type InsertNativeAgentPlan = InferInsertModel<typeof nativeAgentPlans>;

// Server-owned answer events. Message parts are only a display mirror.
export const agentAnswerAudits = pgTable(
  "agent_answer_audits",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    ownerId: uuid("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id").notNull(),
    chatId: uuid("chat_id").notNull().references(() => chat.id, { onDelete: "cascade" }),
    assistantMessageId: uuid("assistant_message_id").notNull(),
    workId: uuid("work_id"),
    eventKey: text("event_key").notNull(),
    eventType: text("event_type").notNull(),
    requestKey: text("request_key"),
    requestPayloadHash: text("request_payload_hash"),
    schemaVersion: text("schema_version").notNull(),
    ruleVersion: text("rule_version").notNull(),
    runtimeHash: text("runtime_hash").notNull(),
    payloadHash: text("payload_hash").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    eventKeyIdx: uniqueIndex("agent_answer_audits_event_key_idx").on(table.ownerId, table.turnId, table.eventKey),
    requestKeyIdx: uniqueIndex("agent_answer_audits_request_key_idx").on(table.ownerId, table.requestKey).where(sql`${table.eventType} = 'turn_started'`),
    turnStartIdx: uniqueIndex("agent_answer_audits_turn_start_idx").on(table.turnId).where(sql`${table.eventType} = 'turn_started'`),
    assistantStartIdx: uniqueIndex("agent_answer_audits_assistant_start_idx").on(table.assistantMessageId).where(sql`${table.eventType} = 'turn_started'`),
    turnSeqIdx: index("agent_answer_audits_turn_seq_idx").on(table.ownerId, table.turnId, table.seq),
    messageIdx: index("agent_answer_audits_message_idx").on(table.ownerId, table.chatId, table.assistantMessageId),
    requestCheck: check("agent_answer_audits_request_check", sql`(${table.eventType} = 'turn_started' AND ${table.requestKey} IS NOT NULL AND ${table.requestPayloadHash} IS NOT NULL) OR (${table.eventType} <> 'turn_started' AND ${table.requestKey} IS NULL AND ${table.requestPayloadHash} IS NULL)`),
  }),
);

export type AgentAnswerAuditRow = InferSelectModel<typeof agentAnswerAudits>;

export const chat = pgTable(
  "Chat",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    createdAt: timestamp("createdAt").notNull(),
    title: text("title").notNull(),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
    visibility: varchar("visibility", { enum: ["public", "private"] })
      .notNull()
      .default("private"),
  },
  (table) => ({
    userIdIdx: index("chat_user_id_idx").on(table.userId),
  }),
);

export type Chat = InferSelectModel<typeof chat>;

export const chatInsights = pgTable(
  "chat_insights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chat.id, { onDelete: "cascade" }),
    insightId: uuid("insight_id")
      .notNull()
      .references(() => insight.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
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

export const message = pgTable(
  "Message_v2",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    chatId: uuid("chatId")
      .notNull()
      .references(() => chat.id),
    role: varchar("role").notNull(),
    parts: json("parts").notNull(),
    attachments: json("attachments").notNull(),
    createdAt: timestamp("createdAt").notNull(),
    metadata: jsonb("metadata"),
  },
  (table) => ({
    chatIdIdx: index("message_chat_id_idx").on(table.chatId),
  }),
);

export type DBMessage = InferSelectModel<typeof message>;

export const vote = pgTable(
  "Vote_v2",
  {
    chatId: uuid("chatId")
      .notNull()
      .references(() => chat.id),
    messageId: uuid("messageId")
      .notNull()
      .references(() => message.id),
    isUpvoted: boolean("isUpvoted").notNull(),
  },
  (table) => {
    return {
      pk: primaryKey({ columns: [table.chatId, table.messageId] }),
    };
  },
);

export type Vote = InferSelectModel<typeof vote>;

export const stream = pgTable("Stream", {
  id: uuid("id").primaryKey().defaultRandom(),
  chatId: uuid("chatId")
    .notNull()
    .references(() => chat.id, { onDelete: "cascade" }),
  createdAt: timestamp("createdAt").notNull(),
});

export type Stream = InferSelectModel<typeof stream>;

export const integrationAccounts = pgTable(
  "platform_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
    platform: varchar("platform", {
      length: 32,
      enum: [
        "telegram",
        "whatsapp",
        "slack",
        "discord",
        "gmail",
        "outlook",
        "linkedin",
        "instagram",
        "twitter",
        "google_calendar",
        "outlook_calendar",
        "teams",
        "facebook_messenger",
        "google_drive",
        "google_docs",
        "hubspot",
        "notion",
        "github",
        "asana",
        "jira",
        "linear",
        "imessage",
        "feishu",
        "dingtalk",
        "qqbot",
        "weixin",
      ],
    }).notNull(),
    externalId: text("external_id").notNull(),
    displayName: text("display_name").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown> | null>()
      .default(null),
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    encryptionKeyId: text("encryption_key_id"),
    lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }),
    rotationCount: integer("rotation_count").notNull().default(0),
    keyVersion: integer("key_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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
export const credentialRotationHistory = pgTable(
  "credential_rotation_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => integrationAccounts.id, { onDelete: "cascade" }),
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    encryptionKeyId: text("encryption_key_id"),
    rotatedAt: timestamp("rotated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    rotatedBy: text("rotated_by"),
    reason: text("reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    accountIdx: index("credential_rotation_history_account_idx").on(
      table.accountId,
      table.rotatedAt.desc(),
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
export const credentialAccessLog = pgTable(
  "credential_access_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => integrationAccounts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    action: varchar("action", { length: 16 })
      .notNull()
      .$type<"read" | "update" | "rotate" | "delete">(),
    ipAddress: varchar("ip_address", { length: 45 }),
    userAgent: text("user_agent"),
    accessedAt: timestamp("accessed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown> | null>()
      .default(null),
    success: boolean("success").notNull().default(true),
    errorMessage: text("error_message"),
  },
  (table) => ({
    accountIdx: index("credential_access_log_account_idx").on(
      table.accountId,
      table.accessedAt.desc(),
    ),
    userIdx: index("credential_access_log_user_idx").on(
      table.userId,
      table.accessedAt.desc(),
    ),
    actionIdx: index("credential_access_log_action_idx").on(
      table.action,
      table.accessedAt.desc(),
    ),
  }),
);

export type CredentialAccessLog = InferSelectModel<typeof credentialAccessLog>;
export type InsertCredentialAccessLog = InferInsertModel<
  typeof credentialAccessLog
>;

export const integrationCatalog = pgTable(
  "integration_catalog",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: varchar("slug", { length: 64 }).notNull(),
    integrationId: varchar("integration_id", { length: 32 }).notNull(),
    integrationType: varchar("integration_type", { length: 32 }).notNull(),
    category: varchar("category", { length: 64 }).notNull(),
    title: text("title").notNull(),
    description: text("description"),
    url: text("url").notNull(),
    logoUrl: text("logo_url"),
    config: jsonb("config").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    slugUnique: uniqueIndex("integration_catalog_slug_idx").on(table.slug),
  }),
);

export type IntegrationCatalogEntry = InferSelectModel<
  typeof integrationCatalog
>;

export const rssSubscriptions = pgTable(
  "rss_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    catalogId: uuid("catalog_id").references(() => integrationCatalog.id, {
      onDelete: "set null",
    }),
    integrationAccountId: uuid("integration_account_id").references(
      () => integrationAccounts.id,
      { onDelete: "set null" },
    ),
    sourceUrl: text("source_url").notNull(),
    title: text("title"),
    category: varchar("category", { length: 64 }),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    sourceType: varchar("source_type", { length: 32 })
      .notNull()
      .default("custom"),
    etag: text("etag"),
    lastModified: text("last_modified"),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    lastErrorCode: varchar("last_error_code", { length: 32 }),
    lastErrorMessage: text("last_error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userSourceUnique: uniqueIndex("rss_subscriptions_user_url_idx").on(
      table.userId,
      table.sourceUrl,
    ),
  }),
);

export type RssSubscription = InferSelectModel<typeof rssSubscriptions>;

export const rssItems = pgTable(
  "rss_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => rssSubscriptions.id, { onDelete: "cascade" }),
    guidHash: varchar("guid_hash", { length: 128 }).notNull(),
    title: text("title"),
    summary: text("summary"),
    content: text("content"),
    link: text("link"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown> | null>()
      .default(null),
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

export const bot = pgTable(
  "Bot",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
    platformAccountId: uuid("platform_account_id").references(
      () => integrationAccounts.id,
      {
        onDelete: "cascade",
      },
    ),
    name: varchar("name", { length: 255 }).notNull(),
    description: varchar("description", { length: 255 }).notNull(),
    adapter: varchar("adapter", { length: 255 }).notNull(),
    adapterConfig: json("adapter_config").notNull(),
    enable: boolean("enable").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index("bot_user_id_idx").on(table.userId),
  }),
);

export type Bot = InferSelectModel<typeof bot>;

type HistorySummary = {
  title: string;
  content: string;
};

type Strategic = {
  relationship: string;
  opportunity: string;
  risk: string;
};

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

export const insight = pgTable(
  "Insight",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: uuid("botId").notNull(),
    dedupeKey: text("dedupe_key"),
    taskLabel: text("taskLabel").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    importance: varchar("importance", { length: 30 }).notNull(),
    urgency: varchar("urgency", { length: 30 }).notNull(),
    platform: text("platform"),
    account: text("account"),
    groups: text("groups")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    people: text("people")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    time: timestamp("time").notNull(),
    details: jsonb("details").$type<DetailData[] | null>().default(null),
    timeline: jsonb("timeline").$type<TimelineData[] | null>().default(null),
    insights: jsonb("insights").$type<StoredInsight[] | null>().default(null),
    trendDirection: text("trend_direction"),
    trendConfidence: numeric("trend_confidence", { precision: 5, scale: 4 })
      .$type<number | null>()
      .default(null),
    sentiment: text("sentiment"),
    sentimentConfidence: numeric("sentiment_confidence", {
      precision: 5,
      scale: 4,
    })
      .$type<number | null>()
      .default(null),
    intent: text("intent"),
    trend: text("trend"),
    issueStatus: text("issue_status"),
    communityTrend: text("community_trend"),
    duplicateFlag: boolean("duplicate_flag"),
    impactLevel: text("impact_level"),
    resolutionHint: text("resolution_hint"),
    topKeywords: text("top_keywords")
      .array()
      .default(sql`ARRAY[]::text[]`),
    topEntities: text("top_entities")
      .array()
      .default(sql`ARRAY[]::text[]`),
    topVoices: jsonb("top_voices")
      .$type<InsightTopVoice[] | null>()
      .default(null),
    sources: jsonb("sources").$type<InsightSource[] | null>().default(null),
    sourceConcentration: text("source_concentration"),
    buyerSignals: text("buyer_signals")
      .array()
      .default(sql`ARRAY[]::text[]`),
    stakeholders: jsonb("stakeholders")
      .$type<InsightStakeholder[] | null>()
      .default(null),
    contractStatus: text("contract_status"),
    signalType: text("signal_type"),
    confidence: numeric("confidence", { precision: 5, scale: 4 })
      .$type<number | null>()
      .default(null),
    scope: text("scope"),
    nextActions: jsonb("next_actions")
      .$type<InsightAction[] | null>()
      .default(null),
    followUps: jsonb("follow_ups")
      .$type<InsightFollowUp[] | null>()
      .default(null),
    actionRequired: boolean("action_required"),
    actionRequiredDetails: jsonb("action_required_details")
      .$type<InsightActionRequirementDetails | null>()
      .default(null),
    isUnreplied: boolean("is_unreplied").default(false),
    myTasks: jsonb("my_tasks").$type<InsightTaskItem[] | null>().default(null),
    waitingForMe: jsonb("waiting_for_me")
      .$type<InsightTaskItem[] | null>()
      .default(null),
    waitingForOthers: jsonb("waiting_for_others")
      .$type<InsightTaskItem[] | null>()
      .default(null),
    clarifyNeeded: boolean("clarify_needed"),
    categories: text("categories")
      .array()
      .default(sql`ARRAY[]::text[]`),
    learning: text("learning"),
    priority: jsonb("priority").$type<InsightPriority | null>().default(null),
    experimentIdeas: jsonb("experiment_ideas")
      .$type<InsightExperimentIdea[] | null>()
      .default(null),
    executiveSummary: text("executive_summary"),
    riskFlags: jsonb("risk_flags")
      .$type<InsightRiskFlag[] | null>()
      .default(null),
    client: text("client"),
    projectName: text("project_name"),
    nextMilestone: text("next_milestone"),
    dueDate: text("due_date"),
    paymentInfo: text("payment_info"),
    entity: text("entity"),
    why: text("why"),
    historySummary: jsonb("history_summary")
      .$type<HistorySummary | null>()
      .default(null),
    strategic: jsonb("strategic").$type<Strategic | null>().default(null),
    roleAttribution: jsonb("role_attribution")
      .$type<InsightRoleAttribution | null>()
      .default(null),
    alerts: jsonb("alerts").$type<InsightAlert[] | null>().default(null),
    pendingDeletionAt: timestamp("pending_deletion_at", {
      withTimezone: true,
    }),
    compactedIntoInsightId: uuid("compacted_into_insight_id").references(
      (): AnyPgColumn => insight.id,
      { onDelete: "set null" },
    ),
    isArchived: boolean("is_archived").notNull().default(false),
    isFavorited: boolean("is_favorited").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    favoritedAt: timestamp("favorited_at", { withTimezone: true }),
    // Temporal validity - enables time-travel queries
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    botIdTimeIdx: index("insight_bot_id_time_idx").on(
      table.botId,
      table.time.desc(),
    ),
    botIdArchivedIdx: index("insight_bot_id_archived_idx").on(
      table.botId,
      table.isArchived,
    ),
    botIdPendingDeletionIdx: index("insight_bot_id_pending_deletion_idx").on(
      table.botId,
      table.pendingDeletionAt,
    ),
    compactedIntoInsightIdx: index("insight_compacted_into_idx").on(
      table.compactedIntoInsightId,
    ),
    // Index for temporal/time-travel queries
    validFromIdx: index("insight_valid_from_idx").on(table.validFrom),
    validToIdx: index("insight_valid_to_idx").on(table.validTo),
    // Composite index for as-of queries: find insights valid at a point in time
    validTimeIdx: index("insight_valid_time_idx").on(
      table.validFrom,
      table.validTo,
    ),
  }),
);

export type Insight = InferSelectModel<typeof insight>;
export type InsertInsight = InferInsertModel<typeof insight>;

export const insightEmbeddings = pgTable(
  "insight_embeddings",
  {
    insightId: uuid("insight_id")
      .primaryKey()
      .references(() => insight.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bot.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    embedding: text("embedding").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    embeddingDimensions: integer("embedding_dimensions").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const rawMessages = pgTable(
  "raw_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    messageId: text("message_id").notNull(),
    platform: text("platform").notNull(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bot.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    channel: text("channel"),
    person: text("person"),
    timestamp: bigint("timestamp", { mode: "number" }).notNull(),
    content: text("content").notNull(),
    attachments: jsonb("attachments")
      .$type<Array<{
        name: string;
        url: string;
        contentType?: string;
        sizeBytes?: number;
      }> | null>()
      .default(null),
    embedding: text("embedding"),
    embeddingModel: text("embedding_model"),
    embeddingContentHash: text("embedding_content_hash"),
    embeddingDimensions: integer("embedding_dimensions"),
    embeddingUpdatedAt: bigint("embedding_updated_at", { mode: "number" }),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    memoryStage: varchar("memory_stage", { length: 16 }).default("short"),
    accessCount: integer("access_count").default(0),
    lastAccessAt: bigint("last_access_at", { mode: "number" }),
    importanceScore: real("importance_score").default(0),
    archivedAt: bigint("archived_at", { mode: "number" }),
    isPinned: boolean("is_pinned").default(false),
    summaryRefId: text("summary_ref_id"),
  },
  (table) => ({
    messageIdUnique: uniqueIndex("raw_messages_message_id_idx").on(
      table.messageId,
    ),
    userTimestampIdx: index("raw_messages_user_timestamp_idx").on(
      table.userId,
      table.timestamp,
    ),
    userMemoryStageIdx: index("raw_messages_user_memory_stage_idx").on(
      table.userId,
      table.memoryStage,
    ),
    platformIdx: index("raw_messages_platform_idx").on(table.platform),
    botIdx: index("raw_messages_bot_id_idx").on(table.botId),
    archivedAtIdx: index("raw_messages_archived_at_idx").on(table.archivedAt),
    createdAtIdx: index("raw_messages_created_at_idx").on(table.createdAt),
  }),
);

export type RawMessageRow = InferSelectModel<typeof rawMessages>;
export type InsertRawMessageRow = InferInsertModel<typeof rawMessages>;

export const memorySummaries = pgTable(
  "memory_summaries",
  {
    summaryId: text("summary_id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    summaryTier: varchar("summary_tier", { length: 8 }).notNull(),
    sourceTier: varchar("source_tier", { length: 16 }).notNull(),
    startTimestamp: bigint("start_timestamp", { mode: "number" }).notNull(),
    endTimestamp: bigint("end_timestamp", { mode: "number" }).notNull(),
    messageCount: integer("message_count").notNull(),
    sourceRecordIds: jsonb("source_record_ids")
      .$type<string[] | null>()
      .default(null),
    keyPoints: jsonb("key_points").$type<string[] | null>().default(null),
    keywords: jsonb("keywords").$type<string[] | null>().default(null),
    keywordsText: text("keywords_text"),
    summaryText: text("summary_text").notNull(),
    dimensions: jsonb("dimensions")
      .$type<Record<string, string | number | boolean | undefined> | null>()
      .default(null),
    qualityScore: real("quality_score"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => ({
    userTimeIdx: index("memory_summaries_user_time_idx").on(
      table.userId,
      table.endTimestamp,
    ),
    userTierIdx: index("memory_summaries_user_tier_idx").on(
      table.userId,
      table.summaryTier,
    ),
  }),
);

export type MemorySummaryRow = InferSelectModel<typeof memorySummaries>;
export type InsertMemorySummaryRow = InferInsertModel<typeof memorySummaries>;

export const insightCompactionLinks = pgTable(
  "insight_compaction_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    compactedInsightId: uuid("compacted_insight_id")
      .notNull()
      .references(() => insight.id, { onDelete: "cascade" }),
    sourceInsightId: uuid("source_insight_id")
      .notNull()
      .references(() => insight.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    compactedInsightIdx: index("insight_compaction_links_compacted_idx").on(
      table.compactedInsightId,
    ),
    sourceInsightIdx: index("insight_compaction_links_source_idx").on(
      table.sourceInsightId,
    ),
    uniquePairIdx: uniqueIndex("insight_compaction_links_pair_idx").on(
      table.compactedInsightId,
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

// Insight Notes Table
// Stores user notes/comments on insights
export const insightNotes = pgTable(
  "insight_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    insightId: uuid("insight_id")
      .notNull()
      .references(() => insight.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id),
    content: text("content").notNull(),
    source: varchar("source", {
      length: 32,
      enum: ["manual", "ai_conversation"],
    })
      .notNull()
      .default("manual"),
    sourceMessageId: uuid("source_message_id"), // Optional: reference to message if from AI conversation
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    insightIdx: index("insight_notes_insight_idx").on(table.insightId),
    userIdx: index("insight_notes_user_idx").on(table.userId),
    createdAtIdx: index("insight_notes_created_at_idx").on(table.createdAt),
  }),
);

export type InsightNote = InferSelectModel<typeof insightNotes>;
export type InsertInsightNote = InferInsertModel<typeof insightNotes>;

// Insight Brief Categories Table
// Stores user's manual category assignments for insights in Brief panel
export const insightBriefCategories = pgTable(
  "insight_brief_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    insightId: uuid("insight_id")
      .notNull()
      .references(() => insight.id, { onDelete: "cascade" }),
    category: varchar("category", { length: 20 })
      .notNull()
      .$type<"urgent" | "important" | "monitor" | "archive">(),
    dedupeKey: text("dedupe_key"), // For exact matching similar insights
    title: text("title"), // For fuzzy matching similar insights
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    source: varchar("source", { length: 20 }).notNull().default("manual"), // "manual" | "auto" | "unpinned"
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

// Insight Documents Table
// Associates documents with insights
export const insightDocuments = pgTable(
  "insight_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    insightId: uuid("insight_id")
      .notNull()
      .references(() => insight.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => ragDocuments.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    insightIdx: index("insight_documents_insight_idx").on(table.insightId),
    documentIdx: index("insight_documents_document_idx").on(table.documentId),
    userIdx: index("insight_documents_user_idx").on(table.userId),
    uniqueInsightDocument: unique("unique_insight_document").on(
      table.insightId,
      table.documentId,
    ),
  }),
);

export type InsightDocument = InferSelectModel<typeof insightDocuments>;
export type InsertInsightDocument = InferInsertModel<typeof insightDocuments>;

export const userInsightSettings = pgTable("user_insight_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("userId")
    .notNull()
    .references(() => user.id),
  // Store as JSON Array String
  focusPeople: text("focus_people").notNull().default(JSON.stringify([])),
  // Store as JSON Array String
  focusTopics: text("focus_topics").notNull().default(JSON.stringify([])),
  language: text("language").notNull().default(""),
  refreshIntervalMinutes: integer("refresh_interval_minutes")
    .notNull()
    .default(60),
  lastMessageProcessedAt: timestamp("last_message_processed_at"),
  lastActiveAt: timestamp("last_active_at"),
  lastInsightMaintenanceRunAt: timestamp("last_insight_maintenance_run_at"),
  lastInsightEmbeddingDreamRunAt: timestamp(
    "last_insight_embedding_dream_run_at",
  ),
  activityTier: varchar("activity_tier", { length: 16 })
    .notNull()
    .default("low"),
  aiSoulPrompt: text("ai_soul_prompt"),
  /** User manually filled industry (JSON array string), max 4 items, takes priority over survey */
  identityIndustries: text("identity_industries"),
  /** User manually filled work description, max 5000 characters, takes priority over survey */
  identityWorkDescription: text("identity_work_description"),
  lastUpdated: timestamp("last_updated").notNull().defaultNow(),
});
export type DBInsightSettings = InferSelectModel<typeof userInsightSettings>;
export type DBInsertInsightSettings = InferInsertModel<
  typeof userInsightSettings
>;

export const userLlmApiSettings = pgTable(
  "user_llm_api_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    providerType: varchar("provider_type", { length: 32 })
      .$type<"openai_compatible" | "anthropic_compatible">()
      .notNull(),
    apiKeyEncrypted: text("api_key_encrypted"),
    encryptionKeyId: text("encryption_key_id"),
    baseUrl: text("base_url"),
    model: text("model"),
    enabled: boolean("enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const personCustomFields = pgTable(
  "person_custom_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id),
    personId: text("person_id").notNull(),
    fields: jsonb("fields")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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
  lastMessageProcessedAt: Date | null;
  lastActiveAt: Date | null;
  lastInsightMaintenanceRunAt?: Date | null;
  lastInsightEmbeddingDreamRunAt?: Date | null;
  activityTier: "high" | "medium" | "low" | "dormant";
  aiSoulPrompt: string | null;
  identityIndustries: string[] | null;
  identityWorkDescription: string | null;
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
    lastMessageProcessedAt: dbSettings.lastMessageProcessedAt ?? null,
    lastActiveAt: dbSettings.lastActiveAt ?? null,
    lastInsightMaintenanceRunAt: dbSettings.lastInsightMaintenanceRunAt ?? null,
    lastInsightEmbeddingDreamRunAt:
      dbSettings.lastInsightEmbeddingDreamRunAt ?? null,
    activityTier: normalizeActivityTier(dbSettings.activityTier),
    aiSoulPrompt: dbSettings.aiSoulPrompt ?? null,
    identityIndustries:
      dbSettings.identityIndustries != null
        ? (JSON.parse(dbSettings.identityIndustries) as string[])
        : null,
    identityWorkDescription: dbSettings.identityWorkDescription ?? null,
    lastUpdated: dbSettings.lastUpdated,
  };
}

export const userRoles = pgTable(
  "user_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    roleKey: text("role_key").notNull(),
    source: text("source").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 })
      .$type<number>()
      .notNull()
      .default(0.5),
    firstDetectedAt: timestamp("first_detected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }),
    evidence: jsonb("evidence")
      .$type<Record<string, unknown> | null>()
      .default(null),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    uniqueRole: uniqueIndex("user_roles_unique").on(
      table.userId,
      table.roleKey,
      table.source,
    ),
    userIdx: index("user_roles_user_idx").on(table.userId, table.roleKey),
  }),
);
export type UserRole = InferSelectModel<typeof userRoles>;
export type InsertUserRole = InferInsertModel<typeof userRoles>;

export function serializeInsightSettings(
  settings: InsightSettings,
): Omit<DBInsertInsightSettings, "id" | "lastUpdated"> {
  return {
    userId: settings.userId,
    focusPeople: Array.isArray(settings.focusPeople)
      ? JSON.stringify(settings.focusPeople)
      : settings.focusPeople,
    focusTopics: Array.isArray(settings.focusTopics)
      ? JSON.stringify(settings.focusTopics)
      : settings.focusTopics,
    language: settings.language,
    refreshIntervalMinutes: settings.refreshIntervalMinutes,
    lastMessageProcessedAt: settings.lastMessageProcessedAt,
    lastActiveAt: settings.lastActiveAt,
    lastInsightMaintenanceRunAt: settings.lastInsightMaintenanceRunAt,
    lastInsightEmbeddingDreamRunAt: settings.lastInsightEmbeddingDreamRunAt,
    activityTier: settings.activityTier,
    aiSoulPrompt: settings.aiSoulPrompt ?? null,
    identityIndustries:
      settings.identityIndustries != null &&
      settings.identityIndustries.length > 0
        ? JSON.stringify(settings.identityIndustries)
        : null,
    identityWorkDescription: settings.identityWorkDescription ?? null,
  };
}

export const insightFilters = pgTable(
  "insight_filters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    color: varchar("color", { length: 16 }),
    icon: varchar("icon", { length: 64 }),
    sortOrder: integer("sort_order").notNull().default(0),
    isPinned: boolean("is_pinned").notNull().default(false),
    isArchived: boolean("is_archived").notNull().default(false),
    source: varchar("source", { length: 16 }).notNull().default("user"),
    definition: jsonb("definition").$type<InsightFilter>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const insightTabs = pgTable(
  "insight_tabs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: varchar("type", { length: 16 }).notNull().default("custom"),
    filter: jsonb("filter").$type<InsightFilter>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userIdx: index("insight_tabs_user_idx").on(table.userId),
    userEnabledIdx: index("insight_tabs_user_enabled_idx").on(
      table.userId,
      table.enabled,
    ),
  }),
);
export type DBInsightTab = InferSelectModel<typeof insightTabs>;
export type DBInsertInsightTab = InferInsertModel<typeof insightTabs>;

export const userCategories = pgTable(
  "user_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 128 }).notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userCategoryNameIdx: uniqueIndex("user_categories_user_name_idx").on(
      table.userId,
      table.name,
    ),
    userIdx: index("user_categories_user_idx").on(table.userId),
  }),
);
export type DBUserCategory = InferSelectModel<typeof userCategories>;
export type DBInsertUserCategory = InferInsertModel<typeof userCategories>;

export const telegramAccounts = pgTable(
  "telegram_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => user.id, { onDelete: "cascade" })
      .notNull(),
    telegramUserId: text("telegram_user_id").notNull(),
    telegramChatId: text("telegram_chat_id").notNull(),
    username: text("username"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    languageCode: text("language_code"),
    isBot: boolean("is_bot").notNull().default(false),
    linkedAt: timestamp("linked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastCommandAt: timestamp("last_command_at", { withTimezone: true }),
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

export const discordAccounts = pgTable(
  "discord_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .references(() => user.id, { onDelete: "cascade" })
      .notNull(),
    discordUserId: text("discord_user_id").notNull(),
    discordGuildId: text("discord_guild_id"),
    discordChannelId: text("discord_channel_id"),
    username: text("username"),
    globalName: text("global_name"),
    linkedAt: timestamp("linked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastCommandAt: timestamp("last_command_at", { withTimezone: true }),
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

export const userContacts = pgTable(
  "user_meta_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
    contactId: text("contact_id").notNull(),
    contactName: text("contact_name").notNull(),
    type: text("contact_type"),
    botId: text("bot_id"),
    contactMeta: jsonb("contact_meta")
      .$type<ContactMeta | null>()
      .default(null),
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

/**
 * DingTalk Stream inbound message cache, for Insight to pull history by session (DingTalk has no official session message list API)
 */
export const dingtalkBotInsightMessages = pgTable(
  "dingtalk_bot_insight_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bot.id, { onDelete: "cascade" }),
    chatId: text("chat_id").notNull(),
    msgId: text("msg_id").notNull(),
    senderId: text("sender_id"),
    senderName: text("sender_name"),
    text: text("text").notNull(),
    tsSec: integer("ts_sec").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const affiliates = pgTable(
  "affiliates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    code: varchar("code", { length: 64 }).notNull(),
    slug: varchar("slug", { length: 64 }),
    commissionRate: numeric("commission_rate", { precision: 6, scale: 4 })
      .$type<number>()
      .notNull()
      .default(0),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown> | null>()
      .default(null),
  },
  (table) => ({
    uniqueAffiliateCode: uniqueIndex("unique_affiliate_code").on(table.code),
    uniqueAffiliateSlug: uniqueIndex("unique_affiliate_slug").on(table.slug),
    uniqueAffiliateUser: uniqueIndex("unique_affiliate_user").on(table.userId),
  }),
);
export type Affiliate = InferSelectModel<typeof affiliates>;
export type AffiliateInsert = InferInsertModel<typeof affiliates>;

export const affiliateClicks = pgTable("affiliate_clicks", {
  id: uuid("id").primaryKey().defaultRandom(),
  affiliateId: uuid("affiliate_id")
    .notNull()
    .references(() => affiliates.id, { onDelete: "cascade" }),
  url: varchar("url", { length: 512 }),
  referrer: varchar("referrer", { length: 512 }),
  ipAddress: varchar("ip_address", { length: 45 }),
  userAgent: text("user_agent"),
  metadata: jsonb("metadata")
    .$type<Record<string, unknown> | null>()
    .default(null),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type AffiliateClick = InferSelectModel<typeof affiliateClicks>;

export const affiliatePayouts = pgTable("affiliate_payouts", {
  id: uuid("id").primaryKey().defaultRandom(),
  affiliateId: uuid("affiliate_id")
    .notNull()
    .references(() => affiliates.id, { onDelete: "cascade" }),
  method: varchar("method", { length: 32 }).notNull(),
  destinationDetails: jsonb("destination_details")
    .$type<Record<string, unknown> | null>()
    .default(null),
  currency: varchar("currency", { length: 8 }).notNull().default("USD"),
  amount: numeric("amount", { precision: 12, scale: 2 })
    .$type<number>()
    .notNull(),
  status: varchar("status", { length: 16 }).notNull().default("requested"),
  requestedAt: timestamp("requested_at").notNull().defaultNow(),
  processedAt: timestamp("processed_at"),
  remarks: text("remarks"),
  adminUserId: uuid("admin_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type AffiliatePayout = InferSelectModel<typeof affiliatePayouts>;

export const coupons = pgTable(
  "coupons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: varchar("code", { length: 96 }).notNull(),
    planId: varchar("plan_id", { length: 32 }),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    stripeCouponId: varchar("stripe_coupon_id", { length: 64 }).notNull(),
    stripePromotionCodeId: varchar("stripe_promotion_code_id", {
      length: 64,
    }).notNull(),
    stripePromotionCode: varchar("stripe_promotion_code", {
      length: 64,
    }).notNull(),
    discountType: varchar("discount_type", { length: 16 }).notNull(),
    percentageOff: numeric("percentage_off", { precision: 5, scale: 2 })
      .$type<number | null>()
      .default(null),
    amountOff: numeric("amount_off", { precision: 12, scale: 2 })
      .$type<number | null>()
      .default(null),
    currency: varchar("currency", { length: 8 }),
    duration: varchar("duration", { length: 16 }).notNull().default("once"),
    durationInMonths: integer("duration_in_months"),
    maxRedemptions: integer("max_redemptions").notNull().default(1),
    redeemedCount: integer("redeemed_count").notNull().default(0),
    activationExpiresAt: timestamp("activation_expires_at", {
      withTimezone: true,
    }),
    assignedUserId: uuid("assigned_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    assignedEmail: varchar("assigned_email", { length: 128 }),
    roleTag: varchar("role_tag", { length: 64 }),
    label: varchar("label", { length: 128 }),
    notes: text("notes"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown> | null>()
      .default(null),
    createdByUserId: uuid("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    redeemedByUserId: uuid("redeemed_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    stripeCheckoutSessionId: varchar("stripe_checkout_session_id", {
      length: 255,
    }),
    stripeSubscriptionId: varchar("stripe_subscription_id", { length: 255 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
  },
  (table) => ({
    uniqueCouponCode: uniqueIndex("unique_coupon_code").on(table.code),
    couponPlanIdx: index("coupon_plan_idx").on(table.planId),
    couponStatusIdx: index("coupon_status_idx").on(table.status),
    couponAssignedUserIdx: index("coupon_assigned_user_idx").on(
      table.assignedUserId,
    ),
  }),
);
export type Coupon = InferSelectModel<typeof coupons>;
export type CouponInsert = InferInsertModel<typeof coupons>;

export const couponRedemptions = pgTable(
  "coupon_redemptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    couponId: uuid("coupon_id")
      .notNull()
      .references(() => coupons.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    stripeCheckoutSessionId: varchar("stripe_checkout_session_id", {
      length: 255,
    }),
    stripeSubscriptionId: varchar("stripe_subscription_id", {
      length: 255,
    }),
    stripeCustomerId: varchar("stripe_customer_id", { length: 64 }),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    redemptionCouponIdx: index("coupon_redemption_coupon_idx").on(
      table.couponId,
    ),
    redemptionUserIdx: index("coupon_redemption_user_idx").on(table.userId),
    uniqueRedemptionSession: uniqueIndex("coupon_redemption_session_unique").on(
      table.stripeCheckoutSessionId,
    ),
  }),
);
export type CouponRedemption = InferSelectModel<typeof couponRedemptions>;
export type CouponRedemptionInsert = InferInsertModel<typeof couponRedemptions>;

export const userSubscriptions = pgTable(
  "user_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
    planName: text("plan_name").notNull(),
    startDate: timestamp("start_date").notNull().defaultNow(), // Subscription start date
    endDate: timestamp("end_date"), // Subscription end date (null means permanent)
    isActive: boolean("is_active").default(true), // Is active
    autoRenew: boolean("auto_renew").default(true), // Auto renew enabled
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripeCustomerId: text("stripe_customer_id"),
    stripePriceId: text("stripe_price_id"),
    status: varchar("status", { length: 32 }).default("incomplete").notNull(),
    billingCycle: varchar("billing_cycle", { length: 16 }),
    lastPaymentDate: timestamp("last_payment_date"), // Last payment date
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
    affiliateId: uuid("affiliate_id").references(() => affiliates.id, {
      onDelete: "set null",
    }),
    affiliateCode: varchar("affiliate_code", { length: 64 }),
    affiliateCommissionRate: numeric("affiliate_commission_rate", {
      precision: 6,
      scale: 4,
    })
      .$type<number | null>()
      .default(null),
  },
  (table) => ({
    uniqueUserSubscription: uniqueIndex("unique_user_subscription").on(
      table.userId,
      table.isActive,
    ),
  }),
);

export const affiliateTransactions = pgTable(
  "affiliate_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    affiliateId: uuid("affiliate_id")
      .notNull()
      .references(() => affiliates.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id").references(
      () => userSubscriptions.id,
      {
        onDelete: "set null",
      },
    ),
    orderId: text("order_id").notNull(),
    userId: uuid("user_id").references(() => user.id, { onDelete: "set null" }),
    planId: text("plan_id"),
    currency: varchar("currency", { length: 8 }).notNull().default("USD"),
    amount: numeric("amount", { precision: 12, scale: 2 })
      .$type<number>()
      .notNull(),
    commissionRate: numeric("commission_rate", { precision: 6, scale: 4 })
      .$type<number>()
      .notNull(),
    commissionAmount: numeric("commission_amount", { precision: 12, scale: 2 })
      .$type<number>()
      .notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    payoutId: uuid("payout_id").references(() => affiliatePayouts.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown> | null>()
      .default(null),
    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqueAffiliateOrder: uniqueIndex("unique_affiliate_order").on(
      table.orderId,
    ),
    affiliateIdx: index("affiliate_transactions_affiliate_idx").on(
      table.affiliateId,
    ),
    affiliateStatusIdx: index("affiliate_transactions_status_idx").on(
      table.affiliateId,
      table.status,
    ),
  }),
);
export type AffiliateTransaction = InferSelectModel<
  typeof affiliateTransactions
>;

export const userMonthlyQuota = pgTable(
  "user_monthly_quota",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
    year: integer("year").notNull(), // Year (e.g., 2024)
    month: integer("month").notNull(), // Month (1-12)
    totalQuota: integer("total_quota").notNull(), // Monthly total quota (based on subscription plan)
    usedQuota: integer("used_quota").notNull().default(0), // Monthly used quota
    isRefreshed: boolean("is_refreshed").default(false), // Flag: whether monthly refresh is completed
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
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

export const userFreeQuota = pgTable(
  "user_free_quota",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
    totalQuota: integer("total_quota").notNull().default(2048),
    usedQuota: integer("used_quota").notNull().default(0),
    lastAdjustedAt: timestamp("last_adjusted_at").defaultNow(),
  },
  (table) => ({
    uniqueUser: uniqueIndex("unique_free_user").on(table.userId),
  }),
);

export const userRewardEvents = pgTable(
  "user_reward_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    rewardType: varchar("reward_type", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("available"),
    creditsGranted: integer("credits_granted").notNull().default(0),
    triggerReference: text("trigger_reference"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown> | null>()
      .default(null),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    grantedAt: timestamp("granted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    rewardTypeUnique: uniqueIndex("user_reward_unique_type").on(
      table.userId,
      table.rewardType,
    ),
    userStatusIdx: index("user_reward_status_idx").on(
      table.userId,
      table.status,
    ),
  }),
);

export const userCreditLedger = pgTable(
  "user_credit_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(),
    balanceAfter: integer("balance_after"),
    source: varchar("source", { length: 32 }).notNull().default("reward"),
    rewardEventId: uuid("reward_event_id").references(
      () => userRewardEvents.id,
      { onDelete: "set null" },
    ),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown> | null>()
      .default(null),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userLedgerIdx: index("user_credit_ledger_user_idx").on(table.userId),
    rewardLedgerIdx: index("user_credit_ledger_reward_idx").on(
      table.rewardEventId,
    ),
  }),
);

export const userFileUsage = pgTable("user_file_usage", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  usedBytes: bigint("used_bytes", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type UserFileUsage = InferSelectModel<typeof userFileUsage>;

export const userFiles = pgTable(
  "user_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    chatId: uuid("chat_id").references(() => chat.id, {
      onDelete: "set null",
    }),
    messageId: uuid("message_id").references(() => message.id, {
      onDelete: "set null",
    }),
    blobUrl: text("blob_url").notNull(),
    blobPathname: text("blob_pathname").notNull(),
    storageProvider: varchar("storage_provider", {
      length: 32,
      enum: ["vercel_blob", "google_drive", "notion", "private_local", "private_blob"],
    })
      .notNull()
      .default("vercel_blob"),
    providerFileId: text("provider_file_id"),
    providerMetadata: jsonb("provider_metadata")
      .$type<Record<string, unknown> | null>()
      .default(null),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    savedAt: timestamp("saved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const userEmailPreferences = pgTable(
  "user_email_preferences",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    marketingOptIn: boolean("marketing_opt_in").notNull().default(true),
    marketingOptedOutAt: timestamp("marketing_opted_out_at", {
      withTimezone: true,
    }),
    unsubscribeToken: uuid("unsubscribe_token").defaultRandom().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastEmailSentAt: timestamp("last_email_sent_at", { withTimezone: true }),
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

export const marketingEmailLog = pgTable(
  "marketing_email_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 128 }).notNull(),
    stage: varchar("stage", { length: 64 }).notNull(),
    template: varchar("template", { length: 64 }).notNull(),
    dedupeKey: varchar("dedupe_key", { length: 128 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("sent"),
    error: text("error"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown> | null>()
      .default(null),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const feedback = pgTable("feedback", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }), // Optional: supports anonymous feedback
  contactEmail: text("contact_email"), // Optional: contact email for anonymous users
  content: text("content").notNull(),
  type: text("type").notNull().default("general"), // 'bug', 'feature', 'improvement', 'general'
  title: text("title").notNull().default(""), // Title (default empty string)
  description: text("description").notNull().default(""), // Description (default empty string)
  status: text("status").notNull().default("open"), // 'open', 'in_progress', 'resolved', 'closed'
  priority: text("priority").default("medium"), // 'low', 'medium', 'high', 'urgent'
  source: text("source").default("web"), // 'web', 'desktop', 'api'
  systemInfo: json("system_info"), // System info (platform, version, etc.)
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type Feedback = InferSelectModel<typeof feedback>;

export const stripeWebhookEvents = pgTable(
  "stripe_webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stripeEventId: text("stripe_event_id").notNull(),
    eventType: text("event_type").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("processing"),
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
    processedAt: timestamp("processed_at"),
  },
  (table) => ({
    uniqueStripeEvent: uniqueIndex("unique_stripe_event").on(
      table.stripeEventId,
    ),
  }),
);

// 👉 Define survey table (for survey data)
export const survey = pgTable("survey", {
  id: uuid("id").primaryKey().defaultRandom(), // Primary key UUID, auto-generated by default
  userId: uuid("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  industry: text("industry").notNull(), // Industry (corresponds to SurveyAnswers.industry)
  role: text("role").notNull(), // Role (corresponds to SurveyAnswers.role)
  roles: text("roles").array().default([]), // Multi-role selection
  otherRole: text("other_role"),
  size: text("size").notNull(), // Company size (corresponds to SurveyAnswers.size)
  communicationTools: text("communication_tools").array().notNull(), // Communication tools (array type)
  dailyMessages: text("daily_messages").notNull(), // Daily message volume (corresponds to SurveyAnswers.dailyMessages)
  challenges: text("challenges").array().notNull(), // Pain points/issues (array type)
  workDescription: text("work_description"),
  submittedAt: timestamp("submitted_at").notNull().defaultNow(), // Submission time, defaults to current time
});

export type Survey = InferSelectModel<typeof survey>;

// RAG Documents table - stores document metadata
export const ragDocuments = pgTable(
  "rag_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    contentType: varchar("content_type", { length: 100 }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    totalChunks: integer("total_chunks").notNull().default(0),
    blobPath: text("blob_path"), // Path to original binary file (e.g., Vercel Blob URL or local file path)
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userIdx: index("rag_documents_user_idx").on(table.userId),
    uploadedAtIdx: index("rag_documents_uploaded_at_idx").on(table.uploadedAt),
  }),
);

export type RAGDocument = InferSelectModel<typeof ragDocuments>;
export type InsertRAGDocument = InferInsertModel<typeof ragDocuments>;

// RAG Chunks table - stores document chunks with embeddings using pgvector
export const ragChunks = pgTable(
  "rag_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => ragDocuments.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    // Store embedding as text - will be cast to vector in queries
    // Nullable to support skipEmbeddings mode where chunks are stored without vectors
    embedding: text("embedding"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

// Landing Promo Registration table
// Tracks users who registered through the landing page promotion
export const landingPromoRegistrations = pgTable(
  "landing_promo_registrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 255 }).notNull(),
    promoCode: varchar("promo_code", { length: 64 })
      .notNull()
      .default("6M_FREE_PRO"),
    monthsGranted: integer("months_granted").notNull().default(6),
    planName: text("plan_name").notNull().default("pro"),
    status: varchar("status", { length: 32 }).notNull().default("active"), // active, expired, claimed
    claimedAt: timestamp("claimed_at"),
    expiresAt: timestamp("expires_at").notNull(),
    referralCode: varchar("referral_code", { length: 64 }), // Unique referral code for this user
    referredBy: uuid("referred_by").references(
      (): any => landingPromoRegistrations.id,
      {
        onDelete: "set null",
      },
    ),
    referralCount: integer("referral_count").notNull().default(0), // Number of successful referrals
    metadata: jsonb("metadata")
      .$type<Record<string, unknown> | null>()
      .default(null),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userIdx: index("landing_promo_user_idx").on(table.userId),
    emailIdx: index("landing_promo_email_idx").on(table.email),
    promoCodeIdx: index("landing_promo_code_idx").on(table.promoCode),
    statusIdx: index("landing_promo_status_idx").on(table.status),
    referralCodeIdx: uniqueIndex("landing_promo_referral_code_idx").on(
      table.referralCode,
    ),
    expiresAtIdx: index("landing_promo_expires_at_idx").on(table.expiresAt),
  }),
);

export type LandingPromoRegistration = InferSelectModel<
  typeof landingPromoRegistrations
>;
export type InsertLandingPromoRegistration = InferInsertModel<
  typeof landingPromoRegistrations
>;

// WhatsApp Accounts
export const whatsappAccounts = pgTable(
  "whatsapp_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    whatsappUserId: text("whatsapp_user_id").notNull(),
    username: text("username"),
    pushName: text("push_name"),
    linkedAt: timestamp("linked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastCommandAt: timestamp("last_command_at", { withTimezone: true }),
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

// Insight Processing Failures
export const insightProcessingFailures = pgTable(
  "insight_processing_failures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bot.id, { onDelete: "cascade" }),
    groupName: text("group_name").notNull(),
    failureCount: integer("failure_count").notNull().default(1),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    lastError: text("last_error"),
    lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedSince: integer("processed_since").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    uniqueBotGroup: uniqueIndex("insight_failures_bot_group_idx").on(
      table.botId,
      table.groupName,
    ),
    botStatusIdx: index("insight_failures_bot_status_idx").on(
      table.botId,
      table.status,
    ),
    attemptedIdx: index("insight_failures_attempted_idx").on(
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

// Scheduled Jobs
export const scheduledJobs = pgTable(
  "scheduled_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    scheduleType: varchar("schedule_type", { length: 20 })
      .notNull()
      .default("cron"),
    cronExpression: varchar("cron_expression", { length: 100 }),
    intervalMinutes: integer("interval_minutes"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    jobType: varchar("job_type", { length: 50 }).notNull().default("custom"),
    jobConfig: jsonb("job_config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    enabled: boolean("enabled").notNull().default(true),
    timezone: varchar("timezone", { length: 50 }).notNull().default("UTC"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastStatus: varchar("last_status", { length: 20 }),
    lastError: text("last_error"),
    runCount: integer("run_count").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

// Job Executions
export const jobExecutions = pgTable(
  "job_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => scheduledJobs.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 20 }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    error: text("error"),
    output: text("output"),
    triggeredBy: varchar("triggered_by", { length: 50 })
      .notNull()
      .default("scheduler"),
  },
  (table) => ({
    jobIdIdx: index("job_executions_job_idx").on(table.jobId),
    startedAtIdx: index("job_executions_started_at_idx").on(table.startedAt),
    statusIdx: index("job_executions_status_idx").on(table.status),
  }),
);

export type JobExecution = InferSelectModel<typeof jobExecutions>;
export type InsertJobExecution = InferInsertModel<typeof jobExecutions>;

// Loop Runtime
export const loops = pgTable(
  "loops",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workshopId: uuid("workshop_id").references(() => workshops.id, {
      onDelete: "cascade",
    }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    goal: text("goal").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    triggerConfig: jsonb("trigger_config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    contextConfig: jsonb("context_config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    actionPolicy: jsonb("action_policy")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    verificationConfig: jsonb("verification_config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    approvalPolicy: jsonb("approval_policy")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    retryPolicy: jsonb("retry_policy")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    escalationPolicy: jsonb("escalation_policy")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const loopRuns = pgTable(
  "loop_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    loopId: uuid("loop_id")
      .notNull()
      .references(() => loops.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 20 }).notNull().default("running"),
    triggerReason: jsonb("trigger_reason").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    inputSnapshot: jsonb("input_snapshot").$type<Record<string, unknown>>(),
    outputSummary: text("output_summary"),
    verificationResult: jsonb("verification_result").$type<
      Record<string, unknown>
    >(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const loopStates = pgTable("loop_states", {
  loopId: uuid("loop_id")
    .primaryKey()
    .references(() => loops.id, { onDelete: "cascade" }),
  currentPhase: varchar("current_phase", { length: 50 })
    .notNull()
    .default("idle"),
  memorySummary: text("memory_summary"),
  openQuestions: jsonb("open_questions")
    .$type<unknown[]>()
    .notNull()
    .default([]),
  lastObservation: text("last_observation"),
  nextAction: text("next_action"),
  blockedReason: text("blocked_reason"),
  stateJson: jsonb("state_json")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type LoopState = InferSelectModel<typeof loopStates>;
export type InsertLoopState = InferInsertModel<typeof loopStates>;

export const loopApprovalRequests = pgTable(
  "loop_approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    loopId: uuid("loop_id")
      .notNull()
      .references(() => loops.id, { onDelete: "cascade" }),
    loopRunId: uuid("loop_run_id")
      .notNull()
      .references(() => loopRuns.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    source: varchar("source", { length: 30 }).notNull().default("tool_gate"),
    actionName: varchar("action_name", { length: 255 }).notNull(),
    capability: varchar("capability", { length: 50 }),
    reason: text("reason"),
    message: text("message"),
    toolInput: jsonb("tool_input").$type<Record<string, unknown>>(),
    actionPayload: jsonb("action_payload").$type<Record<string, unknown>>(),
    resolvedBy: uuid("resolved_by").references(() => user.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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
export const interactionEvents = pgTable(
  "interaction_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    platform: varchar("platform", { length: 40 }).notNull(),
    source: varchar("source", { length: 80 }).notNull(),
    conversationId: text("conversation_id"),
    conversationName: text("conversation_name").notNull(),
    conversationType: varchar("conversation_type", { length: 30 })
      .notNull()
      .default("unknown"),
    senderId: text("sender_id"),
    senderName: text("sender_name"),
    senderDisplayName: text("sender_display_name"),
    direction: varchar("direction", { length: 20 }).notNull().default("unknown"),
    contentType: varchar("content_type", { length: 40 })
      .notNull()
      .default("unknown"),
    content: text("content").notNull().default(""),
    contentPreview: text("content_preview").notNull().default(""),
    messageTime: timestamp("message_time", { withTimezone: true }).notNull(),
    collectedAt: timestamp("collected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sourceMessageId: text("source_message_id"),
    sourceSequence: text("source_sequence"),
    sourceRaw: jsonb("source_raw")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    dedupeKey: text("dedupe_key").notNull(),
    processedStatus: varchar("processed_status", { length: 30 })
      .notNull()
      .default("new"),
    importance: varchar("importance", { length: 30 })
      .notNull()
      .default("unknown"),
    requiresReply: boolean("requires_reply"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const interactionThreads = pgTable(
  "interaction_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    platform: varchar("platform", { length: 40 }).notNull(),
    conversationId: text("conversation_id").notNull(),
    conversationName: text("conversation_name").notNull(),
    conversationType: varchar("conversation_type", { length: 30 })
      .notNull()
      .default("unknown"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull(),
    lastCollectedAt: timestamp("last_collected_at", {
      withTimezone: true,
    }).notNull(),
    unreadCount: integer("unread_count").notNull().default(0),
    pendingReplyCount: integer("pending_reply_count").notNull().default(0),
    lastEventId: uuid("last_event_id").references(() => interactionEvents.id, {
      onDelete: "set null",
    }),
    summary: text("summary"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const interactionProcessingJobs = pgTable(
  "interaction_processing_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").references(() => interactionEvents.id, {
      onDelete: "set null",
    }),
    threadId: uuid("thread_id").references(() => interactionThreads.id, {
      onDelete: "set null",
    }),
    eventIds: jsonb("event_ids").$type<string[]>().notNull().default([]),
    processingMode: varchar("processing_mode", { length: 30 })
      .notNull()
      .default("full"),
    jobType: varchar("job_type", { length: 40 })
      .notNull()
      .default("summarize_thread"),
    status: varchar("status", { length: 30 }).notNull().default("pending"),
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const interactionNotes = pgTable(
  "interaction_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").references(() => interactionEvents.id, {
      onDelete: "set null",
    }),
    threadId: uuid("thread_id").references(() => interactionThreads.id, {
      onDelete: "set null",
    }),
    noteType: varchar("note_type", { length: 40 }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    confidence: integer("confidence").notNull().default(50),
    model: text("model"),
    sourceEventIds: jsonb("source_event_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const interactionTasks = pgTable(
  "interaction_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").references(() => interactionEvents.id, {
      onDelete: "set null",
    }),
    threadId: uuid("thread_id").references(() => interactionThreads.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    description: text("description"),
    status: varchar("status", { length: 30 }).notNull().default("candidate"),
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    dueAt: timestamp("due_at", { withTimezone: true }),
    assigneeName: text("assignee_name"),
    requesterName: text("requester_name"),
    sourceEventIds: jsonb("source_event_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    confidence: integer("confidence").notNull().default(50),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const interactionTaskRevisions = pgTable("interaction_task_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").notNull().references(() => interactionTasks.id, { onDelete: "cascade" }),
  revision: bigint("revision", { mode: "number" }).notNull(),
  commandId: text("command_id").notNull(),
  requestHash: text("request_hash").notNull(),
  action: text("action").notNull(),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  versionUnique: uniqueIndex("interaction_task_revisions_version_unique").on(table.userId, table.taskId, table.revision),
  commandUnique: uniqueIndex("interaction_task_revisions_command_unique").on(table.userId, table.commandId),
}));

export const memoryStateReadReceipts = pgTable("memory_state_read_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  target: jsonb("target").$type<Record<string, unknown>>().notNull(),
  revision: text("revision").notNull(),
  locator: jsonb("locator").$type<Record<string, unknown>>().notNull(),
  traceId: uuid("trace_id").notNull(),
  contractVersion: text("contract_version").notNull(),
  implementationVersion: text("implementation_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ userIdx: index("memory_state_read_receipts_user_idx").on(table.userId, table.createdAt) }));

export const memoryRevisionCommandReceipts = pgTable("memory_revision_command_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  commandId: text("command_id").notNull(),
  requestHash: text("request_hash").notNull(),
  kind: text("kind").notNull(),
  outcome: jsonb("outcome").$type<Record<string, unknown>>().notNull(),
  traceId: uuid("trace_id").notNull(),
  contractVersion: text("contract_version").notNull(),
  implementationVersion: text("implementation_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ commandUnique: uniqueIndex("memory_revision_command_receipts_command_unique").on(table.userId, table.commandId) }));

export const interactionMemories = pgTable(
  "interaction_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    memoryType: varchar("memory_type", { length: 40 }).notNull(),
    subject: text("subject").notNull(),
    content: text("content").notNull(),
    status: varchar("status", { length: 30 }).notNull().default("candidate"),
    confidence: integer("confidence").notNull().default(50),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    sourceEventIds: jsonb("source_event_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const memoryGraphEntities = pgTable(
  "memory_graph_entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scope: varchar("scope", { length: 40 }).notNull().default("interaction"),
    source: varchar("source", { length: 80 })
      .notNull()
      .default("interaction_processor"),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    entityType: varchar("entity_type", { length: 40 })
      .notNull()
      .default("other"),
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    description: text("description"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const memoryGraphRelations = pgTable(
  "memory_graph_relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scope: varchar("scope", { length: 40 }).notNull().default("interaction"),
    source: varchar("source", { length: 80 })
      .notNull()
      .default("interaction_processor"),
    subjectEntityId: uuid("subject_entity_id")
      .notNull()
      .references(() => memoryGraphEntities.id, { onDelete: "cascade" }),
    objectEntityId: uuid("object_entity_id")
      .notNull()
      .references(() => memoryGraphEntities.id, { onDelete: "cascade" }),
    relationType: varchar("relation_type", { length: 60 }).notNull(),
    claim: text("claim").notNull(),
    claimHash: varchar("claim_hash", { length: 64 }).notNull(),
    confidence: integer("confidence").notNull().default(60),
    evidenceStrength: varchar("evidence_strength", { length: 20 })
      .notNull()
      .default("medium"),
    status: varchar("status", { length: 30 }).notNull().default("active"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const memoryGraphEvidence = pgTable(
  "memory_graph_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    relationId: uuid("relation_id")
      .notNull()
      .references(() => memoryGraphRelations.id, { onDelete: "cascade" }),
    sourceType: varchar("source_type", { length: 60 })
      .notNull()
      .default("interaction_event"),
    sourceId: text("source_id").notNull(),
    eventId: uuid("event_id").references(() => interactionEvents.id, {
      onDelete: "set null",
    }),
    quote: text("quote"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const brainObservations = pgTable(
  "brain_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sourceType: varchar("source_type", { length: 60 }).notNull(),
    sourceId: text("source_id").notNull(),
    sourceEventId: text("source_event_id"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    content: text("content").notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    trustLevel: varchar("trust_level", { length: 30 }).notNull().default("raw"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const brainMemories = pgTable(
  "brain_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scopeType: varchar("scope_type", { length: 40 }).notNull(),
    scopeId: text("scope_id"),
    ownerType: varchar("owner_type", { length: 40 }).notNull(),
    ownerId: text("owner_id").notNull(),
    memoryType: varchar("memory_type", { length: 40 }).notNull(),
    subject: text("subject").notNull(),
    content: text("content").notNull(),
    status: varchar("status", { length: 30 }).notNull().default("candidate"),
    confidence: integer("confidence").notNull().default(50),
    canonicalKind: varchar("canonical_kind", { length: 40 }),
    canonicalGroupId: text("canonical_group_id"),
    evidenceRefs: jsonb("evidence_refs").$type<string[]>().notNull().default([]),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    supersedes: jsonb("supersedes").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const brainBackfillBatches = pgTable('brain_backfill_batches', {
  id: uuid('id').primaryKey(), userId: uuid('user_id').notNull().references(()=>user.id,{onDelete:'cascade'}),
  mappingVersion: text('mapping_version').notNull(), requestHash: text('request_hash').notNull(), planHash: text('plan_hash').notNull(),
  sourceCursor: uuid('source_cursor'), nextCursor: uuid('next_cursor'), status: text('status').notNull().default('planned'),
  approvedAt: timestamp('approved_at',{withTimezone:true}), createdAt: timestamp('created_at',{withTimezone:true}).notNull().defaultNow(), updatedAt: timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},table=>({ownerIdx:index('brain_backfill_batches_owner_idx').on(table.userId,table.createdAt)}));
export const brainBackfillItems = pgTable('brain_backfill_items', {
  batchId: uuid('batch_id').notNull().references(()=>brainBackfillBatches.id,{onDelete:'cascade'}), memoryId: uuid('memory_id').notNull(), ordinal: integer('ordinal').notNull(),
  status: text('status').notNull(), beforeHash: text('before_hash').notNull(), afterHash: text('after_hash'),
  beforeValues: jsonb('before_values').$type<{canonicalKind:string|null;canonicalGroupId:string|null}>().notNull(),
  changes: jsonb('changes').$type<{canonicalKind?:string;canonicalGroupId?:string}>().notNull(), detail: jsonb('detail').$type<Record<string,unknown>>().notNull(),
},table=>({pk:primaryKey({columns:[table.batchId,table.memoryId]}),order:unique().on(table.batchId,table.ordinal)}));
export const brainBackfillEvents = pgTable('brain_backfill_events', {
  id: bigserial('id',{mode:'number'}).primaryKey(), batchId: uuid('batch_id').notNull().references(()=>brainBackfillBatches.id,{onDelete:'cascade'}),
  kind: text('kind').notNull(), memoryId: uuid('memory_id'), detail: jsonb('detail').$type<Record<string,unknown>>().notNull().default({}), createdAt: timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
});

export const brainMemoryReviews = pgTable(
  "brain_memory_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    memoryId: uuid("memory_id")
      .notNull()
      .references(() => brainMemories.id, { onDelete: "cascade" }),
    reviewerType: varchar("reviewer_type", { length: 40 }).notNull(),
    reviewerId: text("reviewer_id"),
    decision: varchar("decision", { length: 30 }).notNull(),
    reason: text("reason"),
    evidenceRefs: jsonb("evidence_refs").$type<string[]>().notNull().default([]),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const brainStateSnapshots = pgTable(
  "brain_state_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scopeType: varchar("scope_type", { length: 40 }).notNull(),
    scopeId: text("scope_id"),
    snapshotType: varchar("snapshot_type", { length: 40 }).notNull(),
    content: jsonb("content")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    sourceMemoryIds: jsonb("source_memory_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const brainAccessGrants = pgTable(
  "brain_access_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    subjectType: varchar("subject_type", { length: 40 }).notNull(),
    subjectId: text("subject_id"),
    scopeType: varchar("scope_type", { length: 40 }).notNull(),
    scopeId: text("scope_id"),
    permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
    memoryTypes: jsonb("memory_types").$type<string[]>().notNull().default([]),
    reason: text("reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const brainContextLogs = pgTable(
  "brain_context_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    requesterType: varchar("requester_type", { length: 40 }).notNull(),
    requesterId: text("requester_id"),
    taskIntent: text("task_intent"),
    selectedMemoryIds: jsonb("selected_memory_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    denied: jsonb("denied").$type<unknown[]>().notNull().default([]),
    omitted: jsonb("omitted").$type<unknown[]>().notNull().default([]),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const interactionSourcePolicies = pgTable(
  "interaction_source_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    platform: varchar("platform", { length: 40 }).notNull(),
    sourceId: text("source_id").notNull(),
    sourceName: text("source_name").notNull(),
    sourceType: varchar("source_type", { length: 40 }).notNull().default("unknown"),
    policy: varchar("policy", { length: 30 }).notNull().default("sync"),
    enabled: boolean("enabled").notNull().default(true),
    priority: integer("priority").notNull().default(0),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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
export const workshops = pgTable(
  "workshops",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    mission: text("mission").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    autonomyLevel: varchar("autonomy_level", { length: 20 })
      .notNull()
      .default("draft"),
    boundaryPolicy: jsonb("boundary_policy")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    modelConfig: jsonb("model_config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const workCollaborationRequests = pgTable(
  "work_collaboration_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    requesterWorkId: uuid("requester_work_id").notNull(),
    recipientWorkId: uuid("recipient_work_id").notNull(),
    requesterName: text("requester_name").notNull(),
    recipientName: text("recipient_name").notNull(),
    kind: text("kind").notNull(),
    neededCapability: text("needed_capability"),
    status: text("status").notNull(),
    problem: text("problem").notNull(),
    desiredOutcome: text("desired_outcome").notNull(),
    whyHelpNeeded: text("why_help_needed").notNull(),
    acceptanceCriteria: text("acceptance_criteria"),
    sourceEventIds: jsonb("source_event_ids").$type<string[]>().notNull().default([]),
    originRunId: uuid("origin_run_id"),
    originLoopId: uuid("origin_loop_id"),
    recipientRunId: uuid("recipient_run_id"),
    response: text("response"),
    resolutionNote: text("resolution_note"),
    idempotencyKey: text("idempotency_key").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull().default(sql`now() + interval '48 hours'`),
    attentionReason: text("attention_reason"),
    attentionAt: timestamp("attention_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => ({
    idempotencyIdx: uniqueIndex("work_collaboration_idempotency").on(table.ownerId, table.requesterWorkId, table.idempotencyKey),
    inboxIdx: index("work_collaboration_inbox_idx").on(table.ownerId, table.recipientWorkId, table.updatedAt),
    outboxIdx: index("work_collaboration_outbox_idx").on(table.ownerId, table.requesterWorkId, table.updatedAt),
    attentionIdx: index("work_collaboration_attention_idx").on(table.ownerId, table.dueAt),
  }),
);

export const workCollaborationEvents = pgTable(
  "work_collaboration_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id").notNull().references(() => workCollaborationRequests.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    actorWorkId: uuid("actor_work_id"),
    actorType: text("actor_type").notNull(),
    action: text("action").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    detail: text("detail"),
    commandId: text("command_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    seqIdx: uniqueIndex("work_collaboration_event_seq").on(table.requestId, table.seq),
    commandIdx: uniqueIndex("work_collaboration_event_command").on(table.requestId, table.commandId),
  }),
);

export const workshopWorkVersions = pgTable(
  "workshop_work_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workshopId: uuid("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    version: varchar("version", { length: 80 }).notNull(),
    source: varchar("source", { length: 60 }).notNull().default("manual_update"),
    changeEventId: uuid("change_event_id"),
    snapshot: jsonb("snapshot")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    patch: jsonb("patch")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdBy: varchar("created_by", { length: 60 }).notNull().default("system"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const quantTradePlans = pgTable(
  "quant_trade_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workshopId: uuid("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    loopId: uuid("loop_id"),
    loopRunId: uuid("loop_run_id"),
    sourceEventId: uuid("source_event_id"),
    planDate: varchar("plan_date", { length: 20 }).notNull(),
    horizon: varchar("horizon", { length: 40 }).notNull().default("next_day"),
    status: varchar("status", { length: 30 }).notNull().default("active"),
    code: varchar("code", { length: 32 }).notNull(),
    name: text("name"),
    action: varchar("action", { length: 40 }).notNull(),
    side: varchar("side", { length: 12 }),
    quantity: integer("quantity"),
    targetPrice: real("target_price"),
    triggerCondition: text("trigger_condition").notNull(),
    invalidation: text("invalidation"),
    rationale: text("rationale").notNull(),
    priority: varchar("priority", { length: 20 }).notNull().default("normal"),
    executionStatus: varchar("execution_status", { length: 30 })
      .notNull()
      .default("pending"),
    orderId: text("order_id"),
    blockerReason: text("blocker_reason"),
    completionNote: text("completion_note"),
    sourceDecision: jsonb("source_decision")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    plannedAt: timestamp("planned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    supersededBy: uuid("superseded_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const quantTrendStateSnapshots = pgTable(
  "quant_trend_state_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workshopId: uuid("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    loopId: uuid("loop_id"),
    loopRunId: uuid("loop_run_id"),
    sourceEventId: uuid("source_event_id"),
    code: varchar("code", { length: 32 }).notNull(),
    name: text("name"),
    tradeDate: varchar("trade_date", { length: 20 }),
    benchmarkCode: varchar("benchmark_code", { length: 32 }),
    lifecycleState: varchar("lifecycle_state", { length: 40 }).notNull(),
    trendPhase: varchar("trend_phase", { length: 40 }),
    trendScore: real("trend_score"),
    rsRank: integer("rs_rank"),
    rsPercentile: real("rs_percentile"),
    rsScore: real("rs_score"),
    relativeReturn60d: real("relative_return_60d"),
    trailingStop: real("trailing_stop"),
    hardStop: real("hard_stop"),
    stopAction: varchar("stop_action", { length: 40 }),
    controlAction: varchar("control_action", { length: 40 }),
    tradeAllowed: boolean("trade_allowed").notNull().default(false),
    dataQualityStatus: varchar("data_quality_status", { length: 30 })
      .notNull()
      .default("unknown"),
    snapshot: jsonb("snapshot")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const quantTrendStrategySamples = pgTable(
  "quant_trend_strategy_samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workshopId: uuid("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => quantTrendStateSnapshots.id, { onDelete: "cascade" }),
    sourceEventId: uuid("source_event_id"),
    code: varchar("code", { length: 32 }).notNull(),
    name: text("name"),
    tradeDate: varchar("trade_date", { length: 20 }),
    lifecycleState: varchar("lifecycle_state", { length: 40 }).notNull(),
    trendPhase: varchar("trend_phase", { length: 40 }),
    controlAction: varchar("control_action", { length: 40 }),
    observedPrice: real("observed_price"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    evaluationAt: timestamp("evaluation_at", { withTimezone: true }),
    latestPrice: real("latest_price"),
    returnPct: real("return_pct"),
    horizonDays: integer("horizon_days").notNull().default(0),
    holdingQuantity: integer("holding_quantity").notNull().default(0),
    realizedPnl: real("realized_pnl").notNull().default(0),
    outcomeStatus: varchar("outcome_status", { length: 30 })
      .notNull()
      .default("open"),
    exitReason: text("exit_reason"),
    result: jsonb("result")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const workshopHeartbeats = pgTable(
  "workshop_heartbeats",
  {
    workshopId: uuid("workshop_id")
      .primaryKey()
      .references(() => workshops.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    mode: varchar("mode", { length: 30 }).notNull().default("suggested"),
    nextWakeupAt: timestamp("next_wakeup_at", { withTimezone: true }),
    lastWakeupAt: timestamp("last_wakeup_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    schedulerStatus: varchar("scheduler_status", { length: 30 })
      .notNull()
      .default("idle"),
    schedulerError: text("scheduler_error"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    heartbeatPolicy: jsonb("heartbeat_policy")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const workshopRuns = pgTable(
  "workshop_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workshopId: uuid("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 20 }).notNull().default("running"),
    triggerReason: jsonb("trigger_reason").$type<Record<string, unknown>>(),
    ccSessionId: text("cc_session_id"),
    completionJson: jsonb("completion_json").$type<Record<string, unknown>>(),
    inputSnapshot: jsonb("input_snapshot").$type<Record<string, unknown>>(),
    outputSummary: text("output_summary"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workshopIdx: index("workshop_runs_workshop_idx").on(table.workshopId),
    statusIdx: index("workshop_runs_status_idx").on(table.status),
    startedAtIdx: index("workshop_runs_started_at_idx").on(table.startedAt),
    queueIdx: index("workshop_runs_queue_idx").on(table.createdAt, table.id).where(sql`${table.status} = 'queued'`),
  }),
);

export type WorkshopRun = InferSelectModel<typeof workshopRuns>;
export type InsertWorkshopRun = InferInsertModel<typeof workshopRuns>;

export const workshopRuntimeSnapshots = pgTable(
  "workshop_runtime_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workshopId: uuid("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => workshopRuns.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").references((): AnyPgColumn => workshopEvents.id, {
      onDelete: "set null",
    }),
    loopId: uuid("loop_id").references(() => loops.id, { onDelete: "set null" }),
    loopRunId: uuid("loop_run_id").references(() => loopRuns.id, {
      onDelete: "set null",
    }),
    engine: varchar("engine", { length: 20 }).notNull(),
    adapter: text("adapter").notNull(),
    model: text("model").notNull(),
    modelTier: text("model_tier").notNull(),
    runtimeHash: varchar("runtime_hash", { length: 64 }).notNull(),
    policyHash: varchar("policy_hash", { length: 64 }).notNull(),
    allowedToolCount: integer("allowed_tool_count").notNull(),
    snapshotJson: jsonb("snapshot_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    eventIdx: uniqueIndex("workshop_runtime_snapshots_event_idx")
      .on(table.eventId)
      .where(sql`${table.eventId} IS NOT NULL`),
    runCreatedIdx: index("workshop_runtime_snapshots_run_created_idx").on(
      table.runId,
      table.createdAt,
    ),
    workshopRunIdx: index("workshop_runtime_snapshots_workshop_run_idx").on(
      table.workshopId,
      table.runId,
    ),
    runtimeHashIdx: index("workshop_runtime_snapshots_runtime_hash_idx").on(
      table.runtimeHash,
    ),
  }),
);

export type WorkshopRuntimeSnapshot = InferSelectModel<
  typeof workshopRuntimeSnapshots
>;
export type InsertWorkshopRuntimeSnapshot = InferInsertModel<
  typeof workshopRuntimeSnapshots
>;
export const workshopRunOutputs=pgTable('workshop_run_outputs',{
  runId:uuid('run_id').primaryKey().references(()=>workshopRuns.id,{onDelete:'cascade'}),
  workshopId:uuid('workshop_id').notNull().references(()=>workshops.id,{onDelete:'cascade'}),
  resultJson:jsonb('result_json').notNull(),
  directiveIds:jsonb('directive_ids').$type<string[]>().notNull(),
  workerId:text('worker_id').notNull(),
  fencingToken:integer('fencing_token').notNull(),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
});
export const workshopOutputSteps=pgTable('workshop_output_steps',{
  runId:uuid('run_id').notNull().references(()=>workshopRuns.id,{onDelete:'cascade'}),
  stepKind:text('step_kind').notNull(),
  stepIndex:integer('step_index').notNull(),
  resultJson:jsonb('result_json').notNull(),
  workerId:text('worker_id').notNull(),
  fencingToken:integer('fencing_token').notNull(),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},table=>({pk:primaryKey({columns:[table.runId,table.stepKind,table.stepIndex]})}));
export const workshopRunPlans=pgTable('workshop_run_plans',{
  runId:uuid('run_id').primaryKey().references(()=>workshopRuns.id,{onDelete:'cascade'}),
  workshopId:uuid('workshop_id').notNull().references(()=>workshops.id,{onDelete:'cascade'}),
  checkpointJson:jsonb('checkpoint_json').notNull(),
  workerId:text('worker_id').notNull(),
  fencingToken:integer('fencing_token').notNull(),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
});
export const workshopLoopExecutions=pgTable('workshop_loop_executions',{
  runId:uuid('run_id').primaryKey().references(()=>workshopRuns.id,{onDelete:'restrict'}),
  loopRunId:uuid('loop_run_id').notNull().unique().references(()=>loopRuns.id,{onDelete:'restrict'}),
  loopId:uuid('loop_id').notNull().references(()=>loops.id,{onDelete:'restrict'}),
  workshopId:uuid('workshop_id').notNull().references(()=>workshops.id,{onDelete:'restrict'}),
  requestJson:jsonb('request_json').notNull(),
  resultJson:jsonb('result_json'),
  active:boolean('active').notNull().default(true),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},table=>({activeLoopIdx:uniqueIndex('workshop_loop_executions_active_loop_idx').on(table.loopId).where(sql`${table.active}`)}));

export const loopRuntimeMigrations=pgTable('loop_runtime_migrations',{
  legacyJobId:uuid('legacy_job_id').references(()=>scheduledJobs.id,{onDelete:'restrict'}),
  loopId:uuid('loop_id').primaryKey().references(()=>loops.id,{onDelete:'restrict'}),
  workshopId:uuid('workshop_id').notNull().references(()=>workshops.id,{onDelete:'restrict'}),
  ownerId:uuid('owner_id').notNull().references(()=>user.id,{onDelete:'restrict'}),
  commandId:text('command_id').notNull(),
  snapshotHash:text('snapshot_hash').notNull(),
  sourceSnapshot:jsonb('source_snapshot').notNull(),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},table=>({commandIdx:uniqueIndex('loop_runtime_migrations_owner_command_idx').on(table.ownerId,table.commandId),legacyJobIdx:uniqueIndex('loop_runtime_migrations_legacy_job_idx').on(table.legacyJobId).where(sql`${table.legacyJobId} IS NOT NULL`)}));

export const legacyExecutionReviews=pgTable('legacy_execution_reviews',{
  id:uuid('id').primaryKey().defaultRandom(),
  executionId:uuid('execution_id').notNull().references(()=>jobExecutions.id,{onDelete:'cascade'}),
  loopId:uuid('loop_id').notNull().references(()=>loops.id,{onDelete:'cascade'}),
  ownerId:uuid('owner_id').notNull().references(()=>user.id,{onDelete:'cascade'}),
  commandId:text('command_id').notNull(),payloadHash:text('payload_hash').notNull(),snapshotHash:text('snapshot_hash').notNull(),
  outcome:text('outcome').notNull(),evidence:text('evidence').notNull(),controllersStopped:boolean('controllers_stopped').notNull(),source:text('source').notNull(),
  reviewedAt:timestamp('reviewed_at',{withTimezone:true}).notNull().default(sql`clock_timestamp()`),
},table=>({
  commandKey:unique('legacy_execution_reviews_owner_id_command_id_key').on(table.ownerId,table.commandId),
  snapshotKey:unique('legacy_execution_reviews_execution_id_snapshot_hash_key').on(table.executionId,table.snapshotHash),
  outcomeCheck:check('legacy_execution_reviews_outcome_check',sql`${table.outcome} IN ('no_effect','effects_verified')`),
  evidenceCheck:check('legacy_execution_reviews_evidence_check',sql`length(btrim(${table.evidence})) BETWEEN 1 AND 8000`),
  stoppedCheck:check('legacy_execution_reviews_controllers_stopped_check',sql`${table.controllersStopped}`),
  sourceCheck:check('legacy_execution_reviews_source_check',sql`${table.source}='owner'`),
}));

export const workshopEventCounters = pgTable("workshop_event_counters", {
  workshopId: uuid("workshop_id").primaryKey().references(() => workshops.id, { onDelete: "cascade" }),
  lastSeq: integer("last_seq").notNull().default(0),
});

// A separate revision domain until every legacy command writer is migrated.
export const workCommandTargets = pgTable("work_command_targets", {
  workshopId: uuid("workshop_id").primaryKey().references(() => workshops.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(0),
});

export const workCommands = pgTable("work_commands", {
  ownerId: uuid("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  commandId: varchar("command_id", {length: 256}).notNull(),
  // No target FK: the owner's receipt must survive deletion of the Work.
  targetId: uuid("target_id").notNull(),
  type: varchar("type", {length: 100}).notNull(),
  payloadHash: varchar("payload_hash", {length: 64}).notNull(),
  payload: jsonb("payload").notNull(),
  preparedPayload: jsonb("prepared_payload"),
  preparedAt: timestamp("prepared_at", {withTimezone: true}),
  preparationError: varchar("preparation_error", {length: 100}),
  expectedVersion: integer("expected_version").notNull(),
  status: varchar("status", {length: 20}).notNull().default("queued"),
  result: jsonb("result"),
  errorCode: varchar("error_code", {length: 100}),
  createdAt: timestamp("created_at", {withTimezone: true}).notNull().defaultNow(),
  completedAt: timestamp("completed_at", {withTimezone: true}),
}, table => ({
  pk: primaryKey({columns: [table.ownerId, table.commandId]}),
  targetCreatedIdx: index("work_commands_target_created_idx").on(table.ownerId, table.targetId, table.createdAt),
}));

export const workCommandEvents = pgTable("work_command_events", {
  seq: bigserial("seq", {mode: "number"}).primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  commandId: varchar("command_id", {length: 256}).notNull(),
  targetId: uuid("target_id").notNull(),
  phase: varchar("phase", {length: 20}).notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", {withTimezone: true}).notNull().defaultNow(),
}, table => ({
  commandFk: foreignKey({columns: [table.ownerId, table.commandId], foreignColumns: [workCommands.ownerId, workCommands.commandId]}).onDelete("cascade"),
  phaseUnique: unique().on(table.ownerId, table.commandId, table.phase),
}));

export const workshopEvents = pgTable(
  "workshop_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workshopId: uuid("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => workshopRuns.id, {
      onDelete: "set null",
    }),
    loopId: uuid("loop_id").references(() => loops.id, {
      onDelete: "set null",
    }),
    loopRunId: uuid("loop_run_id").references(() => loopRuns.id, {
      onDelete: "set null",
    }),
    seq: integer("seq").notNull(),
    type: varchar("type", { length: 50 }).notNull(),
    title: text("title").notNull(),
    body: text("body"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    visibility: varchar("visibility", { length: 20 })
      .notNull()
      .default("user"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const workshopReviewItems = pgTable(
  "workshop_review_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workshopId: uuid("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    sourceEventId: uuid("source_event_id").references(() => workshopEvents.id, {
      onDelete: "set null",
    }),
    kind: varchar("kind", { length: 60 }).notNull(),
    status: varchar("status", { length: 30 }).notNull().default("pending"),
    title: text("title").notNull(),
    summary: text("summary"),
    riskLevel: varchar("risk_level", { length: 20 }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
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
export const harnessComponents = pgTable(
  "harness_components",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scopeType: varchar("scope_type", { length: 20 }).notNull(),
    scopeId: text("scope_id").notNull().default("platform"),
    componentKey: text("component_key").notNull(),
    componentType: varchar("component_type", { length: 40 }).notNull(),
    sourceKind: varchar("source_kind", { length: 30 }).notNull(),
    sourceRef: text("source_ref").notNull(),
    owner: varchar("owner", { length: 20 }).notNull(),
    mutability: varchar("mutability", { length: 30 }).notNull(),
    riskLevel: varchar("risk_level", { length: 20 }).notNull(),
    currentRevisionId: uuid("current_revision_id"),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const harnessComponentRevisions = pgTable(
  "harness_component_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    componentId: uuid("component_id")
      .notNull()
      .references(() => harnessComponents.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    schemaVersion: varchar("schema_version", { length: 40 })
      .notNull()
      .default("harness-component.v1"),
    parentRevisionId: uuid("parent_revision_id"),
    content: jsonb("content")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    checksum: varchar("checksum", { length: 64 }).notNull(),
    sourceVersion: text("source_version").notNull(),
    sourceWorkVersionId: uuid("source_work_version_id").references(
      () => workshopWorkVersions.id,
      { onDelete: "set null" },
    ),
    platformVersion: text("platform_version"),
    createdBy: varchar("created_by", { length: 60 })
      .notNull()
      .default("system"),
    changeProposalId: uuid("change_proposal_id"),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const workHarnessSnapshots = pgTable(
  "work_harness_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workshopId: uuid("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    workVersionId: uuid("work_version_id")
      .notNull()
      .references(() => workshopWorkVersions.id, { onDelete: "cascade" }),
    platformVersion: text("platform_version").notNull(),
    componentSetHash: varchar("component_set_hash", { length: 64 }).notNull(),
    modelRuntime: jsonb("model_runtime")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    policySummary: jsonb("policy_summary")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const workHarnessSnapshotItems = pgTable(
  "work_harness_snapshot_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => workHarnessSnapshots.id, { onDelete: "cascade" }),
    componentId: uuid("component_id")
      .notNull()
      .references(() => harnessComponents.id, { onDelete: "restrict" }),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => harnessComponentRevisions.id, {
        onDelete: "restrict",
      }),
    componentOrder: integer("component_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const workRunEvidenceBundles = pgTable(
  "work_run_evidence_bundles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workshopId: uuid("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    workshopRunId: uuid("workshop_run_id").references(() => workshopRuns.id, {
      onDelete: "set null",
    }),
    loopId: uuid("loop_id").references(() => loops.id, {
      onDelete: "set null",
    }),
    loopRunId: uuid("loop_run_id").references(() => loopRuns.id, {
      onDelete: "set null",
    }),
    workVersionId: uuid("work_version_id")
      .notNull()
      .references(() => workshopWorkVersions.id, { onDelete: "restrict" }),
    harnessSnapshotId: uuid("harness_snapshot_id")
      .notNull()
      .references(() => workHarnessSnapshots.id, { onDelete: "restrict" }),
    componentSetHash: varchar("component_set_hash", { length: 64 }).notNull(),
    runtimeSummary: jsonb("runtime_summary")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    observationSummary: jsonb("observation_summary")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    actionSummary: jsonb("action_summary")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    outcomeSummary: jsonb("outcome_summary")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    evidenceRefs: jsonb("evidence_refs").$type<unknown[]>().notNull().default([]),
    captureStatus: varchar("capture_status", { length: 20 })
      .notNull()
      .default("capturing"),
    completeness: varchar("completeness", { length: 20 })
      .notNull()
      .default("partial"),
    warnings: jsonb("warnings").$type<unknown[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const workRunDiagnostics = pgTable(
  "work_run_diagnostics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    evidenceBundleId: uuid("evidence_bundle_id")
      .notNull()
      .references(() => workRunEvidenceBundles.id, { onDelete: "cascade" }),
    analyzerVersion: text("analyzer_version").notNull(),
    failureClasses: jsonb("failure_classes").$type<unknown[]>().notNull().default([]),
    symptoms: jsonb("symptoms").$type<unknown[]>().notNull().default([]),
    rootCauseCandidates: jsonb("root_cause_candidates")
      .$type<unknown[]>()
      .notNull()
      .default([]),
    targetComponentTypes: jsonb("target_component_types")
      .$type<unknown[]>()
      .notNull()
      .default([]),
    confidence: integer("confidence").notNull().default(0),
    evidenceRefs: jsonb("evidence_refs").$type<unknown[]>().notNull().default([]),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const workEvaluationSuites = pgTable(
  "work_evaluation_suites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),
    ownerType: varchar("owner_type", { length: 20 }).notNull(),
    workRole: varchar("work_role", { length: 80 }).notNull(),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    status: varchar("status", { length: 20 }).notNull().default("draft"),
    metricPolicy: jsonb("metric_policy")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    holdoutPolicy: jsonb("holdout_policy")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const workEvaluationScenarios = pgTable(
  "work_evaluation_scenarios",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    suiteId: uuid("suite_id")
      .notNull()
      .references(() => workEvaluationSuites.id, { onDelete: "cascade" }),
    scenarioKey: text("scenario_key").notNull(),
    name: text("name").notNull(),
    mode: varchar("mode", { length: 20 }).notNull(),
    tags: jsonb("tags").$type<unknown[]>().notNull().default([]),
    riskTier: varchar("risk_tier", { length: 20 }).notNull().default("normal"),
    fixtureRef: text("fixture_ref").notNull(),
    preconditions: jsonb("preconditions")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    taskIntent: text("task_intent").notNull(),
    expectedArtifacts: jsonb("expected_artifacts")
      .$type<unknown[]>()
      .notNull()
      .default([]),
    hardInvariants: jsonb("hard_invariants").$type<unknown[]>().notNull().default([]),
    forbiddenActions: jsonb("forbidden_actions").$type<unknown[]>().notNull().default([]),
    metrics: jsonb("metrics").$type<unknown[]>().notNull().default([]),
    repetitions: integer("repetitions").notNull().default(1),
    timeoutMs: integer("timeout_ms").notNull().default(60000),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const workEvaluationCampaigns = pgTable(
  "work_evaluation_campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workshopId: uuid("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    suiteId: uuid("suite_id")
      .notNull()
      .references(() => workEvaluationSuites.id, { onDelete: "restrict" }),
    baselineWorkVersionId: uuid("baseline_work_version_id")
      .notNull()
      .references(() => workshopWorkVersions.id, { onDelete: "restrict" }),
    candidateWorkVersionId: uuid("candidate_work_version_id").references(
      () => workshopWorkVersions.id,
      { onDelete: "set null" },
    ),
    baselineHarnessSnapshotId: uuid("baseline_harness_snapshot_id")
      .notNull()
      .references(() => workHarnessSnapshots.id, { onDelete: "restrict" }),
    candidateHarnessSnapshotId: uuid("candidate_harness_snapshot_id")
      .notNull()
      .references(() => workHarnessSnapshots.id, { onDelete: "restrict" }),
    changeProposalId: uuid("change_proposal_id"),
    status: varchar("status", { length: 30 }).notNull().default("pending"),
    runtimeContract: jsonb("runtime_contract")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    budget: jsonb("budget")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    summary: jsonb("summary")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const workEvaluationRuns = pgTable(
  "work_evaluation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => workEvaluationCampaigns.id, { onDelete: "cascade" }),
    scenarioId: uuid("scenario_id")
      .notNull()
      .references(() => workEvaluationScenarios.id, { onDelete: "restrict" }),
    cohort: varchar("cohort", { length: 20 }).notNull(),
    repetition: integer("repetition").notNull().default(1),
    status: varchar("status", { length: 30 }).notNull().default("pending"),
    score: real("score"),
    metrics: jsonb("metrics")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    evidenceBundleId: uuid("evidence_bundle_id").references(
      () => workRunEvidenceBundles.id,
      { onDelete: "set null" },
    ),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const workHarnessChangeProposals = pgTable(
  "work_harness_change_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workshopId: uuid("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    scope: varchar("scope", { length: 20 }).notNull().default("work"),
    affectedWorkIds: jsonb("affected_work_ids").$type<unknown[]>().notNull().default([]),
    baseWorkVersionId: uuid("base_work_version_id")
      .notNull()
      .references(() => workshopWorkVersions.id, { onDelete: "restrict" }),
    baseHarnessSnapshotId: uuid("base_harness_snapshot_id")
      .notNull()
      .references(() => workHarnessSnapshots.id, { onDelete: "restrict" }),
    baseComponentSetHash: varchar("base_component_set_hash", {
      length: 64,
    }).notNull(),
    proposedBy: varchar("proposed_by", { length: 30 }).notNull(),
    status: varchar("status", { length: 30 }).notNull().default("proposed"),
    riskLevel: varchar("risk_level", { length: 20 }).notNull(),
    failurePattern: text("failure_pattern").notNull(),
    evidenceRefs: jsonb("evidence_refs").$type<unknown[]>().notNull().default([]),
    rootCauseHypothesis: text("root_cause_hypothesis").notNull(),
    predictedFixes: jsonb("predicted_fixes").$type<unknown[]>().notNull().default([]),
    predictedRegressions: jsonb("predicted_regressions")
      .$type<unknown[]>()
      .notNull()
      .default([]),
    successMetrics: jsonb("success_metrics").$type<unknown[]>().notNull().default([]),
    evaluationSuiteId: uuid("evaluation_suite_id").references(
      () => workEvaluationSuites.id,
      { onDelete: "set null" },
    ),
    evaluationScenarioIds: jsonb("evaluation_scenario_ids")
      .$type<unknown[]>()
      .notNull()
      .default([]),
    evaluationWindow: jsonb("evaluation_window")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    rollbackPlan: jsonb("rollback_plan")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    attributionLimited: boolean("attribution_limited").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const workHarnessChangeItems = pgTable(
  "work_harness_change_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => workHarnessChangeProposals.id, { onDelete: "cascade" }),
    componentId: uuid("component_id")
      .notNull()
      .references(() => harnessComponents.id, { onDelete: "restrict" }),
    componentType: varchar("component_type", { length: 40 }).notNull(),
    beforeRevisionId: uuid("before_revision_id")
      .notNull()
      .references(() => harnessComponentRevisions.id, {
        onDelete: "restrict",
      }),
    afterRevisionId: uuid("after_revision_id").references(
      () => harnessComponentRevisions.id,
      { onDelete: "set null" },
    ),
    patch: jsonb("patch")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    rationale: text("rationale").notNull(),
    groupKey: text("group_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const workEvolutionVerdicts = pgTable(
  "work_evolution_verdicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => workHarnessChangeProposals.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => workEvaluationCampaigns.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 20 }).notNull(),
    fixedScenarios: jsonb("fixed_scenarios").$type<unknown[]>().notNull().default([]),
    regressedScenarios: jsonb("regressed_scenarios")
      .$type<unknown[]>()
      .notNull()
      .default([]),
    unexpectedChanges: jsonb("unexpected_changes")
      .$type<unknown[]>()
      .notNull()
      .default([]),
    predictionAccuracy: jsonb("prediction_accuracy")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    recommendedAction: varchar("recommended_action", { length: 30 }).notNull(),
    evidenceRefs: jsonb("evidence_refs").$type<unknown[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const workshopSources = pgTable(
  "workshop_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workshopId: uuid("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 30 }).notNull(),
    name: text("name").notNull(),
    uri: text("uri"),
    content: text("content"),
    config: jsonb("config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    enabled: boolean("enabled").notNull().default(true),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workshopIdx: index("workshop_sources_workshop_idx").on(table.workshopId),
    typeIdx: index("workshop_sources_type_idx").on(table.type),
  }),
);

export type WorkshopSource = InferSelectModel<typeof workshopSources>;
export type InsertWorkshopSource = InferInsertModel<typeof workshopSources>;

export const workshopDirectives = pgTable(
  "workshop_directives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workshopId: uuid("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => workshopRuns.id, {
      onDelete: "set null",
    }),
    content: text("content").notNull(),
    priority: integer("priority").notNull().default(0),
    scope: varchar("scope", { length: 30 }).notNull().default("current_run"),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

/** Durable chat associations are host state, never model-supplied authority. */
export const workshopChatWorkItems = pgTable("workshop_chat_work_items", {
  id: uuid("id").primaryKey(), ownerId: uuid("owner_id").notNull(), chatId: uuid("chat_id").notNull(),
  workshopId: uuid("workshop_id").notNull().references(() => workshops.id, { onDelete: "cascade" }),
  sourceMessageId: uuid("source_message_id").notNull(),
  primaryDirectiveId: uuid("primary_directive_id").references(() => workshopDirectives.id, { onDelete: "set null" }),
  latestRunId: uuid("latest_run_id").references(() => workshopRuns.id, { onDelete: "set null" }),
  revision: integer("revision").notNull().default(1), status: text("status").notNull().default("queued"),
  intentText: text("intent_text").notNull(), resultSummary: text("result_summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ sourceIdx: uniqueIndex("workshop_chat_work_items_source_idx").on(table.ownerId, table.chatId, table.sourceMessageId),
  runIdx: index("workshop_chat_work_items_run_idx").on(table.latestRunId) }));

export const workshopChatContexts = pgTable("workshop_chat_contexts", {
  ownerId: uuid("owner_id").notNull(), chatId: uuid("chat_id").notNull().references(() => chat.id, { onDelete: "cascade" }),
  workshopId: uuid("workshop_id").references(() => workshops.id, { onDelete: "set null" }),
  workItemId: uuid("work_item_id").references(() => workshopChatWorkItems.id, { onDelete: "set null" }),
  runId: uuid("run_id").references(() => workshopRuns.id, { onDelete: "set null" }),
  lastUserMessageId: uuid("last_user_message_id").notNull(), revision: integer("revision").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ pk: primaryKey({ columns: [table.ownerId, table.chatId] }) }));

export const workshopChatDeliveries = pgTable("workshop_chat_deliveries", {
  id: uuid("id").primaryKey(), ownerId: uuid("owner_id").notNull(), chatId: uuid("chat_id").notNull(),
  workshopId: uuid("workshop_id").notNull(), runId: uuid("run_id").notNull(), sourceMessageId: uuid("source_message_id"),
  messageId: uuid("message_id").notNull().unique(), runStatus: text("run_status").notNull(),
  status: text("status").notNull().default("pending"), attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(), lastErrorCode: text("last_error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), deliveredAt: timestamp("delivered_at", { withTimezone: true }),
}, table => ({ eventIdx: uniqueIndex("workshop_chat_deliveries_event_idx").on(table.runId, table.runStatus),
  pendingIdx: index("workshop_chat_deliveries_pending_idx").on(table.status, table.nextAttemptAt) }));

export const workshopMemories = pgTable(
  "workshop_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workshopId: uuid("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 40 }).notNull(),
    content: text("content").notNull(),
    confidence: integer("confidence").notNull().default(50),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    sourceEventIds: jsonb("source_event_ids").$type<string[]>().notNull().default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const workshopOutbox = pgTable(
  "workshop_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workshopId: uuid("workshop_id")
      .notNull()
      .references(() => workshops.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => workshopRuns.id, {
      onDelete: "set null",
    }),
    channel: varchar("channel", { length: 30 }).notNull().default("wechat_desktop"),
    recipientName: text("recipient_name"),
    message: text("message").notNull(),
    status: varchar("status", { length: 30 }).notNull().default("draft"),
    confidence: integer("confidence").notNull().default(50),
    riskLevel: varchar("risk_level", { length: 20 }).notNull().default("medium"),
    sourceEventIds: jsonb("source_event_ids").$type<string[]>().notNull().default([]),
    boundaryResult: jsonb("boundary_result")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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
export const workshopOutboxAttempts=pgTable('workshop_outbox_attempts',{
  id:uuid('id').primaryKey(),
  outboxId:uuid('outbox_id').notNull().references(()=>workshopOutbox.id,{onDelete:'restrict'}),
  workshopId:uuid('workshop_id').notNull().references(()=>workshops.id,{onDelete:'restrict'}),
  ownerId:uuid('owner_id').notNull().references(()=>user.id,{onDelete:'restrict'}),
  commandId:text('command_id').notNull(),
  contentHash:text('content_hash').notNull(),
  policyHash:text('policy_hash').notNull(),
  payload:jsonb('payload').notNull(),
  status:text('status').notNull(),
  providerReceipt:jsonb('provider_receipt'),
  failurePhase:text('failure_phase'),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
  updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},table=>({command:unique().on(table.ownerId,table.commandId),active:uniqueIndex('workshop_outbox_active_attempt').on(table.outboxId).where(sql`${table.status} IN ('sending','sent','unknown')`),statusCheck:check('workshop_outbox_attempts_status_check',sql`${table.status} IN ('sending','sent','unknown','failed')`)}));

export const workshopOutboxResolutions=pgTable('workshop_outbox_resolutions',{
  id:uuid('id').primaryKey(),
  ownerId:uuid('owner_id').notNull().references(()=>user.id,{onDelete:'restrict'}),
  workshopId:uuid('workshop_id').notNull().references(()=>workshops.id,{onDelete:'restrict'}),
  attemptId:uuid('attempt_id').notNull().references(()=>workshopOutboxAttempts.id,{onDelete:'restrict'}),
  commandId:text('command_id').notNull(),payloadHash:text('payload_hash').notNull(),requestJson:jsonb('request_json').notNull(),
  status:text('status').notNull(),resultJson:jsonb('result_json'),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),completedAt:timestamp('completed_at',{withTimezone:true}),
},table=>({command:unique().on(table.ownerId,table.commandId),pending:uniqueIndex('workshop_outbox_pending_resolution').on(table.attemptId).where(sql`${table.status}='pending'`),statusCheck:check('workshop_outbox_resolutions_status_check',sql`${table.status} IN ('pending','completed')`)}));

export const workshopOutboxRecovery=pgTable('workshop_outbox_recovery',{
  attemptId:uuid('attempt_id').primaryKey().references(()=>workshopOutboxAttempts.id,{onDelete:'restrict'}),
  lastCheckedAt:timestamp('last_checked_at',{withTimezone:true}),nextCheckAt:timestamp('next_check_at',{withTimezone:true}).defaultNow(),
  leaseUntil:timestamp('lease_until',{withTimezone:true}),token:uuid('token'),workerId:text('worker_id'),failures:integer('failures').notNull().default(0),detail:text('detail'),
},table=>({due:index('workshop_outbox_recovery_due').on(table.nextCheckAt),failuresCheck:check('workshop_outbox_recovery_failures_check',sql`${table.failures}>=0`)}));

// Characters
export const characters = pgTable(
  "characters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 50 }).notNull(),
    avatarConfig: jsonb("avatar_config")
      .$type<Record<string, unknown>>()
      .default({}),
    jobId: uuid("job_id")
      .notNull()
      .unique()
      .references(() => scheduledJobs.id, { onDelete: "cascade" }),
    insightId: uuid("insight_id")
      .notNull()
      .unique()
      .references(() => insight.id, { onDelete: "set null" }),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    lastExecutionAt: timestamp("last_execution_at", { withTimezone: true }),
    lastExecutionStatus: varchar("last_execution_status", { length: 20 }),
    sources: jsonb("sources")
      .$type<
        Array<{
          type: "file" | "channel" | "folder";
          name: string;
          id?: string;
          path?: string;
        }>
      >()
      .default([]),
    topics: jsonb("topics").$type<string[]>().default([]).notNull(),
    notificationChannels: jsonb("notification_channels")
      .$type<string[]>()
      .default([])
      .notNull(),
    systemNotification: boolean("system_notification").notNull().default(true),
    systemType: varchar("system_type", { length: 50 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userIdx: index("characters_user_idx").on(table.userId),
  }),
);

export type Character = InferSelectModel<typeof characters>;
export type InsertCharacter = InferInsertModel<typeof characters>;

// Insight Timeline History
export const insightTimelineHistory = pgTable(
  "insight_timeline_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    insightId: uuid("insight_id")
      .notNull()
      .references(() => insight.id, { onDelete: "cascade" }),
    timelineEventId: text("timeline_event_id").notNull(),
    version: integer("version").notNull(),
    eventTime: text("event_time"),
    summary: text("summary").notNull(),
    label: text("label").notNull(),
    changeType: text("change_type").notNull(),
    changeReason: text("change_reason").notNull(),
    changedBy: text("changed_by").notNull().default("system"),
    previousSnapshot: jsonb("previous_snapshot"),
    diffSummary: text("diff_summary"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

// Insight Weights Table
// Stores weight-related data for insights (separate table for cleaner separation of concerns)
export const insightWeights = pgTable(
  "insight_weights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    insightId: uuid("insight_id")
      .notNull()
      .references(() => insight.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    customWeightMultiplier: numeric("custom_weight_multiplier", {
      precision: 4,
      scale: 2,
    })
      .$type<number>()
      .notNull()
      .default(1),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
    lastRankCalculatedAt: timestamp("last_rank_calculated_at", {
      withTimezone: true,
    }),
    currentEventRank: numeric("current_event_rank", { precision: 10, scale: 4 })
      .$type<number>()
      .notNull()
      .default(0),
    accessCountTotal: integer("access_count_total").notNull().default(0),
    accessCount7d: integer("access_count_7d").notNull().default(0),
    accessCount30d: integer("access_count_30d").notNull().default(0),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    lastWeightAdjustmentReason: text("last_weight_adjustment_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

// Insight Weight History Table
// Tracks all weight adjustments for insights
export const insightWeightHistory = pgTable(
  "insight_weight_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    insightId: uuid("insight_id")
      .notNull()
      .references(() => insight.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    adjustmentType: varchar("adjustment_type", { length: 20 })
      .notNull()
      .$type<
        "favorite" | "unfavorite" | "view" | "decay" | "manual" | "system"
      >(),
    weightBefore: numeric("weight_before", { precision: 10, scale: 4 })
      .$type<number>()
      .notNull(),
    weightAfter: numeric("weight_after", { precision: 10, scale: 4 })
      .$type<number>()
      .notNull(),
    weightDelta: numeric("weight_delta", { precision: 10, scale: 4 })
      .$type<number>()
      .notNull(),
    customMultiplierBefore: numeric("custom_multiplier_before", {
      precision: 4,
      scale: 2,
    }).$type<number | null>(),
    customMultiplierAfter: numeric("custom_multiplier_after", {
      precision: 4,
      scale: 2,
    }).$type<number | null>(),
    reason: text("reason").notNull(),
    context: jsonb("context")
      .$type<Record<string, unknown> | null>()
      .default(null),
    ipAddress: varchar("ip_address", { length: 45 }), // IPv6 support
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

// Insight Connections Table
// Tracks Hebbian potentiation - connections between insights that strengthen when co-accessed
export const insightConnections = pgTable(
  "insight_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    insightIdA: uuid("insight_id_a")
      .notNull()
      .references(() => insight.id, { onDelete: "cascade" }),
    insightIdB: uuid("insight_id_b")
      .notNull()
      .references(() => insight.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Hebbian potentiation: strength increases when co-accessed
    // Formula: new_strength = old + increment (for co-access)
    // And exponential decay: strength = strength * exp(-days/sqrt(stability))
    strength: numeric("strength", { precision: 10, scale: 6 })
      .$type<number>()
      .notNull()
      .default(0.1), // Start with small initial strength
    // Number of times these insights were accessed together
    coAccessCount: integer("co_access_count").notNull().default(0),
    // When was the connection last strengthened (co-accessed together)
    lastStrengthenedAt: timestamp("last_strengthened_at", {
      withTimezone: true,
    }),
    // Stability affects decay rate - connections accessed frequently have higher stability
    // and decay more slowly
    stability: numeric("stability", { precision: 10, scale: 4 })
      .$type<number>()
      .notNull()
      .default(1.0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // Each pair of insights can only have one connection per user
    uniqueConnection: uniqueIndex("insight_connection_unique_idx").on(
      table.insightIdA,
      table.insightIdB,
      table.userId,
    ),
    // Indexes for efficient lookup
    userIdx: index("insight_connection_user_idx").on(table.userId),
    insightAIdx: index("insight_connection_insight_a_idx").on(table.insightIdA),
    insightBIdx: index("insight_connection_insight_b_idx").on(table.insightIdB),
    // Index for finding strong connections
    strengthIdx: index("insight_connection_strength_idx").on(
      table.userId,
      table.strength,
    ),
    // Index for decay queries (find connections to decay)
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

// Entity Registry Table
// Tracks entities (people, groups, concepts) as first-class citizens with disambiguation
export const entities = pgTable(
  "entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    entityType: varchar("entity_type", { length: 30 })
      .notNull()
      .$type<"person" | "group" | "concept" | "project" | "company">(),
    // The canonical/primary name for this entity
    canonicalName: text("canonical_name").notNull(),
    // Additional names/aliases this entity is known by
    aliases: text("aliases")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    // Context for disambiguation - helps distinguish from similar entities
    // e.g., "CEO of Acme Corp", "works in the NYC office"
    disambiguationContext: text("disambiguation_context"),
    // Source bot IDs where this entity was first seen/learned
    sourceBotIds: uuid("source_bot_ids")
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    // How many insights reference this entity
    insightCount: integer("insight_count").notNull().default(0),
    // First and last seen timestamps
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // User-provided metadata
    isPinned: boolean("is_pinned").notNull().default(false),
    isIgnored: boolean("is_ignored").notNull().default(false),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // Each user can only have one entity with a given canonical name per type
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

// Insight-Entity Junction Table
// Links insights to entities with roles (subject, object, mentioned)
// This enables "who is this insight about" vs "who is mentioned in this insight" distinction
export const insightEntities = pgTable(
  "insight_entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    insightId: uuid("insight_id")
      .notNull()
      .references(() => insight.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    // Role of this entity in the insight
    // - "subject": the primary entity the insight is about (e.g., "John got promoted")
    // - "object": an entity that is acted upon (e.g., "Mary hired John" - John is object)
    // - "mentioned": simply referenced in the insight
    role: varchar("role", { length: 20 })
      .notNull()
      .$type<"subject" | "object" | "mentioned">(),
    // How strongly is this entity connected to the insight (0.0 - 1.0)
    // Computed based on co-occurrence, prominence in text, etc.
    confidence: numeric("confidence", { precision: 5, scale: 4 })
      .$type<number>()
      .notNull()
      .default(0.5),
    // The text span in the original insight that refers to this entity
    textSpan: text("text_span"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // An entity can have one role per insight
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

// Insight View History Table
// Tracks user views of insights
export const insightViewHistory = pgTable(
  "insight_view_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    insightId: uuid("insight_id")
      .notNull()
      .references(() => insight.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    viewDurationSeconds: integer("view_duration_seconds"),
    viewSource: varchar("view_source", { length: 20 })
      .notNull()
      .$type<"list" | "detail" | "search" | "favorite">(),
    viewContext: jsonb("view_context")
      .$type<Record<string, unknown> | null>()
      .default(null),
    viewedAt: timestamp("viewed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

// Insight Weight Config Table
// Stores weight configuration (global and per-user)
export const insightWeightConfig = pgTable(
  "insight_weight_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    configKey: varchar("config_key", { length: 50 }).notNull(),
    configValue: jsonb("config_value")
      .$type<Record<string, unknown>>()
      .notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const pageStateSnapshots = pgTable(
  "page_state_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").$type<Record<string, unknown>>().notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    staleUntil: timestamp("stale_until", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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

export const workshopExecutionLeases = pgTable('workshop_execution_leases', {
  workshopId: uuid('workshop_id').primaryKey().references(()=>workshops.id,{onDelete:'cascade'}),
  token: integer('token').notNull().default(0),
  // Kept independently of run-history pruning so the fencing counter cannot reset.
  runId: uuid('run_id'),
  workerId: text('worker_id'),
  phase: text('phase').notNull().default('idle'),
  leaseUntil: timestamp('lease_until',{withTimezone:true}),
  heartbeatAt: timestamp('heartbeat_at',{withTimezone:true}),
  effectStarted: boolean('effect_started').notNull().default(false),
  resultJson: jsonb('result_json').$type<Record<string,unknown>>(),
  updatedAt: timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},table=>({
  expiryIdx:index('workshop_execution_leases_expiry_idx').on(table.leaseUntil).where(sql`${table.phase}='running'`),
  tokenCheck:check('workshop_execution_leases_token_check',sql`${table.token}>=0`),
  phaseCheck:check('workshop_execution_leases_phase_check',sql`${table.phase} IN ('idle','running','needs_review')`),
  activeCheck:check('workshop_execution_leases_active_check',sql`${table.phase}='idle' OR (${table.runId} IS NOT NULL AND ${table.workerId} IS NOT NULL AND ${table.leaseUntil} IS NOT NULL)`),
}));

// T1 persists narrow audit/read receipts; domain payloads remain in their existing tables.
export const memoryQueryReadReceipts = pgTable("memory_query_read_receipts", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull(), requestHash: text("request_hash").notNull(),
  refs: jsonb("refs").notNull(), contextLogId: uuid("context_log_id"), coverage: jsonb("coverage").notNull(),
  traceId: uuid("trace_id").notNull(), contractVersion: text("contract_version").notNull(),
  implementationVersion: text("implementation_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ ownerCreated: index("memory_query_read_receipts_owner_created_idx").on(table.userId, table.createdAt) }));

export const memoryOperationReceipts = pgTable("memory_operation_receipts", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  commandId: text("command_id").notNull(), requestHash: text("request_hash").notNull(),
  observationId: uuid("observation_id").notNull(), revision: text("revision").notNull(),
  traceId: uuid("trace_id").notNull(), contractVersion: text("contract_version").notNull(),
  implementationVersion: text("implementation_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ command: uniqueIndex("memory_operation_receipts_owner_command_idx").on(table.userId, table.commandId) }));

export const memoryReadReceipts = pgTable("memory_read_receipts", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull(), observationId: uuid("observation_id").notNull(), revision: text("revision").notNull(),
  actualRange: jsonb("actual_range").notNull(), totalLength: integer("total_length").notNull(),
  traceId: uuid("trace_id").notNull(), contractVersion: text("contract_version").notNull(),
  implementationVersion: text("implementation_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ ownerCreated: index("memory_read_receipts_owner_created_idx").on(table.userId, table.createdAt) }));

// T5 keeps object bytes private and records their lifecycle separately from
// business file references and immutable command/read receipts.
export const memoryArtifactManifests = pgTable("memory_artifact_manifests", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  commandId: varchar("command_id", { length: 200 }).notNull(),
  requestHash: text("request_hash").notNull(), revision: integer("revision").notNull().default(0),
  state: text("state", { enum: ["pending", "sealed", "active", "deleting", "deleted"] }).notNull().default("pending"),
  provider: text("provider", { enum: ["private_local", "private_blob"] }).notNull(), objectKey: text("object_key").notNull(),
  name: text("name").notNull(), contentType: text("content_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(), sha256: text("sha256").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  quotaCharged: boolean("quota_charged").notNull().default(false),
  cleanupAttempts: integer("cleanup_attempts").notNull().default(0), lastError: text("last_error"),
  userFileId: uuid("user_file_id").references(() => userFiles.id, { onDelete: "set null" }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  ownerCommand: uniqueIndex("memory_artifact_manifests_owner_command_idx").on(table.userId, table.commandId),
  objectKey: uniqueIndex("memory_artifact_manifests_object_key_idx").on(table.objectKey),
  ownerState: index("memory_artifact_manifests_owner_state_idx").on(table.userId, table.state),
  recovery: index("memory_artifact_manifests_recovery_idx").on(table.state, table.expiresAt),
  revisionCheck: check("memory_artifact_manifests_revision_check", sql`${table.revision} >= 0`),
  sizeCheck: check("memory_artifact_manifests_size_check", sql`${table.sizeBytes} > 0`),
  stateCheck: check("memory_artifact_manifests_state_check", sql`${table.state} IN ('pending','sealed','active','deleting','deleted')`),
  providerCheck: check("memory_artifact_manifests_provider_check", sql`${table.provider} IN ('private_local','private_blob')`),
  digestCheck: check("memory_artifact_manifests_digest_check", sql`${table.sha256} ~ '^[a-f0-9]{64}$' AND ${table.requestHash} ~ '^[a-f0-9]{64}$'`),
}));

export const memoryArtifactCommandReceipts = pgTable("memory_artifact_command_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  commandId: varchar("command_id", { length: 200 }).notNull(), requestHash: text("request_hash").notNull(),
  artifactId: uuid("artifact_id").notNull().references(() => memoryArtifactManifests.id, { onDelete: "cascade" }),
  action: text("action").notNull(), fromRevision: integer("from_revision").notNull(), toRevision: integer("to_revision").notNull(),
  result: jsonb("result").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ ownerCommand: uniqueIndex("memory_artifact_command_receipts_owner_command_idx").on(table.userId, table.commandId),
  artifact: index("memory_artifact_command_receipts_artifact_idx").on(table.artifactId, table.createdAt) }));

export const memoryArtifactReadReceipts = pgTable("memory_artifact_read_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  artifactId: uuid("artifact_id").notNull().references(() => memoryArtifactManifests.id, { onDelete: "cascade" }),
  purpose: text("purpose", { enum: ["current", "evidence"] }).notNull().default("evidence"),
  revision: text("revision").notNull(), actualRange: jsonb("actual_range").$type<{ start: number; end: number; unit: "bytes" }>().notNull(),
  totalLength: bigint("total_length", { mode: "number" }).notNull(), sha256: text("sha256").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ ownerCreated: index("memory_artifact_read_receipts_owner_created_idx").on(table.userId, table.createdAt) }));

export const memoryFileImports = pgTable('memory_file_import_receipts', {
  id: uuid('id').primaryKey(), userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  commandId: varchar('command_id', { length: 200 }).notNull(), requestHash: text('request_hash').notNull(),
  taskChatId: uuid('task_chat_id').notNull(),
  relativePath: text('relative_path').notNull(), sha256: text('sha256').notNull(), sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  fileStat: jsonb('file_stat').$type<Record<string, unknown>>().notNull(),
  state: text('state', { enum: ['pending', 'recorded'] }).notNull(),
  artifactId: uuid('artifact_id').references(() => memoryArtifactManifests.id, { onDelete: 'cascade' }), artifactRevision: text('artifact_revision'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({ ownerCommand: uniqueIndex('memory_file_import_owner_command_idx').on(table.userId, table.commandId),
  digestCheck: check('memory_file_import_digest_check', sql`${table.sha256} ~ '^[a-f0-9]{64}$' AND ${table.requestHash} ~ '^[a-f0-9]{64}$'`),
  stateCheck: check('memory_file_import_state_check', sql`${table.state} IN ('pending','recorded') AND (${table.state} <> 'recorded' OR (${table.artifactId} IS NOT NULL AND ${table.artifactRevision} IS NOT NULL))`) }));

export const memoryFileBindings = pgTable('memory_file_bindings', {
  id: uuid('id').primaryKey(), userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  workshopId: uuid('workshop_id').notNull().references(() => workshops.id, { onDelete: 'cascade' }),
  sourceId: uuid('source_id').notNull().references(() => workshopSources.id, { onDelete: 'cascade' }),
  artifactId: uuid('artifact_id').notNull().references(() => memoryArtifactManifests.id, { onDelete: 'cascade' }), artifactRevision: text('artifact_revision').notNull(),
  revision: integer('revision').notNull().default(1), state: text('state', { enum: ['active', 'revoked'] }).notNull(),
  permissions: jsonb('permissions').$type<Array<'read' | 'convert'>>().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({ ownerSource: uniqueIndex('memory_file_binding_owner_source_idx').on(table.userId, table.sourceId),
  workState: index('memory_file_binding_work_state_idx').on(table.userId, table.workshopId, table.state),
  revisionCheck: check('memory_file_binding_revision_check', sql`${table.revision} >= 1`),
  stateCheck: check('memory_file_binding_state_check', sql`${table.state} IN ('active','revoked')`),
  permissionsCheck: check('memory_file_binding_permissions_check', sql`jsonb_typeof(${table.permissions}) = 'array' AND ${table.permissions} <@ '["read","convert"]'::jsonb AND jsonb_array_length(${table.permissions}) > 0`) }));

export const memoryFileBindingCommands = pgTable('memory_file_binding_commands', {
  id: uuid('id').primaryKey(), userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  commandId: varchar('command_id', { length: 200 }).notNull(), requestHash: text('request_hash').notNull(),
  bindingId: uuid('binding_id').notNull().references(() => memoryFileBindings.id, { onDelete: 'cascade' }),
  fromRevision: integer('from_revision').notNull(), toRevision: integer('to_revision').notNull(), result: jsonb('result').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({ ownerCommand: uniqueIndex('memory_file_binding_command_owner_idx').on(table.userId, table.commandId) }));

export const memoryWorkFileUploadIntents = pgTable('memory_work_file_upload_intents', {
  id: uuid('id').primaryKey(), userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  commandId: varchar('command_id', { length: 200 }).notNull(), requestHash: text('request_hash').notNull(),
  workshopId: uuid('workshop_id').notNull().references(() => workshops.id, { onDelete: 'cascade' }),
  sourceId: uuid('source_id'), state: text('state', { enum: ['pending', 'recorded'] }).notNull(),
  result: jsonb('result').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => ({ ownerCommand: uniqueIndex('memory_work_file_upload_owner_command_idx').on(table.userId, table.commandId),
  stateCheck: check('memory_work_file_upload_state_check', sql`${table.requestHash} ~ '^[a-f0-9]{64}$' AND ${table.state} IN ('pending','recorded') AND (${table.state} <> 'recorded' OR (${table.sourceId} IS NOT NULL AND ${table.result} IS NOT NULL))`) }));
