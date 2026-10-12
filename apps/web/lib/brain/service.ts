import { createHash, randomUUID } from "node:crypto";
import { searchUnifiedMemory } from "@/lib/memory/unified-search";
import { resolveBrainEvidenceRefs } from "./evidence-reader";
import { runBoundedRecall } from "./query-retry";
import { buildInformationReadiness, informationNeedRetry } from './information-needs';
import {
  buildBrainContextPack,
  explainBrainContextPack,
  type BrainContextExplanation,
  type BrainContextPack,
  type BrainRecallProfile,
} from "./context";
import {
  buildBrainMemoryMetadata,
  type BrainCanonicalKind,
  type BrainDerivedMemoryRef,
  type BrainMemoryFacets,
  type BrainMemoryMetadata,
} from "./canonical";
import { validateMemoryWrite } from "./policy";
import { reviewBrainMemoryTransaction, type BrainMemoryReviewInput } from "./memory-review";
import { admitOrdinaryBrainMemory } from "./memory-update-admission";
import { BrainMemoryUpdateError } from "./memory-update-common";
import { BRAIN_MEMORY_AUTO_UPDATE_POLICY_TYPE } from "./memory-update-policy";
import {
  buildBrainContextPackFromStore,
  completeBrainEvidenceAudit,
  completeBrainRecallRetryAudit,
  createBrainAccessGrant,
  deleteBrainAccessGrant,
  getBrainMemoryById,
  insertBrainStateSnapshot,
  listBrainAccessGrantsForUser,
  listBrainMemoriesForUser,
  listBrainMemoryReviewsForUser,
  listBrainObservationsForUser,
  listBrainStateSnapshots,
  catalogBrainStateSnapshots,
  upsertBrainObservation,
} from "./repository";
import {
  buildBrainRecallPlan,
  type BrainMemoryRequest,
  type BrainRecallPlan,
  type BrainRecallRoute,
} from "./recall-planner";
import type {
  BrainAccessGrant,
  BrainMemory,
  BrainMemoryStatus,
  BrainMemoryType,
  BrainRequester,
  BrainSourceFilters,
  BrainScope,
} from "./types";

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
  evidenceQuality?: {requested:number;resolved:number;unresolved:number;notChecked:number;memoriesWithoutRefs:number;checkedAt:string};
};

function clampConfidence(value: number | undefined) {
  if (typeof value !== "number" || Number.isNaN(value)) return 50;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function hashObservation(input: {
  sourceType: string;
  sourceId: string;
  observedAt: string | Date;
  content: string;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        observedAt:
          input.observedAt instanceof Date
            ? input.observedAt.toISOString()
            : input.observedAt,
        content: input.content,
      }),
    )
    .digest("hex");
}

export async function createBrainObservation(input: {
  userId: string;
  sourceType: string;
  sourceId: string;
  sourceEventId?: string | null;
  observedAt: string | Date;
  content: string;
  trustLevel?: string;
  metadata?: Record<string, unknown>;
}) {
  if (input.sourceType === "owner_memory_correction_intent") {
    throw new BrainMemoryUpdateError("reserved_correction_observation", 400, "Use the owner correction draft command to record correction intent");
  }
  return upsertBrainObservation({
    ...input,
    contentHash: hashObservation(input),
  });
}

export async function listBrainObservations(input: {
  userId: string;
  limit?: number;
  sourceTypes?: string[];
}) {
  return listBrainObservationsForUser(input);
}

export async function listBrainMemory(input: {
  userId: string;
  limit?: number;
  statuses?: BrainMemoryStatus[];
  memoryTypes?: BrainMemoryType[];
  ownerType?: BrainMemory["ownerType"];
  ownerId?: string;
}) {
  return listBrainMemoriesForUser(input);
}

export async function getBrainMemory(input: {
  userId: string;
  memoryId: string;
}) {
  return getBrainMemoryById(input);
}

export async function listBrainReviews(input: {
  userId: string;
  memoryId?: string;
  limit?: number;
}) {
  return listBrainMemoryReviewsForUser(input);
}

