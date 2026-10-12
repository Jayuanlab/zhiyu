import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const load = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/jina-page-reader", () => ({ loadWebEvidence: load }));
import { selectWorkshopResearchQuotes, resolveWorkshopResearchQuoteRefs } from "@/lib/workshops/research-quote-selection";
import { verifyAndBuildGroundedResearchReport } from "@/lib/workshops/grounded-research-report";
import type { WorkshopResearchEvidenceEvent, WorkshopResearchSourceCoverage } from "@/lib/workshops/research-evidence-verification";

const url = "https://arxiv.org/html/2402.03300v3";
const exact = "(2) DeepSeekMath-Base 7B achieves 64.2% on GSM8K [^9], using the evaluation settings reported in the paper.";
const method = "Our training procedure uses group relative policy optimization without an additional critic model.";
const content = `## 1 Introduction\n\n${exact}\n\n## 2 Method\n\n${method}`;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const contentHash = digest(content);
const modelConfig = { researchEvidenceContract: { version: "primary-reading/v1", reportDelivery: "grounded-report/v1", requiredPrimarySources: [{ id: "math", label: "Math", urls: [url] }] } };
const source = (): WorkshopResearchSourceCoverage => ({ sourceId: "math", label: "Math", urls: [url], status: "complete", evidenceId: "snapshot", contentHash, totalChars: content.length, coveredChars: content.length, eventIds: ["read"] });
const event = (overrides: Record<string, unknown> = {}): WorkshopResearchEvidenceEvent => ({ id: "read", runId: "run", type: "source_checked", metadata: { receiptAuthority: "runtime", toolName: "webReadPage", method: "jina_defuddle", ok: true, url, finalUrl: url, evidenceId: "snapshot", contentHash, qualityScore: 80, offset: 0, contentLength: content.length, totalChars: content.length, nextOffset: null, ...overrides } });
const snapshot = () => ({ sourceId: "math", evidenceId: "snapshot", contentHash, url, content });
const selectionInput = () => ({ workshopId: "work", runId: "run", modelConfig, taskText: "Research Math", events: [event()], url, evidenceId: "snapshot", queries: [{ text: "DeepSeekMath-Base 7B achieves 64.2%" }] });
const candidate = () => ({ queryIndex: 0, sourceId: "math", evidenceId: "snapshot", contentHash, sourceEventId: "read", offset: content.indexOf(exact), endOffset: content.indexOf(exact) + exact.length, quote: exact, precedingText: content.slice(0, content.indexOf(exact)), followingText: content.slice(content.indexOf(exact) + exact.length, content.indexOf(exact) + exact.length + 160), headingPath: ["1 Introduction"], locator: "1 Introduction", quoteHash: digest(exact) });
const selectionEvent = (): WorkshopResearchEvidenceEvent => ({ id: "selected", runId: "run", type: "research_quote_selected", metadata: { version: "research-quote-selection/v1", receiptAuthority: "runtime", toolName: "webReadPage", workshopId: "work", candidates: [candidate()] } });
const report = () => ({ researchEvidence: { reportVersion: "grounded-report/v1", works: [{ sourceId: "math", supportedClaims: [{ kind: "experiment", claim: "DeepSeekMath-Base 7B 在 GSM8K 达到 64.2%。", quoteRef: { selectionEventId: "selected", index: 0 } }] }], gaps: [] } });
const resolutionInput = () => ({ workshopId: "work", runId: "run", events: [event(), selectionEvent()], snapshots: [snapshot()], coverage: [source()] });

