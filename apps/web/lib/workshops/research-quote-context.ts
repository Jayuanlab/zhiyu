/** Source text positions only. This does not infer the scientific meaning of a claim. */
export type ResearchQuoteContext = {
  start: number;
  end: number;
  heading: string | null;
  headingPath: string[];
  paragraph: string;
  paragraphTruncated: boolean;
};
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function researchHeadingPath(content: string, offset: number): string[] {
  const path: Array<{ level: number; text: string }> = [];
  for (const match of content.slice(0, offset).matchAll(/^(#{1,6})[ \t]+([^\r\n]+)$/gm)) {
    const level = match[1].length;
    while (path.length && path[path.length - 1].level >= level) path.pop();
    path.push({ level, text: match[2].replace(/[ \t]+#+[ \t]*$/, "").trim() });
  }
  return path.map(value => value.text);
}

export function locateResearchQuoteContext(content: string, quote: string,
  window: { offset: number; endOffset: number }): ResearchQuoteContext | null {
  if (!Number.isSafeInteger(window.offset) || !Number.isSafeInteger(window.endOffset) ||
      window.offset < 0 || window.endOffset > content.length || window.offset >= window.endOffset || !quote.trim()) return null;
  // Exact words and punctuation, allowing only the gate's whitespace normalization.
  const expression = new RegExp(quote.trim().split(/\s+/u).map(escaped).join("\\s+"), "gu");
  const selected = content.slice(window.offset, window.endOffset);
  const first = expression.exec(selected);
  if (!first) return null;
  // Search one original code point after the start, including overlapping matches.
  expression.lastIndex = first.index + (first[0].codePointAt(0)! > 0xffff ? 2 : 1);
  if (expression.exec(selected)) return null; // Ambiguous passages are not assigned a favorable location.
  const start = window.offset + first.index, end = start + first[0].length;
  const before = content.slice(0, start), after = content.slice(end);
  const precedingBreak = [...before.matchAll(/\r?\n[ \t]*\r?\n/g)].at(-1);
  const followingBreak = /\r?\n[ \t]*\r?\n/.exec(after);
  const paragraphStart = precedingBreak ? precedingBreak.index! + precedingBreak[0].length : 0;
  const paragraphEnd = followingBreak ? end + followingBreak.index : content.length;
  const clippedStart = Math.max(paragraphStart, start - 300, window.offset);
  const clippedEnd = Math.min(paragraphEnd, end + 300, window.endOffset);
  const headingPath = researchHeadingPath(content, start);
  return { start, end, heading: headingPath.at(-1) ?? null, headingPath,
    paragraph: content.slice(clippedStart, clippedEnd), paragraphTruncated: clippedStart !== paragraphStart || clippedEnd !== paragraphEnd };
}

function locatorKey(value: string): string | null {
  const trimmed = value.trim().replace(/\*|`/g, "");
  if (/^(?:abstract|摘要)(?:\s|$)/i.test(trimmed)) return "abstract";
  const appendix = /^(?:appendix\s*|附录\s*)([A-Z])(?:\b|\s|$)/i.exec(trimmed);
  if (appendix) return `appendix:${appendix[1].toUpperCase()}`;
  const section = /^(?:(?:section|sec\.?|章节?)\s*|§\s*)?(\d{1,2}(?:\.\d{1,2})*)(?:\.|\s|$)/i.exec(trimmed);
  if (section) return `section:${section[1]}`;
  const table = /^(?:table|表)\s*(\d{1,3})(?:\b|\s|$)/i.exec(trimmed);
  if (table) return `table:${table[1]}`;
  return null;
}

/** Known machine-readable section locators cannot contradict the source heading.
 * Free-text table captions and ambiguous/no-heading documents still need independent review. */
export function researchQuoteLocatorIssue(locator: string, context: ResearchQuoteContext): string | null {
  const supplied = locatorKey(locator);
  const actual = context.headingPath.map(locatorKey).filter((key): key is string => key !== null);
  if (!supplied || !actual.length || supplied.startsWith("table:")) return null;
  const matches = actual.some(key => key === supplied || supplied.startsWith("section:") && key.startsWith(`${supplied}.`));
  return matches ? null : `定位 ${locator} 与真实正文标题 ${context.headingPath.join(" / ")} 不对应；请按短摘实际位置标注。`;
}
