import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const load = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/jina-page-reader", () => ({ loadWebEvidence: load }));
import { suggestWorkshopResearchQuoteCorrections, workshopResearchSourceWindows } from "@/lib/workshops/research-evidence-correction";
import type { WorkshopResearchEvidenceEvent, WorkshopResearchSourceCoverage } from "@/lib/workshops/research-evidence-verification";

const url = "https://arxiv.org/html/2402.03300v3";
const exact = "The evaluation results indicate that the large-scale corpus is of high quality, as our base model DeepSeekMath-Base 7B achieves 64.2% on GSM8K [^9] and 36.2% on the competition-level MATH dataset [^17], outperforming Minerva 540B [^25].";
const content = `## 1 Introduction\n\n${exact}\n\nAnother reported experiment uses the DeepSeekMath-Base model and compares GSM8K and MATH benchmark performance.\n\nAnother DeepSeekMath-Base experiment reports GSM8K observations under different data settings, with limitations on comparison.`;
const hash = createHash("sha256").update(content).digest("hex");
const coverage = (): WorkshopResearchSourceCoverage => ({ sourceId: "deepseek-math", label: "DeepSeekMath", urls: [url], status: "complete", evidenceId: "snapshot", contentHash: hash, totalChars: content.length, coveredChars: content.length, eventIds: ["event"] });
const event = (overrides: Record<string, unknown> = {}): WorkshopResearchEvidenceEvent => ({ id: "event", runId: "run", type: "source_checked", metadata: { receiptAuthority: "runtime", toolName: "webReadPage", method: "jina_defuddle", ok: true, url, finalUrl: url, evidenceId: "snapshot", contentHash: hash, qualityScore: 80, offset: 0, contentLength: content.length, totalChars: content.length, nextOffset: null, ...overrides } });
const claim = () => ({ kind: "experiment", claim: "DeepSeekMath-Base 7B 在GSM8K达64.2%，MATH达36.2%，超过Minerva 540B。", locator: "Section 1", quote: "DeepSeekMath-Base 7B achieves 64.2% on GSM8K and 36.2% on the competition-level MATH dataset, outperforming Minerva 540B", evidenceEventId: "event" });
const input = () => ({ workshopId: "work", runId: "run", report: { researchEvidence: { works: [{ sourceId: "deepseek-math", supportedClaims: [claim()] }] } }, issues: ["必读来源 deepseek-math 第 1 条结论 的短摘未完整出现在所引用的同版正文窗口中。"], coverage: [coverage()], events: [event()] });

