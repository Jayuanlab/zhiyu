import type { AgentMessage } from "@openzhiyu/ai/agent/types";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const object = (value: unknown): Record<string, any> | null => value !== null
  && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
const time = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));

/** Supplied by an authenticated host/registered adapter, never model parameters. */
export type TrustedLoopRuntimeContext = {
  ownerId: string; loopId: string;
  adapter: "native_platform_recall" | "owner_workflow_runtime_reader";
  toolName: "platformRecall" | "readLoopRuntimeObservation";
};
export type LoopRuntimeObservationFacet = {
  schemaVersion: "loop-runtime-observation-facet.v1";
  subject: { ownerId: string; loopId: string };
  state: "observed" | "unknown";
  reason: string | null; toolCallId: string | null; observedAt: string | null;
  provider: "workshop_execution_leases";
  mapping: "linked" | "no_active_linked_mapping_observed" | "unknown";
  lease: { evaluated: boolean; matchesRun: boolean | null; unexpired: boolean | null };
  heartbeat: { evaluated: boolean; fresh: boolean | null; ageMs: number | null };
  observedActivity: "matching_lease_recent_heartbeat" | "not_currently_verified" | "unknown";
  currentProcessActivity: "unknown";
  configuration: { status: string; updatedAt: string | null } | null;
};
export function isTrustedLoopRuntimeContext(value: unknown): value is TrustedLoopRuntimeContext {
  const context = object(value);
  return !!context && typeof context.ownerId === "string" && typeof context.loopId === "string"
    && uuid.test(context.ownerId) && uuid.test(context.loopId)
    && ((context.adapter === "native_platform_recall" && context.toolName === "platformRecall")
      || (context.adapter === "owner_workflow_runtime_reader" && context.toolName === "readLoopRuntimeObservation"));
}
const contextValid = isTrustedLoopRuntimeContext;
export function unknownLoopRuntimeFacet(context: TrustedLoopRuntimeContext, reason: string,
  toolCallId: string | null = null): LoopRuntimeObservationFacet {
  if (!contextValid(context)) throw Error("invalid_trusted_loop_runtime_context");
  return { schemaVersion: "loop-runtime-observation-facet.v1", subject: {
    ownerId: context.ownerId.toLowerCase(), loopId: context.loopId.toLowerCase() },
    state: "unknown", reason, toolCallId, observedAt: null, provider: "workshop_execution_leases",
    mapping: "unknown", lease: { evaluated: false, matchesRun: null, unexpired: null },
    heartbeat: { evaluated: false, fresh: null, ageMs: null }, observedActivity: "unknown",
    currentProcessActivity: "unknown", configuration: null };
}
/** Projects only registered reader output; configuration/history/terminal cannot supply liveness. */
export function projectTrustedLoopRuntimeObservation(context: TrustedLoopRuntimeContext,
  input: { toolCallId: string; isError?: boolean; output: unknown }): LoopRuntimeObservationFacet {
  const unknown = (reason: string) => unknownLoopRuntimeFacet(context, reason, input.toolCallId);
  if (!contextValid(context) || !input.toolCallId?.trim()) return unknown("invalid_call_binding");
  if (input.isError) return unknown("reader_error");
  let payload: unknown = input.output;
  if (typeof payload === "string") { try { payload = JSON.parse(payload); } catch { return unknown("invalid_reader_json"); } }
  const envelope = object(payload);
  if (!envelope || envelope.ok === false) return unknown("reader_failure");
  // Two exact server adapters, rather than arbitrary aliases guessed from JSON.
  const runtime = context.adapter === "native_platform_recall"
    ? object(object(envelope.data)?.runtimeObservation ?? envelope.runtime ?? envelope) : envelope;
  if (!runtime || runtime.provider !== "workshop_execution_leases") return unknown("provider_mismatch");
  if (runtime.status === "source_error") return unknown("source_error");
  if (runtime.status === "loop_not_found_in_scope") return unknown("owner_scope_unavailable");
  if (typeof runtime.loopId !== "string" || runtime.loopId.toLowerCase() !== context.loopId.toLowerCase()
    || (runtime.ownerId !== undefined && runtime.ownerId !== context.ownerId)
    || !time(runtime.observedAt)) return unknown("subject_or_time_mismatch");
  const result = unknown("runtime_fields_incomplete");
  const configuration = object(runtime.loopConfiguration);
  if (configuration && typeof configuration.status === "string"
    && /^(active|paused|archived|draft)$/.test(configuration.status)
    && (configuration.updatedAt === null || time(configuration.updatedAt))) {
    result.configuration = { status: configuration.status, updatedAt: configuration.updatedAt };
  }
  if (runtime.status === "no_active_linked_execution_observed") {
    if (runtime.observationScope !== "active_linked_execution_mapping_only" || runtime.linkedExecution !== null)
      return unknown("mapping_scope_mismatch");
    return { ...result, state: "observed", reason: null, observedAt: runtime.observedAt,
      mapping: "no_active_linked_mapping_observed" };
  }
  const linked = object(runtime.linkedExecution);
  if (!["active_lease_recent_heartbeat", "not_currently_verified"].includes(runtime.status)
    || runtime.observationScope !== "linked_execution_and_matching_lease" || !linked
    || !uuid.test(linked.workRunId) || !uuid.test(linked.loopRunId)
    || typeof linked.leaseMatchesRun !== "boolean" || typeof linked.leaseUnexpired !== "boolean"
    || typeof linked.heartbeatFresh !== "boolean"
    || !time(linked.leaseUntil) || !time(linked.heartbeatAt)
    || !Number.isSafeInteger(runtime.maximumHeartbeatAgeMs) || runtime.maximumHeartbeatAgeMs <= 0)
    return unknown("linked_fields_incomplete");
  const observedMs = Date.parse(runtime.observedAt), ageMs = observedMs - Date.parse(linked.heartbeatAt);
  if (ageMs < 0 || ageMs !== linked.heartbeatAgeMs
    || linked.heartbeatFresh !== (ageMs <= runtime.maximumHeartbeatAgeMs)
    || linked.leaseUnexpired !== (Date.parse(linked.leaseUntil) > observedMs)) return unknown("linked_fields_inconsistent");
  if (runtime.status === "active_lease_recent_heartbeat" && (!linked.leaseMatchesRun
    || !linked.leaseUnexpired || !linked.heartbeatFresh || linked.leasePhase !== "running"
    || linked.workRunStatus !== "running")) return unknown("active_status_inconsistent");
  return { ...result, state: "observed", reason: null, observedAt: runtime.observedAt, mapping: "linked",
    lease: { evaluated: true, matchesRun: linked.leaseMatchesRun, unexpired: linked.leaseUnexpired },
    heartbeat: { evaluated: true, fresh: linked.heartbeatFresh, ageMs },
    observedActivity: runtime.status === "active_lease_recent_heartbeat"
      ? "matching_lease_recent_heartbeat" : "not_currently_verified" };
}
export function renderLoopRuntimeObservationFacet(facet: LoopRuntimeObservationFacet): string {
  const prefix = `Loop ${facet.subject.loopId}：`;
  if (facet.state !== "observed") return `${prefix}本轮执行观测未核实（${facet.reason}）；当前执行器活动未知。`;
  const config = facet.configuration
    ? `数据库读取时任务配置为 ${facet.configuration.status}；配置状态不是执行器活动状态。` : "";
  if (facet.mapping === "no_active_linked_mapping_observed") return `${prefix}${config}数据库于 ${facet.observedAt} 未查到活动的 Loop 与执行记录关联映射。本次未评估该 Loop 的执行租约或心跳，当前执行器活动未知；不能据此推断已停止、阻塞或故障原因。`;
  const observation = facet.observedActivity === "matching_lease_recent_heartbeat"
    ? "观察到匹配的有效租约与近期心跳" : "未能核实匹配的有效租约与近期心跳";
  return `${prefix}${config}数据库于 ${facet.observedAt} ${observation}。这只描述读取时证据，回答瞬间进程活动仍未知。`;
}
export type HostVerifiedLoopFacet = { facet: "repair_evidence" | "configuration_postcondition"
  | "admission_feedback" | "history_observation"; text: string; evidenceRefs: string[] };
