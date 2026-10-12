export { loadMemoryRevisionOwner as loadMemoryDependencyOwner } from "./memory-revision-recovery";

export type MemoryDependencyEntityKind = "wiki_note" | "interaction_task" | "loop";
export type MemoryDependencyState = "unknown" | "current" | "stale" | "denied";
export type MemoryDependencySourceRef = { memoryId: string; expectedVersion: string };
export type MemoryDependencyRequest = {
  commandId: string;
  action: "register" | "rebind";
  expectedDependencyVersion: string;
  expectedEntityVersion: string;
  sources: MemoryDependencySourceRef[];
  reason: string;
  evidenceConfirmed: true;
};
export type PendingMemoryDependency = {
  kind: "memory_dependency_pending.v1";
  ownerId: string;
  entityKind: MemoryDependencyEntityKind;
  entityId: string;
  request: MemoryDependencyRequest;
};
export type DependencyMemory = {
  id: string;
  subject: string;
  content: string;
  status: string;
  revisionVersion: string;
  evidenceRefs: string[];
  expiresAt?: string | null;
};
export type MemoryDependencySnapshot = {
  entity: { kind: MemoryDependencyEntityKind; id: string; title: string; content: string; contentTruncated: boolean; status: string; version: string; workId?: string | null };
  coverage: "unknown" | "recorded";
  dependencyVersion: string;
  registry: { snapshotId: string; sequence: number; createdAt: string; reason: string } | null;
  assessment: MemoryDependencyState;
  reasons: string[];
  sources: Array<MemoryDependencySourceRef & {
    assessment: MemoryDependencyState;
    reason: string;
    oldMemory?: DependencyMemory | null;
    currentMemory?: DependencyMemory | null;
    currentVersion?: string | null;
  }>;
};
export type MemoryDependencyReceiptResult = {
  replayed: boolean;
  receipt: {
    id: string;
    commandId: string;
    action: "register" | "rebind";
    entityKind: MemoryDependencyEntityKind;
    entityId: string;
    previousDependencyVersion: string;
    dependencyVersion: string;
    entityVersion: string;
    sourceVersions: MemoryDependencySourceRef[];
    sequence: number;
    snapshotId: string;
    createdAt: string;
  };
};
export type MemoryDependencyCommandState = {
  pending: PendingMemoryDependency | null;
  outcome: "idle" | "unknown" | "saved" | "blocked";
  result: MemoryDependencyReceiptResult | null;
  blockedCode: string | null;
};

export const MEMORY_DEPENDENCY_PENDING_EVENT = "memory-dependency-pending-changed";
export const dependencyRecoveryKey = (ownerId: string) => `memory-dependency-pending:v1:${ownerId}`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const memoryVersion = /^bmrv1:[a-f0-9]{64}$/;
const entityVersion = /^bmde1:[a-f0-9]{64}$/;
const dependencyVersion = /^bmdd1:(?:initial|[a-f0-9]{64})$/;
const states = new Set(["unknown", "current", "stale", "denied"]);
const kinds = new Set(["wiki_note", "interaction_task", "loop"]);
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, limit: number): value is string => typeof value === "string" && !!value.trim() && value.length <= limit;
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

export function normalizeDependencySources(value: unknown): MemoryDependencySourceRef[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20 || value.some(source => !object(source) ||
      !only(source, ["memoryId", "expectedVersion"]) || !uuid.test(source.memoryId) || !memoryVersion.test(source.expectedVersion))) {
    throw new Error("请登记 1 至 20 条带实际版本的记忆依据。");
  }
  const sources = value.map(source => ({ memoryId: source.memoryId.toLowerCase(), expectedVersion: source.expectedVersion }))
    .sort((a, b) => a.memoryId.localeCompare(b.memoryId));
  if (new Set(sources.map(source => source.memoryId)).size !== sources.length) throw new Error("记忆依据不能重复登记。");
  return sources;
}