describe("run-bound exact quote selection", () => {
  beforeEach(() => load.mockReset().mockResolvedValue({ snapshot: snapshot() }));

  it("returns the original complete sentence including numbering and footnotes, without modifying the query", async () => {
    const input = selectionInput(); const before = JSON.stringify(input);
    const selected = await selectWorkshopResearchQuotes(input);
    expect(selected.candidates).toHaveLength(1);
    expect(selected.candidates[0]).toMatchObject(candidate());
    expect(selected.gaps).toEqual([]);
    expect(selected).not.toHaveProperty("ok");
    expect(JSON.stringify(input)).toBe(before);
    expect(load).toHaveBeenCalledWith("workshop:work", "snapshot", url);
  });

  it("permits whitespace-only needle matching but never deleted markers, case changes or invented numbers", async () => {
    const input = selectionInput(); input.queries[0].text = "DeepSeekMath-Base  7B\nachieves 64.2%";
    expect((await selectWorkshopResearchQuotes(input)).candidates[0].quote).toBe(exact);
    for (const text of ["DeepSeekMath-Base 7B achieves 99.9%", "deepseekmath-Base 7B achieves 64.2%", "64.2% on GSM8K, using the evaluation"]) {
      input.queries[0].text = text;
      const result = await selectWorkshopResearchQuotes(input);
      expect(result.candidates).toEqual([]); expect(result.gaps).not.toEqual([]);
    }
  });

  it("requires active grounded delivery, all required coverage, safe query bounds and the pinned identity before cache access", async () => {
    const valid = selectionInput();
    for (const input of [
      { ...valid, modelConfig: {} }, { ...valid, runId: "other" }, { ...valid, evidenceId: "other" },
      { ...valid, eventsOverflow: true }, { ...valid, queries: [] },
      { ...valid, queries: Array.from({ length: 4 }, () => ({ text: valid.queries[0].text })) },
      { ...valid, queries: [{ text: "short" }] }, { ...valid, queries: [{ text: "x".repeat(201) }] },
      { ...valid, events: [event({ contentLength: 100, nextOffset: 100 })] },
      { ...valid, modelConfig: { researchEvidenceContract: { ...modelConfig.researchEvidenceContract, requiredPrimarySources: [...modelConfig.researchEvidenceContract.requiredPrimarySources, { id: "r1", label: "R1", urls: ["https://arxiv.org/html/2501.12948v1"] }] } } },
    ]) {
      const result = await selectWorkshopResearchQuotes(input);
      expect(result.candidates).toEqual([]); expect(result.gaps).not.toEqual([]);
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("fails closed on agent-authored, conflicting or low quality source receipts", async () => {
    const valid = selectionInput();
    for (const events of [[event({ receiptAuthority: "agent" })], [event({ qualityScore: 54 })], [event(), event({ contentHash: "a".repeat(64) })]]) {
      const result = await selectWorkshopResearchQuotes({ ...valid, events });
      expect(result.candidates).toEqual([]); expect(result.gaps).not.toEqual([]);
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("does not recover a quote across two windows whose union fully covers the page", async () => {
    const split = content.indexOf("64.2");
    const events = [event({ contentLength: split, nextOffset: split }), { ...event({ offset: split, contentLength: content.length - split }), id: "tail" }];
    const result = await selectWorkshopResearchQuotes({ ...selectionInput(), events });
    expect(result.candidates).toEqual([]); expect(result.gaps.join(" ")).toContain("窗口");
  });

  it("deduplicates repeated reads and identical queries, but rejects identical passages ambiguous within a window", async () => {
    const valid = selectionInput();
    const result = await selectWorkshopResearchQuotes({ ...valid, events: [event(), { ...event(), id: "duplicate" }], queries: [valid.queries[0], valid.queries[0]] });
    expect(result.candidates).toHaveLength(1);
    const repeated = `${content}\n\n${exact}`; const hash = digest(repeated);
    load.mockResolvedValue({ snapshot: { ...snapshot(), content: repeated, contentHash: hash } });
    const ambiguous = await selectWorkshopResearchQuotes({ ...valid, events: [event({ contentHash: hash, contentLength: repeated.length, totalChars: repeated.length })] });
    expect(ambiguous.candidates).toEqual([]); expect(ambiguous.gaps).not.toEqual([]);
  });

  it("recomputes the cached body hash and never refetches unavailable or tampered snapshots", async () => {
    for (const value of [{ ...snapshot(), content: content.replace("64.2", "99.9") }, { ...snapshot(), evidenceId: "other" }, { ...snapshot(), url: "https://example.com/other" }]) {
      load.mockResolvedValueOnce({ snapshot: value });
      expect((await selectWorkshopResearchQuotes(selectionInput())).candidates).toEqual([]);
    }
    load.mockRejectedValueOnce(new Error("missing cache"));
    const result = await selectWorkshopResearchQuotes(selectionInput());
    expect(result.candidates).toEqual([]); expect(result.gaps).not.toEqual([]);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("bounds comparison context by 160 characters and the selected actual read window", async () => {
    const start = content.indexOf(exact), end = start + exact.length;
    const events = [event({ contentLength: start, nextOffset: start }),
      { ...event({ offset: start, contentLength: exact.length, nextOffset: end }), id: "middle" },
      { ...event({ offset: end, contentLength: content.length - end }), id: "tail" }];
    const selected = await selectWorkshopResearchQuotes({ ...selectionInput(), events });
    expect(selected.candidates).toHaveLength(1);
    expect(selected.candidates[0]).toMatchObject({ sourceEventId: "middle", quote: exact, precedingText: "", followingText: "" });
    expect(selected.candidates[0].precedingText.length).toBeLessThanOrEqual(160);
    expect(selected.candidates[0].followingText.length).toBeLessThanOrEqual(160);
  });
});

describe("bounded source-only alternatives for unmatched literal needles", () => {
  beforeEach(() => load.mockReset().mockResolvedValue({ snapshot: snapshot() }));

  it("keeps a false numeric needle unmatched while offering the original source sentence as an explicitly different suggestion", async () => {
    const args = selectionInput(); args.queries[0].text = "DeepSeekMath-Base 7B achieves 61.9% on GSM8K";
    const before = JSON.stringify(args);
    const result = await selectWorkshopResearchQuotes(args);
    expect(result.candidates).toEqual([]);
    expect(result.gaps.length).toBeGreaterThan(0);
    expect(result.alternativeCandidates).toHaveLength(1);
    expect(result.alternativeCandidates[0]).toMatchObject({ ...candidate(), selectionKind: "alternative", matchMode: "term_overlap_suggestion" });
    expect(result.alternativeCandidates[0].quote).not.toContain("61.9");
    expect(result.semanticStatus).toBe("not_independently_verified");
    expect(result).not.toHaveProperty("ok"); expect(result).not.toHaveProperty("supported");
    expect(JSON.stringify(args)).toBe(before);
  });

  it("does not rank pure numeric overlap or unrelated stop words as supporting retrieval", async () => {
    for (const text of ["99.9% 64.2% 2024 12345", "and the a of in at for from to with", "ultraviolet telescope galaxy brightness"]) {
      const result = await selectWorkshopResearchQuotes({ ...selectionInput(), queries: [{ text }] });
      expect(result.candidates).toEqual([]);
      expect(result.alternativeCandidates).toEqual([]);
      expect(result.gaps.length).toBeGreaterThan(0);
    }
  });

  it("never substitutes alternatives for genuine literals or consumes their existing six-candidate bound", async () => {
    const result = await selectWorkshopResearchQuotes(selectionInput());
    expect(result.candidates).toHaveLength(1); expect(result.candidates[0].quote).toBe(exact);
    expect(result.alternativeCandidates).toEqual([]); expect(result.gaps).toEqual([]);
    const mixed = await selectWorkshopResearchQuotes({ ...selectionInput(), queries: [selectionInput().queries[0], { text: "training procedure uses a critic 61.9" }] });
    expect(mixed.candidates[0].quote).toBe(exact);
    expect(mixed.alternativeCandidates[0]).toMatchObject({ queryIndex: 1, quote: method, selectionKind: "alternative", matchMode: "term_overlap_suggestion" });
    expect(mixed.candidates.length + mixed.alternativeCandidates.length).toBeLessThanOrEqual(6);
  });

  it("caps each unmatched query at two alternatives, deduplicates spans and caps the entire response at six", async () => {
    const sentences = Array.from({ length: 8 }, (_, index) => `Candidate ${index} discusses benchmark evaluation results under a distinct experimental setting, keeping its original comparison scope.`);
    const body = `## 1 Results\n\n${sentences.join("\n\n")}`; const bodyHash = digest(body);
    load.mockResolvedValue({ snapshot: { ...snapshot(), content: body, contentHash: bodyHash } });
    const result = await selectWorkshopResearchQuotes({ ...selectionInput(), events: [event({ contentHash: bodyHash, totalChars: body.length, contentLength: body.length })],
      queries: Array.from({ length: 3 }, (_, index) => ({ text: `benchmark evaluation results invented ${index}` })) });
    expect(result.candidates).toEqual([]); expect(result.alternativeCandidates).toHaveLength(6);
    for (const queryIndex of [0, 1, 2]) expect(result.alternativeCandidates.filter(value => value.queryIndex === queryIndex)).toHaveLength(2);
    expect(new Set(result.alternativeCandidates.map(value => `${value.offset}:${value.endOffset}`)).size).toBe(6);
    for (const selected of result.alternativeCandidates) {
      expect(selected.quote).toBe(body.slice(selected.offset, selected.endOffset));
      expect(selected.quoteHash).toBe(digest(selected.quote));
      expect(selected.precedingText.length).toBeLessThanOrEqual(160); expect(selected.followingText.length).toBeLessThanOrEqual(160);
    }
  });

  it("preserves all six genuine literals before spending any slot on alternatives", async () => {
    const rows = ["Alpha", "Beta", "Gamma"].flatMap(group => Array.from({ length: 2 }, (_, index) =>
      `Experiment ${index} reports benchmark evaluation setting ${group}, retaining the exact observed comparison and its limitations.`));
    const body = `## 1 Results\n\n${rows.join("\n\n")}`; const bodyHash = digest(body);
    load.mockResolvedValue({ snapshot: { ...snapshot(), content: body, contentHash: bodyHash } });
    const result = await selectWorkshopResearchQuotes({ ...selectionInput(), events: [event({ contentHash: bodyHash, totalChars: body.length, contentLength: body.length })],
      queries: ["Alpha", "Beta", "Gamma"].map(group => ({ text: `benchmark evaluation setting ${group}` })) });
    expect(result.candidates).toHaveLength(6); expect(result.alternativeCandidates).toEqual([]);
    expect(result.gaps).toEqual([]);
    expect(result.candidates.map(value => value.queryIndex)).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it("retrieves Chinese source terms without translating, editing punctuation or borrowing the query's fabricated score", async () => {
    const exactChinese = "研究团队通过策略优化改进奖励模型，并在统一评测设置下分析模型表现；所有比较仅限于本文记录的数据范围、评测条件和实验对象。";
    const body = `## 1 研究结果\n\n${exactChinese}`; const bodyHash = digest(body);
    load.mockResolvedValue({ snapshot: { ...snapshot(), content: body, contentHash: bodyHash } });
    const result = await selectWorkshopResearchQuotes({ ...selectionInput(), events: [event({ contentHash: bodyHash, totalChars: body.length, contentLength: body.length })],
      queries: [{ text: "研究团队通过策略优化使奖励模型取得99.9%的整体提升" }] });
    expect(result.candidates).toEqual([]); expect(result.alternativeCandidates).toHaveLength(1);
    expect(result.alternativeCandidates[0]).toMatchObject({ quote: exactChinese, quoteHash: digest(exactChinese), matchMode: "term_overlap_suggestion" });
    expect(result.alternativeCandidates[0].quote).not.toContain("99.9");
    expect(result.gaps.length).toBeGreaterThan(0);
  });

  it("applies the same scope, hash, single-window and unique-location restrictions to alternatives", async () => {
    const args = { ...selectionInput(), queries: [{ text: "DeepSeekMath-Base 7B achieves 61.9% on GSM8K" }] };
    const split = content.indexOf("64.2");
    for (const input of [
      { ...args, runId: "other" }, { ...args, events: [event({ receiptAuthority: "agent" })] },
      { ...args, events: [event({ contentLength: split, nextOffset: split }), { ...event({ offset: split, contentLength: content.length - split }), id: "tail" }] },
    ]) {
      const result = await selectWorkshopResearchQuotes(input);
      expect(result.candidates).toEqual([]); expect(result.alternativeCandidates).toEqual([]);
    }
    load.mockResolvedValueOnce({ snapshot: { ...snapshot(), content: content.replace("64.2", "61.9") } });
    expect((await selectWorkshopResearchQuotes(args)).alternativeCandidates).toEqual([]);
    const repeated = `${content}\n\n${exact}`, repeatedHash = digest(repeated);
    load.mockResolvedValueOnce({ snapshot: { ...snapshot(), content: repeated, contentHash: repeatedHash } });
    const ambiguous = await selectWorkshopResearchQuotes({ ...args, events: [event({ contentHash: repeatedHash, totalChars: repeated.length, contentLength: repeated.length })] });
    expect(ambiguous.alternativeCandidates).toEqual([]);
  });

  it("can resolve a persisted alternative reference but the original numeric final gate still rejects the unchanged false claim", async () => {
    const selected = await selectWorkshopResearchQuotes({ ...selectionInput(), queries: [{ text: "DeepSeekMath-Base 7B achieves 61.9% on GSM8K" }] });
    expect(selected.alternativeCandidates).toHaveLength(1);
    const args = resolutionInput(); (args.events[1].metadata as { candidates: object[] }).candidates = selected.alternativeCandidates;
    const raw = { researchEvidence: { reportVersion: "grounded-report/v1", works: [{ sourceId: "math", supportedClaims: [
      { kind: "method", claim: "论文报告了数学基准的评测设置。", quoteRef: { selectionEventId: "selected", index: 0 } },
      { kind: "experiment", claim: "DeepSeekMath-Base 7B 在 GSM8K 达到 61.9%。", quoteRef: { selectionEventId: "selected", index: 0 } },
      { kind: "limitation", claim: "比较结论限于原文所报告的评测设置。", quoteRef: { selectionEventId: "selected", index: 0 } },
    ] }], gaps: [] } };
    const resolved = resolveWorkshopResearchQuoteRefs(raw, args);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const gate = verifyAndBuildGroundedResearchReport({ ...args, report: resolved.report });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.issues.join(" ")).toContain("61.9%");
    expect(raw.researchEvidence.works[0].supportedClaims[1].claim).toContain("61.9%");
  });
});

describe("quote references resolve into the unchanged strict report gate", () => {
  beforeEach(() => load.mockReset());
  it("restores exact quote and receipt, derives a true locator, and leaves claim and input untouched", () => {
    const raw = report(); const before = JSON.stringify(raw);
    const result = resolveWorkshopResearchQuoteRefs(raw, resolutionInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const claim = (result.report as ReturnType<typeof report>).researchEvidence.works[0].supportedClaims[0];
    expect(claim).toEqual({ kind: "experiment", claim: raw.researchEvidence.works[0].supportedClaims[0].claim, quote: exact, evidenceEventId: "read", locator: "1 Introduction" });
    expect(JSON.stringify(raw)).toBe(before);
    expect(load).not.toHaveBeenCalled();
  });

  it("keeps an explicit owner/model locator for the original gate to reject instead of silently repairing it", () => {
    const raw = report(); Object.assign(raw.researchEvidence.works[0].supportedClaims[0], { locator: "Section 99" });
    const result = resolveWorkshopResearchQuoteRefs(raw, resolutionInput());
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.report as ReturnType<typeof report>).researchEvidence.works[0].supportedClaims[0]).toHaveProperty("locator", "Section 99");
  });

  it("does not parse wrappers or rewrite ordinary legacy reports", () => {
    expect(resolveWorkshopResearchQuoteRefs("prefix {\"researchEvidence\":{}}", resolutionInput())).toEqual({ ok: true, report: "prefix {\"researchEvidence\":{}}" });
    const legacy = { researchEvidence: { works: [{ supportedClaims: [{ kind: "method", quote: exact, evidenceEventId: "read", claim: "unchanged", locator: "Section 1" }] }] } };
    expect(resolveWorkshopResearchQuoteRefs(legacy, resolutionInput())).toEqual({ ok: true, report: legacy });
  });

  it("rejects mixed or malformed refs, missing rows and invalid indexes without guessing", () => {
    for (const extra of [
      { quote: exact }, { evidenceEventId: "read" }, { quoteRef: { selectionEventId: "missing", index: 0 } },
      { quoteRef: { selectionEventId: "selected", index: -1 } }, { quoteRef: { selectionEventId: "selected", index: 1 } },
      { quoteRef: { selectionEventId: "selected", index: 0, offset: 0 } }, { quoteRef: "selected:0" },
    ]) {
      const raw = report(); Object.assign(raw.researchEvidence.works[0].supportedClaims[0], extra);
      expect(resolveWorkshopResearchQuoteRefs(raw, resolutionInput()).ok).toBe(false);
    }
  });

  it("rejects cross run/work, forged, conflicting and wrong type selection events", () => {
    for (const alter of [
      (value: WorkshopResearchEvidenceEvent) => ({ ...value, runId: "other" }),
      (value: WorkshopResearchEvidenceEvent) => ({ ...value, type: "agent_text" }),
      (value: WorkshopResearchEvidenceEvent) => ({ ...value, metadata: { ...(value.metadata as object), workshopId: "other" } }),
      (value: WorkshopResearchEvidenceEvent) => ({ ...value, metadata: { ...(value.metadata as object), receiptAuthority: "agent" } }),
      (value: WorkshopResearchEvidenceEvent) => ({ ...value, metadata: { ...(value.metadata as object), version: "other" } }),
    ]) {
      const input = resolutionInput(); input.events[1] = alter(input.events[1]);
      expect(resolveWorkshopResearchQuoteRefs(report(), input).ok).toBe(false);
    }
    const input = resolutionInput(); input.events.push({ ...selectionEvent(), metadata: { ...(selectionEvent().metadata as object), candidates: [] } });
    expect(resolveWorkshopResearchQuoteRefs(report(), input).ok).toBe(false);
  });

  it("rejects tampered candidate quote/hash/range/heading/identity and source receipt bounds", () => {
    for (const patch of [
      { quote: exact.replace("[^9]", "") }, { quoteHash: "a".repeat(64) }, { contentHash: "a".repeat(64) },
      { offset: candidate().offset - 1 }, { endOffset: candidate().endOffset + 1 }, { sourceId: "other" },
      { evidenceId: "other" }, { sourceEventId: "missing" }, { headingPath: ["99 Invented"] }, { locator: "99 Invented" },
      { precedingText: "Invented comparison conditions" }, { followingText: "Invented baseline details" },
    ]) {
      const input = resolutionInput(); (input.events[1].metadata as { candidates: object[] }).candidates = [{ ...candidate(), ...patch }];
      expect(resolveWorkshopResearchQuoteRefs(report(), input).ok).toBe(false);
    }
    const input = resolutionInput(); input.events[0] = event({ contentLength: 20, nextOffset: 20 });
    expect(resolveWorkshopResearchQuoteRefs(report(), input).ok).toBe(false);
  });

  it("rejects unread coverage, duplicate source identity and tampered/ambiguous body without adding coverage", () => {
    for (const alter of [
      (input: ReturnType<typeof resolutionInput>) => { input.coverage[0].status = "incomplete"; },
      (input: ReturnType<typeof resolutionInput>) => { input.coverage.push(source()); },
      (input: ReturnType<typeof resolutionInput>) => { input.snapshots[0].content = content.replace("64.2", "99.9"); },
      (input: ReturnType<typeof resolutionInput>) => { input.events.push({ ...event(), metadata: { ...(event().metadata as object), contentHash: "a".repeat(64) } }); },
    ]) {
      const input = resolutionInput(); alter(input); const before = JSON.stringify(input.coverage);
      expect(resolveWorkshopResearchQuoteRefs(report(), input).ok).toBe(false);
      expect(JSON.stringify(input.coverage)).toBe(before);
    }
  });

  it("rejects a restored passage that is repeated within its selected source window", () => {
    const input = resolutionInput();
    const repeated = `${content}\n\n${exact}`; const repeatedHash = digest(repeated);
    input.snapshots[0] = { ...snapshot(), content: repeated, contentHash: repeatedHash };
    input.coverage[0] = { ...source(), totalChars: repeated.length, coveredChars: repeated.length, contentHash: repeatedHash };
    input.events[0] = event({ contentHash: repeatedHash, totalChars: repeated.length, contentLength: repeated.length });
    (input.events[1].metadata as { candidates: object[] }).candidates = [{ ...candidate(), contentHash: repeatedHash,
      followingText: repeated.slice(candidate().endOffset, candidate().endOffset + 160) }];
    expect(resolveWorkshopResearchQuoteRefs(report(), input).ok).toBe(false);
  });

  it("preserves unsupported numbers, bad locators and unknown fields for strict final validation instead of approving or rewriting them", () => {
    const raw = report();
    Object.assign(raw.researchEvidence.works[0].supportedClaims[0], { claim: "DeepSeekMath-Base 7B 达到 99.9%。", locator: "Section 99", unknownField: true });
    const result = resolveWorkshopResearchQuoteRefs(raw, resolutionInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.report as ReturnType<typeof report>).researchEvidence.works[0].supportedClaims[0]).toMatchObject({ claim: "DeepSeekMath-Base 7B 达到 99.9%。", locator: "Section 99", unknownField: true, quote: exact });
      expect(result).not.toHaveProperty("verified");
    }
  });
});
