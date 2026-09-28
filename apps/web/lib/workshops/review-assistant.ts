/** Browser-safe projection. Execution receipts are separate from model output. */
export type ReviewAssistantDecision = {
  itemId: string;
  title: string;
  outcome: "closed_for_now" | "owner_review" | "investigate";
  reason: string;
  knownFacts: string[];
  evidence: string[];
  missingInfo: string[];
  sourceUpdatedAt: string;
  sourceEventId: string | null;
  applied: boolean;
  decisionEventId?: string;
  decidedAt?: string;
};

export type ReviewAssistantItem = {
  id: string;
  kind: string;
  title: string;
  what: string;
  whyOwner: string;
  impact: string;
  decision: string;
  category: "required" | "optional" | "anomaly";
  priority: "first" | "normal" | "later";
  prioritySource: "rules" | "ai";
  suggestion: "review" | "defer" | "need_evidence";
  reason: string;
  evidence: string[];
  missingInfo: string[];
  sourceEventId: string | null;
  sourceUpdatedAt: string;
  riskLevel: "low" | "medium" | "high" | null;
  aiAssisted: boolean;
  knownFacts?: string[];
  nextStep?: string;
  verificationQuestions?: { impact: string; benefit: string; evidence: string; sideEffects: string };
};

export type ReviewAssistantResponse = {
  version: 1;
  workId: string;
  generatedAt: string;
  fingerprint: string;
  mode: "rules" | "ai";
  model: string | null;
  warning: string | null;
  cached: boolean;
  coverage: {
    scope: "pending_review_items";
    total: number;
    included: number;
    analyzed: number;
    limit: number;
    hasMore: boolean;
    note: string;
  };
  items: ReviewAssistantItem[];
  decisions?: ReviewAssistantDecision[];
};

export type ReviewAssistantSourceItem = {
  id: string;
  kind: string;
  title: string;
  summary?: string | null;
  riskLevel?: string | null;
  sourceEventId?: string | null;
  updatedAt?: Date | string;
  createdAt?: Date | string;
  metadata?: unknown;
};

