import { getBrainMemoryById as getBrainMemory } from "@/lib/memory/adapters/postgres/memory-records";
import { listBrainAccessGrantsForUser as listBrainGrants } from "@/lib/memory/adapters/postgres/memory-records";
import { resolveEvidenceRefs as resolveBrainEvidenceRefs } from "@/lib/memory/evidence/reader";
import type { ResolvedEvidence as BrainResolvedEvidence } from "@/lib/memory/evidence/types";
import { admitExactMemoryUse } from "@/lib/memory/context/exact-use";
import { workMemorySourceFilters } from "@/lib/memory/kernel/runtime-applicability";
import { getBrainMemoryRevisionVersion } from "@/lib/memory/revision/version";
import { canReadMemory } from "@/lib/memory/revision/policy";
import { createWorkshopBrainRequester } from "@/lib/memory/records/workshop-memory";
import { getInteractionEventsByIds } from "@/lib/interactions/service";
import { getWorkshopEvent, getWorkshopMemory } from "./service";
import type { BrainMemory } from "@/lib/memory/kernel/memory-types";
import { admitHostSourceRows } from "@/lib/memory/sources/host-context";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const observationPrefix = "brain-observation:";
const realDependencies = () => ({ getBrainMemory, listBrainGrants, resolveBrainEvidenceRefs, getInteractionEventsByIds, getWorkshopEvent, getWorkshopMemory });
type Dependencies = ReturnType<typeof realDependencies>;
type Resolution = { id: string; status: "resolved" | "unresolved"; provider: string; warning?: string };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Only canonical references of an authorized memory may select evidence. Typed
 * observation refs never reach UUID event queries, even when a source is down. */
