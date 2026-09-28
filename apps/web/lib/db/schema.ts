/**
 * Schema Selector
 * Automatically selects PostgreSQL or SQLite schema based on deployment mode
 *
 * This file handles the dual-schema system:
 * - Server mode: Uses PostgreSQL schema (./schema.pg.ts)
 * - Tauri mode: Uses SQLite schema (./schema-sqlite.ts)
 */

// Check deployment mode directly from env (avoid importing from files with "server-only")
const isTauriMode =
  process.env.TAURI_MODE === "true" || process.env.IS_TAURI === "true";

// Import both schemas
import * as pgSchema from "./schema.pg";
import * as sqliteSchema from "./schema-sqlite";

// Get the current schema at module load time
// For Tauri, IS_TAURI must be set before the module loads
const currentSchema = isTauriMode ? sqliteSchema : pgSchema;

// Export all runtime table definitions directly from the selected schema
export const user = (currentSchema as any).user;
export const passwordResetToken = (currentSchema as any).passwordResetToken;
export const nativeAgentPlans = (currentSchema as any).nativeAgentPlans;
export const chat = (currentSchema as any).chat;
export const chatInsights = (currentSchema as any).chatInsights;
export const message = (currentSchema as any).message;
export const vote = (currentSchema as any).vote;
export const stream = (currentSchema as any).stream;
export const bot = (currentSchema as any).bot;
export const insight = (currentSchema as any).insight;
export const insightEmbeddings = (currentSchema as any).insightEmbeddings;
export const rawMessages = (currentSchema as any).rawMessages;
export const memorySummaries = (currentSchema as any).memorySummaries;
export const userInsightSettings = (currentSchema as any).userInsightSettings;
export const userLlmApiSettings = (currentSchema as any).userLlmApiSettings;
export const userContacts = (currentSchema as any).userContacts;
export const dingtalkBotInsightMessages = (currentSchema as any)
  .dingtalkBotInsightMessages;
export const feedback = (currentSchema as any).feedback;
export const survey = (currentSchema as any).survey;
export const userSubscriptions = (currentSchema as any).userSubscriptions;
export const userEmailPreferences = (currentSchema as any).userEmailPreferences;
export const marketingEmailLog = (currentSchema as any).marketingEmailLog;
export const telegramAccounts = (currentSchema as any).telegramAccounts;
export const whatsappAccounts = (currentSchema as any).whatsappAccounts;
export const discordAccounts = (currentSchema as any).discordAccounts;
export const integrationAccounts = (currentSchema as any).integrationAccounts;
export const integrationCatalog = (currentSchema as any).integrationCatalog;
export const rssSubscriptions = (currentSchema as any).rssSubscriptions;
export const rssItems = (currentSchema as any).rssItems;
export const userRoles = (currentSchema as any).userRoles;
export const insightFilters = (currentSchema as any).insightFilters;
export const insightTabs = (currentSchema as any).insightTabs;
export const userCategories = (currentSchema as any).userCategories;
export const weeklyReports = (currentSchema as any).weeklyReports;
export const weeklyReportRevisions = (currentSchema as any)
  .weeklyReportRevisions;
export const peopleGraphSnapshot = (currentSchema as any).peopleGraphSnapshot;
export const personCustomFields = (currentSchema as any).personCustomFields;
export const ragDocuments = (currentSchema as any).ragDocuments;
export const ragChunks = (currentSchema as any).ragChunks;
export const userFileUsage = (currentSchema as any).userFileUsage;
export const userFiles = (currentSchema as any).userFiles;

// Tables that may not exist in both schemas - use optional chaining
export const affiliates = (currentSchema as any).affiliates;
export const affiliateClicks = (currentSchema as any).affiliateClicks;
export const affiliatePayouts = (currentSchema as any).affiliatePayouts;
export const affiliateTransactions = (currentSchema as any)
  .affiliateTransactions;
export const coupons = (currentSchema as any).coupons;
export const couponRedemptions = (currentSchema as any).couponRedemptions;
export const landingPromoRegistrations = (currentSchema as any)
  .landingPromoRegistrations;
