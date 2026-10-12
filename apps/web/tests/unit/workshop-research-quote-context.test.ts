import { describe, expect, it } from "vitest";
import { verifyAndBuildGroundedResearchReport, type GroundedResearchReportInput } from "@/lib/workshops/grounded-research-report";
import { locateResearchQuoteContext, researchQuoteLocatorIssue } from "@/lib/workshops/research-quote-context";

const quote = "DeepSeek-R1-Zero, a model trained via large-scale reinforcement learning (RL) without supervised fine-tuning (SFT) as a preliminary step, demonstrates remarkable reasoning capabilities.";
const scaling = "demonstrating the effectiveness of inference-time scaling of DeepSeek-GRM-27B compared to scaling model sizes";
const scalingContext = `The models are tested on the Reward Bench with the compared model sizes and sampling settings. This experiment is ${scaling}.`;
function fixture(methodClaim = "作者报告在基座上直接进行 RL，不先做监督微调（SFT）。", locator = "Abstract"): GroundedResearchReportInput {
  const content = `# Paper\n\n## Abstract\n\n${quote}\n\n## 1 Introduction\n\nThe experiments have specific evaluation conditions.\n\n## 5.2 Results and Analysis\n\n${scalingContext}\n\n## Appendix B Limitations and Future Directions\n\nThe efficiency of the generative reward models limits large-scale online use.`;
  const sourceId = "paper", runId = "run", evidenceId = "snapshot", eventId = "event", url = "https://papers.example.com/paper/v1", contentHash = "a".repeat(64);
  return { runId, report: { researchEvidence: { reportVersion: "grounded-report/v1", gaps: [], works: [{ sourceId,
    supportedClaims: [
      { kind: "method", claim: methodClaim, locator, quote, evidenceEventId: eventId },
      { kind: "experiment", claim: "作者在本文设置下观察到 DeepSeek-GRM-27B 推理时扩展的有效性。", locator: "Section 5.2", quote: scaling, evidenceEventId: eventId },
      { kind: "limitation", claim: "作者指出生成式奖励模型的大规模在线使用受到效率限制。", locator: "Appendix B", quote: "The efficiency of the generative reward models limits large-scale online use.", evidenceEventId: eventId },
    ] }] } },
    coverage: [{ sourceId, label: "Paper", urls: [url], status: "complete", evidenceId, contentHash, totalChars: content.length, coveredChars: content.length, eventIds: [eventId] }],
    events: [{ id: eventId, runId, type: "source_checked", metadata: { receiptAuthority: "runtime", toolName: "webReadPage", method: "jina_defuddle", ok: true, url,
      evidenceId, contentHash, offset: 0, contentLength: content.length, totalChars: content.length, nextOffset: null, qualityScore: 80 } }],
    snapshots: [{ sourceId, evidenceId, contentHash, url, content }] };
}

