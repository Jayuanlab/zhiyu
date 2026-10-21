import { searchUnifiedMemory } from "../unified-search";
import { resolveEvidenceRefs } from "../evidence/reader";
import { groupResolvedEvidenceRoots } from "../evidence/lineage";
import { runBoundedRecall } from "./query-retry";
import { buildInformationReadiness, informationNeedRetry } from "./information-needs";
import { buildBrainContextPack, explainBrainContextPack, type BrainContextExplanation, type BrainContextPack, type BrainRecallProfile } from "../context/pack";
import { buildBrainContextPackFromStore } from "../context/from-store";
import { finalizeContextPack } from "../context/finalize";
import { registerContextForDispatch } from "../context/dispatch";
import { MemoryModuleError } from "../kernel/errors";
import { MemoryWriteBusy } from "../kernel/reference-errors";
import { ExecutionLeaseError } from "@/lib/work-runtime/execution-errors";
import { completeBrainEvidenceAudit, completeBrainRecallRetryAudit } from "../context/audit";
import { listBrainAccessGrantsForUser } from "../adapters/postgres/memory-records";
import { listBrainMemoriesForUser } from "./candidates";
import { buildBrainRecallPlan, buildRuleBasedBrainRecallPlan, type BrainMemoryRequest, type BrainRecallPlan, type BrainRecallRoute } from "./recall-planner";
import type { BrainMemoryStatus, BrainMemoryType, BrainRequester, BrainSourceFilters } from "../kernel/memory-types";

export type BrainRecallRouteResult = {
  route: BrainRecallRoute["route"];
  purpose: BrainRecallRoute["purpose"];
  status: "executed" | "planned" | "skipped" | "failed" | "degraded";
  reason: string;
  count: number;
  results: Array<{
    type: string;
    id: string;
    content: string;
    similarity: number;
    metadata: Record<string, unknown>;
  }>;
  error?: string;
  evidenceQuality?: {requested:number;resolved:number;unresolved:number;notChecked:number;memoriesWithoutRefs:number;checkedAt:string;
    resolvedRootGroups?:number;overlappingResolvedRefs?:number;unresolvedSourceLinks?:number;lineageSemantics?:string};
};

export async function buildBrainContextForRequester(input: {
  requester: BrainRequester;
  taskIntent: string;
  maxItems?: number;
  memoryLimit?: number;
  statuses?: BrainMemoryStatus[];
  memoryTypes?: BrainMemoryType[];
  minConfidence?: number;
  updatedAfter?: string | Date;
  searchTerms?: string[];
  accessMode?: "strict" | "owner_override";
  recallProfiles?: BrainRecallProfile[];
  sourceFilters?: BrainSourceFilters;
}) {
  const grants = await listBrainAccessGrantsForUser({
    userId: input.requester.userId,
    limit: 200,
  });
  const memories = await listBrainMemoriesForUser({
    userId: input.requester.userId,
    limit: input.memoryLimit ?? 200,
    reserveBoundaries: true,
    reserveRevisions: true,
    includePendingUpdates: true,
    statuses: input.statuses ?? ["active", "verified", "weakened"],
    memoryTypes: input.memoryTypes,
    minConfidence: input.minConfidence,
    updatedAfter: input.updatedAfter,
    searchTerms: input.searchTerms,
  });
  const pack = buildBrainContextPack({
    memories,
    grants,
    requester: input.requester,
    taskIntent: input.taskIntent,
    maxItems: input.maxItems,
    accessMode: input.accessMode,
    recallProfiles: input.recallProfiles,
    sourceFilters: input.sourceFilters,
  });
  const finalized = await finalizeContextPack({ ...input, pack });
  registerContextForDispatch({ requester: input.requester, pack: finalized, taskIntent: input.taskIntent,
    accessMode: input.accessMode, sourceFilters: input.sourceFilters, recallProfiles: input.recallProfiles });
  return finalized;
}