export const stripeWebhookEvents = (currentSchema as any).stripeWebhookEvents;
export const presentationJobs = (currentSchema as any).presentationJobs;
export const presentationArtifacts = (currentSchema as any)
  .presentationArtifacts;
export const presentationOutlines = (currentSchema as any).presentationOutlines;
export const insightTimelineHistory = (currentSchema as any)
  .insightTimelineHistory;
export const insightNotes = (currentSchema as any).insightNotes;
export const insightDocuments = (currentSchema as any).insightDocuments;
export const insightBriefCategories = (currentSchema as any)
  .insightBriefCategories;
export const insightCompactionLinks = (currentSchema as any)
  .insightCompactionLinks;
// Weight management tables
export const insightWeights = (currentSchema as any).insightWeights;
export const insightWeightHistory = (currentSchema as any).insightWeightHistory;
export const insightViewHistory = (currentSchema as any).insightViewHistory;
export const insightWeightConfig = (currentSchema as any).insightWeightConfig;

// Living Connections tables (Hebbian potentiation)
export const insightConnections = (currentSchema as any).insightConnections;

// Entity Registry tables
export const entities = (currentSchema as any).entities;
export const insightEntities = (currentSchema as any).insightEntities;

// Credential security tables
export const credentialRotationHistory = (currentSchema as any)
  .credentialRotationHistory;
export const credentialAccessLog = (currentSchema as any).credentialAccessLog;

// Tables only available in PostgreSQL mode
export const insightProcessingFailures = (currentSchema as any)
  .insightProcessingFailures;
export const userFreeQuota = (currentSchema as any).userFreeQuota;
export const userMonthlyQuota = (currentSchema as any).userMonthlyQuota;
export const userRewardEvents = (currentSchema as any).userRewardEvents;
export const userCreditLedger = (currentSchema as any).userCreditLedger;
export const scheduledJobs = (currentSchema as any).scheduledJobs;
export const jobExecutions = (currentSchema as any).jobExecutions;
export const loops = (currentSchema as any).loops;
export const loopRuns = (currentSchema as any).loopRuns;
export const loopStates = (currentSchema as any).loopStates;
export const loopApprovalRequests = (currentSchema as any).loopApprovalRequests;
export const interactionEvents = (currentSchema as any).interactionEvents;
export const interactionThreads = (currentSchema as any).interactionThreads;
export const interactionProcessingJobs = (currentSchema as any)
  .interactionProcessingJobs;
export const interactionNotes = (currentSchema as any).interactionNotes;
export const interactionTasks = (currentSchema as any).interactionTasks;
export const interactionMemories = (currentSchema as any).interactionMemories;
export const memoryGraphEntities = (currentSchema as any).memoryGraphEntities;
export const memoryGraphRelations = (currentSchema as any).memoryGraphRelations;
export const memoryGraphEvidence = (currentSchema as any).memoryGraphEvidence;
export const brainObservations = (currentSchema as any).brainObservations;
export const brainMemories = (currentSchema as any).brainMemories;
export const brainMemoryReviews = (currentSchema as any).brainMemoryReviews;
export const brainStateSnapshots = (currentSchema as any).brainStateSnapshots;
export const pageStateSnapshots = (currentSchema as any).pageStateSnapshots;
export const brainAccessGrants = (currentSchema as any).brainAccessGrants;
export const brainContextLogs = (currentSchema as any).brainContextLogs;
export const interactionSourcePolicies = (currentSchema as any).interactionSourcePolicies;
export const workshops = (currentSchema as any).workshops;
export const workCollaborationRequests = (currentSchema as any).workCollaborationRequests;
export const workCollaborationEvents = (currentSchema as any).workCollaborationEvents;
export const workCommands = (currentSchema as any).workCommands;
export const workshopWorkVersions = (currentSchema as any).workshopWorkVersions;
export const quantTradePlans = (currentSchema as any).quantTradePlans;
export const quantTrendStateSnapshots = (currentSchema as any)
  .quantTrendStateSnapshots;
export const quantTrendStrategySamples = (currentSchema as any)
  .quantTrendStrategySamples;
export const workshopHeartbeats = (currentSchema as any).workshopHeartbeats;
export const workshopRuns = (currentSchema as any).workshopRuns;
export const workshopRuntimeSnapshots = (currentSchema as any)
  .workshopRuntimeSnapshots;