describe("research quote context at the real grounded-report gate", () => {
  it("rejects the observed SFT-as-pretraining mistake even when its quote is real", () => {
    const input = fixture("DeepSeek-R1-Zero 不经过 SFT 预训练步骤，通过大规模 RL 展现推理能力。");
    const result = verifyAndBuildGroundedResearchReport(input);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("监督微调");
  });
  it("rejects a Section 1 locator for the actual Abstract quotation", () => {
    const result = verifyAndBuildGroundedResearchReport(fixture(undefined, "Section 1"));
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("Abstract");
    expect(result.issues.join(" ")).toContain("定位");
  });
  it("preserves supported terminology and the host-observed chapter and experiment context", () => {
    const result = verifyAndBuildGroundedResearchReport(fixture());
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(result.issues.join(" "));
    expect(result.structured.presentation.reportMarkdown).toContain("证据语境");
    expect(result.structured.presentation.reportMarkdown).toContain("Reward Bench");
    expect(result.structured.presentation.reportMarkdown).toContain("sampling settings");
    expect(result.structured.presentation.reportMarkdown).toContain("Abstract");
  });
  it("does not confuse an explicit distinction between SFT and pretraining with the mistake", () => {
    expect(verifyAndBuildGroundedResearchReport(fixture("监督微调（SFT）不是预训练；作者报告在已预训练基座上直接 RL。")).ok).toBe(true);
  });
  it("maps original offsets under whitespace normalization and cannot match altered punctuation", () => {
    const body = "## 2 Method\n\nThis [^1] is an exact\n excerpt with punctuation (A+B).\n\nOther text.";
    const context = locateResearchQuoteContext(body, "This [^1] is an exact excerpt with punctuation (A+B).", { offset: 0, endOffset: body.length });
    expect(context?.heading).toBe("2 Method");
    expect(body.slice(context!.start, context!.end)).toContain("exact\n excerpt");
    expect(locateResearchQuoteContext(body, "This is an exact excerpt with punctuation (A+B).", { offset: 0, endOffset: body.length })).toBeNull();
    expect(locateResearchQuoteContext(body, "This [^1] is an exact excerpt with punctuation (AxB).", { offset: 0, endOffset: body.length })).toBeNull();
  });
  it("does not assign a favorable section to ambiguous repeated passages", () => {
    const body = `## 1 Method\n\n${quote}\n\n## 2 Experiment\n\n${quote}`;
    expect(locateResearchQuoteContext(body, quote, { offset: 0, endOffset: body.length })).toBeNull();
  });
  it("rejects overlapping duplicate passages without inventing a unique position", () => {
    const body = `## 1 Method\n\n${"a".repeat(41)}`;
    expect(locateResearchQuoteContext(body, "a".repeat(40), { offset: 0, endOffset: body.length })).toBeNull();
    const unicode = `## 1 Method\n\n🦊 unique quotation with complete source words.`;
    expect(locateResearchQuoteContext(unicode, "🦊 unique quotation with complete source words.", { offset: 0, endOffset: unicode.length })?.heading).toBe("1 Method");
  });
  it("rejects the full gate when repeated source text cannot support the claimed location", () => {
    const input = fixture(undefined, "Section 99");
    const snapshot = { ...input.snapshots[0], content: `${input.snapshots[0].content}\n\n## 6 Repeat\n\n${quote}` };
    input.snapshots = [snapshot];
    input.coverage = [{ ...input.coverage[0], coveredChars: snapshot.content.length, totalChars: snapshot.content.length }];
    input.events = [{ ...input.events[0], metadata: { ...input.events[0].metadata as object, totalChars: snapshot.content.length, contentLength: snapshot.content.length } }];
    const result = verifyAndBuildGroundedResearchReport(input);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("无法唯一定位");
  });
  it("permits an enclosing section but rejects an unrelated abstract or section", () => {
    const body = `## 4 Method\n\n### 4.1 Algorithm\n\n#### 4.1.1 Learning\n\n${quote}`;
    const context = locateResearchQuoteContext(body, quote, { offset: 0, endOffset: body.length })!;
    expect(researchQuoteLocatorIssue("Section 4", context)).toBeNull();
    expect(researchQuoteLocatorIssue("Section 4.1.1", context)).toBeNull();
    expect(researchQuoteLocatorIssue("Section 4.2", context)).toContain("不对应");
    expect(researchQuoteLocatorIssue("Abstract", context)).toContain("不对应");
  });
  it("never expands displayed paragraph text beyond the cited reading window", () => {
    const body = `## Abstract\n\nUnread prefix. ${quote} Unread suffix.`;
    const offset = body.indexOf(quote), endOffset = offset + quote.length;
    const context = locateResearchQuoteContext(body, quote, { offset, endOffset })!;
    expect(context.paragraph).toBe(quote);
    expect(context.paragraphTruncated).toBe(true);
    expect(context.paragraph).not.toContain("Unread");
    expect(locateResearchQuoteContext(body, quote, { offset, endOffset: endOffset - 1 })).toBeNull();
  });
});
