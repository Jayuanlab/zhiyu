import type { WorkshopEvent } from "./run-history-types";

const WORKING_MEMORY_EVENTS = new Set([
  "working_memory_updated",
  "working_memory_rejected",
  "working_memory_restored",
  "working_memory_projected",
  "working_memory_usage",
  "working_memory_continuity_loaded",
]);

export type WorkingMemoryEntryView = {
  key: string | null;
  text: string;
  evidenceRefs: string[];
};

export type WorkingMemorySourceView = {
  toolCallId: string;
  toolName: string | null;
  provider: string | null;
  detail: string | null;
  contentHash: string | null;
  sourceIdentity: { label: string; value: string }[];
  sourceIdentityStatus: string | null;
  durableEventId: string | null;
  referenceEligible: boolean | null;
  projectionEligible: boolean | null;
  blockedReasons: string[];
  warningCodes: string[];
  warningTexts: string[];
};

export type WorkingMemoryCatalogView = {
  evidenceCount: number | null;
  referenceEligibleCount: number | null;
  projectionCandidateCount: number | null;
  blockedCount: number | null;
  blockedReasons: { code: string; label: string; count: number }[];
  truncated: boolean;
  sources: WorkingMemorySourceView[];
};

export type WorkingMemoryRecordView = {
  id: string;
  runId: string | null;
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
  phase: string | null;
  readCount: number | null;
  logCount: number | null;
  planCount: number | null;
  policy: { version: string | null; hash: string | null } | null;
  catalog: WorkingMemoryCatalogView | null;
  usage: {
    invocation: number | null;
    model: string | null;
    provider: string | null;
    status: string | null;
    elapsedMs: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    totalTokens: number | null;
  } | null;
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
  continuity?: {
    status: string; reason: string; sourceRunId: string | null; checkpointEventId: string | null;
    sourceLoopId: string | null; expiresAt: string | null; warnings: string[];
    openQuestionsCount: number; historicalNoteCount: number; suppressedHistoricalClaims: boolean;
  } | null;
  records: WorkingMemoryRecordView[];
  latest: WorkingMemoryRecordView;
  checkpoint: WorkingMemoryRecordView | null;
  projection: WorkingMemoryRecordView | null;
  catalog: WorkingMemoryRecordView | null;
  protocol: WorkingMemoryRecordView | null;
  counts: { updated: number; projected: number; reduced: number; restored: number; rejected: number };
  usage: {
    records: number;
    inputTokens: { known: number | null; missing: number };
    outputTokens: { known: number | null; missing: number };
    cacheReadTokens: { known: number | null; missing: number };
    cacheWriteTokens: { known: number | null; missing: number };
    totalTokens: { known: number | null; missing: number };
  };
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
    if (plain) return [{ key: null, text: plain, evidenceRefs: [] }];
    const item = object(entry);
    const content = text(item.text) ?? text(item.content) ?? text(item.summary);
    return content ? [{ key: text(item.key), text: content, evidenceRefs: references(item.evidenceIds ?? item.evidenceRefs) }] : [];
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
  read_limit: "本轮记忆读取预算已用完，仍可恢复原正文",
  duplicate_note_key: "同一个笔记键对应了不同内容，需明确修订对象",
  note_category_conflict: "笔记键不能在事实、假设和下一步之间改变类别",
  edit_limit: "本轮更新次数已达上限，仍可读取或恢复",
  summary_limit: "保留摘要超过本轮长度上限",
  unknown_evidence: "摘要引用了未知、不可引用或超出当前目录的工具回执",
  unsafe_prune: "选择的回执不存在、受到保护或不属于当前获准投影的读取来源",
  already_pruned: "选择的工具回执已经在移出集合中",
  incomplete_group: "同组读取回执需要完整保留或一起移出",
  unreferenced_prune: "移出的工具回执未在保留摘要中引用",
  audit_failed: "整理审计回执保存失败，保留上次状态",
};

