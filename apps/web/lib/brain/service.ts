import { createHash, randomUUID } from "node:crypto";
import { searchUnifiedMemory } from "@/lib/memory/unified-search";
import { resolveBrainEvidenceRefs } from "./evidence-reader";
import {
  buildBrainContextPack,
  explainBrainContextPack,
  type BrainContextExplanation,
  type BrainContextPack,
  type BrainRecallProfile,
} from "./context";
import {
  buildBrainMemoryMetadata,
  getBrainMemoryCanonicalMetadata,
  type BrainCanonicalKind,
  type BrainDerivedMemoryRef,
  type BrainMemoryFacets,
  type BrainMemoryMetadata,
} from "./canonical";
import { canWriteMemory, validateMemoryWrite } from "./policy";
import {
  buildBrainContextPackFromStore,
  createBrainAccessGrant,
  deleteBrainAccessGrant,
  getBrainMemoryById,
  insertBrainMemoryReview,
  insertBrainStateSnapshot,
  listBrainAccessGrantsForUser,
  listBrainMemoriesForUser,
  listBrainMemoryReviewsForUser,
  listBrainObservationsForUser,
  listBrainStateSnapshots,
  upsertBrainMemory,
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
  BrainScope,
} from "./types";

export type BrainRecallRouteResult = {
  route: BrainRecallRoute["route"];
  purpose: BrainRecallRoute["purpose"];
  status: "executed" | "planned" | "skipped" | "failed";
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

function reviewerId(requester: BrainRequester) {
  return requester.id ?? requester.workId ?? requester.workshopId ?? null;
}

function reviewStatus(decision: "confirmed" | "dismissed" | "rejected") {
  return decision === "confirmed" ? "verified" : "deleted";
}

const CANONICAL_ADMISSION_STATUSES: BrainMemoryStatus[] = [
  "candidate",
  "active",
  "verified",
  "weakened",
];

function statusRank(status: BrainMemoryStatus) {
  switch (status) {
    case "verified":
      return 4;
    case "active":
      return 3;
    case "weakened":
      return 2;
    case "candidate":
      return 1;
    default:
      return 0;
  }
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value))),
  );
}

function mergeBrainMemoryForCanonicalAdmission(input: {
  existing: BrainMemory;
  incoming: BrainMemory;
  now: Date;
}) {
  const evidenceRefs = uniqueStrings([
    ...input.existing.evidenceRefs,
    ...input.incoming.evidenceRefs,
  ]);
  const tags = uniqueStrings([
    ...(input.existing.tags ?? []),
    ...(input.incoming.tags ?? []),
  ]);
  return {
    ...input.existing,
    scope: input.incoming.scope,
    ownerType: input.incoming.ownerType,
    ownerId: input.incoming.ownerId,
    memoryType: input.incoming.memoryType,
    subject: input.incoming.subject,
    content: input.incoming.content,
    status: input.incoming.status,
    confidence: Math.max(input.existing.confidence, input.incoming.confidence),
    evidenceRefs,
    tags,
    updatedAt: input.now.toISOString(),
    expiresAt: input.incoming.expiresAt ?? input.existing.expiresAt,
    supersedes: uniqueStrings([
      ...(input.existing.supersedes ?? []),
      ...(input.incoming.supersedes ?? []),
    ]),
    metadata: {
      ...(input.incoming.metadata ?? {}),
      canonicalAdmission: {
        action: "merged_existing",
        existingMemoryId: input.existing.id,
        attemptedMemoryId: input.incoming.id,
        mergedAt: input.now.toISOString(),
      },
    },
  } satisfies BrainMemory;
}

async function findCanonicalAdmissionDuplicate(input: {
  memory: BrainMemory;
  canonicalGroupId: string;
}) {
  const candidates = await listBrainMemoriesForUser({
    userId: input.memory.userId,
    statuses: CANONICAL_ADMISSION_STATUSES,
    ownerType: input.memory.ownerType,
    ownerId: input.memory.ownerId,
    scopes: [input.memory.scope],
    limit: 100,
  });
  return candidates
    .filter((candidate) => candidate.id !== input.memory.id)
    .filter(
      (candidate) =>
        getBrainMemoryCanonicalMetadata(candidate).canonicalGroupId ===
        input.canonicalGroupId,
    )
    .sort(
      (left, right) =>
        statusRank(right.status) - statusRank(left.status) ||
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    )[0];
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
  const status = input.status ?? "active";
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
      metadata: input.metadata,
    }),
  };
  const canonical = getBrainMemoryCanonicalMetadata(memory);
  const duplicate = await findCanonicalAdmissionDuplicate({
    memory,
    canonicalGroupId: canonical.canonicalGroupId,
  });
  if (duplicate) {
    if (statusRank(status) > statusRank(duplicate.status)) {
      return upsertBrainMemory(
        mergeBrainMemoryForCanonicalAdmission({
          existing: duplicate,
          incoming: memory,
          now,
        }),
      );
    }
    return {
      ...duplicate,
      metadata: {
        ...(duplicate.metadata ?? {}),
        canonicalAdmission: {
          action: "reused_existing",
          existingMemoryId: duplicate.id,
          attemptedMemoryId: memory.id,
          attemptedAt: now.toISOString(),
        },
      },
    };
  }
  return upsertBrainMemory(memory);
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