async function executeBrainRecallRoutes(input: {
  request: BrainMemoryRequest;
  recallPlan: BrainRecallPlan;
  searchQuery?: string;
}): Promise<BrainRecallRouteResult[]> {
  const routeResults: BrainRecallRouteResult[] = [];
  for (const route of input.recallPlan.routes) {
    if (!route.enabled || route.route === "brain_memory") continue;
    if (route.route === "evidence_read") {
      routeResults.push({
        route: route.route,
        purpose: route.purpose,
        status: "planned",
        reason: route.reason,
        count: 0,
        results: [],
      });
      continue;
    }
    const sources =
      route.route === "knowledge_store"
        ? (["knowledge"] as const)
        : route.route === "memory_graph"
          ? (["graph"] as const)
          : ([] as const);
    if (sources.length === 0) {
      routeResults.push({
        route: route.route,
        purpose: route.purpose,
        status: "skipped",
        reason: "No executor is registered for this recall route.",
        count: 0,
        results: [],
      });
      continue;
    }
    // These auxiliary indexes currently authorize only by owner userId. They
    // cannot prove Work/Loop/tool source access or scenario applicability.
    // Keep evidence_read (which resolves selected authorized refs) available.
    if (["work", "loop", "tool"].includes(input.request.requester.type)) {
      routeResults.push({ route: route.route, purpose: route.purpose, status: "skipped",
        reason: "scoped_discovery_reader_unavailable", count: 0, results: [] });
      continue;
    }
    if (input.request.discoverySources && !sources.every(source => input.request.discoverySources!.includes(source))) {
      routeResults.push({ route: route.route, purpose: route.purpose, status: "skipped",
        reason: "Source is outside the caller's explicit discovery scope.", count: 0, results: [] });
      continue;
    }
    try {
      const result = await searchUnifiedMemory({
        userId: input.request.requester.userId,
        query: input.searchQuery ?? input.request.taskIntent,
        sources: [...sources],
        limit: Math.min(8, input.recallPlan.maxItems),
        threshold: 0.5,
      });
      const unavailable = result.sourceStatuses?.some(source => source.status === 'unavailable');
      const degraded = result.sourceStatuses?.some(source => source.status === 'degraded') || Boolean(result.warnings?.length);
      const withheld = result.results.length > 0;
      routeResults.push({
        route: route.route,
        purpose: route.purpose,
        reason: route.reason,
        count: 0,
        results: [],
        status: unavailable ? 'failed' : withheld || degraded ? 'degraded' : 'executed',
        ...(unavailable || degraded || withheld ? { error: unavailable || degraded ? 'recall_source_incomplete' : 'memory_source_unregistered' } : {}),
      });
    } catch {
      routeResults.push({
        route: route.route,
        purpose: route.purpose,
        status: "failed",
        reason: route.reason,
        count: 0,
        results: [],
        error: "recall_source_unavailable",
      });
    }
  }
  return routeResults;
}