export async function writeBrainMemory(input: {
  requester: BrainRequester;
  scope: BrainScope;
  ownerType: BrainMemory["ownerType"];
  ownerId: string;
  memoryType: BrainMemoryType;
  subject: string;
  content: string;
  status?: BrainMemoryStatus;
  confidence?: number;
  evidenceRefs?: string[];
  tags?: string[];
  id?: string;
  now?: Date;
  grants?: BrainAccessGrant[];
  expiresAt?: string;
  supersedes?: string[];
  canonicalKind?: BrainCanonicalKind;
  canonicalGroupId?: string;
  facets?: BrainMemoryFacets;
  derivedRefs?: BrainDerivedMemoryRef[];
  metadata?: BrainMemoryMetadata;
}) {
  const now = input.now ?? new Date();
  if (["revision","revisionRetired","updateProposal","documentProgramUpdate","automaticProof","admission","pendingMemoryUpdate"].some(key => Object.hasOwn(input.metadata ?? {},key))) {
    throw new BrainMemoryUpdateError("reserved_memory_metadata",400,"Protected memory metadata can only be written by versioned update services");
  }
  const sourceKind = input.facets?.sourceKind ?? input.metadata?.sourceKind;
  const modelUnderstanding = input.requester.type === "work" || input.requester.type === "loop" || input.requester.id === "brain-mcp" ||
    input.requester.id === "interaction-wiki-api" ||
    input.requester.id === "work-runtime-command" && input.facets?.commandSource !== "owner" ||
    ["workshop_tool","workshop_run_output","wechat"].includes(String(sourceKind));
  const status = modelUnderstanding ? "candidate" : input.status ?? "active";
  const evidenceRefs = input.evidenceRefs ?? [];
  const grants =
    input.grants ??
    (await listBrainAccessGrantsForUser({ userId: input.requester.userId }));
  const request = {
    requester: input.requester,
    targetScope: input.scope,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    memoryType: input.memoryType,
    status,
    confidence: clampConfidence(input.confidence),
    evidenceRefs,
  };
  const issues = validateMemoryWrite({ request, grants, now });
  if (issues.length > 0) {
    throw new Error(
      `Brain memory write rejected: ${issues
        .map((issue) => `${issue.code}:${issue.message}`)
        .join("; ")}`,
    );
  }

  const memory: BrainMemory = {
    id: input.id ?? randomUUID(),
    userId: input.requester.userId,
    scope: input.scope,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    memoryType: input.memoryType,
    subject: input.subject,
    content: input.content,
    status,
    confidence: request.confidence,
    evidenceRefs,
    tags: input.tags,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: input.expiresAt,
    supersedes: input.supersedes,
    metadata: buildBrainMemoryMetadata({
      memoryType: input.memoryType,
      subject: input.subject,
      content: input.content,
      scope: input.scope,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      evidenceRefs,
      tags: input.tags,
      canonicalKind: input.canonicalKind,
      canonicalGroupId: input.canonicalGroupId,
      facets: input.facets,
      derivedRefs: input.derivedRefs,
      metadata: {...input.metadata,...(modelUnderstanding?{admission:{requiresOwnerVerification:true,source:"ordinary_model_understanding.v1",requestedStatus:input.status??"active"}}:{})},
    }),
  };
  return admitOrdinaryBrainMemory({requester:input.requester,memory,now});
}

export async function createBrainMemoryCandidate(input: {
  requester: BrainRequester;
  scope: BrainScope;
  ownerType: BrainMemory["ownerType"];
  ownerId: string;
  memoryType: BrainMemoryType;
  subject: string;
  content: string;
  confidence?: number;
  evidenceRefs?: string[];
  tags?: string[];
  id?: string;
  now?: Date;
  expiresAt?: string;
  canonicalKind?: BrainCanonicalKind;
  canonicalGroupId?: string;
  facets?: BrainMemoryFacets;
  derivedRefs?: BrainDerivedMemoryRef[];
  metadata?: BrainMemoryMetadata;
}) {
  return writeBrainMemory({
    ...input,
    status: "candidate",
  });
}

export async function reviewBrainMemory(input: BrainMemoryReviewInput) {
  return reviewBrainMemoryTransaction(input);
}

export async function listBrainCandidates(input: {
  userId: string;
  limit?: number;
  ownerType?: BrainMemory["ownerType"];
  ownerId?: string;
}) {
  return listBrainMemoriesForUser({
    userId: input.userId,
    statuses: ["candidate"],
    limit: input.limit,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
  });
}

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
  return buildBrainContextPack({
    memories,
    grants,
    requester: input.requester,
    taskIntent: input.taskIntent,
    maxItems: input.maxItems,
    accessMode: input.accessMode,
    recallProfiles: input.recallProfiles,
    sourceFilters: input.sourceFilters,
  });
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
      const unavailable = result.sourceStatuses?.some(source => source.status === "unavailable");
      const degraded = result.sourceStatuses?.some(source => source.status === "degraded") || Boolean(result.warnings?.length);
      routeResults.push({
        route: route.route,
        purpose: route.purpose,
        status: unavailable ? "failed" : degraded ? "degraded" : "executed",
        reason: route.reason,
        count: result.count,
        results: result.results,
        ...(unavailable || degraded ? { error: "recall_source_incomplete" } : {}),
      });
    } catch (error) {
      routeResults.push({
        route: route.route,
        purpose: route.purpose,
        status: "failed",
        reason: route.reason,
        count: 0,
        results: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return routeResults;
}

export async function attachSelectedEvidenceReadResults(input: {
  request: BrainMemoryRequest;
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
  let resolvedEvidence:Awaited<ReturnType<typeof resolveBrainEvidenceRefs>>=[];
  let readerFailed=false;
  try{resolvedEvidence=await resolveBrainEvidenceRefs({userId:input.request.requester.userId,evidenceRefs,ownerHintsByRef:evidenceOwners});}
  catch{readerFailed=true;}
  const resolvedEvidenceById = new Map(
    resolvedEvidence.map((evidence) => [evidence.id, evidence]),
  );
  const evidenceQuality={requested:evidenceRefs.length,resolved:resolvedEvidence.filter(e=>e.status==='resolved').length,unresolved:resolvedEvidence.filter(e=>e.status==='unresolved').length,notChecked:evidenceRefs.filter(ref=>!resolvedEvidenceById.has(ref)).length,memoriesWithoutRefs:input.pack.items.filter(item=>item.evidenceRefs.length===0).length,checkedAt:new Date().toISOString()};
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
          },
        };
      }),
    };
  });
}

