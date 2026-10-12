import { platformRecordSemantics } from "./platform-record-semantics";

export const PLATFORM_STATISTICS_COUNTING_INSTRUCTION = "本成员是完整 owner 范围的分组查询，不是列表样本；只在本次范围内，缺席组可计零。NULL 表示未分类，具体数量见 unclassifiedCount（含零）。不能从有界列表外推总量，也不能把此查询扩成其他字段、时间或业务回执。保留来源状态原标签，不自行合并为‘有效’、‘待处理’或‘已成交’；这些业务分类需要另有定义及证据。委托数不是成交账本数，采集完成不等于验收。";

// Select existing dimensions, never new SQL or wider ownership. Ambiguous
// population requests retain the full catalog rather than silently dropping data.
const normalizeDimension = (source: string) => source.replaceAll("_", "").toLowerCase().replace(/^userllmapisettings\./, "modelconfiguration.");
/** Shared population vocabulary. A raw message noun alone is never a job. */
export const PLATFORM_PROCESSING_JOB_TOPIC_PATTERN = /interaction[_ ]?processing[_ ]?jobs|处理队列|处理任务|处理作业|消息理解作业|消息理解任务|理解作业|加工任务|加工作业/iu;
const statisticTopics: Array<[RegExp, readonly string[]]> = [
  [/workshop[_ ]heartbeats|车间心跳|心跳表|heartbeat.*(?:count|distribution|数量)/iu, ["workshop_heartbeats.scheduler_status", "workshop_heartbeats.count"]],
  [/\bworkshops?\b|车间/iu, ["workshops.status"]],
  [/\bloops?\b|持续任务/iu, ["loops.status"]],
  [/brain[_ ]memories|记忆|\bmemor(?:y|ies)\b/iu, ["brainMemories.status"]],
  [/canonical[_ ]kind|记忆.{0,8}(类型|类别)|memory.{0,12}(kind|type)/iu, ["brainMemories.canonicalKind"]],
  [/interaction[_ ]events|原始.{0,6}(交互|消息)|交互消息|微信消息/iu, ["interactionEvents.processedStatus"]],
  [PLATFORM_PROCESSING_JOB_TOPIC_PATTERN, ["interactionProcessingJobs.status"]],
  [/outbox|外发队列|发件箱|发送队列/iu, ["workshopOutbox.status"]],
  [/rag[_ ]documents|知识文档|知识库文档|资料.{0,8}(类型|数量)/iu, ["ragDocuments.contentType"]],
  [/model[_ ]configuration|user[_ ]llm[_ ]api[_ ]settings|模型配置/iu, ["modelConfiguration.enabled"]],
  [/harness[_ ]components|组件/iu, ["harnessComponents.componentType"]],
  [/harness[_ ]component[_ ]revisions|组件.{0,8}(版本|修订)/iu, ["harnessComponentRevisions.status"]],
  [/work[_ ]commands|控制命令|命令.{0,8}(数量|状态|分布)/iu, ["workCommands.status"]],
  [/evidence[_ ]bundles|证据包|证据束|采集.{0,8}(状态|数量|分布)/iu, ["workRunEvidenceBundles.captureStatus"]],
  [/paper[_ ]accounts|模拟.{0,6}账户/iu, ["paper_accounts.version"]],
  [/paper[_ ]orders|模拟.{0,6}(委托|订单)|委托.{0,8}(数量|状态|分布)/iu, ["paper_orders.status"]],
];

export function selectPlatformStatisticsSources(question: string | undefined, availableSources: readonly string[]) {
  const text = (question ?? "").replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  if (/(?:全部|所有)(?:平台)?记录|全平台|(?:全部|所有)(?:统计|聚合)?(?:维度|来源)|\ball (?:platform |owner |population )?(?:records|sources|dimensions|populations)\b/iu.test(text)) return [...availableSources];
  // A workshop's heartbeat table is a distinct observation, not its configuration.
  const withoutHeartbeatName = text.replace(/workshop[_ ]heartbeats|车间心跳/giu, "heartbeat");
  const wanted = new Set(statisticTopics.flatMap(([pattern, sources]) => pattern.test(withoutHeartbeatName) || (sources[0] === "workshop_heartbeats.scheduler_status" && pattern.test(text))
    ? sources.map(normalizeDimension) : []));
  return wanted.size ? availableSources.filter(source => wanted.has(normalizeDimension(source))) : [...availableSources];
}

