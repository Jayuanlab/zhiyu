export type BrainRequesterType = "chat" | "work" | "loop" | "tool" | "system";

export type BrainPermission = "read" | "reference" | "write" | "review";

export type BrainScope =
  | { type: "global" }
  | { type: "workspace"; workspaceId: string }
  | { type: "workshop"; workshopId: string }
  | { type: "work"; workId: string };

export type BrainMemoryType =
  | "fact"
  | "preference"
  | "plan"
  | "boundary"
  | "relationship"
  | "task"
  | "insight"
  | "system";

export type BrainMemoryStatus =
  | "candidate"
  | "active"
  | "verified"
  | "weakened"
  | "superseded"
  | "deleted";

export type BrainRequester = {
  type: BrainRequesterType;
  userId: string;
  id?: string;
  workId?: string;
  workshopId?: string;
};

export type BrainMemory = {
  id: string;
  userId: string;
  scope: BrainScope;
  ownerType: "chat" | "work" | "system";
  ownerId: string;
  memoryType: BrainMemoryType;
  subject: string;
  content: string;
  status: BrainMemoryStatus;
  confidence: number;
  evidenceRefs: string[];
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  supersedes?: string[];
  metadata?: Record<string, unknown>;
};

export type BrainAccessGrant = {
  id: string;
  userId: string;
  subjectType: BrainRequesterType;
  subjectId?: string;
  scope: BrainScope;
  permissions: BrainPermission[];
  memoryTypes?: BrainMemoryType[];
  expiresAt?: string;
};

export type BrainAccessDecision = {
  allowed: boolean;
  reason:
    | "owner_override"
    | "same_work_owner"
    | "explicit_grant"
    | "system"
    | "wrong_user"
    | "expired"
    | "no_matching_grant"
    | "tool_requires_grant"
    | "write_requires_owner_or_grant";
};

export type BrainWriteRequest = {
  requester: BrainRequester;
  targetScope: BrainScope;
  ownerType: "chat" | "work" | "system";
  ownerId: string;
  memoryType: BrainMemoryType;
  status: BrainMemoryStatus;
  confidence: number;
  evidenceRefs: string[];
};

export type BrainValidationIssue = {
  code:
    | "evidence_required"
    | "confidence_out_of_range"
    | "write_not_allowed"
    | "candidate_requires_review";
  message: string;
};
