import { withMemoryRecordWrite } from "../revision/transaction";
import { getBrainMemoryRevisionVersion } from "../revision/version";
import { canReadMemory } from "../revision/policy";
import { MemoryModuleError } from "../kernel/errors";
import { MemoryWriteBusy } from "../kernel/reference-errors";
import { ExecutionLeaseError } from "@/lib/work-runtime/execution-errors";
import { readContextMemoriesForShare, readContextGrantsForShare, readContextPendingUpdates } from "../adapters/postgres/memory-records";
import { lockContextOwnerForShare, insertContextLogInTransaction } from "../adapters/postgres/context-logs";
import { contextLogProjection } from "./audit";
import { buildBrainContextPack, type BrainContextPack, type BrainContextPackItem, type BrainRecallProfile } from "./pack";
import type { BrainRequester, BrainSourceFilters } from "../kernel/memory-types";

export type FinalizeContextPackInput = {
  requester: BrainRequester; pack: BrainContextPack; taskIntent: string;
  accessMode?: "strict" | "owner_override"; sourceFilters?: BrainSourceFilters; includeCandidates?: boolean;
  applicabilityMode?: "task" | "discovery"; recallProfiles?: BrainRecallProfile[]; metadata?: Record<string, unknown>; now?: Date;
};
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function validPrefix(original: string, selected: string) {
  return typeof selected === "string" && original.startsWith(selected)
    && Array.from(original).slice(0, Array.from(selected).length).join("") === selected;
}
function uniqueOutcomes(values: Array<{ id: string; reason: string }>) {
  return [...new Map(values.map(value => [`${value.id}\u0000${value.reason}`, value])).values()];
}

/** Final admission only subtracts from the caller's selected snapshot. Every
 * physical row and grant is held through its audit and any outer query receipt.
 * Provider calls and budget clipping must happen before this short transaction. */
