import type { AnswerBodyMirror } from "@/lib/ai/runtime/answer-body-mirror";

export type AuditSummary = {
  turnId: string;
  chatId: string;
  assistantMessageId: string;
  status: "running" | "completed" | "failed" | "aborted";
  mode?: "off" | "shadow" | "enforce_critical" | "enforce_supported";
  finalText?: string;
  bodyMirror?: AnswerBodyMirror;
  runtimeTerminal?: { schemaVersion?: string; status?: string; cleanupStatus?: string };
  evidence?: {
    schemaVersion?: string;
    mode?: string;
    kind?: string;
    contractKind?: string;
    outcome?: string;
    auditPersisted?: boolean;
    auditIncomplete?: boolean;
    questionComplete?: boolean;
    evidenceCoverage?: { supported: number; notRecorded: number; unknown: number; denied: number; total: number };
    resolutions?: Array<{ requirementId: string; state: string; reason: string; presentationIncluded?: boolean }>;
    evidenceRefs?: Array<{ evidenceId?: string; observedAt?: string; status: string; source?: string; scope?: string }>;
  };
  progress?: {
    schemaVersion: string;
    phase: "reading" | "read_closed";
    totalRequirements: number;
    resolvedRequirements: number;
    lastEventAt: string;
    requirements: Array<{ requirementId: string; label: string; state: string; reason?: string }>;
  };
};

const LABELS: Record<string, string> = {
  "loopRuns.status": "运行记录状态", "loopRuns.outputSummary": "运行结果摘要", "loopRuns.verificationResult": "结果验证记录",
  "loopRuns.error": "运行错误记录", "loopRuns.loopId": "所属任务", "loopRuns.triggerReason": "触发原因",
  "loops.name": "任务名称", "loops.goal": "任务目标", "loops.triggerConfig": "触发配置", "loops.status": "任务保存状态",
  "message.role": "消息角色", "message.chatId": "所属对话", "message.known_text": "已知消息正文", "message.parts": "消息组成",
  "message.interpretation": "消息含义解读",
  "chat.title": "对话标题", "brain_memories.status": "记忆保存状态分布", "interaction_processing_jobs.status": "消息处理作业状态分布",
  "interaction_events.processed_status": "原始消息处理标记分布", "paper_orders.status": "模拟订单保存状态分布",
  "workshop_outbox.status": "待发消息保存状态分布", "workshop_heartbeats.scheduler_status": "车间调度保存状态分布",
  "workshops.status": "车间保存状态分布", business_effective_count: "业务有效数量", current_worker_activity: "当前执行活性",
  raw_content_completeness: "原始内容完整性", business_or_later_outcome: "业务效果或后续结果", original_user_decision: "用户原始决定",
  unassessed_clause: "原问中的其它问项", unassessed_causal_claim: "原因分析",
};
const SOURCE_LABELS: Record<string, string> = {
  loopRuns: "任务运行记录", workshopRuns: "车间运行记录", loops: "任务配置", message: "消息记录", chat: "对话记录",
  "brain_memories.status": "记忆保存状态", "interaction_processing_jobs.status": "消息处理作业", "interaction_events.processed_status": "原始消息处理标记",
  "paper_orders.status": "模拟订单", "workshop_outbox.status": "待发消息", "workshop_heartbeats.scheduler_status": "车间调度记录",
  "loops.status": "任务保存状态", "workshops.status": "车间保存状态",
};
const SCOPE_LABELS: Record<string, string> = {
  owner_exact_record: "当前用户的指定记录", owner_stored_status: "当前用户的保存状态分布",
  known_message_text: "当前可见的指定消息正文", exact_context: "本轮指定上下文",
};
const REASONS: Record<string, string> = {
  business_definition_missing: "尚缺业务有效性规则与验证证据，保存状态不能代替实际有效数量。",
  runtime_receipt_required: "尚缺匹配的运行、租约或心跳观测，处理队列状态不能证明执行器当前活动。",
  raw_content_receipt_required: "本轮尚未读取原始正文，状态统计不能证明内容完整。",
  business_or_timeline_receipt_required: "尚缺独立业务验收或后续时间线证据，记录状态不能确认实际效果。",
  original_decision_evidence_required: "尚需核对用户原消息与授权上下文，消息角色不能代替明确决定。",
  message_interpretation_context_unavailable: "尚未取得这条消息完整交付的已知正文与角色，无法提交带依据的解读。",
  message_interpretation_candidate_missing: "本轮尚未给出可核对原文依据的消息解读。",
  message_interpretation_candidate_too_large: "解读超过本次展示边界，尚未提交。",
  message_interpretation_invalid_format: "解读未按约定格式提交，原文依据尚未核对。",
  message_interpretation_invalid_schema: "解读的记录、分类或必要字段不匹配，尚未提交。",
  message_interpretation_anchor_invalid: "解读引用的原文不存在、位置不明确或不在已读取范围内。",
  message_decision_role_mismatch: "决定分类与实际消息角色不符，不能当作用户授权。",
  message_decision_anchor_invalid: "决定判断的原文依据尚未核对，不能当作用户授权。",
  message_decision_read_scope_incomplete: "尚未核对全部已知文本，不能声称所读正文中没有明确决定。",
  message_interpretation_candidate_available: "已核对引用与所读原文的对应；解读含义尚未独立核实。",
  message_decision_candidate_available: "已交付带原文依据的决定解读；分类尚未独立核实，也不授予动作权限。",
  unassessed_original_clause: "原问仍有当前读取范围尚未覆盖的问项。",
  causal_verification_required: "已存错误字段不能独立确认真实根因，尚需因果验证。",
  permission_not_currently_authorized: "最终来源访问权限尚未核实。", permission_denied: "来源访问被拒绝。",
  runtime_not_completed: "本轮未完成可靠交付，相关事实未提交。", answer_budget_exhausted: "本轮读取或回答预算已耗尽，相关问项保持未知。",
  complete_owner_scope_proof_unavailable: "尚未取得当前用户完整范围的统计证明，不能从分页样本推算总数。",
  complete_owner_stored_scope: "已核对当前用户保存状态范围的完整统计。",
  matching_source_dimension_value: "已核对原问指定的原始状态标签数量。",
  absent_dimension_value_in_complete_query: "指定标签未出现在本次完整分组中，仅在该来源与读取范围内计零。",
  waiting_business_definition_missing: "等待的业务口径尚未明确，不能直接用某个保存状态替代。",
  waiting_has_multiple_feature_definitions: "现有流程包含等待恢复和等待人工审核等不同口径，已分别说明各分支数量。",
  fixed_service_necessary_status_empty: "现有领取规则的必要状态集合为空，本次快照可领取数量为零。",
  runnable_schedule_and_attempts_required: "存在候选状态，仍需核对计划时间、次数和恢复规则，才能确定可领取数量。",
  processing_job_metric_binding_invalid: "作业统计的来源、范围或交付绑定不符合要求。",
  processing_job_metric_conflict: "同一快照的作业统计存在冲突，数量尚未核实。",
  runnable_job_predicate_required: "可领取数量还需核对计划时间、重试次数及恢复规则，状态分组尚不足以证明。",
  linked_subject_identity_unavailable: "尚未读到可信关联记录，不能用同名记录代替。",
  matching_field_not_read: "尚未取得对应字段的完整读取，字段未显示不代表没有记录。",
  field_too_large: "字段超过当前整字段读取预算，正文尚未读完。",
  version_changed: "来源版本已变更，需要重新读取当前版本。",
  published_field_null: "指定字段已完整读取，保存值为空；仅适用于该字段与本轮读取范围。",
  matching_owner_scoped_whole_field: "已核对当前用户指定记录的完整发布字段。",
  audit_incomplete: "本轮核验审计未完整保存，最终结论未提交。",
};
function explainReason(reason: string | undefined) {
  if (!reason) return undefined;
  return REASONS[reason] ?? (/[\u3400-\u9fff]/u.test(reason) ? reason.slice(0, 240) : "该项核验说明暂不可用。");
}

