import { createHash } from "node:crypto";
import { PLATFORM_PROCESSING_JOB_TOPIC_PATTERN } from "../platform-statistics-semantics";

export type PlatformRequestedStateCount = {
  kind: "dimension_value"; requestedLabel: string; value: string | null;
};
export type PlatformStateBoundaryKind = "waiting_definition" | "runnable_job_count";
type StateRequirement = { id: string; source: string; label: string; metricRequest: PlatformRequestedStateCount };
type StateBoundary = { id: string; source: string; label: string; boundaryKind: PlatformStateBoundaryKind };
const jobSource = "interaction_processing_jobs.status";
const rawEventSource = "interaction_events.processed_status";
const sourceTopics: Array<[string, RegExp]> = [
  [jobSource, PLATFORM_PROCESSING_JOB_TOPIC_PATTERN],
  ["brain_memories.status", /brain[_ ]?memories|脑记忆|记忆/iu],
  ["interaction_events.processed_status", /interaction[_ ]?events|原始交互消息|原始消息|原始事件/iu],
  ["paper_orders.status", /paper[_ ]?orders|模拟委托|模拟订单|纸面订单/iu],
  ["workshop_outbox.status", /workshop[_ ]?outbox|外发队列|发信队列/iu],
  ["workshop_heartbeats.scheduler_status", /workshop[_ ]?heartbeats|心跳记录/iu],
  ["loops.status", /\bloops?\b|持续任务/iu],
  ["workshops.status", /\bworkshops?\b|车间/iu],
];
const countQuestion = /多少|数量|计数|条数|总数|\b(?:counts?|how\s+many)\b/iu;
const negativePrefix = /(?:尚未|并非|不是|未|没|不|非|not|!=|不等于)[\s（(]*["'`]?[\s（(]*$/iu;
const narrativePrefix = /(?:之前|之后|以前|以后|曾经|可能|将|会|导致|表示|证明|before|after|will|may|might|said|says)\s*$/iu;
const waitingDefinitionPattern = /等待\s*(?:=|指|定义为|按)\s*(?:原始\s*)?(?:status\s*=\s*)?(?:"pending"|'pending'|`pending`|pending)(?:\s*口径)?/giu;
const sameDimension = (source: string, field: string) => source.split(".").at(-1)?.replaceAll("_", "").toLowerCase() === field.replaceAll("_", "").toLowerCase();
const sourceId = (source: string, value: string | null) => `${source}:state:${createHash("sha256").update(JSON.stringify([typeof value, value])).digest("hex")}`;
const countTargetSuffix = /^(?:\s*(?:[,，、/]|和|与|及)|\s*(?:等)?(?:状态|作业|任务|记录)?\s*(?:各|分别)?(?:有|的)?\s*(?:多少|数量|计数|条数|总数)|\s+(?:and|or|counts?|count)\b)/iu;

/** This finite host grammar creates obligations, never counts or scope proofs.
 * Source labels remain an open set; only explicitly requested values are added.
 * Natural-language aliases are registered per source, not shared globally. */
export function parsePlatformRequestedStateCounts(question: string, sources: readonly string[], maximumAdditional = 48) {
  const requirements: StateRequirement[] = [], boundaries: StateBoundary[] = [];
  const spans: Array<[number, number]> = [];
  const quotedLabels = [...question.matchAll(/\b(?:status|processed_?status|scheduler_?status)\s*(?:=|为|是|等于)\s*(?:"[^"\n]*"|'[^'\n]*'|`[^`\n]*`)/giu)];
  const globalDefinitions = sources.length === 1 && sources[0] === jobSource ? [...question.matchAll(waitingDefinitionPattern)].filter(item =>
    !quotedLabels.some(label => item.index >= label.index && item.index < label.index + label[0].length)
      && !negativePrefix.test(question.slice(Math.max(0, item.index - 12), item.index))) : [];
  let unassessed = false;
  const room = () => requirements.length + boundaries.length < Math.max(0, maximumAdditional);
  const add = (source: string, requestedLabel: string, value: string | null) => {
    const id = sourceId(source, value);
    if (requirements.some(item => item.id === id)) return;
    if (!room()) { unassessed = true; return; }
    const label = source === jobSource && /^(?:已)?完成$/u.test(requestedLabel) ? "完成（completed）数量"
      : source === jobSource && /^(?:已)?失败$/u.test(requestedLabel) ? "失败（failed）数量"
        : requestedLabel === "等待（按 pending 原始标签）" ? "等待（按 pending）数量"
          : source === rawEventSource && value === "processed" && requestedLabel === "已处理" ? "已处理（processed）数量"
            : value === null ? "未分类（NULL）数量" : "原问指定原始标签数量";
    requirements.push({ id, source, label, metricRequest: { kind: "dimension_value", requestedLabel, value } });
  };
  const boundary = (source: string, kind: PlatformStateBoundaryKind) => {
    const id = `${source}:${kind}`;
    if (boundaries.some(item => item.id === id)) return;
    if (!room()) { unassessed = true; return; }
    boundaries.push({ id, source, label: kind === "waiting_definition" ? "等待数量的业务口径" : "当前可领取作业数量", boundaryKind: kind });
  };
  for (const match of question.matchAll(/[^\n。；;?？!！]+/gu)) {
    const clause = match[0], offset = match.index;
    if (!countQuestion.test(clause)) continue;
    const raw = [...clause.matchAll(/\b(status|processed_?status|scheduler_?status)\s*(?:=|为|是|等于)\s*(?:"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`|([a-z][a-z0-9_-]*))/giu)];
    // A quoted label is data, even when its spelling resembles a source noun.
    let scopeText = clause;
    for (const item of [...raw].reverse()) scopeText = scopeText.slice(0, item.index) + " ".repeat(item[0].length) + scopeText.slice(item.index + item[0].length);
    const named = sourceTopics.filter(([source, pattern]) => sources.includes(source) && pattern.test(scopeText)).map(([source]) => source);
    const source = named.length === 1 ? named[0] : named.length === 0 && sources.length === 1 ? sources[0] : undefined;
    const occupied: Array<[number, number]> = [];
    const consume = (begin: number, end: number) => { occupied.push([begin, end]); spans.push([offset + begin, offset + end]); };
    const covered = (index: number) => occupied.some(([begin, end]) => index >= begin && index < end);
    const waitingDefinitions = [...clause.matchAll(waitingDefinitionPattern)];
    for (const definition of waitingDefinitions) {
      const begin = definition.index;
      if (raw.some(item => begin >= item.index && begin < item.index + item[0].length)) continue;
      if (source !== jobSource || negativePrefix.test(clause.slice(Math.max(0, begin - 12), begin))) { unassessed = true; continue; }
      add(source, "等待（按 pending 原始标签）", "pending"); consume(begin, begin + definition[0].length);
    }
    for (const item of raw) {
      const rawValue = item[2] ?? item[3] ?? item[4] ?? item[5], begin = item.index;
      if (covered(begin)) continue;
      const value = item[5] !== undefined && /^null$/iu.test(item[5]) ? null : rawValue;
      if (!source || !sameDimension(source, item[1]) || rawValue.length > 80 || negativePrefix.test(clause.slice(Math.max(0, begin - 12), begin))) { unassessed = true; continue; }
      add(source, value === null ? "NULL（未分类）" : value, value); consume(begin, begin + item[0].length);
    }
    for (const word of clause.matchAll(/等待|待处理|待领取|\bwaiting\b/giu)) {
      if (covered(word.index)) continue;
      if (!source) unassessed = true;
      else if (source === jobSource && word[0] === "等待" && globalDefinitions.length) {
        add(source, "等待（按 pending 原始标签）", "pending");
        for (const definition of globalDefinitions) spans.push([definition.index, definition.index + definition[0].length]);
      } else boundary(source, "waiting_definition");
      consume(word.index, word.index + word[0].length);
    }
    for (const word of clause.matchAll(/可领取(?:作业|任务)?|可重试(?:作业|任务)?|可执行(?:作业|任务)?|\brunnable\b/giu)) {
      if (source !== jobSource) unassessed = true;
      else boundary(source, "runnable_job_count");
      consume(word.index, word.index + word[0].length);
    }
    for (const word of clause.matchAll(/已处理|已完成|完成|已失败|失败|\b(?:active|candidate|rejected|pending|completed|failed|running|applying|needs_review|resume_pending|review_closed)\b/giu)) {
      const begin = word.index;
      if (covered(begin)) continue;
      const previous = clause.slice(Math.max(0, begin - 12), begin), after = clause.slice(begin + word[0].length);
      if (negativePrefix.test(previous)) { unassessed = true; continue; }
      if (narrativePrefix.test(previous)) { unassessed = true; continue; }
      // Quoted values require the explicit dimension grammar above; arbitrary
      // prose or negated raw predicates cannot become a positive state request.
      if (/["'`]\s*$/u.test(previous) || /^["'`]/u.test(after)) { unassessed = true; continue; }
      if (!countTargetSuffix.test(after)) continue;
      // These are literal stored labels, never aliases for effective memory,
      // owner approval or executor activity. The complete source proof still
      // decides whether a present value or an absent group can be counted.
      if (/^(?:active|candidate|rejected)$/iu.test(word[0])) {
        if (!source || !sameDimension(source, "status")) { unassessed = true; continue; }
        add(source, word[0], word[0].toLowerCase()); consume(begin, begin + word[0].length); continue;
      }
      if (source === rawEventSource && word[0] === "已处理") { add(source, word[0], "processed"); consume(begin, begin + word[0].length); continue; }
      if (source !== jobSource || word[0] === "已处理") { unassessed = true; continue; }
      const value = /完成/u.test(word[0]) ? "completed" : /失败/u.test(word[0]) ? "failed" : word[0].toLowerCase();
      add(source, word[0], value); consume(begin, begin + word[0].length);
    }
    for (const word of clause.matchAll(/运行中|执行中|成功|错误|已结束|未开始|排队/gu)) {
      if (!covered(word.index) && countTargetSuffix.test(clause.slice(word.index + word[0].length))) unassessed = true;
    }
  }
  // Only recognized requested-label syntax is removed from the residual.
  // Unparsed clauses remain visible to the original-question boundary gate.
  let grammarQuestion = question;
  const unique = [...new Map(spans.map(span => [span.join(":"), span])).values()].sort(([a], [b]) => b - a);
  for (const [begin, end] of unique) grammarQuestion = grammarQuestion.slice(0, begin) + " ".repeat(end - begin) + grammarQuestion.slice(end);
  return { requirements, boundaries, grammarQuestion, unassessed };
}
