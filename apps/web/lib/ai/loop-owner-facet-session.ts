import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@openzhiyu/ai/agent/types";
import { guardTrustedLoopRuntimeAnswer, isTrustedLoopRuntimeContext, type TrustedLoopRuntimeContext, type HostVerifiedLoopFacet } from "./loop-runtime-evidence-boundary";
import { LoopRepairReadCoverage, isPublishedRunCreatedAt } from "./loop-repair-read-coverage";
import { deliverOwnerLoopPartial, type OwnerLoopPartialDeliveryBinding } from "./loop-partial-delivery";
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const uuidInText = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi;
const object = (value: unknown): Record<string, any> | null => value && typeof value === "object"
  && !Array.isArray(value) ? value as Record<string, any> : null;
/** Select the registered read from emitted native JSON, never from host-only details.
 * Multiple declared representations must agree before the existing read guards run. */
function nativeOwnerReadPayload(payload: Record<string, any>, key: "recordRead" | "timeline") {
  const candidates: unknown[] = [];
  const data = object(payload.data);
  if (data && Object.hasOwn(data, key)) candidates.push(data[key]);
  if (Object.hasOwn(payload, key)) candidates.push(payload[key]);
  const directKeys = key === "recordRead" ? ["source", "id", "offset"] : ["loopId", "afterRunId"];
  if (directKeys.every(field => Object.hasOwn(payload, field))) candidates.push(payload);
  if (!candidates.length || candidates.some(value => !object(value))) return null;
  const selected = object(candidates[0])!;
  return candidates.every(value => isDeepStrictEqual(value, selected)) ? selected : null;
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
type QuestionScope = "runtime_only" | "goal_and_runtime" | "repair_and_runtime" | "unsupported";
/** Text subject selection cannot substitute the authenticated host subject. */
export function exactExplicitOwnerLoopQuestionId(question: string): string | null {
  const ids = [...new Set((question.match(uuidInText) ?? []).map(id => id.toLowerCase()))];
  const labeled = [...question.matchAll(/\bloop\s*(?:id)?\s*[:：#]?\s*([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/gi)];
  return ids.length === 1 && labeled.length > 0
    && labeled.every(match => match[1].toLowerCase() === ids[0]) ? ids[0] : null;
}
/** A deliberately closed vocabulary. Unknown concurrent obligations reject the narrow guard. */
export function ownerLoopCurrentRuntimeRequested(question: string): boolean {
  return /现在|当前|目前|此刻|实时|回答瞬间|正在|还在|仍在|\bnow\b|\bcurrent(?:ly)?\b/i.test(question)
    && /运行|执行|在线|存活|租约|心跳|\brunn?ing\b|\bexecutor\b|\balive\b|\bonline\b|\bleases?\b|\bheart[ -]?beats?\b|\blease(?:MatchesRun|Unexpired|Until|Phase)\b|\bheartbeat(?:At|AgeMs|Fresh)\b/iu.test(question);
}
export function ownerLoopFacetQuestionScope(question: string): QuestionScope {
  if (!ownerLoopCurrentRuntimeRequested(question)) return "unsupported";
  const normalized = question.replace(uuidInText, " ").toLowerCase();
  const common = /(?:回答瞬间|请核对|告诉我|查询|检查|请问|核对|请|这个|该|它|现在|当前|目前|此刻|实时|正在|还在|仍在|是否在|是否|有无|有没有|执行器|运行|执行|在线|存活|状态|租约|心跳|有效|近期|的|是|吗|呢|什么|和|与|及|\b(?:loop|id|please|check|tell|me|is|it|its|the|this|that|a|an|and|or|whether|still|now|current|currently|running|executor|alive|online|status|lease|leases|heartbeat|heartbeats|heart[ -]beat|matching|recent|fresh|valid|leasematchesrun|leaseunexpired|leaseuntil|leasephase|heartbeatat|heartbeatagems|heartbeatfresh|maximumheartbeatagems)\b)/giu;
  const punctuationOnly = (text: string) => /^[\s\p{P}\p{S}]*$/u.test(text);
  if (punctuationOnly(normalized.replace(common, ""))) return "runtime_only";
  if (/目标|\bgoal\b/iu.test(question)
    && punctuationOnly(normalized.replace(/目标|\bgoal\b/giu, "").replace(common, ""))) return "goal_and_runtime";
  // This scope concerns a failed baseline and later verification, not arbitrary
  // history, causal attribution, actions, goals, counts or future scheduling.
  if (/修好|修复|\bfixed\b|\brepair(?:ed)?\b/iu.test(question)) {
    const repairVocabulary = /(?:上次|后来|出现|一次|失败|完成|判断|是不是|已经|修好|修复|并|后继|复验|验证|结果|\b(?:last|previous|failed|failure|later|completed|appeared|once|compare|judge|repaired|repair|fixed|verification|result|results)\b)/giu;
    if (punctuationOnly(normalized.replace(repairVocabulary, "").replace(common, ""))) return "repair_and_runtime";
  }
  return "unsupported";
}

type ToolCall = { name: string; input: Record<string, any> };
type RecordResult = { callId: string; source: string; id: string; offset: number; expectedHash?: string;
  output: Record<string, any>; isError: boolean };
/** Only real SDK tool_use/result events from this registered owner adapter enter here. */
export class OwnerLoopFacetSession {
  private calls = new Map<string, ToolCall>();
  private results = new Set<string>();
  private invalid: string | null = null;
  private repair: LoopRepairReadCoverage | null = null;
  private timelineStarted = false;
  private timelineFinished = false;
  private timelineNextCursor: string | null = null;
  private successorIds = new Set<string>();
  private timelineOrder: { id: string; status: string; createdAt: string }[] = [];
  private bufferedRecordResults: RecordResult[] = [];
  private bufferedCharacters = 0;
  private goal = { content: "", hash: null as string | null, nextOffset: 0, total: null as number | null,
    completeValue: null as string | null, completeHash: null as string | null };
  constructor(private context: TrustedLoopRuntimeContext, readonly scope: "goal_and_runtime" | "repair_and_runtime") {}
  observe(event: AgentMessage) {
    if (event.type === "tool_use" && event.id) {
      if (this.calls.has(event.id)) { this.invalid = "duplicate_registered_call"; return; }
      const params = object(event.input);
      if (!params) return;
      if (this.context.adapter === "native_platform_recall" && event.name === "platformRecall"
        || this.context.adapter === "owner_workflow_runtime_reader"
          && ["readLoopRunTimeline", "readRunRecord"].includes(event.name ?? "")) {
        if (Object.hasOwn(params, "ownerId") && params.ownerId !== this.context.ownerId
          || Object.hasOwn(params, "userId") && params.userId !== this.context.ownerId) {
          this.invalid = "registered_owner_read_input_mismatch"; return;
        }
        this.calls.set(event.id, { name: event.name!, input: params });
      }
      return;
    }
    if (event.type !== "tool_result" || !event.toolUseId) return;
    const call = this.calls.get(event.toolUseId); if (!call) return;
    if (this.results.has(event.toolUseId)) { this.invalid = "duplicate_registered_result"; return; }
    this.results.add(event.toolUseId);
    let payload: Record<string, any> | null = null;
    try { payload = object(JSON.parse(event.output ?? "")); } catch { return; }
    if (!payload || payload.ok === false || event.isError) { this.invalid = "registered_read_unavailable"; return; }
    const timelineRequest = call.name === "platformRecall" ? object(call.input.timelineRead)
      : call.name === "readLoopRunTimeline" ? call.input : null;
    if (timelineRequest) {
      const timeline = call.name === "platformRecall" ? nativeOwnerReadPayload(payload, "timeline") : payload;
      if (!timeline || timeline.status !== "read" || timelineRequest.loopId !== this.context.loopId
        || timeline.loopId !== this.context.loopId || timeline.afterRunId !== timelineRequest.afterRunId
        || !uuid.test(timeline.afterRunId) || timeline.baseline?.id !== timeline.afterRunId
        || (timeline.cursorRunId ?? null) !== (timelineRequest.cursorRunId ?? null)) {
        this.invalid = "owner_timeline_binding_mismatch"; return;
      }
      const cursor = timelineRequest.cursorRunId ?? null;
      if (!this.timelineStarted ? cursor !== null
        : this.timelineFinished || cursor !== this.timelineNextCursor) {
        this.invalid = "owner_timeline_not_read_contiguously_from_baseline"; return;
      }
      if (typeof timeline.coverage?.hasMore !== "boolean" || !Array.isArray(timeline.runs)
        || timeline.coverage.hasMore && (!uuid.test(timeline.coverage.nextCursorRunId ?? "")
          || timeline.coverage.nextCursorRunId !== timeline.runs.at(-1)?.id)) {
        this.invalid = "owner_timeline_next_cursor_unavailable"; return;
      }
      if (timeline.ordering !== "createdAt_asc_id_asc" || !isPublishedRunCreatedAt(timeline.baseline?.createdAt)
        || typeof timeline.baseline.status !== "string") {
        this.invalid = "owner_timeline_order_unavailable"; return;
      }
      const initialAnchor = this.timelineOrder[0];
      if (this.timelineStarted && (!initialAnchor || initialAnchor.id !== timeline.baseline.id
        || initialAnchor.status !== timeline.baseline.status || initialAnchor.createdAt !== timeline.baseline.createdAt)) {
        this.invalid = "owner_timeline_baseline_changed_across_reads"; return;
      }
      const ordered = this.timelineStarted ? [...this.timelineOrder]
        : [{ id: timeline.baseline.id, status: timeline.baseline.status, createdAt: timeline.baseline.createdAt }];
      for (const run of timeline.runs) {
        const previous = ordered.at(-1)!;
        if (!uuid.test(run?.id ?? "") || run.loopId !== this.context.loopId
          || typeof run.status !== "string" || !isPublishedRunCreatedAt(run.createdAt)
          || ordered.some(row => row.id === run.id)
          || Date.parse(run.createdAt) < Date.parse(previous.createdAt)
          || Date.parse(run.createdAt) === Date.parse(previous.createdAt) && run.id <= previous.id) {
          this.invalid = "owner_timeline_order_or_identity_mismatch"; return;
        }
        ordered.push({ id: run.id, status: run.status, createdAt: run.createdAt });
      }
      this.timelineOrder = ordered;
      this.timelineStarted = true; this.timelineFinished = !timeline.coverage.hasMore;
      this.timelineNextCursor = timeline.coverage.hasMore ? timeline.coverage.nextCursorRunId : null;
      if (!this.repair) this.repair = new LoopRepairReadCoverage({ ownerId: this.context.ownerId,
        loopId: this.context.loopId, failedBaselineRunId: timeline.afterRunId,
        baselineOrigin: "owner_visible_timeline_anchor" }, { maximumAccumulatedCharacters: 64000, maximumSuccessors: 8 });
      else if (this.repair.project([], 0).subject.failedBaselineRunId !== timeline.afterRunId) {
        this.invalid = "conflicting_owner_baseline"; return;
      }
      this.repair.observeOwnerTimeline(timeline);
      for (const run of timeline.runs ?? []) if (uuid.test(run?.id)) this.successorIds.add(run.id);
      this.replayBufferedRecords(); return;
    }
    const recordRequest = call.name === "platformRecall" ? object(call.input.recordRead)
      : call.name === "readRunRecord" ? { source: "loopRuns", id: call.input.runId,
        offset: call.input.offset, expectedHash: call.input.expectedHash } : null;
    if (!recordRequest) return;
    const page = call.name === "platformRecall" ? nativeOwnerReadPayload(payload, "recordRead") : payload;
    if (!page || !uuid.test(recordRequest.id) || page.source !== recordRequest.source
      || page.id !== recordRequest.id || !Number.isSafeInteger(recordRequest.offset ?? 0)
      || page.offset !== (recordRequest.offset ?? 0)) { this.invalid = "owner_record_binding_mismatch"; return; }
    const result: RecordResult = { callId: event.toolUseId, source: recordRequest.source, id: recordRequest.id,
      offset: recordRequest.offset ?? 0, expectedHash: recordRequest.expectedHash, output: page, isError: !!event.isError };
    if (result.source === "loops" && result.id === this.context.loopId && this.scope === "goal_and_runtime") {
      this.observeGoalWindow(result); return;
    }
    if (result.source === "loopRuns" && this.scope === "repair_and_runtime") {
      const size = typeof page.content === "string" ? page.content.length : 0;
      if (this.bufferedRecordResults.length >= 20 || size > 24000 || this.bufferedCharacters + size > 64000) {
        this.invalid = "existing_result_budget_exhausted"; return;
      }
      this.bufferedCharacters += size; this.bufferedRecordResults.push(result); this.replayBufferedRecords();
    }
  }
  private replayBufferedRecords() {
    if (!this.repair) return;
    this.bufferedRecordResults = this.bufferedRecordResults.filter(result => {
      if (!this.repair!.registerReadCall({ toolCallId: result.callId, toolName: "readRunRecord", runId: result.id,
        offset: result.offset, expectedHash: result.expectedHash })) return true;
      this.repair!.observeReadResult(result.callId, result.output, result.isError); return false;
    });
  }
  private observeGoalWindow(result: RecordResult) {
    const page = result.output, goal = this.goal;
    if (page.status !== "read" || page.offset !== goal.nextOffset || typeof page.content !== "string"
      || page.content.length > 24000 || !/^[a-f0-9]{64}$/.test(page.contentHash ?? "")
      || (result.expectedHash && result.expectedHash !== page.contentHash)
      || (goal.hash && goal.hash !== page.contentHash) || !Number.isSafeInteger(page.totalCharacters)
      || page.totalCharacters < 1 || page.totalCharacters > 64000
      || (goal.total !== null && goal.total !== page.totalCharacters)) { this.invalid = "goal_window_gap_or_version_change"; return; }
    const end = page.offset + page.content.length;
    if (page.nextOffset === null ? end !== page.totalCharacters
      : page.nextOffset !== end || end >= page.totalCharacters || end <= page.offset) {
      this.invalid = "goal_window_not_contiguous"; return;
    }
    goal.hash = page.contentHash; goal.total = page.totalCharacters; goal.nextOffset = end; goal.content += page.content;
    if (page.nextOffset !== null) return;
    if (sha(goal.content) !== goal.hash) { this.invalid = "goal_complete_parent_hash_mismatch"; return; }
    let record: any; try { record = JSON.parse(goal.content); } catch { this.invalid = "goal_record_parse_failed"; return; }
    if (record?.source !== "loops" || record.id !== this.context.loopId || record.fields?.id !== this.context.loopId
      || typeof record.fields.goal !== "string" || record.fields.goal.length > 2000) {
      this.invalid = "goal_exact_loop_field_unavailable"; return;
    }
    goal.completeValue = record.fields.goal; goal.completeHash = goal.hash;
  }
  project() {
    const readCoverage = this.repair?.project([...this.successorIds], 0) ?? null;
    const records = readCoverage?.completeRunRecords ?? [];
    const statusConsistent = this.timelineFinished && this.timelineOrder.length > 0
      && this.timelineOrder.every(row => records.some(record => record.runId === row.id
        && record.status === row.status));
    const createdAtConsistent = this.timelineFinished && this.timelineOrder.length > 0
      && this.timelineOrder.every(row => records.some(record => record.runId === row.id
        && record.createdAt === row.createdAt));
    const orderConsistent = statusConsistent && createdAtConsistent;
    const latestFailed = orderConsistent ? [...this.timelineOrder].reverse().find(row => row.status === "failed") : null;
    const latestBaseline = records.find(record => record.runId === latestFailed?.id) ?? null;
    const latestIndex = this.timelineOrder.findIndex(row => row.id === latestFailed?.id);
    const selectedComparisons = latestBaseline ? this.timelineOrder.slice(latestIndex + 1).flatMap(row => {
      const successor = records.find(record => record.runId === row.id); if (!successor) return [];
      const a = latestBaseline.verification, b = successor.verification;
      const sameFailureTarget = !!a && !!b && !a.passed && a.inputVersion === b.inputVersion
        && a.target === b.target && a.expectedHash === b.expectedHash;
      return [{ runId: successor.runId, fullyRead: true, sameFailureTarget,
        successorStatus: successor.status, baselineVerification: latestBaseline.verificationObservation,
        successorVerification: successor.verificationObservation,
        repairedTargetObserved: sameFailureTarget && successor.status === "completed" && !!b?.passed
          && b.observedHash === b.expectedHash,
        baselineRecordHash: latestBaseline.contentHash, successorRecordHash: successor.contentHash }];
    }) : [];
    const repair = readCoverage ? { ...readCoverage, baselineRecord: latestBaseline,
      comparisons: selectedComparisons, originalTimelineAnchorRunId: readCoverage.subject.failedBaselineRunId,
      latestFailedBaselineRunId: latestFailed?.id ?? null, timelineOrderAndCompleteRecordStatusConsistent: statusConsistent,
      timelineOrderAndCompleteRecordCreatedAtConsistent: createdAtConsistent,
      latestFailureHasMatchingVerifiedSuccessor: selectedComparisons.some(item => item.repairedTargetObserved) } : null;
    const ready = !this.invalid && (this.scope === "goal_and_runtime" ? this.goal.completeValue !== null
      : !!repair && repair.timelineAtReadEnd && repair.coverageCompleteForCitedRuns
        && !!repair.baselineRecord && repair.baselineRecord.status === "failed"
        && repair.timelineOrderAndCompleteRecordStatusConsistent && repair.timelineOrderAndCompleteRecordCreatedAtConsistent
        && repair.latestFailureHasMatchingVerifiedSuccessor);
    return { schemaVersion: "owner-loop-host-facet-session.v3", scope: this.scope, ready,
      protectedRuntimeBoundaryEligible: ready, invalid: this.invalid, repairCoverage: repair,
      goalFieldCoverage: { complete: this.goal.completeValue !== null, parentContentHash: this.goal.completeHash },
      automaticReadsExecuted: false, sdkContextCommitObserved: false };
  }
  verifiedFacets(): HostVerifiedLoopFacet[] {
    const report = this.project(); if (!report.ready) return [];
    if (this.scope === "goal_and_runtime") return [{ facet: "configuration_postcondition",
      text: `Loop 的已记录目标字段：${JSON.stringify(this.goal.completeValue)}。这是完整 owner 记录字段，不是执行器活动观测。`,
      evidenceRefs: [`loops:${this.context.loopId}@${this.goal.completeHash}`] }];
    const coverage = report.repairCoverage!, baseline = coverage.baselineRecord!;
    const observation = baseline.verificationObservation;
    const baselineText = `失败基线 ${baseline.runId}：status=${baseline.status}；error=${baseline.errorAvailability === "not_published"
      ? "字段未发布" : JSON.stringify(baseline.error)}；验证字段=${JSON.stringify(observation)}。记录 error 不单独证明故障根因。`;
    const successors = coverage.comparisons.map(item => `后继 ${item.runId}：status=${item.successorStatus}；验证字段=${JSON.stringify(item.successorVerification)}；同失败目标复验${item.repairedTargetObserved ? "通过" : "未成立"}。`);
    const repaired = coverage.comparisons.some(item => item.repairedTargetObserved);
    const conclusion = repaired ? "同一输入版本、验证目标与预期哈希的后继复验已通过；这只支持该目标这次复验，不证明所有故障均修好。"
      : "已完整读取的后继中尚无成立的同目标修复复验证据，不能仅凭 completed 判断已修好。";
    const observationScope = "创建时间与状态来自分别读取并核对一致的 owner 记录，不是跨读取的全局快照；后续新增或回填记录可能改变最近失败。";
    return [{ facet: "repair_evidence", text: [baselineText, ...successors, conclusion, observationScope].join("\n"),
      evidenceRefs: [`loopRuns:${baseline.runId}@${baseline.contentHash}`,
        ...coverage.comparisons.map(item => `loopRuns:${item.runId}@${item.successorRecordHash}`)] }];
  }
  verifiedPartialObservations(): HostVerifiedLoopFacet[] {
    if (this.invalid) return [];
    const complete = this.verifiedFacets();
    if (complete.length) return complete;
    const records = this.repair?.project([...this.successorIds], 0).completeRunRecords ?? [];
    return records.map(record => ({ facet: "history_observation" as const,
      text: `已完整读取记录 ${record.runId}：status=${record.status}；创建时间字段=${JSON.stringify(record.createdAt)}；验证字段=${JSON.stringify(record.verificationObservation)}。单条记录不证明最近失败已修复或当前执行器活动。`,
      evidenceRefs: [`loopRuns:${record.runId}@${record.contentHash}`] }));
  }
}

/** Exact owner/current-runtime compound questions with gaps never expose a draft.
 * A host binding additionally requires actual construction and SDK context receipts. */
export async function* guardOwnerLoopFacetAnswer(source: AsyncGenerator<AgentMessage>, question: string,
  context: TrustedLoopRuntimeContext | undefined, deliveryBinding?: OwnerLoopPartialDeliveryBinding): AsyncGenerator<AgentMessage> {
  const explicitSubject = exactExplicitOwnerLoopQuestionId(question);
  if (!isTrustedLoopRuntimeContext(context) || !explicitSubject || explicitSubject !== context.loopId.toLowerCase()) {
    yield { type: "answer_evidence", answerEvidence: { schemaVersion: "owner-loop-facet-scope.v3",
      scope: "unsupported", protectedByNewRuntimeBoundary: false, outputPolicy: "baseline_stream_preserved",
      fullOriginalQuestionVerified: false, reason: !isTrustedLoopRuntimeContext(context)
        ? "missing_or_invalid_authenticated_host" : "question_requires_one_explicit_matching_loop_subject" } };
    yield* source; return;
  }
  const scope = ownerLoopFacetQuestionScope(question);
  if (scope === "runtime_only") { yield* guardTrustedLoopRuntimeAnswer(source, context, { questionScope: "runtime_only" }); return; }
  const currentRuntimeRequested = ownerLoopCurrentRuntimeRequested(question);
  if (scope === "unsupported" && !currentRuntimeRequested) {
    yield { type: "answer_evidence", answerEvidence: { schemaVersion: "owner-loop-facet-scope.v2",
      scope, protectedByNewRuntimeBoundary: false, outputPolicy: "baseline_stream_preserved",
      fullOriginalQuestionVerified: false, reason: "concurrent_or_unknown_obligations_outside_narrow_contract" } };
    yield* source; return;
  }
  const knownScopes = scope === "unsupported"
    ? [(/目标|\bgoal\b/iu.test(question) ? "goal_and_runtime" : null),
      (/失败|修好|修复|\bfailure\b|\bfailed\b|\brepair(?:ed)?\b|\bfixed\b/iu.test(question) ? "repair_and_runtime" : null)]
      .filter((value): value is "goal_and_runtime" | "repair_and_runtime" => value !== null)
    : [scope];
  const sessions = knownScopes.map(selected => new OwnerLoopFacetSession(context, selected));
  const session = sessions[0], events: AgentMessage[] = [];
  let rawDraft = "";
  let draftCharacters = 0, overflow = false, failed = false, streamedText = false;
  try { for await (const event of source) {
    // This is the actual incoming stream, not the later domain projection replay.
    await deliveryBinding?.core.observeToolResult(event);
    for (const selected of sessions) selected.observe(event);
    if (["text", "result", "direct_answer"].includes(event.type)) {
      if (event.type === "text") streamedText = true;
      if (event.type !== "result" || !streamedText && event.content !== "success") draftCharacters += event.content?.length ?? 0;
      if (draftCharacters <= 64000 && (event.type !== "result" || !streamedText && event.content !== "success")) rawDraft += event.content ?? "";
      if (draftCharacters > 64000) overflow = true;
    }
    if (event.type === "error" || event.type === "runtime_terminal" && (event.runtimeTerminal?.status !== "completed"
      || event.runtimeTerminal?.cleanupStatus !== "completed")) failed = true;
    if (!overflow) events.push(event);
    if (!["text", "result", "direct_answer", "done"].includes(event.type)) yield event;
  } } catch {
    failed = true;
    const error: AgentMessage = { type: "error", content: "Loop 观测流异常结束；未确认运行终止及清理回执。" };
    events.push(error); yield error;
  }
  const report = session?.project();
  if ((failed || overflow) && !deliveryBinding) {
    yield { type: "answer_evidence", answerEvidence: { schemaVersion: "owner-loop-facet-scope.v2", scope,
      protectedByNewRuntimeBoundary: false, outputPolicy: "failed_delivery_no_buffered_success",
      reason: overflow ? "original_answer_buffer_limit" : "runtime_failed_or_cleanup_unconfirmed",
      fullOriginalQuestionVerified: false } };
    const done = [...events].reverse().find(event => event.type === "done"); if (done) yield done; return;
  }
  if (deliveryBinding || scope === "unsupported" || !report?.ready) {
    yield* deliverOwnerLoopPartial({ context, originalQuestion: question, events,
      independentFacts: sessions.flatMap(selected => selected.verifiedPartialObservations()),
      gaps: [scope === "unsupported" ? "unknown_independent_question_obligations"
        : !report?.ready ? "selected_independent_coverage_incomplete" : "bounded_runtime_observation_not_full_question_completion"],
      rawDraft, rawDraftCharacters: draftCharacters, overflow, binding: deliveryBinding, hostCoverage: report });
    return;
  }
  async function* replay() { yield* events; }
  for await (const event of guardTrustedLoopRuntimeAnswer(replay(), context, {
    questionScope: "fully_covered_host_facets", independentFacets: () => session.verifiedFacets(),
    requestedIndependentFacets: scope === "repair_and_runtime" ? ["repair_evidence"] : ["configuration_postcondition"],
  })) {
    if (["text", "result", "done"].includes(event.type) || event.type === "answer_evidence"
      && event.answerEvidence?.schemaVersion === "loop-runtime-facet-delivery.v1") yield event;
  }
}
