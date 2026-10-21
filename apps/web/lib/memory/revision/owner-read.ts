import { createHash, randomUUID } from "node:crypto";
import { withRevisionStateRead, readRevisionMemoryForShare, appendRevisionStateReadReceipt } from "../adapters/postgres/revision-state";
import { memoryInvalid, MemoryModuleError } from "../kernel/errors";
import { stableJson } from "../records/observations";
import { getBrainMemoryCanonicalMetadata } from "./canonical";
import { getBrainMemoryRevisionVersion } from "./version";
import { canReadMemory } from "./policy";
import { getMemoryDependenciesInTransaction, type MemoryDependencySnapshot } from "./dependency-check";
import type { BrainMemory } from "../kernel/memory-types";
import type { CurrentMemoryDependenciesRecord, MemoryResultMeta, RevisionStateRecordRef, RevisionStateReadResult, RevisionStateVersionRef } from "../contracts";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function parseRef(value: unknown): RevisionStateRecordRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) memoryInvalid("A typed revision reference is required");
  const ref = value as Record<string, unknown>;
  if (ref.kind === "memory") {
    if (Object.keys(ref).some(key => !["kind", "id"].includes(key)) || typeof ref.id !== "string" || !uuid.test(ref.id)) memoryInvalid("Invalid memory reference");
    return { kind: "memory", id: ref.id.toLowerCase() };
  }
  if (ref.kind !== "memory_dependencies" || Object.keys(ref).some(key => !["kind", "entityKind", "entityId"].includes(key))
    || typeof ref.entityKind !== "string" || !["wiki_note", "interaction_task", "loop"].includes(ref.entityKind) || typeof ref.entityId !== "string" || !uuid.test(ref.entityId))
    memoryInvalid("Invalid memory dependency reference");
  return { kind: "memory_dependencies", entityKind: ref.entityKind as "wiki_note" | "interaction_task" | "loop", entityId: ref.entityId.toLowerCase() };
}
function sameCanonicalIdentity(root: BrainMemory, current: BrainMemory) {
  const before = getBrainMemoryCanonicalMetadata(root), after = getBrainMemoryCanonicalMetadata(current);
  return root.userId === current.userId && root.ownerType === current.ownerType && root.ownerId === current.ownerId
    && stableJson(root.scope) === stableJson(current.scope)
    && before.canonicalKind === after.canonicalKind && before.canonicalGroupId === after.canonicalGroupId;
}
function redactedDependencies(snapshot: MemoryDependencySnapshot): CurrentMemoryDependenciesRecord {
  const denied = snapshot.assessment === "denied";
  return { ...snapshot, id: `${snapshot.entity.kind}:${snapshot.entity.id}`,
    entity: denied ? { ...snapshot.entity, title: "", content: "", contentTruncated: true } : snapshot.entity,
    registry: denied && snapshot.registry ? { ...snapshot.registry, reason: "" } : snapshot.registry,
    sources: snapshot.sources.map(source => {
      if (!denied && source.assessment !== "denied") return source;
      const { oldMemory: _old, currentMemory: _current, ...edge } = source;
      return edge;
    }),
    verified: snapshot.coverage === "recorded" && snapshot.assessment === "current",
  };
}
function mapReadError(error: unknown): never {
  if (error instanceof MemoryModuleError) throw error;
  const value = error as { code?: unknown; status?: unknown; message?: unknown };
  if (typeof value?.code === "string" && typeof value.status === "number" && value.status >= 400 && value.status < 500)
    throw new MemoryModuleError(value.code, value.status, typeof value.message === "string" ? value.message : "Memory read rejected");
  throw error;
}

/** The public client has already required an authenticated owner and rejected
 * Work capabilities. This reader never issues an action grant or a verification. */
export async function readOwnerRevisionState(userId: string, value: unknown): Promise<RevisionStateReadResult> {
  const target = parseRef(value);
  const meta: MemoryResultMeta = { traceId: randomUUID(), contractVersion: "memory-revision.v1", implementationVersion: "memory-t3.v1",
    provider: "postgres", detail: "exact_current_revision_state", warnings: [] };
  try { return await withRevisionStateRead<RevisionStateReadResult>(userId, async store => {
    if (target.kind === "memory") {
      const root = await readRevisionMemoryForShare(store, userId, target.id);
      if (!root) return { status: "not_found", code: "memory_not_found", meta };
      let current = root;
      const seen = new Set<string>();
      for (let hop = 0; hop <= 8; hop++) {
        if (seen.has(current.id) || !sameCanonicalIdentity(root, current)) return { status: "unavailable", code: "memory_history_unavailable", meta };
        seen.add(current.id);
        const retired = current.metadata?.revisionRetired;
        const next = retired && typeof retired === "object" && !Array.isArray(retired)
          ? (retired as Record<string, unknown>).nextMemoryId : undefined;
        if (current.status !== "superseded") {
          if (typeof next === "string") return { status: "unavailable", code: "memory_history_unavailable", meta };
          if (!canReadMemory({ memory: current, requester: { type: "chat", userId, id: "memory-owner-api" }, accessMode: "owner_override" }).allowed)
            return { status: "unavailable", code: "memory_read_denied", meta };
          const revision = getBrainMemoryRevisionVersion(current), ref: RevisionStateVersionRef = { record: target, revision };
          const record = { ...current, revisionVersion: revision };
          const receipt = await appendRevisionStateReadReceipt(store, { userId, ref, locator: { kind: "memory", id: current.id, rootId: target.id }, meta });
          meta.warnings.push("A current memory record is a saved interpretation, not independent business verification or action permission");
          if (!["active", "verified"].includes(current.status)) meta.warnings.push(`Current memory status is ${current.status}; it is not an effective verified fact`);
          return { status: "ok", record, ref, receipt, meta };
        }
        if (hop === 8 || typeof next !== "string" || !uuid.test(next)) return { status: "unavailable", code: "memory_history_unavailable", meta };
        const successor = await readRevisionMemoryForShare(store, userId, next.toLowerCase());
        if (!successor) return { status: "unavailable", code: "memory_history_unavailable", meta };
        current = successor;
      }
      return { status: "unavailable", code: "memory_history_unavailable", meta };
    }
    let snapshot: MemoryDependencySnapshot;
    try { snapshot = await getMemoryDependenciesInTransaction(store, { requester: { type: "chat", userId, id: "memory-owner-api" },
      entityKind: target.entityKind, entityId: target.entityId }); }
    catch (error) {
      if ((error as { code?: unknown })?.code === "dependency_target_not_found") return { status: "not_found", code: "memory_dependencies_not_found", meta };
      throw error;
    }
    const record = redactedDependencies(snapshot);
    const revision = `mdeprv1:${createHash("sha256").update(stableJson(record)).digest("hex")}`;
    const ref: RevisionStateVersionRef = { record: target, revision };
    const receipt = await appendRevisionStateReadReceipt(store, { userId, ref,
      locator: { kind: "memory_dependencies", entityKind: target.entityKind, entityId: target.entityId, registrySnapshotId: record.registry?.snapshotId ?? null }, meta });
    meta.warnings.push("Dependency assessment describes saved version and access bindings; it does not independently verify business facts or grant action permission");
    if (record.assessment === "unknown") meta.warnings.push("Dependency coverage is unknown and has not been verified");
    if (record.assessment === "denied") meta.warnings.push("Denied dependency content has been withheld");
    return { status: "ok", record, ref, receipt, meta };
  }); } catch (error) { return mapReadError(error); }
}
