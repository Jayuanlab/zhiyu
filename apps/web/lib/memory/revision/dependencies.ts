import { db } from "@/lib/db/client";
import type { DrizzleDB } from "@/lib/db/types";
import type { BrainMemory, BrainRequester } from "../kernel/memory-types";
import { getBrainMemoryRevisionVersion } from "./version";
import { acquireBrainWriteAdvisoryLock } from "./locks";
import { sameIdentity } from "./common";
import { withMemoryRecordWrite } from "./transaction";
import { readDependencySnapshot, appendDependencySnapshot, listLatestDependencyRegistryRows, latestRegistry, registryFromRow, grantsFor, type Registry } from "../adapters/postgres/dependencies";
import { authorizeMemoryDependencyEntity, readMemoryDependencyEntity } from "./dependencies-entity";
import { withDependencyLockErrors, sourceIdentity, consumerForEntity, lockRegistry, assessSource, assessRegistry,
  type MemoryDependencyReceipt, type MemoryDependencyBindRequest } from "./dependency-check";
import { dependencyFail, dependencyNow, dependencyObject, dependencyText, getMemoryDependencyRegistryVersion, isDependencyHuman,
  memoryDependencyDigest, memoryDependencyRecordId, memoryIsDependencyCurrent, MEMORY_DEPENDENCY_CHANGE_TYPE, MEMORY_DEPENDENCY_REGISTRY_TYPE, MEMORY_DEPENDENCY_SOURCE,
  parseMemoryDependencyEntity, parseMemoryDependencySources, type MemoryDependencyEntityKind, type MemoryDependencySource } from "./dependencies-common";
export * from "./dependencies-common";
export { getMemoryDependencies, getMemoryDependenciesInTransaction, getMemoryDependencySummariesForEntities, assertMemoryDependenciesCurrentInTransaction } from "./dependency-check";
export type { MemoryDependencySourceAssessment, MemoryDependencySnapshot, MemoryDependencyReceipt, MemoryDependencyBindRequest,
  MemoryDependencyEntitySummary, MemoryDependencyEntitySummaryTarget } from "./dependency-check";
type EntityValue = NonNullable<Awaited<ReturnType<typeof readMemoryDependencyEntity>>>;

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
  const row = await readDependencySnapshot(store, userId, id);
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
  await appendDependencySnapshot(store, { id, userId: requester.userId, scopeType: value.entity.workId ? "work" : "global", scopeId: value.entity.workId,
    snapshotType: MEMORY_DEPENDENCY_REGISTRY_TYPE, content, sourceMemoryIds: sources.map(s => s.memoryId),
    metadata: { source: MEMORY_DEPENDENCY_SOURCE, commandId, requestHash, action, reason, requester: sourceIdentity(requester), consumerRequester: sourceIdentity(consumerForEntity(value, current, requester)), receipt, coverage: "recorded", independentlyVerifiesCompleteness: false }, createdAt: now });
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
  return withDependencyLockErrors(() => withMemoryRecordWrite(input.requester.userId, "snapshot", async store => {
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
/** No target fanout locks: the source-change ledger and source retirement commit together. */
export async function recordMemoryChangeInTransaction(store: DrizzleDB, input: { beforeMemory: BrainMemory; afterMemory: BrainMemory; replacementMemory?: BrainMemory | null; commandId: string; reason: string; now: Date; reviewId?: string }) {
  const before = input.beforeMemory, after = input.afterMemory, next = input.replacementMemory;
  if (!sameIdentity(before, after) || before.id !== after.id || next && !sameIdentity(before, next)) dependencyFail("dependency_change_invalid", 409, "Memory change must preserve user, scope and owner");
  const now = dependencyNow(input.now), id = memoryDependencyRecordId(before.userId, input.commandId, `change:${before.id}`);
  const content = { oldMemoryId: before.id, oldVersion: getBrainMemoryRevisionVersion(before), retiredVersion: getBrainMemoryRevisionVersion(after), newMemoryId: next?.id ?? null, newVersion: next ? getBrainMemoryRevisionVersion(next) : null, commandId: input.commandId, reviewId: input.reviewId ?? null, reason: input.reason };
  const prior = await readDependencySnapshot(store, before.userId, id);
  if (prior) {
    if (prior.snapshotType !== MEMORY_DEPENDENCY_CHANGE_TYPE || dependencyObject(prior.metadata).source !== MEMORY_DEPENDENCY_SOURCE || memoryDependencyDigest(prior.content) !== memoryDependencyDigest(content)) dependencyFail("dependency_command_conflict", 409, "Memory change ledger command conflicts");
    return { id, written: false };
  }
  const scopeId = before.scope.type === "global" ? null : before.scope.type === "work" ? before.scope.workId : before.scope.type === "workshop" ? before.scope.workshopId : before.scope.workspaceId;
  await appendDependencySnapshot(store, { id, userId: before.userId, scopeType: before.scope.type, scopeId, snapshotType: MEMORY_DEPENDENCY_CHANGE_TYPE, content,
    sourceMemoryIds: [before.id, ...(next ? [next.id] : [])], metadata: { source: MEMORY_DEPENDENCY_SOURCE, commandId: input.commandId, reviewId: input.reviewId ?? null }, createdAt: now });
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
    const rows = await listLatestDependencyRegistryRows(store, { userId: input.requester.userId, sourceMemoryId: input.sourceMemoryId, workId: input.workId }, limit, cursor);
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