const PROJECTION_BLOCK_REASON_LABELS: Record<string, string> = {
  unrecognized_warning: "来源警告结构无法核对，正文保留",
  warning_metadata_limit: "来源警告超过记录上限，正文保留",
  fallback_warning: "来源包含后备数据源警告，正文保留",
  source_warning: "来源包含须继续保留的警告，正文保留",
  inspection_depth_limit: "来源结构超过核验深度，正文保留",
  approval_or_denial: "回执涉及审核或权限拒绝，不可引用，正文保留",
  failed_result: "读取失败，不可引用，正文保留",
  control_or_error_result: "回执涉及控制结果或错误，不可引用，正文保留",
  redirect_unverified: "最终来源地址尚未核验，正文保留",
  degraded_source: "来源降级或只覆盖部分数据，正文保留",
  control_result: "回执改变工具控制状态，不可引用，正文保留",
  non_text_result: "回执包含非文字内容，正文保留",
  incomplete_pair: "调用与回执无法唯一完整配对，不可引用，正文保留",
  invalid_assistant_result: "助手调用结果异常，不可引用，正文保留",
  denied_tool: "读取工具被边界禁止，正文保留",
  source_identity_conflict: "来源身份字段相互冲突，正文保留",
};

const SOURCE_IDENTITY_LABELS: Record<string, string> = {
  observedAt: "观测时间", evidenceId: "证据编号", sourceEventId: "原始事件", evidenceEventId: "证据事件", contentHash: "来源内容 hash", rawHash: "原始内容 hash",
  url: "请求地址", source: "来源", finalUrl: "最终地址", finalUrlVerified: "最终地址已核验",
  retrievedAt: "检索时间", fetchedAt: "获取时间", offset: "片段起点", nextOffset: "下一片段起点", truncated: "片段已截断", contentLength: "当前片段长度", totalChars: "原文字符数", sourceVersion: "来源版本",
};

function catalogView(metadata: Record<string, unknown>): WorkingMemoryCatalogView | null {
  const summary = object(metadata.catalogSummary);
  const hasCatalog = Object.keys(summary).length > 0 || Array.isArray(metadata.evidenceCatalog);
  if (!hasCatalog) return null;
  const reasons = Array.isArray(summary.blockedReasons) ? summary.blockedReasons.flatMap((entry) => {
    const reason = object(entry);
    const code = text(reason.code);
    const count = nonnegativeInteger(reason.count);
    return code && count !== null ? [{ code, count, label: PROJECTION_BLOCK_REASON_LABELS[code] ?? code }] : [];
  }) : [];
  const sources = Array.isArray(metadata.evidenceCatalog) ? metadata.evidenceCatalog.flatMap((entry) => {
    const source = object(entry);
    const toolCallId = text(source.toolCallId);
    if (!toolCallId) return [];
    const caution = object(source.sourceCautions);
    const retained = object(source.retainedCautions);
    const identity = object(source.sourceIdentity);
    return [{
      toolCallId,
      toolName: text(source.toolName),
      provider: text(source.provider),
      detail: text(source.detail),
      contentHash: text(source.contentHash),
      sourceIdentity: Object.entries(object(source.sourceIdentity)).flatMap(([key, value]) =>
        typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)
          ? [{ label: SOURCE_IDENTITY_LABELS[key] ?? key, value: typeof value === "boolean" ? value ? "是" : "否" : String(value) }] : []),
      sourceIdentityStatus: text(source.sourceIdentityStatus),
      durableEventId: text(identity.sourceEventId) ?? text(identity.evidenceEventId),
      referenceEligible: typeof source.referenceEligible === "boolean" ? source.referenceEligible : null,
      projectionEligible: typeof source.projectionEligible === "boolean" ? source.projectionEligible : null,
      blockedReasons: stringList(source.projectionBlockedReasons),
      warningCodes: [...new Set([...stringList(caution.warningCodes), ...stringList(retained.warningCodes)])],
      warningTexts: [...new Set([...stringList(caution.warningTexts), ...stringList(retained.warningTexts)])],
    }];
  }) : [];
  return {
    evidenceCount: nonnegativeInteger(summary.evidenceCount),
    referenceEligibleCount: nonnegativeInteger(summary.referenceEligibleCount),
    projectionCandidateCount: nonnegativeInteger(summary.projectionCandidateCount),
    blockedCount: nonnegativeInteger(summary.blockedCount),
    blockedReasons: reasons,
    truncated: summary.truncated === true,
    sources,
  };
}