export type ReviewAssistantSourceEvent = {
  id: string;
  title: string;
  type: string;
  body?: string | null;
  createdAt?: Date | string;
  metadata?: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function compact(value: unknown, max = 260) {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function dateString(value: Date | string | undefined) {
  const date = value instanceof Date ? value : value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

type Explanation = Pick<ReviewAssistantItem, "title" | "what" | "whyOwner" | "impact" | "decision" | "category">;
const explanations: Record<string, Explanation> = {
  report_quality_config_proposal: {
    title: "让以后的工作汇报更好读",
    what: "系统检查了一次工作汇报，提出了改进以后报告格式或证据说明的建议。",
    whyOwner: "这是一项可选的汇报改进，你可以按兴趣查看，不需要给每份报告打分。",
    impact: "未实施前继续沿用原汇报方式。关注仅用于收藏，关闭待办不会修改报告。",
    decision: "查看具体建议，想实施时在当前智能体对话中交代；无需跟进可关闭待办。",
    category: "optional",
  },
  agent_change_proposal: {
    title: "调整这位智能体的工作安排",
    what: "智能体提出修改自己的职责、配置或工作规则。",
    whyOwner: "调整可能影响它以后的工作方式，需要你确认具体变化。",
    impact: "应用后会影响后续运行；不处理则继续沿用原配置。",
    decision: "查看改前改后的内容，决定应用还是拒绝。",
    category: "required",
  },
  watchlist_proposal: {
    title: "调整持续关注的股票名单",
    what: "智能体提出增加或移除自选股，供后续观察使用。",
    whyOwner: "这会改变后续智能体重点关注的对象。",
    impact: "应用后改变关注名单；这项名单调整本身不代表买卖指令。",
    decision: "查看新增、移除的对象及依据，决定是否接受。",
    category: "required",
  },
  insight_change_proposal: {
    title: "调整一项长期洞察",
    what: "智能体提出新增或修改用于后续理解信息的洞察配置。",
    whyOwner: "这会影响系统以后关注什么、如何整理信息。",
    impact: "通过后影响长期洞察；暂不处理则保留现有安排。",
    decision: "确认目标和具体改动，再决定是否应用。",
    category: "required",
  },
  loop_change_proposal: {
    title: "调整一项持续任务",
    what: "智能体建议修改持续任务的内容、运行安排或状态。",
    whyOwner: "这会影响任务后续何时运行、执行什么。",
    impact: "影响后续持续执行；请先看具体动作和变更范围。",
    decision: "确认任务、运行安排和权限变化，再决定是否接受。",
    category: "required",
  },
  memory_recall_change_plan: {
    title: "检查记忆整理的修改方案",
    what: "系统准备了一份改善记忆查找或整理方式的方案。",
    whyOwner: "需要确认方案是否符合你的意图；当前方案可能只是演练步骤。",
    impact: "确认演练方案不等于已经修改记忆；实际写入要以原详情中的执行回执为准。",
    decision: "查看方案涉及的记忆和证据，决定接受或拒绝。",
    category: "required",
  },
  memory_recall_governance_proposal: {
    title: "决定如何改善记忆使用",
    what: "系统提出一项记忆治理建议，处理查找、证据或时效方面的问题。",
    whyOwner: "后续可能形成长期记忆改动，需要确认治理方向。",
    impact: "确认方向不代表自动扩大记忆访问权限，也不等于已经改写记忆。",
    decision: "核对证据与建议方向，决定是否进入下一步方案。",
    category: "required",
  },
  memory_recall_quality: {
    title: "改善智能体查找记忆的效果",
    what: "系统发现记忆查找可能有遗漏、过时或证据不足的情况。",
    whyOwner: "这是改善建议；你可以先看它是否影响自己关心的任务。",
    impact: "暂不处理会保留现有查找方式。确认建议会形成后续治理提案，不会直接修改记忆。",
    decision: "查看具体问题，再决定是否推动一项改进。",
    category: "optional",
  },
  permission_boundary: {
    title: "一项操作被权限边界拦住了",
    what: "智能体尝试的操作触及当前权限限制，系统已留下待核对事项。",
    whyOwner: "需要核对目标、对象和允许范围；AI 建议不能解除权限限制。",
    impact: "未核对前，受限制的操作继续受原边界约束。不能把关闭提醒当作授权成功。",
    decision: "确认操作是否符合你的意图，再通过原详情处理。",
    category: "required",
  },
  service_error: {
    title: "一次工作遇到了执行问题",
    what: "工具或服务在执行中报告了错误，需要判断是否影响最终结果。",
    whyOwner: "先了解受影响的任务与是否已经恢复，再决定是否跟进。",
    impact: "关闭提醒不会修复服务或重跑任务；已恢复也需要有实际回执。",
    decision: "查看失败范围和恢复证据，决定继续排查还是关闭提醒。",
    category: "anomaly",
  },
  loop_blocker: {
    title: "一项持续任务无法继续",
    what: "持续任务当前处于阻塞或错误状态。",
    whyOwner: "需要确认缺少什么条件，以及是否影响正在等待的工作。",
    impact: "未解决阻塞前，任务可能无法按原安排继续；关闭提醒不会自动恢复运行。",
    decision: "查看阻塞原因、最近运行和下一步建议，决定如何恢复。",
    category: "anomaly",
  },
};

const memoryIssues: Record<string, { title: string; what: string }> = {
  missing_or_too_narrow: { title: "查找记忆时可能遗漏了相关资料", what: "系统的反馈记录提示，智能体找到的参考记忆可能不够完整，需要核对检索目标和查找范围。" },
  ranking_or_scope: { title: "参考记忆的选择顺序可能不合适", what: "系统的反馈记录提示，部分参考记忆与当前任务的相关性或排序可能有问题。" },
  freshness: { title: "参考记忆可能已经过时", what: "系统发现部分参考记忆存在时效问题，需要对照来源时间和新的事实判断是否仍适用。" },
  no_evidence_selected: { title: "参考记忆缺少可核验的来源", what: "记录中有被选中的记忆未附来源链接，需要核对对应记忆和原始来源，再判断它能否支持结论。" },
  trace_warnings: { title: "查找记忆时有异常提示", what: "智能体查找参考记忆时留下了异常提示，需要核对它是否影响这次任务的资料完整性。" },
  duplicate_canonical_groups: { title: "记忆查找中过滤了重复候选", what: "统计记录显示重复候选已被过滤；是否还需要整理记忆，要核对具体分组和过滤结果。" },
};
const reportIssues: Record<string, { title: string; what: string }> = {
  missing_final_markdown: { title: "补齐本次工作的完整汇报", what: "质量检查没有找到完整的最终汇报，建议明确以后需要提交的汇报内容。" },
  report_too_short: { title: "让汇报把工作情况说完整", what: "质量检查认为汇报内容偏少，建议补充判断依据和必要说明。" },
  missing_required_section: { title: "补上汇报中缺少的内容", what: "质量检查发现汇报缺少要求的内容段落，建议明确后续报告需要包含哪些部分。" },
  missing_tool_reasoning: { title: "说明为什么使用这些资料和工具", what: "质量检查发现汇报没有充分说明资料或工具与结论的关系，建议补上判断依据。" },
  tool_error_noise: { title: "让汇报说清错误有没有影响结果", what: "质量检查发现错误信息与最终结果混在一起，建议明确哪些问题已恢复、哪些仍影响工作。" },
  verification_gap: { title: "为汇报补上数据来源和核验依据", what: "质量检查发现结论与可核验依据之间存在缺口，建议补充来源或核验说明。" },
  boundary_language_risk: { title: "把汇报中的权限与执行状态说清楚", what: "质量检查发现汇报对操作边界或执行状态的表达可能不够清楚，建议据实际回执区分建议与已执行动作。" },
  formatting_gap: { title: "改善汇报的阅读顺序和格式", what: "质量检查认为汇报的结构或格式可以改善，建议让结论和关键依据更容易找到。" },
};

function plainChinese(value: string) {
  return /[\u3400-\u9fff]/u.test(value) && !/[A-Za-z_][A-Za-z0-9_]{2,}|[{}]|```/.test(value);
}

function investigation(kind: string, metadata: Record<string, unknown>) {
  const checks = {
    impact: "它关联哪项任务，是否有任务被阻塞或结果受到影响？",
    benefit: "建议改动具体能改善什么，有没有修改前后的对照依据？",
    evidence: "涉及哪个对象、哪次工作，能否找到对应的原始记录？",
    sideEffects: "具体会改动哪些对象，是否涉及发送、删除或权限变化，如何撤回？",
  };
  let nextStep = "建议由提出这件事的智能体先核对上述问题，整理具体方案后再交给你决定；当前尚未派发核查任务。";
  if (kind === "memory_recall_quality") {
    const issue = metadata.issueKind;
    checks.impact = "这些信号对应哪个智能体、哪次任务；有没有造成信息遗漏或结论错误？";
    checks.sideEffects = "整理时会合并、隐藏或改写哪些记忆，原始来源和恢复方式如何保留？";
    if (issue === "duplicate_canonical_groups") {
      checks.evidence = "被过滤的是哪些候选、属于哪个记忆分组；有没有误过滤需要保留的内容？";
      checks.benefit = "重复候选已经被过滤，进一步整理能减少什么问题；是否有整理前后的检索对照？";
    } else if (issue === "no_evidence_selected") {
      checks.evidence = "哪条记忆在哪次记录中缺少来源链接；原始来源是否存在且能够访问？";
      checks.benefit = "补齐来源后，哪些结论可以核验；是否仍有无法追溯的内容？";
    } else if (issue === "trace_warnings") {
      checks.evidence = "具体告警是什么、出现在哪次任务；后续是否已有恢复或成功回执？";
      checks.benefit = "这些告警是否反复出现，拟议修复能解决哪一个具体原因？";
    } else {
      checks.evidence = "找出相关记忆、原始来源和触发这条记录的任务，再核对是否遗漏、过时或选错资料。";
    }
    nextStep = "建议由记忆维护环节先查对应日志和来源，说明是否影响具体任务，再提出修改方案。你现在无需为这条系统诊断补交文档；当前尚未派发核查任务。";
  } else if (kind === "report_quality_config_proposal") {
    checks.evidence = "报告具体哪一段存在问题，原文和质量检查依据分别在哪里？";
    checks.benefit = "修改后的样例能否更清楚地说明结论、依据和工作结果？";
    nextStep = "建议让提交汇报的智能体提供有问题的段落和修改样例，你再按需要决定是否采用；当前尚未派发修改任务。";
  } else if (["agent_change_proposal", "loop_change_proposal", "insight_change_proposal"].includes(kind)) {
    checks.evidence = "修改对象和改前、改后的内容是否完整，提案依据是哪次运行？";
    nextStep = "建议由提出修改的智能体补齐变更对照、影响范围和恢复方式，你再审具体方案；当前配置仍以原审核状态为准。";
  }
  return { verificationQuestions: checks, nextStep };
}

/** Shared by the inbox and original detail panel; no model or database work. */
export function buildReviewAssistantItem(
  item: ReviewAssistantSourceItem,
  sourceEvent?: ReviewAssistantSourceEvent | null,
): ReviewAssistantItem {
  let explanation = explanations[item.kind] ?? {
    title: compact(item.title, 80) || "一项待确认事项",
    what: "智能体提交了一项待确认事项。",
    whyOwner: "目前没有可用的专用说明，需要先查看原始详情。",
    impact: "影响范围尚未确认。",
    decision: "核对来源与具体动作后再决定。",
    category: "required" as const,
  };
  const metadata = { ...record(item.metadata), ...record(sourceEvent?.metadata) };
  const mappedMemoryIssue = typeof metadata.issueKind === "string" ? memoryIssues[metadata.issueKind] : undefined;
  if (item.kind === "memory_recall_quality" && mappedMemoryIssue) explanation = { ...explanation, ...mappedMemoryIssue };
  const firstProblem = Array.isArray(metadata.problems) ? record(metadata.problems[0]) : {};
  const mappedReportIssue = typeof firstProblem.type === "string" ? reportIssues[firstProblem.type] : undefined;
  if (item.kind === "report_quality_config_proposal" && mappedReportIssue) explanation = { ...explanation, ...mappedReportIssue };
  const riskLevel = item.riskLevel === "low" || item.riskLevel === "medium" || item.riskLevel === "high" ? item.riskLevel : null;
  const category = explanation.category;
  const urgent = category === "required" || riskLevel === "high" || metadata.destructive === true;
  const problems = Array.isArray(metadata.problems) ? metadata.problems.map(problem => compact(record(problem).evidence)).filter(Boolean) : [];
  const summary = compact(item.summary?.split(/Proposed YAML patch:|```/i)[0]);
  const detail = problems[0] || summary;
  const understandableDetail = detail && plainChinese(detail) ? detail : "";
  const change = compact(firstProblem.suggestedChange, 180);
  const understandableChange = item.kind === "report_quality_config_proposal" && plainChinese(change) ? change : "";
  const evidence = [
    sourceEvent ? `来源记录：${compact(sourceEvent.title, 120)}` : "",
    detail ? `原记录说明：${detail}` : "",
  ].filter(Boolean);
  const missingInfo = [
    item.sourceEventId && !sourceEvent ? "原始事件暂时不可读取，当前只有待办摘要。" : "",
    !detail ? "当前记录没有提供足够的具体事实，请查看原详情。" : "",
  ].filter(Boolean);
  const knownFacts: string[] = [];
  if (item.kind === "memory_recall_quality") {
    const count = typeof metadata.issueCount === "number" && Number.isSafeInteger(metadata.issueCount) && metadata.issueCount >= 0 ? metadata.issueCount : null;
    if (count !== null) {
      knownFacts.push(metadata.issueKind === "duplicate_canonical_groups"
        ? `原待办记录了 ${count} 次重复候选被过滤，不能据此认定重复内容已被使用。`
        : metadata.issueKind === "no_evidence_selected"
          ? `原待办累计 ${count} 次所选记忆未附来源链接的信号，次数不等于不同记忆的条数。`
          : metadata.issueKind === "trace_warnings"
            ? `原待办累计 ${count} 条记忆查找告警信号，是否仍存在需要核对后续记录。`
            : `原待办记录了 ${count} 条记忆质量信号。`);
    }
    if (metadata.source === "memory_recall_quality_report" || record(metadata.observationScope).includesOtherWorkshops === true) {
      knownFacts.push("这条待办来自跨智能体的记忆质量抽样统计，挂在当前车间不代表当前任务受到影响。");
    }
    if (!metadata.periodSince || !metadata.generatedAt) {
      missingInfo.push("原待办未记录统计起止时间，需要回查报告对应的日志范围。");
    } else {
      knownFacts.push(`原统计范围：${compact(metadata.periodSince, 40)} 至 ${compact(metadata.generatedAt, 40)}。`);
    }
    const diagnostics = record(metadata.feedbackTraceDiagnostics);
    if (!(Array.isArray(diagnostics.runs) && diagnostics.runs.length) && !(Array.isArray(diagnostics.loops) && diagnostics.loops.length)) {
      missingInfo.push("原待办没有关联到具体任务，需要由记忆维护环节定位触发记录。");
    }
  }
  return {
    ...explanation, id: item.id, kind: item.kind, category,
    what: `${explanation.what}${understandableDetail ? ` 当前记录：${understandableDetail}` : ""}${understandableChange ? ` 建议：${understandableChange}` : ""}`,
    priority: urgent ? "first" : category === "optional" ? "later" : "normal",
    prioritySource: "rules",
    suggestion: missingInfo.length ? "need_evidence" : urgent ? "review" : category === "optional" ? "defer" : "review",
    reason: urgent ? "涉及工作安排、权限或重要风险，建议优先核对。" : category === "optional" ? "属于改进建议，可按你的关注点选择。" : "先核对是否影响结果，再决定是否跟进。",
    evidence, missingInfo, knownFacts, ...investigation(item.kind, metadata),
    sourceEventId: item.sourceEventId ?? null,
    sourceUpdatedAt: dateString(item.updatedAt ?? item.createdAt),
    riskLevel, aiAssisted: false,
  };
}

export function sortReviewAssistantItems(items: ReviewAssistantItem[]) {
  const order = { first: 0, normal: 1, later: 2 };
  return [...items].sort((a, b) => order[a.priority] - order[b.priority] || b.sourceUpdatedAt.localeCompare(a.sourceUpdatedAt) || a.id.localeCompare(b.id));
}
