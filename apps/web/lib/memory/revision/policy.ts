import { verifiedLessonSource } from "../records/lesson-extraction";
import type {
  BrainAccessDecision,
  BrainAccessGrant,
  BrainMemory,
  BrainMemoryType,
  BrainPermission,
  BrainRequester,
  BrainScope,
  BrainValidationIssue,
  BrainWriteRequest,
} from "../kernel/memory-types";

export function scopeMatches(grantScope: BrainScope, targetScope: BrainScope) {
  if (grantScope.type === "global") return true;
  if (grantScope.type !== targetScope.type) return false;
  if (grantScope.type === "workspace" && targetScope.type === "workspace") {
    return grantScope.workspaceId === targetScope.workspaceId;
  }
  if (grantScope.type === "workshop" && targetScope.type === "workshop") {
    return grantScope.workshopId === targetScope.workshopId;
  }
  if (grantScope.type === "work" && targetScope.type === "work") {
    return grantScope.workId === targetScope.workId;
  }
  return false;
}

function requesterOwnsWorkMemory(requester: BrainRequester, memory: BrainMemory) {
  const workId = requester.type === "loop" ? requester.workId : requester.id;
  return (
    (requester.type === "work" || requester.type === "loop") &&
    memory.ownerType === "work" &&
    memory.ownerId === workId
  );
}

function grantApplies(input: {
  grant: BrainAccessGrant;
  requester: BrainRequester;
  targetScope: BrainScope;
  permission: BrainPermission;
  memoryType?: BrainMemoryType;
  now: Date;
}) {
  const { grant, requester, targetScope, permission, memoryType, now } = input;
  if (grant.userId !== requester.userId) return false;
  if (grant.subjectType !== requester.type) return false;
  if (grant.subjectId && grant.subjectId !== (requester.id ?? requester.workId)) {
    return false;
  }
  if (grant.expiresAt && new Date(grant.expiresAt).getTime() <= now.getTime()) {
    return false;
  }
  if (!grant.permissions.includes(permission)) return false;
  if (!scopeMatches(grant.scope, targetScope)) return false;
  if (memoryType && grant.memoryTypes && !grant.memoryTypes.includes(memoryType)) {
    return false;
  }
  return true;
}

export function canReadMemory(input: {
  memory: BrainMemory;
  requester: BrainRequester;
  grants?: BrainAccessGrant[];
  accessMode?: "strict" | "owner_override";
  now?: Date;
}): BrainAccessDecision {
  const {
    memory,
    requester,
    grants = [],
    accessMode = "strict",
    now = new Date(),
  } = input;

  if (memory.userId !== requester.userId) {
    return { allowed: false, reason: "wrong_user" };
  }
  if (memory.metadata?.lessonExtraction) {
    const source = verifiedLessonSource(memory);
    if (!source) return { allowed: false, reason: "lesson_source_changed_or_unverified" };
    const sourceAccess = canReadMemory({ ...input, memory: source });
    if (!sourceAccess.allowed) return { allowed: false, reason: "lesson_source_denied" };
  }
  if (memory.expiresAt && new Date(memory.expiresAt).getTime() <= now.getTime()) {
    return { allowed: false, reason: "expired" };
  }
  const reviewBy = (memory.metadata?.recordLifecycle as { reviewBy?: string } | undefined)?.reviewBy;
  if (reviewBy && Date.parse(reviewBy) <= now.getTime()) return { allowed: false, reason: "expired" };
  if (requester.type === "system") {
    return { allowed: true, reason: "system" };
  }
  if (requester.type === "chat" && accessMode === "owner_override") {
    return { allowed: true, reason: "owner_override" };
  }
  if (requesterOwnsWorkMemory(requester, memory)) {
    return { allowed: true, reason: "same_work_owner" };
  }

  const permission: BrainPermission = requester.type === "work" ? "reference" : "read";
  const hasGrant = grants.some((grant) =>
    grantApplies({
      grant,
      requester,
      targetScope: memory.scope,
      permission,
      memoryType: memory.memoryType,
      now,
    }),
  );
  if (hasGrant) return { allowed: true, reason: "explicit_grant" };
  if (requester.type === "tool") {
    return { allowed: false, reason: "tool_requires_grant" };
  }
  return { allowed: false, reason: "no_matching_grant" };
}

export function canWriteMemory(input: {
  request: BrainWriteRequest;
  grants?: BrainAccessGrant[];
  now?: Date;
}): BrainAccessDecision {
  const { request, grants = [], now = new Date() } = input;
  const { requester } = request;

  if (requester.type === "system") {
    return { allowed: true, reason: "system" };
  }
  if (requester.type === "chat" && request.ownerType === "chat") {
    return { allowed: true, reason: "owner_override" };
  }
  if (
    (requester.type === "work" || requester.type === "loop") &&
    request.ownerType === "work" &&
    request.ownerId === (requester.type === "loop" ? requester.workId : requester.id)
  ) {
    return { allowed: true, reason: "same_work_owner" };
  }

  const hasGrant = grants.some((grant) =>
    grantApplies({
      grant,
      requester,
      targetScope: request.targetScope,
      permission: "write",
      memoryType: request.memoryType,
      now,
    }),
  );
  if (hasGrant) return { allowed: true, reason: "explicit_grant" };
  return { allowed: false, reason: "write_requires_owner_or_grant" };
}

export function validateMemoryWrite(input: {
  request: BrainWriteRequest;
  grants?: BrainAccessGrant[];
  now?: Date;
}): BrainValidationIssue[] {
  const issues: BrainValidationIssue[] = [];
  const { request } = input;

  if (request.confidence < 0 || request.confidence > 100) {
    issues.push({
      code: "confidence_out_of_range",
      message: "Memory confidence must be between 0 and 100.",
    });
  }

  if (
    (request.status === "active" || request.status === "verified") &&
    request.evidenceRefs.length === 0
  ) {
    issues.push({
      code: "evidence_required",
      message: "Active or verified memories require at least one evidence ref.",
    });
  }

  const access = canWriteMemory(input);
  if (!access.allowed) {
    issues.push({
      code: "write_not_allowed",
      message: `Requester cannot write this memory: ${access.reason}.`,
    });
  }

  return issues;
}
