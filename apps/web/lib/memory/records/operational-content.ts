import type { BrainMemory } from "../kernel/memory-types";
export type OperationalCategory = "market_snapshot" | "daily_report" | "mixed_content";
export type LessonSpan = { offset: number; quote: string };
/** Exact original spans, never factual endorsements or generated summaries. */
export function findLessonSpans(content: string): LessonSpan[] {
  const spans: LessonSpan[] = [];
  for (const match of content.matchAll(/(?:【(?:学习|教训|经验总结|经验|改进建议)】|(?:^|\n|\\n)(?:教训|经验总结|学习|Lesson learned)\s*[:：])/gi)) {
    const start = match.index!, tail = content.slice(start, start + 1600);
    const end = tail.slice(match[0].length).search(/\n(?=【)|\\n(?=【)/);
    const original = end >= 0 ? tail.slice(0, match[0].length + end) : tail.split(/\n\n|\\n\\n/)[0], quote = original.trim();
    if (quote.length >= 12) spans.push({ offset: start + original.indexOf(quote), quote });
    if (spans.length >= 6) break;
  }
  return spans;
}
export function analyzeOperationalContent(memory: BrainMemory): { category: OperationalCategory; reason: string } | null {
  if (!["fact", "insight", "plan", "task", "system"].includes(memory.memoryType) || memory.metadata?.canonicalKind === "boundary") return null;
  const head = memory.content.slice(0, 400), tags = (memory.tags ?? []).join(" ");
  const dated = /(?:20\d{2}[-年/]\d{1,2}|\b\d{1,2}[-/]\d{1,2}\b)/.test(head + " " + tags);
  const market = /现价|收盘|开盘|盘前|盘后|持仓|净流[入出]|涨停|跌停|trendScore|timing_assessment|【账户】|watchlist_constraint|市场风格|净卖出/.test(head);
  const daily = /巡检|复盘|日报|早报|晚报|早盘雷达|午盘|尾盘|筛选经验|自检|自查|运行完成|重试运行|第.{0,10}次运行|数据源异常记录/.test(head);
  const selfAudit = /(?:Work\s*模型第.{0,8}次自检|Work自检\s*[（(:：]|Work自检结果)/i.test(head)
    || /work-self-audit|work-self-check/i.test(tags) && /自检|audit/i.test(head);
  const environment = /dependency|tool-config|source-unavailable/.test(tags) && /未安装|fetch failed|无法访问|被拒绝|不可用/.test(head);
  if (!(dated && (market || daily) || selfAudit || environment)) return null;
  const category: OperationalCategory = findLessonSpans(memory.content).length ? "mixed_content" : market ? "market_snapshot" : "daily_report";
  return { category, reason: `operational_${category}` };
}
export function isVolatileLesson(content: string): boolean {
  return /【账户】|总资产|账户余额|现金\s*[:：=]?\s*\d|现价\s*[:：=]?\s*\d|收盘\s*[:：=]?\s*\d|(?:trendScore|MA\d+)\s*[:：=]\s*\d|\b\d{6}\.(?:SH|SZ)\b|当前持仓|今日(?:买入|卖出)|明日(?:买入|卖出)/i.test(content);
}
