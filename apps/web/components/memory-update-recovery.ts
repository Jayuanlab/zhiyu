export { loadMemoryRevisionOwner as loadMemoryUpdateOwner } from "./memory-revision-recovery";

export type MemoryUpdateDecisionRequest = {
  action: "accept" | "reject";
  commandId: string;
  expectedVersion: string;
  expectedBaseVersion: string;
  reason: string;
  evidenceConfirmed?: true;
};
export type MemoryUpdatePolicyRequest = {
  commandId: string;
  expectedVersion: string;
  enabled: boolean;
  reason: string;
};
export type PendingMemoryUpdate = {
  kind: "memory_update_pending.v1";
  ownerId: string;
} & ({
  actionKind: "decision";
  candidateId: string;
  baseMemoryId: string;
  request: MemoryUpdateDecisionRequest;
} | {
  actionKind: "policy";
  request: MemoryUpdatePolicyRequest;
});

export type MemoryUpdateMemory = {
  id: string;
  subject: string;
  content: string;
  status: string;
  revisionVersion: string;
  evidenceRefs: string[];
  createdAt: string;
  updatedAt: string;
  ownerType: string;
  ownerId: string;
  scope: { type: string; workspaceId?: string; workshopId?: string; workId?: string };
  metadata?: Record<string, unknown>;
};
export type MemoryUpdateSnapshot = {
  candidate: MemoryUpdateMemory;
  proposalVersion: string;
  base: MemoryUpdateMemory;
  baseVersion: string;
  proposal: {
    status: "pending" | "accepted" | "rejected";
    targetMemoryId: string;
    expectedBaseVersion: string;
    commandId: string;
    reason: string;
    createdAt: string;
  };
};
export type MemoryUpdateDecisionResult = {
  candidate: MemoryUpdateMemory;
  base: MemoryUpdateMemory;
  baseVersion: string;
  proposalVersion: string;
  replayed: boolean;
  receipt: {
    id: string;
    commandId: string;
    action: "accept" | "reject";
    status: "accepted" | "rejected";
    candidateId: string;
    baseMemoryId: string;
    previousProposalVersion: string;
    previousBaseVersion: string;
    proposalVersion: string;
    baseVersion: string;
    effective: boolean;
    createdAt: string;
  };
};
export type MemoryUpdatePolicySnapshot = { enabled: boolean; version: string; snapshotId: string | null };
export type MemoryUpdatePolicyResult = MemoryUpdatePolicySnapshot & {
  replayed: boolean;
  receipt: {
    id: string;
    commandId: string;
    enabled: boolean;
    previousVersion: string;
    version: string;
    snapshotId: string;
    createdAt: string;
  };
};

export const MEMORY_UPDATE_PENDING_EVENT = "memory-update-pending-changed";
export const memoryUpdateRecoveryKey = (ownerId: string) => `memory-update-pending:v1:${ownerId}`;
const memoryVersion = /^bmrv1:[a-f0-9]{64}$/;
const policyVersion = /^bmup1:(?:initial|[a-f0-9]{64})$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, limit: number): value is string => typeof value === "string" && !!value.trim() && value.length <= limit;
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(new Date(value).getTime());
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

function normalizePending(value: unknown, ownerId: string): PendingMemoryUpdate {
  if (!object(value) || value.kind !== "memory_update_pending.v1" || value.ownerId !== ownerId || !text(ownerId, 200) ||
      !object(value.request) || !text(value.request.commandId, 200) || !text(value.request.reason, 2000)) {
    throw new Error("记忆更新恢复记录无效，未发送操作。请保留原提交编号核对记录。");
  }
  const request = value.request;
  if (value.actionKind === "decision" && only(value, ["kind", "ownerId", "actionKind", "candidateId", "baseMemoryId", "request"]) &&
      uuid.test(value.candidateId) && uuid.test(value.baseMemoryId) && value.candidateId !== value.baseMemoryId &&
      ["accept", "reject"].includes(request.action) && memoryVersion.test(request.expectedVersion) && memoryVersion.test(request.expectedBaseVersion) &&
      only(request, ["action", "commandId", "expectedVersion", "expectedBaseVersion", "reason", "evidenceConfirmed"]) &&
      (request.action === "accept" ? request.evidenceConfirmed === true : request.evidenceConfirmed === undefined)) {
    return { kind: "memory_update_pending.v1", ownerId, actionKind: "decision", candidateId: value.candidateId,
      baseMemoryId: value.baseMemoryId, request: { action: request.action, commandId: request.commandId,
        expectedVersion: request.expectedVersion, expectedBaseVersion: request.expectedBaseVersion, reason: request.reason,
        ...(request.action === "accept" ? { evidenceConfirmed: true } : {}) } };
  }
  if (value.actionKind === "policy" && only(value, ["kind", "ownerId", "actionKind", "request"]) &&
      typeof request.enabled === "boolean" && policyVersion.test(request.expectedVersion) &&
      only(request, ["commandId", "expectedVersion", "enabled", "reason"])) {
    return { kind: "memory_update_pending.v1", ownerId, actionKind: "policy", request: {
      commandId: request.commandId, expectedVersion: request.expectedVersion, enabled: request.enabled, reason: request.reason } };
  }
  throw new Error("记忆更新恢复记录无效，未发送操作。请保留原提交编号核对记录。");
}