export const workshopEvents = (currentSchema as any).workshopEvents;
export const workshopReviewItems = (currentSchema as any).workshopReviewItems;
export const harnessComponents = (currentSchema as any).harnessComponents;
export const harnessComponentRevisions = (currentSchema as any)
  .harnessComponentRevisions;
export const workHarnessSnapshots = (currentSchema as any)
  .workHarnessSnapshots;
export const workHarnessSnapshotItems = (currentSchema as any)
  .workHarnessSnapshotItems;
export const workRunEvidenceBundles = (currentSchema as any)
  .workRunEvidenceBundles;
export const workRunDiagnostics = (currentSchema as any).workRunDiagnostics;
export const workEvaluationSuites = (currentSchema as any)
  .workEvaluationSuites;
export const workEvaluationScenarios = (currentSchema as any)
  .workEvaluationScenarios;
export const workEvaluationCampaigns = (currentSchema as any)
  .workEvaluationCampaigns;
export const workEvaluationRuns = (currentSchema as any).workEvaluationRuns;
export const workHarnessChangeProposals = (currentSchema as any)
  .workHarnessChangeProposals;
export const workHarnessChangeItems = (currentSchema as any)
  .workHarnessChangeItems;
export const workEvolutionVerdicts = (currentSchema as any)
  .workEvolutionVerdicts;
export const workshopSources = (currentSchema as any).workshopSources;
export const workshopDirectives = (currentSchema as any).workshopDirectives;
export const workshopMemories = (currentSchema as any).workshopMemories;
export const workshopOutbox = (currentSchema as any).workshopOutbox;
export const characters = (currentSchema as any).characters;

// Functions
export const parseInsightSettings = (currentSchema as any).parseInsightSettings;
export const serializeInsightSettings = (currentSchema as any)
  .serializeInsightSettings;

