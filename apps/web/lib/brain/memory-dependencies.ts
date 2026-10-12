import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { brainAccessGrants, brainMemories, brainStateSnapshots } from "@/lib/db/schema";
import type { DrizzleDB } from "@/lib/db/types";
import { brainAccessGrantFromRow, brainMemoryFromRow } from "./repository";
import { canReadMemory } from "./policy";
import { getBrainMemoryRevisionVersion } from "./memory-revision-version";
import { acquireBrainWriteAdvisoryLock } from "./memory-revision-lock";
import { sameIdentity } from "./memory-update-common";
import { withBrainRecordWrite } from "./write-guard";
import { BrainMemoryWriteBusy } from "./write-errors";
import type { BrainAccessGrant, BrainMemory, BrainRequester } from "./types";
import { authorizeMemoryDependencyEntity, readMemoryDependencyEntity, type MemoryDependencyEntity } from "./memory-dependencies-entity";
import { dependencyFail, dependencyNow, dependencyObject, dependencyText, deriveMemoryDependencyAssessment, getMemoryDependencyRegistryVersion, isDependencyHuman,
  memoryDependencyDigest, memoryDependencyRecordId, memoryIsDependencyCurrent, MEMORY_DEPENDENCY_CHANGE_TYPE, MEMORY_DEPENDENCY_REGISTRY_TYPE, MEMORY_DEPENDENCY_SOURCE,
  parseMemoryDependencyEntity, parseMemoryDependencySources, type MemoryDependencyAssessment, type MemoryDependencyEntityKind, type MemoryDependencySource } from "./memory-dependencies-common";
export * from "./memory-dependencies-common";

export type MemoryDependencySourceAssessment = MemoryDependencySource & {
  assessment: "current" | "stale" | "denied"; reason: string;
  oldMemory?: BrainMemory & { revisionVersion: string };
  currentMemory?: BrainMemory & { revisionVersion: string };
  currentVersion?: string;
};
export type MemoryDependencySnapshot = {
  entity: MemoryDependencyEntity;
  coverage: "unknown" | "recorded";
  dependencyVersion: string;
  registry: { snapshotId: string; sequence: number; createdAt: string; reason: string } | null;
  assessment: MemoryDependencyAssessment;
  reasons: string[];
  sources: MemoryDependencySourceAssessment[];
};
export type MemoryDependencyReceipt = {
  id: string; commandId: string; action: "register" | "rebind";
  entityKind: MemoryDependencyEntityKind; entityId: string;
  previousDependencyVersion: string; dependencyVersion: string; entityVersion: string;
  sourceVersions: MemoryDependencySource[]; sequence: number; snapshotId: string; createdAt: string;
};
export type MemoryDependencyBindRequest = {
  commandId: string; action: "register" | "rebind"; expectedDependencyVersion: string;
  expectedEntityVersion: string; sources: MemoryDependencySource[]; reason: string; evidenceConfirmed: true;
};
export type MemoryDependencyEntitySummary = Pick<MemoryDependencySnapshot, "coverage" | "assessment" | "reasons" | "dependencyVersion"> & { entityVersion: string | null };
export type MemoryDependencyEntitySummaryTarget = { entityKind: "wiki_note" | "interaction_task"; entityId: string; expectedEntityVersion: string };

/** Exported in-transaction operations must reject, so the caller rolls back.
 * Never catch a lock failure and continue a partially successful transaction. */
