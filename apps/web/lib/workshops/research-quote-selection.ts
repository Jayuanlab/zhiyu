import { createHash } from "node:crypto";
import { loadWebEvidence } from "@/lib/ai/jina-page-reader";
import type { GroundedResearchSnapshot } from "./grounded-research-report";
import { workshopResearchSourceWindows } from "./research-evidence-correction";
import { locateResearchQuoteContext, researchHeadingPath } from "./research-quote-context";
import { resolveWorkshopResearchContract, verifyWorkshopResearchEvidence,
  type WorkshopResearchEvidenceEvent, type WorkshopResearchSourceCoverage } from "./research-evidence-verification";

export const WORKSHOP_RESEARCH_QUOTE_SELECTION_VERSION = "research-quote-selection/v1" as const;
type Value = Record<string, unknown>;
export type WorkshopResearchSelectedQuote = {
  queryIndex: number;
  sourceId: string;
  evidenceId: string;
  contentHash: string;
  sourceEventId: string;
  offset: number;
  endOffset: number;
  quote: string;
  precedingText: string;
  followingText: string;
  headingPath: string[];
  locator: string;
  quoteHash: string;
};
export type WorkshopResearchAlternativeQuote = WorkshopResearchSelectedQuote & {
  selectionKind: "alternative";
  matchMode: "term_overlap_suggestion";
};
export type WorkshopResearchQuoteSelection = {
  version: typeof WORKSHOP_RESEARCH_QUOTE_SELECTION_VERSION;
  sourceId: string | null;
  url: string | null;
  evidenceId: string | null;
  contentHash: string | null;
  candidates: WorkshopResearchSelectedQuote[];
  alternativeCandidates: WorkshopResearchAlternativeQuote[];
  gaps: string[];
  semanticStatus: "not_independently_verified";
};
const record = (value: unknown): Value => value && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
const integer = (value: unknown, minimum: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
const RETRIEVAL_STOP_WORDS = new Set("a an and are as at be been being but by can could did do does for from had has have in into is it its may might not of on or our paper result results reported reporting reports same should than that the their these they this those to under use used uses using was we were which who will with without would you your".split(" "));
function retrievalTerms(value: string): Set<string> {
  // Generic lexical retrieval only. Standalone values never become search
  // proof or repair a fabricated score. Digits within a real name stay bound
  // to that complete name, rather than matching an unrelated numeric token.
  const terms = new Set((value.match(/[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*/g) ?? [])
    .map(term => term.toLowerCase()).filter(term => term.length >= 3 && !RETRIEVAL_STOP_WORDS.has(term)));
  for (const text of value.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let index = 0; index < text.length - 1; index++) terms.add(text.slice(index, index + 2));
  }
  return terms;
}
function canonical(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = ""; return url.href;
  } catch { return null; }
}
function observedEvents(events: readonly WorkshopResearchEvidenceEvent[]): WorkshopResearchEvidenceEvent[] {
  const byId = new Map<string, WorkshopResearchEvidenceEvent>(); const conflicts = new Set<string>();
  for (const event of events) {
    if (!event.id) continue;
    const previous = byId.get(event.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) conflicts.add(event.id);
    byId.set(event.id, event);
  }
  return [...byId.values()].filter(event => !conflicts.has(event.id));
}
type Span = { start: number; end: number };
function trimmedSpan(content: string, span: Span): Span {
  const text = content.slice(span.start, span.end);
  return { start: span.start + text.length - text.trimStart().length,
    end: span.end - (text.length - text.trimEnd().length) };
}
function paragraphs(content: string): Span[] {
  const result: Span[] = []; let start = 0;
  for (const separator of content.matchAll(/\r?\n[ \t]*\r?\n/g)) {
    result.push(trimmedSpan(content, { start, end: separator.index! }));
    start = separator.index! + separator[0].length;
  }
  result.push(trimmedSpan(content, { start, end: content.length }));
  return result.filter(span => span.end > span.start && !/^#{1,6}[ \t]/.test(content.slice(span.start, span.end)));
}
function sentences(content: string, paragraph: Span): Span[] {
  const result: Span[] = []; let start = paragraph.start;
  const text = content.slice(paragraph.start, paragraph.end);
  // Punctuation locates exact slices only. Footnotes, list numbers and markup
  // remain source bytes; a query spanning sentences may use the whole paragraph.
  for (const separator of text.matchAll(/[.!?](?=\s+(?:[A-Z]|[-*][ \t]|\d+[).][ \t]))/g)) {
    const end = paragraph.start + separator.index! + 1;
    result.push(trimmedSpan(content, { start, end })); start = end;
  }
  result.push(trimmedSpan(content, { start, end: paragraph.end }));
  return result;
}
function locatorFor(headingPath: string[], start: number, end: number): string {
  const heading = headingPath.at(-1);
  return heading && heading.length <= 200 ? heading : `正文字符 ${start}–${end}`;
}
function validSnapshot(source: WorkshopResearchSourceCoverage, snapshots: readonly GroundedResearchSnapshot[]): GroundedResearchSnapshot | null {
  if (source.status !== "complete" || !source.evidenceId || !source.contentHash || !/^[a-f0-9]{64}$/i.test(source.contentHash) ||
      !integer(source.totalChars, 1) || source.totalChars > 2 * 1024 * 1024 || source.coveredChars !== source.totalChars || !source.eventIds.length) return null;
  const matches = snapshots.filter(snapshot => snapshot.sourceId === source.sourceId && snapshot.evidenceId === source.evidenceId);
  if (!matches.length || matches.some(snapshot => snapshot.contentHash !== source.contentHash ||
      typeof snapshot.content !== "string" || snapshot.content.length !== source.totalChars || hash(snapshot.content) !== source.contentHash ||
      !canonical(snapshot.url) || !source.urls.map(canonical).includes(canonical(snapshot.url)) ||
      snapshot.content !== matches[0].content || canonical(snapshot.url) !== canonical(matches[0].url))) return null;
  return matches[0];
}

