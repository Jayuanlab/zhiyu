import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { brainAccessGrants, brainMemories, brainStateSnapshots } from "@/lib/db/schema";
import type { DrizzleDB } from "@/lib/db/types";
import { brainAccessGrantFromRow, brainMemoryFromRow } from "../../records/memory-record";
import { qualifyLessonSources } from "./lesson-sources";
import type { BrainAccessGrant, BrainMemory } from "../../kernel/memory-types";
import { dependencyFail, dependencyObject, MEMORY_DEPENDENCY_SOURCE, MEMORY_DEPENDENCY_REGISTRY_TYPE,
  parseMemoryDependencyEntity, parseMemoryDependencySources, type MemoryDependencyEntityKind, type MemoryDependencySource } from "../../revision/dependencies-common";

export type Registry = { id: string; content: { entityKind: MemoryDependencyEntityKind; entityId: string; entityVersion: string; sources: MemoryDependencySource[]; sequence: number }; metadata: Record<string, any>; createdAt: Date | string };
function registryWhere(userId: string, entityKind?: MemoryDependencyEntityKind, entityId?: string) {
  return and(eq(brainStateSnapshots.userId, userId), eq(brainStateSnapshots.snapshotType, MEMORY_DEPENDENCY_REGISTRY_TYPE),
    sql`${brainStateSnapshots.metadata}->>'source' = ${MEMORY_DEPENDENCY_SOURCE}`,
    entityKind ? sql`${brainStateSnapshots.content}->>'entityKind' = ${entityKind}` : undefined,
    entityId ? sql`${brainStateSnapshots.content}->>'entityId' = ${entityId}` : undefined);
}
export function registryFromRow(row: any): Registry {
  const content = dependencyObject(row.content);
  if (!Number.isSafeInteger(content.sequence) || content.sequence < 1 || typeof content.entityVersion !== "string" || !/^bmde1:[a-f0-9]{64}$/.test(content.entityVersion))
    dependencyFail("dependency_unavailable", 503, "Dependency registry cannot be read safely");
  const target = parseMemoryDependencyEntity(content.entityKind, content.entityId);
  return { id: row.id, content: { ...target, entityVersion: content.entityVersion, sequence: content.sequence, sources: parseMemoryDependencySources(content.sources) }, metadata: dependencyObject(row.metadata), createdAt: row.createdAt };
}
export async function latestRegistry(store: DrizzleDB, userId: string, kind: MemoryDependencyEntityKind, id: string): Promise<Registry | null> {
  const [row] = await store.select().from(brainStateSnapshots).where(registryWhere(userId, kind, id))
    .orderBy(desc(sql`(${brainStateSnapshots.content}->>'sequence')::bigint`), desc(brainStateSnapshots.id)).limit(1);
  return row ? registryFromRow(row) : null;
}
export async function grantsFor(store: DrizzleDB, userId: string, now: Date): Promise<BrainAccessGrant[]> {
  const rows = await store.select().from(brainAccessGrants).where(eq(brainAccessGrants.userId, userId)).for("share", { noWait: true });
  return rows.map(brainAccessGrantFromRow).filter((g: BrainAccessGrant) => !g.expiresAt || Number.isFinite(Date.parse(g.expiresAt)) && Date.parse(g.expiresAt) > now.getTime());
}
export async function readMemory(store: DrizzleDB, userId: string, id: string, lock: boolean) {
  let q = store.select().from(brainMemories).where(and(eq(brainMemories.userId, userId), eq(brainMemories.id, id)));
  if (lock) q = q.for("share", { noWait: true });
  const [row] = await q;
  return row ? (await qualifyLessonSources(store, userId, [brainMemoryFromRow(row)], lock))[0] : null;
}

export async function readDependencySnapshot(store: DrizzleDB, userId: string, id: string) {
  const [row] = await store.select().from(brainStateSnapshots).where(and(eq(brainStateSnapshots.userId, userId), eq(brainStateSnapshots.id, id)));
  return row ?? null;
}
export async function appendDependencySnapshot(store: DrizzleDB, record: typeof brainStateSnapshots.$inferInsert) {
  return store.insert(brainStateSnapshots).values(record).returning();
}
export async function hasPendingDependencyUpdate(store: DrizzleDB, userId: string, current: BrainMemory, currentVersion: string) {
  const [pending] = await store.select({ id: brainMemories.id }).from(brainMemories).where(and(eq(brainMemories.userId, userId), eq(brainMemories.status, "candidate"),
    eq(brainMemories.ownerType, current.ownerType), eq(brainMemories.ownerId, current.ownerId),
    sql`${brainMemories.metadata}->'updateProposal'->>'status' = 'pending'`, sql`${brainMemories.metadata}->'updateProposal'->>'targetMemoryId' = ${current.id}`,
    sql`${brainMemories.metadata}->'updateProposal'->>'expectedBaseVersion' = ${currentVersion}`)).limit(1);
  return !!pending;
}
export async function listLatestDependencyRegistryRows(store: DrizzleDB, input: { userId: string; sourceMemoryId?: string; workId?: string }, limit: number, cursor?: { kind: string; id: string }) {
    // Rank chooses current target registry before source filtering or page limit.
    const kind = sql<string>`${brainStateSnapshots.content}->>'entityKind'`, entityId = sql<string>`${brainStateSnapshots.content}->>'entityId'`;
    const latest = store.select({ ...getTableColumns(brainStateSnapshots), registryRank: sql<number>`row_number() over (partition by ${kind}, ${entityId} order by (${brainStateSnapshots.content}->>'sequence')::bigint desc, ${brainStateSnapshots.id} desc)`.as("registry_rank") }).from(brainStateSnapshots).where(registryWhere(input.userId)).as("latest_dependency");
    const conditions = [eq(latest.registryRank, 1)];
    if (input.sourceMemoryId) conditions.push(sql`${latest.sourceMemoryIds} @> ${JSON.stringify([input.sourceMemoryId.toLowerCase()])}::jsonb`);
    if (input.workId) conditions.push(and(eq(latest.scopeType, "work"), eq(latest.scopeId, input.workId))!);
    if (cursor) conditions.push(sql`(${latest.content}->>'entityKind', ${latest.content}->>'entityId') > (${cursor.kind}, ${cursor.id})`);
    const rows = await store.select().from(latest).where(and(...conditions)).orderBy(sql`${latest.content}->>'entityKind'`, sql`${latest.content}->>'entityId'`).limit(limit + 1);
  return rows;
}
