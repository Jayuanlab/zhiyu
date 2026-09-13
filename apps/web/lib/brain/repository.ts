import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import {isDeepStrictEqual} from 'node:util';
import { db } from "@/lib/db/client";
import {withBrainMemoryWrite,withBrainRecordWrite,BrainMemoryIdentityConflict} from './write-guard';
import {BrainReferenceError,assertBrainReferenceIds} from './write-errors';
import {
  brainAccessGrants,
  brainContextLogs,
  brainMemories,
  brainMemoryReviews,
  brainObservations,
  brainStateSnapshots,
  type BrainAccessGrantRow,
  type BrainContextLog,
  type BrainMemoryRow,
  type BrainMemoryReview,
  type BrainObservation,
  type BrainStateSnapshot,
  type InsertBrainAccessGrantRow,
  type InsertBrainContextLog,
  type InsertBrainMemoryRow,
  type InsertBrainMemoryReview,
  type InsertBrainObservation,
  type InsertBrainStateSnapshot,
  type Workshop,
  type WorkshopMemory,
} from "@/lib/db/schema";
import { deserializeJson, serializeJson } from "@/lib/db/serialization";
import {
  buildBrainContextPack,
  type BrainContextPack,
  type BrainRecallProfile,
} from "./context";
import {
  getBrainMemoryCanonicalMetadata,
  type BrainCanonicalKind,
} from "./canonical";
import { workshopMemoryToBrainMemory } from "./workshop-memory";
import type { BrainRecallQualityLog } from "./recall-quality";
import type {
  BrainAccessGrant,
  BrainMemory,
  BrainMemoryStatus,
  BrainMemoryReviewDecision,
  BrainMemoryType,
  BrainRequester,
  BrainSourceFilters,
  BrainScope,
} from "./types";

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

function unknownArray(value: unknown): unknown[] {
  const parsed = deserializeJson(value as any);
  return Array.isArray(parsed) ? parsed : [];
}

function recallRouteCounts(value: unknown): Record<string, number> {
  const routes = Array.isArray(value) ? value : [];
  const counts: Record<string, number> = {};
  for (const item of routes) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (record.enabled === false || typeof record.route !== "string") continue;
    counts[record.route] = (counts[record.route] ?? 0) + 1;
  }
  return counts;
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