export async function attachSelectedEvidenceReadResults(input: {
  request: BrainMemoryRequest & { accessMode?: 'strict' | 'owner_override' };
  routeResults: BrainRecallRouteResult[];
  pack: BrainContextPack;
}) {
  if(!input.routeResults.some(result=>result.route==='evidence_read'))return input.routeResults;
  const evidenceMemoryIds = new Map<string, string[]>();
  const evidenceOwners = new Map<
    string,
    Array<{ ownerType: string; ownerId: string }>
  >();
  for (const item of input.pack.items) {
    for (const evidenceRef of item.evidenceRefs) {
      evidenceMemoryIds.set(evidenceRef, [
        ...(evidenceMemoryIds.get(evidenceRef) ?? []),
        item.id,
      ]);
      evidenceOwners.set(evidenceRef, [
        ...(evidenceOwners.get(evidenceRef) ?? []),
        { ownerType: item.ownerType, ownerId: item.ownerId },
      ]);
    }
  }
  const evidenceRefs = [...evidenceMemoryIds.keys()].sort();
  let resolvedEvidence:Awaited<ReturnType<typeof resolveEvidenceRefs>>=[];
  let readerFailed=false;
  try{resolvedEvidence=await resolveEvidenceRefs({userId:input.request.requester.userId,evidenceRefs,ownerHintsByRef:evidenceOwners,
    modelPolicy: { requester: input.request.requester, accessMode: input.request.accessMode, sourceFilters: input.request.sourceFilters, purpose: 'recall_selected_evidence' },
    modelMemoryIdsByRef: evidenceMemoryIds });}
  catch{readerFailed=true;}
  const resolvedEvidenceById = new Map(
    resolvedEvidence.map((evidence) => [evidence.id, evidence]),
  );
  const lineage = groupResolvedEvidenceRoots(resolvedEvidence);
  const evidenceQuality={requested:evidenceRefs.length,resolved:resolvedEvidence.filter(e=>e.status==='resolved').length,unresolved:resolvedEvidence.filter(e=>e.status==='unresolved').length,notChecked:evidenceRefs.filter(ref=>!resolvedEvidenceById.has(ref)).length,memoriesWithoutRefs:input.pack.items.filter(item=>item.evidenceRefs.length===0).length,checkedAt:new Date().toISOString(),
    resolvedRootGroups:lineage.resolvedRootGroups,overlappingResolvedRefs:lineage.overlappingResolvedRefs,unresolvedSourceLinks:lineage.unresolvedSourceLinks,lineageSemantics:lineage.semantics};
  const rootsByRef = new Map(lineage.groups.flatMap(group => group.refs.map(ref => [ref, group] as const)));
  const expandableWith = (evidenceRef: string) => {
    const owners = evidenceOwners.get(evidenceRef) ?? [];
    return owners.some((owner) =>
      owner.ownerType === "work" || owner.ownerType === "workshop",
    )
      ? "workshopGetMemoryEvidence"
      : "domainEvidenceReader";
  };
  return input.routeResults.map((result) => {
    if (result.route !== "evidence_read") return result;
    if (evidenceRefs.length === 0) {
      return {
        ...result,
        status: "skipped" as const,
        evidenceQuality,
        count: 0,
        results: [],
      };
    }
    return {
      ...result,
      status: readerFailed?'failed' as const:evidenceQuality.unresolved+evidenceQuality.notChecked+evidenceQuality.memoriesWithoutRefs>0?'degraded' as const:'executed' as const,
      evidenceQuality,
      ...(readerFailed?{error:'evidence_reader_unavailable'}:{}),
      count: evidenceRefs.length,
      results: evidenceRefs.map((evidenceRef) => {
        const evidence = resolvedEvidenceById.get(evidenceRef);
        return {
          type: "evidence_ref",
          id: evidenceRef,
          content:
            evidence?.content ??
            "Selected evidence reference from canonical Brain ContextPack. Expand through the domain evidence reader before relying on it for high-impact action.",
          similarity: evidence?.status === "resolved" ? 1 : 0,
          metadata: {
            sourceSemantics: "evidence_source",
            route: "evidence_read",
            sourceRef: evidenceRef,
            selectedMemoryIds: evidenceMemoryIds.get(evidenceRef) ?? [],
            selectedMemoryOwners: evidenceOwners.get(evidenceRef) ?? [],
            expandableWith: expandableWith(evidenceRef),
            evidenceStatus: evidence?.status ?? "not_checked",
            evidenceSource: evidence?.source ?? "unknown",
            evidenceTitle: evidence?.title ?? null,
            evidenceCreatedAt: evidence?.createdAt ?? null,
            evidenceMetadata: evidence?.metadata ?? {},
            evidenceRootGroup: rootsByRef.get(evidenceRef) ?? null,
          },
        };
      }),
    };
  });
}

/** A route body is reusable only when all identities that authorized its read
 * survived final admission. Shared refs must not inherit a removed owner's read. */