describe("owned body correction suggestions remain separate from approval", () => {
  beforeEach(() => load.mockReset().mockResolvedValue({ snapshot: { evidenceId: "snapshot", contentHash: hash, url, content } }));

  it("returns exact single-window slices with true section and bounded surrounding context, leaving input untouched", async () => {
    const args = input(); const original = JSON.stringify(args);
    const result = await suggestWorkshopResearchQuoteCorrections(args);
    expect(result.candidates[0].quote).toBe(exact);
    expect(result.candidates[0].sectionHeading).toBe("## 1 Introduction");
    for (const candidate of result.candidates) {
      expect(candidate.quote).toBe(content.slice(candidate.offset, candidate.endOffset));
      expect(candidate.quote.length).toBeGreaterThanOrEqual(40);
      expect(candidate.quote.length).toBeLessThanOrEqual(600);
      expect(candidate.precedingText.length).toBeLessThanOrEqual(100);
      expect(candidate.followingText.length).toBeLessThanOrEqual(100);
      expect(candidate.eventId).toBe("event"); expect(candidate.contentHash).toBe(hash);
      expect(candidate.relatedCandidateCount).toBeGreaterThanOrEqual(candidate.candidateCount);
    }
    expect(JSON.stringify(args)).toBe(original);
  });

  it("does not turn an invented number into a retrieved number or approve it", async () => {
    const args = input(); args.report.researchEvidence.works[0].supportedClaims[0].claim = "DeepSeekMath-Base 7B 在GSM8K达99.9%。";
    const result = await suggestWorkshopResearchQuoteCorrections(args);
    expect(result.candidates).not.toHaveLength(0);
    for (const candidate of result.candidates) {
      expect(candidate.quote).not.toContain("99.9%");
      expect(candidate.missingClaimNumbers).toContain("99.9%");
    }
    expect(args.report.researchEvidence.works[0].supportedClaims[0].claim).toContain("99.9%");
    expect(result).not.toHaveProperty("ok");
  });

  it("fails closed when content, evidence identity, length or source URL differs, without refetching", async () => {
    for (const snapshot of [
      { evidenceId: "snapshot", contentHash: hash, url, content: content.replace("64.2", "99.9") },
      { evidenceId: "other", contentHash: hash, url, content },
      { evidenceId: "snapshot", contentHash: hash, url, content: `${content} extra` },
      { evidenceId: "snapshot", contentHash: hash, url: "https://example.com/other", content },
    ]) {
      load.mockResolvedValueOnce({ snapshot });
      const result = await suggestWorkshopResearchQuoteCorrections(input());
      expect(result.candidates).toEqual([]); expect(result.warnings.join(" ")).toContain("身份校验失败");
    }
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("never suggests a quote that spans two receipts, even when their union covers the whole body", async () => {
    const args = input(); const split = content.indexOf("64.2");
    args.events = [event({ contentLength: split, nextOffset: split }), { ...event({ offset: split, contentLength: content.length - split }), id: "tail" }];
    args.coverage[0].eventIds.push("tail");
    const result = await suggestWorkshopResearchQuoteCorrections(args);
    expect(result.candidates.some(candidate => candidate.quote === exact)).toBe(false);
    for (const candidate of result.candidates) {
      const receipt = args.events.find(observed => observed.id === candidate.eventId)!;
      const metadata = receipt.metadata as Record<string, number>;
      expect(candidate.offset).toBeGreaterThanOrEqual(metadata.offset);
      expect(candidate.endOffset).toBeLessThanOrEqual(metadata.offset + metadata.contentLength);
    }
  });

  it("excludes stale, agent-authored, hash/URL/range/quality-invalid and conflicting event identities", async () => {
    const args = input(); args.events = [
      { ...event(), runId: "other" }, event({ receiptAuthority: "agent" }), event({ contentHash: "a".repeat(64) }),
      event({ url: "https://example.com/other" }), event({ offset: -1 }), event({ qualityScore: 54 }),
      event(), event({ finalUrl: "https://example.com/other" }),
    ];
    expect(workshopResearchSourceWindows(args.coverage[0], args.events, "run")).toEqual([]);
    expect((await suggestWorkshopResearchQuoteCorrections(args)).candidates).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it("includes duplicate reads but does not expose a later window outside proved contiguous coverage", () => {
    const source = coverage(); source.coveredChars = 120; source.status = "incomplete";
    const events = [event({ contentLength: 120, nextOffset: 120 }), { ...event({ contentLength: 120, nextOffset: 120 }), id: "duplicate" },
      { ...event({ offset: 150, contentLength: content.length - 150 }), id: "jump" }];
    expect(workshopResearchSourceWindows(source, events, "run").map(window => window.eventId)).toEqual(["event", "duplicate"]);
  });

  it("caps total candidates at four, prioritizes different failed claims, and explicitly reports omissions", async () => {
    const args = input(); args.report.researchEvidence.works[0].supportedClaims = Array.from({ length: 9 }, claim);
    args.issues = Array.from({ length: 9 }, (_, index) => `必读来源 deepseek-math 第 ${index + 1} 条结论 短摘未完整。`);
    const result = await suggestWorkshopResearchQuoteCorrections(args);
    expect(result.candidates).toHaveLength(4);
    expect(result.candidates.map(candidate => candidate.claimIndex)).toEqual([1, 2, 3, 4]);
    expect(result.candidates.every(candidate => candidate.candidateCount === 1)).toBe(true);
    expect(result.candidates[0].omittedCandidateCount).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).toContain("另有 5 条失败结论未列候选");
  });

  it("rotates sources before adding second choices so multiple Math errors do not suppress R1 feedback", async () => {
    const args = input(); const r1Url = "https://arxiv.org/html/2501.12948v1";
    const r1Content = "## 1 Introduction\n\nDeepSeek-R1 achieves a score of 79.8% Pass@1 on AIME 2024, slightly surpassing OpenAI-o1-1217.\n\nDeepSeek-R1 shows strong benchmark performance on AIME 2024 under the reported evaluation settings.";
    const r1Hash = createHash("sha256").update(r1Content).digest("hex");
    load.mockImplementation(async (_scope, evidenceId) => ({ snapshot: evidenceId === "r1-snapshot"
      ? { evidenceId, contentHash: r1Hash, url: r1Url, content: r1Content }
      : { evidenceId, contentHash: hash, url, content } }));
    args.report.researchEvidence.works[0].supportedClaims = [claim(), claim(), claim()];
    args.report.researchEvidence.works.push({ sourceId: "deepseek-r1", supportedClaims: Array.from({ length: 3 }, () => ({ kind: "experiment", claim: "DeepSeek-R1 在AIME 2024达79.8%", locator: "Section 1", quote: "DeepSeek-R1 shows strong benchmark performance on AIME 2024 under the reported evaluation settings.", evidenceEventId: "r1-event" })) });
    args.coverage.push({ ...coverage(), sourceId: "deepseek-r1", label: "R1", urls: [r1Url], evidenceId: "r1-snapshot", contentHash: r1Hash, totalChars: r1Content.length, coveredChars: r1Content.length, eventIds: ["r1-event"] });
    args.events.push({ ...event({ evidenceId: "r1-snapshot", contentHash: r1Hash, url: r1Url, finalUrl: r1Url, contentLength: r1Content.length, totalChars: r1Content.length }), id: "r1-event" });
    args.issues = ["deepseek-math", "deepseek-r1"].flatMap(sourceId => Array.from({ length: 3 }, (_, index) => `必读来源 ${sourceId} 第 ${index + 1} 条结论 短摘或数字未对应。`));
    const result = await suggestWorkshopResearchQuoteCorrections(args);
    expect(result.candidates.map(candidate => [candidate.sourceId, candidate.claimIndex])).toEqual([
      ["deepseek-math", 1], ["deepseek-r1", 1], ["deepseek-math", 2], ["deepseek-r1", 2],
    ]);
    expect(result.candidates.filter(candidate => candidate.sourceId === "deepseek-r1").every(candidate => candidate.quote.includes("79.8%"))).toBe(true);
    expect(result.warnings.join(" ")).toContain("另有 2 条失败结论未列候选");
  });

  it("does no owned snapshot reads on overflow, missing parsed report, incomplete coverage or oversized body", async () => {
    const args = input();
    expect((await suggestWorkshopResearchQuoteCorrections({ ...args, eventsOverflow: true })).candidates).toEqual([]);
    expect((await suggestWorkshopResearchQuoteCorrections({ ...args, report: null })).candidates).toEqual([]);
    args.coverage[0].status = "incomplete";
    expect((await suggestWorkshopResearchQuoteCorrections(args)).candidates).toEqual([]);
    args.coverage[0].status = "complete"; args.coverage[0].totalChars = 2 * 1024 * 1024 + 1;
    expect((await suggestWorkshopResearchQuoteCorrections(args)).candidates).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });
});