export function brainObservationToInsertRow(input: {
  id?: string;
  userId: string;
  sourceType: string;
  sourceId: string;
  sourceEventId?: string | null;
  observedAt: string | Date;
  content: string;
  contentHash: string;
  trustLevel?: string;
  metadata?: Record<string, unknown>;
}): InsertBrainObservation {
  return {
    id: input.id,
    userId: input.userId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    sourceEventId: input.sourceEventId ?? null,
    observedAt:
      input.observedAt instanceof Date
        ? input.observedAt
        : new Date(input.observedAt),
    content: input.content,
    contentHash: input.contentHash,
    trustLevel: input.trustLevel ?? "raw",
    metadata: toDbJson(input.metadata ?? {}),
  } as InsertBrainObservation;
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

export function brainObservationFromRow(row: BrainObservation) {
  return {
    id: row.id,
    userId: row.userId,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    sourceEventId:
      typeof row.sourceEventId === "string" ? row.sourceEventId : undefined,
    observedAt: dateIso(row.observedAt) ?? new Date().toISOString(),
    content: row.content,
    contentHash: row.contentHash,
    trustLevel: row.trustLevel,
    metadata: deserializeJson(row.metadata as any) as Record<string, unknown>,
    createdAt: dateIso(row.createdAt) ?? new Date().toISOString(),
  };
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

export async function upsertBrainObservation(input: {
  id?: string;
  userId: string;
  sourceType: string;
  sourceId: string;
  sourceEventId?: string | null;
  observedAt: string | Date;
  content: string;
  contentHash: string;
  trustLevel?: string;
  metadata?: Record<string, unknown>;
}) {
  const row = brainObservationToInsertRow(input);
  return withBrainRecordWrite(input.userId,"observation",async store=>{
  const [created] = await store
    .insert(brainObservations)
    .values(row)
    .onConflictDoNothing()
    .returning();
  if (created) {
    return {id:created.id,result:brainObservationFromRow(created as BrainObservation)};
  }
  const [existing] = await store
    .select()
    .from(brainObservations)
    .where(
      and(
        eq(brainObservations.userId, input.userId),
        eq(brainObservations.sourceType, input.sourceType),
        eq(brainObservations.sourceId, input.sourceId),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new Error("Brain observation was not persisted");
  }
  return {id:existing.id,result:brainObservationFromRow(existing as BrainObservation),written:false};
  });
}

export async function listBrainObservationsForUser(input: {
  userId: string;
  limit?: number;
  sourceTypes?: string[];
}) {
  const conditions = [eq(brainObservations.userId, input.userId)];
  if (input.sourceTypes?.length) {
    conditions.push(inArray(brainObservations.sourceType, input.sourceTypes));
  }
  const rows = await db
    .select()
    .from(brainObservations)
    .where(and(...conditions))
    .orderBy(desc(brainObservations.observedAt))
    .limit(input.limit ?? 200);
  return (rows as BrainObservation[]).map(brainObservationFromRow);
}

export async function insertBrainMemory(
  memory: BrainMemory,
): Promise<BrainMemoryRow> {
  return withBrainMemoryWrite(memory,async store=>{
  const [created] = await store
    .insert(brainMemories)
    .values(brainMemoryToInsertRow(memory))
    .returning();
  return created as BrainMemoryRow;
  });
}

export async function getBrainMemoryById(input: {
  userId: string;
  memoryId: string;
}): Promise<BrainMemory | null> {
  const [row] = await db
    .select()
    .from(brainMemories)
    .where(
      and(
        eq(brainMemories.userId, input.userId),
        eq(brainMemories.id, input.memoryId),
      ),
    )
    .limit(1);
  return row ? brainMemoryFromRow(row as BrainMemoryRow) : null;
}

export async function upsertBrainMemory(
  memory: BrainMemory,
): Promise<BrainMemory> {
  const row = brainMemoryToInsertRow(memory);
  return withBrainMemoryWrite(memory,async store=>{
  const [created] = await store
    .insert(brainMemories)
    .values(row)
    .onConflictDoUpdate({
      target: brainMemories.id,
      set: {
        memoryType: row.memoryType,
        subject: row.subject,
        content: row.content,
        status: row.status,
        confidence: row.confidence,
        canonicalKind: row.canonicalKind,
        canonicalGroupId: row.canonicalGroupId,
        evidenceRefs: row.evidenceRefs,
        tags: row.tags,
        metadata: row.metadata,
        expiresAt: row.expiresAt,
        supersedes: row.supersedes,
        updatedAt: row.updatedAt,
      },
      setWhere: and(eq(brainMemories.userId,row.userId),eq(brainMemories.scopeType,row.scopeType),
        row.scopeId==null?isNull(brainMemories.scopeId):eq(brainMemories.scopeId,row.scopeId),
        eq(brainMemories.ownerType,row.ownerType),eq(brainMemories.ownerId,row.ownerId)),
    })
    .returning();
  if(!created)throw new BrainMemoryIdentityConflict();
  return brainMemoryFromRow(created as BrainMemoryRow);
  });
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

export async function insertBrainMemoryReview(input: {
  userId: string;
  memoryId: string;
  reviewerType: BrainRequester["type"];
  reviewerId?: string | null;
  decision: BrainMemoryReviewDecision | "edited";
  reason?: string | null;
  evidenceRefs?: string[];
  metadata?: Record<string, unknown>;
}): Promise<BrainMemoryReview> {
  return withBrainRecordWrite(input.userId,"review",async store=>{
  assertBrainReferenceIds([input.memoryId]);
  const [memory] = await store.select({id:brainMemories.id}).from(brainMemories)
    .where(and(eq(brainMemories.userId,input.userId),eq(brainMemories.id,input.memoryId))).for("share");
  if (!memory) throw new BrainReferenceError();
  const [created] = await store
    .insert(brainMemoryReviews)
    .values(brainMemoryReviewToInsertRow(input))
    .returning();
  return {id:created.id,result:created as BrainMemoryReview};
  });
}

export async function listBrainMemoryReviewsForUser(input: {
  userId: string;
  memoryId?: string;
  limit?: number;
}): Promise<BrainMemoryReview[]> {
  const conditions = [eq(brainMemoryReviews.userId, input.userId)];
  if (input.memoryId) {
    conditions.push(eq(brainMemoryReviews.memoryId, input.memoryId));
  }
  const rows = await db
    .select()
    .from(brainMemoryReviews)
    .where(and(...conditions))
    .orderBy(desc(brainMemoryReviews.createdAt))
    .limit(input.limit ?? 100);
  return rows as BrainMemoryReview[];
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
}): Promise<BrainMemory[]> {
  if(input.reserveBoundaries&&(!input.memoryTypes?.length||input.memoryTypes.includes('boundary'))&&(!input.canonicalKinds?.length||input.canonicalKinds.includes('boundary'))){
    const [recent,boundaries]=await Promise.all([
      listBrainMemoriesForUser({...input,reserveBoundaries:false}),
      listBrainMemoriesForUser({...input,reserveBoundaries:false,boundaryOnly:true,limit:50,updatedAfter:undefined,searchTerms:undefined}),
    ]);
    return [...new Map([...boundaries,...recent].map(memory=>[memory.id,memory])).values()];
  }
  const conditions = [eq(brainMemories.userId, input.userId)];
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
  return (rows as BrainMemoryRow[]).map(brainMemoryFromRow);
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function normalizeMemorySearchTerms(values: string[]) {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim().toLowerCase().normalize("NFKC"))
        .filter((value) => value.length >= 2)
        .slice(0, 12),
    ),
  );
}

function requesterDefaultScopes(
  requester: BrainRequester,
  grants: BrainAccessGrant[],
) {
  if (
    requester.type === "chat" ||
    requester.type === "system" ||
    grants.some(
      (grant) =>
        grant.scope.type === "global" &&
        grant.permissions.some((permission) =>
          permission === "read" || permission === "reference",
        ),
    )
  ) {
    return undefined;
  }

  const scopes: BrainScope[] = [];
  if(requester.type==='work'&&requester.id){scopes.push({type:'work',workId:requester.id});}
  if (requester.workshopId) {
    scopes.push({ type: "workshop", workshopId: requester.workshopId });
  }
  if (requester.workId) {
    scopes.push({ type: "work", workId: requester.workId });
  }
  for (const grant of grants) {
    if (
      grant.userId === requester.userId &&
      grant.subjectType === requester.type &&
      (!grant.subjectId ||
        grant.subjectId === (requester.id ?? requester.workId)) &&
      grant.permissions.some((permission) =>
        permission === "read" || permission === "reference",
      )
    ) {
      scopes.push(grant.scope);
    }
  }

  const seen = new Set<string>();
  return scopes.filter((scope) => {
    const key = JSON.stringify(scope);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function listBrainAccessGrantsForUser(input: {
  userId: string;
  limit?: number;
  subjectType?: BrainAccessGrant["subjectType"];
  subjectId?: string;
}): Promise<BrainAccessGrant[]> {
  const conditions = [eq(brainAccessGrants.userId, input.userId)];
  if (input.subjectType) {
    conditions.push(eq(brainAccessGrants.subjectType, input.subjectType));
  }
  if (input.subjectId) {
    conditions.push(eq(brainAccessGrants.subjectId, input.subjectId));
  }
  const rows = await db
    .select()
    .from(brainAccessGrants)
    .where(and(...conditions))
    .orderBy(desc(brainAccessGrants.updatedAt))
    .limit(input.limit ?? 200);
  return (rows as BrainAccessGrantRow[]).map(brainAccessGrantFromRow);
}

export async function createBrainAccessGrant(
  grant: Omit<BrainAccessGrant, "id"> & { id?: string; reason?: string | null },
): Promise<BrainAccessGrant> {
  const [created] = await db
    .insert(brainAccessGrants)
    .values(brainAccessGrantToInsertRow(grant))
    .returning();
  return brainAccessGrantFromRow(created as BrainAccessGrantRow);
}

export async function deleteBrainAccessGrant(input: {
  userId: string;
  grantId: string;
}) {
  const deleted = await db
    .delete(brainAccessGrants)
    .where(
      and(
        eq(brainAccessGrants.userId, input.userId),
        eq(brainAccessGrants.id, input.grantId),
      ),
    )
    .returning();
  return { deletedCount: deleted.length };
}

export async function insertBrainStateSnapshot(input: {
  id?: string;
  userId: string;
  scope: BrainScope;
  snapshotType: string;
  content: Record<string, unknown>;
  sourceMemoryIds?: string[];
  metadata?: Record<string, unknown>;
  createdAt?: string | Date;
}) {
  return withBrainRecordWrite(input.userId,"snapshot",async store=>{
  assertBrainReferenceIds(input.sourceMemoryIds??[]);
  const sourceIds=[...new Set((input.sourceMemoryIds??[]).map(id=>id.toLowerCase()))];
  if(sourceIds.length){
    const memories=await store.select({id:brainMemories.id}).from(brainMemories)
      .where(and(eq(brainMemories.userId,input.userId),inArray(brainMemories.id,sourceIds))).for("share");
    if(memories.length!==sourceIds.length)throw new BrainReferenceError();
  }
  const [created] = await store
    .insert(brainStateSnapshots)
    .values(brainStateSnapshotToInsertRow({...input,sourceMemoryIds:sourceIds}))
    .returning();
  return {id:created.id,result:brainStateSnapshotFromRow(created as BrainStateSnapshot)};
  });
}

export async function listBrainStateSnapshots(input: {
  userId: string;
  scope?: BrainScope;
  snapshotTypes?: string[];
  limit?: number;
}) {
  const conditions = [eq(brainStateSnapshots.userId, input.userId)];
  if (input.scope) {
    const scope = scopeColumns(input.scope);
    conditions.push(eq(brainStateSnapshots.scopeType, scope.scopeType));
    if (scope.scopeId) {
      conditions.push(eq(brainStateSnapshots.scopeId, scope.scopeId));
    }
  }
  if (input.snapshotTypes?.length) {
    conditions.push(
      inArray(brainStateSnapshots.snapshotType, input.snapshotTypes),
    );
  }
  const rows = await db
    .select()
    .from(brainStateSnapshots)
    .where(and(...conditions))
    .orderBy(desc(brainStateSnapshots.createdAt))
    .limit(input.limit ?? 100);
  return (rows as BrainStateSnapshot[]).map(brainStateSnapshotFromRow);
}

export async function insertBrainMemoryFromWorkshop(input: {
  workshop: Pick<Workshop, "id" | "userId">;
  memory: WorkshopMemory & { status?: string };
}) {
  return insertBrainMemory(
    workshopMemoryToBrainMemory({
      workshop: input.workshop,
      memory: input.memory,
    }),
  );
}

export function brainContextLogToInsertRow(input: {
  requester: BrainRequester;
  pack: BrainContextPack;
  taskIntent?: string | null;
  metadata?: Record<string, unknown>;
}): InsertBrainContextLog {
  return {
    userId: input.requester.userId,
    requesterType: input.requester.type,
    requesterId: input.requester.id ?? input.requester.workId ?? null,
    taskIntent: input.taskIntent ?? null,
    selectedMemoryIds: toDbJson(input.pack.items.map((item) => item.id)),
    denied: toDbJson(input.pack.denied),
    omitted: toDbJson(input.pack.omitted),
    metadata: toDbJson(input.metadata ?? {}),
  } as InsertBrainContextLog;
}

export async function insertBrainContextLog(input: {
  requester: BrainRequester;
  pack: BrainContextPack;
  taskIntent?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<BrainContextLog> {
  return withBrainRecordWrite(input.requester.userId,"context_log",async store=>{
  const [created] = await store
    .insert(brainContextLogs)
    .values(brainContextLogToInsertRow(input))
    .returning();
  return {id:created.id,result:created as BrainContextLog};
  });
}

export async function completeBrainEvidenceAudit(input:{userId:string;contextLogId:string;outcome:Record<string,unknown>}) {
  const outcome=JSON.parse(JSON.stringify(input.outcome)) as Record<string,unknown>;
  return withBrainRecordWrite(input.userId,'context_log',async store=>{
    const [row]=await store.select().from(brainContextLogs).where(and(eq(brainContextLogs.id,input.contextLogId),eq(brainContextLogs.userId,input.userId))).for('update');
    if(!row)throw new BrainReferenceError();
    const metadata=jsonRecord(row.metadata);
    if(metadata.evidenceReadOutcome!==undefined){
      if(!isDeepStrictEqual(metadata.evidenceReadOutcome,outcome))throw new BrainMemoryIdentityConflict();
      return {id:row.id,result:{recorded:true},written:false};
    }
    await store.update(brainContextLogs).set({metadata:toDbJson({...metadata,evidenceReadOutcome:outcome})}).where(and(eq(brainContextLogs.id,input.contextLogId),eq(brainContextLogs.userId,input.userId)));
    return {id:row.id,result:{recorded:true}};
  });
}

export function brainContextLogToQualityLog(
  row: BrainContextLog,
): BrainRecallQualityLog {
  const metadata = jsonRecord(row.metadata);
  const evidenceAudit=metadata.evidenceReadOutcome;
  const recallPlanner =
    metadata.recallPlanner &&
    typeof metadata.recallPlanner === "object" &&
    !Array.isArray(metadata.recallPlanner)
      ? (metadata.recallPlanner as Record<string, unknown>)
      : {};
  const omitted = unknownArray(row.omitted);
  return {
    id: row.id,
    evidenceReadAudit:evidenceAudit&&typeof evidenceAudit==='object'&&!Array.isArray(evidenceAudit)?{status:(evidenceAudit as Record<string,unknown>).status,quality:(evidenceAudit as Record<string,unknown>).quality}:evidenceAudit,
    requesterType: row.requesterType as BrainRequester["type"],
    requesterId: row.requesterId ?? null,
    selectedMemoryIds: stringArray(row.selectedMemoryIds),
    deniedCount: unknownArray(row.denied).length,
    omittedCount: omitted.length,
    duplicateCanonicalGroupCount: omitted.filter(
      (item) =>
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        (item as Record<string, unknown>).reason ===
          "duplicate_canonical_group",
    ).length,
    recallProfileIds: stringArray(metadata.recallProfileIds),
    recallProfileIssueCount: stringArray(
      metadata.recallProfileIssueCodes,
    ).length,
    recallPlannerMode:
      recallPlanner.mode === "llm" || recallPlanner.mode === "fallback_rules"
        ? recallPlanner.mode
        : "unknown",
    recallPlannerWarningCount: stringArray(recallPlanner.warnings).length,
    recallRouteCounts: recallRouteCounts(recallPlanner.routes),
    createdAt: dateIso(row.createdAt) ?? "",
  };
}

export async function listBrainContextLogsForQuality(input: {
  userId: string;
  limit?: number;
}): Promise<BrainRecallQualityLog[]> {
  const rows = await db
    .select()
    .from(brainContextLogs)
    .where(eq(brainContextLogs.userId, input.userId))
    .orderBy(desc(brainContextLogs.createdAt))
    .limit(Math.min(2_000, Math.max(1, input.limit ?? 500)));
  return (rows as BrainContextLog[]).map(brainContextLogToQualityLog);
}

export type BrainCanonicalStorageStatus = {
  checkedAt: string;
  migrationReady: boolean;
  status: "ok" | "degraded" | "migration_missing";
  totalMemories: number;
  canonicalKindRows: number;
  canonicalGroupRows: number;
  canonicalKindCoverage: number;
  canonicalGroupCoverage: number;
  sampleQueryMs: number | null;
  warnings: string[];
  error: string | null;
};

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : 1;
}

function rowsFromDbResult<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] } | null | undefined)?.rows ?? [];
}

export async function getBrainCanonicalStorageStatus(input: {
  userId: string;
}): Promise<BrainCanonicalStorageStatus> {
  const checkedAt = new Date().toISOString();
  try {
    const [summary] = rowsFromDbResult<{
      totalMemories: number | string | null;
      canonicalKindRows: number | string | null;
      canonicalGroupRows: number | string | null;
    }>(
      await db.execute(
        sql`
          select
            count(*) as "totalMemories",
            sum(case when canonical_kind is not null then 1 else 0 end) as "canonicalKindRows",
            sum(case when canonical_group_id is not null then 1 else 0 end) as "canonicalGroupRows"
          from brain_memories
          where user_id = ${input.userId}
        `,
      ),
    );
    const sampleStartedAt = Date.now();
    await db.execute(
      sql`
        select id
        from brain_memories
        where user_id = ${input.userId}
          and canonical_kind in ('fact', 'boundary')
        limit 10
      `,
    );
    const sampleQueryMs = Date.now() - sampleStartedAt;
    const totalMemories = Number(summary?.totalMemories ?? 0);
    const canonicalKindRows = Number(summary?.canonicalKindRows ?? 0);
    const canonicalGroupRows = Number(summary?.canonicalGroupRows ?? 0);
    const canonicalKindCoverage = ratio(canonicalKindRows, totalMemories);
    const canonicalGroupCoverage = ratio(canonicalGroupRows, totalMemories);
    const warnings: string[] = [];
    if (totalMemories > 0 && canonicalKindCoverage < 0.95) {
      warnings.push("canonical_kind coverage is below 95%; backfill may still be incomplete.");
    }
    if (totalMemories > 0 && canonicalGroupCoverage < 0.95) {
      warnings.push("canonical_group_id coverage is below 95%; dedupe prefilter may be incomplete.");
    }
    if (sampleQueryMs > 250) {
      warnings.push("canonicalKind sample query is slower than 250ms; inspect index usage.");
    }
    return {
      checkedAt,
      migrationReady: true,
      status: warnings.length > 0 ? "degraded" : "ok",
      totalMemories,
      canonicalKindRows,
      canonicalGroupRows,
      canonicalKindCoverage,
      canonicalGroupCoverage,
      sampleQueryMs,
      warnings,
      error: null,
    };
  } catch (error) {
    return {
      checkedAt,
      migrationReady: false,
      status: "migration_missing",
      totalMemories: 0,
      canonicalKindRows: 0,
      canonicalGroupRows: 0,
      canonicalKindCoverage: 0,
      canonicalGroupCoverage: 0,
      sampleQueryMs: null,
      warnings: [
        "Brain canonical storage columns or indexes are not queryable; run the canonical memory migration before production rollout.",
      ],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function buildBrainContextPackFromStore(input: {
  requester: BrainRequester;
  taskIntent: string;
  maxItems?: number;
  memoryLimit?: number;
  statuses?: BrainMemoryStatus[];
  memoryTypes?: BrainMemoryType[];
  scopes?: BrainScope[];
  minConfidence?: number;
  updatedAfter?: string | Date;
  searchTerms?: string[];
  canonicalKinds?: BrainCanonicalKind[];
  now?: Date;
  accessMode?: "strict" | "owner_override";
  includeCandidates?: boolean;
  metadata?: Record<string, unknown>;
  recallProfiles?: BrainRecallProfile[];
  sourceFilters?: BrainSourceFilters;
}): Promise<BrainContextPack> {
  const grants = await listBrainAccessGrantsForUser({
    userId: input.requester.userId,
    limit: 200,
  });
  const scopes =
    input.scopes ?? requesterDefaultScopes(input.requester, grants);
  const statuses =
    input.statuses ??
    (input.includeCandidates
      ? (["candidate", "active", "verified", "weakened"] as BrainMemoryStatus[])
      : (["active", "verified", "weakened"] as BrainMemoryStatus[]));
  const memories = await listBrainMemoriesForUser({
    userId: input.requester.userId,
    limit: input.memoryLimit ?? 200,
    reserveBoundaries: true,
    statuses,
    memoryTypes: input.memoryTypes,
    scopes,
    minConfidence: input.minConfidence,
    updatedAfter: input.updatedAfter,
    searchTerms: input.searchTerms,
    canonicalKinds: input.canonicalKinds,
  });
  const canonicalKinds = input.canonicalKinds ?? [];
  const filteredMemories = canonicalKinds.length
    ? memories.filter((memory) =>
        canonicalKinds.includes(
          getBrainMemoryCanonicalMetadata(memory).canonicalKind,
        ),
      )
    : memories;
  const pack = buildBrainContextPack({
    memories: filteredMemories,
    grants,
    requester: input.requester,
    taskIntent: input.taskIntent,
    maxItems: input.maxItems,
    now: input.now,
    accessMode: input.accessMode,
    includeCandidates: input.includeCandidates,
    recallProfiles: input.recallProfiles,
    sourceFilters: input.sourceFilters,
  });
  const contextLog = await insertBrainContextLog({
    requester: input.requester,
    pack,
    taskIntent: input.taskIntent,
    metadata: {
      ...(input.metadata ?? {}),
      candidateFilters: {
        boundaryReserveLimit: 50,
        statuses,
        memoryTypes: input.memoryTypes ?? null,
        scopes: scopes ?? null,
        minConfidence: input.minConfidence ?? null,
        updatedAfter: input.updatedAfter
          ? input.updatedAfter instanceof Date
            ? input.updatedAfter.toISOString()
            : input.updatedAfter
          : null,
        searchTerms: normalizeMemorySearchTerms(input.searchTerms ?? []),
        canonicalKinds: input.canonicalKinds ?? null,
        sourceFilters: input.sourceFilters ?? null,
      },
      candidateCount: memories.length,
      filteredCandidateCount: filteredMemories.length,
    },
  });
  return {
    ...pack,
    contextLogId: contextLog.id,
  };
}