export async function finalizeContextPack(input: FinalizeContextPackInput): Promise<BrainContextPack> {
  try {
    const incoming = structuredClone(input.pack);
    if (!uuid.test(input.requester.userId) || input.now && !Number.isFinite(input.now.getTime()) || incoming.items.length > 256
      || incoming.items.some(item => !uuid.test(item.id))) throw new MemoryModuleError("memory_context_unavailable", 503, "Invalid context admission snapshot");
    return await withMemoryRecordWrite(input.requester.userId, "context_log", async store => {
      await lockContextOwnerForShare(store, input.requester.userId);
      const ids = [...new Set(incoming.items.map(item => item.id))].sort();
      const memories = await readContextMemoriesForShare(store, input.requester.userId, ids);
      const grants = await readContextGrantsForShare(store, input.requester.userId);
      const byId = new Map(memories.map(memory => [memory.id, memory]));
      const pending = await readContextPendingUpdates(store, input.requester.userId, ids);
      // Lock waits can outlive a source/grant TTL. Evaluate after every lock
      // has been acquired, rather than at the earlier recall/request time.
      const now = input.now ?? new Date();
      const pendingVersions = new Set(pending.map(value => { const proposal = record(record(value.metadata).updateProposal);
        return `${String(proposal.targetMemoryId)}:${String(proposal.expectedBaseVersion)}`; }));
      const denied = [...incoming.denied], omitted = [...incoming.omitted], valid: typeof memories = [];
      const inputById = new Map<string, BrainContextPackItem>();
      for (const item of incoming.items) {
        const current = byId.get(item.id);
        if (!current) { omitted.push({ id: item.id, reason: "finalization:record_unavailable" }); continue; }
        const access = canReadMemory({ memory: current, requester: input.requester, grants, accessMode: input.accessMode, now });
        if (!access.allowed) { denied.push({ id: item.id, reason: access.reason }); continue; }
        if (current.status === "deleted" || current.status === "superseded") { omitted.push({ id: item.id, reason: current.status }); continue; }
        const version = getBrainMemoryRevisionVersion(current);
        if (typeof item.revisionVersion !== "string" || item.revisionVersion !== version) {
          omitted.push({ id: item.id, reason: "finalization:version_changed" }); continue;
        }
        if (item.ownerType !== current.ownerType || item.ownerId !== current.ownerId || item.memoryType !== current.memoryType
          || item.subject !== current.subject || !validPrefix(current.content, item.content)
          || item.evidenceRefs.some(ref => !current.evidenceRefs.includes(ref))
          || item.supersedes?.some(id => !current.supersedes?.includes(id))
          || item.status !== undefined && item.status !== current.status
          || item.confidence !== undefined && item.confidence !== current.confidence
          || item.ref && (item.ref.record.kind !== "memory" || item.ref.record.id !== current.id || item.ref.revision !== version)) {
          omitted.push({ id: item.id, reason: "finalization:projection_mismatch" }); continue;
        }
        if (inputById.has(item.id)) continue;
        inputById.set(item.id, item);
        valid.push(pendingVersions.has(`${item.id}:${version}`) ? { ...current, metadata: { ...current.metadata,
          pendingMemoryUpdate: { requiresOwnerDecision: true, basis: "current_stored_version" } } } : current);
      }
      const checked = buildBrainContextPack({ memories: valid, requester: input.requester, grants, taskIntent: input.taskIntent,
        accessMode: input.accessMode, sourceFilters: input.sourceFilters, includeCandidates: input.includeCandidates,
        applicabilityMode: input.applicabilityMode ?? incoming.applicabilityMode, recallProfiles: input.recallProfiles, now, maxItems: valid.length });
      const checkedById = new Map(checked.items.map(item => [item.id, item]));
      const items: BrainContextPackItem[] = [];
      for (const original of inputById.values()) {
        const current = checkedById.get(original.id);
        if (!current || items.some(item => item.id === original.id)) continue;
        items.push({ id: current.id, revisionVersion: current.revisionVersion, ownerType: current.ownerType, ownerId: current.ownerId,
          memoryType: current.memoryType, subject: original.subject, content: original.content, confidence: current.confidence, status: current.status,
          evidenceRefs: [...original.evidenceRefs], ...(original.supersedes?.length ? { supersedes: [...original.supersedes] } : {}),
          score: Number.isFinite(original.score) ? original.score : current.score,
          reasons: [...new Set([...original.reasons, ...current.reasons, "finalized_current_version"])], freshness: current.freshness,
          warnings: [...new Set([...(original.warnings ?? []), ...(current.warnings ?? [])])], canonicalKind: current.canonicalKind,
          canonicalGroupId: current.canonicalGroupId, facets: current.facets, derivedRefs: current.derivedRefs,
          scenarioApplicability: current.scenarioApplicability, applicabilityUse: current.applicabilityUse, useSemantics: current.useSemantics });
      }
      const allowed = new Set(items.map(item => item.id));
      const warnings = [...(incoming.warnings ?? []), ...(checked.warnings ?? [])].flatMap(warning => {
        const memoryIds = warning.memoryIds.filter(id => allowed.has(id));
        return memoryIds.length || warning.memoryIds.length === 0 ? [{ ...warning, memoryIds }] : [];
      });
      if (incoming.items.some(item => !allowed.has(item.id))) warnings.push({ code: "evidence_unavailable", memoryIds: [],
        message: "Some selected memories changed or are no longer authorized/applicable. Their content was withheld; refresh authorized current sources before relying on the missing constraints or facts.", requiresCurrentObservation: true });
      const finalDenied = uniqueOutcomes([...denied, ...checked.denied]), finalOmitted = uniqueOutcomes([...omitted, ...checked.omitted]);
      const selectedCanonicalKinds: BrainContextPack["selection"]["selectedCanonicalKinds"] = {};
      for (const item of items) if (item.canonicalKind) selectedCanonicalKinds[item.canonicalKind] = (selectedCanonicalKinds[item.canonicalKind] ?? 0) + 1;
      const pack: BrainContextPack = { interfaceVersion: "brain-context.v1", applicabilityMode: checked.applicabilityMode,
        informationReadiness: undefined, items, denied: finalDenied, omitted: finalOmitted, warnings,
        selection: { selectedCount: items.length, deniedCount: finalDenied.length, omittedCount: finalOmitted.length,
          duplicateCanonicalGroupCount: finalOmitted.filter(item => item.reason === "duplicate_canonical_group").length, selectedCanonicalKinds } };
      const created = await insertContextLogInTransaction(store, contextLogProjection({ requester: input.requester, taskIntent: input.taskIntent, pack,
        metadata: { ...input.metadata, admission: { schemaVersion: "memory-context-admission.v1", checkedAt: now.toISOString(),
          previousContextLogId: incoming.contextLogId ?? null, inputMemoryVersions: incoming.items.map(item => ({ memoryId: item.id, revisionVersion: item.revisionVersion ?? null })),
          selectedCount: items.length, withheldCount: incoming.items.length - items.length, sourceFilters: input.sourceFilters ?? null } } }));
      return { id: created.id, result: { ...pack, contextLogId: created.id, items: items.map(item => ({ ...item,
        ref: { record: { kind: "memory" as const, id: item.id }, revision: item.revisionVersion! }, receipt: { id: created.id } })) } };
    });
  } catch (error) {
    if (error instanceof MemoryModuleError || error instanceof ExecutionLeaseError || error instanceof MemoryWriteBusy) throw error;
    throw new MemoryModuleError("memory_context_unavailable", 503, "Current memory context could not be verified and audited");
  }
}
