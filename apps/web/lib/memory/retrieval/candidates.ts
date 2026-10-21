import { and, desc, eq, gte, inArray, isNull, or, sql, lt } from "drizzle-orm";
import { qualifyLessonSources } from "../adapters/postgres/lesson-sources";
import { db } from "@/lib/db/client";
import { brainMemories, type BrainMemoryRow } from "@/lib/db/schema";
import { brainMemoryFromRow } from "../records/memory-record";
import type { BrainMemory, BrainMemoryStatus, BrainMemoryType, BrainScope } from "../kernel/memory-types";
import type { BrainCanonicalKind } from "../kernel/memory-canonical";
import type { MemoryRecordClass } from "../records/lifecycle";

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

export async function listBrainMemoriesForUser(input: {
  userId: string;
  limit?: number;
  statuses?: BrainMemoryStatus[];
  memoryTypes?: BrainMemoryType[];
  ownerType?: BrainMemory["ownerType"];
  ownerId?: string;
  scopes?: BrainScope[];
  minConfidence?: number;
  updatedAfter?: string | Date;
  searchTerms?: string[];
  canonicalKinds?: BrainCanonicalKind[];
  reserveBoundaries?: boolean;
  boundaryOnly?: boolean;
  reserveRevisions?: boolean;
  revisionsOnly?: boolean;
  /** Host-controlled own-work correction feedback lookup, not a planner field. */
  ownerCorrectionsOnly?: boolean;
  includePendingUpdates?: boolean;
  /** Host-controlled listing only; ContextPack independently enforces recall eligibility. */
  recordClass?: MemoryRecordClass | "all";
  before?: { updatedAt: string; id: string };
  extractionsOnly?: boolean;
}): Promise<BrainMemory[]> {
  if (input.includePendingUpdates) {
    const memories = await listBrainMemoriesForUser({ ...input, includePendingUpdates: false });
    const { annotatePendingMemoryUpdates } = await import("./pending-updates");
    return annotatePendingMemoryUpdates(memories);
  }
  if (input.reserveRevisions) {
    const [memories, revisions] = await Promise.all([
      listBrainMemoriesForUser({...input, reserveRevisions: false}),
      listBrainMemoriesForUser({...input, reserveRevisions: false, reserveBoundaries: false,
        revisionsOnly: true, limit: 30}),
    ]);
    return [...new Map([...memories, ...revisions].map(memory => [memory.id, memory])).values()];
  }
  if(input.reserveBoundaries&&(!input.memoryTypes?.length||input.memoryTypes.includes('boundary'))&&(!input.canonicalKinds?.length||input.canonicalKinds.includes('boundary'))){
    const [recent,boundaries]=await Promise.all([
      listBrainMemoriesForUser({...input,reserveBoundaries:false}),
      listBrainMemoriesForUser({...input,reserveBoundaries:false,boundaryOnly:true,limit:50,updatedAfter:undefined,searchTerms:undefined}),
    ]);
    return [...new Map([...boundaries,...recent].map(memory=>[memory.id,memory])).values()];
  }
  const conditions = [eq(brainMemories.userId, input.userId)];
  if (input.before) conditions.push(or(lt(brainMemories.updatedAt, new Date(input.before.updatedAt)), and(eq(brainMemories.updatedAt, new Date(input.before.updatedAt)), lt(brainMemories.id, input.before.id)))!);
  if (input.extractionsOnly) conditions.push(sql`(${brainMemories.metadata}->'lessonExtraction' is not null or ${brainMemories.metadata}->'admission'->>'source' = 'historical_long_term_intake.v1')`);
  if (input.recordClass !== "all") {
    const kind = input.recordClass ?? "long_term";
    conditions.push(sql`((${brainMemories.metadata}->'recordLifecycle'->>'schemaVersion' = 'memory-record-lifecycle.v1'
      and ${brainMemories.metadata}->'recordLifecycle'->>'recordClass' = ${kind})
      or (${kind} = 'long_term' and ${brainMemories.metadata}->'recordLifecycle' is null))`);
  }
  if (input.revisionsOnly) conditions.push(sql`(${brainMemories.metadata} ->> 'revision') is not null`);
  if (input.ownerCorrectionsOnly) {
    conditions.push(sql`${brainMemories.metadata} -> 'revision' ->> 'operation' = ${'correct'}`);
    conditions.push(sql`${brainMemories.metadata} -> 'revision' ->> 'authority' = ${'owner_statement'}`);
    conditions.push(sql`${brainMemories.metadata} -> 'revision' ->> 'reviewStatus' = ${'applied'}`);
  }
  if(input.boundaryOnly)conditions.push(or(eq(brainMemories.memoryType,'boundary'),eq(brainMemories.canonicalKind,'boundary'))!);
  if (input.statuses?.length) {
    conditions.push(inArray(brainMemories.status, input.statuses));
  }
  if (input.memoryTypes?.length) {
    conditions.push(inArray(brainMemories.memoryType, input.memoryTypes));
  }
  if (input.canonicalKinds?.length) {
    const canonicalCondition = or(
      inArray(brainMemories.canonicalKind, input.canonicalKinds),
      isNull(brainMemories.canonicalKind),
    );
    if (canonicalCondition) conditions.push(canonicalCondition);
  }
  if (input.ownerType) {
    conditions.push(eq(brainMemories.ownerType, input.ownerType));
  }
  if (input.ownerId) {
    conditions.push(eq(brainMemories.ownerId, input.ownerId));
  }
  if (input.scopes?.length) {
    const scopeConditions = input.scopes.map((scope) => {
      const columns = scopeColumns(scope);
      return and(
        eq(brainMemories.scopeType, columns.scopeType),
        columns.scopeId
          ? eq(brainMemories.scopeId, columns.scopeId)
          : isNull(brainMemories.scopeId),
      );
    });
    if (scopeConditions.length === 1) {
      const [scopeCondition] = scopeConditions;
      if (scopeCondition) conditions.push(scopeCondition);
    } else if (scopeConditions.length > 1) {
      const scopeCondition = or(...scopeConditions);
      if (scopeCondition) conditions.push(scopeCondition);
    }
  }
  if (typeof input.minConfidence === "number") {
    conditions.push(gte(brainMemories.confidence, input.minConfidence));
  }
  if (input.updatedAfter) {
    const updatedAfter =
      input.updatedAfter instanceof Date
        ? input.updatedAfter
        : new Date(input.updatedAfter);
    if (Number.isFinite(updatedAfter.getTime())) {
      conditions.push(gte(brainMemories.updatedAt, updatedAfter));
    }
  }
  const searchTerms = normalizeMemorySearchTerms(input.searchTerms ?? []);
  if (searchTerms.length > 0) {
    const haystack = sql`lower(${brainMemories.memoryType} || ' ' || ${brainMemories.subject} || ' ' || ${brainMemories.content})`;
    const searchCondition = or(
      ...searchTerms.map((term) => {
        const pattern = `%${escapeLike(term.toLowerCase())}%`;
        return sql`${haystack} like ${pattern} escape '\\'`;
      }),
    );
    if (searchCondition) conditions.push(searchCondition);
  }
  const rows = await db
    .select()
    .from(brainMemories)
    .where(and(...conditions))
    .orderBy(...(input.boundaryOnly?[desc(brainMemories.confidence)]:[]),desc(brainMemories.updatedAt),desc(brainMemories.id))
    .limit(input.limit ?? 200);
  return qualifyLessonSources(db, input.userId, (rows as BrainMemoryRow[]).map(brainMemoryFromRow));
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function normalizeMemorySearchTerms(values: string[]) {
  // Initial planner terms (12) plus at most six retry terms; do not truncate the alternative.
  return Array.from(
    new Set(
      values
        .map((value) => value.trim().toLowerCase().normalize("NFKC"))
        .filter((value) => value.length >= 2)
        .slice(0, 18),
    ),
  );
}

export { listBrainMemoriesForUser as listMemoryCandidatesForUser };
