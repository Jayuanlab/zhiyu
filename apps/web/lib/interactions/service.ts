import { randomUUID } from "node:crypto";
import { projectInteractionTaskScenariosInTransaction } from "./scenario-task-projection";
import { assertTaskSources, insertTaskRecord, lockTaskCommand, readTaskInTransaction, replayTaskCommand, TaskRecordInputError } from "@/lib/memory/records/tasks";
import { taskCommandHash, taskState, validateTaskCommand, transitionInteractionTaskInTransaction, setInteractionTaskStatus, withInteractionTaskTransaction } from "./task-state";
import { createMemoryCandidate as createBrainMemoryCandidate, reviewMemory as reviewBrainMemory, writeMemory as writeBrainMemory } from "@/lib/memory/revision/writes";
import { createObservation as createBrainObservation } from "@/lib/memory/ingestion/observations";
import { listBrainMemoriesForUser as listBrainMemory } from "@/lib/memory/retrieval/candidates";
import type { BrainMemory, BrainMemoryStatus, BrainRequester } from "@/lib/memory/kernel/memory-types";
import { captureMemoryDependenciesInTransaction, assertMemoryDependenciesCurrentInTransaction } from "@/lib/memory/revision/dependencies";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import { withExecutionBusinessWrite, ExecutionLeaseError } from "@/lib/work-runtime/execution-lease";
import type { DrizzleDB } from "@/lib/db/types";
import {
  shouldPreferBrainMemory,
  shouldReadLegacyMemoryFallback,
} from "@/lib/memory/retrieval/mode";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import pLimit from "p-limit";
import { db } from "@/lib/db/client";
import {
  interactionEvents,
  interactionMemories,
  interactionNotes,
  interactionTasks,
  interactionThreads,
  type InsertInteractionMemory,
  type InsertInteractionNote,
  type InsertInteractionTask,
  type InsertInteractionEvent,
  type InteractionEvent,
  type InteractionMemory,
  type InteractionNote,
  type InteractionTask,
  type InteractionThread,
} from "@/lib/db/schema";
import { deserializeJson, serializeJson } from "@/lib/db/serialization";
import {
  getWechatLocalHistory,
  getWechatLocalSessions,
} from "@/lib/wechat-local/client";
import { listInteractionSourcePolicies } from "@/lib/knowledge-pipeline/source-policies";
import {
  normalizeWechatLocalPayload,
  type NormalizedWechatMessage,
} from "./wechat-normalizer";
import {
  evaluateInteractionMemoryPromotion,
  INTERACTION_MEMORY_AUTO_PROMOTION_POLICY_VERSION,
  type InteractionMemoryPromotionDecision,
} from "./memory-promotion";
import type {
  BrainCanonicalKind,
  BrainMemoryFacets,
} from "@/lib/memory/kernel/memory-canonical";
import { buildInteractionScenarioApplicabilityFacets, getBrainMemoryCanonicalMetadata } from "@/lib/memory/kernel/memory-canonical";
import { assertInteractionMemorySources, interactionMemorySourceId, INTERACTION_MEMORY_ALIAS_PREFIX,
  listInteractionCleanupCandidates, requireInteractionMemoryTarget, withInteractionMemoryCommand } from "./memory-command";

export type InteractionEventStatus =
  | "new"
  | "seen"
  | "processing"
  | "processed"
  | "ignored"
  | "failed";

export type RecordWechatMessagesResult = {
  insertedCount: number;
  duplicateCount: number;
  eventCount: number;
  events: InteractionEvent[];
  insertedEvents: InteractionEvent[];
  duplicateEvents: InteractionEvent[];
  sourceResults?: Array<{
    warning?: string;
    sourceId: string;
    sourceName: string;
    messageCount: number;
    insertedCount: number;
    duplicateCount: number;
    eventCount: number;
  }>;
  rawPayload: unknown;
};

export type InteractionWikiItemKind = "note" | "task" | "memory";

export type InteractionWikiSnapshot = {
  notes: InteractionNote[];
  tasks: InteractionTask[];
  memories: InteractionMemory[];
};

export type InteractionMemorySearchResult = {
  memory: InteractionMemory;
  score: number;
};

export type PromoteInteractionMemoryCandidatesResult = {
  scanned: number;
  promotedCount: number;
  retainedCount: number;
  promoted: InteractionMemory[];
  retained: Array<{
    id: string;
    subject: string;
    memoryType: string;
    confidence: number | null;
    decision: InteractionMemoryPromotionDecision;
  }>;
};

type InteractionEventInput = NormalizedWechatMessage & {
  userId: string;
  processedStatus?: InteractionEventStatus;
  importance?: string;
  requiresReply?: boolean;
};

type WechatSessionSummary = {
  username: string;
  chat?: string;
  chatType?: string;
  isGroup?: boolean;
  timestamp?: number;
  raw: Record<string, unknown>;
};

function toDbJson(value: unknown) {
  const data =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return serializeJson(data) as Record<string, unknown>;
}