/** Derive display state from the owned, terminal audit and the entire visible body. */
export function presentAnswerEvidence(input: {
  turnId: string; chatId: string; assistantMessageId: string; displayedText: string;
  valid: boolean; unavailable?: boolean; summary?: AuditSummary;
}) {
  const data = input.summary;
  const owned = data?.turnId === input.turnId && data.chatId === input.chatId && data.assistantMessageId === input.assistantMessageId;
  const unavailable = !input.valid || !!input.unavailable || (!!data && !owned);
  const bodyMatches = owned && typeof data.finalText === "string" && data.finalText === input.displayedText;
  const bodyMismatch = owned && data.status !== "running" && !!data.evidence && !bodyMatches;
  const mirror = !unavailable && owned && data.bodyMirror?.schemaVersion === "answer-body-mirror.v1" ? data.bodyMirror : undefined;
  const bodySaved = bodyMatches && mirror?.state === "stored_matching" && mirror.reason === "exact_body_and_turn_reference";
  const bodyMirrorTitle = bodySaved ? "聊天正文已保存，与本轮答文一致"
    : mirror?.state === "unavailable" || unavailable ? "聊天正文保存状态暂不可核实"
    : "聊天正文保存尚未确认";
  const known = data?.evidence?.schemaVersion === "answer-evidence-summary.v1" || data?.evidence?.schemaVersion === "platform-answer-summary.v1";
  const evidence = !unavailable && bodyMatches && data.status !== "running" && known ? data.evidence : undefined;
  const loop = !unavailable && owned && data.evidence?.schemaVersion === "answer-evidence-summary.v1";
  const platform = evidence?.schemaVersion === "platform-answer-summary.v1";
  const shadow = owned && data.mode === "shadow";
  const terminal = data?.runtimeTerminal;
  const runtimeComplete = terminal?.schemaVersion === "agent-runtime-terminal.v1" && terminal.status === "completed" && terminal.cleanupStatus === "completed";
  const enforced = platform ? data?.mode === "enforce_supported" && evidence?.mode === "enforce_supported" : data?.mode === "enforce_critical";
  const usable = !unavailable && data?.status === "completed" && runtimeComplete && enforced && evidence?.auditPersisted === true && evidence.auditIncomplete !== true && evidence.outcome !== "unchecked";
  const resolutions = evidence?.resolutions ?? [];
  const progress = !unavailable && owned && data.progress?.schemaVersion === "platform-answer-progress.v1" ? data.progress : undefined;
  const label = (id: string, index: number) => LABELS[id] ?? progress?.requirements.find(r => r.requirementId === id)?.label ?? `问项 ${index + 1}`;
  const rows: Array<{ label: string; value: string; reason?: string }> = platform ? resolutions.map((resolution, index) => ({
    label: label(resolution.requirementId, index),
    value: shadow ? (resolution.state === "supported" || resolution.state === "not_recorded" ? "候选依据已读取，正文尚未核验" : "候选依据存在缺口")
      : !usable || !resolution.presentationIncluded ? "尚未核实"
      : resolution.state === "supported" ? "已核对读取到的字段"
      : resolution.state === "not_recorded" ? "在指定读取范围内未记录"
      : resolution.state === "denied" ? "权限边界拒绝读取"
      : resolution.reason === "message_interpretation_candidate_available" ? "已交付解读，语义尚未核实"
      : resolution.reason === "message_decision_candidate_available" ? "已交付判断，不代表用户授权" : "未知，证据不足",
    reason: explainReason(resolution.reason),
  })) : loop ? [
    { label: "任务配置", value: usable && resolutions.some(r => r.requirementId === "loop_configuration" && r.state === "supported" && r.presentationIncluded) ? "已读取配置状态" : "未核实" },
    { label: "执行观测", value: usable && resolutions.some(r => r.requirementId === "runtime_observation" && r.state === "supported" && r.presentationIncluded) ? "已核验读取时的有限观测" : "未核实" },
    { label: "实际效果", value: "本轮未核验任务结果或回答瞬间的进程状态" },
  ] : progress ? progress.requirements.map(r => ({ label: r.label, value: r.state === "pending" ? "等待读取" : "已判断，等待回答与终态确认", reason: explainReason(r.reason) })) : [];
  const checked = usable ? resolutions.filter(r => r.presentationIncluded && (r.state === "supported" || r.state === "not_recorded")).length : 0;
  const total = platform ? evidence?.evidenceCoverage?.total ?? resolutions.length : progress?.totalRequirements;
  const complete = usable && platform && evidence.questionComplete === true && !!total && checked === total && evidence.outcome === "supported_fields";
  const title = unavailable ? "核验记录暂不可用"
    : !data || data.status === "running" ? "正在读取并核对本轮问项"
    : bodyMismatch ? "显示正文尚未与核验记录一致"
    : data.status === "aborted" ? "本轮回答已中断"
    : data.status === "failed" ? "本轮回答未正常完成"
    : shadow ? "影子对照：正文尚未受核验约束"
    : !evidence || evidence.outcome === "unchecked" || data.mode === "off" ? "本轮回答尚未核验"
    : complete ? "已核对本轮问项（限读取范围）"
    : usable && !platform && evidence.outcome === "supported_fields" ? "已核验本次读取到的状态"
    : "部分问项存在证据缺口";
  const runtimeNotice = !unavailable && owned && (data.status === "aborted" || data.status === "failed")
    ? "本轮未完成可靠核验交付；相关任务的执行状态和实际效果尚未核实。" : undefined;
  const sources = (evidence?.evidenceRefs ?? []).map(ref => ({
    source: ref.source ? SOURCE_LABELS[ref.source] : undefined,
    scope: ref.scope ? SCOPE_LABELS[ref.scope] : undefined,
    observedAt: ref.observedAt,
  })).filter(ref => ref.source || ref.scope || ref.observedAt);
  return { title, runtimeNotice, rows, shadow: !!shadow, platform: !!platform, checked, total,
    gaps: total === undefined ? undefined : Math.max(0, total - checked), sources, progress,
    bodyMirrorTitle, bodyMirrorObservedAt: mirror?.observedAt };
}