async function withDependencyLockErrors<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; cause && typeof cause === "object" && depth < 8; depth++) {
      if ((cause as { code?: unknown }).code === "55P03") throw new BrainMemoryWriteBusy();
      cause = (cause as { cause?: unknown }).cause;
    }
    throw error;
  }
}
type EntityValue = NonNullable<Awaited<ReturnType<typeof readMemoryDependencyEntity>>>;
type Registry = { id: string; content: { entityKind: MemoryDependencyEntityKind; entityId: string; entityVersion: string; sources: MemoryDependencySource[]; sequence: number }; metadata: Record<string, any>; createdAt: Date | string };
function sourceDto(memory: BrainMemory) { return { ...memory, revisionVersion: getBrainMemoryRevisionVersion(memory) }; }
function sourceIdentity(requester: BrainRequester) { return { type: requester.type, userId: requester.userId, id: requester.id, workId: requester.workId, workshopId: requester.workshopId }; }
function consumerForEntity(value: EntityValue, registry: Registry | null, fallback: BrainRequester): BrainRequester {
  if (value.entity.kind === "loop") return { type: "loop", userId: value.row.userId, id: value.entity.id, workId: value.entity.workId ?? undefined };
  const saved = dependencyObject(registry?.metadata.consumerRequester ?? registry?.metadata.requester);
  return saved.type ? { ...saved, userId: value.row.userId } as BrainRequester : fallback;
}
function registryWhere(userId: string, entityKind?: MemoryDependencyEntityKind, entityId?: string) {
  return and(eq(brainStateSnapshots.userId, userId), eq(brainStateSnapshots.snapshotType, MEMORY_DEPENDENCY_REGISTRY_TYPE),
    sql`${brainStateSnapshots.metadata}->>'source' = ${MEMORY_DEPENDENCY_SOURCE}`,
    entityKind ? sql`${brainStateSnapshots.content}->>'entityKind' = ${entityKind}` : undefined,
    entityId ? sql`${brainStateSnapshots.content}->>'entityId' = ${entityId}` : undefined);
}
function registryFromRow(row: any): Registry {
  const content = dependencyObject(row.content);
  if (!Number.isSafeInteger(content.sequence) || content.sequence < 1 || typeof content.entityVersion !== "string" || !/^bmde1:[a-f0-9]{64}$/.test(content.entityVersion))
    dependencyFail("dependency_unavailable", 503, "Dependency registry cannot be read safely");
  const target = parseMemoryDependencyEntity(content.entityKind, content.entityId);
  return { id: row.id, content: { ...target, entityVersion: content.entityVersion, sequence: content.sequence, sources: parseMemoryDependencySources(content.sources) }, metadata: dependencyObject(row.metadata), createdAt: row.createdAt };
}
async function latestRegistry(store: DrizzleDB, userId: string, kind: MemoryDependencyEntityKind, id: string): Promise<Registry | null> {
  const [row] = await store.select().from(brainStateSnapshots).where(registryWhere(userId, kind, id))
    .orderBy(desc(sql`(${brainStateSnapshots.content}->>'sequence')::bigint`), desc(brainStateSnapshots.id)).limit(1);
  return row ? registryFromRow(row) : null;
}
async function lockRegistry(store: DrizzleDB, userId: string, kind: MemoryDependencyEntityKind, id: string) {
  await acquireBrainWriteAdvisoryLock(store, JSON.stringify([MEMORY_DEPENDENCY_SOURCE, "target", userId, kind, id]));
}
async function grantsFor(store: DrizzleDB, userId: string, now: Date): Promise<BrainAccessGrant[]> {
  const rows = await store.select().from(brainAccessGrants).where(eq(brainAccessGrants.userId, userId)).for("share", { noWait: true });
  return rows.map(brainAccessGrantFromRow).filter((g: BrainAccessGrant) => !g.expiresAt || Number.isFinite(Date.parse(g.expiresAt)) && Date.parse(g.expiresAt) > now.getTime());
}
function sourceAllowed(memory: BrainMemory, requester: BrainRequester, grants: BrainAccessGrant[], now: Date) {
  // Expiry is a separate stale observation; it never restores a revoked grant.
  return canReadMemory({ memory: { ...memory, expiresAt: undefined }, requester, grants, accessMode: isDependencyHuman(requester) ? "owner_override" : "strict", now }).allowed;
}
async function readMemory(store: DrizzleDB, userId: string, id: string, lock: boolean) {
  let q = store.select().from(brainMemories).where(and(eq(brainMemories.userId, userId), eq(brainMemories.id, id)));
  if (lock) q = q.for("share", { noWait: true });
  const [row] = await q;
  return row ? brainMemoryFromRow(row) : null;
}
async function assessSource(store: DrizzleDB, input: { requester: BrainRequester; viewer?: BrainRequester; source: MemoryDependencySource; grants: BrainAccessGrant[]; now: Date; lock: boolean }): Promise<MemoryDependencySourceAssessment> {
  const { source, requester, grants, now, lock } = input;
  const readable = (memory: BrainMemory) => sourceAllowed(memory, requester, grants, now) && (!input.viewer || sourceAllowed(memory, input.viewer, grants, now));
  const saved = await readMemory(store, requester.userId, source.memoryId, lock);
  const denied = { ...source, assessment: "denied" as const, reason: "source_unavailable_or_denied" };
  if (!saved || !readable(saved)) return denied;
  const oldMemory = sourceDto(saved);
  let current = saved;
  const seen = new Set<string>();
  for (let step = 0; step < 8; step++) {
    if (seen.has(current.id)) return { ...source, oldMemory, assessment: "stale", reason: "source_history_cycle" };
    seen.add(current.id);
    const next = dependencyObject(current.metadata?.revisionRetired).nextMemoryId;
    if (current.status !== "superseded" || typeof next !== "string") {
      const currentMemory = sourceDto(current), currentVersion = currentMemory.revisionVersion;
      const [pending] = await store.select({ id: brainMemories.id }).from(brainMemories).where(and(eq(brainMemories.userId, requester.userId), eq(brainMemories.status, "candidate"),
        eq(brainMemories.ownerType, current.ownerType), eq(brainMemories.ownerId, current.ownerId),
        sql`${brainMemories.metadata}->'updateProposal'->>'status' = 'pending'`, sql`${brainMemories.metadata}->'updateProposal'->>'targetMemoryId' = ${current.id}`,
        sql`${brainMemories.metadata}->'updateProposal'->>'expectedBaseVersion' = ${currentVersion}`)).limit(1);
      return { ...source, oldMemory, currentMemory, currentVersion,
        assessment: !pending && current.id === source.memoryId && currentVersion === source.expectedVersion && memoryIsDependencyCurrent(current, now) ? "current" : "stale",
        reason: pending ? "source_update_pending" : !memoryIsDependencyCurrent(current, now) ? "source_inactive_or_expired" : current.id !== source.memoryId ? "source_replaced" : currentVersion !== source.expectedVersion ? "source_version_changed" : "source_current" };
    }
    const successor = await readMemory(store, requester.userId, next, lock);
    if (!successor || !sameIdentity(saved, successor)) return { ...source, oldMemory, assessment: "stale", reason: "source_successor_unavailable" };
    if (!readable(successor)) return denied;
    current = successor;
  }
  return { ...source, oldMemory, assessment: "stale", reason: "source_history_limit" };
}
async function assessRegistry(store: DrizzleDB, value: EntityValue, registry: Registry | null, requester: BrainRequester, now: Date, lock = true, loadedGrants?: BrainAccessGrant[]): Promise<MemoryDependencySnapshot> {
  const grants = registry ? loadedGrants ?? await grantsFor(store, requester.userId, now) : [];
  const consumer = consumerForEntity(value, registry, requester);
  const sources: MemoryDependencySourceAssessment[] = [];
  for (const source of registry?.content.sources ?? []) sources.push(await assessSource(store, { requester: consumer, viewer: requester, source, grants, now, lock }));
  const entityAvailable = value.entity.status !== "deleted" && value.entity.status !== "archived";
  const entityCurrent = entityAvailable && (!registry || value.entity.version === registry.content.entityVersion);
  const assessment = deriveMemoryDependencyAssessment({ recorded: !!registry, entityCurrent, sourceAssessments: sources.map(s => s.assessment) });
  return { entity: value.entity, coverage: registry ? "recorded" : "unknown", dependencyVersion: getMemoryDependencyRegistryVersion(registry),
    registry: registry ? { snapshotId: registry.id, sequence: registry.content.sequence, createdAt: new Date(registry.createdAt).toISOString(), reason: String(registry.metadata.reason ?? "") } : null,
    assessment, reasons: [...(!entityAvailable ? ["entity_unavailable"] : !entityCurrent ? ["entity_version_changed"] : []), ...new Set(sources.filter(s => s.assessment !== "current").map(s => s.reason)), ...(!registry ? ["dependency_coverage_unknown"] : [])], sources };
}
export async function getMemoryDependencies(input: { requester: BrainRequester; entityKind: MemoryDependencyEntityKind; entityId: string; now?: Date }): Promise<MemoryDependencySnapshot> {
  const target = parseMemoryDependencyEntity(input.entityKind, input.entityId), now = dependencyNow(input.now);
  return withDependencyLockErrors(() => db.transaction(async (store: DrizzleDB) => {
    const value = await readMemoryDependencyEntity(store, { userId: input.requester.userId, ...target }, "share");
    if (!value) dependencyFail("dependency_target_not_found", 404, "Dependency target is unavailable");
    authorizeMemoryDependencyEntity(input.requester, value);
    return assessRegistry(store, value, await latestRegistry(store, input.requester.userId, target.entityKind, target.entityId), input.requester, now);
  }));
}