export function retainFinalEvidenceResults(routes: BrainRecallRouteResult[], pack: BrainContextPack): BrainRecallRouteResult[] {
  const byRef = new Map<string, BrainContextPack["items"]>();
  for (const item of pack.items) for (const ref of item.evidenceRefs) {
    byRef.set(ref, [...(byRef.get(ref) ?? []), item]);
  }
  return routes.map(route => {
    if (route.route !== "evidence_read") return route;
    const results: BrainRecallRouteResult["results"] = route.results.filter(result => byRef.has(result.id)).map(result => {
      const items = byRef.get(result.id)!;
      const oldIds = Array.isArray(result.metadata.selectedMemoryIds) ? result.metadata.selectedMemoryIds : [];
      const unchanged = oldIds.length > 0 && oldIds.every(id => items.some(item => item.id === id))
        && items.every(item => oldIds.includes(item.id));
      const selected = { selectedMemoryIds: items.map(item => item.id),
        selectedMemoryOwners: items.map(item => ({ ownerType: item.ownerType, ownerId: item.ownerId })) };
      if (!unchanged) return { type: "evidence_ref", id: result.id, content: "Evidence requires a new authorized read after final admission.",
        similarity: 0, metadata: { sourceSemantics: "evidence_source", route: "evidence_read", sourceRef: result.id,
          ...selected, evidenceStatus: "not_checked", evidenceSource: "unknown", reason: "evidence_authorization_changed" } };
      // Root groups were computed for the attempted union and may mention refs
      // removed by final admission. Do not return that obsolete grouping.
      return { ...result, metadata: { ...result.metadata, ...selected, evidenceRootGroup: null } };
    });
    const resolved = results.filter(result => result.metadata.evidenceStatus === "resolved").length;
    const unresolved = results.filter(result => result.metadata.evidenceStatus === "unresolved").length;
    const notChecked = results.length - resolved - unresolved;
    const quality = { requested: results.length, resolved, unresolved, notChecked,
      memoriesWithoutRefs: pack.items.filter(item => !item.evidenceRefs.length).length, checkedAt: new Date().toISOString() };
    return { ...route, results, count: results.length, evidenceQuality: quality,
      status: !results.length ? "skipped" : route.status === "failed" ? "failed"
        : unresolved + notChecked + quality.memoriesWithoutRefs > 0 ? "degraded" : "executed" };
  });
}