export async function reviewBrainMemory(input: {
  requester: BrainRequester;
  memoryId: string;
  decision: "confirmed" | "dismissed" | "rejected";
  reason?: string | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const existing = await getBrainMemoryById({
    userId: input.requester.userId,
    memoryId: input.memoryId,
  });
  if (!existing) {
    throw new Error("Brain memory not found");
  }

  const grants = await listBrainAccessGrantsForUser({
    userId: input.requester.userId,
  });
  const writeDecision = canWriteMemory({
    request: {
      requester: input.requester,
      targetScope: existing.scope,
      ownerType: existing.ownerType,
      ownerId: existing.ownerId,
      memoryType: existing.memoryType,
      status: reviewStatus(input.decision),
      confidence: existing.confidence,
      evidenceRefs: existing.evidenceRefs,
    },
    grants,
    now,
  });
  if (!writeDecision.allowed && input.requester.type !== "chat") {
    throw new Error(`Brain memory review rejected: ${writeDecision.reason}`);
  }

  const reviewed: BrainMemory = {
    ...existing,
    status: reviewStatus(input.decision),
    updatedAt: now.toISOString(),
  };
  await upsertBrainMemory(reviewed);
  await insertBrainMemoryReview({
    userId: input.requester.userId,
    memoryId: reviewed.id,
    reviewerType: input.requester.type,
    reviewerId: reviewerId(input.requester),
    decision: input.decision,
    reason: input.reason,
    evidenceRefs: reviewed.evidenceRefs,
    metadata: {
      source: "brain_service_review",
      previousStatus: existing.status,
      nextStatus: reviewed.status,
    },
  });
  return reviewed;
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
}) {
  const grants = await listBrainAccessGrantsForUser({
    userId: input.requester.userId,
    limit: 200,
  });
  const memories = await listBrainMemoriesForUser({
    userId: input.requester.userId,
    limit: input.memoryLimit ?? 200,
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
  });
}

async function executeBrainRecallRoutes(input: {
  request: BrainMemoryRequest;
  recallPlan: BrainRecallPlan;
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
    try {
      const result = await searchUnifiedMemory({
        userId: input.request.requester.userId,
        query: input.request.taskIntent,
        sources: [...sources],
        limit: Math.min(8, input.recallPlan.maxItems),
        threshold: 0.5,
      });
      routeResults.push({
        route: route.route,
        purpose: route.purpose,
        status: "executed",
        reason: route.reason,
        count: result.count,
        results: result.results,
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

async function attachSelectedEvidenceReadResults(input: {
  request: BrainMemoryRequest;
  routeResults: BrainRecallRouteResult[];
  pack: BrainContextPack;
}) {
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
  const resolvedEvidence = await resolveBrainEvidenceRefs({
    userId: input.request.requester.userId,
    evidenceRefs,
    ownerHintsByRef: evidenceOwners,
  });
  const resolvedEvidenceById = new Map(
    resolvedEvidence.map((evidence) => [evidence.id, evidence]),
  );
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
        status: "planned" as const,
        count: 0,
        results: [],
      };
    }
    return {
      ...result,
      status: "executed" as const,
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
            evidenceStatus: evidence?.status ?? "unresolved",
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
): Promise<
  Awaited<ReturnType<typeof buildBrainContextPackFromStore>> & {
    recallPlan: BrainRecallPlan;
    explanation: BrainContextExplanation;
    routeResults: BrainRecallRouteResult[];
  }
> {
  const recallPlan = await buildBrainRecallPlan(input);
  const routeResults = await executeBrainRecallRoutes({
    request: input,
    recallPlan,
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
    metadata: {
      ...(input.metadata ?? {}),
      recallPlanner: {
        mode: recallPlan.mode,
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
  return {
    ...pack,
    recallPlan,
    explanation: explainBrainContextPack(pack),
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
  return insertBrainStateSnapshot(input);
}

export async function listBrainSnapshots(input: {
  userId: string;
  scope?: BrainScope;
  snapshotTypes?: string[];
  limit?: number;
}) {
  return listBrainStateSnapshots(input);
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
