import { createHash } from "node:crypto";
import { loadWebEvidence } from "@/lib/ai/jina-page-reader";
import { researchHeadingPath } from "./research-quote-context";
import { isSavedResearchPageMethod } from "./research-page-method";
import type { WorkshopResearchEvidenceEvent, WorkshopResearchSourceCoverage } from "./research-evidence-verification";

const MAX_CANDIDATES = 4;
const MAX_PER_CLAIM = 2;
const MAX_QUOTE_CHARS = 600;
const MAX_CONTEXT_CHARS = 100;
type Value = Record<string, unknown>;
export type WorkshopResearchCorrectionWindow = { eventId: string; url: string; offset: number; endOffset: number };
export type WorkshopResearchQuoteCorrection = {
  sourceId: string;
  claimIndex: number;
  candidateIndex: number;
  candidateCount: number;
  relatedCandidateCount: number;
  omittedCandidateCount: number;
  eventId: string;
  evidenceId: string;
  contentHash: string;
  url: string;
  offset: number;
  endOffset: number;
  sectionHeading: string | null;
  headingPath: string[];
  quote: string;
  precedingText: string;
  followingText: string;
  missingClaimNumbers: string[];
};
const record = (value: unknown): Value => value && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
const integer = (value: unknown, min: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min;
function canonicalUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = ""; return url.href; } catch { return null; }
}

/** Include all admitted same-run windows, including repeated reads. Coverage
 * selects one proof chain; that chain must not hide another real citation ID.
 * Conflicting event IDs and windows beyond proven contiguous coverage are inert. */
export function workshopResearchSourceWindows(source: WorkshopResearchSourceCoverage,
  events: readonly WorkshopResearchEvidenceEvent[], runId: string, minQuality = 55): WorkshopResearchCorrectionWindow[] {
  if (!source.evidenceId || !source.contentHash || !integer(source.totalChars, 1)) return [];
  const admitted = new Map<string, WorkshopResearchEvidenceEvent>();
  const conflicts = new Set<string>();
  for (const event of events) {
    if (!event.id || event.runId !== runId || event.type !== "source_checked") continue;
    const previous = admitted.get(event.id);
    if (previous && JSON.stringify(previous.metadata) !== JSON.stringify(event.metadata)) conflicts.add(event.id);
    admitted.set(event.id, event);
  }
  const urls = source.urls.map(canonicalUrl);
  return [...admitted.values()].flatMap(event => {
    const metadata = record(event.metadata); const url = canonicalUrl(metadata.url);
    const finalUrl = metadata.finalUrl == null ? null : canonicalUrl(metadata.finalUrl);
    if (conflicts.has(event.id) || metadata.receiptAuthority !== "runtime" || metadata.toolName !== "webReadPage" ||
      !isSavedResearchPageMethod(metadata) || metadata.ok !== true || metadata.evidenceId !== source.evidenceId ||
      metadata.contentHash !== source.contentHash || metadata.totalChars !== source.totalChars ||
      !url || !urls.includes(url) || (metadata.finalUrl != null && (!finalUrl || !urls.includes(finalUrl))) ||
      !integer(metadata.offset, 0) || !integer(metadata.contentLength, 1) ||
      typeof metadata.qualityScore !== "number" || !Number.isFinite(metadata.qualityScore) ||
      metadata.qualityScore < minQuality || metadata.qualityScore > 100) return [];
    const endOffset = metadata.offset + metadata.contentLength;
    if (!integer(endOffset, 1) || endOffset > source.totalChars! || endOffset > source.coveredChars ||
      (metadata.nextOffset === null ? endOffset !== source.totalChars : metadata.nextOffset !== endOffset || endOffset >= source.totalChars!)) return [];
    return [{ eventId: event.id, url, offset: metadata.offset, endOffset }];
  }).sort((left, right) => left.offset - right.offset);
}