function toDbArray(value: unknown[] | null | undefined) {
  return serializeJson(value ?? []) as unknown[];
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed = deserializeJson(value as any);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function parseJsonArray<T = unknown>(value: unknown): T[] {
  const parsed = deserializeJson(value as any);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

function normalizeEvent<T extends InteractionEvent>(event: T): T {
  return {
    ...event,
    sourceRaw: parseJsonObject((event as any).sourceRaw),
  };
}

function normalizeNote<T extends InteractionNote>(note: T): T {
  return {
    ...note,
    sourceEventIds: parseJsonArray<string>((note as any).sourceEventIds),
    metadata: parseJsonObject((note as any).metadata),
  };
}

function normalizeTask<T extends InteractionTask>(task: T): T {
  return {
    ...task,
    sourceEventIds: parseJsonArray<string>((task as any).sourceEventIds),
    metadata: parseJsonObject((task as any).metadata),
  };
}

function normalizeMemory<T extends InteractionMemory>(memory: T): T {
  return {
    ...memory,
    tags: parseJsonArray<string>((memory as any).tags),
    sourceEventIds: parseJsonArray<string>((memory as any).sourceEventIds),
    metadata: parseJsonObject((memory as any).metadata),
  };
}

function brainStatusToInteractionStatus(status: BrainMemoryStatus) {
  switch (status) {
    case "candidate":
      return "candidate";
    case "verified":
    case "active":
      return "confirmed";
    case "deleted":
      return "deleted";
    case "weakened":
      return "archived";
    default:
      return "candidate";
  }
}

function interactionStatusesToBrainStatuses(statuses?: string[]) {
  if (!statuses?.length) {
    return ["candidate", "active", "verified", "weakened"] as BrainMemoryStatus[];
  }
  const mapped = new Set<BrainMemoryStatus>();
  for (const status of statuses) {
    if (status === "candidate") mapped.add("candidate");
    if (status === "confirmed" || status === "active") {
      mapped.add("active");
      mapped.add("verified");
    }
    if (status === "verified") mapped.add("verified");
    if (status === "weakened") mapped.add("weakened");
    if (status === "dismissed" || status === "deleted") mapped.add("deleted");
    if (status === "archived") mapped.add("weakened");
  }
  return [...mapped];
}

function brainMemoryToInteractionMemory(memory: BrainMemory): InteractionMemory {
  const createdAt = new Date(memory.createdAt);
  const updatedAt = new Date(memory.updatedAt);
  return {
    id: memory.id,
    userId: memory.userId,
    memoryType: memory.memoryType,
    subject: memory.subject,
    content: memory.content,
    status: brainStatusToInteractionStatus(memory.status),
    confidence: memory.confidence,
    tags: memory.tags ?? [],
    sourceEventIds: memory.evidenceRefs,
    lastVerifiedAt:
      memory.status === "verified" || memory.status === "active"
        ? updatedAt
        : null,
    expiresAt: memory.expiresAt ? new Date(memory.expiresAt) : null,
    metadata: {
      source: "brain",
      brainMemoryId: memory.id,
      scope: memory.scope,
      ownerType: memory.ownerType,
      ownerId: memory.ownerId,
      supersedes: memory.supersedes ?? [],
    },
    createdAt,
    updatedAt,
  } as InteractionMemory;
}

function interactionMemoryTypeToBrainMemoryType(memoryType: string) {
  return memoryType === "preference" ||
    memoryType === "plan" ||
    memoryType === "boundary" ||
    memoryType === "relationship" ||
    memoryType === "task" ||
    memoryType === "insight" ||
    memoryType === "system"
    ? memoryType
    : "fact";
}

function metadataString(
  metadata: Record<string, unknown>,
  key: string,
  fallback: string,
) {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

async function listBrainInteractionMemories(input: {
  userId: string;
  limit: number;
  statuses?: string[];
}) {
  const statuses = interactionStatusesToBrainStatuses(input.statuses);
  if (statuses.length === 0) return [];
  const memories = await listBrainMemory({
    userId: input.userId,
    limit: input.limit,
    statuses,
    ownerType: "chat",
    ownerId: input.userId,
  });
  return memories.map(brainMemoryToInteractionMemory);
}

export async function createInteractionBrainMemory(input: {
  userId: string;
  memoryType: string;
  subject: string;
  content: string;
  status?: string;
  confidence?: number;
  tags?: string[];
  sourceEventIds: string[];
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
}) {
  const sourceEventIds = await assertSourceEventsBelongToUser(
    input.userId,
    input.sourceEventIds,
  );
  const status =
    input.status === "confirmed" && sourceEventIds.length > 0
      ? "active"
      : "candidate";
  const metadata = input.metadata ?? {};
  const facets = {
    sourceKind: "wechat",
    domain: "owner_context",
    writePath: "interaction_wiki_api",
    layer: metadataString(metadata, "layer", "L3"),
    atomType: metadataString(metadata, "atomType", ""),
    privacyClass: metadataString(metadata, "privacyClass", "normal"),
    riskLevel: metadataString(metadata, "riskLevel", "low"),
    ...buildInteractionScenarioApplicabilityFacets(metadata.scenarioHints),
  } satisfies BrainMemoryFacets;
  const canonicalKind = interactionMemoryCanonicalKind(input.memoryType);
  const derivedRefs = sourceEventIds.map((id) => ({
    source: "interaction_event",
    id,
    relation: "derived_from",
  }));
  const memory =
    status === "candidate"
      ? await createBrainMemoryCandidate({
          requester: {
            type: "chat",
            userId: input.userId,
            id: "interaction-wiki-api",
          },
          scope: { type: "global" },
          ownerType: "chat",
          ownerId: input.userId,
          memoryType: interactionMemoryTypeToBrainMemoryType(input.memoryType),
          subject: input.subject,
          content: input.content,
          confidence: input.confidence,
          evidenceRefs: sourceEventIds,
          tags: input.tags,
          expiresAt: input.expiresAt?.toISOString(),
          canonicalKind,
          facets,
          derivedRefs,
          metadata: {
            ...metadata,
            sourceKind: "wechat",
            layer: metadata.layer ?? "L3",
          },
        })
      : await writeBrainMemory({
          requester: {
            type: "chat",
            userId: input.userId,
            id: "interaction-wiki-api",
          },
          scope: { type: "global" },
          ownerType: "chat",
          ownerId: input.userId,
          memoryType: interactionMemoryTypeToBrainMemoryType(input.memoryType),
          subject: input.subject,
          content: input.content,
          status,
          confidence: input.confidence,
          evidenceRefs: sourceEventIds,
          tags: input.tags,
          expiresAt: input.expiresAt?.toISOString(),
          canonicalKind,
          facets,
          derivedRefs,
          metadata: {
            ...metadata,
            sourceKind: "wechat",
            layer: metadata.layer ?? "L3",
          },
        });
  return brainMemoryToInteractionMemory(memory);
}

function interactionMemoryCanonicalKind(
  memoryType: string,
): BrainCanonicalKind | undefined {
  switch (memoryType) {
    case "preference":
      return "preference";
    case "relationship":
    case "person":
      return "profile";
    case "commitment":
      return "commitment";
    case "boundary":
      return "boundary";
    case "mistake":
      return "lesson";
    case "routine":
    case "project":
      return "fact";
    default:
      return undefined;
  }
}

async function dismissBrainInteractionMemories(input: {
  userId: string;
  reason: string;
  memoryIds?: string[];
  preserveIds?: Set<string>;
  legacyMemories?: InteractionMemory[];
}, store: DrizzleDB) {
  const legacy = new Map((input.legacyMemories ?? []).map(memory => [memory.id, memory]));
  const preserved = new Set([...(input.preserveIds ?? [])].map(interactionMemorySourceId));
  const targets = new Map<string, { memory: BrainMemory; standalone: boolean }>();
  const add = async (id: string, source?: InteractionMemory) => {
    const sourceId = interactionMemorySourceId(id);
    if (preserved.has(sourceId)) return;
    const memory = await requireInteractionMemoryTarget(store, input.userId, sourceId, source, { verifySources: false });
    if (preserved.has(memory.id) || getBrainMemoryCanonicalMetadata(memory).derivedRefs.some(ref =>
      ref.source === "interaction_memory" && preserved.has(ref.id))) return;
    targets.set(memory.id, { memory, standalone: !source });
  };
  if (input.memoryIds?.length) {
    for (const id of input.memoryIds) await add(id, legacy.get(interactionMemorySourceId(id)));
  } else {
    for (const source of [...legacy.values()].sort((a, b) => a.id.localeCompare(b.id))) await add(source.id, source);
    for (const memory of await listInteractionCleanupCandidates(store, input.userId)) {
      if (targets.has(memory.id) || preserved.has(memory.id)) continue;
      const canonical = getBrainMemoryCanonicalMetadata(memory);
      if (canonical.derivedRefs.some(ref => ref.source === "interaction_memory" && preserved.has(ref.id))) continue;
      const related = canonical.derivedRefs.some(ref => ref.source === "interaction_event" || ref.source === "interaction_memory")
        || ["wechat", "interaction_memory"].includes(String(canonical.facets.sourceKind));
      // A generic owner Brain memory is outside the interaction cleanup surface.
      if (related) await add(memory.id, legacy.get(memory.id));
    }
  }
  const memories: BrainMemory[] = [];
  let standaloneCount = 0;
  for (const target of [...targets.values()].sort((a, b) => a.memory.id.localeCompare(b.memory.id))) {
    const reviewed = target.memory.status === "deleted" ? target.memory : await reviewBrainMemory({
      requester: { type: "chat", userId: input.userId, id: "interaction-memory-clear" },
      memoryId: target.memory.id, decision: "dismissed", reason: input.reason,
    });
    memories.push(reviewed);
    if (target.standalone && target.memory.status !== "deleted") standaloneCount++;
  }
  return { memories, standaloneCount };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRecordList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
  }
  return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function firstBoolean(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes"].includes(normalized)) return true;
      if (["false", "0", "no"].includes(normalized)) return false;
    }
  }
  return undefined;
}

function sessionsFromWechatPayload(payload: unknown): WechatSessionSummary[] {
  const record = asRecord(payload);
  const sessions: WechatSessionSummary[] = [];
  for (const session of asRecordList(
    record.sessions ?? record.results ?? record.items ?? record.data ?? payload,
  )) {
    const username = firstString(session, [
      "username",
      "chatId",
      "conversationId",
      "chat",
    ]);
    if (!username) continue;
    sessions.push({
      username,
      chat: firstString(session, ["chat", "display", "displayName", "name"]),
      chatType: firstString(session, [
        "chat_type",
        "chatType",
        "conversationType",
      ]),
      isGroup: firstBoolean(session, ["is_group", "isGroup"]),
      timestamp: firstNumber(session, ["timestamp", "last_timestamp"]),
      raw: session,
    });
  }
  return sessions.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

function formatWechatLocalTime(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${[
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join(
    "-",
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function canFetchWechatHistory(session: WechatSessionSummary) {
  const chatType = session.chatType?.toLowerCase();
  if (chatType === "folded") return false;
  if (session.username.startsWith("@placeholder")) return false;
  if (session.username.endsWith("sessionholder")) return false;
  return true;
}

async function filterWechatSessionsByPolicy(
  userId: string,
  sessions: WechatSessionSummary[],
) {
  const policies = await listInteractionSourcePolicies({
    userId,
    platform: "wechat",
  });
  const policyBySource = new Map(
    policies.map((policy) => [policy.sourceId, policy]),
  );
  const allowedPolicies = new Set(["sync", "summary", "mention_only"]);
  const hasExplicitAllow = policies.some(
    (policy) => policy.enabled && allowedPolicies.has(policy.policy),
  );

  const filtered = sessions.filter((session) => {
    const policy = policyBySource.get(session.username);
    if (policy?.policy === "ignore" || policy?.enabled === false) return false;
    if (hasExplicitAllow) {
      return Boolean(policy && allowedPolicies.has(policy.policy));
    }
    return true;
  });

  if (!hasExplicitAllow) {
    return filtered;
  }

  const sessionByUsername = new Map(
    filtered.map((session) => [session.username, session]),
  );
  for (const policy of policies) {
    if (
      !policy.enabled ||
      !allowedPolicies.has(policy.policy) ||
      sessionByUsername.has(policy.sourceId)
    ) {
      continue;
    }

    const sourceType = policy.sourceType || "unknown";
    sessionByUsername.set(policy.sourceId, {
      username: policy.sourceId,
      chat: policy.sourceName || policy.sourceId,
      chatType: sourceType,
      isGroup: sourceType === "group" || policy.sourceId.endsWith("@chatroom"),
      timestamp: policy.lastSeenAt?.getTime(),
      raw: {
        source: "interaction_source_policy",
        policy: policy.policy,
      },
    });
  }

  return [...sessionByUsername.values()].sort(
    (a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0),
  );
}

function enrichWechatHistoryPayload(
  payload: unknown,
  session: WechatSessionSummary,
) {
  const record = asRecord(payload);
  const messages = asRecordList(
    record.messages ?? record.results ?? record.items,
  ).map((message) => ({
    ...message,
    chat: firstString(record, ["chat"]) ?? session.chat ?? session.username,
    username: firstString(record, ["username"]) ?? session.username,
    chat_type:
      firstString(record, ["chat_type", "chatType"]) ??
      session.chatType ??
      message.chat_type,
    is_group:
      firstBoolean(record, ["is_group", "isGroup"]) ??
      session.isGroup ??
      message.is_group,
  }));
  return {
    ...record,
    chat: firstString(record, ["chat"]) ?? session.chat ?? session.username,
    username: firstString(record, ["username"]) ?? session.username,
    chat_type:
      firstString(record, ["chat_type", "chatType"]) ?? session.chatType,
    is_group: firstBoolean(record, ["is_group", "isGroup"]) ?? session.isGroup,
    messages,
  };
}

async function getStoredThreadLastMessageAt(
  userId: string,
  conversationId: string,
) {
  const rows = await db
    .select({ lastMessageAt: interactionThreads.lastMessageAt })
    .from(interactionThreads)
    .where(
      and(
        eq(interactionThreads.userId, userId),
        eq(interactionThreads.platform, "wechat"),
        eq(interactionThreads.conversationId, conversationId),
      ),
    )
    .limit(1);
  return rows[0]?.lastMessageAt instanceof Date
    ? rows[0].lastMessageAt
    : undefined;
}

function toDate(value: unknown, fallback = new Date(0)) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number" && Number.isFinite(value))
    return new Date(value);
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return fallback;
}

function compactBody(value: string, max = 800) {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}

function uniqueIds(ids: string[]) {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

async function assertSourceEventsBelongToUser(userId: string, ids: string[]) {
  const sourceEventIds = uniqueIds(ids);
  if (sourceEventIds.length === 0) {
    throw new Error("sourceEventIds are required");
  }
  const rows = await db
    .select({ id: interactionEvents.id })
    .from(interactionEvents)
    .where(
      and(
        eq(interactionEvents.userId, userId),
        inArray(interactionEvents.id, sourceEventIds),
      ),
    );
  if (rows.length !== sourceEventIds.length) {
    throw new Error("Some sourceEventIds are missing or not accessible");
  }
  return sourceEventIds;
}

function boundedLimit(value: number | undefined, fallback = 50, max = 200) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

function wechatHistoryConcurrency() {
  const parsed = Number(process.env.WECHAT_HISTORY_CONCURRENCY);
  if (!Number.isFinite(parsed)) return 3;
  return Math.min(Math.max(Math.trunc(parsed), 1), 6);
}

function isUniqueViolation(error: unknown) {
  const err = error as {
    code?: string;
    message?: string;
    cause?: { code?: string; message?: string; constraint_name?: string };
  };
  const code = err?.code ?? err?.cause?.code;
  const message = [
    err?.message,
    err?.cause?.message,
    err?.cause?.constraint_name,
  ]
    .filter(Boolean)
    .join(" ");
  return code === "23505" || /unique|constraint|duplicate/i.test(message);
}

async function findExistingEvent(input: InteractionEventInput) {
  const [existing] = await db
    .select()
    .from(interactionEvents)
    .where(
      and(
        eq(interactionEvents.userId, input.userId),
        eq(interactionEvents.platform, input.platform),
        eq(interactionEvents.dedupeKey, input.dedupeKey),
      ),
    )
    .limit(1);
  return existing ? normalizeEvent(existing as InteractionEvent) : null;
}

async function updateThreadForEvent(event: InteractionEvent, isNew: boolean) {
  const conversationId = event.conversationId ?? event.conversationName;
  const [existing] = await db
    .select()
    .from(interactionThreads)
    .where(
      and(
        eq(interactionThreads.userId, event.userId),
        eq(interactionThreads.platform, event.platform),
        eq(interactionThreads.conversationId, conversationId),
      ),
    )
    .limit(1);

  const now = new Date();
  const incrementUnread =
    isNew && event.direction !== "outbound" && event.processedStatus === "new";
  const incrementPending =
    isNew && event.direction !== "outbound" && event.requiresReply === true;
  const nextUnreadCount =
    Number((existing as InteractionThread | undefined)?.unreadCount ?? 0) +
    (incrementUnread ? 1 : 0);
  const nextPendingReplyCount =
    Number(
      (existing as InteractionThread | undefined)?.pendingReplyCount ?? 0,
    ) + (incrementPending ? 1 : 0);
  const existingLastMessageAt = toDate(
    (existing as InteractionThread | undefined)?.lastMessageAt,
  );
  const eventMessageAt = toDate(event.messageTime, now);
  const shouldReplaceLast =
    !existing || eventMessageAt >= existingLastMessageAt;

  const values = {
    userId: event.userId,
    platform: event.platform,
    conversationId,
    conversationName: event.conversationName,
    conversationType: event.conversationType,
    lastMessageAt: shouldReplaceLast
      ? eventMessageAt
      : (existing as InteractionThread).lastMessageAt,
    lastCollectedAt: event.collectedAt,
    unreadCount: nextUnreadCount,
    pendingReplyCount: nextPendingReplyCount,
    lastEventId: shouldReplaceLast
      ? event.id
      : (existing as InteractionThread | undefined)?.lastEventId,
    summary: shouldReplaceLast ? compactBody(event.contentPreview) : undefined,
    metadata: toDbJson({
      latestSenderName: event.senderDisplayName ?? event.senderName,
      latestContentType: event.contentType,
      source: event.source,
    }),
    updatedAt: now,
  } as any;

  if (!existing) {
    try {
      await db
        .insert(interactionThreads)
        .values({
          ...values,
          id: randomUUID(),
          createdAt: now,
          summary: compactBody(event.contentPreview),
        })
        .returning();
      return;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  const updateValues = Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );
  await db
    .update(interactionThreads)
    .set(updateValues)
    .where(
      and(
        eq(interactionThreads.userId, event.userId),
        eq(interactionThreads.platform, event.platform),
        eq(interactionThreads.conversationId, conversationId),
      ),
    );
}

export async function upsertInteractionEvents(input: {
  userId: string;
  messages: NormalizedWechatMessage[];
}): Promise<
  Pick<
    RecordWechatMessagesResult,
    | "insertedCount"
    | "duplicateCount"
    | "eventCount"
    | "events"
    | "insertedEvents"
    | "duplicateEvents"
  >
> {
  const now = new Date();
  const events: InteractionEvent[] = [];
  const insertedEvents: InteractionEvent[] = [];
  const duplicateEvents: InteractionEvent[] = [];
  let insertedCount = 0;
  let duplicateCount = 0;
  const entries = input.messages.map((message) => {
    const eventInput: InteractionEventInput = {
      ...message,
      userId: input.userId,
      processedStatus: "new",
      importance: "unknown",
    };
    const values: InsertInteractionEvent = {
      id: randomUUID(),
      userId: eventInput.userId,
      platform: eventInput.platform,
      source: eventInput.source,
      conversationId: eventInput.conversationId,
      conversationName: eventInput.conversationName,
      conversationType: eventInput.conversationType,
      senderId: eventInput.senderId,
      senderName: eventInput.senderName,
      senderDisplayName: eventInput.senderDisplayName,
      direction: eventInput.direction,
      contentType: eventInput.contentType,
      content: eventInput.content,
      contentPreview: eventInput.contentPreview,
      messageTime: eventInput.messageTime,
      collectedAt: eventInput.collectedAt,
      sourceMessageId: eventInput.sourceMessageId,
      sourceSequence: eventInput.sourceSequence,
      sourceRaw: toDbJson(eventInput.sourceRaw),
      dedupeKey: eventInput.dedupeKey,
      processedStatus: eventInput.processedStatus,
      importance: eventInput.importance,
      requiresReply: eventInput.requiresReply,
      createdAt: now,
      updatedAt: now,
    } as any;

    return { eventInput, values };
  });
  const createdById = new Map<string, InteractionEvent>();
  const writeChunkSize = 50;
  for (let index = 0; index < entries.length; index += writeChunkSize) {
    const created = await db
      .insert(interactionEvents)
      .values(
        entries
          .slice(index, index + writeChunkSize)
          .map((entry) => entry.values),
      )
      .onConflictDoNothing()
      .returning();
    for (const event of created) {
      const normalized = normalizeEvent(event as InteractionEvent);
      createdById.set(normalized.id, normalized);
    }
  }

  const storedByKey = new Map<string, InteractionEvent>();
  const dedupeKeys = [
    ...new Set(entries.map((entry) => entry.eventInput.dedupeKey)),
  ];
  for (let index = 0; index < dedupeKeys.length; index += 100) {
    const stored = await db
      .select()
      .from(interactionEvents)
      .where(
        and(
          eq(interactionEvents.userId, input.userId),
          inArray(
            interactionEvents.dedupeKey,
            dedupeKeys.slice(index, index + 100),
          ),
        ),
      );
    for (const event of stored) {
      const normalized = normalizeEvent(event as InteractionEvent);
      storedByKey.set(
        `${normalized.platform}\0${normalized.dedupeKey}`,
        normalized,
      );
    }
  }

  const countedInsertedIds = new Set<string>();
  for (const entry of entries) {
    const created = createdById.get(entry.values.id as string);
    const event =
      created ??
      storedByKey.get(
        `${entry.eventInput.platform}\0${entry.eventInput.dedupeKey}`,
      );
    if (!event) {
      throw new Error("Interaction event was not persisted");
    }
    if (created && !countedInsertedIds.has(created.id)) {
      countedInsertedIds.add(created.id);
      insertedCount += 1;
      insertedEvents.push(event);
      await updateThreadForEvent(event, true);
    } else {
      duplicateCount += 1;
      duplicateEvents.push(event);
      await updateThreadForEvent(event, false);
    }
    events.push(event);
  }

  for (const event of insertedEvents) {
    try {
      await createBrainObservation({
        userId: input.userId,
        sourceType: "interaction_event",
        sourceId: event.id,
        sourceEventId: event.id,
        observedAt: event.messageTime,
        content: event.content,
        metadata: {
          platform: event.platform,
          source: event.source,
          conversationId: event.conversationId,
          conversationName: event.conversationName,
          conversationType: event.conversationType,
          senderName: event.senderName,
          direction: event.direction,
          contentType: event.contentType,
          dedupeKey: event.dedupeKey,
        },
      });
    } catch (error) {
      console.warn("[Interactions] Brain observation write failed", {
        userId: input.userId,
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    insertedCount,
    duplicateCount,
    eventCount: events.length,
    events,
    insertedEvents,
    duplicateEvents,
  };
}

export async function recordWechatNewMessages(input: {
  userId: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<RecordWechatMessagesResult> {
  input.signal?.throwIfAborted();
  const limit = boundedLimit(input.limit, 50, 1000);
  const sessionsPayload = await getWechatLocalSessions({
    limit: Math.min(Math.max(limit, 10), 50),
    withMeta: true,
    signal: input.signal,
  });
  const sessions = await filterWechatSessionsByPolicy(
    input.userId,
    sessionsFromWechatPayload(sessionsPayload).filter(canFetchWechatHistory),
  );
  const histories: unknown[] = [];
  const messages: NormalizedWechatMessage[] = [];
  const sourceMessageCounts = new Map<
    string,
    { sourceId: string; sourceName: string; messageCount: number; warning?:string }
  >();
  const sessionLimit = Math.min(
    sessions.length,
    Math.min(Math.max(limit, 10), 30),
  );
  const perSessionLimit = Math.min(
    Math.max(Math.ceil(limit / Math.max(sessionLimit, 1)) * 2, 5),
    30,
  );

  const historyLimit = pLimit(wechatHistoryConcurrency());
  const sessionHistories = await Promise.allSettled(
    sessions.slice(0, sessionLimit).map((session) =>
      historyLimit(async () => {
        input.signal?.throwIfAborted();
        const source = {
          sourceId: session.username,
          sourceName: session.chat ?? session.username,
          messageCount: 0,
        };
        try {
          const lastStoredAt = await getStoredThreadLastMessageAt(
            input.userId,
            session.username,
          );
          input.signal?.throwIfAborted();
          const historyPayload = await getWechatLocalHistory(session.username, {
            limit: perSessionLimit,
            since: lastStoredAt
              ? formatWechatLocalTime(lastStoredAt)
              : undefined,
            withMeta: true,
            signal: input.signal,
          });
          const enrichedPayload = enrichWechatHistoryPayload(
            historyPayload,
            session,
          );
          const normalizedMessages =
            normalizeWechatLocalPayload(enrichedPayload);
          return {
            source: { ...source, messageCount: normalizedMessages.length },
            enrichedPayload,
            normalizedMessages,
          };
        } catch {
          return { source:{...source,warning:'wechat_history_unavailable'}, enrichedPayload: null, normalizedMessages: [] };
        }
      }),
    ),
  );

  input.signal?.throwIfAborted();
  for (const settled of sessionHistories) {
    if(settled.status==='rejected')throw settled.reason;
    const history=settled.value;
    sourceMessageCounts.set(history.source.sourceId, history.source);
    if (history.enrichedPayload) histories.push(history.enrichedPayload);
    messages.push(...history.normalizedMessages);
  }

  messages.sort((a, b) => a.messageTime.getTime() - b.messageTime.getTime());
  const result = await upsertInteractionEvents({
    userId: input.userId,
    messages,
  });
  const countEventsByConversation = (events: InteractionEvent[]) =>
    events.reduce<Record<string, number>>((acc, event) => {
      const key = event.conversationId ?? event.conversationName;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
  const insertedBySource = countEventsByConversation(result.insertedEvents);
  const duplicateBySource = countEventsByConversation(result.duplicateEvents);
  const eventsBySource = countEventsByConversation(result.events);
  const sourceResults = [...sourceMessageCounts.values()].map((source) => ({
    ...source,
    insertedCount: insertedBySource[source.sourceId] ?? 0,
    duplicateCount: duplicateBySource[source.sourceId] ?? 0,
    eventCount: eventsBySource[source.sourceId] ?? 0,
  }));
  return {
    ...result,
    sourceResults,
    rawPayload: {
      mode: "recent_sessions_history",
      sessions: sessionsPayload,
      histories,
    },
  };
}

export async function listInteractionEvents(input: {
  userId: string;
  platform?: string;
  conversationId?: string;
  statuses?: InteractionEventStatus[];
  since?: Date;
  until?: Date;
  limit?: number;
}) {
  const conditions = [eq(interactionEvents.userId, input.userId)];
  if (input.platform)
    conditions.push(eq(interactionEvents.platform, input.platform));
  if (input.conversationId) {
    conditions.push(eq(interactionEvents.conversationId, input.conversationId));
  }
  if (input.statuses?.length) {
    conditions.push(inArray(interactionEvents.processedStatus, input.statuses));
  }
  if (input.since)
    conditions.push(gte(interactionEvents.messageTime, input.since));
  if (input.until)
    conditions.push(lte(interactionEvents.messageTime, input.until));

  const rows = await db
    .select()
    .from(interactionEvents)
    .where(and(...conditions))
    .orderBy(desc(interactionEvents.messageTime))
    .limit(boundedLimit(input.limit));
  return (rows as InteractionEvent[]).map((row: InteractionEvent) =>
    normalizeEvent(row),
  );
}

export async function getInteractionEventsByIds(input: {
  userId: string;
  ids: string[];
}) {
  const ids = uniqueIds(input.ids).slice(0, 200);
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(interactionEvents)
    .where(
      and(
        eq(interactionEvents.userId, input.userId),
        inArray(interactionEvents.id, ids),
      ),
    )
    .orderBy(interactionEvents.messageTime);
  return (rows as InteractionEvent[]).map((row: InteractionEvent) =>
    normalizeEvent(row),
  );
}

export async function listInteractionThreads(input: {
  userId: string;
  platform?: string;
  limit?: number;
}) {
  const conditions = [eq(interactionThreads.userId, input.userId)];
  if (input.platform) {
    conditions.push(eq(interactionThreads.platform, input.platform));
  }
  const rows = await db
    .select()
    .from(interactionThreads)
    .where(and(...conditions))
    .orderBy(desc(interactionThreads.lastMessageAt))
    .limit(boundedLimit(input.limit));
  return (rows as InteractionThread[]).map((row: InteractionThread) => ({
    ...row,
    metadata: parseJsonObject((row as any).metadata),
  })) as InteractionThread[];
}

export async function markInteractionEventsProcessed(input: {
  userId: string;
  ids: string[];
  status: InteractionEventStatus;
}) {
  const ids = [
    ...new Set(input.ids.map((id) => id.trim()).filter(Boolean)),
  ].slice(0, 200);
  if (ids.length === 0) return { updatedCount: 0 };
  const rows = await db
    .update(interactionEvents)
    .set({
      processedStatus: input.status,
      updatedAt: new Date(),
    } as any)
    .where(
      and(
        eq(interactionEvents.userId, input.userId),
        inArray(interactionEvents.id, ids),
      ),
    )
    .returning({ id: interactionEvents.id });
  return { updatedCount: rows.length };
}

type DerivedMemoryBasis = {
  memoryDependencies?: Array<{ memoryId: string; expectedVersion: string }>;
  memoryRequester?: BrainRequester;
};

async function withInteractionDerivedWrite<T>(userId: string, write: (store: DrizzleDB) => Promise<T>): Promise<T> {
  const lease = resolveExecutionLease();
  if (!lease) return db.transaction(write);
  if (lease.userId !== userId) throw new ExecutionLeaseError("invalid_lease");
  return withExecutionBusinessWrite(lease, ({ db: store }) => write(store));
}

async function captureDerivedBasis(store: DrizzleDB, input: DerivedMemoryBasis & { userId: string }, kind: "wiki_note" | "interaction_task", id: string) {
  if (input.memoryDependencies === undefined) return;
  if (!input.memoryRequester || input.memoryRequester.userId !== input.userId) throw new Error("A server-owned memory requester is required");
  await captureMemoryDependenciesInTransaction(store, {
    requester: input.memoryRequester, entityKind: kind, entityId: id,
    sources: input.memoryDependencies, commandId: id,
    reason: "Explicit memory references captured when creating the derived artifact",
  });
}

export async function createInteractionNote(input: DerivedMemoryBasis & {
  userId: string;
  noteType: string;
  title: string;
  body: string;
  confidence?: number;
  model?: string | null;
  eventId?: string | null;
  threadId?: string | null;
  sourceEventIds: string[];
  metadata?: Record<string, unknown>;
}) {
  const sourceEventIds = await assertSourceEventsBelongToUser(
    input.userId,
    input.sourceEventIds,
  );
  const now = new Date();
  return withInteractionDerivedWrite(input.userId, async store => {
  const [created] = await store
    .insert(interactionNotes)
    .values({
      id: randomUUID(),
      userId: input.userId,
      eventId: input.eventId ?? sourceEventIds[0] ?? null,
      threadId: input.threadId ?? null,
      noteType: input.noteType,
      title: input.title,
      body: input.body,
      confidence: Math.min(
        Math.max(Math.trunc(input.confidence ?? 50), 0),
        100,
      ),
      model: input.model ?? null,
      sourceEventIds: toDbArray(sourceEventIds),
      metadata: toDbJson(input.metadata ?? {}),
      createdAt: now,
      updatedAt: now,
    } as InsertInteractionNote)
    .returning();
  await captureDerivedBasis(store, input, "wiki_note", created.id);
  return normalizeNote(created as InteractionNote);
  });
}

export async function createInteractionTask(input: DerivedMemoryBasis & {
  commandId?: string;
  userId: string;
  title: string;
  description?: string | null;
  status?: string;
  dueAt?: Date | null;
  assigneeName?: string | null;
  requesterName?: string | null;
  confidence?: number;
  eventId?: string | null;
  threadId?: string | null;
  sourceEventIds: string[];
  metadata?: Record<string, unknown>;
}) {
  const sourceEventIds = uniqueIds(input.sourceEventIds).sort();
  const commandId = input.commandId ?? randomUUID();
  validateTaskCommand(commandId);
  const status = input.status ?? "candidate";
  if (!["candidate", "confirmed", "done", "dismissed"].includes(status)) throw new TaskRecordInputError("Invalid initial task status");
  // Attempt number is execution telemetry; a saved processor plan keeps the
  // same creation intent when another attempt resumes it.
  const { processingAttempt: _attempt, taskActions: _untrustedHistory, taskState: _untrustedState, ...intentMetadata } = input.metadata ?? {};
  const command = { commandId, action: "create", requestHash: taskCommandHash({
    ...input, commandId, sourceEventIds, metadata: intentMetadata,
  }) };
  return withInteractionTaskTransaction(input.userId, async store => {
  await lockTaskCommand(store, input.userId, commandId);
  const replay = await replayTaskCommand(store, input.userId, command);
  if (replay) {
    const current = await readTaskInTransaction(store, input.userId, replay.task.id);
    if (!current) throw new Error("Created task is no longer available");
    return normalizeTask(current);
  }
  await assertTaskSources(store, { ...input, sourceEventIds });
  const now = new Date();
  const initialState = taskState({ status, title: input.title, dueAt: input.dueAt ?? null, metadata: {}, revision: 0 });
  const result = await insertTaskRecord(store, {
      id: randomUUID(),
      userId: input.userId,
      eventId: input.eventId ?? sourceEventIds[0] ?? null,
      threadId: input.threadId ?? null,
      title: input.title,
      description: input.description ?? null,
      status,
      revision: 0,
      dueAt: input.dueAt ?? null,
      assigneeName: input.assigneeName ?? null,
      requesterName: input.requesterName ?? null,
      sourceEventIds: toDbArray(sourceEventIds),
      confidence: Math.min(
        Math.max(Math.trunc(input.confidence ?? 50), 0),
        100,
      ),
      metadata: toDbJson({ ...intentMetadata, ...(input.metadata?.processingAttempt !== undefined ? { processingAttempt: input.metadata.processingAttempt } : {}), taskState: initialState }),
      createdAt: now,
      updatedAt: now,
    } as InsertInteractionTask, command);
  const created = result.task;
  await captureDerivedBasis(store, input, "interaction_task", created.id);
  await projectInteractionTaskScenariosInTransaction(store, created, now);
  return normalizeTask(created as InteractionTask);
  });
}

export async function createInteractionMemoryCandidate(input: {
  userId: string;
  memoryType: string;
  subject: string;
  content: string;
  status?: string;
  confidence?: number;
  tags?: string[];
  sourceEventIds: string[];
  lastVerifiedAt?: Date | null;
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
}) {
  return withInteractionMemoryCommand(input.userId, async store => {
  const sourceEventIds = await assertInteractionMemorySources(store, input.userId, input.sourceEventIds);
  const now = new Date(), id = randomUUID();
  const alias = `${INTERACTION_MEMORY_ALIAS_PREFIX}${id}`;
  const [created] = await store
    .insert(interactionMemories)
    .values({
      id,
      userId: input.userId,
      memoryType: input.memoryType,
      subject: input.subject,
      content: input.content,
      status: "candidate",
      confidence: Math.min(
        Math.max(Math.trunc(input.confidence ?? 50), 0),
        100,
      ),
      tags: toDbArray(input.tags ?? []),
      sourceEventIds: toDbArray(sourceEventIds),
      lastVerifiedAt: input.lastVerifiedAt ?? null,
      expiresAt: input.expiresAt ?? null,
      metadata: toDbJson({ ...input.metadata, brainMemoryId: id, brainMemoryAlias: alias }),
      createdAt: now,
      updatedAt: now,
    } as InsertInteractionMemory)
    .returning();
  const memory = normalizeMemory(created as InteractionMemory);
  const canonical = await createBrainMemoryCandidate({
      requester: {
        type: "chat",
        userId: input.userId,
        id: "interaction-memory-candidate",
      },
      scope: { type: "global" },
      ownerType: "chat",
      ownerId: input.userId,
      memoryType:
        input.memoryType === "preference" ||
        input.memoryType === "plan" ||
        input.memoryType === "boundary" ||
        input.memoryType === "relationship" ||
        input.memoryType === "task" ||
        input.memoryType === "insight" ||
        input.memoryType === "system"
          ? input.memoryType
          : "fact",
      subject: memory.subject,
      content: memory.content,
      confidence: memory.confidence,
      evidenceRefs: memory.sourceEventIds as string[],
      tags: memory.tags as string[],
      id: memory.id,
      canonicalGroupId: alias,
      expiresAt: input.expiresAt?.toISOString(),
      now,
      facets: {
        sourceKind: "interaction_memory",
        domain: "owner_context",
        writePath: "legacy_interaction_memory_candidate",
        ...buildInteractionScenarioApplicabilityFacets(input.metadata?.scenarioHints),
      },
      metadata: { ...input.metadata, legacyMemoryId: memory.id, legacyAlias: alias, requestedStatus: input.status ?? "candidate" },
      derivedRefs: [
        {
          source: "interaction_memory",
          id: memory.id,
          relation: "mirrors",
        },
      ],
    });
  if (canonical.id !== memory.id || canonical.status !== "candidate") throw new Error("Interaction candidate admission did not retain the exact pending mirror");
  return memory;
  });
}

export async function listInteractionWiki(input: {
  userId: string;
  limit?: number;
  statuses?: string[];
}): Promise<InteractionWikiSnapshot> {
  const limit = boundedLimit(input.limit);
  const taskConditions = [eq(interactionTasks.userId, input.userId)];
  const memoryConditions = [eq(interactionMemories.userId, input.userId)];
  if (input.statuses?.length) {
    taskConditions.push(inArray(interactionTasks.status, input.statuses));
    memoryConditions.push(inArray(interactionMemories.status, input.statuses));
  }

  const preferBrain = shouldPreferBrainMemory();
  const allowLegacyFallback = shouldReadLegacyMemoryFallback();
  const [notes, tasks, brainMemories, legacyMemories] = await Promise.all([
    db
      .select()
      .from(interactionNotes)
      .where(eq(interactionNotes.userId, input.userId))
      .orderBy(desc(interactionNotes.createdAt))
      .limit(limit),
    db
      .select()
      .from(interactionTasks)
      .where(and(...taskConditions))
      .orderBy(desc(interactionTasks.createdAt))
      .limit(limit),
    preferBrain
      ? listBrainInteractionMemories({
          userId: input.userId,
          limit,
          statuses: input.statuses,
        })
      : Promise.resolve([]),
    allowLegacyFallback
      ? db
          .select()
          .from(interactionMemories)
          .where(and(...memoryConditions))
          .orderBy(desc(interactionMemories.createdAt))
          .limit(limit)
      : Promise.resolve([]),
  ]);

  const includeDeleted = input.statuses?.includes("deleted") ?? false;

  return {
    notes: (notes as InteractionNote[])
      .map((note) => normalizeNote(note))
      .filter(
        (note) =>
          includeDeleted ||
          typeof asRecord(note.metadata).deletedAt !== "string",
      ),
    tasks: (tasks as InteractionTask[])
      .map((task) => normalizeTask(task))
      .filter((task) => includeDeleted || task.status !== "deleted"),
    memories: (preferBrain && brainMemories.length > 0
      ? brainMemories
      : (legacyMemories as InteractionMemory[]).map((memory) =>
          normalizeMemory(memory),
        )
    )
      .filter((memory) => includeDeleted || memory.status !== "deleted"),
  };
}

async function interactionCleanupRows(store: DrizzleDB, table: typeof interactionNotes | typeof interactionTasks | typeof interactionMemories, userId: string) {
  const query = store.select().from(table).where(eq(table.userId, userId)).orderBy(table.id);
  return await (typeof query.for === "function" ? query.for("update") : query) as Array<InteractionNote | InteractionTask | InteractionMemory>;
}

async function deleteInteractionRows(store: DrizzleDB, table: typeof interactionNotes | typeof interactionTasks | typeof interactionMemories,
  rows: Array<InteractionNote | InteractionTask | InteractionMemory>, userId: string, now: Date, reason: string, clearScope?: string) {
  const results: Array<InteractionNote | InteractionTask | InteractionMemory> = [];
  for (const row of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
    if (row.userId !== userId) throw new Error("Interaction cleanup ownership mismatch");
    if (table === interactionTasks) {
      const result = await transitionInteractionTaskInTransaction(store, { userId, id: row.id,
        commandId: randomUUID(), action: "delete", expectedVersion: (row as InteractionTask).revision, reason, clearScope });
      results.push(result.task);
      continue;
    }
    const [updated] = await store.update(table).set({
      ...(table === interactionNotes ? {} : { status: "deleted" }),
      metadata: toDbJson({ ...parseJsonObject(row.metadata), ...("status" in row ? { previousStatus: row.status } : {}),
        deletedAt: now.toISOString(), deletedReason: reason, deletedBy: "user", ...(clearScope ? { clearScope } : {}) }),
      updatedAt: now,
    }).where(and(eq(table.userId, userId), eq(table.id, row.id))).returning();
    if (!updated) throw new Error("Interaction cleanup target changed");
    results.push(updated);
  }
  return results;
}

export async function deleteInteractionWikiItem(input: {
  userId: string; kind: InteractionWikiItemKind; id: string; reason?: string | null; commandId?: string; expectedVersion?: number;
}) {
  if (input.kind === "task") return withInteractionTaskTransaction(input.userId, async store => {
    const result = await transitionInteractionTaskInTransaction(store, { userId: input.userId, id: input.id,
      commandId: input.commandId ?? randomUUID(), expectedVersion: input.expectedVersion, action: "delete", reason: input.reason?.trim() || "user_deleted" });
    return { task: normalizeTask(await readTaskInTransaction(store, input.userId, input.id) ?? result.task) };
  });
  return withInteractionMemoryCommand(input.userId, async store => {
    const now = new Date(), reason = input.reason?.trim() || "user_deleted";
    const table = input.kind === "note" ? interactionNotes : input.kind === "task" ? interactionTasks : interactionMemories;
    const id = input.kind === "memory" ? interactionMemorySourceId(input.id) : input.id;
    const query = store.select().from(table).where(and(eq(table.userId, input.userId), eq(table.id, id)));
    const [existing] = await (typeof query.for === "function" ? query.for("update") : query);
    if (existing && (existing.userId !== input.userId || existing.id !== id)) throw new Error("Interaction cleanup ownership mismatch");
    if (input.kind === "memory") {
      const dismissed = await dismissBrainInteractionMemories({ userId: input.userId, reason, memoryIds: [id],
        legacyMemories: existing ? [existing as InteractionMemory] : [] }, store);
      if (!existing) return { memory: brainMemoryToInteractionMemory(dismissed.memories[0]) };
    } else if (!existing) throw new Error("Interaction " + input.kind + " not found");
    const [updated] = await deleteInteractionRows(store, table, [existing], input.userId, now, reason);
    if (input.kind === "note") return { note: normalizeNote(updated as InteractionNote) };
    if (input.kind === "task") return { task: normalizeTask(updated as InteractionTask) };
    return { memory: normalizeMemory(updated as InteractionMemory) };
  });
}

export async function clearInteractionMemories(input: { userId: string; reason?: string | null }) {
  return withInteractionMemoryCommand(input.userId, async store => {
    const now = new Date(), reason = input.reason?.trim() || "user_cleared_memories";
    const memories = (await interactionCleanupRows(store, interactionMemories, input.userId))
      .filter(memory => memory.userId === input.userId && ["candidate", "confirmed", "dismissed", "archived"].includes((memory as InteractionMemory).status)) as InteractionMemory[];
    const dismissed = await dismissBrainInteractionMemories({ userId: input.userId, reason, legacyMemories: memories }, store);
    await deleteInteractionRows(store, interactionMemories, memories, input.userId, now, reason, "interaction_memories");
    return { deletedCount: memories.length + dismissed.standaloneCount };
  });
}

export async function clearInteractionWikiItems(input: {
  userId: string; reason?: string | null;
  preserve?: { noteIds?: string[]; taskIds?: string[]; memoryIds?: string[] };
}) {
  return withInteractionMemoryCommand(input.userId, async store => {
    const now = new Date(), reason = input.reason?.trim() || "user_cleared_wiki_items";
    const preservedNotes = new Set(uniqueIds(input.preserve?.noteIds ?? []));
    const preservedTasks = new Set(uniqueIds(input.preserve?.taskIds ?? []));
    const preservedMemories = new Set(uniqueIds(input.preserve?.memoryIds ?? []).map(interactionMemorySourceId));
    const notes = (await interactionCleanupRows(store, interactionNotes, input.userId)).filter(note =>
      note.userId === input.userId && typeof parseJsonObject(note.metadata).deletedAt !== "string" && !preservedNotes.has(note.id)) as InteractionNote[];
    const tasks = (await interactionCleanupRows(store, interactionTasks, input.userId)).filter(task =>
      task.userId === input.userId && ["candidate", "confirmed", "done", "dismissed"].includes((task as InteractionTask).status) && !preservedTasks.has(task.id)) as InteractionTask[];
    const memories = (await interactionCleanupRows(store, interactionMemories, input.userId)).filter(memory =>
      memory.userId === input.userId && ["candidate", "confirmed", "dismissed", "archived"].includes((memory as InteractionMemory).status) && !preservedMemories.has(memory.id)) as InteractionMemory[];
    const dismissed = await dismissBrainInteractionMemories({ userId: input.userId, reason, legacyMemories: memories, preserveIds: preservedMemories }, store);
    await deleteInteractionRows(store, interactionNotes, notes, input.userId, now, reason, "interaction_wiki");
    await deleteInteractionRows(store, interactionTasks, tasks, input.userId, now, reason, "interaction_wiki");
    await deleteInteractionRows(store, interactionMemories, memories, input.userId, now, reason, "interaction_wiki");
    const deletedMemories = memories.length + dismissed.standaloneCount;
    return { deletedNotes: notes.length, deletedTasks: tasks.length, deletedMemories,
      deletedCount: notes.length + tasks.length + deletedMemories };
  });
}

export async function updateInteractionTaskStatus(input: {
  userId: string;
  id: string;
  status: string;
  commandId?: string;
  expectedVersion?: number;
}) {
  return normalizeTask(await setInteractionTaskStatus(input));
}

export async function updateInteractionMemoryStatus(input: {
  userId: string;
  id: string;
  status: string;
}) {
  const id = interactionMemorySourceId(input.id);
  if (!["candidate", "confirmed", "dismissed", "archived", "deleted"].includes(input.status)) throw new Error("Unsupported interaction memory review status");
  return withInteractionMemoryCommand(input.userId, async store => {
  const now = new Date();
  const patch: Partial<InsertInteractionMemory> = {
    status: input.status,
    updatedAt: now,
  };
  if (input.status === "confirmed") {
    patch.lastVerifiedAt = now;
  }

  const query = store.select().from(interactionMemories)
    .where(and(eq(interactionMemories.userId, input.userId), eq(interactionMemories.id, id)));
  const [existing] = await (typeof query.for === "function" ? query.for("update") : query);
  const canonical = await requireInteractionMemoryTarget(store, input.userId, id, existing as InteractionMemory | undefined,
    { verifySources: input.status === "confirmed" });
  if (input.status === "candidate" && canonical.status !== "candidate") {
    throw new Error("An effective or retired memory requires its versioned revision workflow before returning to review");
  }
  const reviewed = input.status === "candidate" ? canonical : await reviewBrainMemory({
    requester: { type: "chat", userId: input.userId, id: "interaction-memory-status" },
    memoryId: canonical.id, decision: input.status === "confirmed" ? "confirmed"
      : input.status === "archived" && ["active", "verified", "weakened"].includes(canonical.status) ? "weakened" : "dismissed",
    reason: `interaction_memory_status:${input.status}`, now,
  });
  if (!existing) return brainMemoryToInteractionMemory(reviewed);
  const [updated] = await store.update(interactionMemories).set(patch)
    .where(and(eq(interactionMemories.userId, input.userId), eq(interactionMemories.id, id))).returning();
  if (!updated) throw new Error("Interaction memory not found");
  const memory = normalizeMemory(updated as InteractionMemory);
  // The canonical review has already committed with this projection. Callers
  // must not attempt a second, legacy-prefixed Brain upsert after this command.
  return { ...memory, metadata: { ...parseJsonObject(memory.metadata), source: "brain", brainMemoryId: reviewed.id,
    brainReviewApplied: input.status !== "candidate" } } as InteractionMemory;
  });
}

export async function promoteInteractionMemoryCandidates(input: {
  userId: string;
  limit?: number;
  dryRun?: boolean;
}): Promise<PromoteInteractionMemoryCandidatesResult> {
  return withInteractionMemoryCommand(input.userId, async store => {
  const limit = boundedLimit(input.limit, 100, 500);
  const query = store
    .select()
    .from(interactionMemories)
    .where(
      and(
        eq(interactionMemories.userId, input.userId),
        eq(interactionMemories.status, "candidate"),
      ),
    )
    .orderBy(desc(interactionMemories.updatedAt))
    .limit(limit);
  const rows = await (typeof query.for === "function" ? query.for("update") : query);

  const candidates = (rows as InteractionMemory[]).map((row) =>
    normalizeMemory(row),
  );
  const promoted: InteractionMemory[] = [];
  const retained: PromoteInteractionMemoryCandidatesResult["retained"] = [];
  const now = new Date();

  for (const candidate of candidates) {
    const decision = evaluateInteractionMemoryPromotion({
      id: candidate.id,
      memoryType: candidate.memoryType,
      subject: candidate.subject,
      content: candidate.content,
      status: candidate.status,
      confidence: candidate.confidence,
      tags: candidate.tags as string[],
      sourceEventIds: candidate.sourceEventIds as string[],
      expiresAt: candidate.expiresAt,
      metadata: candidate.metadata,
    });

    if (decision.decision !== "promote") {
      retained.push({
        id: candidate.id,
        subject: candidate.subject,
        memoryType: candidate.memoryType,
        confidence: candidate.confidence ?? null,
        decision,
      });
      continue;
    }

    if (input.dryRun) {
      promoted.push(candidate);
      continue;
    }

    const canonical = await requireInteractionMemoryTarget(store, input.userId, candidate.id, candidate);
    await reviewBrainMemory({
      requester: { type: "chat", userId: input.userId, id: "interaction-memory-auto-promotion" },
      memoryId: canonical.id, decision: "confirmed", reason: decision.reasons.join("; "), now,
    });
    const [updated] = await store
      .update(interactionMemories)
      .set({
        status: "confirmed",
        lastVerifiedAt: now,
        metadata: toDbJson({
          ...asRecord(candidate.metadata),
          autoPromotion: {
            policyVersion: INTERACTION_MEMORY_AUTO_PROMOTION_POLICY_VERSION,
            promotedAt: now.toISOString(),
            reasons: decision.reasons,
            riskLevel: decision.riskLevel,
          },
        }),
        updatedAt: now,
      } as Partial<InsertInteractionMemory>)
      .where(
        and(
          eq(interactionMemories.userId, input.userId),
          eq(interactionMemories.id, candidate.id),
          eq(interactionMemories.status, "candidate"),
        ),
      )
      .returning();

    if (updated) {
      const promotedMemory = normalizeMemory(updated as InteractionMemory);
      promoted.push(promotedMemory);
    } else throw new Error("Interaction memory candidate changed during promotion");
  }

  return {
    scanned: candidates.length,
    promotedCount: promoted.length,
    retainedCount: retained.length,
    promoted,
    retained,
  };
  });
}

function normalizeSearchText(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function searchTokens(query: string) {
  return query
    .split(/[\s,\uFF0C\u3002\uFF1B;\u3001|/\\()\[\]{}"'`]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function scoreInteractionMemory(query: string, memory: InteractionMemory) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;

  const haystack = normalizeSearchText(
    [
      memory.memoryType,
      memory.subject,
      memory.content,
      ...parseJsonArray<string>(memory.tags),
    ].join(" "),
  );
  if (!haystack) return 0;

  let score = haystack.includes(normalizedQuery) ? 0.55 : 0;
  const tokens = searchTokens(normalizedQuery);
  if (tokens.length > 0) {
    const hits = tokens.filter((token) => haystack.includes(token)).length;
    score += (hits / tokens.length) * 0.4;
  }

  if (score > 0 && memory.status === "confirmed") {
    score += 0.05;
  }

  return Math.min(0.99, score);
}

export { searchInteractionMemories } from "@/lib/memory/adapters/postgres/interaction-discovery";

export async function createInteractionSummaryNoteFromEvents(input: {
  userId: string;
  eventIds: string[];
  title?: string;
  metadata?: Record<string, unknown>;
}) {
  const sourceEventIds = await assertSourceEventsBelongToUser(
    input.userId,
    input.eventIds,
  );
  const events = await db
    .select()
    .from(interactionEvents)
    .where(
      and(
        eq(interactionEvents.userId, input.userId),
        inArray(interactionEvents.id, sourceEventIds),
      ),
    )
    .orderBy(interactionEvents.messageTime);
  const normalizedEvents = (events as InteractionEvent[]).map((event) =>
    normalizeEvent(event),
  );
  const title =
    input.title ??
    `交互摘要：${normalizedEvents[0]?.conversationName ?? "微信消息"}`;
  const body = normalizedEvents
    .map((event) => {
      const sender =
        event.senderDisplayName ?? event.senderName ?? event.conversationName;
      return `- ${toDate(event.messageTime).toISOString()} ${sender}: ${event.contentPreview}`;
    })
    .join("\n");

  return createInteractionNote({
    userId: input.userId,
    noteType: "summary",
    title,
    body,
    confidence: 60,
    sourceEventIds,
    metadata: {
      generatedBy: "interaction_summary_note_from_events",
      ...input.metadata,
      eventCount: normalizedEvents.length,
      platform: normalizedEvents[0]?.platform ?? "wechat",
    },
  });
}
