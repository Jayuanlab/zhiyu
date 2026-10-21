import { createHash } from "node:crypto";
import type { BrainMemory } from "../kernel/memory-types";

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

/** A content/state token, not a freshness or factual-correctness score. */
export function getBrainMemoryRevisionVersion(memory: BrainMemory): string {
  const value = {
    id: memory.id,
    userId: memory.userId,
    scope: memory.scope,
    ownerType: memory.ownerType,
    ownerId: memory.ownerId,
    memoryType: memory.memoryType,
    subject: memory.subject,
    content: memory.content,
    status: memory.status,
    confidence: memory.confidence,
    evidenceRefs: memory.evidenceRefs,
    tags: memory.tags ?? [],
    expiresAt: memory.expiresAt ?? null,
    supersedes: memory.supersedes ?? [],
    metadata: memory.metadata ?? {},
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
  return `bmrv1:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}
