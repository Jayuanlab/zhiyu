import { aggregatePlatformCommittedFieldPages } from "./platform-field-page-evidence";
import { checkEvidenceTime, inferEvidenceTimePolicy } from "@/lib/memory/retrieval/evidence-time";
import type { FactResolution } from "./answer-evidence-contract";
import { answerEvidenceHash, answerTextHash, type CoreFinalState } from "./answer-evidence-core";
import type { PlatformAnswerDecision, PlatformAnswerPlan, PlatformAnswerReceipt, PlatformAnswerSessionOptions, PlatformAnswerRequirement, PlatformFieldFact } from "./platform-answer-contract";
import { PLATFORM_ANSWER_RULE_VERSION } from "./platform-answer-contract";
import { bindPlatformMessageInterpretation, projectMessageInterpretationAudit, type MessageInterpretationBinding, type MessageInterpretationAnchor } from "./platform-message-interpretation";
import { derivePlatformProcessingJobBoundaries, PLATFORM_PROCESSING_JOB_STATUS_SOURCE } from "./platform-processing-job-boundaries";

const boundaryReasons: Record<string, [string, string]> = {
  business_effective_count: ["business_definition_missing", "存储状态不定义实际有效或可被执行器使用的数量，需要有效性规则及对应验证证据。"],
  current_worker_activity: ["runtime_receipt_required", "队列表状态不证明执行器当前活动，需要匹配运行及租约、心跳观测。"],
  raw_content_completeness: ["raw_content_receipt_required", "状态聚合没有读取原始正文，不能证明原始内容完整。"],
  specific_raw_event: ["specific_raw_event_receipt_required", "当前用户已存记录的状态统计未读取指定原始事件，不能确认该事件存在、可访问或其原文。"],
  paper_order_fill_ledger: ["paper_fill_ledger_required", "模拟委托的状态统计只计委托记录；实际成交数量、成交量及金额需要独立成交账本或匹配成交回执，不能由委托状态推断。"],
  processing_failure_not_disappearance: ["raw_event_lifecycle_receipt_required", "理解作业失败描述加工状态，不等于原始消息消失；该统计未逐项读取原始事件，不能确认每条原始消息的存续。"],
  source_lifecycle_history: ["source_timeline_receipt_required", "已存状态统计只描述各自观测时点的记录，需要匹配历史事件与时间线才能核实来源生命周期。"],
  business_or_later_outcome: ["business_or_timeline_receipt_required", "状态或验证字段是原记录；没有独立业务验收及后续时间线证据，不能确认实质成功、生效或恢复。"],
  original_user_decision: ["original_decision_evidence_required", "角色及消息正文不自动构成用户的明确决定，需核对对应用户原消息及授权上下文。"],
  unassessed_clause: ["unassessed_original_clause", "原问另有时间、数量或其它问项，当前契约尚未核实。"],
  unassessed_causal_claim: ["causal_verification_required", "已存错误字段不能独立确认真实根因，需要因果验证。"],
  independent_truth_verification: ["independent_verification_required", "读取原记录不独立证明其内容准确或真实，需要对应独立验证证据。"],
  waiting_definition: ["waiting_business_definition_missing", "“等待”的业务口径尚未明确，不能自动等同于 pending、running 或其它存储标签；若明确按 pending 原始标签计数，可核对该标签，但可领取数量还取决于计划时间和重试次数。"],
  runnable_job_count: ["runnable_job_predicate_required", "当前只有原始状态分组；可领取作业还需匹配计划时间、重试次数及恢复规则，不能将 pending、failed 或 resume_pending 的状态数量直接合并成可领取数量，也不能据此确认执行器活动。"],
};
type FactWithReceipt = { receipt: PlatformAnswerReceipt; fact: PlatformAnswerReceipt["facts"][number] };
function quote(value: unknown) {
  const json = JSON.stringify(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return json;
  // A source value is data. A longer inline-code delimiter prevents arbitrary
  // Markdown, links, images, HTML or embedded backticks becoming presentation.
  const longest = Math.max(0, ...(json.match(/`+/gu) ?? []).map(run => run.length));
  const delimiter = "`".repeat(longest + 1);
  return `${delimiter} ${json} ${delimiter}`;
}
function fenced(value: string, language = "text") {
  const longest = Math.max(0, ...(value.match(/`+/gu) ?? []).map(run => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${value}${value.endsWith("\n") ? "" : "\n"}${fence}`;
}
function displayField(value: unknown, fieldKey: string) {
  if (typeof value === "string" && (value.length > 200 || /[\r\n]/u.test(value))) return `\n${fenced(value)}\n`;
  if (value && typeof value === "object" && fieldKey === "triggerReason") return `\n${fenced(JSON.stringify(value, null, 2), "json")}\n`;
  return quote(value);
}
function knownText(value: unknown) {
  if (!Array.isArray(value) || !value.every(text => typeof text === "string")) return quote(value);
  if (!value.length) return "已完整读取的已识别文本段为空。";
  return value.map((text: string, index: number) => `文本段 ${index + 1}：\n${fenced(text)}`).join("\n\n");
}
export function renderPlatformAnswer(plan: PlatformAnswerPlan, state: CoreFinalState<PlatformAnswerReceipt>, options: PlatformAnswerSessionOptions): PlatformAnswerDecision {
  const policy = options.timePolicy ?? inferEvidenceTimePolicy(plan.question, state.now);
  const snapshotMatches = !plan.requestedSnapshotAt || !!options.snapshotAt && Number.isFinite(Date.parse(options.snapshotAt))
    && new Date(options.snapshotAt).toISOString() === plan.requestedSnapshotAt;
  const pageReceipts = aggregatePlatformCommittedFieldPages(state.contextReceipts, state.receipts, options);
  const facts: FactWithReceipt[] = [...state.receipts, ...pageReceipts].flatMap(receipt => receipt.facts.map(fact => ({ receipt, fact })))
    .filter(({ receipt, fact }) => snapshotMatches && checkEvidenceTime(receipt.evidenceId, fact.kind === "metric" ? fact.observation : { ...receipt.observation, observedAt: fact.observedAt }, policy).state === "eligible");
  const references = new Map<string, PlatformAnswerDecision["evidenceRefs"][number]>();
  const resolutions: FactResolution[] = [];
  const lines: string[] = [];
  const deny = state.finalDenied;
  const unavailable = state.failed || state.overflow || !state.allowed;
  const add = (requirement: PlatformAnswerRequirement, value: FactResolution["state"], reason: string, detail: string, matching: FactWithReceipt[] = []) => {
    if (lines.join("\n").length + detail.length + requirement.label.length > 60_000) {
      value = "unknown"; reason = "answer_display_budget_exhausted"; detail = "整字段展示预算已用尽，本问项未完成展示。"; matching = [];
    }
    const evidenceIds = [...new Set(matching.flatMap(item => item.fact.kind === "field" && item.fact.retrievalEvidenceIds ? item.fact.retrievalEvidenceIds : [item.receipt.evidenceId]))];
    resolutions.push({ requirementId: requirement.id, state: value, evidenceIds, reason, presentationIncluded: options.mode !== "shadow" });
    lines.push(`${requirement.label}：${detail}`);
    for (const { receipt, fact } of matching) {
      const key = `${receipt.evidenceId}:${fact.source}:${fact.observedAt}`;
      references.set(key, { evidenceId: receipt.evidenceId, observedAt: fact.observedAt, status: value, source: fact.source,
        scope: fact.kind === "gap" ? "owner_exact_record" : fact.scope });
    }
  };
  const exactField = (source: string, id: string, key: string) => facts.filter(item => item.fact.kind === "field" && item.fact.source === source && item.fact.id === id && item.fact.fieldKey === key);
  function chooseFields(candidates: FactWithReceipt[]) {
    const sorted = candidates.sort((a, b) => Date.parse(b.fact.observedAt) - Date.parse(a.fact.observedAt));
    if (!sorted.length) return [];
    const newest = sorted[0].fact as PlatformFieldFact;
    if (sorted.some(item => item.fact.observedAt === newest.observedAt && answerEvidenceHash((item.fact as PlatformFieldFact).value) !== answerEvidenceHash(newest.value))) return [];
    return [sorted[0]];
  }
  let interpretation: MessageInterpretationBinding = { state: "unavailable", reason: "message_interpretation_context_unavailable" };
  let interpretationEvidence: FactWithReceipt[] = [];
  const interpretationRequested = plan.kind === "message_identity" && plan.requirements.some(item => item.facet === "interpretation" || item.id === "original_user_decision");
  const interpretationDenied = facts.some(item => item.fact.kind === "gap" && item.fact.source === "message" && item.fact.id === plan.subject?.id
    && item.fact.state === "denied" && (!item.fact.fieldKey || ["known_text", "textParts", "parts", "role"].includes(item.fact.fieldKey)));
  if (interpretationRequested && plan.subject && !unavailable && snapshotMatches && !interpretationDenied) {
    const text = chooseFields(exactField("message", plan.subject.id, "known_text")), role = chooseFields(exactField("message", plan.subject.id, "role"));
    const textFact = text[0]?.fact, roleFact = role[0]?.fact;
    if (textFact?.kind === "field" && textFact.state === "supported" && textFact.scope === "known_message_text"
      && Array.isArray(textFact.value) && textFact.value.every(value => typeof value === "string")
      && roleFact?.kind === "field" && roleFact.state === "supported" && typeof roleFact.value === "string"
      && (textFact.contentHash && roleFact.contentHash ? textFact.contentHash === roleFact.contentHash : textFact.observedAt === roleFact.observedAt)) {
      interpretation = bindPlatformMessageInterpretation(state.input.rawDraft, { messageId: plan.subject.id, role: roleFact.value,
        knownText: textFact.value as string[], textEvidenceId: text[0].receipt.evidenceId, roleEvidenceId: role[0].receipt.evidenceId, observedAt: textFact.observedAt });
      if (interpretation.state === "candidate_available") interpretationEvidence = [...text, ...role];
    }
  }
  function anchorDisplay(anchors: MessageInterpretationAnchor[]) {
    return anchors.map(anchor => `依据：文本段 ${anchor.textIndex + 1}，UTF-16 字符区间 [${anchor.startUtf16}, ${anchor.endUtf16})。\n${fenced(anchor.quote)}`).join("\n");
  }
  const jobBoundaries = derivePlatformProcessingJobBoundaries({
    metrics: facts.flatMap(({ fact }) => fact.kind === "metric" && fact.source === PLATFORM_PROCESSING_JOB_STATUS_SOURCE ? [fact] : []),
    contextState: deny ? "denied" : unavailable ? "unavailable" : !snapshotMatches ? "snapshot_mismatch" : "eligible",
  });
  const jobEvidence = jobBoundaries.binding ? facts.filter(({ fact }) => fact.kind === "metric"
    && fact.source === jobBoundaries.binding!.source && fact.proofId === jobBoundaries.binding!.proofId && fact.observedAt === jobBoundaries.binding!.observedAt) : [];
  const jobPolicyScope = `按现有服务规则，对${options.snapshotAt ? "该只读快照" : "该次已存状态观测"}作条件计算；未核实观测时点的服务规则版本，也不代表实时领取状态。`;
  // Keep every obligation and the full original text, but let the reader see
  // the evidence-bound model interpretation before lengthy source quotations.
  const orderedRequirements = interpretation.state === "candidate_available"
    ? [...plan.requirements.filter(item => item.facet === "interpretation" || item.id === "original_user_decision"),
      ...plan.requirements.filter(item => item.facet !== "interpretation" && item.id !== "original_user_decision")]
    : plan.requirements;
  for (const requirement of orderedRequirements) {
    if (unavailable) { add(requirement, deny ? "denied" : "unknown", deny ? "permission_not_currently_authorized" : state.failed ? "runtime_not_completed" : "answer_budget_exhausted", deny ? "最终来源访问权限未核实。" : "本轮未完成可靠交付，相关事实未提交。"); continue; }
    if (!snapshotMatches) { add(requirement, "unknown", "requested_snapshot_not_matched", "请求的只读快照时点未与采集记录匹配，不能用其它快照或实时记录代替。"); continue; }
    if (requirement.facet === "interpretation" || requirement.id === "original_user_decision") {
      if (interpretationDenied) { add(requirement, "denied", "permission_denied", "消息来源访问被拒绝，理解候选未提交。"); continue; }
      if (interpretation.state !== "candidate_available") { add(requirement, "unknown", interpretation.reason, "尚未取得基于完整已交付文本、带有效原文锚的理解候选；不会从角色或未读内容推断决定。"); continue; }
      if (requirement.facet === "interpretation") {
        add(requirement, "unknown", "message_interpretation_candidate_available", `模型解读候选（原文对应已核对，语义尚未独立核实）：\n${fenced(interpretation.summary.text)}\n${anchorDisplay(interpretation.summary.anchors)}\n仅限已完整读取的已识别文本段，不代表未读消息组成。`, interpretationEvidence); continue;
      }
      const decision = interpretation.decision;
      if (decision.state === "unavailable") { add(requirement, "unknown", decision.reason, "决定分类候选未通过角色、原文锚或已读范围检查，不能确认用户已作出决定。", interpretationEvidence); continue; }
      const labels = { user_direct: "用户直接表达的决定候选", quoted_user: "引用用户说法的决定候选", assistant_restatement: "助手转述的决定候选", not_found_in_read_text: "在全部已读文本中未发现明确决定（模型判断）", unverified: "决定尚未核实" };
      add(requirement, "unknown", "message_decision_candidate_available", `${labels[decision.classification]}，语义尚未独立核实：\n${fenced(decision.explanation)}\n${anchorDisplay(decision.anchors)}\n这不是用户授权。引用或助手转述需核对对应用户原消息；未发现只限已完整交付的已识别文本，不否定未读 payload 或整条消息。`, interpretationEvidence); continue;
    }
    if (requirement.facet === "boundary") {
      if (requirement.source === PLATFORM_PROCESSING_JOB_STATUS_SOURCE && requirement.boundaryKind === "waiting_definition"
        && jobBoundaries.waiting.state === "conditional" && jobEvidence.length) {
        const detail = `“等待”的业务口径尚未明确，不能将 running 改称等待。${jobPolicyScope}完整已存状态可分别核对以下现有流程条件口径：\n${jobBoundaries.waiting.branches.map(branch => `- 按原始 ${branch.status} 标签：${branch.count} 条。${branch.definition}`).join("\n")}\n以上分别计数，不合并成唯一等待量，也不证明执行器当前活动。来源为当前用户已存消息理解作业，观测于 ${jobBoundaries.binding!.observedAt}。`;
        add(requirement, "unknown", jobBoundaries.waiting.reason, detail, jobEvidence); continue;
      }
      if (requirement.source === PLATFORM_PROCESSING_JOB_STATUS_SOURCE && requirement.boundaryKind === "runnable_job_count" && jobEvidence.length) {
        if (jobBoundaries.runnable.state === "supported") {
          add(requirement, "supported", jobBoundaries.runnable.reason, `${jobPolicyScope}现有领取规则要求原始状态属于 pending、failed 或 resume_pending。当前用户完整已存分组中这三个必要状态均为 0，因此按该现有规则计算的范围内可领取作业数为 0（记录观测于 ${jobBoundaries.binding!.observedAt}）。这不证明执行器当前活动。`, jobEvidence); continue;
        }
        add(requirement, "unknown", jobBoundaries.runnable.reason, `${jobPolicyScope}原始状态中存在领取候选；是否可领取仍需计划时间、重试次数及恢复规则的匹配证据，不能合并状态数量直接给出可领取总数。`, jobEvidence); continue;
      }
      const [reason, detail] = boundaryReasons[requirement.boundaryKind ?? requirement.id] ?? ["unassessed_original_clause", "当前契约尚未核实此问项。"];
      add(requirement, "unknown", reason, detail); continue;
    }
    if (requirement.facet === "metric") {
      const candidates = facts.filter(item => item.fact.kind === "metric" && item.fact.source === requirement.source)
        .sort((a, b) => Date.parse(b.fact.observedAt) - Date.parse(a.fact.observedAt));
      const chosen = candidates[0];
      const selectedMetric = chosen?.fact.kind === "metric" ? chosen.fact : undefined;
      if (!chosen || !selectedMetric || candidates.some(item => item.fact.kind === "metric" && item.fact.observedAt === selectedMetric.observedAt && item.fact.proofId !== selectedMetric.proofId)) {
        add(requirement, "unknown", "complete_owner_scope_proof_unavailable", "未取得当前用户已存记录的完整范围及完整交付证明，不能用分页样本外推总数。"); continue;
      }
      const fact = selectedMetric;
      if (requirement.metricRequest) {
        if (!fact.groups) { add(requirement, "unknown", "complete_owner_stored_scope_unavailable", "未取得原问指定维度的完整分组，不能将缺席标签计零。"); continue; }
        const request = requirement.metricRequest;
        const group = fact.groups.find(item => typeof item.value === typeof request.value && item.value === request.value);
        const valueDetail = request.value === null
          ? `未分类（NULL）分组数量 ${group?.count ?? 0}（NULL 指返回的空维度分组值，并非 SQL 等值谓词）`
          : `原始标签 ${quote(request.value)}数量 ${group?.count ?? 0}`;
        add(requirement, "supported", group ? "matching_source_dimension_value" : "absent_dimension_value_in_complete_query",
          `原问标签 ${quote(request.requestedLabel)}；来源 ${quote(fact.source)}、${valueDetail}${group ? "" : "（该分组值未出现在本次完整分组中，仅在此读取范围内计零）"}；范围为当前用户已存记录的原始维度分组值统计（读取/采集于 ${fact.observedAt}），不代表业务效果或执行器活动。`, [chosen]); continue;
      }
      const groups = fact.groups?.map(group => `${quote(group.value)}=${group.count}`).join("，") ?? "";
      add(requirement, "supported", "complete_owner_stored_scope", `当前用户已存记录总数 ${fact.total}${groups ? `；原始状态分布 ${groups}` : ""}（读取/采集于 ${fact.observedAt}）。`, [chosen]); continue;
    }
    let subjectId = requirement.subjectId;
    if (requirement.linkedBy && plan.subject) {
      const links = chooseFields(exactField(plan.subject.source, plan.subject.id, requirement.linkedBy));
      const value = links[0]?.fact.kind === "field" ? links[0].fact.value : undefined;
      if (typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)) subjectId = value.toLowerCase();
      else { add(requirement, "unknown", "linked_subject_identity_unavailable", "尚未读取可信关联 ID，不能用其它同名记录代替。"); continue; }
    }
    const fieldKey = requirement.facet === "known_text" ? "known_text" : requirement.fieldKey!;
    const gaps = facts.filter(item => item.fact.kind === "gap" && item.fact.source === requirement.source && item.fact.id === subjectId && (!item.fact.fieldKey || item.fact.fieldKey === fieldKey));
    if (gaps.some(item => item.fact.kind === "gap" && item.fact.state === "denied")) { add(requirement, "denied", "permission_denied", "来源访问被拒绝。"); continue; }
    const chosen = subjectId ? chooseFields(exactField(requirement.source, subjectId, fieldKey)) : [];
    if (!chosen.length) {
      const reason = gaps[0]?.fact.kind === "gap" ? gaps[0].fact.reason : "matching_field_not_read";
      add(requirement, "unknown", reason, reason === "field_too_large" ? "字段超过当前整字段预算，正文仍未读完。" : reason === "version_changed" ? "来源版本已变更，需要在当前预算内重新发现后读取。" : "未取得对应字段的完整、已交付读取；字段未显示不代表没有记录。"); continue;
    }
    const fact = chosen[0].fact as PlatformFieldFact;
    if (fact.state === "not_recorded") { add(requirement, "not_recorded", "published_field_null", `该发布字段已完整读取，存储值为 null（${fact.observedAt}）。${requirement.source === "workshopRuns" && fieldKey === "error" ? "该字段未记录错误，不能据此排除未记录的失败。" : ""}`, chosen); continue; }
    const detail = requirement.facet === "known_text" ? `仅展示完整读取的已识别文本段；全部消息组成及原始记录完整性须另行核实。\n${knownText(fact.value)}`
      : `${displayField(fact.value, fieldKey)}${requirement.source === "loops" ? "（读取时任务配置，不能作为运行当时配置或执行器活动证明）" : ""}`;
    add(requirement, "supported", "matching_owner_scoped_whole_field", detail, chosen);
  }
  const evidenceCoverage = { supported: resolutions.filter(item => item.state === "supported").length, notRecorded: resolutions.filter(item => item.state === "not_recorded").length,
    unknown: resolutions.filter(item => item.state === "unknown").length, denied: resolutions.filter(item => item.state === "denied").length, total: resolutions.length };
  const questionComplete = !unavailable && resolutions.length > 0 && resolutions.every(item => item.state === "supported" || item.state === "not_recorded");
  const count = evidenceCoverage.supported + evidenceCoverage.notRecorded;
  const outcome = state.failed ? "execution_failed" : questionComplete ? "supported_fields" : count ? "partial" : "unknown";
  const prefix = !snapshotMatches ? `请求的只读快照 ${plan.requestedSnapshotAt} 尚未核实。` : options.snapshotAt ? `以下仅描述采集于 ${options.snapshotAt} 的只读快照，不能当作实时当前状态。` : "以下为本轮读取到的当前用户已存记录，记录字段不自动证明业务效果。";
  const runRecordBoundary = plan.kind === "workshop_run_outcome"
    ? "\n存储的车间运行状态只描述运行记录；completed 不证明业务验收通过或业务真实效果。错误字段须按已读取值解释，不能排除未记录的失败。输出摘要与未读缺项按各自来源和交付范围呈现。"
    : plan.kind === "run_outcome" && plan.subject?.source === "loopRuns"
      ? "\n存储的运行状态只描述运行记录，不证明业务验收通过或业务真实效果。输出摘要、验证字段及未读缺项仍按各自来源和交付范围分别呈现。" : "";
  const candidateDisplayText = `${prefix}${runRecordBoundary}\n${lines.join("\n")}${plan.statisticSources.length > 1 ? "\n各统计按各自观测时间读取，未据此声称多个总体是同一原子时点。" : ""}`;
  const renderedText = options.mode === "shadow" ? state.input.rawDraft : candidateDisplayText;
  return { schemaVersion: "platform-answer-decision.v1", mode: options.mode, contractKind: plan.kind, ruleVersion: PLATFORM_ANSWER_RULE_VERSION, runtimeHash: options.runtimeHash,
    outcome, resolutions, questionComplete, evidenceCoverage, renderedText, rawDraftHash: state.rawDraftHash,
    renderedTextHash: options.mode === "shadow" ? state.rawDraftHash : answerTextHash(renderedText), auditPersisted: false, auditIncomplete: false,
    evidenceRefs: [...references.values()], ...(interpretationRequested ? { interpretationAudit: projectMessageInterpretationAudit(interpretation) } : {}),
    ...(options.mode === "shadow" ? { candidateDisplayText, candidateDisplayTextHash: answerTextHash(candidateDisplayText) } : {}) };
}
