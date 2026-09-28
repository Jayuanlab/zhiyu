import {
  listBrainCandidates,
  listBrainGrants,
  listBrainMemory,
  listBrainSnapshots,
  catalogBrainSnapshots,
} from "@/lib/brain/service";
import type {
  BrainMemory,
  BrainMemoryStatus,
  BrainMemoryType,
} from "@/lib/brain/types";
import { evidenceWindow } from "./evidence-window";
import { decodeSnapshotSearchCursor, encodeSnapshotSearchCursor } from "./snapshot-search-cursor";
import { snapshotAnswerCheckpoint } from "./snapshot-answer-checkpoint";

export const BRAIN_MEMORY_STATUSES: BrainMemoryStatus[] = [
  "candidate",
  "active",
  "verified",
  "weakened",
  "superseded",
  "deleted",
];

export const BRAIN_MEMORY_TYPES: BrainMemoryType[] = [
  "fact",
  "preference",
  "plan",
  "boundary",
  "relationship",
  "task",
  "insight",
  "system",
];

const BRAIN_OWNER_TYPES = ["chat", "work", "system"] as const;
type BrainOwnerType = (typeof BRAIN_OWNER_TYPES)[number];
type BrainReadResult = {
  ok: boolean;
  text: string;
  data?: Record<string, unknown>;
  isError?: boolean;
};

function safeLimit(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(100, Math.trunc(value)))
    : 20;
}

function filterEnumArray<T extends string>(
  values: unknown,
  allowed: readonly T[],
): T[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const filtered = values.filter((value): value is T =>
    allowed.includes(value as T),
  );
  return filtered.length > 0 ? filtered : undefined;
}

function normalizeOwnerType(value: unknown): BrainOwnerType | undefined {
  return BRAIN_OWNER_TYPES.includes(value as BrainOwnerType)
    ? (value as BrainOwnerType)
    : undefined;
}

function normalizeStringArray(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const filtered = values.filter((value): value is string =>
    typeof value === "string" && value.trim().length > 0,
  );
  return filtered.length > 0 ? filtered : undefined;
}

function jsonResult(key: string, value: unknown): BrainReadResult {
  const data = { [key]: value };
  return {
    ok: true,
    text: JSON.stringify(data, null, 2),
    data,
    isError: false,
  };
}