function policyView(metadata: Record<string, unknown>): WorkingMemoryRecordView["policy"] {
  const policy = object(metadata.policyIdentity);
  const policyVersion = version(policy.version);
  const hash = text(policy.hash);
  return policyVersion || hash ? { version: policyVersion, hash } : null;
}

function usageView(event: WorkshopEvent): WorkingMemoryRecordView["usage"] {
  const metadata = object(event.metadata);
  if (event.type !== "working_memory_usage" || metadata.status !== "provider_result_received") return null;
  return {
    invocation: nonnegativeInteger(metadata.invocation),
    model: text(metadata.model),
    provider: text(metadata.provider),
    status: text(metadata.usageStatus),
    elapsedMs: nonnegativeInteger(metadata.elapsedMs),
    inputTokens: nonnegativeInteger(metadata.inputTokens),
    outputTokens: nonnegativeInteger(metadata.outputTokens),
    cacheReadTokens: nonnegativeInteger(metadata.cacheReadTokens),
    cacheWriteTokens: nonnegativeInteger(metadata.cacheWriteTokens),
    totalTokens: nonnegativeInteger(metadata.totalTokens),
  };
}

function usageTotal(records: WorkingMemoryRecordView[], field: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "totalTokens") {
  const values = records.flatMap(record => record.usage?.[field] !== null && record.usage?.[field] !== undefined
    ? [record.usage[field]] : []);
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    known: values.length && Number.isSafeInteger(sum) ? sum : null,
    missing: records.length - values.length,
  };
}

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
  const continuity = event.type === "working_memory_continuity_loaded";
  const hostReportCommit = event.type === "working_memory_updated" && mode === "apply"
    && metadata.operation === "update" && metadata.phase === "LOG" && metadata.status === "ready_for_projection"
    && metadata.commitOrigin === "validated_report_checkpoint" && !persistenceError && metadata.__truncated !== true;
  const usage = usageView(event);
  const reason = text(metadata.reason) ?? text(metadata.code) ?? text(payload.reason);
  const originalChars = nonnegativeInteger(metadata.originalChars);
  const projectedChars = nonnegativeInteger(metadata.projectedChars);
  const projection = projected && originalChars !== null && projectedChars !== null ? {
    originalChars,
    projectedChars,
    originalMessageCount: nonnegativeInteger(metadata.originalMessageCount),
    projectedMessageCount: nonnegativeInteger(metadata.projectedMessageCount),
  } : null;
  const catalog = catalogView(metadata);
  const warnings: string[] = [];
  if (metadata.__truncated === true) warnings.push("这条整理记录已截断，保留内容和来源可能不完整。请重新读取完整运行记录。");
  if (persistenceError) warnings.push("整理状态未可靠保存，请结合原始运行记录核对；不能据此确认本轮整理生效。");
  if (projected && !projection) warnings.push("请求准备记录未包含有效字符计数，无法判断上下文变化量。");
  if (event.type === "working_memory_usage" && !usage) warnings.push("用量回执状态无法核对，不能据此确认 token 用量。");
  if (!rejected && !continuity && mode !== "apply" && mode !== "shadow") warnings.push("未记录可识别的整理模式，不能据此确认上下文是否发生改变。");
  return {
    id: event.id,
    runId: event.runId ?? event.loopRunId ?? null,
    type: event.type,
    seq: event.seq,
    createdAt: event.createdAt,
    mode,
    modeLabel: hostReportCommit ? "宿主提交报告待办（非模型工具调用）" : continuity ? "历史工作状态" : modeLabel(mode),
    version: version(metadata.version ?? payload.version),
    previousVersion: version(metadata.previousVersion),
    statusLabel: continuity ? metadata.status === 'inherited' ? "历史状态已准备，待本轮模型调用" : "历史状态未接续" :
      rejected ? "整理未应用" : persistenceError ? "保存结果异常" :
      event.type === "working_memory_usage" ? "模型调用用量回执已记录" :
      projected ? (mode === "shadow" ? "试运行请求已准备（未裁剪）" : "模型请求上下文已准备") :
      restored ? "恢复状态已保存" : mode === "shadow" ? "候选已记录" :
      mode === "apply" ? hostReportCommit ? "宿主已保存报告待办，供后续运行接续" : "整理已保存，待模型调用采用" : "整理动作已记录",
    commandId: text(metadata.commandId) ?? text(payload.commandId),
    reason,
    reasonLabel: reason ? REJECTION_REASON_LABELS[reason] ?? reason : null,
    persistenceError,
    phase: text(metadata.phase),
    readCount: nonnegativeInteger(metadata.readCount),
    logCount: nonnegativeInteger(metadata.logCount),
    planCount: nonnegativeInteger(metadata.planCount),
    policy: policyView(metadata),
    catalog,
    usage,
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
    && (event.metadata.schemaVersion === "host-working-memory.v1" || event.type === 'working_memory_continuity_loaded'
      && event.metadata.schemaVersion === 'working-memory-continuity.v1')
    && event.metadata.receiptAuthority === "runtime")
    .map(recordView)
    .sort((left, right) => right.seq - left.seq || right.createdAt.localeCompare(left.createdAt));
  if (!records.length) return null;
  const usages = records.filter(record => record.usage && !record.persistenceError);
  const continuityRecord = records.find(record => record.type === 'working_memory_continuity_loaded' && !record.persistenceError);
  const continuityMetadata = object(events.find(event => event.id === continuityRecord?.id)?.metadata);
  const historicalCheckpoint = object(continuityMetadata.checkpoint);
  const historicalState = object(historicalCheckpoint.history);
  const continuity = continuityRecord ? {
    status: text(continuityMetadata.status) ?? 'unknown', reason: text(continuityMetadata.reason) ?? 'unknown',
    sourceRunId: text(historicalCheckpoint.sourceRunId), checkpointEventId: text(historicalCheckpoint.checkpointEventId),
    sourceLoopId: text(historicalCheckpoint.loopId), expiresAt: text(historicalCheckpoint.expiresAt),
    warnings: stringList(continuityMetadata.warnings), openQuestionsCount: stringList(historicalState.openQuestions).length,
    historicalNoteCount: (Array.isArray(historicalState.facts) ? historicalState.facts.length : 0)
      + (Array.isArray(historicalState.hypotheses) ? historicalState.hypotheses.length : 0),
    suppressedHistoricalClaims: object(historicalCheckpoint.chain).assertionsSuppressed === true
      || continuityMetadata.reason === 'inherited_with_corrections',
  } : null;
  return {
    continuity,
    records,
    latest: records[0],
    checkpoint: records.find((record) => (record.type === "working_memory_updated" || record.type === "working_memory_restored") && !record.persistenceError) ?? null,
    projection: records.find((record) => record.type === "working_memory_projected" && !record.persistenceError) ?? null,
    catalog: records.find((record) => record.catalog && !record.persistenceError) ?? null,
    protocol: records.find((record) => (record.phase || record.readCount !== null || record.logCount !== null || record.planCount !== null) && !record.persistenceError) ?? null,
    counts: {
      updated: records.filter((record) => record.type === "working_memory_updated" && !record.persistenceError).length,
      projected: records.filter((record) => record.type === "working_memory_projected" && !record.persistenceError).length,
      reduced: records.filter((record) => record.type === "working_memory_projected" && !record.persistenceError
        && record.mode === "apply" && record.projection && record.projection.projectedChars < record.projection.originalChars).length,
      restored: records.filter((record) => record.type === "working_memory_restored" && !record.persistenceError).length,
      rejected: records.filter((record) => record.type === "working_memory_rejected").length,
    },
    usage: {
      records: usages.length,
      inputTokens: usageTotal(usages, "inputTokens"),
      outputTokens: usageTotal(usages, "outputTokens"),
      cacheReadTokens: usageTotal(usages, "cacheReadTokens"),
      cacheWriteTokens: usageTotal(usages, "cacheWriteTokens"),
      totalTokens: usageTotal(usages, "totalTokens"),
    },
  };
}
