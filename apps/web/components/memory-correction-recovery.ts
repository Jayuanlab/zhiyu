export type MemoryCorrectionRequest = { commandId: string; expectedVersion: string; intent: string };
export type MemoryCorrectionDraft = {
  id: string; commandId: string; memoryId: string; expectedVersion: string; intent: string;
  outcome: "ready" | "needs_clarification";
  operation: "correct" | "supplement" | "state_change" | "deactivate" | null;
  content: string | null; reason: string | null; authority: null; sourceObservedAt: null;
  evidenceRefs: string[]; quote: { start: number; end: number; text: string } | null;
  questions: string[]; provider: "deterministic_rules"; detail: string; warnings: string[]; createdAt: string;
};
export type MemoryCorrectionResponse = {
  draft: MemoryCorrectionDraft;
  receipt: { id: string; commandId: string; memoryId: string; expectedVersion: string; draftId: string;
    observationId: string; draftVersion: string; createdAt: string; effective: false };
  current: { memoryId: string; version: string; status: string; expiresAt: string | null; versionMatches: boolean; canSeed: boolean };
  replayed: boolean;
};
export type PendingMemoryCorrection = {
  kind: "memory_correction_draft_pending.v1"; ownerId: string; memoryId: string;
  request: MemoryCorrectionRequest; result: MemoryCorrectionResponse | null;
};

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const memoryVersion = /^bmrv1:[a-f0-9]{64}$/;
const statuses = new Set(["candidate", "active", "verified", "weakened", "superseded", "deleted"]);
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(new Date(value).getTime());
const strings = (value: unknown, count: number, length: number): value is string[] => Array.isArray(value) && value.length <= count && value.every(item => typeof item === "string" && item.length <= length);
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
}
function invalid(): never { throw new Error("纠错草稿或恢复记录无效，未采用任何建议。请保留原编号并重新核对。"); }

export const MEMORY_CORRECTION_PENDING_EVENT = "memory-correction-draft-pending-changed";
export const memoryCorrectionRecoveryKey = (ownerId: string) => `memory-correction-draft-pending:v1:${ownerId}`;

export function normalizeMemoryCorrectionRequest(value: unknown): MemoryCorrectionRequest {
  if (!object(value) || !exactKeys(value, ["commandId", "expectedVersion", "intent"]) ||
      typeof value.commandId !== "string" || !value.commandId.trim() || value.commandId.length > 200 ||
      typeof value.expectedVersion !== "string" || !memoryVersion.test(value.expectedVersion) ||
      typeof value.intent !== "string" || !value.intent.trim() || value.intent.length > 4000 || value.intent.includes("\0")) invalid();
  return { commandId: value.commandId.trim(), expectedVersion: value.expectedVersion, intent: value.intent };
}

/** Match the saved command and original quotation; a success status alone cannot seed a revision. */
export function parseMemoryCorrectionResponse(value: unknown, pending: Pick<PendingMemoryCorrection, "memoryId" | "request">): MemoryCorrectionResponse {
  if (!object(value) || !object(value.draft) || !object(value.receipt) || !object(value.current)) invalid();
  const { draft, receipt, current } = value;
  const request = normalizeMemoryCorrectionRequest(pending.request);
  if (typeof draft.id !== "string" || !uuid.test(draft.id) || draft.commandId !== request.commandId ||
      draft.memoryId !== pending.memoryId || draft.expectedVersion !== request.expectedVersion || draft.intent !== request.intent ||
      !["ready", "needs_clarification"].includes(draft.outcome) || draft.authority !== null || draft.sourceObservedAt !== null ||
      draft.provider !== "deterministic_rules" || typeof draft.detail !== "string" || !draft.detail || draft.detail.length > 4000 ||
      !strings(draft.questions, 20, 4000) || !strings(draft.warnings, 20, 4000) || !date(draft.createdAt) ||
      !strings(draft.evidenceRefs, 101, 2048) || draft.evidenceRefs.length !== 1 ||
      typeof receipt.id !== "string" || !uuid.test(receipt.id) || receipt.commandId !== request.commandId ||
      receipt.memoryId !== pending.memoryId || receipt.expectedVersion !== request.expectedVersion || receipt.draftId !== draft.id ||
      typeof receipt.observationId !== "string" || !uuid.test(receipt.observationId) ||
      draft.evidenceRefs[0] !== `brain-observation:${receipt.observationId}` ||
      typeof receipt.draftVersion !== "string" || !/^bmcd1:[a-f0-9]{64}$/.test(receipt.draftVersion) ||
      receipt.effective !== false || !date(receipt.createdAt) || receipt.createdAt !== draft.createdAt ||
      current.memoryId !== pending.memoryId || typeof current.version !== "string" || !memoryVersion.test(current.version) ||
      !statuses.has(current.status) || (current.expiresAt !== null && !date(current.expiresAt)) ||
      typeof current.versionMatches !== "boolean" || current.versionMatches !== (current.version === request.expectedVersion) ||
      typeof current.canSeed !== "boolean" || current.canSeed && (!current.versionMatches || ["deleted", "superseded"].includes(current.status)) ||
      typeof value.replayed !== "boolean") invalid();
  if (draft.outcome === "ready") {
    if (!["correct", "supplement", "state_change", "deactivate"].includes(draft.operation) || !object(draft.quote) || draft.questions.length !== 0 ||
        typeof draft.reason !== "string" || !draft.reason.trim() || draft.reason.length > 4000 ||
        (draft.operation === "deactivate" ? draft.content !== null : typeof draft.content !== "string" || !draft.content.trim() || draft.content.length > 64000 || draft.content !== draft.quote.text)) invalid();
  } else if (draft.operation !== null || draft.content !== null || draft.reason !== null || draft.questions.length === 0) invalid();
  if (draft.quote !== null && (!object(draft.quote) || !Number.isInteger(draft.quote.start) || !Number.isInteger(draft.quote.end) ||
      draft.quote.start < 0 || draft.quote.end <= draft.quote.start || draft.quote.end > request.intent.length ||
      draft.quote.text !== request.intent.slice(draft.quote.start, draft.quote.end))) invalid();
  return {
    draft: { id: draft.id, commandId: draft.commandId, memoryId: draft.memoryId, expectedVersion: draft.expectedVersion, intent: draft.intent,
      outcome: draft.outcome, operation: draft.operation, content: draft.content, reason: draft.reason, authority: null, sourceObservedAt: null,
      evidenceRefs: [...draft.evidenceRefs], quote: draft.quote === null ? null : { start: draft.quote.start, end: draft.quote.end, text: draft.quote.text },
      questions: [...draft.questions], provider: "deterministic_rules", detail: draft.detail, warnings: [...draft.warnings], createdAt: draft.createdAt },
    receipt: { id: receipt.id, commandId: receipt.commandId, memoryId: receipt.memoryId, expectedVersion: receipt.expectedVersion,
      draftId: receipt.draftId, observationId: receipt.observationId, draftVersion: receipt.draftVersion, createdAt: receipt.createdAt, effective: false },
    current: { memoryId: current.memoryId, version: current.version, status: current.status, expiresAt: current.expiresAt,
      versionMatches: current.versionMatches, canSeed: current.canSeed }, replayed: value.replayed,
  };
}