// Re-export ALL types from PostgreSQL schema
// Types are compatible between PostgreSQL and SQLite schemas
// We use PostgreSQL types as the source of truth
export type {
  User,
  PasswordResetToken,
  NativeAgentPlanRow,
  InsertNativeAgentPlan,
  Chat,
  DBMessage,
  Vote,
  Stream,
  IntegrationAccount,
  InsertIntegrationAccount,
  IntegrationCatalogEntry,
  RssSubscription,
  RssItem,
  InsertRssItem,
  Bot,
  Insight,
  InsertInsight,
  InsightEmbedding,
  InsertInsightEmbedding,
  RawMessageRow,
  InsertRawMessageRow,
  MemorySummaryRow,
  InsertMemorySummaryRow,
  InsightSettings,
  DBInsightSettings,
  DBInsertInsightSettings,
  UserLlmApiSettings,
  InsertUserLlmApiSettings,
  DBPersonCustomFields,
  DBInsertPersonCustomFields,
  UserRole,
  InsertUserRole,
  DBInsightFilter,
  DBInsertInsightFilter,
  DBInsightTab,
  DBInsertInsightTab,
  DBUserCategory,
  DBInsertUserCategory,
  TelegramAccount,
  InsertTelegramAccount,
  DiscordAccount,
  InsertDiscordAccount,
  UserContact,
  DingtalkBotInsightMessage,
  ChatInsight,
  InsertChatInsight,
  Affiliate,
  AffiliateInsert,
  AffiliateClick,
  AffiliatePayout,
  Coupon,
  CouponInsert,
  CouponRedemption,
  CouponRedemptionInsert,
  UserFileUsage,
  UserFile,
  Feedback,
  Survey,
  UserEmailPreferences,
  InsightAction,
  InsightTaskStatus,
  InsightTaskItem,
  InsightRiskFlag,
  InsertRAGDocument,
  InsertRAGChunk,
  LandingPromoRegistration,
  InsertLandingPromoRegistration,
  WhatsAppAccount,
  InsertWhatsAppAccount,
  InsightProcessingFailure,
  InsertInsightProcessingFailure,
  ScheduledJob,
  InsertScheduledJob,
  JobExecution,
  InsertJobExecution,
  Loop,
  InsertLoop,
  LoopRun,
  InsertLoopRun,
  LoopState,
  InsertLoopState,
  LoopApprovalRequest,
  InsertLoopApprovalRequest,
  InteractionEvent,
  InsertInteractionEvent,
  InteractionThread,
  InsertInteractionThread,
  InteractionProcessingJob,
  InsertInteractionProcessingJob,
  InteractionNote,
  InsertInteractionNote,
  InteractionTask,
  InsertInteractionTask,
  InteractionMemory,
  InsertInteractionMemory,
  MemoryGraphEntity,
  InsertMemoryGraphEntity,
  MemoryGraphRelation,
  InsertMemoryGraphRelation,
  MemoryGraphEvidence,
  InsertMemoryGraphEvidence,
  BrainObservation,
  InsertBrainObservation,
  BrainMemoryRow,
  InsertBrainMemoryRow,
  BrainMemoryReview,
  InsertBrainMemoryReview,
  BrainStateSnapshot,
  InsertBrainStateSnapshot,
  PageStateSnapshot,
  InsertPageStateSnapshot,
  BrainAccessGrantRow,
  InsertBrainAccessGrantRow,
  BrainContextLog,
  InsertBrainContextLog,
  Workshop,
  InsertWorkshop,
  WorkshopWorkVersion,
  InsertWorkshopWorkVersion,
  QuantTradePlan,
  InsertQuantTradePlan,
  QuantTrendStateSnapshot,
  InsertQuantTrendStateSnapshot,
  QuantTrendStrategySample,
  InsertQuantTrendStrategySample,
  WorkshopHeartbeat,
  InsertWorkshopHeartbeat,
  WorkshopRun,
  InsertWorkshopRun,
  WorkshopEvent,
  InsertWorkshopEvent,
  WorkshopReviewItem,
  InsertWorkshopReviewItem,
  HarnessComponentRow,
  InsertHarnessComponentRow,
  HarnessComponentRevisionRow,
  InsertHarnessComponentRevisionRow,
  WorkHarnessSnapshotRow,
  InsertWorkHarnessSnapshotRow,
  WorkHarnessSnapshotItemRow,
  InsertWorkHarnessSnapshotItemRow,
  WorkRunEvidenceBundleRow,
  InsertWorkRunEvidenceBundleRow,
  WorkRunDiagnosticRow,
  InsertWorkRunDiagnosticRow,
  WorkEvaluationSuiteRow,
  InsertWorkEvaluationSuiteRow,
  WorkEvaluationScenarioRow,
  InsertWorkEvaluationScenarioRow,
  WorkEvaluationCampaignRow,
  InsertWorkEvaluationCampaignRow,
  WorkEvaluationRunRow,
  InsertWorkEvaluationRunRow,
  WorkHarnessChangeProposalRow,
  InsertWorkHarnessChangeProposalRow,
  WorkHarnessChangeItemRow,
  InsertWorkHarnessChangeItemRow,
  WorkEvolutionVerdictRow,
  InsertWorkEvolutionVerdictRow,
  WorkshopSource,
  InsertWorkshopSource,
  WorkshopDirective,
  InsertWorkshopDirective,
  WorkshopMemory,
  InsertWorkshopMemory,
  WorkshopOutboxItem,
  InsertWorkshopOutboxItem,
  InsightTimelineHistory,
  InsertInsightTimelineHistory,
  InsightNote,
  InsertInsightNote,
  InsightDocument,
  InsertInsightDocument,
  InsightBriefCategory,
  InsertInsightBriefCategory,
  InsightCompactionLink,
  InsertInsightCompactionLink,
  InsightWeight,
  InsertInsightWeight,
  InsightWeightHistory,
  InsertInsightWeightHistory,
  InsightViewHistory,
  InsertInsightViewHistory,
  InsightWeightConfig,
  InsertInsightWeightConfig,
  InsightConnection,
  InsertInsightConnection,
  Entity,
  InsertEntity,
  InsightEntity,
  InsertInsightEntity,
  Character,
  InsertCharacter,
  CredentialRotationHistory,
  InsertCredentialRotationHistory,
  CredentialAccessLog,
  InsertCredentialAccessLog,
} from "./schema.pg";

// Re-export SQLite-specific types
