import { db } from "@/lib/db/client";
import type { DrizzleDB } from "@/lib/db/types";
import { canReadMemory } from "@/lib/memory/revision/policy";
import { getBrainMemoryRevisionVersion } from "@/lib/memory/revision/version";
import { acquireBrainWriteAdvisoryLock } from "@/lib/memory/revision/locks";
import { sameIdentity } from "@/lib/memory/revision/common";
import { MemoryWriteBusy as BrainMemoryWriteBusy } from "@/lib/memory/kernel/reference-errors";
import type { BrainAccessGrant, BrainMemory, BrainRequester } from "@/lib/memory/kernel/memory-types";
import { latestRegistry, grantsFor, readMemory, hasPendingDependencyUpdate, type Registry } from "@/lib/memory/adapters/postgres/dependencies";
import { authorizeMemoryDependencyEntity, readMemoryDependencyEntity, type MemoryDependencyEntity } from "@/lib/memory/revision/dependencies-entity";
import { dependencyFail, dependencyNow, dependencyObject, deriveMemoryDependencyAssessment, getMemoryDependencyRegistryVersion, isDependencyHuman,
  memoryIsDependencyCurrent, MEMORY_DEPENDENCY_SOURCE, parseMemoryDependencyEntity,
  type MemoryDependencyAssessment, type MemoryDependencyEntityKind, type MemoryDependencySource } from "@/lib/memory/revision/dependencies-common";

/** Read/gate implementation intentionally does not import the write transaction. */
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
export async function withDependencyLockErrors<T>(operation: () => Promise<T>): Promise<T> {
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
function sourceDto(memory: BrainMemory) { return { ...memory, revisionVersion: getBrainMemoryRevisionVersion(memory) }; }
export function sourceIdentity(requester: BrainRequester) { return { type: requester.type, userId: requester.userId, id: requester.id, workId: requester.workId, workshopId: requester.workshopId }; }
export function consumerForEntity(value: EntityValue, registry: Registry | null, fallback: BrainRequester): BrainRequester {
  if (value.entity.kind === "loop") return { type: "loop", userId: value.row.userId, id: value.entity.id, workId: value.entity.workId ?? undefined };
  const saved = dependencyObject(registry?.metadata.consumerRequester ?? registry?.metadata.requester);
  return saved.type ? { ...saved, userId: value.row.userId } as BrainRequester : fallback;
}
export async function lockRegistry(store: DrizzleDB, userId: string, kind: MemoryDependencyEntityKind, id: string) {
  await acquireBrainWriteAdvisoryLock(store, JSON.stringify([MEMORY_DEPENDENCY_SOURCE, "target", userId, kind, id]));
}
function sourceAllowed(memory: BrainMemory, requester: BrainRequester, grants: BrainAccessGrant[], now: Date) {
  // Expiry is a separate stale observation; it never restores a revoked grant.
  return canReadMemory({ memory: { ...memory, expiresAt: undefined }, requester, grants, accessMode: isDependencyHuman(requester) ? "owner_override" : "strict", now }).allowed;
}
export async function assessSource(store: DrizzleDB, input: { requester: BrainRequester; viewer?: BrainRequester; source: MemoryDependencySource; grants: BrainAccessGrant[]; now: Date; lock: boolean }): Promise<MemoryDependencySourceAssessment> {
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
      const pending = await hasPendingDependencyUpdate(store, requester.userId, current, currentVersion);
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
export async function assessRegistry(store: DrizzleDB, value: EntityValue, registry: Registry | null, requester: BrainRequester, now: Date, lock = true, loadedGrants?: BrainAccessGrant[]): Promise<MemoryDependencySnapshot> {
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
export async function getMemoryDependenciesInTransaction(store: DrizzleDB, input: { requester: BrainRequester; entityKind: MemoryDependencyEntityKind; entityId: string; now?: Date }): Promise<MemoryDependencySnapshot> {
  const target = parseMemoryDependencyEntity(input.entityKind, input.entityId), now = dependencyNow(input.now);
  return withDependencyLockErrors(async () => {
    const value = await readMemoryDependencyEntity(store, { userId: input.requester.userId, ...target }, "share");
    if (!value) dependencyFail("dependency_target_not_found", 404, "Dependency target is unavailable");
    authorizeMemoryDependencyEntity(input.requester, value);
    return assessRegistry(store, value, await latestRegistry(store, input.requester.userId, target.entityKind, target.entityId), input.requester, now);
  });
}
export async function getMemoryDependencies(input: { requester: BrainRequester; entityKind: MemoryDependencyEntityKind; entityId: string; now?: Date }): Promise<MemoryDependencySnapshot> {
  return withDependencyLockErrors(() => db.transaction((store: DrizzleDB) => getMemoryDependenciesInTransaction(store, input)));
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