export function readPendingMemoryUpdate(storage: Pick<Storage, "getItem">, ownerId: string): PendingMemoryUpdate | null {
  const raw = storage.getItem(memoryUpdateRecoveryKey(ownerId));
  return raw ? normalizePending(JSON.parse(raw), ownerId) : null;
}

/** One owner-scoped slot retains the exact command until its outcome is acknowledged. */
export function persistPendingMemoryUpdate(storage: Pick<Storage, "getItem" | "setItem">, pending: PendingMemoryUpdate) {
  const normalized = normalizePending(pending, pending.ownerId);
  const existing = readPendingMemoryUpdate(storage, pending.ownerId);
  if (existing && JSON.stringify(existing) !== JSON.stringify(normalized)) throw new Error("还有一条记忆提案审核或设置等待回执，请先使用恢复入口处理原提交。");
  storage.setItem(memoryUpdateRecoveryKey(pending.ownerId), JSON.stringify(normalized));
  const stored = readPendingMemoryUpdate(storage, pending.ownerId);
  if (!stored || JSON.stringify(stored) !== JSON.stringify(normalized)) throw new Error("恢复记录保存失败，未发送操作。");
}

export function clearPendingMemoryUpdate(storage: Pick<Storage, "getItem" | "removeItem">, pending: PendingMemoryUpdate) {
  const current = readPendingMemoryUpdate(storage, pending.ownerId);
  if (current && JSON.stringify(current) === JSON.stringify(normalizePending(pending, pending.ownerId))) {
    storage.removeItem(memoryUpdateRecoveryKey(pending.ownerId));
    if (storage.getItem(memoryUpdateRecoveryKey(pending.ownerId)) !== null) throw new Error("本地恢复记录未能清除，请重新核对。");
  }
}

/** Another control may acknowledge this exact command; never discard a different or still stored command. */
export function hasAcknowledgedMemoryUpdate(storage: Pick<Storage, "getItem">, pending: PendingMemoryUpdate, acknowledged: unknown): boolean {
  try {
    const normalized = normalizePending(pending, pending.ownerId);
    const cleared = normalizePending(acknowledged, pending.ownerId);
    return JSON.stringify(normalized) === JSON.stringify(cleared) && storage.getItem(memoryUpdateRecoveryKey(pending.ownerId)) === null;
  } catch { return false; }
}

export function isMemoryUpdateMemory(value: unknown): value is MemoryUpdateMemory {
  return object(value) && typeof value.id === "string" && uuid.test(value.id) && typeof value.subject === "string" &&
    typeof value.content === "string" && typeof value.status === "string" && memoryVersion.test(value.revisionVersion) &&
    Array.isArray(value.evidenceRefs) && value.evidenceRefs.length <= 101 && value.evidenceRefs.every((ref: unknown) => text(ref, 2048)) &&
    date(value.createdAt) && date(value.updatedAt) && text(value.ownerType, 100) && text(value.ownerId, 200) &&
    object(value.scope) && text(value.scope.type, 100) && (value.metadata === undefined || object(value.metadata));
}

export function parseMemoryUpdateSnapshot(value: unknown, candidateId: string): MemoryUpdateSnapshot {
  if (!object(value) || !isMemoryUpdateMemory(value.candidate) || !isMemoryUpdateMemory(value.base) || !object(value.proposal) ||
      value.candidate.id !== candidateId || value.candidate.id === value.base.id ||
      value.proposalVersion !== value.candidate.revisionVersion || value.baseVersion !== value.base.revisionVersion ||
      value.proposal.targetMemoryId !== value.base.id || !memoryVersion.test(value.proposal.expectedBaseVersion) ||
      !["pending", "accepted", "rejected"].includes(value.proposal.status) || !text(value.proposal.commandId, 200) ||
      !text(value.proposal.reason, 2000) || !date(value.proposal.createdAt) ||
      value.candidate.ownerType !== value.base.ownerType || value.candidate.ownerId !== value.base.ownerId ||
      value.candidate.scope.type !== value.base.scope.type || value.candidate.scope.workspaceId !== value.base.scope.workspaceId ||
      value.candidate.scope.workshopId !== value.base.scope.workshopId || value.candidate.scope.workId !== value.base.scope.workId ||
      !object(value.candidate.metadata?.updateProposal) || value.candidate.metadata.updateProposal.targetMemoryId !== value.base.id ||
      value.candidate.metadata.updateProposal.expectedBaseVersion !== value.proposal.expectedBaseVersion ||
      value.candidate.metadata.updateProposal.commandId !== value.proposal.commandId ||
      value.candidate.metadata.updateProposal.status !== value.proposal.status) {
    throw new Error("提案与当前记忆版本信息不完整或不匹配，请重新读取，未发送审核。");
  }
  return value as MemoryUpdateSnapshot;
}

