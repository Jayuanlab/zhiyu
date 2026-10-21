import { createHash } from "node:crypto";
import { canonicalCommandJson } from "@/lib/work-runtime/command-payload";
import type { WorkshopEvent } from "./run-history-types";

export const WORKING_MEMORY_PROMOTION_SOURCE = "working-memory-promotion.v1";
export const WORKING_MEMORY_PROMOTION_EVENT_LIMIT = 2000;
export type WorkingMemoryPromotionRunIdentity = { runKind: "workshop"; runId: string } | { runKind: "loop"; loopId: string; runId: string };
export type WorkingMemoryPromotionCommand = WorkingMemoryPromotionRunIdentity & { noteKey: string; expectedVersion: number; commandId: string };
export class WorkingMemoryPromotionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}

function fail(code: string, message: string, status = 409): never { throw new WorkingMemoryPromotionError(code, message, status); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function integer(value: unknown, min = 0): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= min; }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const key = /^[A-Za-z0-9][A-Za-z0-9._:/|+-]{0,127}$/;
const hash = /^[a-f0-9]{64}$/i;
const strings = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && !!item.trim()))] : [];
function digest(value: unknown) { return createHash("sha256").update(canonicalCommandJson(value)).digest("hex"); }
function stableId(value: unknown) {
  const h = digest(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function parseWorkingMemoryPromotionCommand(value: unknown): WorkingMemoryPromotionCommand {
  const command = object(value);
  const fields = command.runKind === "loop" ? ["runKind", "loopId", "runId", "noteKey", "expectedVersion", "commandId"] : ["runKind", "runId", "noteKey", "expectedVersion", "commandId"];
  if (!["workshop", "loop"].includes(String(command.runKind)) || Object.keys(command).length !== fields.length || Object.keys(command).some(name => !fields.includes(name)) ||
    command.runKind === "loop" && (typeof command.loopId !== "string" || !uuid.test(command.loopId)) ||
    typeof command.runId !== "string" || !uuid.test(command.runId) || typeof command.noteKey !== "string" || !key.test(command.noteKey) ||
    !integer(command.expectedVersion, 1) || typeof command.commandId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/|+-]{0,199}$/.test(command.commandId))
    fail("invalid_promotion_command", "请选择当前运行类型、笔记和版本；Loop 还须提供对应的持续任务编号。", 400);
  const common = { runId: command.runId.toLowerCase(), noteKey: command.noteKey, expectedVersion: command.expectedVersion, commandId: command.commandId };
  return command.runKind === "loop" ? { ...common, runKind: "loop", loopId: String(command.loopId).toLowerCase() } : { ...common, runKind: "workshop" };
}

function inRun(event: WorkshopEvent, workshopId: string, command: WorkingMemoryPromotionRunIdentity) {
  if (event.workshopId !== workshopId) return false;
  return command.runKind === "loop"
    ? event.loopRunId === command.runId && event.loopId === command.loopId
    : event.runId === command.runId && !event.loopRunId && !event.loopId;
}
function hostMemory(event: WorkshopEvent) {
  return event.metadata.schemaVersion === "host-working-memory.v1" && event.metadata.receiptAuthority === "runtime";
}
function persisted(event: WorkshopEvent) { return !event.metadata.persistenceError && !event.metadata.persistence_error; }
function policyIdentity(event: WorkshopEvent) {
  const policy = object(event.metadata.policyIdentity);
  if (!text(policy.version) || typeof policy.hash !== "string" || !hash.test(policy.hash))
    fail("unknown_memory_policy", "这条运行没有完整的记忆策略身份，不能送交长期记忆审核。");
  return { version: String(policy.version), hash: policy.hash.toLowerCase() };
}
function sourceCurrent(metadata: Record<string, unknown>, now: Date) {
  if (metadata.__truncated === true || metadata.revoked === true || metadata.deleted === true || metadata.stale === true || metadata.superseded === true ||
    metadata.revokedAt || metadata.deletedAt || metadata.supersededBy || /^(revoked|deleted|expired|stale|superseded|unavailable|failed|denied|unknown)$/i.test(String(metadata.status ?? ""))) return false;
  if (metadata.expiresAt !== undefined && metadata.expiresAt !== null) {
    const expiry = typeof metadata.expiresAt === "string" ? Date.parse(metadata.expiresAt) : Number.NaN;
    if (!Number.isFinite(expiry) || expiry <= now.getTime()) return false;
  }
  return true;
}

/** No retrieval fallback: only persisted run notes and exact host source windows enter review. */
export function resolveWorkingMemoryPromotion(input: {
  userId: string; workshopId: string; command: WorkingMemoryPromotionCommand; events: WorkshopEvent[]; now?: Date;
}) {
  const command = parseWorkingMemoryPromotionCommand(input.command);
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) fail("invalid_promotion_time", "提交时间无法核对。", 400);
  if (input.events.length > WORKING_MEMORY_PROMOTION_EVENT_LIMIT) fail("promotion_history_limit", "运行记录超过本次可核对范围；请先读取完整来源记录。");
  const events = input.events.filter(event => inRun(event, input.workshopId, command)).sort((left, right) => left.seq - right.seq);
  const mutations = events.filter(event => hostMemory(event) && persisted(event) && ["working_memory_updated", "working_memory_restored"].includes(event.type));
  const checkpoint = mutations.at(-1);
  if (!checkpoint || checkpoint.type !== "working_memory_updated" || checkpoint.metadata.mode !== "apply" || checkpoint.metadata.status !== "ready_for_projection")
    fail("no_current_working_note", "本轮没有已保存且可送审的启用记忆；恢复状态或试运行候选不能晋升。");
  if (checkpoint.metadata.__truncated === true) fail("truncated_working_note", "当前记忆记录已截断，不能确认笔记及来源完整。");
  if (checkpoint.metadata.version !== command.expectedVersion) fail("working_memory_version_conflict", "工作记忆版本已变化，请刷新运行记录再选择笔记。");
  const state = object(checkpoint.metadata.state);
  const notes = [
    ...(Array.isArray(state.facts) ? state.facts.map(value => ({ value: object(value), category: "fact" as const })) : []),
    ...(Array.isArray(state.hypotheses) ? state.hypotheses.map(value => ({ value: object(value), category: "hypothesis" as const })) : []),
  ].filter(note => note.value.key === command.noteKey);
  if (notes.length !== 1 || !text(notes[0].value.text) || String(notes[0].value.text).length > 2000) fail("unknown_working_note", "该笔记键缺失或不唯一；不能用自报正文替代已保存笔记。");
  const note = notes[0], evidenceIds = strings(note.value.evidenceIds);
  if (!evidenceIds.length || evidenceIds.length > 64 || !Array.isArray(note.value.evidenceIds) || note.value.evidenceIds.length !== evidenceIds.length)
    fail("durable_source_required", "这条笔记没有完整、唯一的精确来源，不能送交长期记忆审核。");
  const policy = policyIdentity(checkpoint);
  const projection = events.filter(event => hostMemory(event) && persisted(event) && event.type === "working_memory_projected" && event.metadata.__truncated !== true &&
    event.metadata.status === "provider_request_prepared" && event.metadata.mode === "apply" && event.metadata.version === command.expectedVersion && event.seq > checkpoint.seq).at(-1);
  if (!projection) fail("working_note_not_consumed", "当前笔记尚无同版本的模型请求准备回执，暂不能送审；准备回执只证明请求已组装，不证明模型已接收或理解。");
  if (digest(policyIdentity(projection)) !== digest(policy)) fail("memory_policy_conflict", "笔记与后续模型请求的记忆策略身份不一致。");
  const catalog = Array.isArray(checkpoint.metadata.evidenceCatalog) ? checkpoint.metadata.evidenceCatalog.map(object) : [];
  const preparedCatalog = Array.isArray(projection.metadata.evidenceCatalog) ? projection.metadata.evidenceCatalog.map(object) : [];
  const sources = evidenceIds.map(toolCallId => {
    const entries = catalog.filter(entry => entry.toolCallId === toolCallId), prepared = preparedCatalog.filter(entry => entry.toolCallId === toolCallId);
    if (entries.length !== 1 || prepared.length !== 1 || entries[0].referenceEligible !== true || prepared[0].referenceEligible !== true)
      fail("durable_source_required", "笔记引用不在同版本可引用来源目录中；本地读取或最近事件不能替代精确来源。");
    const entry = entries[0], identity = object(entry.sourceIdentity), preparedIdentity = object(prepared[0].sourceIdentity);
    if (entry.sourceIdentityStatus !== "reported" || prepared[0].sourceIdentityStatus !== "reported" || digest(identity) !== digest(preparedIdentity) ||
      typeof entry.contentHash !== "string" || !hash.test(entry.contentHash) || entry.contentHash !== prepared[0].contentHash)
      fail("source_identity_conflict", "保存笔记与模型请求的来源身份缺失或冲突。");
    const sourceEventId = text(identity.sourceEventId) ?? text(identity.evidenceEventId);
    if (!sourceEventId || !uuid.test(sourceEventId) || identity.sourceEventId && identity.evidenceEventId && identity.sourceEventId !== identity.evidenceEventId)
      fail("durable_source_required", "该工具读取没有精确的持久来源事件，不能晋升为长期候选。");
    const matches = input.events.filter(event => event.id === sourceEventId);
    const source = matches.length === 1 ? matches[0] : undefined;
    if (!source || !inRun(source, input.workshopId, command) || source.seq >= checkpoint.seq)
      fail("source_scope_mismatch", "来源事件不存在、跨车间、跨运行或晚于笔记，不能送审。");
    const metadata = object(source.metadata);
    if (source.type !== "source_checked" || metadata.receiptAuthority !== "runtime" || metadata.ok !== true || metadata.toolName !== "webReadPage" || entry.toolName !== metadata.toolName ||
      (metadata.toolUseId ?? metadata.toolCallId) !== toolCallId)
      fail("source_not_bound", "来源事件尚未与这次获准工具调用绑定；旧记录不能通过猜测映射晋升。");
    if (!sourceCurrent(metadata, now)) fail("source_not_current", "来源已过期、撤销、变化或不完整，不能送交长期记忆审核。");
    if (typeof identity.contentHash !== "string" || !hash.test(identity.contentHash) || typeof metadata.contentHash !== "string" || identity.contentHash.toLowerCase() !== metadata.contentHash.toLowerCase() ||
      !text(identity.evidenceId) || identity.evidenceId !== metadata.evidenceId || !integer(identity.offset) || !integer(identity.contentLength, 1) || !integer(identity.totalChars, 1) ||
      identity.offset !== metadata.offset || identity.contentLength !== metadata.contentLength || identity.totalChars !== metadata.totalChars ||
      !Number.isSafeInteger(identity.offset + identity.contentLength) || identity.offset + identity.contentLength > identity.totalChars)
      fail("source_window_conflict", "原文快照 hash 或已读片段范围不一致，不能使用相邻窗口或最新网页替代。");
    if (identity.sourceVersion !== undefined || metadata.sourceVersion !== undefined) {
      if (identity.sourceVersion !== metadata.sourceVersion) fail("source_version_conflict", "来源版本与原事件不一致。");
    }
    if (events.some(event => event.seq > source.seq && event.metadata.receiptAuthority === "runtime" &&
      (event.metadata.sourceEventId === source.id || event.metadata.evidenceId === metadata.evidenceId) &&
      (!sourceCurrent(event.metadata, now) || typeof event.metadata.contentHash === "string" && event.metadata.contentHash.toLowerCase() !== metadata.contentHash?.toString().toLowerCase() ||
        event.metadata.sourceVersion !== undefined && event.metadata.sourceVersion !== metadata.sourceVersion)))
      fail("source_not_current", "后续原始事件已使该来源失效或变更；请重新读取后整理。");
    const caution = object(entry.sourceCautions);
    return { toolCallId, sourceEventId: source.id, evidenceId: String(metadata.evidenceId), contentHash: String(metadata.contentHash).toLowerCase(),
      sourceVersion: metadata.sourceVersion ?? `sha256:${String(metadata.contentHash).toLowerCase()}`, sourceVersionKind: metadata.sourceVersion === undefined ? "content_hash" : "reported",
      span: { offset: identity.offset, contentLength: identity.contentLength, totalChars: identity.totalChars },
      provider: text(metadata.provider), detail: text(metadata.detail),
      warningCodes: [...new Set([...strings(metadata.warnings), ...strings(caution.warningCodes)])],
      warningTexts: [...new Set([...strings(metadata.warning ? [metadata.warning] : []), ...strings(caution.warningTexts)])],
      finalUrlVerified: metadata.finalUrlVerified === true,
    };
  }).sort((left, right) => left.toolCallId < right.toolCallId ? -1 : left.toolCallId > right.toolCallId ? 1 : 0);
  const identity = command.runKind === "loop" ? { runKind: command.runKind, loopId: command.loopId, runId: command.runId } : { runKind: command.runKind, runId: command.runId };
  const requestHash = digest([identity, command.noteKey, command.expectedVersion]);
  const previous = events.filter(event => event.type === "working_memory_promoted" && event.metadata.receiptAuthority === "runtime" && event.metadata.commandId === command.commandId).at(-1);
  if (previous && previous.metadata.requestHash !== requestHash) fail("promotion_command_conflict", "同一提交指令已用于不同笔记或版本。", 409);
  const candidateId = stableId([WORKING_MEMORY_PROMOTION_SOURCE, input.userId, input.workshopId, identity, command.noteKey, note.category, note.value.text, sources]);
  return { candidateId, requestHash, command, checkpointEventId: checkpoint.id, projectionEventId: projection.id,
    runIdentity: identity, loopId: command.runKind === "loop" ? command.loopId : null,
    loopRunId: command.runKind === "loop" ? command.runId : null, runId: checkpoint.runId, category: note.category, content: String(note.value.text),
    evidenceRefs: [...new Set(sources.map(source => source.sourceEventId))], policyIdentity: policy, sources,
    replayEvent: previous ?? null,
  };
}
