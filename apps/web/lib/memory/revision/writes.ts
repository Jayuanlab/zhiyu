import { remoteOwnerOperation } from "@/lib/memory-zhiyu/remote";
import { randomUUID } from "node:crypto";
import { validateMemoryWrite } from "./policy";
import { buildBrainMemoryMetadata, type BrainCanonicalKind, type BrainMemoryFacets, type BrainDerivedMemoryRef, type BrainMemoryMetadata } from "./canonical";
import { admitOrdinaryBrainMemory } from "./admission";
import { reviewBrainMemoryTransaction, type BrainMemoryReviewInput } from "./review";
import { BrainMemoryUpdateError } from "./common";
import { listAccessGrantsForUser as listBrainAccessGrantsForUser } from "../adapters/postgres/memory-records";
import type { BrainMemory, BrainRequester, BrainScope, BrainMemoryType, BrainMemoryStatus, BrainAccessGrant } from "../kernel/memory-types";
function clampConfidence(value: number | undefined) {
  if (typeof value !== "number" || Number.isNaN(value)) return 50;
  return Math.max(0, Math.min(100, Math.round(value)));
}
export async function writeMemory(input: {
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
  if (["lessonExtraction","recordLifecycle","revision","revisionRetired","updateProposal","documentProgramUpdate","automaticProof","admission","pendingMemoryUpdate"].some(key => Object.hasOwn(input.metadata ?? {},key))) {
    throw new BrainMemoryUpdateError("reserved_memory_metadata",400,"Protected memory metadata can only be written by versioned update services");
  }
  const sourceKind = input.facets?.sourceKind ?? input.metadata?.sourceKind;
  const modelUnderstanding = input.requester.type === "work" || input.requester.type === "loop" || input.requester.id === "brain-mcp" ||
    input.requester.id === "interaction-wiki-api" ||
    input.requester.id === "work-runtime-command" && input.facets?.commandSource !== "owner" ||
    ["workshop_tool","workshop_run_output","wechat"].includes(String(sourceKind));
  const applicabilityFacets = [input.facets, input.metadata?.facets, input.metadata];
  if (modelUnderstanding && applicabilityFacets.some(value => value && typeof value === 'object' &&
    ['scenarioApplicabilityAuthority', 'scenarioApplicabilityEvidenceRefs'].some(key => Object.hasOwn(value, key)))) {
    throw new BrainMemoryUpdateError('reserved_memory_metadata', 400,
      'An ordinary model understanding cannot assert owner-confirmed global applicability');
  }
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

export async function createMemoryCandidate(input: {
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
  const remote=remoteOwnerOperation(input.requester,'legacy.candidate',input);if(remote)return remote;
  return writeMemory({
    ...input,
    status: "candidate",
  });
}

export async function reviewMemory(input: BrainMemoryReviewInput) {
  const remote=remoteOwnerOperation(input.requester,'legacy.review',input);if(remote)return remote;
  return reviewBrainMemoryTransaction(input);
}

