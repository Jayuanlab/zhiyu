import type { WorkshopEvent } from "./run-history-types";

const WORKING_MEMORY_EVENTS = new Set([
  "working_memory_updated",
  "working_memory_rejected",
  "working_memory_restored",
  "working_memory_projected",
]);

export type WorkingMemoryEntryView = {
  text: string;
  evidenceRefs: string[];
};

export type WorkingMemoryRecordView = {
  id: string;
  type: string;
  seq: number;
  createdAt: string;
  mode: string | null;
  modeLabel: string;
  version: string | null;
  previousVersion: string | null;
  statusLabel: string;
  commandId: string | null;
  reason: string | null;
  reasonLabel: string | null;
  persistenceError: string | null;
  facts: WorkingMemoryEntryView[];
  hypotheses: WorkingMemoryEntryView[];
  openQuestions: string[];
  nextAction: string | null;
  nextActionEvidenceRefs: string[];
  evidenceRefs: string[];
  prunedToolCallIds: string[];
  restoredToolCallIds: string[];
  projection: {
    originalChars: number;
    projectedChars: number;
    originalMessageCount: number | null;
    projectedMessageCount: number | null;
  } | null;
  warnings: string[];
};

export type WorkingMemoryView = {
  records: WorkingMemoryRecordView[];
  latest: WorkingMemoryRecordView;
  checkpoint: WorkingMemoryRecordView | null;
  projection: WorkingMemoryRecordView | null;
};

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((entry) => {
    const entryText = text(entry);
    return entryText ? [entryText] : [];
  }))];
}

function referenceText(value: unknown): string | null {
  const plain = text(value);
  if (plain) return plain;
  const reference = object(value);
  const id = text(reference.id) ?? text(reference.eventId) ??
    text(reference.sourceEventId) ?? text(reference.toolCallId);
  const kind = text(reference.kind) ?? text(reference.type);
  return id ? (kind ? `${kind}: ${id}` : id) : null;
}

function references(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((entry) => {
    const reference = referenceText(entry);
    return reference ? [reference] : [];
  }))];
}

function entries(value: unknown): WorkingMemoryEntryView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const plain = text(entry);
    if (plain) return [{ text: plain, evidenceRefs: [] }];
    const item = object(entry);
    const content = text(item.text) ?? text(item.content) ?? text(item.summary);
    return content ? [{ text: content, evidenceRefs: references(item.evidenceIds ?? item.evidenceRefs) }] : [];
  });
}

function version(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return text(value);
}

