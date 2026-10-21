import type {
  BrainAccessGrantRow, BrainMemoryRow, InsertBrainAccessGrantRow, InsertBrainMemoryRow, InsertBrainMemoryReview,
} from "@/lib/db/schema";
import { deserializeJson, serializeJson } from "@/lib/db/serialization";
import { getBrainMemoryCanonicalMetadata } from "../kernel/memory-canonical";
import type {
  BrainAccessGrant, BrainMemory, BrainMemoryStatus, BrainMemoryType, BrainMemoryReviewDecision, BrainRequester, BrainScope,
} from "../kernel/memory-types";
import { classifyNewRecord } from "./lifecycle";

function toDbJson(value: unknown) {
  return serializeJson(
    value as Record<string, unknown> | unknown[] | string | number | boolean,
  ) as any;
}

function scopeColumns(scope: BrainScope) {
  switch (scope.type) {
    case "global":
      return { scopeType: "global", scopeId: null };
    case "workspace":
      return { scopeType: "workspace", scopeId: scope.workspaceId };
    case "workshop":
      return { scopeType: "workshop", scopeId: scope.workshopId };
    case "work":
      return { scopeType: "work", scopeId: scope.workId };
  }
}

function scopeFromColumns(scopeType: unknown, scopeId: unknown): BrainScope {
  const id = typeof scopeId === "string" ? scopeId : "";
  switch (scopeType) {
    case "workspace":
      return { type: "workspace", workspaceId: id };
    case "workshop":
      return { type: "workshop", workshopId: id };
    case "work":
      return { type: "work", workId: id };
    case "global":
    default:
      return { type: "global" };
  }
}

function stringArray(value: unknown): string[] {
  const parsed = deserializeJson(value as any);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function jsonRecord(value: unknown): Record<string, unknown> {
  const parsed = deserializeJson(value as any);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function dateIso(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function nullableDate(value: string | null | undefined) {
  return value ? new Date(value) : null;
}

export function brainMemoryToInsertRow(
  memory: BrainMemory,
): InsertBrainMemoryRow {
  memory = classifyNewRecord(memory);
  const scope = scopeColumns(memory.scope);
  const canonical = getBrainMemoryCanonicalMetadata(memory);
  return {
    id: memory.id,
    userId: memory.userId,
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    ownerType: memory.ownerType,
    ownerId: memory.ownerId,
    memoryType: memory.memoryType,
    subject: memory.subject,
    content: memory.content,
    status: memory.status,
    confidence: memory.confidence,
    canonicalKind: canonical.canonicalKind,
    canonicalGroupId: canonical.canonicalGroupId,
    evidenceRefs: toDbJson(memory.evidenceRefs),
    tags: toDbJson(memory.tags ?? []),
    metadata: toDbJson(memory.metadata ?? {}),
    expiresAt: memory.expiresAt ? new Date(memory.expiresAt) : null,
    supersedes: toDbJson(memory.supersedes ?? []),
    createdAt: new Date(memory.createdAt),
    updatedAt: new Date(memory.updatedAt),
  } as InsertBrainMemoryRow;
}

export function brainAccessGrantToInsertRow(
  grant: Omit<BrainAccessGrant, "id"> & { id?: string; reason?: string | null },
): InsertBrainAccessGrantRow {
  const scope = scopeColumns(grant.scope);
  return {
    id: grant.id,
    userId: grant.userId,
    subjectType: grant.subjectType,
    subjectId: grant.subjectId ?? null,
    ...scope,
    permissions: toDbJson(grant.permissions),
    memoryTypes: toDbJson(grant.memoryTypes ?? []),
    reason: grant.reason ?? null,
    expiresAt: nullableDate(grant.expiresAt),
  } as InsertBrainAccessGrantRow;
}

export function brainMemoryFromRow(row: BrainMemoryRow): BrainMemory {
  const metadata = jsonRecord(row.metadata);
  if (typeof row.canonicalKind === "string" && row.canonicalKind) {
    metadata.canonicalKind ??= row.canonicalKind;
  }
  if (typeof row.canonicalGroupId === "string" && row.canonicalGroupId) {
    metadata.canonicalGroupId ??= row.canonicalGroupId;
  }
  return {
    id: String(row.id),
    userId: String(row.userId),
    scope: scopeFromColumns(row.scopeType, row.scopeId),
    ownerType:
      row.ownerType === "chat" || row.ownerType === "system"
        ? row.ownerType
        : "work",
    ownerId: String(row.ownerId),
    memoryType: row.memoryType as BrainMemoryType,
    subject: String(row.subject),
    content: String(row.content),
    status: row.status as BrainMemoryStatus,
    confidence: Number(row.confidence ?? 50),
    evidenceRefs: stringArray(row.evidenceRefs),
    tags: stringArray(row.tags),
    createdAt: dateIso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: dateIso(row.updatedAt) ?? new Date(0).toISOString(),
    expiresAt: dateIso(row.expiresAt),
    supersedes: stringArray(row.supersedes),
    metadata,
  };
}

export function brainAccessGrantFromRow(
  row: BrainAccessGrantRow,
): BrainAccessGrant {
  return {
    id: String(row.id),
    userId: String(row.userId),
    subjectType: row.subjectType as BrainAccessGrant["subjectType"],
    subjectId: typeof row.subjectId === "string" ? row.subjectId : undefined,
    scope: scopeFromColumns(row.scopeType, row.scopeId),
    permissions: stringArray(row.permissions) as BrainAccessGrant["permissions"],
    memoryTypes: stringArray(row.memoryTypes) as BrainMemoryType[],
    expiresAt: dateIso(row.expiresAt),
  };
}

export function brainMemoryReviewToInsertRow(input: {
  userId: string;
  memoryId: string;
  reviewerType: BrainRequester["type"];
  reviewerId?: string | null;
  decision: BrainMemoryReviewDecision | "edited";
  reason?: string | null;
  evidenceRefs?: string[];
  metadata?: Record<string, unknown>;
}): InsertBrainMemoryReview {
  return {
    userId: input.userId,
    memoryId: input.memoryId,
    reviewerType: input.reviewerType,
    reviewerId: input.reviewerId ?? null,
    decision: input.decision,
    reason: input.reason ?? null,
    evidenceRefs: toDbJson(input.evidenceRefs ?? []),
    metadata: toDbJson(input.metadata ?? {}),
  } as InsertBrainMemoryReview;
}

// Names without the historical namespace are available to new Memory callers.
export {
  brainMemoryToInsertRow as memoryToInsertRow, brainMemoryFromRow as memoryFromRow,
  brainAccessGrantToInsertRow as accessGrantToInsertRow, brainAccessGrantFromRow as accessGrantFromRow,
  brainMemoryReviewToInsertRow as memoryReviewToInsertRow,
};