export async function listBrainMemoriesForUser(input: {
  userId: string;
  limit?: number;
  statuses?: unknown;
  memoryTypes?: unknown;
  ownerType?: unknown;
  ownerId?: string;
  listMemories?: typeof listBrainMemory;
}): Promise<BrainReadResult> {
  try {
    const memories = await (input.listMemories ?? listBrainMemory)({
      userId: input.userId,
      limit: safeLimit(input.limit),
      statuses: filterEnumArray(input.statuses, BRAIN_MEMORY_STATUSES),
      memoryTypes: filterEnumArray(input.memoryTypes, BRAIN_MEMORY_TYPES),
      ownerType: normalizeOwnerType(input.ownerType) as BrainMemory["ownerType"],
      ownerId: input.ownerId,
    });
    const data = { memories, coverage: {
      scope: "authenticated_owner_filtered_list", returnedCount: memories.length,
      requestedLimit: safeLimit(input.limit), totalMatching: null, completeness: "not_established",
      filters: { statuses: filterEnumArray(input.statuses, BRAIN_MEMORY_STATUSES), memoryTypes: filterEnumArray(input.memoryTypes, BRAIN_MEMORY_TYPES), ownerType: normalizeOwnerType(input.ownerType), ownerId: input.ownerId },
      observedAt: new Date().toISOString(),
      warning: "This is a bounded discovery list, not a population census. Never infer total counts or state distributions from this list. Use platformRecall with the full current-statistics question for owner-wide aggregation. Current rows cannot answer historical snapshot questions.",
    } };
    return { ok: true, text: JSON.stringify(data, null, 2), data, isError: false };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `Failed to list Brain memories: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export async function listBrainCandidatesForUser(input: {
  userId: string;
  limit?: number;
  ownerType?: unknown;
  ownerId?: string;
  listCandidates?: typeof listBrainCandidates;
}): Promise<BrainReadResult> {
  try {
    const candidates = await (input.listCandidates ?? listBrainCandidates)({
      userId: input.userId,
      limit: safeLimit(input.limit),
      ownerType: normalizeOwnerType(input.ownerType) as BrainMemory["ownerType"],
      ownerId: input.ownerId,
    });
    return jsonResult("candidates", candidates);
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `Failed to list Brain candidates: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export async function listBrainSnapshotsForUser(input: {
  userId: string;
  /** Trusted runtime question, not a tool parameter. */
  originalQuestion?: string;
  limit?: number;
  snapshotTypes?: unknown;
  snapshotId?: string;
  recordedBefore?: string;
  offset?: number;
  expectedHash?: string;
  workId?: string;
  view?: "list" | "catalog" | "search";
  contentQuery?: string;
  cursor?: string;
  catalogSnapshots?: typeof catalogBrainSnapshots;
  listSnapshots?: typeof listBrainSnapshots;
}): Promise<BrainReadResult> {
  try {
    if (input.snapshotId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.snapshotId)) throw Error("Invalid snapshot ID");
    if (input.snapshotTypes !== undefined && (!Array.isArray(input.snapshotTypes) || !normalizeStringArray(input.snapshotTypes))) throw Error("Snapshot type filter must contain at least one valid type");
    if (input.recordedBefore !== undefined) {
      const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(input.recordedBefore);
      const day = match && new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
      if (!match || !day || day.getUTCMonth() + 1 !== Number(match[2]) || day.getUTCDate() !== Number(match[3]) || !Number.isFinite(Date.parse(input.recordedBefore))) throw Error("recordedBefore needs a valid ISO timestamp with timezone");
    }
    if ((input.offset !== undefined || input.expectedHash !== undefined) && !input.snapshotId) throw Error("Snapshot pagination requires an exact snapshot ID");
    if (input.view !== undefined && !["list", "catalog", "search"].includes(input.view)) throw Error("Invalid snapshot view");
    if (input.contentQuery !== undefined && input.view !== "search") throw Error("contentQuery requires view:search");
    if (input.cursor !== undefined && input.view !== "search") throw Error("cursor requires view:search");
    if (input.view === "search") {
      if (input.snapshotId) throw Error("Use exact snapshot reads separately from content search");
      if (typeof input.contentQuery !== "string" || input.contentQuery.trim().length < 2 || input.contentQuery.trim().length > 200) throw Error("Content search needs a literal phrase of 2 to 200 characters");
      const query = input.contentQuery.trim();
      const scope = { userId: input.userId, workId: input.workId, query, recordedBefore: input.recordedBefore,
        snapshotTypes: normalizeStringArray(input.snapshotTypes) };
      const cursor = input.cursor === undefined ? undefined : decodeSnapshotSearchCursor(input.cursor, scope);
      const cutoff = cursor?.cutoff ?? input.recordedBefore ?? new Date().toISOString();
      if (Date.parse(cutoff) > Date.parse(input.recordedBefore ?? new Date().toISOString())) throw Error("Cursor cannot widen the requested recording-time boundary");
      const limit = Math.min(10, safeLimit(input.limit));
      const rows = await (input.listSnapshots ?? listBrainSnapshots)({ userId: input.userId,
        ...(input.workId ? { workId: input.workId } : {}), recordedBefore: cutoff,
        ...(cursor ? { pageAfter: cursor.after } : {}), includePagePosition: true,
        snapshotTypes: scope.snapshotTypes, contentQuery: query, limit: limit + 1 });
      const matches = rows.slice(0, limit).map(({ paginationTime, ...snapshot }) => {
        const content = JSON.stringify(snapshot.content);
        const at = content.toLowerCase().indexOf(query.toLowerCase());
        const start = Math.max(0, at - 200);
        return { snapshotId: snapshot.id, snapshotType: snapshot.snapshotType, scope: snapshot.scope, recordedAt: snapshot.createdAt,
          snapshotHash: evidenceWindow(JSON.stringify(snapshot)).contentHash,
          excerpt: content.slice(start, start + 1200), excerptStart: start, excerptTruncated: start > 0 || content.length > start + 1200,
          matchLocatedInExcerpt: at >= 0 && at + query.length <= start + 1200 };
      });
      const last = rows[Math.min(rows.length, limit) - 1];
      if (rows.length > limit && !last?.paginationTime) throw Error("Search source omitted continuation position");
      const nextCursor = rows.length > limit ? encodeSnapshotSearchCursor(scope, cutoff, { id: last.id, time: last.paginationTime! }) : null;
      const data = { status: "searched", provider: "database_literal_json_content", query, matches, hasMoreMatches: rows.length > limit, nextCursor,
        coverage: { scope: input.workId ? "current_work_snapshots" : "authenticated_owner_snapshots", snapshotTypes: normalizeStringArray(input.snapshotTypes), recordedBefore: input.recordedBefore,
          searchCutoff: cutoff, pageSize: limit,
          continuation: "Pass nextCursor with the same query/filters. Descending recording-time/ID order preserves database timestamp precision. Newer insertions are excluded by searchCutoff; updates, deletions and backdated inserts can still change results. End of pages is not semantic completeness.",
          observedAt: new Date().toISOString(), completeness: "literal_matches_only_not_semantic_coverage",
          warning: "Search matches literal text in serialized content (JSON keys and values), not metadata/type names. Zero hits means no match for this phrase in this scope, NOT absence of the fact. Matches are candidate evidence, not verified claims. Read exact snapshotId with snapshotHash as expectedHash to verify full context; recordedAt is not a validity interval." } };
      return { ok: true, text: JSON.stringify(data), data, isError: false };
    }
    if (input.view === "catalog") {
      if (input.snapshotId) throw Error("Catalog view cannot be combined with a snapshot ID");
      const catalog = await (input.catalogSnapshots ?? catalogBrainSnapshots)({ userId: input.userId,
        ...(input.workId ? { workId: input.workId } : {}),
        ...(input.recordedBefore ? { recordedBefore: input.recordedBefore } : {}),
        ...(input.snapshotTypes ? { snapshotTypes: normalizeStringArray(input.snapshotTypes) } : {}),
      });
      const data = { ...catalog, status: "catalog",
        contentCoverage: { level: "type_metadata_only", snapshotContentsRead: 0,
          supportedClaims: ["saved_record_count_by_type_in_query_scope", "recording_time_range_in_query_scope"],
          unsupportedClaims: ["a_fact_is_absent_from_all_snapshot_contents", "a_type_cannot_contain_the_requested_fact", "platform_has_no_historical_query_capability"],
          nextAction: "Use view:search with a literal contentQuery to find candidate evidence without guessing by type, or list candidate IDs then read exact snapshots. If the target is unidentified, report that gap instead of claiming content absence." },
        coverage: { scope: input.workId ? "current_work_snapshots" : "authenticated_owner_snapshots",
        filters: { snapshotTypes: normalizeStringArray(input.snapshotTypes), recordedBefore: input.recordedBefore },
        completeness: catalog.hasMoreTypes ? "truncated_type_catalog" : "complete_type_catalog_in_query_scope",
        observedAt: new Date().toISOString(),
        warning: "Counts describe saved records within this query scope only. Type names do not prove which facts their contents contain. Recording times are not validity intervals. This catalog does not measure platform capability or inaccessible/deleted/external history. Use a returned type to discover IDs and read exact snapshots." } };
      return { ok: true, text: JSON.stringify(data), data, isError: false };
    }
    const snapshots = await (input.listSnapshots ?? listBrainSnapshots)({
      userId: input.userId,
      limit: input.snapshotId ? 1 : safeLimit(input.limit),
      snapshotTypes: normalizeStringArray(input.snapshotTypes),
      ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
      ...(input.recordedBefore ? { recordedBefore: input.recordedBefore } : {}),
      ...(input.workId ? { workId: input.workId } : {}),
    });
    const coverage = { scope: input.workId ? "current_work_snapshots" : "authenticated_owner_snapshots",
      snapshotId: input.snapshotId, recordedBefore: input.recordedBefore, returnedCount: snapshots.length,
      completeness: "not_established", observedAt: new Date().toISOString(),
      nextAction: "Use view:catalog for scoped type counts; a recent list is not the full type inventory. Then filter by type or read an exact snapshot ID.",
      warning: "createdAt is recording time, NOT a fact validity interval. An earlier snapshot is not proof of state at the requested instant. No match is not proof history never existed. Never substitute current memory counts or current code for missing historical evidence." };
    if (input.snapshotId) {
      if (!snapshots.length) {
        const data = { status: "not_found_in_scope", coverage };
        return { ok: false, isError: true, text: JSON.stringify(data), data };
      }
      const page = evidenceWindow(JSON.stringify(snapshots[0]), input.offset ?? 0, input.expectedHash);
      const checkpoint = snapshotAnswerCheckpoint(snapshots[0], page, input.originalQuestion);
      const data = { ...page, snapshotId: input.snapshotId, coverage, ...(checkpoint ? { answerCheckpoint: checkpoint } : {}) };
      return { ok: page.status === "read", isError: page.status !== "read", text: JSON.stringify(data), data };
    }
    const data = { snapshots, coverage };
    return { ok: true, text: JSON.stringify(data), data, isError: false };
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `Failed to list Brain snapshots: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export async function listBrainGrantsForUser(input: {
  userId: string;
  limit?: number;
  subjectType?: unknown;
  subjectId?: string;
  listGrants?: typeof listBrainGrants;
}): Promise<BrainReadResult> {
  try {
    const subjectType =
      input.subjectType === "chat" ||
      input.subjectType === "work" ||
      input.subjectType === "loop" ||
      input.subjectType === "tool" ||
      input.subjectType === "system"
        ? input.subjectType
        : undefined;
    const grants = await (input.listGrants ?? listBrainGrants)({
      userId: input.userId,
      limit: safeLimit(input.limit),
      subjectType,
      subjectId: input.subjectId,
    });
    return jsonResult("grants", grants);
  } catch (error) {
    return {
      ok: false,
      isError: true,
      text: `Failed to list Brain grants: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