/** Selects source bytes, never rewrites a conclusion or marks a report valid.
 * The caller persists a runtime-owned selection receipt before returning refs.
 * It uses only an already covered, owned, same-version body; no network path. */
export async function selectWorkshopResearchQuotes(input: {
  workshopId: string; runId: string; modelConfig: unknown; taskText: string;
  events: readonly WorkshopResearchEvidenceEvent[]; url: string; evidenceId: string;
  queries: readonly { text: string; kind?: "method" | "experiment" | "limitation" }[];
  eventsOverflow?: boolean;
}): Promise<WorkshopResearchQuoteSelection> {
  const result: WorkshopResearchQuoteSelection = { version: WORKSHOP_RESEARCH_QUOTE_SELECTION_VERSION,
    sourceId: null, url: canonical(input.url), evidenceId: typeof input.evidenceId === "string" ? input.evidenceId : null,
    contentHash: null, candidates: [], alternativeCandidates: [], gaps: [], semanticStatus: "not_independently_verified" };
  const unavailable = (message: string) => { result.gaps.push(message); return result; };
  const resolution = resolveWorkshopResearchContract(input.modelConfig, input.taskText);
  if (!input.workshopId || !input.runId || input.eventsOverflow || input.events.length > 1000 || !resolution.active || resolution.issues.length ||
      resolution.contract?.reportDelivery !== "grounded-report/v1") return unavailable("当前本轮原文引用选择合同不可用，未新增读取或权限。");
  if (!Array.isArray(input.queries) || input.queries.length < 1 || input.queries.length > 3 || input.queries.some(query =>
      !query || typeof query.text !== "string" || query.text.trim().length < 20 || query.text.length > 200 ||
      query.kind !== undefined && !["method", "experiment", "limitation"].includes(query.kind))) return unavailable("引用选择需要 1–3 条 20–200 字符的连续原文片段。");
  const events = observedEvents(input.events);
  const verification = verifyWorkshopResearchEvidence({ ...input, events, report: undefined });
  if (!verification.coverage.length || verification.coverage.some(source => source.status !== "complete")) {
    return unavailable("本轮必读来源尚未完整覆盖；引用选择不能补造正文覆盖。");
  }
  const matches = verification.coverage.filter(source => source.evidenceId === input.evidenceId && source.urls.map(canonical).includes(result.url));
  if (!result.url || matches.length !== 1) return unavailable("请求未绑定本轮必读来源的真实同版正文身份。");
  const source = matches[0]; result.sourceId = source.sourceId; result.contentHash = source.contentHash ?? null;
  const windows = workshopResearchSourceWindows(source, events, input.runId, resolution.contract.minQualityScore ?? 55);
  if (!windows.length || source.eventIds.some(id => !windows.some(window => window.eventId === id))) return unavailable("本轮真实正文窗口回执不完整或冲突，未提供引用。");
  let snapshot: GroundedResearchSnapshot;
  try {
    const loaded = await loadWebEvidence(`workshop:${input.workshopId}`, input.evidenceId, result.url);
    snapshot = { sourceId: source.sourceId, evidenceId: loaded.snapshot.evidenceId, contentHash: loaded.snapshot.contentHash,
      url: loaded.snapshot.url, content: loaded.snapshot.content };
    if (!validSnapshot(source, [snapshot]) || windows.some(window => window.url !== canonical(snapshot.url))) throw Error("body_identity_mismatch");
  } catch { return unavailable("本轮同版正文缓存缺失或身份校验失败；未重取来源。"); }
  const blocks = paragraphs(snapshot.content); const seen = new Set<string>(); const unmatchedQueryIndexes: number[] = [];
  const candidateAt = (span: Span, queryIndex: number): WorkshopResearchSelectedQuote | null => {
    if (span.end - span.start < 40 || span.end - span.start > 1600) return null;
    const quote = snapshot.content.slice(span.start, span.end);
    const containing = windows.filter(window => window.offset <= span.start && window.endOffset >= span.end);
    const window = containing.find(window => {
      const context = locateResearchQuoteContext(snapshot.content, quote, window);
      return context?.start === span.start && context.end === span.end;
    });
    if (!window) return null;
    const headingPath = researchHeadingPath(snapshot.content, span.start);
    if (headingPath.some(heading => heading.length > 300) || headingPath.join(" / ").length > 1200) return null;
    return { queryIndex, sourceId: source.sourceId, evidenceId: snapshot.evidenceId, contentHash: snapshot.contentHash,
      sourceEventId: window.eventId, offset: span.start, endOffset: span.end, quote, headingPath,
      precedingText: snapshot.content.slice(Math.max(window.offset, span.start - 160), span.start),
      followingText: snapshot.content.slice(span.end, Math.min(window.endOffset, span.end + 160)),
      locator: locatorFor(headingPath, span.start, span.end), quoteHash: hash(quote) };
  };
  for (const [queryIndex, query] of input.queries.entries()) {
    const needle = normalize(query.text); const choices: Span[] = [];
    for (const paragraph of blocks) {
      if (!normalize(snapshot.content.slice(paragraph.start, paragraph.end)).includes(needle)) continue;
      const matchingSentences = sentences(snapshot.content, paragraph).filter(span => normalize(snapshot.content.slice(span.start, span.end)).includes(needle));
      choices.push(...(matchingSentences.length ? matchingSentences : [paragraph]));
    }
    let admitted = 0;
    for (const span of choices) {
      const candidate = candidateAt(span, queryIndex);
      if (!candidate) continue;
      const key = `${span.start}:${span.end}`;
      if (seen.has(key)) { admitted += 1; continue; }
      if (admitted >= 2) break;
      seen.add(key); admitted += 1;
      result.candidates.push(candidate);
    }
    if (!admitted) {
      unmatchedQueryIndexes.push(queryIndex);
      result.gaps.push(`第 ${queryIndex + 1} 条片段未找到单个本轮真实阅读窗口内可唯一定位的 40–1600 字符连续原句或原段；未删字、拼接或猜造。`);
    }
  }
  // Literal selection completes first. Suggestions never displace a real
  // literal, erase its missing-match gap, alter a claim or enter final gates.
  const alternativeSpans = blocks.flatMap(paragraph => {
    const parts = sentences(snapshot.content, paragraph);
    return parts.some(span => span.end - span.start >= 40) ? parts : [paragraph];
  }).filter(span => span.end - span.start >= 40 && span.end - span.start <= 1600);
  const termSpans = alternativeSpans.map(span => ({ span, terms: retrievalTerms(snapshot.content.slice(span.start, span.end)) }));
  for (const queryIndex of unmatchedQueryIndexes) {
    if (result.candidates.length + result.alternativeCandidates.length >= 6) break;
    const queryTerms = retrievalTerms(input.queries[queryIndex].text);
    if (queryTerms.size < 2) continue;
    const ranked = termSpans.map(({ span, terms }) => ({ span,
      overlap: [...queryTerms].filter(term => terms.has(term)).length }))
      .filter(choice => choice.overlap >= 2)
      .sort((left, right) => right.overlap - left.overlap || left.span.start - right.span.start);
    let admitted = 0;
    for (const { span } of ranked) {
      if (admitted >= 2 || result.candidates.length + result.alternativeCandidates.length >= 6) break;
      const key = `${span.start}:${span.end}`;
      if (seen.has(key)) continue;
      const candidate = candidateAt(span, queryIndex);
      if (!candidate) continue;
      seen.add(key); admitted += 1;
      result.alternativeCandidates.push({ ...candidate, selectionKind: "alternative", matchMode: "term_overlap_suggestion" });
    }
    if (admitted) result.gaps.push(`第 ${queryIndex + 1} 条仅提供词项重合的原文建议，不是原片段的逐字命中或结论支持证明；请核对上下文后按真实原句重写原子结论，不能保留无原文支持的数字。`);
  }
  return result;
}