export function parseMemoryUpdateDecisionResult(value: unknown, pending: Extract<PendingMemoryUpdate, { actionKind: "decision" }>): MemoryUpdateDecisionResult {
  if (!object(value) || !isMemoryUpdateMemory(value.candidate) || !isMemoryUpdateMemory(value.base) || !object(value.receipt)) {
    throw new Error("审核回执不完整，结果尚未确认。请使用原提交编号重试核对。");
  }
  const receipt = value.receipt;
  const accepted = pending.request.action === "accept";
  const proposal = value.candidate.metadata?.updateProposal;
  const revision = value.candidate.metadata?.revision;
  const retired = value.base.metadata?.revisionRetired;
  if (!uuid.test(receipt.id) || receipt.commandId !== pending.request.commandId || receipt.action !== pending.request.action ||
      receipt.status !== (accepted ? "accepted" : "rejected") || receipt.candidateId !== pending.candidateId || receipt.baseMemoryId !== pending.baseMemoryId ||
      value.candidate.id !== pending.candidateId || value.base.id !== pending.baseMemoryId ||
      receipt.previousProposalVersion !== pending.request.expectedVersion || receipt.previousBaseVersion !== pending.request.expectedBaseVersion ||
      receipt.proposalVersion !== value.proposalVersion || value.proposalVersion !== value.candidate.revisionVersion ||
      receipt.baseVersion !== value.baseVersion || value.baseVersion !== value.base.revisionVersion ||
      value.proposalVersion === pending.request.expectedVersion ||
      (accepted ? value.baseVersion === pending.request.expectedBaseVersion : value.baseVersion !== pending.request.expectedBaseVersion) ||
      !object(proposal) || proposal.targetMemoryId !== pending.baseMemoryId || proposal.decisionCommandId !== pending.request.commandId ||
      proposal.status !== receipt.status ||
      (accepted && (!object(revision) || revision.commandId !== pending.request.commandId || revision.previousMemoryId !== pending.baseMemoryId ||
        revision.previousVersion !== pending.request.expectedBaseVersion || !object(retired) || retired.commandId !== pending.request.commandId || retired.nextMemoryId !== pending.candidateId)) ||
      receipt.effective !== accepted || (accepted ? value.candidate.status !== "active" || value.base.status !== "superseded" : value.candidate.status !== "deleted") ||
      typeof value.replayed !== "boolean" || !date(receipt.createdAt)) {
    throw new Error("审核回执与原提交不匹配，结果尚未确认。请使用原提交编号重试核对。");
  }
  return value as MemoryUpdateDecisionResult;
}

export function parseMemoryUpdatePolicySnapshot(value: unknown): MemoryUpdatePolicySnapshot {
  if (!object(value) || typeof value.enabled !== "boolean" || !policyVersion.test(value.version) ||
      (value.version === "bmup1:initial" ? value.snapshotId !== null : typeof value.snapshotId !== "string" || !uuid.test(value.snapshotId))) {
    throw new Error("自动生效设置的版本信息不完整，请重新读取。");
  }
  return value as MemoryUpdatePolicySnapshot;
}

export function parseMemoryUpdatePolicyResult(value: unknown, pending: Extract<PendingMemoryUpdate, { actionKind: "policy" }>): MemoryUpdatePolicyResult {
  const snapshot = parseMemoryUpdatePolicySnapshot(value);
  if (snapshot.version === "bmup1:initial" || snapshot.snapshotId === null || snapshot.version === pending.request.expectedVersion ||
      !object(value) || !object(value.receipt) || !uuid.test(value.receipt.id) ||
      value.receipt.commandId !== pending.request.commandId || value.receipt.enabled !== pending.request.enabled || snapshot.enabled !== pending.request.enabled ||
      value.receipt.previousVersion !== pending.request.expectedVersion || value.receipt.version !== snapshot.version ||
      value.receipt.snapshotId !== snapshot.snapshotId || typeof value.replayed !== "boolean" || !date(value.receipt.createdAt)) {
    throw new Error("设置回执与原提交不匹配，结果尚未确认。请使用原提交编号重试核对。");
  }
  return value as MemoryUpdatePolicyResult;
}
