import type { PlatformFieldPageResult, PlatformFieldPageBinding } from "../platform-field-pages";
import type { EvidenceObservation, EvidenceTimePolicy } from "@/lib/memory/retrieval/evidence-time";
import type { AnswerEvidenceAuditEvent, FactResolution } from "./answer-evidence-contract";
import type { CoreReceipt } from "./answer-evidence-core";
import type { PlatformFieldReadBinding } from "../platform-read-handle-registry";
import type { MemoryReadBudgetSnapshot } from "../memory-read-budget";
import { PLATFORM_PROCESSING_JOB_TOPIC_PATTERN } from "../platform-statistics-semantics";
import { parsePlatformRequestedStateCounts, type PlatformRequestedStateCount, type PlatformStateBoundaryKind } from "./platform-requested-state-counts";
import type { projectMessageInterpretationAudit } from "./platform-message-interpretation";

export const PLATFORM_ANSWER_RULE_VERSION = "platform-compact-interpretation.v7";
export type PlatformAnswerMode = "off" | "shadow" | "enforce_supported";
export type PlatformAnswerKind = "run_outcome" | "workshop_run_outcome" | "message_identity" | "chat_identity" | "stored_status_distribution";
export type PlatformAnswerSource = "loopRuns" | "workshopRuns" | "loops" | "message" | "chat";
export type PlatformAnswerRequirement = {
  id: string; label: string; source: string; facet: "field" | "known_text" | "metric" | "boundary" | "interpretation";
  fieldKey?: string; subjectId?: string; linkedBy?: "loopId" | "chatId";
  metricRequest?: PlatformRequestedStateCount;
  boundaryKind?: PlatformStateBoundaryKind;
};
export type PlatformAnswerPlan = {
  schemaVersion: "platform-answer-contract.v1"; ruleVersion: typeof PLATFORM_ANSWER_RULE_VERSION;
  kind: PlatformAnswerKind; question: string;
  /** Explicitly requested captured instant. It must match host snapshot metadata. */
  requestedSnapshotAt?: string;
  subject?: { source: PlatformAnswerSource; id: string };
  statisticSources: string[]; requirements: PlatformAnswerRequirement[];
  /** Filled only by the host session from emitted, exact-source identity links. */
  finalAuthorizationSubjects?: Array<{ source: PlatformAnswerSource; id: string }>;
  readOnly: true;
};
export type PlatformFieldFact = {
  kind: "field"; source: PlatformAnswerSource; id: string; fieldKey: string; value: unknown;
  state: "supported" | "not_recorded"; observedAt: string; contentHash?: string;
  scope: "owner_exact_record" | "known_message_text";
  /** Exact core-committed page receipts used to derive this whole field. */
  retrievalEvidenceIds?: string[];
};
export type PlatformMetricFact = {
  kind: "metric"; source: string; total: number;
  groups?: Array<{ value: string | number | boolean | null; count: number }>;
  proofId: string; observation: EvidenceObservation; observedAt: string; scope: "owner_stored_status";
};
export type PlatformGapFact = {
  kind: "gap"; source: string; id?: string; fieldKey?: string; reason: string;
  state: "unknown" | "denied"; observedAt: string;
};
export type PlatformAnswerReceipt = CoreReceipt & {
  schemaVersion: "platform-answer-receipt.v1"; turnId: string; toolUseId: string;
  source: { name: "published_platform_adapter"; resultHash: string; receiptHash: string };
  authorization: { ownerId: string; policyHash: string; toolPolicyDecision: "allowed";
    decision: "allowed" | "denied" | "mixed" | "not_checked"; checkedAt: string };
  facts: Array<PlatformFieldFact | PlatformMetricFact | PlatformGapFact>;
  fieldPageReceipt?: PlatformFieldPageResult;
  readHandles?: Array<{ readHandle: string; source: string; id: string; fieldKey: string; parentContentHash: string }>;
};
export type PlatformAnswerCoverage = { supported: number; notRecorded: number; unknown: number; denied: number; total: number };
export type PlatformAnswerDecision = {
  schemaVersion: "platform-answer-decision.v1"; mode: PlatformAnswerMode;
  contractKind: PlatformAnswerKind; ruleVersion: string; runtimeHash: string;
  outcome: "supported_fields" | "partial" | "unknown" | "execution_failed" | "unchecked";
  resolutions: FactResolution[]; questionComplete: boolean; evidenceCoverage: PlatformAnswerCoverage;
  renderedText: string; rawDraftHash: string; renderedTextHash: string;
  candidateDisplayText?: string; candidateDisplayTextHash?: string;
  auditPersisted: boolean; auditIncomplete: boolean;
  /** Hashes/check states only. Model interpretation never becomes a field receipt. */
  interpretationAudit?: ReturnType<typeof projectMessageInterpretationAudit>;
  evidenceRefs: Array<{ evidenceId: string; observedAt: string; status: string; source?: string;
    scope?: "owner_exact_record" | "owner_stored_status" | "known_message_text" | "exact_context" }>;
};
export type PlatformAnswerSessionOptions = {
  mode: PlatformAnswerMode; turnId: string; ownerId: string; runtimeHash: string; policyHash: string; question: string;
  auditSink?: (event: AnswerEvidenceAuditEvent) => Promise<unknown>;
  authorizeFinal?: (plan: PlatformAnswerPlan) => Promise<boolean>; now?: () => Date;
  /** Trusted host-only final owner/version recheck; never model arguments. */
  authorizeFieldPageFinal?: (binding: PlatformFieldPageBinding) => Promise<boolean>;
  resolveFieldPageReadHandle?: (handle: string) => PlatformFieldReadBinding;
  timePolicy?: EvidenceTimePolicy;
  /** Host manifest metadata, never a historical validity interval. */
  snapshotAt?: string;
  /** Optional P3. Registry resolution and budget observation remain host-owned. */
  readonlyContinuation?: {
    enabled: true;
    resolveReadHandle: (handle: string) => PlatformFieldReadBinding;
    readBudgetSnapshot: () => MemoryReadBudgetSnapshot | undefined;
  };
};