/** Internal model projection: same-user Wiki rows are readable even when legacy
 * rows have no Work metadata. Source permissions still use consumer AND viewer.
 * No memory bodies or source identifiers leave this bounded summary operation. */
export async function getMemoryDependencySummariesForEntities(input: { requester: BrainRequester; entities: MemoryDependencyEntitySummaryTarget[]; now?: Date }): Promise<Record<string, MemoryDependencyEntitySummary>> {
  if (!Array.isArray(input.entities) || input.entities.length > 400) dependencyFail("invalid_dependency", 400, "Read at most 400 exact Wiki targets");
  const targets = input.entities.map(entity => {
    const target = parseMemoryDependencyEntity(entity.entityKind, entity.entityId);
    if (target.entityKind === "loop" || typeof entity.expectedEntityVersion !== "string" || !/^bmde1:[a-f0-9]{64}$/.test(entity.expectedEntityVersion))
      dependencyFail("invalid_dependency", 400, "Each Wiki target requires its loaded content version");
    return { ...target, expectedEntityVersion: entity.expectedEntityVersion };
  });
  if (new Set(targets.map(t => `${t.entityKind}:${t.entityId}`)).size !== targets.length) dependencyFail("invalid_dependency", 400, "Duplicate Wiki targets are not allowed");
  const now = dependencyNow(input.now);
  if (!targets.length) return {};
  return withDependencyLockErrors(() => db.transaction(async (store: DrizzleDB) => {
    const summaries: Record<string, MemoryDependencyEntitySummary> = {};
    let loadedGrants: BrainAccessGrant[] | undefined;
    for (const target of targets) {
      const registry = await latestRegistry(store, input.requester.userId, target.entityKind, target.entityId);
      const value = await readMemoryDependencyEntity(store, { userId: input.requester.userId, entityKind: target.entityKind, entityId: target.entityId }, "share");
      const key = `${target.entityKind}:${target.entityId}`;
      if (!value) {
        summaries[key] = { coverage: registry ? "recorded" : "unknown", assessment: "denied", reasons: ["entity_unavailable_or_denied"], entityVersion: null, dependencyVersion: getMemoryDependencyRegistryVersion(registry) };
        continue;
      }
      if (registry && !loadedGrants) loadedGrants = await grantsFor(store, input.requester.userId, now);
      const result = await assessRegistry(store, value, registry, input.requester, now, true, loadedGrants);
      const entityAvailable = value.entity.status !== "deleted" && value.entity.status !== "archived";
      const versionMatches = value.entity.version === target.expectedEntityVersion;
      summaries[key] = { coverage: result.coverage,
        assessment: result.assessment === "denied" ? "denied" : !entityAvailable || !versionMatches ? "stale" : result.assessment,
        reasons: [...new Set([...result.reasons, ...(!versionMatches ? ["entity_version_changed"] : [])])],
        entityVersion: value.entity.version, dependencyVersion: result.dependencyVersion };
    }
    return summaries;
  }));
}
export function parseMemoryDependencyBindRequest(value: unknown): MemoryDependencyBindRequest {
  const body = dependencyObject(value);
  if (Object.keys(body).some(k => !["commandId", "action", "expectedDependencyVersion", "expectedEntityVersion", "sources", "reason", "evidenceConfirmed"].includes(k)) || !["register", "rebind"].includes(body.action))
    dependencyFail("invalid_dependency", 400, "Invalid dependency command");
  if (body.evidenceConfirmed !== true) dependencyFail("dependency_evidence_confirmation_required", 400, "Explicit review of target and memory sources is required");
  if (typeof body.expectedEntityVersion !== "string" || !/^bmde1:[a-f0-9]{64}$/.test(body.expectedEntityVersion) || typeof body.expectedDependencyVersion !== "string" || body.expectedDependencyVersion !== "bmdd1:initial" && !/^bmdd1:[a-f0-9]{64}$/.test(body.expectedDependencyVersion))
    dependencyFail("invalid_dependency", 400, "Expected entity and dependency versions are required");
  return { commandId: dependencyText(body.commandId, "commandId", 200), action: body.action, expectedDependencyVersion: body.expectedDependencyVersion,
    expectedEntityVersion: body.expectedEntityVersion, sources: parseMemoryDependencySources(body.sources), reason: dependencyText(body.reason, "reason", 2000), evidenceConfirmed: true };
}
async function replayRegistry(store: DrizzleDB, userId: string, commandId: string, requestHash: string) {
  await acquireBrainWriteAdvisoryLock(store, JSON.stringify([MEMORY_DEPENDENCY_SOURCE, "command", userId, commandId]));
  const id = memoryDependencyRecordId(userId, commandId, "registry");
  const [row] = await store.select().from(brainStateSnapshots).where(and(eq(brainStateSnapshots.userId, userId), eq(brainStateSnapshots.id, id)));
  if (!row) return null;
  const meta = dependencyObject(row.metadata);
  if (row.snapshotType !== MEMORY_DEPENDENCY_REGISTRY_TYPE || meta.source !== MEMORY_DEPENDENCY_SOURCE || meta.requestHash !== requestHash)
    dependencyFail("dependency_command_conflict", 409, "commandId already identifies a different dependency command");
  return { receipt: meta.receipt as MemoryDependencyReceipt, replayed: true };
}
async function writeRegistry(store: DrizzleDB, input: { requester: BrainRequester; value: EntityValue; current: Registry | null; sources: MemoryDependencySource[]; commandId: string; action: "register" | "rebind"; reason: string; requestHash: string; now: Date }) {
  const { requester, value, current, sources, commandId, action, reason, requestHash, now } = input;
  const id = memoryDependencyRecordId(requester.userId, commandId, "registry");
  const content = { entityKind: value.entity.kind, entityId: value.entity.id, entityVersion: value.entity.version, sources, sequence: (current?.content.sequence ?? 0) + 1 };
  const receipt: MemoryDependencyReceipt = { id, commandId, action, entityKind: value.entity.kind, entityId: value.entity.id, previousDependencyVersion: getMemoryDependencyRegistryVersion(current), dependencyVersion: getMemoryDependencyRegistryVersion({ id, content }), entityVersion: value.entity.version,
    sourceVersions: sources, sequence: content.sequence, snapshotId: id, createdAt: now.toISOString() };
  await store.insert(brainStateSnapshots).values({ id, userId: requester.userId, scopeType: value.entity.workId ? "work" : "global", scopeId: value.entity.workId,
    snapshotType: MEMORY_DEPENDENCY_REGISTRY_TYPE, content, sourceMemoryIds: sources.map(s => s.memoryId),
    metadata: { source: MEMORY_DEPENDENCY_SOURCE, commandId, requestHash, action, reason, requester: sourceIdentity(requester), consumerRequester: sourceIdentity(consumerForEntity(value, current, requester)), receipt, coverage: "recorded", independentlyVerifiesCompleteness: false }, createdAt: now }).returning();
  return { receipt, replayed: false };
}
async function validateRegistrationSources(store: DrizzleDB, requester: BrainRequester, sources: MemoryDependencySource[], now: Date, consumer = requester) {
  const grants = await grantsFor(store, requester.userId, now);
  for (const source of sources) {
    const item = await assessSource(store, { requester: consumer, viewer: requester, source, grants, now, lock: true });
    if (item.assessment === "denied") dependencyFail("dependency_source_denied", 403, "A dependency source is unavailable or not authorized");
    if (item.assessment !== "current") dependencyFail("dependency_source_conflict", 409, "A dependency source changed, expired or requires review");
  }
}
export async function bindMemoryDependencies(input: { requester: BrainRequester; entityKind: MemoryDependencyEntityKind; entityId: string; request: unknown; now?: Date }) {
  if (!isDependencyHuman(input.requester)) dependencyFail("dependency_owner_review_required", 403, "Only the owner may register or review dependencies");
  const target = parseMemoryDependencyEntity(input.entityKind, input.entityId), request = parseMemoryDependencyBindRequest(input.request), now = dependencyNow(input.now);
  const requestHash = memoryDependencyDigest({ target, request, requester: sourceIdentity(input.requester) });
  return withDependencyLockErrors(() => withBrainRecordWrite(input.requester.userId, "snapshot", async store => {
    const replay = await replayRegistry(store, input.requester.userId, request.commandId, requestHash);
    if (replay) return { id: replay.receipt.id, result: replay, written: false };
    const value = await readMemoryDependencyEntity(store, { userId: input.requester.userId, ...target }, "update");
    if (!value) dependencyFail("dependency_target_not_found", 404, "Dependency target is unavailable");
    authorizeMemoryDependencyEntity(input.requester, value);
    await lockRegistry(store, input.requester.userId, target.entityKind, target.entityId);
    const current = await latestRegistry(store, input.requester.userId, target.entityKind, target.entityId);
    if (value.entity.status === "deleted" || value.entity.status === "archived") dependencyFail("dependency_target_unavailable", 409, "An unavailable target cannot be reviewed");
    if (value.entity.version !== request.expectedEntityVersion) dependencyFail("dependency_entity_conflict", 409, "Target content changed; review it again");
    if (getMemoryDependencyRegistryVersion(current) !== request.expectedDependencyVersion) dependencyFail("dependency_version_conflict", 409, "Dependency registry changed; refresh it");
    if (request.action === "register" && current) dependencyFail("dependency_already_registered", 409, "Registered targets require rebind review");
    if (request.action === "rebind" && !current) dependencyFail("dependency_not_registered", 409, "Register exact sources before review");
    if (current) {
      const assessed = await assessRegistry(store, value, current, input.requester, now);
      if (assessed.assessment === "denied") dependencyFail("dependency_source_denied", 403, "A previous dependency is no longer authorized");
      const adopted = assessed.sources.map(s => {
        if (!s.currentMemory || !s.currentVersion || !memoryIsDependencyCurrent(s.currentMemory, now)) dependencyFail("dependency_source_conflict", 409, "Restore or correct the source before reviewing its dependent target");
        return { memoryId: s.currentMemory.id, expectedVersion: s.currentVersion };
      }).sort((a, b) => a.memoryId.localeCompare(b.memoryId));
      if (adopted.length !== request.sources.length || new Set(adopted.map(s => s.memoryId)).size !== adopted.length || memoryDependencyDigest(adopted) !== memoryDependencyDigest(request.sources))
        dependencyFail("dependency_source_conflict", 409, "Rebind must preserve every recorded edge and adopt its actual current successor");
    }
    await validateRegistrationSources(store, input.requester, request.sources, now, consumerForEntity(value, current, input.requester));
    const result = await writeRegistry(store, { requester: input.requester, value, current, sources: request.sources, commandId: request.commandId, action: request.action, reason: request.reason, requestHash, now });
    return { id: result.receipt.id, result, written: true };
  }));
}
/** Internal only: target insertion and exact source capture must use the same transaction. */
export async function captureMemoryDependenciesInTransaction(store: DrizzleDB, input: { requester: BrainRequester; entityKind: MemoryDependencyEntityKind; entityId: string; sources: MemoryDependencySource[]; commandId: string; reason: string; now?: Date }) {
  return withDependencyLockErrors(async () => {
  const target = parseMemoryDependencyEntity(input.entityKind, input.entityId), sources = parseMemoryDependencySources(input.sources), commandId = dependencyText(input.commandId, "commandId", 200), reason = dependencyText(input.reason, "reason", 2000), now = dependencyNow(input.now);
  const requestHash = memoryDependencyDigest({ target, sources, commandId, reason, requester: sourceIdentity(input.requester), action: "capture" });
  const replay = await replayRegistry(store, input.requester.userId, commandId, requestHash);
  const value = await readMemoryDependencyEntity(store, { userId: input.requester.userId, ...target }, "update");
  if (!value) dependencyFail("dependency_target_not_found", 404, "Insert the target before capturing its dependencies");
  authorizeMemoryDependencyEntity(input.requester, value, true);
  if (replay) {
    await validateRegistrationSources(store, input.requester, sources, now, consumerForEntity(value, null, input.requester));
    return replay;
  }
  await lockRegistry(store, input.requester.userId, target.entityKind, target.entityId);
  const current = await latestRegistry(store, input.requester.userId, target.entityKind, target.entityId);
  if (current) dependencyFail("dependency_already_registered", 409, "Model capture cannot change or review registered dependencies");
  if (value.entity.status === "deleted" || value.entity.status === "archived") dependencyFail("dependency_target_unavailable", 409, "Target is unavailable");
  await validateRegistrationSources(store, input.requester, sources, now, consumerForEntity(value, current, input.requester));
  return writeRegistry(store, { requester: input.requester, value, current, sources, commandId, action: "register", reason, requestHash, now });
  });
}
/** Gate already registered stale/denied dependencies; legacy unknown is explicit, never verified. */
export async function assertMemoryDependenciesCurrentInTransaction(store: DrizzleDB, input: { userId: string; entityKind: MemoryDependencyEntityKind; entityId: string; now?: Date }) {
  return withDependencyLockErrors(async () => {
  const target = parseMemoryDependencyEntity(input.entityKind, input.entityId), now = dependencyNow(input.now);
  const value = await readMemoryDependencyEntity(store, { userId: input.userId, ...target }, "share");
  if (!value) dependencyFail("dependency_target_not_found", 404, "Dependency target is unavailable");
  await lockRegistry(store, input.userId, target.entityKind, target.entityId);
  const registry = await latestRegistry(store, input.userId, target.entityKind, target.entityId);
  const savedRequester = dependencyObject(registry?.metadata.consumerRequester ?? registry?.metadata.requester) as BrainRequester;
  const requester: BrainRequester = target.entityKind === "loop"
    ? { type: "loop", userId: input.userId, id: target.entityId, workId: value.entity.workId ?? undefined }
    : savedRequester.type ? { ...savedRequester, userId: input.userId } : { type: "chat", userId: input.userId, id: "brain-dependency-gate" };
  const result = await assessRegistry(store, value, registry, requester, now);
  if (result.coverage === "recorded" && result.assessment !== "current") dependencyFail("memory_dependency_stale", 409, "Recorded memory dependencies require owner review before this action");
  return { coverage: result.coverage, assessment: result.assessment, verified: result.coverage === "recorded" && result.assessment === "current", dependencyVersion: result.dependencyVersion, entityVersion: result.entity.version };
  });
}
/** No target fanout locks: the source-change ledger and source retirement commit together. */
export async function recordMemoryChangeInTransaction(store: DrizzleDB, input: { beforeMemory: BrainMemory; afterMemory: BrainMemory; replacementMemory?: BrainMemory | null; commandId: string; reason: string; now: Date; reviewId?: string }) {
  const before = input.beforeMemory, after = input.afterMemory, next = input.replacementMemory;
  if (!sameIdentity(before, after) || before.id !== after.id || next && !sameIdentity(before, next)) dependencyFail("dependency_change_invalid", 409, "Memory change must preserve user, scope and owner");
  const now = dependencyNow(input.now), id = memoryDependencyRecordId(before.userId, input.commandId, `change:${before.id}`);
  const content = { oldMemoryId: before.id, oldVersion: getBrainMemoryRevisionVersion(before), retiredVersion: getBrainMemoryRevisionVersion(after), newMemoryId: next?.id ?? null, newVersion: next ? getBrainMemoryRevisionVersion(next) : null, commandId: input.commandId, reviewId: input.reviewId ?? null, reason: input.reason };
  const [prior] = await store.select().from(brainStateSnapshots).where(and(eq(brainStateSnapshots.userId, before.userId), eq(brainStateSnapshots.id, id)));
  if (prior) {
    if (prior.snapshotType !== MEMORY_DEPENDENCY_CHANGE_TYPE || dependencyObject(prior.metadata).source !== MEMORY_DEPENDENCY_SOURCE || memoryDependencyDigest(prior.content) !== memoryDependencyDigest(content)) dependencyFail("dependency_command_conflict", 409, "Memory change ledger command conflicts");
    return { id, written: false };
  }
  const scopeId = before.scope.type === "global" ? null : before.scope.type === "work" ? before.scope.workId : before.scope.type === "workshop" ? before.scope.workshopId : before.scope.workspaceId;
  await store.insert(brainStateSnapshots).values({ id, userId: before.userId, scopeType: before.scope.type, scopeId, snapshotType: MEMORY_DEPENDENCY_CHANGE_TYPE, content,
    sourceMemoryIds: [before.id, ...(next ? [next.id] : [])], metadata: { source: MEMORY_DEPENDENCY_SOURCE, commandId: input.commandId, reviewId: input.reviewId ?? null }, createdAt: now }).returning();
  return { id, written: true };
}