export async function buildBrainContextFromMemoryRequest(
  input: BrainMemoryRequest & {
    /** Server-owned selection; public query JSON never accepts this field. */
    planningMode?: "configured" | "rules";
    recallProfiles?: BrainRecallProfile[];
    accessMode?: "strict" | "owner_override";
    metadata?: Record<string, unknown>;
  },
) {
  const localRules = input.planningMode === "rules";
  const plan = localRules ? buildRuleBasedBrainRecallPlan(input) : await buildBrainRecallPlan(input);
  const { result, trace } = await runBoundedRecall({
    originalQuery: input.taskIntent,
    plan,
    enabled: input.allowQueryRetry !== false && process.env.BRAIN_RECALL_QUERY_RETRY_ENABLED !== "false",
    run: async (recallPlan, searchQuery) => {
      try { return await buildBrainContextAttempt(input, recallPlan, searchQuery); }
      catch (error) {
        if (error instanceof MemoryModuleError || error instanceof MemoryWriteBusy || error instanceof ExecutionLeaseError) throw error;
        // Provider/auxiliary route outages are already explicit route results.
        // A failed canonical snapshot or its audit cannot become a successful
        // retry fallback to a previously loaded body.
        throw new MemoryModuleError("memory_recall_attempt_unavailable", 503, "Memory recall could not load and audit a context snapshot");
      }
    },
    ...(localRules ? { checkEvidence: async () => ({ provider: "typesafe" as const, mode: "off" as const,
      status: "disabled" as const, detail: "local_deterministic_rules_no_independent_verification", elapsedMs: 0 }) }
      : { beforeCheckEvidence: async (attempt: Awaited<ReturnType<typeof buildBrainContextAttempt>>) => {
        const checked = await finalizeContextPack({ requester: input.requester, pack: attempt, taskIntent: input.taskIntent,
          accessMode: input.accessMode, sourceFilters: input.sourceFilters, recallProfiles: input.recallProfiles,
          includeCandidates: plan.includeCandidates, metadata: { source: "recall_evidence_check_admission",
            phase: "evidence_check_admission", attemptContextLogId: attempt.contextLogId ?? null } });
        return { ...attempt, ...checked, routeResults: retainFinalEvidenceResults(attempt.routeResults, checked),
          explanation: explainBrainContextPack(checked) };
      } }),
    selectMissingInformationRetry: (first) => {
      const readiness = buildInformationReadiness({ taskIntent: input.taskIntent,
        needs: input.informationNeeds, pack: first, routes: first.routeResults });
      const gap = readiness.needs.find(need => need.required && need.status === 'missing');
      if (!gap) return undefined;
      return informationNeedRetry(gap);
    },
  });
  // Attempts and their evidence are snapshots. Re-read stored identity, revision,
  // permissions and applicability after every provider/retry has completed.
  // Finalization failure is terminal: an earlier pack must never be returned.
  const finalizedPack = await finalizeContextPack({
    requester: input.requester, taskIntent: input.taskIntent, pack: result,
    accessMode: input.accessMode, sourceFilters: input.sourceFilters,
    recallProfiles: input.recallProfiles, includeCandidates: plan.includeCandidates,
    metadata: { ...(input.metadata ?? {}), source: "recall_final_admission", attemptContextLogIds: trace.contextLogIds },
  });
  const routeResults = retainFinalEvidenceResults(result.routeResults, finalizedPack);
  const finalResult = { ...result, ...finalizedPack, routeResults };
  const informationReadiness = buildInformationReadiness({
    taskIntent: input.taskIntent, phase: input.platformState?.phase,
    needs: input.informationNeeds, pack: finalResult, routes: routeResults,
    additionalRecallBudget: 0,
  });
  const finalEvidenceRoute = routeResults.find(route => route.route === "evidence_read");
  if (finalizedPack.contextLogId && finalEvidenceRoute) {
    await completeBrainEvidenceAudit({ userId: input.requester.userId, contextLogId: finalizedPack.contextLogId,
      outcome: { status: finalEvidenceRoute.status, quality: finalEvidenceRoute.evidenceQuality ?? null,
        error: finalEvidenceRoute.error ?? null, references: finalEvidenceRoute.results.map(result => ({ id: result.id,
          status: result.metadata.evidenceStatus, source: result.metadata.evidenceSource,
          selectedMemoryIds: result.metadata.selectedMemoryIds })), warnings: finalizedPack.warnings ?? [] } });
  }
  if (finalizedPack.contextLogId) {
    await completeBrainRecallRetryAudit({
      userId: input.requester.userId, contextLogId: finalizedPack.contextLogId, outcome: { ...trace, informationReadiness },
    });
  }
  // Shadow judgments are persisted above, but not supplied as answer guidance.
  const publicTrace = trace.evidenceCheck?.mode === "shadow" ? {
    ...trace, informationReadiness, evidenceCheck: { ...trace.evidenceCheck, coverage: undefined, relevance: undefined, fieldChecks: undefined },
  } : { ...trace, informationReadiness };
  registerContextForDispatch({ requester: input.requester, pack: finalizedPack, taskIntent: input.taskIntent,
    accessMode: input.accessMode, sourceFilters: input.sourceFilters, recallProfiles: input.recallProfiles,
    includeCandidates: plan.includeCandidates, metadata: { source: "memory_recall_dispatch" } });
  return {
    ...finalResult,
    informationReadiness,
    explanation: explainBrainContextPack(finalResult),
    recallPlan: { ...result.recallPlan, queryRetryTrace: publicTrace },
    queryRetryTrace: publicTrace,
  };
}

/** Persist only observed connection identity and terminal facts, never provider configuration. */
function recallPlannerProviderAudit(provider: BrainRecallPlan["provider"]) {
  if (!provider) return null;
  return {
    source: typeof provider.source === "string" ? provider.source : null,
    model: typeof provider.model === "string" ? provider.model : null,
    protocol: typeof provider.protocol === "string" ? provider.protocol : null,
    finishReason: typeof provider.finishReason === "string" ? provider.finishReason : null,
    thinkingMode: typeof provider.thinkingMode === "string" ? provider.thinkingMode : null,
    migrated: typeof provider.migrated === "boolean" ? provider.migrated : null,
  };
}