function modeLabel(mode: string | null): string {
  if (mode === "shadow") return "试运行 · 仅记录候选";
  if (mode === "apply") return "启用 · 整理本轮上下文";
  if (mode === "off" || mode === "disabled") return "已关闭";
  return mode ? `未知模式（${mode}）` : "模式未记录";
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const REJECTION_REASON_LABELS: Record<string, string> = {
  disabled: "本轮工作记忆已关闭",
  invalid_command: "整理指令的结构、引用或长度不符合要求",
  command_id_conflict: "整理指令编号已用于不同内容",
  version_conflict: "摘要版本已变化，需先读取当前版本",
  command_limit: "本轮整理指令记录已达上限",
  edit_limit: "本轮更新次数已达上限，仍可读取或恢复",
  summary_limit: "保留摘要超过本轮长度上限",
  unknown_evidence: "摘要引用了当前读取目录之外的工具回执",
  unsafe_prune: "选择的回执不存在、受到保护或不属于可移出的完整读取记录",
  already_pruned: "选择的工具回执已经在移出集合中",
  incomplete_group: "同组读取回执需要完整保留或一起移出",
  unreferenced_prune: "移出的工具回执未在保留摘要中引用",
  audit_failed: "整理审计回执保存失败，保留上次状态",
};

function recordView(event: WorkshopEvent): WorkingMemoryRecordView {
  const metadata = object(event.metadata);
  const snapshot = object(metadata.snapshot);
  const state = object(metadata.state);
  const payload = Object.keys(state).length ? state : Object.keys(snapshot).length ? snapshot : metadata;
  const mode = text(metadata.mode) ?? text(payload.mode);
  const persistenceError = text(metadata.persistenceError) ?? text(metadata.persistence_error);
  const rejected = event.type === "working_memory_rejected";
  const restored = event.type === "working_memory_restored";
  const projected = event.type === "working_memory_projected";
  const reason = text(metadata.reason) ?? text(metadata.code) ?? text(payload.reason);
  const originalChars = nonnegativeInteger(metadata.originalChars);
  const projectedChars = nonnegativeInteger(metadata.projectedChars);
  const projection = projected && originalChars !== null && projectedChars !== null ? {
    originalChars,
    projectedChars,
    originalMessageCount: nonnegativeInteger(metadata.originalMessageCount),
    projectedMessageCount: nonnegativeInteger(metadata.projectedMessageCount),
  } : null;
  const warnings: string[] = [];
  if (metadata.__truncated === true) warnings.push("这条整理记录已截断，保留内容和来源可能不完整。请重新读取完整运行记录。");
  if (persistenceError) warnings.push("整理状态未可靠保存，请结合原始运行记录核对；不能据此确认本轮整理生效。");
  if (projected && !projection) warnings.push("请求准备记录未包含有效字符计数，无法判断上下文变化量。");
  if (!rejected && mode !== "apply" && mode !== "shadow") warnings.push("未记录可识别的整理模式，不能据此确认上下文是否发生改变。");
  return {
    id: event.id,
    type: event.type,
    seq: event.seq,
    createdAt: event.createdAt,
    mode,
    modeLabel: modeLabel(mode),
    version: version(metadata.version ?? payload.version),
    previousVersion: version(metadata.previousVersion),
    statusLabel: rejected ? "整理未应用" : persistenceError ? "保存结果异常" :
      projected ? (mode === "shadow" ? "试运行请求已准备（未裁剪）" : "模型请求上下文已准备") :
      restored ? "恢复状态已保存" : mode === "shadow" ? "候选已记录" :
      mode === "apply" ? "整理已保存，待模型调用采用" : "整理动作已记录",
    commandId: text(metadata.commandId) ?? text(payload.commandId),
    reason,
    reasonLabel: reason ? REJECTION_REASON_LABELS[reason] ?? reason : null,
    persistenceError,
    facts: entries(payload.facts),
    hypotheses: entries(payload.hypotheses),
    openQuestions: stringList(payload.openQuestions),
    nextAction: text(payload.nextAction) ?? text(object(payload.nextAction).text),
    nextActionEvidenceRefs: references(object(payload.nextAction).evidenceIds),
    evidenceRefs: references(payload.evidenceIds ?? payload.evidenceRefs),
    prunedToolCallIds: stringList(metadata.pruneToolCallIds ?? metadata.prunedToolCallIds ?? payload.pruneToolCallIds),
    restoredToolCallIds: stringList(metadata.restoredToolCallIds ?? payload.restoredToolCallIds),
    projection,
    warnings,
  };
}

/** Projects recorded host actions; the prose remains an agent estimate, not verified evidence. */
export function buildWorkingMemoryView(events: WorkshopEvent[]): WorkingMemoryView | null {
  const records = events.filter((event) => WORKING_MEMORY_EVENTS.has(event.type)
    && event.metadata.schemaVersion === "host-working-memory.v1"
    && event.metadata.receiptAuthority === "runtime")
    .map(recordView)
    .sort((left, right) => right.seq - left.seq || right.createdAt.localeCompare(left.createdAt));
  if (!records.length) return null;
  return {
    records,
    latest: records[0],
    checkpoint: records.find((record) => (record.type === "working_memory_updated" || record.type === "working_memory_restored") && !record.persistenceError) ?? null,
    projection: records.find((record) => record.type === "working_memory_projected" && !record.persistenceError) ?? null,
  };
}
