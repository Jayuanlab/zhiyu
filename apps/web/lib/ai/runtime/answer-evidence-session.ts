import { checkEvidenceTime } from "@/lib/brain/evidence-time";
import { directLoopRuntimeQuestionId } from "@/lib/ai/loop-runtime-answer-guard";
import { projectLoopRuntimeFacets, renderRequestedLoopRuntimeFacets, requestedLoopRuntimeFacets } from "./answer-evidence-loop-facets";
import type {
  AnswerDecision, AnswerEvidenceSessionOptions,
  EvidenceReceipt, FactResolution, FinalizeAnswerInput, ToolConstruction,
} from "./answer-evidence-contract";

export const ANSWER_EVIDENCE_RULE_VERSION = "exact-loop-observation.v2";
export { MAX_ANSWER_DRAFT_CHARACTERS, answerEvidenceHash, answerTextHash } from "./answer-evidence-core";
import { createAnswerEvidenceCore, answerEvidenceHash, answerTextHash, objectRecord as record, validEvidenceTime as validTime } from "./answer-evidence-core";
const runtimeStatuses = new Set(["no_active_linked_execution_observed", "active_lease_recent_heartbeat", "not_currently_verified"]);
const loopStatuses = new Set(["active", "paused", "archived", "draft"]);
/** Bounded first contract only; unsupported wording keeps the existing guard. */
export function exactCurrentLoopEvidenceSubject(question: string): string | null {
  const loopId = directLoopRuntimeQuestionId(question);
  if (!loopId) return null;
  const otherGoals = /(?:为什么|为何|原因|故障|修复|结果|产物|效果|生效|是否成功|有没有成功|是否完成|有没有完成|审核|审批|批准|下次|下一次|历史|昨天|明天|之前|以后|之后|\b(?:why|cause|repair|outcome|effect|succeed|success|approval|history|yesterday|tomorrow|schedule|scheduled|scheduling)\b|\bnext\s+(?:run|execution|time)\b)/iu;
  const command = /(?:暂停|停止|取消|启动|恢复|重启|删除|修改|更新|调整|重跑|发送|通知|关闭|上线|发布|禁用|启用|下单|运行一次|跑一次|执行(?:动作|命令|修改)|确认(?:修改|提交|批准|取消))/u;
  // A request to inspect a state may contain polite verbs. An additional
  // control verb is outside this read-only contract even when phrased politely.
  const chineseImperative = /(?:请|帮我|帮忙|替我|为我|麻烦|先|然后|再|并(?:且)?|同时|立即|马上|直接|把).{0,120}(?:暂停|停止|取消|启动|恢复|重启|删除|修改|更新|调整|重跑|发送|通知|关闭|上线|发布|禁用|启用|下单|运行一次|跑一次|执行(?:动作|命令|修改)|确认(?:修改|提交|批准|取消))/u;
  const englishImperative = /\b(?:pause|stop|cancel|start|resume|restart|delete|modify|update|send|notify|approve|disable|enable|publish|click|press|change|edit|configure|set)\b/iu;
  const withoutIds = question.replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu, "ID");
  if (otherGoals.test(question) || chineseImperative.test(question) || englishImperative.test(question)
    || /(?:^|[，,。.;；\n])\s*(?:暂停|停止|取消|启动|恢复|重启|删除|修改|更新|调整|重跑|发送|通知|关闭|上线|发布|禁用|启用)/u.test(question)
    || (/\bloop\s*(?:id\s*)?id\s*/iu.test(withoutIds) && /\bloop\s*(?:id\s*)?id\s*(?:暂停|停止|取消|启动|恢复|重启|删除|修改|更新|调整|重跑)/iu.test(withoutIds))
    || (command.test(question) && /(?:后|完成后|成功后)/u.test(question))) return null;
  return loopId;
}