/** Only the source adapter can attest that its query covered the full owner scope. */
export function platformStatisticsSemantics(input: {
  source: string;
  status: string;
  total?: unknown;
  groups?: unknown;
  fullOwnerGroupQuery: boolean;
  scope: "live_owner_read" | "frozen_owner_capture" | "bounded_sample";
}) {
  const groups = Array.isArray(input.groups) ? input.groups : undefined;
  const validCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const validGroupValues = groups !== undefined && groups.every(group => group && typeof group === "object" && !Array.isArray(group) && Object.hasOwn(group, "value")
    && ["string", "number", "boolean", "object"].includes(typeof group.value)
    && (group.value === null || typeof group.value !== "object")
    && (typeof group.value !== "number" || Number.isFinite(group.value)) && validCount(group.count));
  const groupKeys = validGroupValues ? groups.map(group => JSON.stringify([typeof group.value, group.value])) : [];
  const validGroups = validGroupValues && new Set(groupKeys).size === groups?.length;
  const complete = input.status === "ok" && input.fullOwnerGroupQuery && input.scope !== "bounded_sample"
    && validCount(input.total) && validGroups && groups.reduce((sum, group) => sum + group.count, 0) === input.total;
  return {
    schemaVersion: "platform-statistics-semantics.v1" as const,
    recordSemantics: platformRecordSemantics(input.source),
    counting: {
      scope: input.scope,
      coverage: input.status !== "ok" ? "unavailable" : complete ? "complete_owner_group_query" : "not_established",
      fieldCoverage: "selected_dimension_and_counts_only",
      absentGroupMeaning: complete ? "zero_within_this_read_scope" : "unknown",
      nullGroupMeaning: "unclassified",
      ...(complete ? { unclassifiedCount: groups.find(group => group.value === null)?.count ?? 0 } : {}),
      classificationScope: "source_dimension_values_only",
      instruction: complete
        ? PLATFORM_STATISTICS_COUNTING_INSTRUCTION
        : "Do not infer absent state counts from samples, unavailable sources or unverified aggregate coverage. NULL is unclassified; unavailable is not zero.",
    },
    answerCompleteness: "not_verified" as const,
  };
}

/** Share the identical complete-query prose once; retain every source-bound fact. */
export function platformStatisticsCollectionMember(semantics: ReturnType<typeof platformStatisticsSemantics>) {
  if (semantics.counting.coverage !== "complete_owner_group_query") return semantics;
  const { instruction, ...counting } = semantics.counting;
  return { ...semantics, schemaVersion: "platform-statistics-semantics.v2-collection" as const,
    counting: { ...counting, instructionRef: "collection.semanticsRules.completeOwnerGroupQuery" } };
}

export const PLATFORM_STATISTICS_COLLECTION_RULES = {
  completeOwnerGroupQuery: PLATFORM_STATISTICS_COUNTING_INSTRUCTION,
    instruction: "instructionRef refers to these rules in this same statistics collection. State the selected scope and NULL/unclassified count, including zero. Apply the complete-query rule only to members whose coverage is complete_owner_group_query; unavailable and unverified members keep their own warning.",
};

/** A quantity in one identified record is not a population-count request. */
export function needsPlatformPopulationStatistics(question: string) {
  if (!/多少|数量|分布|统计|心跳表|\bcounts?\b|\bdistribution\b|\baggregate\b|\btotal\b/i.test(question)) return false;
  const exactRecord = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i.test(question);
  return !exactRecord || /当前用户|全部记录|全平台|所有车间|owner[- ]wide|entire owner|all records/i.test(question);
}