/** The callback is host code consuming actual reads, never JSON/prose from the model. */
export async function* guardTrustedLoopRuntimeAnswer(source: AsyncGenerator<AgentMessage>,
  context: TrustedLoopRuntimeContext, options: {
    questionScope: "runtime_only" | "fully_covered_host_facets";
    independentFacets?: () => HostVerifiedLoopFacet[];
    repairRequested?: boolean;
    requestedIndependentFacets?: HostVerifiedLoopFacet["facet"][];
  }): AsyncGenerator<AgentMessage> {
  if (!contextValid(context) || !options || !["runtime_only", "fully_covered_host_facets"].includes(options.questionScope)) {
    yield { type: "answer_evidence", answerEvidence: { schemaVersion: "loop-runtime-facet-scope.v3",
      protectedByNewRuntimeBoundary: false, outputPolicy: "baseline_stream_preserved",
      reason: "missing_or_invalid_explicit_host_contract", fullOriginalQuestionVerified: false } };
    yield* source; return;
  }
  let facet = unknownLoopRuntimeFacet(context, "runtime_observation_missing");
  const calls = new Set<string>(), completed = new Set<string>(), rejected = new Set<string>();
  const invalidInputs = new Set<string>();
  let newestObservedAt = -Infinity, done: AgentMessage | null = null, failed = false;
  for await (const event of source) {
    if (event.type === "tool_use" && event.name === context.toolName && event.id) {
      const params = object(event.input);
      // A native record/timeline/field read is not a runtime read and must not
      // erase a separate usable runtime result merely because the name matches.
      if (context.adapter === "native_platform_recall" && params
        && (params.recordRead !== undefined || params.timelineRead !== undefined || params.readHandle !== undefined)) {
        yield event; continue;
      }
      const runtimeRequest = object(params?.runtimeRead);
      const question = typeof params?.question === "string" ? params.question : null;
      const questionIds = question ? [...new Set((question.match(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi) ?? [])
        .map(id => id.toLowerCase()))] : [];
      const questionLoop = question?.match(/\bloop\s*(?:id)?\s*[:：#]?\s*([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/i)?.[1]?.toLowerCase();
      const subjectMatches = (id: unknown) => typeof id === "string" && id.toLowerCase() === context.loopId.toLowerCase();
      const validInput = !!params && (params.ownerId === undefined || params.ownerId === context.ownerId)
        && (context.adapter === "native_platform_recall"
          ? runtimeRequest ? subjectMatches(runtimeRequest.loopId)
            : questionIds.length === 1 && questionLoop === questionIds[0] && subjectMatches(questionLoop)
          : Object.keys(params).every(key => ["loopId", "ownerId"].includes(key))
            && (params.loopId === undefined || subjectMatches(params.loopId)));
      if (!validInput) {
        invalidInputs.add(event.id);
        facet = unknownLoopRuntimeFacet(context, "registered_runtime_call_input_mismatch", event.id);
      }
      if (calls.has(event.id)) {
        rejected.add(event.id); facet = unknownLoopRuntimeFacet(context, "duplicate_tool_call", event.id);
      }
      calls.add(event.id);
    }
    if (event.type === "tool_result" && event.toolUseId && calls.has(event.toolUseId)) {
      if (invalidInputs.has(event.toolUseId)) facet = unknownLoopRuntimeFacet(context, "registered_runtime_call_input_mismatch", event.toolUseId);
      else if (rejected.has(event.toolUseId)) facet = unknownLoopRuntimeFacet(context, "duplicate_tool_call", event.toolUseId);
      else if (completed.has(event.toolUseId)) facet = unknownLoopRuntimeFacet(context, "duplicate_tool_result", event.toolUseId);
      else {
        completed.add(event.toolUseId);
        const next = projectTrustedLoopRuntimeObservation(context, { toolCallId: event.toolUseId,
          isError: event.isError, output: event.output });
        if (next.observedAt && Date.parse(next.observedAt) < newestObservedAt)
          facet = unknownLoopRuntimeFacet(context, "out_of_order_observation", event.toolUseId);
        else { facet = next; if (next.observedAt) newestObservedAt = Date.parse(next.observedAt); }
      }
    }
    if (event.type === "error" || (event.type === "runtime_terminal"
      && (event.runtimeTerminal?.status !== "completed" || event.runtimeTerminal?.cleanupStatus !== "completed"))) failed = true;
    if (event.type === "done") done = event;
    else if (!["text", "result", "direct_answer"].includes(event.type)) yield event;
  }
  if (!failed) {
    const independent = (options.independentFacets?.() ?? []).filter(item => item.text.trim()
      && item.evidenceRefs.length > 0 && item.evidenceRefs.every(ref => typeof ref === "string" && ref.length > 0));
    const requested = [...new Set([...(options.requestedIndependentFacets ?? []),
      ...(options.repairRequested ? ["repair_evidence" as const] : [])])];
    const residualFacets = requested.filter(kind => !independent.some(item => item.facet === kind));
    // A successful stream is distinct from satisfying every original question obligation.
    yield { type: "answer_evidence", answerEvidence: { schemaVersion: "loop-runtime-facet-delivery.v1",
      runtimeFacet: facet, retainedIndependentFacets: independent.map(item => ({ facet: item.facet,
        evidenceRefs: item.evidenceRefs })), residualFacets,
      repairCoverage: options.repairRequested && residualFacets.includes("repair_evidence")
        ? { status: "incomplete", required: ["failed_baseline_verification", "all_cited_successor_verification_comparison"] } : null,
      rawModelProse: "withheld_not_independently_verified", contentVerdict: "requires_independent_review",
      fullOriginalQuestionVerified: false } };
    const text = [...independent.map(item => item.text),
      ...(options.repairRequested && !independent.some(item => item.facet === "repair_evidence")
        ? ["修复复验：本轮尚未完整核对失败基线及结论引用的后继验证字段，是否已经修好未核实。"] : []),
      ...residualFacets.filter(kind => kind !== "repair_evidence").map(kind => `${kind}：对应独立证据尚未核实。`),
      renderLoopRuntimeObservationFacet(facet)].join("\n\n");
    yield { type: "text", content: text, messageId: crypto.randomUUID() };
    yield { type: "result", content: text };
  }
  if (done) yield done;
}