export function normalizePendingMemoryCorrection(value: unknown, ownerId: string): PendingMemoryCorrection {
  if (!object(value) || !exactKeys(value, ["kind", "ownerId", "memoryId", "request", "result"]) ||
      value.kind !== "memory_correction_draft_pending.v1" || value.ownerId !== ownerId ||
      typeof value.memoryId !== "string" || !uuid.test(value.memoryId)) invalid();
  const pending: PendingMemoryCorrection = { kind: "memory_correction_draft_pending.v1", ownerId, memoryId: value.memoryId,
    request: normalizeMemoryCorrectionRequest(value.request), result: null };
  if (value.result !== null) pending.result = parseMemoryCorrectionResponse(value.result, pending);
  return pending;
}

export function readPendingMemoryCorrection(storage: Pick<Storage, "getItem">, ownerId: string): PendingMemoryCorrection | null {
  const raw = storage.getItem(memoryCorrectionRecoveryKey(ownerId));
  return raw === null ? null : normalizePendingMemoryCorrection(JSON.parse(raw), ownerId);
}

export function sameMemoryCorrectionCommand(a: PendingMemoryCorrection, b: PendingMemoryCorrection) {
  return a.ownerId === b.ownerId && a.memoryId === b.memoryId && JSON.stringify(a.request) === JSON.stringify(b.request);
}

export function persistPendingMemoryCorrection(storage: Pick<Storage, "getItem" | "setItem">, record: PendingMemoryCorrection) {
  const pending = normalizePendingMemoryCorrection(record, record.ownerId);
  const existing = readPendingMemoryCorrection(storage, pending.ownerId);
  if (existing && (!sameMemoryCorrectionCommand(existing, pending) || existing.result && pending.result &&
      (JSON.stringify(existing.result.draft) !== JSON.stringify(pending.result.draft) || JSON.stringify(existing.result.receipt) !== JSON.stringify(pending.result.receipt)))) {
    throw new Error("还有一份纠错草稿，请先通过恢复入口核对或明确放弃原草稿。");
  }
  if (existing?.result && !pending.result) throw new Error("已取得草稿回执，不能把它降为结果未知。");
  storage.setItem(memoryCorrectionRecoveryKey(pending.ownerId), JSON.stringify(pending));
  if (JSON.stringify(readPendingMemoryCorrection(storage, pending.ownerId)) !== JSON.stringify(pending)) throw new Error("草稿恢复记录保存失败。未发送新的请求。");
}

export function clearPendingMemoryCorrection(storage: Pick<Storage, "getItem" | "removeItem">, record: PendingMemoryCorrection) {
  const pending = normalizePendingMemoryCorrection(record, record.ownerId);
  const existing = readPendingMemoryCorrection(storage, pending.ownerId);
  if (!existing || JSON.stringify(existing) !== JSON.stringify(pending)) throw new Error("草稿暂存已变化，未清除其它记录。");
  storage.removeItem(memoryCorrectionRecoveryKey(pending.ownerId));
  if (storage.getItem(memoryCorrectionRecoveryKey(pending.ownerId)) !== null) throw new Error("草稿暂存未清除，请重新读取后再操作。");
}

export function canSeedMemoryCorrection(record: PendingMemoryCorrection, memoryId: string, expectedVersion: string) {
  return record.memoryId === memoryId && record.request.expectedVersion === expectedVersion &&
    record.result?.draft.outcome === "ready" && record.result.current.versionMatches && record.result.current.canSeed;
}