/** Only host callbacks register constructions. Model text and client mirrors are never parsed. */
export function createAnswerEvidenceSession(options: AnswerEvidenceSessionOptions) {
  const loopId = exactCurrentLoopEvidenceSubject(options.question);
  const supported = Boolean(loopId);
  const requestedFacets = supported ? requestedLoopRuntimeFacets(options.question) : [];
  const unknownText = (reason: string) => `Loop ${loopId} 的当前执行状态未核实：${reason}。不能据此判断执行器现在是否运行，也不能推断已停止、阻塞或故障原因。可在车间核对运行记录。${renderRequestedLoopRuntimeFacets(requestedFacets)}`;

  function projection(input: ToolConstruction): EvidenceReceipt | undefined {
    if (!loopId || input.toolName !== "platformRecall") return undefined;
    const payload = record(input.result);
    if (payload.ok !== true || payload.success === false || payload.isError === true) return undefined;
    const runtime = record(record(payload.data).runtimeObservation ?? payload.runtime ?? payload);
    if (runtime.provider !== "workshop_execution_leases" || typeof runtime.loopId !== "string"
      || runtime.loopId.toLowerCase() !== loopId || !runtimeStatuses.has(runtime.status) || !validTime(runtime.observedAt)) return undefined;
    // A structured SDK details object does not prove that its fields were in
    // the text constructed for the model. This reader has a fixed JSON format.
    let visible: Record<string, any>;
    try { visible = record(JSON.parse(input.modelText ?? "")); } catch { return undefined; }
    const visibleRuntime = record(record(visible.data).runtimeObservation ?? visible.runtime ?? visible);
    if (answerEvidenceHash(visibleRuntime) !== answerEvidenceHash(runtime)) return undefined;
    const args = record(input.params);
    if (record(args.runtimeRead).loopId && String(record(args.runtimeRead).loopId).toLowerCase() !== loopId) return undefined;
    if (runtime.status === "no_active_linked_execution_observed"
      && (runtime.observationScope !== "active_linked_execution_mapping_only" || runtime.linkedExecution !== null)) return undefined;
    const runtimeFacets = projectLoopRuntimeFacets(runtime);
    if (runtime.status === "active_lease_recent_heartbeat") {
      const linked = record(runtime.linkedExecution);
      if (runtime.observationScope !== "linked_execution_and_matching_lease" || linked.leaseMatchesRun !== true
        || linked.heartbeatFresh !== true || linked.leaseUnexpired !== true || linked.workRunStatus !== "running"
        || linked.leasePhase !== "running" || !validTime(linked.heartbeatAt) || !validTime(linked.leaseUntil)
        || Date.parse(linked.heartbeatAt) > Date.parse(runtime.observedAt)
        || Date.parse(linked.leaseUntil) <= Date.parse(runtime.observedAt)
        || ["lease_matches_run", "lease_unexpired", "heartbeat_fresh"].some(key =>
          !runtimeFacets.some(fact => fact.key === key && fact.state === "observed" && fact.value === true))) return undefined;
    }
    const configuration = record(runtime.loopConfiguration);
    const config = loopStatuses.has(configuration.status) && (configuration.updatedAt === null || validTime(configuration.updatedAt))
      ? { status: configuration.status, updatedAt: configuration.updatedAt } : null;
    // The host reader's runtime schema is current-only. Frozen adapters must mark snapshot.
    const snapshot = typeof payload.frozenSnapshotCapturedAt === "string";
    const body = {
      schemaVersion: "answer-evidence.v1" as const, evidenceId: `${options.turnId}:${input.toolCallId}`,
      turnId: options.turnId, toolUseId: input.toolCallId, subject: { kind: "loop" as const, id: loopId },
      authorization: { ownerId: options.ownerId, policyHash: options.policyHash, decision: "allowed" as const, checkedAt: input.trace.timestamp },
      observation: { kind: snapshot ? "snapshot" as const : "live" as const, provider: runtime.provider,
        observedAt: runtime.observedAt, temporalScope: snapshot ? "snapshot" as const : "live_read" as const },
      availability: "read" as const, delivery: "result_constructed" as const,
      facts: [{ key: "runtime_observation", value: runtime.status, state: "observed" as const },
        { key: "loop_configuration", value: config, state: config ? "observed" as const : "unknown" as const },
        ...runtimeFacets],
    };
    return { ...body, source: { name: "workshop_execution_leases", resultHash: answerEvidenceHash(input.result), receiptHash: answerEvidenceHash(body) } };
  }

  const core = createAnswerEvidenceCore<EvidenceReceipt>({ ...options, supported, project: projection });
  const { observeToolConstruction, observeToolResult, observeContextCommitted, gaps } = core;
  let decision: AnswerDecision | undefined;

  function resolutionsFor(receipt?: EvidenceReceipt, denied = false): FactResolution[] {
    return ["loop_configuration", "runtime_observation", ...requestedFacets].map(key => {
      const fact = receipt?.facts.find(item => item.key === key);
      return { requirementId: key, state: denied ? "denied" : fact?.state === "observed" ? "supported" : "unknown",
        evidenceIds: fact?.state === "observed" && receipt ? [receipt.evidenceId] : [],
        reason: denied ? "permission_not_currently_authorized" : fact?.state === "observed" ? "matching_owner_scoped_observation" : "matching_evidence_unavailable",
        presentationIncluded: true };
    });
  }

  async function finalizeOnce(input: FinalizeAnswerInput): Promise<AnswerDecision> {
    return core.finalize(input, state => {
      const { now, failed, overflow, allowed, finalDenied, rawDraftHash } = state;
      const terminal = input.terminal;
      const candidates = state.receipts.filter(receipt => checkEvidenceTime(receipt.evidenceId, receipt.observation,
        { mode: "current", now: now.toISOString(), maxAgeMs: 5 * 60_000 }).state === "eligible")
        .sort((a, b) => Date.parse(b.observation.observedAt!) - Date.parse(a.observation.observedAt!));
    const conflict = gaps.has("construction_conflict");
    const receipt = !failed && !overflow && allowed && !conflict ? candidates[0] : undefined;
    let renderedText = input.rawDraft, outcome: AnswerDecision["outcome"] = "unchecked";
    let resolutions: FactResolution[] = [];
    if (supported) {
      resolutions = resolutionsFor(receipt, finalDenied);
      if (failed) { outcome = "execution_failed"; renderedText = unknownText(terminal?.status === "aborted" ? "本轮已中断" : "本轮运行未成功完成或清理失败"); }
      else if (overflow) { outcome = "unknown"; renderedText = unknownText("回答缓存超限，未提交完整模型回答"); }
      else if (!allowed) { outcome = "unknown"; renderedText = unknownText("最终来源访问权限未核实"); }
      else if (!receipt) { outcome = "unknown"; renderedText = unknownText("本轮没有取得已交付且时间合格的对应执行观测"); }
      else {
        const status = String(receipt.facts.find(fact => fact.key === "runtime_observation")!.value);
        const config = record(receipt.facts.find(fact => fact.key === "loop_configuration")?.value);
        const configText = config.status ? `任务配置在读取时为 ${config.status}${config.updatedAt ? `（配置更新时间 ${config.updatedAt}）` : ""}；这不是执行器活动状态。` : "任务配置状态未核实。";
        const observedAt = receipt.observation.observedAt;
        renderedText = status === "no_active_linked_execution_observed"
          ? `Loop ${loopId}：${configText}数据库于 ${observedAt} 未查到活动的 Loop 与执行记录关联映射。本次没有评估该 Loop 的执行租约或心跳；回答时执行器是否仍在运行未知，不能据此推断已停止、阻塞或故障原因。`
          : `Loop ${loopId}：${configText}数据库于 ${observedAt} ${status === "active_lease_recent_heartbeat" ? "观察到匹配的有效租约与近期心跳" : "未能核实正在活动的执行器"}。这只描述读取时的证据，不能证明回答瞬间的进程状态，也不证明任务结果成功。`;
        renderedText += renderRequestedLoopRuntimeFacets(requestedFacets, receipt);
        outcome = resolutions.every(item => item.state === "supported") ? "supported_fields" : "partial";
      }
    }
    const evidenceRefs = receipt ? [{ evidenceId: receipt.evidenceId, observedAt: receipt.observation.observedAt!, status: String(receipt.facts[0].value) }] : [];
    const candidateDisplayText = renderedText;
    if (options.mode === "shadow") {
      renderedText = input.rawDraft;
      resolutions = resolutions.map(item => ({ ...item, presentationIncluded: false }));
    }
    const base: AnswerDecision = { schemaVersion: "answer-decision.v1" as const, mode: options.mode, ruleVersion: ANSWER_EVIDENCE_RULE_VERSION,
      runtimeHash: options.runtimeHash, outcome, resolutions, renderedText, rawDraftHash,
      renderedTextHash: options.mode === "shadow" ? rawDraftHash : answerTextHash(renderedText), auditPersisted: false, auditIncomplete: false, evidenceRefs,
      ...(options.mode === "shadow" ? { candidateDisplayText, candidateDisplayTextHash: answerTextHash(candidateDisplayText) } : {}) };

      decision = base;
      return base;
    }, (base, state) => {
      base.outcome = "unknown";
      const uncommitted = unknownText("核验审计未能保存，最终结论未提交");
      if (options.mode === "shadow") {
        base.candidateDisplayText = uncommitted;
        base.candidateDisplayTextHash = answerTextHash(uncommitted);
      } else {
        base.renderedText = uncommitted;
        base.renderedTextHash = answerTextHash(base.renderedText);
      }
      base.resolutions = resolutionsFor(undefined, state.finalDenied).map(item => options.mode === "shadow" ? { ...item, presentationIncluded: false } : item);
      base.evidenceRefs = [];
      base.auditIncomplete = true;

      decision = base;
    });
  }

  return {
    mode: options.mode, supported, loopId, turnId: options.turnId,
    observeToolConstruction, observeToolResult, observeContextCommitted,
    bindPromptEvidence: core.bindPromptEvidence, observePromptContextCommitted: core.observePromptContextCommitted,
    finalize(input: FinalizeAnswerInput) { return finalizeOnce(input); },
    snapshot() { return { turnId: options.turnId, supported, loopId, ...core.snapshot(),
      resolutions: decision?.resolutions ?? resolutionsFor(), ...(decision ? { decision } : {}) }; },
  };
}
export type AnswerEvidenceSession = ReturnType<typeof createAnswerEvidenceSession>;
