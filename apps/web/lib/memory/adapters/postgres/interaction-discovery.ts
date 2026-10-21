import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { interactionMemories, type InteractionMemory } from "@/lib/db/schema";
import { deserializeJson } from "@/lib/db/serialization";
import type { BrainMemory, BrainMemoryStatus } from "../../kernel/memory-types";
import { listBrainMemoriesForUser as listBrainMemory } from "../../retrieval/candidates";
import { shouldPreferBrainMemory, shouldReadLegacyMemoryFallback } from "../../retrieval/mode";

export type InteractionMemorySearchResult = {
  memory: InteractionMemory;
  score: number;
};

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

function boundedLimit(value: number | undefined, fallback = 50, max = 200) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
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

export async function searchInteractionMemories(input: {
  userId: string;
  query: string;
  limit?: number;
  statuses?: string[];
}): Promise<InteractionMemorySearchResult[]> {
  const limit = boundedLimit(input.limit);
  const statuses = input.statuses?.length ? input.statuses : ["confirmed"];
  const preferBrain = shouldPreferBrainMemory();
  const allowLegacyFallback = shouldReadLegacyMemoryFallback();
  const brainMemories = preferBrain
    ? await listBrainInteractionMemories({
        userId: input.userId,
        limit: Math.min(1000, Math.max(limit * 50, limit)),
        statuses,
      })
    : [];
  if (preferBrain && brainMemories.length > 0) {
    return brainMemories
      .map((memory) => ({
        memory,
        score: scoreInteractionMemory(input.query, memory),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => {
        const scoreDelta = b.score - a.score;
        if (scoreDelta !== 0) return scoreDelta;
        return (
          toDate(b.memory.updatedAt).getTime() -
          toDate(a.memory.updatedAt).getTime()
        );
      })
      .slice(0, limit);
  }
  if (!allowLegacyFallback) return [];
  const rows = await db
    .select()
    .from(interactionMemories)
    .where(
      and(
        eq(interactionMemories.userId, input.userId),
        inArray(interactionMemories.status, statuses),
      ),
    )
    .orderBy(desc(interactionMemories.updatedAt))
    .limit(Math.min(200, Math.max(limit * 5, limit)));

  return (rows as InteractionMemory[])
    .map((row) => {
      const memory = normalizeMemory(row);
      return {
        memory,
        score: scoreInteractionMemory(input.query, memory),
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      const scoreDelta = b.score - a.score;
      if (scoreDelta !== 0) return scoreDelta;
      return (
        toDate(b.memory.updatedAt).getTime() -
        toDate(a.memory.updatedAt).getTime()
      );
    })
    .slice(0, limit);
}