/** Resolves only persisted host selections into the existing literal-quote
 * report shape. Claim text is untouched. The existing strict final gate must
 * still check all source coverage, numbers, identifiers, locators and schema. */
export function resolveWorkshopResearchQuoteRefs(report: unknown, input: {
  workshopId: string; runId: string; events: readonly WorkshopResearchEvidenceEvent[];
  snapshots: readonly GroundedResearchSnapshot[]; coverage: readonly WorkshopResearchSourceCoverage[];
}): { ok: true; report: unknown } | { ok: false; issues: string[] } {
  const evidence = record(record(report).researchEvidence);
  const works = Array.isArray(evidence.works) ? evidence.works : [];
  const claims = works.flatMap(work => Array.isArray(record(work).supportedClaims) ? record(work).supportedClaims as unknown[] : []);
  if (!claims.some(claim => Object.hasOwn(record(claim), "quoteRef"))) return { ok: true, report };
  const issues: string[] = [];
  if (!input.workshopId || !input.runId || input.events.length > 1000 || !input.coverage.length || input.coverage.length > 20 ||
      new Set(input.coverage.map(source => source.sourceId)).size !== input.coverage.length || input.coverage.some(source => source.status !== "complete")) {
    return { ok: false, issues: ["引用选择缺少本轮有效且完整的必读来源覆盖，未恢复引文。"] };
  }
  if (claims.length > 180 || works.length > 20 || claims.some(claim => !Object.hasOwn(record(claim), "quoteRef") ||
      Object.hasOwn(record(claim), "quote") || Object.hasOwn(record(claim), "evidenceEventId"))) {
    return { ok: false, issues: ["同一引用选择报告不能混合 quoteRef 与自由 quote/evidenceEventId；未自动修补。"] };
  }
  const events = observedEvents(input.events); const byId = new Map(events.map(event => [event.id, event]));
  const resolvedWorks = works.map(rawWork => {
    const work = record(rawWork); const source = input.coverage.find(value => value.sourceId === work.sourceId);
    const snapshot = source ? validSnapshot(source, input.snapshots) : null;
    const windows = source ? workshopResearchSourceWindows(source, events, input.runId, 0) : [];
    const validSource = source && snapshot && source.eventIds.every(id => windows.some(window => window.eventId === id));
    const resolvedClaims = (Array.isArray(work.supportedClaims) ? work.supportedClaims : []).map((rawClaim, claimIndex) => {
      const claim = record(rawClaim); const ref = record(claim.quoteRef);
      const failure = () => { issues.push(`来源 ${String(work.sourceId)} 第 ${claimIndex + 1} 条 quoteRef 未绑定本轮宿主选择的真实同版单窗口原文；未恢复或改写结论。`); return rawClaim; };
      if (!source || !snapshot || !validSource || typeof ref.selectionEventId !== "string" || !ref.selectionEventId.trim() || ref.selectionEventId.length > 200 ||
          !integer(ref.index, 0) || Object.keys(ref).some(key => !["selectionEventId", "index"].includes(key))) return failure();
      const selection = byId.get(ref.selectionEventId); const metadata = record(selection?.metadata);
      if (!selection || selection.runId !== input.runId || selection.type !== "research_quote_selected" ||
          metadata.version !== WORKSHOP_RESEARCH_QUOTE_SELECTION_VERSION || metadata.receiptAuthority !== "runtime" ||
          metadata.toolName !== "webReadPage" || metadata.workshopId !== input.workshopId ||
          !Array.isArray(metadata.candidates) || metadata.candidates.length > 6 || ref.index >= metadata.candidates.length) return failure();
      const selected = record(metadata.candidates[ref.index]);
      if (selected.sourceId !== source.sourceId || selected.evidenceId !== snapshot.evidenceId || selected.contentHash !== snapshot.contentHash ||
          typeof selected.sourceEventId !== "string" || !integer(selected.offset, 0) || !integer(selected.endOffset, 1) ||
          selected.endOffset <= selected.offset || selected.endOffset > snapshot.content.length ||
          typeof selected.quote !== "string" || selected.quote.length < 40 || selected.quote.length > 1600 ||
          selected.quote !== snapshot.content.slice(selected.offset, selected.endOffset) || selected.quoteHash !== hash(selected.quote)) return failure();
      const offset = selected.offset, endOffset = selected.endOffset;
      const window = windows.find(value => value.eventId === selected.sourceEventId && value.offset <= offset && value.endOffset >= endOffset);
      if (!window || window.url !== canonical(snapshot.url)) return failure();
      // Context is displayed as a retrieval aid only, never folded into the
      // quote or numeric proof. It cannot expose bytes outside this receipt.
      if (selected.precedingText !== snapshot.content.slice(Math.max(window.offset, offset - 160), offset) ||
          selected.followingText !== snapshot.content.slice(endOffset, Math.min(window.endOffset, endOffset + 160))) return failure();
      const context = locateResearchQuoteContext(snapshot.content, selected.quote, window);
      const headingPath = researchHeadingPath(snapshot.content, selected.offset);
      if (!context || context.start !== selected.offset || context.end !== selected.endOffset ||
          !Array.isArray(selected.headingPath) || JSON.stringify(selected.headingPath) !== JSON.stringify(headingPath) ||
          selected.locator !== locatorFor(headingPath, selected.offset, selected.endOffset)) return failure();
      const { quoteRef: _quoteRef, ...unchanged } = claim;
      return { ...unchanged, ...(Object.hasOwn(claim, "locator") ? {} : { locator: selected.locator }),
        quote: selected.quote, evidenceEventId: selected.sourceEventId };
    });
    return { ...work, supportedClaims: resolvedClaims };
  });
  return issues.length ? { ok: false, issues: [...new Set(issues)] }
    : { ok: true, report: { ...record(report), researchEvidence: { ...evidence, works: resolvedWorks } } };
}