export function normalizePendingMemoryDependency(value: unknown, ownerId: string): PendingMemoryDependency {
  if (!object(value) || value.kind !== "memory_dependency_pending.v1" || value.ownerId !== ownerId || !text(ownerId, 200) ||
      !kinds.has(value.entityKind) || !uuid.test(value.entityId) || !object(value.request) ||
      !only(value, ["kind", "ownerId", "entityKind", "entityId", "request"])) throw new Error("依据登记恢复记录无效，未发送操作。");
  const request = value.request;
  if (!only(request, ["commandId", "action", "expectedDependencyVersion", "expectedEntityVersion", "sources", "reason", "evidenceConfirmed"]) ||
      !text(request.commandId, 200) || !["register", "rebind"].includes(request.action) ||
      !dependencyVersion.test(request.expectedDependencyVersion) || !entityVersion.test(request.expectedEntityVersion) ||
      !text(request.reason, 2000) || request.evidenceConfirmed !== true) throw new Error("依据登记命令不完整，未发送操作。");
  return { kind: "memory_dependency_pending.v1", ownerId, entityKind: value.entityKind, entityId: value.entityId.toLowerCase(),
    request: { commandId: request.commandId, action: request.action, expectedDependencyVersion: request.expectedDependencyVersion,
      expectedEntityVersion: request.expectedEntityVersion, sources: normalizeDependencySources(request.sources), reason: request.reason, evidenceConfirmed: true } };
}

/** A refreshed stored command cannot erase a response already received by this control. */
export function restoreMemoryDependencyCommandState(current: MemoryDependencyCommandState, stored: PendingMemoryDependency | null): MemoryDependencyCommandState {
  if (stored === null) return current;
  const normalized = normalizePendingMemoryDependency(stored, stored.ownerId);
  if (current.pending) {
    if (JSON.stringify(normalizePendingMemoryDependency(current.pending, current.pending.ownerId)) !== JSON.stringify(normalized)) {
      throw new Error("恢复记录与当前原命令不同，未覆盖已有回执或结果。");
    }
    return current;
  }
  if (current.outcome !== "idle" || current.result !== null || current.blockedCode !== null) throw new Error("当前命令状态需先核对，未覆盖已有结果。");
  return { pending: normalized, outcome: "unknown", result: null, blockedCode: null };
}

export function readPendingMemoryDependency(storage: Pick<Storage, "getItem">, ownerId: string): PendingMemoryDependency | null {
  const raw = storage.getItem(dependencyRecoveryKey(ownerId));
  return raw === null ? null : normalizePendingMemoryDependency(JSON.parse(raw), ownerId);
}

export function persistPendingMemoryDependency(storage: Pick<Storage, "getItem" | "setItem">, pending: PendingMemoryDependency): PendingMemoryDependency {
  const normalized = normalizePendingMemoryDependency(pending, pending.ownerId);
  const current = readPendingMemoryDependency(storage, pending.ownerId);
  if (current && JSON.stringify(current) !== JSON.stringify(normalized)) throw new Error("另一条依据登记仍待核对，请先处理恢复入口中的原命令。");
  storage.setItem(dependencyRecoveryKey(pending.ownerId), JSON.stringify(normalized));
  if (JSON.stringify(readPendingMemoryDependency(storage, pending.ownerId)) !== JSON.stringify(normalized)) throw new Error("恢复记录未能保存，未发送操作。");
  return normalized;
}

export function clearPendingMemoryDependency(storage: Pick<Storage, "getItem" | "removeItem">, pending: PendingMemoryDependency) {
  const current = readPendingMemoryDependency(storage, pending.ownerId);
  if (current && JSON.stringify(current) !== JSON.stringify(normalizePendingMemoryDependency(pending, pending.ownerId))) {
    throw new Error("恢复记录已变化，未清除另一条命令。");
  }
  if (current) storage.removeItem(dependencyRecoveryKey(pending.ownerId));
  if (storage.getItem(dependencyRecoveryKey(pending.ownerId)) !== null) throw new Error("恢复记录未能清除，请重新核对。");
}

export function hasAcknowledgedMemoryDependency(storage: Pick<Storage, "getItem">, pending: PendingMemoryDependency, acknowledged: unknown): boolean {
  try {
    return JSON.stringify(normalizePendingMemoryDependency(pending, pending.ownerId)) ===
      JSON.stringify(normalizePendingMemoryDependency(acknowledged, pending.ownerId)) && storage.getItem(dependencyRecoveryKey(pending.ownerId)) === null;
  } catch { return false; }
}

export function isMemoryDependencyTargetUnavailable(status: number, body: unknown): boolean {
  return status === 404 && object(body) && body.code === "dependency_target_not_found";
}

export function parseDependencyMemory(value: unknown): DependencyMemory {
  if (!object(value) || !uuid.test(value.id) || typeof value.subject !== "string" || typeof value.content !== "string" ||
      typeof value.status !== "string" || !memoryVersion.test(value.revisionVersion) || !Array.isArray(value.evidenceRefs) ||
      value.evidenceRefs.length > 101 || value.evidenceRefs.some((ref: unknown) => !text(ref, 2048)) ||
      value.expiresAt != null && !date(value.expiresAt)) throw new Error("记忆内容或实际版本不完整，请重新读取。");
  return value as DependencyMemory;
}