export async function readWorkshopMemoryEvidence(input: {
  workshop: { id: string; userId: string; modelConfig?: unknown }; memoryId: string; maxEvents?: number;
}, dependencies: Dependencies = realDependencies()) {
  const warnings: string[] = [];
  const unavailable = (error: string, warning?: string) => ({ status: "unavailable" as const,
    provider: "workshop_memory_evidence", error, memoryId: input.memoryId,
    warnings: [...warnings, ...(warning ? [warning] : [])] });
  if (!uuid.test(input.memoryId)) return unavailable("Invalid memory identifier", "invalid_memory_id");
  const maxEvents = Number.isSafeInteger(input.maxEvents) ? Math.min(50, Math.max(1, input.maxEvents!)) : 10;
  const requester = createWorkshopBrainRequester(input.workshop);
  const sourceFilters = workMemorySourceFilters(input.workshop.modelConfig);
  let grants: ReturnType<typeof listBrainGrants> | undefined;
  const readable = async (target: BrainMemory) => {
    const access = canReadMemory({ memory: target, requester });
    if (access.allowed || access.reason === "wrong_user" || access.reason === "expired") return access.allowed;
    grants ??= dependencies.listBrainGrants({ userId: input.workshop.userId });
    return canReadMemory({ memory: target, requester, grants: await grants }).allowed;
  };
  let memory: Awaited<ReturnType<typeof getWorkshopMemory>> | BrainMemory = null;
  let memoryBackend: "legacy" | "brain" = "legacy";
  try { memory = await dependencies.getWorkshopMemory(input.workshop.id, input.memoryId); }
  catch { warnings.push("legacy_memory_reader_unavailable"); }
  if (!memory) {
    let brainMemory: BrainMemory | null;
    try { brainMemory = await dependencies.getBrainMemory({ userId: input.workshop.userId, memoryId: input.memoryId }); }
    catch { return unavailable("Memory source unavailable", "brain_memory_reader_unavailable"); }
    if (!brainMemory) return unavailable("Workshop memory not found");
    try {
      if (!await readable(brainMemory)) return unavailable("Workshop memory not found or not permitted", "memory_access_denied");
    } catch { return unavailable("Memory access could not be verified", "brain_access_reader_unavailable"); }
    memory = brainMemory;
    memoryBackend = "brain";
    try { await admitExactMemoryUse({ requester, sourceFilters, purpose: "workshop_get_memory_evidence", memories: [brainMemory] }); }
    catch { return unavailable("memory_exact_use_unavailable", "memory_access_or_audit_unavailable"); }
  }
  if (memoryBackend === 'legacy') {
    try { await admitHostSourceRows({ requester, sourceFilters, purpose: 'workshop_legacy_memory_evidence' }, 'workshopMemories', [memory]); }
    catch { return unavailable('memory_source_unavailable', 'legacy_source_access_or_version_unavailable'); }
  }

  const refs = [...new Set((memoryBackend === "brain" ? (memory as BrainMemory).evidenceRefs
    : (memory as NonNullable<Awaited<ReturnType<typeof getWorkshopMemory>>>).sourceEventIds).filter(ref => typeof ref === "string"))];
  const selected = refs.slice(0, maxEvents);
  const resolution = new Map<string, Resolution>(selected.map(id => [id, { id, status: "unresolved", provider: "unknown",
    warning: uuid.test(id) ? "evidence_not_found" : id.startsWith(observationPrefix) ? "invalid_observation_reference" : "unsupported_evidence_reference" }]));
  const eventIds = selected.filter(id => uuid.test(id));
  const workshopEvents: NonNullable<Awaited<ReturnType<typeof getWorkshopEvent>>>[] = [];
  await Promise.all(eventIds.map(async eventId => {
    try {
      const event = await dependencies.getWorkshopEvent(input.workshop.id, eventId);
      if (event && event.id === eventId && event.workshopId === input.workshop.id) {
        await admitHostSourceRows({ requester, sourceFilters, purpose: 'workshop_memory_raw_evidence' }, 'workshopEvents', [event]);
        workshopEvents.push(event);
        resolution.set(eventId, { id: eventId, status: "resolved", provider: "workshop_event" });
      }
    } catch { warnings.push("workshop_event_reader_unavailable"); }
  }));
  let interactionEvents: Awaited<ReturnType<typeof getInteractionEventsByIds>> = [];
  if (eventIds.length) {
    try {
      interactionEvents = (await dependencies.getInteractionEventsByIds({ userId: input.workshop.userId, ids: eventIds }))
        .filter(event => eventIds.includes(event.id) && event.userId === input.workshop.userId);
      await admitHostSourceRows({ requester, sourceFilters, purpose: 'workshop_memory_raw_evidence' }, 'interactionEvents', interactionEvents);
      for (const event of interactionEvents) resolution.set(event.id, { id: event.id, status: "resolved", provider: "interaction_event" });
    } catch { interactionEvents = []; warnings.push("interaction_event_scope_or_source_unavailable"); }
  }
  const observationRefs = selected.filter(ref => ref.startsWith(observationPrefix) && uuid.test(ref.slice(observationPrefix.length)));
  let brainEvidence: BrainResolvedEvidence[] = [];
  if (observationRefs.length && memoryBackend === "brain") {
    const brainMemory = memory as BrainMemory;
    try {
      const readEvidence = await dependencies.resolveBrainEvidenceRefs({ userId: input.workshop.userId, evidenceRefs: observationRefs,
        ownerHintsByRef: new Map(observationRefs.map(ref => [ref, [{ ownerType: brainMemory.ownerType, ownerId: brainMemory.ownerId }]])),
        modelPolicy: { requester, sourceFilters, purpose: 'workshop_typed_observation_evidence' },
        modelMemoryIdsByRef: new Map(observationRefs.map(ref => [ref, [brainMemory.id]])) });
      for (const ref of observationRefs) {
        const evidence = readEvidence.find(item => item.id === ref && item.source === "brain_observation" && item.status === "resolved");
        if (!evidence || typeof evidence.content !== "string") {
          resolution.set(ref, { id: ref, status: "unresolved", provider: "brain_observation", warning: "evidence_not_found" });
          continue;
        }
        // Observations are tenant-only records. A readable memory's reference
        // does not grant access to a different work's raw owner submission.
        // Revision/correction observations identify the canonical target memory;
        // authorize that actual target independently before exposing the body.
        const targetMemoryId = object(evidence.metadata.provenance).memoryId;
        if (typeof targetMemoryId !== "string" || !uuid.test(targetMemoryId)) {
          resolution.set(ref, { id: ref, status: "unresolved", provider: "brain_observation", warning: "observation_scope_unavailable" });
          continue;
        }
        try {
          const target = targetMemoryId === brainMemory.id ? brainMemory : await dependencies.getBrainMemory({ userId: input.workshop.userId, memoryId: targetMemoryId });
          if (!target || !await readable(target)) {
            resolution.set(ref, { id: ref, status: "unresolved", provider: "brain_observation", warning: "observation_access_denied" });
            continue;
          }
          brainEvidence.push(evidence);
          resolution.set(ref, { id: ref, status: "resolved", provider: "brain_observation" });
        } catch {
          warnings.push("observation_access_reader_unavailable");
          resolution.set(ref, { id: ref, status: "unresolved", provider: "brain_observation", warning: "observation_access_unavailable" });
        }
      }
    } catch {
      warnings.push("brain_evidence_reader_unavailable");
      for (const ref of observationRefs) resolution.set(ref, { id: ref, status: "unresolved", provider: "brain_observation", warning: "evidence_reader_unavailable" });
    }
  } else if (observationRefs.length) {
    for (const ref of observationRefs) resolution.set(ref, { id: ref, status: "unresolved", provider: "brain_observation", warning: "canonical_brain_memory_required" });
  }
  const evidenceResolution = selected.map(ref => resolution.get(ref)!);
  const unresolvedSourceEventIds = evidenceResolution.filter(item => item.status !== "resolved").map(item => item.id);
  const resolvedCount = evidenceResolution.length - unresolvedSourceEventIds.length;
  if (unresolvedSourceEventIds.length) warnings.push("some_memory_evidence_unresolved");
  if (refs.length > selected.length) warnings.push("memory_evidence_limit_reached");
  return { status: "read" as const, provider: "workshop_memory_evidence", memoryBackend, memory,
    ...(memoryBackend === "brain" ? { sourceIdentity: { memoryId: memory.id,
      sourceVersion: getBrainMemoryRevisionVersion(memory as BrainMemory) } } : {}),
    workshopEvents, interactionEvents, brainEvidence, evidenceResolution, unresolvedSourceEventIds,
    evidenceCount: resolvedCount, resolvedCount, unresolvedCount: unresolvedSourceEventIds.length,
    evidenceCoverage: { totalRefs: refs.length, requested: selected.length, notChecked: refs.length - selected.length },
    warnings: [...new Set(warnings)] };
}
