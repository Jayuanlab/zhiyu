import { createHash } from "node:crypto";
import type { BrainStateSnapshot, InsertBrainStateSnapshot } from "@/lib/db/schema";
import { deserializeJson, serializeJson } from "@/lib/db/serialization";
import type { BrainScope } from "../kernel/memory-types";
import { stableJson } from "./observations";

function toDbJson(value: unknown) {
  return serializeJson(
    value as Record<string, unknown> | unknown[] | string | number | boolean,
  ) as any;
}

export function scopeColumns(scope: BrainScope) {
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

function dateIso(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function brainStateSnapshotToInsertRow(input: {
  id?: string;
  userId: string;
  scope: BrainScope;
  snapshotType: string;
  content: Record<string, unknown>;
  sourceMemoryIds?: string[];
  metadata?: Record<string, unknown>;
  createdAt?: string | Date;
}): InsertBrainStateSnapshot {
  const scope = scopeColumns(input.scope);
  return {
    id: input.id,
    userId: input.userId,
    ...scope,
    snapshotType: input.snapshotType,
    content: toDbJson(input.content),
    sourceMemoryIds: toDbJson(input.sourceMemoryIds ?? []),
    metadata: toDbJson(input.metadata ?? {}),
    createdAt:
      input.createdAt instanceof Date
        ? input.createdAt
        : input.createdAt
          ? new Date(input.createdAt)
          : undefined,
  } as InsertBrainStateSnapshot;
}

export function brainStateSnapshotFromRow(row: BrainStateSnapshot) {
  return {
    id: row.id,
    userId: row.userId,
    scope: scopeFromColumns(row.scopeType, row.scopeId),
    snapshotType: row.snapshotType,
    content: deserializeJson(row.content as any) as Record<string, unknown>,
    sourceMemoryIds: stringArray(row.sourceMemoryIds),
    metadata: deserializeJson(row.metadata as any) as Record<string, unknown>,
    createdAt: dateIso(row.createdAt) ?? new Date().toISOString(),
  };
}

export type SnapshotQuery = {
  userId: string;
  scope?: BrainScope;
  workId?: string;
  snapshotTypes?: string[];
  snapshotId?: string;
  recordedBefore?: string;
  contentQuery?: string;
  pageAfter?: { id: string; time: string };
  includePagePosition?: boolean;
  limit?: number;
};

export type StateSnapshotRecord = ReturnType<typeof brainStateSnapshotFromRow>;
export function stateSnapshotRevisionVersion(record: StateSnapshotRecord): string { return `ssrv1:${createHash("sha256").update(stableJson(record)).digest("hex")}`; }
export { brainStateSnapshotToInsertRow as stateSnapshotToInsertRow, brainStateSnapshotFromRow as stateSnapshotFromRow };