export function parseMemoryDependencySnapshot(value: unknown, kind: MemoryDependencyEntityKind, id: string): MemoryDependencySnapshot {
  if (!object(value) || !object(value.entity) || value.entity.kind !== kind || value.entity.id !== id ||
      typeof value.entity.title !== "string" || typeof value.entity.content !== "string" || value.entity.content.length > 12000 || typeof value.entity.contentTruncated !== "boolean" ||
      typeof value.entity.status !== "string" || !entityVersion.test(value.entity.version) ||
      !["unknown", "recorded"].includes(value.coverage) || !dependencyVersion.test(value.dependencyVersion) || !states.has(value.assessment) ||
      !Array.isArray(value.reasons) || value.reasons.some((reason: unknown) => typeof reason !== "string") ||
      !Array.isArray(value.sources) || value.sources.length > 20) throw new Error("依据状态或版本信息不完整，请重新读取。");
  if (value.registry === null ? value.dependencyVersion !== "bmdd1:initial" || value.coverage !== "unknown" || value.sources.length !== 0 || value.assessment !== "unknown" :
      !object(value.registry) || !uuid.test(value.registry.snapshotId) || !Number.isSafeInteger(value.registry.sequence) || value.registry.sequence < 1 ||
      !date(value.registry.createdAt) || typeof value.registry.reason !== "string" || value.coverage !== "recorded" || value.sources.length === 0 || value.dependencyVersion === "bmdd1:initial") {
    throw new Error("依据登记快照与版本不匹配，请重新读取。");
  }
  const ids = new Set<string>();
  for (const source of value.sources) {
    if (!object(source) || !uuid.test(source.memoryId) || !memoryVersion.test(source.expectedVersion) || !["current", "stale", "denied"].includes(source.assessment) ||
        typeof source.reason !== "string" || ids.has(source.memoryId)) throw new Error("登记来源不完整或重复，请重新读取。");
    ids.add(source.memoryId);
    if (source.assessment === "denied" && (source.oldMemory != null || source.currentMemory != null)) throw new Error("受限来源不应返回正文，未展示来源。");
    if (source.oldMemory != null && parseDependencyMemory(source.oldMemory).id !== source.memoryId) throw new Error("旧依据编号不匹配，请重新读取。");
    if (source.currentMemory != null && parseDependencyMemory(source.currentMemory).revisionVersion !== source.currentVersion) throw new Error("当前依据版本不匹配，请重新读取。");
    if (source.currentVersion != null && !memoryVersion.test(source.currentVersion)) throw new Error("当前依据版本无效，请重新读取。");
    if (source.assessment === "current" && (!source.currentMemory || source.currentMemory.id !== source.memoryId ||
        source.currentVersion !== source.expectedVersion || !["active", "verified"].includes(source.currentMemory.status) || source.reason === "source_update_pending")) {
      throw new Error("当前有效的依据声明与实际记忆不匹配，请重新读取。");
    }
  }
  if (value.assessment === "current" && value.sources.some((source: Record<string, unknown>) => source.assessment !== "current") ||
      value.coverage === "recorded" && value.assessment === "unknown") throw new Error("依据覆盖与当前状态不匹配，请重新读取。");
  return value as MemoryDependencySnapshot;
}

export function parseMemoryDependencyReceipt(value: unknown, pending: PendingMemoryDependency): MemoryDependencyReceiptResult {
  if (!object(value) || !object(value.receipt) || typeof value.replayed !== "boolean") throw new Error("未取得完整登记回执，结果尚未确认。");
  const receipt = value.receipt;
  if (!uuid.test(receipt.id) || receipt.commandId !== pending.request.commandId || receipt.action !== pending.request.action ||
      receipt.entityKind !== pending.entityKind || receipt.entityId !== pending.entityId ||
      receipt.previousDependencyVersion !== pending.request.expectedDependencyVersion || receipt.entityVersion !== pending.request.expectedEntityVersion ||
      !dependencyVersion.test(receipt.dependencyVersion) || receipt.dependencyVersion === "bmdd1:initial" || receipt.dependencyVersion === pending.request.expectedDependencyVersion ||
      !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1 || !uuid.test(receipt.snapshotId) || !date(receipt.createdAt) ||
      JSON.stringify(normalizeDependencySources(receipt.sourceVersions)) !== JSON.stringify(normalizeDependencySources(pending.request.sources))) {
    throw new Error("登记回执与原命令不匹配，结果尚未确认。请核对当前状态或重试原命令。");
  }
  return value as MemoryDependencyReceiptResult;
}