export async function buildBrainContextFromMemoryRequest(
  input: BrainMemoryRequest & {
    recallProfiles?: BrainRecallProfile[];
    accessMode?: "strict" | "owner_override";
    metadata?: Record<string, unknown>;
  },
) {
  const plan = await buildBrainRecallPlan(input);
  const { result, trace } = await runBoundedRecall({
    originalQuery: input.taskIntent,
    plan,
    enabled: input.allowQueryRetry !== false && process.env.BRAIN_RECALL_QUERY_RETRY_ENABLED !== "false",
    run: (recallPlan, searchQuery) => buildBrainContextAttempt(input, recallPlan, searchQuery),
    selectMissingInformationRetry: (first) => {
      const readiness = buildInformationReadiness({ taskIntent: input.taskIntent,
        needs: input.informationNeeds, pack: first, routes: first.routeResults });
      const gap = readiness.needs.find(need => need.required && need.status === 'missing');
      if (!gap) return undefined;
      return informationNeedRetry(gap);
    },
  });
  const informationReadiness = buildInformationReadiness({
    taskIntent: input.taskIntent, phase: input.platformState?.phase,
    needs: input.informationNeeds, pack: result, routes: result.routeResults,
    additionalRecallBudget: 0,
  });
  if (result.contextLogId) {
    await completeBrainRecallRetryAudit({
      userId: input.requester.userId, contextLogId: result.contextLogId, outcome: { ...trace, informationReadiness },
    });
  }
  // Shadow judgments are persisted above, but not supplied as answer guidance.
  const publicTrace = trace.evidenceCheck?.mode === "shadow" ? {
    ...trace, informationReadiness, evidenceCheck: { ...trace.evidenceCheck, coverage: undefined, relevance: undefined, fieldChecks: undefined },
  } : { ...trace, informationReadiness };
  return {
    ...result,
    informationReadiness,
    explanation: explainBrainContextPack(result),
    recallPlan: { ...result.recallPlan, queryRetryTrace: publicTrace },
    queryRetryTrace: publicTrace,
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
    metadata: {
      ...(input.metadata ?? {}),
      sourceFilters: input.sourceFilters ?? null,
      recallQuery: { original: input.taskIntent, executed: searchQuery },
      recallPlanner: {
        mode: recallPlan.mode,
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

export async function createBrainStateSnapshot(input: {
  userId: string;
  scope: BrainScope;
  snapshotType: string;
  content: Record<string, unknown>;
  sourceMemoryIds?: string[];
  metadata?: Record<string, unknown>;
}) {
  if(input.snapshotType === BRAIN_MEMORY_AUTO_UPDATE_POLICY_TYPE)throw new BrainMemoryUpdateError("reserved_policy_snapshot",400,"Use the versioned automatic memory policy command");
  if (["memory_dependency_registry", "memory_dependency_change"].includes(input.snapshotType)) {
    throw new BrainMemoryUpdateError("reserved_dependency_snapshot", 400, "Use the versioned memory dependency command");
  }
  if (input.snapshotType === "memory_correction_draft") {
    throw new BrainMemoryUpdateError("reserved_correction_snapshot", 400, "Use the owner correction draft command");
  }
  return insertBrainStateSnapshot(input);
}

export async function listBrainSnapshots(input: {
  userId: string;
  scope?: BrainScope;
  workId?: string;
  snapshotTypes?: string[];
  snapshotId?: string;
  recordedBefore?: string;
  contentQuery?: string;
  pageAfter?: { id: string; time: string };
  includePagePosition?: boolean;
  limit?: number;
}) {
  return listBrainStateSnapshots(input);
}

export async function catalogBrainSnapshots(input: Parameters<typeof catalogBrainStateSnapshots>[0]) {
  return catalogBrainStateSnapshots(input);
}

export async function grantBrainAccess(
  input: Omit<BrainAccessGrant, "id"> & { id?: string; reason?: string | null },
) {
  return createBrainAccessGrant(input);
}

export async function listBrainGrants(input: {
  userId: string;
  limit?: number;
  subjectType?: BrainAccessGrant["subjectType"];
  subjectId?: string;
}) {
  return listBrainAccessGrantsForUser(input);
}

export async function revokeBrainAccess(input: {
  userId: string;
  grantId: string;
}) {
  return deleteBrainAccessGrant(input);
}