const STOP_WORDS = new Set("a an and are as at be by for from has have in is it model of on or that the this to uses via was we which with without".split(" "));
function words(value: string): string[] {
  return [...new Set((value.match(/[A-Za-z0-9][A-Za-z0-9_/%.-]*/g) ?? [])
    .map(word => word.toLowerCase().replace(/[.,;:]$/g, ""))
    .filter(word => word.length >= 3 && !STOP_WORDS.has(word)))];
}
function numbers(value: string): string[] {
  return [...new Set((value.match(/[+\-−]?\d+(?:,\d{3})*(?:\.\d+)?(?:[eE][+\-]?\d+)?(?:\s*[%‰]|\+)?/g) ?? [])
    .map(number => number.replace(/\s+/g, "")))];
}
function sourceSentences(content: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  // Offsets refer to the exact owned body; punctuation boundaries only locate
  // suggestions. No cleanup (including citation removal) alters the quote.
  let start = 0;
  const separators = /\n\s*\n|[.!?](?=\s+[A-Z(])/g;
  for (const separator of content.matchAll(separators)) {
    const end = separator.index! + (separator[0].startsWith("\n") ? 0 : 1);
    spans.push({ start, end }); start = separator.index! + separator[0].length;
  }
  spans.push({ start, end: content.length });
  return spans.map(span => {
    const text = content.slice(span.start, span.end);
    const lead = text.length - text.trimStart().length;
    return { start: span.start + lead, end: span.end - (text.length - text.trimEnd().length) };
  }).filter(span => span.end - span.start >= 40 && span.end - span.start <= MAX_QUOTE_CHARS);
}
function headingBefore(content: string, offset: number): string | null {
  let heading: string | null = null;
  for (const match of content.slice(0, offset).matchAll(/^#{1,6}[^\S\r\n]+[^\r\n]+/gm)) heading = match[0].slice(0, 300);
  return heading;
}

/** Suggestions locate, never repair or approve. The same strict final gate
 * must independently verify the model's next choice. No model, tool, refetch,
 * external search, write, or new source is used here. */
export async function suggestWorkshopResearchQuoteCorrections(input: {
  workshopId: string;
  runId: string;
  report: unknown;
  issues: readonly string[];
  coverage: readonly WorkshopResearchSourceCoverage[];
  events: readonly WorkshopResearchEvidenceEvent[];
  minQuality?: number;
  eventsOverflow?: boolean;
}): Promise<{ candidates: WorkshopResearchQuoteCorrection[]; warnings: string[] }> {
  const candidates: WorkshopResearchQuoteCorrection[] = []; const warnings: string[] = [];
  if (input.eventsOverflow || input.coverage.length > 20) return { candidates, warnings };
  const works = record(record(input.report).researchEvidence).works;
  if (!Array.isArray(works) || works.length > 20) return { candidates, warnings };
  type PendingClaim = { choices: WorkshopResearchQuoteCorrection[]; relatedCount: number };
  const sourceQueues: PendingClaim[][] = [];
  for (const source of input.coverage) {
    const matchingWorks = works.map(record).filter(work => work.sourceId === source.sourceId);
    if (source.status !== "complete" || matchingWorks.length !== 1 || !source.evidenceId ||
      !source.contentHash || !integer(source.totalChars, 1) || source.totalChars > 2 * 1024 * 1024) continue;
    const evidenceId = source.evidenceId;
    const contentHash = source.contentHash;
    const totalChars = source.totalChars;
    const claims = matchingWorks[0].supportedClaims;
    if (!Array.isArray(claims) || claims.length > 9) continue;
    const targets = claims.map(record).map((claim, index) => ({ claim, index })).filter(({ claim, index }) =>
      typeof claim.claim === "string" && claim.claim.length <= 500 && typeof claim.quote === "string" && claim.quote.length <= 1600 &&
      typeof claim.evidenceEventId === "string" && input.issues.some(issue => issue.startsWith(`必读来源 ${source.sourceId} 第 ${index + 1} 条结论`)));
    if (!targets.length) continue;
    const windows = workshopResearchSourceWindows(source, input.events, input.runId, input.minQuality);
    if (!windows.length) continue;
    let content: string; let snapshotUrl: string;
    try {
      const { snapshot } = await loadWebEvidence(`workshop:${input.workshopId}`, evidenceId, windows[0].url);
      snapshotUrl = canonicalUrl(snapshot.url)!; content = snapshot.content;
      if (snapshot.evidenceId !== evidenceId || snapshot.contentHash !== contentHash ||
        typeof content !== "string" || content.length !== totalChars ||
        createHash("sha256").update(content).digest("hex") !== contentHash ||
        !snapshotUrl || !source.urls.map(canonicalUrl).includes(snapshotUrl) || windows.some(window => window.url !== snapshotUrl)) throw Error("body_identity_mismatch");
    } catch {
      warnings.push(`来源 ${source.sourceId} 的纠正提示未装载：同版正文快照不可用或身份校验失败；未重取来源。`); continue;
    }
    const spans = sourceSentences(content);
    const sourceQueue: PendingClaim[] = [];
    for (const { claim, index } of targets) {
      const quoteWords = words(claim.quote as string); const claimWords = words(claim.claim as string);
      const claimNumbers = numbers(claim.claim as string);
      const ranked = spans.flatMap(span => {
        const containing = windows.filter(window => window.offset <= span.start && window.endOffset >= span.end);
        if (!containing.length) return [];
        const quote = content.slice(span.start, span.end); const tokens = new Set(words(quote));
        const quoteMatches = quoteWords.filter(word => tokens.has(word));
        const claimMatches = claimWords.filter(word => tokens.has(word));
        const quoteNumbers = new Set(numbers(quote));
        const matchedNumbers = claimNumbers.filter(number => quoteNumbers.has(number));
        if (quoteMatches.length < 2 && claimMatches.length < 2) return [];
        // Ranking is only a retrieval suggestion; these scores never enter the
        // report gate or decide factual truth. A wrong value remains missing.
        const score = quoteMatches.length + claimMatches.length * 2 + matchedNumbers.length * 4;
        const window = containing.find(window => window.eventId === claim.evidenceEventId) ?? containing[0];
        return [{ ...span, quote, score, window, missingClaimNumbers: claimNumbers.filter(number => !quoteNumbers.has(number)) }];
      }).sort((left, right) => left.missingClaimNumbers.length - right.missingClaimNumbers.length ||
        right.score - left.score || left.start - right.start);
      const selected = ranked.slice(0, MAX_PER_CLAIM);
      const choices = selected.map(span => ({ sourceId: source.sourceId, claimIndex: index + 1, candidateIndex: 0,
          candidateCount: 0, relatedCandidateCount: ranked.length, omittedCandidateCount: ranked.length,
          eventId: span.window.eventId, evidenceId,
          contentHash, url: snapshotUrl, offset: span.start, endOffset: span.end,
          sectionHeading: headingBefore(content, span.start), headingPath: researchHeadingPath(content, span.start), quote: span.quote,
          precedingText: content.slice(Math.max(span.window.offset, span.start - MAX_CONTEXT_CHARS), span.start),
          followingText: content.slice(span.end, Math.min(span.window.endOffset, span.end + MAX_CONTEXT_CHARS)),
          missingClaimNumbers: span.missingClaimNumbers }));
      if (choices.length) sourceQueue.push({ choices, relatedCount: ranked.length });
      if (!selected.length) warnings.push(`来源 ${source.sourceId} 第 ${index + 1} 条结论未找到 40–600 字符、位于单个真实窗口内的相关连续原文候选；不能拼接或补造。`);
    }
    if (sourceQueue.length) sourceQueues.push(sourceQueue);
  }
  // Give each failed claim one useful passage before offering alternatives.
  // Round-robin sources so the first paper cannot consume all four hints.
  const pendingCount = sourceQueues.reduce((total, queue) => total + queue.length, 0);
  const chosen: Array<{ target: PendingClaim; choice: WorkshopResearchQuoteCorrection }> = [];
  while (chosen.length < MAX_CANDIDATES && sourceQueues.some(queue => queue.length)) {
    for (const queue of sourceQueues) {
      if (chosen.length >= MAX_CANDIDATES) break;
      const target = queue.shift();
      if (target) chosen.push({ target, choice: target.choices[0] });
    }
  }
  const primary = [...chosen];
  for (const { target } of primary) {
    if (chosen.length >= MAX_CANDIDATES) break;
    if (target.choices[1]) chosen.push({ target, choice: target.choices[1] });
  }
  const counts = new Map<PendingClaim, number>(); const seen = new Map<PendingClaim, number>();
  for (const { target } of chosen) counts.set(target, (counts.get(target) ?? 0) + 1);
  for (const { target, choice } of chosen) {
    const candidateIndex = (seen.get(target) ?? 0) + 1; seen.set(target, candidateIndex);
    candidates.push({ ...choice, candidateIndex, candidateCount: counts.get(target)!,
      omittedCandidateCount: target.relatedCount - counts.get(target)! });
  }
  if (pendingCount > primary.length) warnings.push(`连续原文纠正候选已达 4 个总数上限，另有 ${pendingCount - primary.length} 条失败结论未列候选；未列出不表示其问题已解决。`);
  return { candidates, warnings };
}