async function buildBrainContextAttempt(
  input: BrainMemoryRequest & {
    recallProfiles?: BrainRecallProfile[];
    accessMode?: "strict" | "owner_override";
    metadata?: Record<string, unknown>;
  },
  recallPlan: BrainRecallPlan,
  searchQuery: string,
): Promise<
  Awaited<ReturnType<typeof buildBrainContextPackFromStore>> & {
    recallPlan: BrainRecallPlan;
    explanation: BrainContextExplanation;
    routeResults: BrainRecallRouteResult[];
  }
> {
  const routeResults = await executeBrainRecallRoutes({
    request: input,
    recallPlan,
    searchQuery,
  });
  const pack = await buildBrainContextPackFromStore({
    requester: input.requester,
    taskIntent: input.taskIntent,
    maxItems: recallPlan.maxItems,
    memoryLimit: recallPlan.memoryLimit,
    statuses: recallPlan.statuses,
    memoryTypes: recallPlan.memoryTypes,
    scopes: recallPlan.scopes,
    minConfidence: recallPlan.minConfidence,
    updatedAfter: recallPlan.updatedAfter,
    searchTerms: recallPlan.searchTerms,
    canonicalKinds: recallPlan.canonicalKinds,
    includeCandidates: recallPlan.includeCandidates,
    accessMode: input.accessMode,
    recallProfiles: input.recallProfiles,
    sourceFilters: input.sourceFilters,
    reserveCurrentOwnerCorrections: (input.platformState?.riskLevel === 'normal' || input.platformState?.riskLevel === 'low')
      && input.platformState.highRiskAction !== true
      && !['external_message', 'trade', 'config_change', 'write_memory'].includes(input.action?.kind ?? ''),
    metadata: {
      ...(input.metadata ?? {}),
      sourceFilters: input.sourceFilters ?? null,
      recallQuery: { original: input.taskIntent, executed: searchQuery },
      recallPlanner: {
        mode: recallPlan.mode,
        provider: recallPlannerProviderAudit(recallPlan.provider),
        routing: recallPlan.routing,
        canonicalKinds: recallPlan.canonicalKinds ?? null,
        routes: recallPlan.routes,
        routeResults: routeResults.map((result) => ({
          route: result.route,
          purpose: result.purpose,
          status: result.status,
          count: result.count,
          error: result.error ?? null,
        })),
        rationale: recallPlan.rationale,
        warnings: recallPlan.warnings,
      },
    },
  });
  const finalRouteResults = await attachSelectedEvidenceReadResults({
    request: input,
    routeResults,
    pack,
  });
  const evidenceRoute=finalRouteResults.find(result=>result.route==='evidence_read');
  const quality=evidenceRoute?.evidenceQuality;
  const evidenceIncomplete=quality&&(quality.unresolved+quality.notChecked+quality.memoriesWithoutRefs>0);
  const finalPack:BrainContextPack=evidenceIncomplete?{...pack,warnings:[...(pack.warnings??[]),{code:'evidence_unavailable',memoryIds:pack.items.filter(item=>item.evidenceRefs.length===0||item.evidenceRefs.some(ref=>evidenceRoute?.results.find(result=>result.id===ref)?.metadata.evidenceStatus!=='resolved')).map(item=>item.id),message:'Some selected memories have unavailable or unchecked evidence. Keep their boundary constraints, but verify current sources before relying on factual claims for high-impact actions.',requiresCurrentObservation:true}]}:pack;
  if(evidenceRoute&&pack.contextLogId){
    await completeBrainEvidenceAudit({userId:input.requester.userId,contextLogId:pack.contextLogId,outcome:{
      status:evidenceRoute.status,quality:evidenceRoute.evidenceQuality??null,error:evidenceRoute.error??null,
      references:evidenceRoute.results.map(result=>({id:result.id,status:result.metadata.evidenceStatus,source:result.metadata.evidenceSource,selectedMemoryIds:result.metadata.selectedMemoryIds})),
      warnings:finalPack.warnings??[],
    }});
  }
  return {
    ...finalPack,
    recallPlan,
    explanation: explainBrainContextPack(finalPack),
    routeResults: finalRouteResults,
  };
}

export { buildBrainContextForRequester as buildContextForRequester, buildBrainContextFromMemoryRequest as recallMemory };

