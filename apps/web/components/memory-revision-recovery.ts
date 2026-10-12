export type RevisionOperation = "correct" | "supplement" | "state_change" | "deactivate" | "restore";
export type RevisionAuthority = "owner_statement" | "external_fact";
export type RevisionRequest = {
  commandId: string;
  expectedVersion: string;
  operation: RevisionOperation;
  authority: RevisionAuthority;
  reason: string;
  content?: string;
  evidenceRefs: string[];
  sourceObservedAt?: string;
};
export type PendingMemoryRevision = {
  kind: "memory_revision_pending.v1";
  ownerId: string;
  memoryId: string;
  request: RevisionRequest;
  reviewPending?: { memoryId: string; expectedVersion: string };
};
export type PendingMemoryReview = {
  kind: "memory_revision_review_pending.v1";
  ownerId: string;
  memoryId: string;
  expectedVersion: string;
};

export const MEMORY_REVISION_PENDING_EVENT = "memory-revision-pending-changed";
export const memoryRevisionRecoveryKey = (ownerId: string) => `memory-revision-pending:v1:${ownerId}`;
export const memoryReviewRecoveryKey = (ownerId: string) => `memory-revision-review-pending:v1:${ownerId}`;

export function canEndMemoryReviewRecovery(pending: PendingMemoryReview, current: {
  memoryId: string; expectedVersion: string; status: string;
}) {
  return current.memoryId === pending.memoryId && /^bmrv1:[a-f0-9]{64}$/.test(current.expectedVersion) &&
    (current.expectedVersion !== pending.expectedVersion || ["deleted", "superseded"].includes(current.status));
}