export async function listMemoryDependencyImpacts(input: { requester: BrainRequester; sourceMemoryId?: string; workId?: string; limit?: number; cursor?: string; now?: Date }) {
  if (!isDependencyHuman(input.requester)) dependencyFail("dependency_not_allowed", 403, "Only the owner may inspect the dependency register");
  if (input.sourceMemoryId) parseMemoryDependencyEntity("wiki_note", input.sourceMemoryId);
  if (input.workId) parseMemoryDependencyEntity("loop", input.workId);
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 20))), now = dependencyNow(input.now);
  if (!Number.isFinite(limit)) dependencyFail("invalid_dependency", 400, "Invalid limit");
  let cursor: { kind: string; id: string } | undefined;
  if (input.cursor) {
    try { cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")); } catch { dependencyFail("invalid_dependency", 400, "Invalid cursor"); }
    const valid = parseMemoryDependencyEntity(cursor?.kind, cursor?.id); cursor = { kind: valid.entityKind, id: valid.entityId };
  }
  return withDependencyLockErrors(() => db.transaction(async (store: DrizzleDB) => {
    // Rank chooses current target registry before source filtering or page limit.
    const kind = sql<string>`${brainStateSnapshots.content}->>'entityKind'`, entityId = sql<string>`${brainStateSnapshots.content}->>'entityId'`;
    const latest = store.select({ ...getTableColumns(brainStateSnapshots), registryRank: sql<number>`row_number() over (partition by ${kind}, ${entityId} order by (${brainStateSnapshots.content}->>'sequence')::bigint desc, ${brainStateSnapshots.id} desc)`.as("registry_rank") }).from(brainStateSnapshots).where(registryWhere(input.requester.userId)).as("latest_dependency");
    const conditions = [eq(latest.registryRank, 1)];
    if (input.sourceMemoryId) conditions.push(sql`${latest.sourceMemoryIds} @> ${JSON.stringify([input.sourceMemoryId.toLowerCase()])}::jsonb`);
    if (input.workId) conditions.push(and(eq(latest.scopeType, "work"), eq(latest.scopeId, input.workId))!);
    if (cursor) conditions.push(sql`(${latest.content}->>'entityKind', ${latest.content}->>'entityId') > (${cursor.kind}, ${cursor.id})`);
    const rows: any[] = await store.select().from(latest).where(and(...conditions)).orderBy(sql`${latest.content}->>'entityKind'`, sql`${latest.content}->>'entityId'`).limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = [];
    for (const row of rows.slice(0, limit)) {
      const registry = registryFromRow(row);
      const value = await readMemoryDependencyEntity(store, { userId: input.requester.userId, entityKind: registry.content.entityKind, entityId: registry.content.entityId }, "share");
      if (!value) {
        items.push({ entity: { kind: registry.content.entityKind, id: registry.content.entityId, title: "Unavailable target", content: "", contentTruncated: false, status: "unavailable", version: registry.content.entityVersion, workId: null }, dependencyVersion: getMemoryDependencyRegistryVersion(registry), coverage: "recorded", assessment: "stale", reasons: ["entity_unavailable"] });
      } else {
        const assessed = await assessRegistry(store, value, registry, input.requester, now);
        const { sources: _sources, ...summary } = assessed;
        items.push(summary);
      }
    }
    const last = rows[Math.min(limit, rows.length) - 1];
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ kind: dependencyObject(last.content).entityKind, id: dependencyObject(last.content).entityId })).toString("base64url") : null;
    return { items, coverage: "recorded" as const, hasMore, truncated: hasMore, nextCursor };
  }));
}