const uuidPattern = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu;
/** Fixed aliases are an adapter vocabulary; arbitrary model table names are rejected. */
export function canonicalPlatformAnswerSource(value: string): PlatformAnswerSource | null {
  const normalized = value.trim().toLowerCase();
  return ["loopruns", "loop_runs"].includes(normalized) ? "loopRuns" : ["workshopruns", "workshop_runs"].includes(normalized) ? "workshopRuns" : normalized === "loops" ? "loops"
    : ["message", "messagev2", "message_v2", "chatmessages", "chat_messages"].includes(normalized) ? "message" : normalized === "chat" ? "chat" : null;
}
export function platformAnswerContractKind(question: string) { return selectPlatformAnswerContract(question)?.kind ?? null; }

/** Quoted source names and IDs are evidence text, not the requested object. */
function unquotedQuestionText(question: string): string {
  return question.replace(/```[\s\S]*?```|"[^"\r\n]*"|'[^'\r\n]*'|“[^”]*”|‘[^’]*’|`[^`]*`/gu,
    text => text.replace(/[^\r\n]/g, " "));
}

/** An unknown/malformed explicit object must not fall through to a nearby noun. */
function originalQuestionObject(question: string): {
  question: string; routingQuestion: string; subject?: { source: PlatformAnswerSource; id: string };
} | null {
  const routingQuestion = unquotedQuestionText(question).trimEnd();
  const markers = [...routingQuestion.matchAll(/对象[：:]/gu)];
  if (!markers.length) return { question, routingQuestion };
  const suffix = /(?:^|\n)[ \t]*对象：([A-Za-z][A-Za-z0-9_]*)（记录[ \t]+([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})）[ \t]*$/iu.exec(routingQuestion);
  if (markers.length !== 1 || !suffix) return null;
  const source = canonicalPlatformAnswerSource(suffix[1]);
  if (!source) return null;
  const body = routingQuestion.slice(0, suffix.index);
  const mentionedSources = [...body.matchAll(/\b(?:loop_runs|loopRuns|workshop_runs|workshopRuns|loops|message_v2|messagev2|message|chat_messages|chatMessages|chat)\b/giu)]
    .map(match => ({ source: canonicalPlatformAnswerSource(match[0]),
      exactObject: /^[ \t]+[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/iu.test(body.slice(match.index + match[0].length)) }));
  const linkedSourceAllowed = (mentioned: PlatformAnswerSource | null) => mentioned === source
    || (source === "message" && mentioned === "chat" && /所属|出自|关联|哪个|which.*chat|chat.*title/iu.test(body))
    || (source === "loopRuns" && mentioned === "loops" && /任务|所属|属于|关联|目标|名称|goal|name|triggerConfig/iu.test(body));
  if (mentionedSources.some(mentioned => mentioned.source !== source && (mentioned.exactObject || !linkedSourceAllowed(mentioned.source)))) return null;
  return { question: question.slice(0, suffix.index), routingQuestion: body, subject: { source, id: suffix[2].toLowerCase() } };
}

/** Parse only the host original question. Tool paraphrases cannot remove obligations. */
export function selectPlatformAnswerContract(question: string): PlatformAnswerPlan | null {
  if (!question.trim() || question.length > 12_000) return null;
  const originalQuestion = question;
  const mutation = "(?:暂停|停止|取消|启动|恢复|重启|删除|修改|更新|调整|重跑|发送|通知|关闭|上线|发布|禁用|启用|下单|创建|新增|添加|保存|重命名|移动|移除|清空|归档|提交|批准|授权|点击|点确认|上传|支付|购买|运行一次|跑一次|执行(?:动作|命令|操作|修改|一次)|确认(?:修改|提交|批准|取消|按钮))";
  const imperative = new RegExp(String.raw`(?:^|[，,。.;；\n])\s*${mutation}|(?:请|帮我|替我|为我|先|然后|再|并(?:且)?|而且|以及|且|随后|接着|同时|立即|直接|把|查看|读取|查询|核对).{0,100}${mutation}|\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\s*${mutation}|\b(?:pause|stop|cancel|start|resume|restart|delete|modify|update|send|notify|approve|disable|enable|publish|click|change|edit|configure|set|create|add|save|rename|move|remove|submit|archive|upload|pay|buy)\b`, "iu");
  if (imperative.test(question)) return null;
  // Only this fixed source wrapper is grammar metadata. Keep the original
  // question and its requested instant; a host manifest must still match it.
  const snapshotWrapper = /^\s*在随题提供(?:的)?只读(?:数据)?快照[（(]\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))\s*[）)]中[，,]?\s*(?:针对所选关联记录[，,：:]?\s*)?/u.exec(question);
  // Only these finite captured-source prefixes are metadata. A canonical UTC
  // instant is required; the renderer still binds it to the host snapshotAt.
  const capturedPrefix = /^\s*(?:在\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s*的随题只读快照里[，,]?|查看\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s*的随题只读快照中[，,]?|截至\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s*的随题只读快照[，,]|请根据时间为\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s*的随题只读快照[，,])\s*/u.exec(question);
  const capturedPrefixHint = /^\s*(?:在|查看|截至|请根据时间为)[^\r\n，,。;；]{0,96}的随题只读快照/u.test(question);
  if (capturedPrefixHint && !capturedPrefix) return null;
  const capturedInstant = capturedPrefix?.slice(1).find(value => value !== undefined);
  if (capturedInstant && (!Number.isFinite(Date.parse(capturedInstant)) || new Date(capturedInstant).toISOString() !== capturedInstant)) return null;
  let requestedSnapshotAt: string | undefined;
  if (snapshotWrapper && Number.isFinite(Date.parse(snapshotWrapper[1]))) {
    requestedSnapshotAt = new Date(snapshotWrapper[1]).toISOString();
    question = question.slice(snapshotWrapper[0].length);
  }
  if (!snapshotWrapper && capturedPrefix && capturedInstant) {
    requestedSnapshotAt = capturedInstant;
    question = question.slice(capturedPrefix[0].length);
  }
  if (/截至|当时|昨天|明天|历史区间|历史快照|评测快照|\bas\s+of\b|\byesterday\b/iu.test(question)) return null;
  const object = originalQuestionObject(question);
  if (!object) return null;
  question = object.question;
  const routingQuestion = object.routingQuestion;
  const ids = [...new Set([...(routingQuestion.match(uuidPattern)?.map(id => id.toLowerCase()) ?? []), ...(object.subject ? [object.subject.id] : [])])];
  const matchesSource = (source: PlatformAnswerSource, vocabulary: RegExp) => object.subject
    ? object.subject.source === source : vocabulary.test(routingQuestion);
  const requirements: PlatformAnswerRequirement[] = [];
  let stateGrammarQuestion: string | undefined;
  const add = (source: string, fieldKey: string, label: string, subjectId?: string, linkedBy?: "loopId" | "chatId") => {
    const id = `${source}.${fieldKey}`;
    if (!requirements.some(item => item.id === id)) requirements.push({ id, source, fieldKey, label, facet: "field", ...(subjectId ? { subjectId } : {}), ...(linkedBy ? { linkedBy } : {}) });
  };
  const boundary = (id: string, label: string, source: string) => requirements.push({ id, label, source, facet: "boundary" });
  // Consume only exact stored start/end timestamp clauses. Durations, future
  // runs, arbitrary history and unrelated temporal claims remain residuals.
  const runTimingPattern = /(?:何时|什么时候)开始(?:和|与|及|、)结束|开始(?:和|与|及|、)结束时间|(?:何时|什么时候)开始|(?:何时|什么时候)结束|开始时间|结束时间|开始于|结束于|\b(?:startedAt|completedAt)\b/giu;
  const withoutRunTiming = (text: string) => text.replace(runTimingPattern, "");
  const preserveUnsupportedClauses = (source: string) => {
    const clauseQuestion = source === "loopRuns" ? withoutRunTiming(question) : source === "workshopRuns"
      ? question.replace(/关联车间|哪个车间|所属车间/gu, "") : question;
    if (/耗时|时长|持续多久|什么时候|何时|时间|起止|开始于|结束于|审核|审批|参与(?:者|人)|成员|多少条|多少人|多少钱|数量|关联车间|哪个车间|模型|费用|成本|附件|图片|图像|文件|非文本|推理|工具|全部字段|所有字段|原始记录完整|执行轨迹|日志|token|duration|timestamp|participants?|approval|how\s+(?:long|many)|\b(?:when|time|date|trace|tool|reasoning|image|file)\b/iu.test(clauseQuestion))
      boundary("unassessed_clause", "原问中未支持的时间、数量或其它问项", source);
    if (/分析|根因|真实原因|为什么.*(?:失败|错误)|故障原因|root\s*cause/iu.test(question)) boundary("unassessed_causal_claim", "原因分析", source);
    if (/准确|正确|真实吗|可信|确认真实|independent|accurate|correct|trustworthy/iu.test(question)) boundary("independent_truth_verification", "独立真实性验证", source);
  };
  const base = (kind: PlatformAnswerKind, subject?: PlatformAnswerPlan["subject"], statisticSources: string[] = []): PlatformAnswerPlan => {
    const fieldHints: Array<[RegExp, string[]]> = [
      [/目标|目的|\b(?:goal|purpose)\b/iu, ["loops.goal"]],
      [/名称|名字|叫什么|\bname\b/iu, ["loops.name", "chat.title"]],
      [/产物|产出|输出|摘要|\b(?:output|summary)\b/iu, ["loopRuns.outputSummary", "workshopRuns.outputSummary"]],
      [/验证|核验|验收|\b(?:verification|acceptance)\b/iu, ["loopRuns.verificationResult"]],
      [/正文|原文|文本|表达|含义|意思|解读|\b(?:content|text|meaning|express(?:es|ed)?|convey(?:s|ed)?)\b/iu, ["message.known_text", "message.parts", "loopRuns.outputSummary", "specific_raw_event", "raw_content_completeness"]],
      [/角色|\brole\b/iu, ["message.role"]], [/标题|\btitle\b/iu, ["chat.title"]],
      [/\bparts\b/iu, ["message.parts"]],
      [/配置|\b(?:config|configuration|triggerConfig)\b/iu, ["loops.triggerConfig"]],
    ];
    if (fieldHints.some(([hint, ids]) => hint.test(question) && !requirements.some(requirement => ids.includes(requirement.id)))
      && !requirements.some(item => item.id === "unassessed_clause")) boundary("unassessed_clause", "原问包含尚未映射的字段问项", subject?.source ?? statisticSources[0]);
    // The bounded grammar has an explicit residual. Matching a source noun or
    // one field never certifies arbitrary remaining natural-language clauses.
    let grammarQuestion = stateGrammarQuestion ?? question;
    if (kind === "run_outcome" && subject?.source === "loopRuns") grammarQuestion = withoutRunTiming(grammarQuestion).replace(/为什么开始|为何开始/gu, "");
    if (kind === "workshop_run_outcome") grammarQuestion = grammarQuestion.replace(/记录是否说明了|具体怎样写的|原记录|关联车间|哪个车间|所属车间/gu, "");
    if (requirements.some(item => item.id === "paper_order_fill_ledger")) grammarQuestion = grammarQuestion.replace(/模拟委托|模拟订单|纸面订单|区分|区别|委托|订单|成交|交易|真实|\b(?:fills?|executions?)\b/giu, "");
    if (requirements.some(item => item.id === "processing_failure_not_disappearance")) grammarQuestion = grammarQuestion.replace(/失败作业不等于消息消失|加工失败不等于消息消失/gu, "");
    if (requirements.some(item => item.id === "source_lifecycle_history")) grammarQuestion = grammarQuestion.replace(/历史|生命周期/gu, "");
    if (requirements.some(item => item.id === "business_effective_count")) grammarQuestion = grammarQuestion.replace(/不能当作|不能视为|不能代表|不等于|有效记忆量|记忆量/gu, "");
    if (kind === "message_identity") {
      // An archived message is an exact record object, not a request to infer
      // its historical timeline. Explicit as-of/history intervals still fail
      // the temporal boundary above; roles and decisions keep their obligations.
      grammarQuestion = grammarQuestion.replace(/实际历史聊天消息|历史聊天消息|历史消息记录|历史消息|聊天消息|出自|它/gu, "");
      if (requirements.some(item => item.id === "original_user_decision")) grammarQuestion = grammarQuestion.replace(/用户已经作出的|用户作出的|已经作出的|明确包含|用户|作出/gu, "");
    }
    grammarQuestion = grammarQuestion.replace(/对象[：:]?/gu, "");
    if (kind === "stored_status_distribution") grammarQuestion = grammarQuestion.replace(/生命周期状态|消息理解作业|消息理解任务|理解作业|加工作业|处理作业|当前用户|作业|各|条|笔|等|个/gu, "");
    const remainder = (requirements.some(item => item.id === "specific_raw_event") ? grammarQuestion.replace(/是否存在|存在吗|存在|可读取/gu, "") : grammarQuestion).replace(uuidPattern, "")
      .replace(/\b(?:loop[_ ]?runs?|loops?|runId|chat[_ ]?messages?|message[_ ]?v2|messages?|chats?|brain[_ ]?memories|interaction[_ ]?processing[_ ]?jobs|interaction[_ ]?events|paper[_ ]?orders|workshop[_ ]?runs?|workshop[_ ]?outbox|workshop[_ ]?heartbeats|workshops?|workshopId|status|outputSummary|verificationResult|triggerReason|triggerConfig|chatId|parts|textParts|known_text)\b/giu, "")
      .replace(/(?:运行记录|运行批次|本次运行|这次运行|触发配置|触发条件|触发原因|输出摘要|验证结果|关联任务|所属聊天|聊天名称|聊天标题|原始交互消息|原始消息|原始事件|原始正文|处理队列|处理任务|加工任务|模拟委托|模拟订单|纸面订单|外发队列|发信队列|心跳记录|持续任务|车间|脑记忆|记忆|消息记录|原消息|消息|聊天|对话|任务|运行|记录|名称|名字|叫什么|目标|目的|触发|配置|状态|结果|产物|产出|输出|摘要|验证|核验|验收|效果|实质|生效|成功|完成|错误|失败|原因|内容|正文|文本|角色|标题|决定|决策|同意|确认|批准|数量|总数|计数|条数|分布|统计|有效|可用|读取|读完|读|未记录|没记录|未读|空值|未知|不确定|发布|存储|数据库|完整|原始|字段|所有|全部|已知|实际|当前|目前|现在|最新|最近|本轮|本次|这次|这条|这个|该|此|具体|详细|逐项|分别|展开|到底|已经|是否|有没有|是什么|哪些|哪个|怎么|怎样|如何|为什么|为何|多少|什么|表达了|表达|含义|意思|解读|说了|讲了|谈什么|做了|所属|属于|关联|是不是|如果|若|给我|告诉我|帮我|帮忙|查看|检查|查询|核对|请|说明|回答|显示|保留|以及|并且|还有|其中|对照|只|仅|按|有|为|是|在|从|中|里|的|和|与|及|或|我|吗|呢)/gu, "")
      .replace(/\b(?:what|which|how|why|is|are|was|were|does|did|has|have|the|this|that|it|a|an|of|in|to|from|for|and|or|my|me|please|read|show|tell|check|current|now|stored|recorded|complete|whole|known|text|content|express(?:es|ed)?|convey(?:s|ed)?|role|title|task|name|goal|purpose|trigger|reason|config|configuration|output|summary|result|outcome|verification|acceptance|success|effective|error|failure|decision|count|distribution|total|only|null|unknown|id)\b/giu, "")
      .replace(/[\s，,。.;；:：?？!！、()（）\[\]【】"'“”‘’\/\\_-]/gu, "");
    if (remainder && !requirements.some(item => item.id === "unassessed_clause")) boundary("unassessed_clause", "原问中未映射到当前发布字段的问项", subject?.source ?? statisticSources[0]);
    return { schemaVersion: "platform-answer-contract.v1", ruleVersion: PLATFORM_ANSWER_RULE_VERSION, kind, question: originalQuestion,
      ...(requestedSnapshotAt ? { requestedSnapshotAt } : {}), ...(subject ? { subject } : {}), statisticSources, requirements, readOnly: true };
  };
  const exactSubjectVocabulary = /workshop[_ ]?runs?|loop[_ ]?runs?|runId|运行记录|运行批次|本次运行|这次运行|chat[_ ]?messages?|\bmessage(?:[_ ]?v2)?\b|消息记录|这条消息|原消息|\bchat\b|聊天|对话|\bloops?\b|持续任务/iu;
  const specificRawEvent = !object.subject && ids.length === 1 && /interaction[_ ]?events?|原始事件|原始消息/iu.test(routingQuestion) && !exactSubjectVocabulary.test(routingQuestion);
  if ((ids.length === 0 || specificRawEvent) && /多少|数量|分布|统计|总数|计数|条数|\b(?:count|distribution|total)\b/iu.test(routingQuestion)) {
    // Document statistics are outside this contract. An ancillary workshop
    // noun cannot replace that explicit count, including a mixed-source query.
    const documentSource = String.raw`(?:知识库文档|RAG\s*文档|\brag(?:[_ ]documents?|\s+docs?)\b)`;
    const documentCount = new RegExp(String.raw`${documentSource}[^。.;；!?！？\n]{0,80}(?:多少|数量|总数|计数|条数|分布|统计|\b(?:count|distribution|total)\b)|(?:多少|几)\s*(?:份|个)?\s*${documentSource}`, "iu");
    if (documentCount.test(routingQuestion)) return null;
    const sources: string[] = [];
    const choose = (test: RegExp, source: string, label: string) => {
      if (!test.test(routingQuestion)) return;
      sources.push(source); requirements.push({ id: source, source, label, facet: "metric" });
    };
    choose(/brain[_ ]?memories|脑记忆|记忆/iu, "brain_memories.status", "存储记忆状态分布");
    choose(PLATFORM_PROCESSING_JOB_TOPIC_PATTERN, "interaction_processing_jobs.status", "处理任务存储状态分布");
    choose(/interaction[_ ]?events|原始交互消息|原始消息|原始事件/iu, "interaction_events.processed_status", "原始事件处理状态分布");
    choose(/paper[_ ]?orders|模拟委托|模拟订单|纸面订单/iu, "paper_orders.status", "模拟委托存储状态分布");
    choose(/workshop[_ ]?outbox|外发队列|发信队列/iu, "workshop_outbox.status", "外发队列存储状态分布");
    choose(/workshop[_ ]?heartbeats|心跳记录/iu, "workshop_heartbeats.scheduler_status", "心跳记录调度状态分布");
    choose(/\bloops?\b|持续任务/iu, "loops.status", "Loop 配置状态分布");
    choose(/\bworkshops?\b|车间/iu, "workshops.status", "车间配置状态分布");
    if (!sources.length || sources.length > 4) return null;
    if (specificRawEvent) requirements.push({ id: "specific_raw_event", label: "指定原始事件及其原文", source: "interaction_events", subjectId: ids[0], facet: "boundary" });
    if (/有效|生效|可用记忆|可使用|effectiv|usable/iu.test(question)) boundary("business_effective_count", "实际有效数量", sources[0]);
    if (/正在处理|执行器|worker|是否运行|是否活跃|卡住|阻塞/iu.test(question)) boundary("current_worker_activity", "当前执行器活动", sources[0]);
    if (/原文|原始正文|完整原始/iu.test(question)) boundary("raw_content_completeness", "原始正文完整性", sources[0]);
    if (sources.includes("paper_orders.status") && /(?:区分|区别|实际|真实).*(?:成交|交易)|(?:成交|交易).*(?:委托|订单)|\b(?:fills?|executions?)\b/iu.test(question)) boundary("paper_order_fill_ledger", "委托与实际成交的区别", "paper_orders.status");
    if (sources.includes("interaction_processing_jobs.status") && /(?:失败|错误).*(?:消失|丢失|不存在)|(?:消失|丢失|不存在).*(?:失败|错误)/iu.test(question)) boundary("processing_failure_not_disappearance", "处理失败与原始消息存续", "interaction_processing_jobs.status");
    if (/历史|生命周期(?:变化|变迁|历程|过程)|状态(?:变化|变迁|转换)|时间线|\b(?:timeline|transitions?|historical)\b/iu.test(question)) boundary("source_lifecycle_history", "来源历史或生命周期", sources[0]);
    if (/今天|本周|本月|时间|期间|窗口|新增|删除|过期|选中过|调用过|命中|实际使用|分类|类型分布|canonical[_ ]?kind|准确|正确|列出|列表|全部内容|\b(?:selected|used|window|since|list)\b/iu.test(question)) boundary("unassessed_clause", "原问中未支持的期间、分类或其它问项", sources[0]);
    const states = parsePlatformRequestedStateCounts(question, sources, Math.max(0, 60 - requirements.length));
    requirements.push(...states.requirements.map(item => ({ ...item, facet: "metric" as const })), ...states.boundaries.map(item => ({ ...item, facet: "boundary" as const })));
    stateGrammarQuestion = states.grammarQuestion;
    if (states.unassessed && !requirements.some(item => item.id === "unassessed_clause")) boundary("unassessed_clause", "原问中尚未解析或超过本轮数量限制的状态问项", sources[0]);
    return base("stored_status_distribution", undefined, sources);
  }
  if (ids.length !== 1) return null;
  const id = ids[0];
  // An explicitly named workshop run owns this source contract. A generic
  // "运行记录" noun must never turn it into a Loop run with the same UUID.
  if (matchesSource("workshopRuns", /\bworkshop[_ ]?runs?\b/iu)) {
    // This adapter answers published outcomes. A diagnosis-only request for
    // failure categories or a causal evidence package is a different object.
    if (!/状态|结果|产物|产出|输出|摘要|错误|失败原因|是否[^。；;？?]*失败|关联车间|哪个车间|所属车间|\b(?:status|outcome|output|summary|error|workshopId)\b/iu.test(question)) return null;
    preserveUnsupportedClauses("workshopRuns");
    add("workshopRuns", "status", "车间运行存储状态", id);
    if (/结果|产物|产出|输出|摘要|做了|完成了|成功|生效|outcome|output|summary|success/iu.test(question)) add("workshopRuns", "outputSummary", "车间运行结果原记录", id);
    if (/错误|失败|原因|为什么|error|fail|why/iu.test(question)) add("workshopRuns", "error", "车间运行错误原记录", id);
    if (/关联车间|哪个车间|所属车间|\bworkshopId\b|\bworkshop\s+id\b/iu.test(question)) add("workshopRuns", "workshopId", "关联车间 ID", id);
    if (/实质|成功|生效|完成了吗|有没有完成|外部.*(?:成功|生效)|修复|恢复|后来|之后|下一次|success|effective|recovery/iu.test(question)) boundary("business_or_later_outcome", "实质效果或后续恢复", "workshopRuns");
    return base("workshop_run_outcome", { source: "workshopRuns", id });
  }
  if (matchesSource("loopRuns", /loop[_ ]?runs?|runId|运行记录|运行批次|本次运行|这次运行/iu)) {
    preserveUnsupportedClauses("loopRuns");
    add("loopRuns", "status", "运行记录状态", id);
    if (/结果|产物|产出|输出|摘要|做了|完成了|成功|生效|outcome|output|summary|success/iu.test(question)) add("loopRuns", "outputSummary", "运行结果原记录", id);
    if (/验证|验收|效果|实质|生效|成功|执行轨迹|trace|verification|effective|acceptance/iu.test(question)) add("loopRuns", "verificationResult", "验证结果原记录", id);
    if (/错误|失败|原因|为什么|error|fail|why/iu.test(question)) add("loopRuns", "error", "错误原记录", id);
    if (/触发|为什么执行|为什么开始|为何开始|trigger/iu.test(question)) add("loopRuns", "triggerReason", "本次触发原因原记录", id);
    if (/(?:何时|什么时候)开始|开始(?:和|与|及|、)结束时间|开始时间|开始于|\bstartedAt\b/iu.test(question)) add("loopRuns", "startedAt", "运行开始时间原记录", id);
    if (/(?:何时|什么时候)结束|(?:何时|什么时候)开始(?:和|与|及|、)结束|开始(?:和|与|及|、)结束时间|结束时间|结束于|\bcompletedAt\b/iu.test(question)) add("loopRuns", "completedAt", "运行结束时间原记录", id);
    if (/任务|名称|名字|叫什么|目标|目的|name|goal|purpose/iu.test(question)) {
      add("loopRuns", "loopId", "关联 Loop ID", id);
      if (/任务|名称|名字|叫什么|name/iu.test(question)) add("loops", "name", "关联任务当前名称", undefined, "loopId");
      if (/任务|目标|目的|goal|purpose/iu.test(question)) add("loops", "goal", "关联任务当前目标", undefined, "loopId");
    }
    if (/触发配置|怎么触发|触发条件|trigger\s*config/iu.test(question)) { add("loopRuns", "loopId", "关联 Loop ID", id); add("loops", "triggerConfig", "关联任务当前触发配置", undefined, "loopId"); }
    if (/实质|成功|生效|完成了吗|有没有完成|外部.*(?:成功|生效)|修复|恢复|后来|之后|下一次|current.*running|success|effective|recovery/iu.test(question)) boundary("business_or_later_outcome", "实质效果或后续恢复", "loopRuns");
    return base("run_outcome", { source: "loopRuns", id });
  }
  if (matchesSource("message", /chat[_ ]?messages?|message(?:[_ ]?v2)?|消息记录|这条消息|原消息/iu)) {
    preserveUnsupportedClauses("message");
    add("message", "role", "消息角色", id); add("message", "chatId", "所属聊天 ID", id);
    if (/内容|正文|原文|文本|说了|是什么|讲了|谈什么|表达|含义|意思|解读|决定|决策|text|content|\b(?:say|said|meaning|decision|express(?:es|ed)?|convey(?:s|ed)?)\b/iu.test(question)) requirements.push({ id: "message.known_text", source: "message", subjectId: id, label: "已识别文本段的完整原文", facet: "known_text" });
    if (/说了|讲了|谈什么|表达|含义|意思|解读|\b(?:say|said|meaning|express(?:es|ed)?|convey(?:s|ed)?)\b/iu.test(question)) requirements.push({ id: "message.interpretation", source: "message", subjectId: id, label: "消息的具体解读", facet: "interpretation" });
    if (/哪个聊天|哪个对话|什么(?:聊天|对话)|聊天名称|聊天标题|标题|哪段对话|which.*chat|chat.*title/iu.test(question)) add("chat", "title", "所属聊天标题", undefined, "chatId");
    if (/决定|决策|同意|确认|批准|decision|approve/iu.test(question)) boundary("original_user_decision", "是否为用户的明确决定", "message");
    if (/完整消息|原始记录完整|所有.*(?:part|字段)|raw.*complete/iu.test(question)) add("message", "parts", "完整发布 parts", id);
    return base("message_identity", { source: "message", id });
  }
  if (matchesSource("chat", /\bchat\b|聊天|对话/iu)) { preserveUnsupportedClauses("chat"); add("chat", "title", "聊天标题", id); return base("chat_identity", { source: "chat", id }); }
  if (matchesSource("loops", /\bloops?\b|持续任务/iu)) {
    preserveUnsupportedClauses("loops");
    add("loops", "status", "任务配置状态", id);
    if (/名称|名字|叫什么|什么任务|name/iu.test(question)) add("loops", "name", "任务名称", id);
    if (/目标|目的|做什么|什么任务|goal|purpose/iu.test(question)) add("loops", "goal", "任务目标", id);
    if (/触发|trigger/iu.test(question)) add("loops", "triggerConfig", "触发配置", id);
    if (/当前.*(?:运行|执行)|现在.*(?:运行|执行)|心跳|租约|阻塞|running|heartbeat/iu.test(question)) return null;
    if (/结果|成功|效果|生效|验证|历史|why|为什么/iu.test(question)) return null;
    return base("run_outcome", { source: "loops", id });
  }
  return null;
}