export async function loadMemoryRevisionOwner(): Promise<string> {
  const response = await fetch("/api/identity", { cache: "no-store", signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.actorId !== "string" || !body.actorId) throw new Error("无法确认当前登录身份。");
  return body.actorId;
}

/** Restore only the current owner's bounded, versioned request. Never reconstruct a new command. */
export function readPendingMemoryRevision(storage: Pick<Storage, "getItem">, ownerId: string): PendingMemoryRevision | null {
  const raw = storage.getItem(memoryRevisionRecoveryKey(ownerId));
  if (!raw) return null;
  const value = JSON.parse(raw);
  const request = value?.request;
  if (value?.kind !== "memory_revision_pending.v1" || value.ownerId !== ownerId ||
      typeof value.memoryId !== "string" || !/^[a-f0-9-]{36}$/i.test(value.memoryId) ||
      typeof request?.commandId !== "string" || !request.commandId || request.commandId.length > 200 ||
      typeof request.expectedVersion !== "string" || !/^bmrv1:[a-f0-9]{64}$/.test(request.expectedVersion) ||
      !["correct", "supplement", "state_change", "deactivate", "restore"].includes(request.operation) ||
      !["owner_statement", "external_fact"].includes(request.authority) ||
      typeof request.reason !== "string" || !request.reason.trim() || request.reason.length > 4000 ||
      !Array.isArray(request.evidenceRefs) || request.evidenceRefs.length > 101 ||
      request.evidenceRefs.some((ref: unknown) => typeof ref !== "string" || !ref.trim() || ref.length > 2048) ||
      (request.operation === "deactivate" ? request.content !== undefined : typeof request.content !== "string" || !request.content.trim() || request.content.length > 64000) ||
      (request.sourceObservedAt !== undefined && (request.operation !== "state_change" || typeof request.sourceObservedAt !== "string" || !Number.isFinite(new Date(request.sourceObservedAt).getTime())))) {
    throw new Error("恢复记录无效，未发送任何更新。请保留原提交编号并核对记录。");
  }
  if (value.reviewPending !== undefined && (typeof value.reviewPending?.memoryId !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(value.reviewPending.memoryId) ||
      typeof value.reviewPending.expectedVersion !== "string" || !/^bmrv1:[a-f0-9]{64}$/.test(value.reviewPending.expectedVersion))) {
    throw new Error("审核恢复记录无效，未发送审核。");
  }
  return {
    kind: "memory_revision_pending.v1", ownerId, memoryId: value.memoryId,
    request: {
      commandId: request.commandId, expectedVersion: request.expectedVersion,
      operation: request.operation, authority: request.authority, reason: request.reason,
      ...(request.content === undefined ? {} : { content: request.content }),
      evidenceRefs: [...request.evidenceRefs],
      ...(request.sourceObservedAt === undefined ? {} : { sourceObservedAt: request.sourceObservedAt }),
    },
    ...(value.reviewPending === undefined ? {} : { reviewPending: {
      memoryId: value.reviewPending.memoryId, expectedVersion: value.reviewPending.expectedVersion,
    } }),
  };
}

export function persistPendingMemoryRevision(storage: Pick<Storage, "getItem" | "setItem">, pending: PendingMemoryRevision) {
  const existing = readPendingMemoryRevision(storage, pending.ownerId);
  if (existing && (existing.memoryId !== pending.memoryId || JSON.stringify(existing.request) !== JSON.stringify(pending.request))) {
    throw new Error("还有一条更新等待回执，请先通过页面的恢复入口处理原提交。");
  }
  storage.setItem(memoryRevisionRecoveryKey(pending.ownerId), JSON.stringify(pending));
  const stored = readPendingMemoryRevision(storage, pending.ownerId);
  if (!stored || JSON.stringify(stored) !== JSON.stringify(pending)) throw new Error("恢复记录保存失败，未发送更新。");
}

export function clearPendingMemoryRevision(storage: Pick<Storage, "getItem" | "removeItem">, ownerId: string, commandId: string) {
  const current = readPendingMemoryRevision(storage, ownerId);
  if (current?.request.commandId === commandId) storage.removeItem(memoryRevisionRecoveryKey(ownerId));
}

/** A review recovery marker identifies an existing version; it never invents a revision command. */
export function readPendingMemoryReview(storage: Pick<Storage, "getItem">, ownerId: string): PendingMemoryReview | null {
  const raw = storage.getItem(memoryReviewRecoveryKey(ownerId));
  if (!raw) return null;
  const value = JSON.parse(raw);
  if (value?.kind !== "memory_revision_review_pending.v1" || value.ownerId !== ownerId ||
      typeof value.memoryId !== "string" || !/^[a-f0-9-]{36}$/i.test(value.memoryId) ||
      typeof value.expectedVersion !== "string" || !/^bmrv1:[a-f0-9]{64}$/.test(value.expectedVersion) ||
      Object.keys(value).some(key => !["kind", "ownerId", "memoryId", "expectedVersion"].includes(key))) {
    throw new Error("审核恢复记录无效，未发送审核。请保留记忆编号并核对当前版本。");
  }
  return { kind: "memory_revision_review_pending.v1", ownerId, memoryId: value.memoryId, expectedVersion: value.expectedVersion };
}

export function persistPendingMemoryReview(storage: Pick<Storage, "getItem" | "setItem">, pending: PendingMemoryReview) {
  const existing = readPendingMemoryReview(storage, pending.ownerId);
  if (existing && (existing.memoryId !== pending.memoryId || existing.expectedVersion !== pending.expectedVersion)) {
    throw new Error("还有一条记忆核实等待结果核对，请先通过恢复入口处理。");
  }
  storage.setItem(memoryReviewRecoveryKey(pending.ownerId), JSON.stringify(pending));
  const stored = readPendingMemoryReview(storage, pending.ownerId);
  if (!stored || stored.ownerId !== pending.ownerId || stored.memoryId !== pending.memoryId ||
      stored.expectedVersion !== pending.expectedVersion) throw new Error("审核恢复记录保存失败，未发送审核。");
}

export function clearPendingMemoryReview(storage: Pick<Storage, "getItem" | "removeItem">, pending: PendingMemoryReview) {
  const current = readPendingMemoryReview(storage, pending.ownerId);
  if (current?.memoryId === pending.memoryId && current.expectedVersion === pending.expectedVersion) {
    storage.removeItem(memoryReviewRecoveryKey(pending.ownerId));
  }
}
