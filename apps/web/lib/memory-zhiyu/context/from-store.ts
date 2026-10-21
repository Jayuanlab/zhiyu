import { deserializeJson } from "@/lib/db/serialization";
import { listBrainAccessGrantsForUser } from "@/lib/memory/adapters/postgres/memory-records";
import { listBrainMemoriesForUser, normalizeMemorySearchTerms } from "@/lib/memory/retrieval/candidates";
import { getBrainMemoryCanonicalMetadata, type BrainCanonicalKind } from "@/lib/memory/kernel/memory-canonical";
import { buildBrainContextPack, type BrainContextPack, type BrainRecallProfile } from "@/lib/memory/context/pack";
import { insertBrainContextLog } from "@/lib/memory/context/audit";
import { readBrainRetirementSignals } from "@/lib/memory/context/retirement-signals";
import type { BrainAccessGrant, BrainMemory, BrainMemoryStatus, BrainMemoryType, BrainRequester, BrainSourceFilters, BrainScope } from "@/lib/memory/kernel/memory-types";

function jsonRecord(value: unknown): Record<string, unknown> {
  const parsed = deserializeJson(value as Parameters<typeof deserializeJson>[0]);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
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

const OWNER_CORRECTION_RESERVE_LIMIT = 30;
const OWNER_CORRECTION_RESERVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
async function currentOwnerCorrectionReserve(input: {
  enabled: boolean; requester: BrainRequester; taskIntent: string; grants: BrainAccessGrant[];
  now?: Date; recallProfiles?: BrainRecallProfile[]; sourceFilters?: BrainSourceFilters;
}) {
  const now = input.now ?? new Date();
  const workId = input.requester.type === 'work' ? input.requester.id : input.requester.type === 'loop' ? input.requester.workId : undefined;
  const trace = { schemaVersion: 'brain-owner-correction-reserve.v1', enabled: input.enabled,
    scope: 'own_work_recent_applied_owner_corrections', workId: workId ?? null, checkedAt: now.toISOString(),
    windowStartedAt: new Date(now.getTime() - OWNER_CORRECTION_RESERVE_WINDOW_MS).toISOString(), limit: OWNER_CORRECTION_RESERVE_LIMIT,
    ignoredAdvisoryFilters: ['minConfidence', 'memoryTypes', 'canonicalKinds', 'searchTerms', 'updatedAfter', 'plannerScopes'],
    fetchedCount: 0, relatedCountBeforeLimit: 0, maxReservedCorrections: 2, relatedMemoryIds: [] as string[] };
  if (!input.enabled || !workId || !['work', 'loop'].includes(input.requester.type)) return { memories: [] as BrainMemory[], trace };
  if (input.requester.workshopId && input.requester.workshopId !== workId) throw Error('brain_owner_correction_scope_invalid');
  let candidates: BrainMemory[];
  try {
    candidates = await listBrainMemoriesForUser({ userId: input.requester.userId, ownerType: 'work', ownerId: workId,
      statuses: ['active', 'verified'], scopes: [{ type: 'work', workId }, { type: 'workshop', workshopId: workId }],
      updatedAfter: new Date(trace.windowStartedAt), ownerCorrectionsOnly: true, limit: OWNER_CORRECTION_RESERVE_LIMIT + 1 });
  } catch {
    throw Error('brain_owner_correction_reserve_unavailable');
  }
  if (candidates.length > OWNER_CORRECTION_RESERVE_LIMIT) throw Error('brain_owner_correction_reserve_too_many');
  trace.fetchedCount = candidates.length;
  const ownCurrent = candidates.filter(memory => {
    const revision = jsonRecord(memory.metadata?.revision);
    const revisedAt = Date.parse(String(revision.createdAt ?? ''));
    return memory.userId === input.requester.userId && memory.ownerType === 'work' && memory.ownerId === workId
      && (memory.scope.type === 'work' && memory.scope.workId === workId || memory.scope.type === 'workshop' && memory.scope.workshopId === workId)
      && ['active', 'verified'].includes(memory.status) && revision.operation === 'correct' && revision.authority === 'owner_statement'
      && revision.reviewStatus === 'applied' && Number.isFinite(revisedAt)
      && revisedAt >= Date.parse(trace.windowStartedAt) && revisedAt <= now.getTime();
  });
  // Reuse actual source/privacy/access checks and the existing relevance scorer.
  // An unrelated owner statement cannot become relevant merely by bypassing a
  // planner's confidence or type suggestion. The final pack still reserves at
  // most two recent revisions and never changes stored status or confidence.
  const probe = buildBrainContextPack({ memories: ownCurrent, requester: input.requester, grants: input.grants,
    taskIntent: input.taskIntent, sourceFilters: input.sourceFilters, recallProfiles: input.recallProfiles,
    now, maxItems: OWNER_CORRECTION_RESERVE_LIMIT, includeCandidates: false });
  const relatedCandidates = probe.items.filter(item => item.reasons.includes('relevant_recent_revision'));
  trace.relatedCountBeforeLimit = relatedCandidates.length;
  trace.relatedMemoryIds = relatedCandidates.slice(0, trace.maxReservedCorrections).map(item => item.id);
  const related = new Set(trace.relatedMemoryIds);
  return { memories: ownCurrent.filter(memory => related.has(memory.id)), trace };
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
  /** Enabled only by trusted low/normal-risk callers, never by model filters. */
  reserveCurrentOwnerCorrections?: boolean;
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
    reserveRevisions: true,
    includePendingUpdates: true,
    statuses,
    memoryTypes: input.memoryTypes,
    scopes,
    minConfidence: input.minConfidence,
    updatedAfter: input.updatedAfter,
    searchTerms: input.searchTerms,
    canonicalKinds: input.canonicalKinds,
  });
  // Planner-selected active statuses cannot reveal a retirement without a replacement.
  // Read only bounded identities in this requester's own Work; failure must reach
  // the caller's explicit unavailable-Brain path rather than imply no correction.
  const retirementSignal = await readBrainRetirementSignals({ requester: input.requester, grants, now: input.now });
  const canonicalKinds = input.canonicalKinds ?? [];
  const filteredMemories = canonicalKinds.length
    ? memories.filter((memory) =>
        canonicalKinds.includes(
          getBrainMemoryCanonicalMetadata(memory).canonicalKind,
        ),
      )
    : memories;
  const ownerCorrectionReserve = await currentOwnerCorrectionReserve({ enabled: input.reserveCurrentOwnerCorrections === true,
    requester: input.requester, grants, taskIntent: input.taskIntent, now: input.now,
    recallProfiles: input.recallProfiles, sourceFilters: input.sourceFilters });
  const combinedMemories = [...new Map([...filteredMemories, ...ownerCorrectionReserve.memories].map(memory => [memory.id, memory])).values()];
  const selectedPack = buildBrainContextPack({
    memories: combinedMemories,
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
  const omitted = [...new Map([...selectedPack.omitted, ...retirementSignal.retired].map(item => [item.id, item])).values()];
  const ownerFeedbackIds = new Set(ownerCorrectionReserve.trace.relatedMemoryIds);
  const pack: BrainContextPack = { ...selectedPack, omitted,
    items: selectedPack.items.map(item => ownerFeedbackIds.has(item.id) ? { ...item,
      warnings: [...new Set([...(item.warnings ?? []), 'owner_statement_control_feedback_not_verified_fact' as const])] } : item),
    selection: { ...selectedPack.selection, omittedCount: omitted.length } };
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
      combinedCandidateCount: combinedMemories.length,
      retirementSignal,
      ownerCorrectionReserve: { ...ownerCorrectionReserve.trace,
        selectedMemoryIds: pack.items.filter(item => ownerFeedbackIds.has(item.id)).map(item => item.id) },
    },
  });
  return {
    ...pack,
    contextLogId: contextLog.id,
  };
}
