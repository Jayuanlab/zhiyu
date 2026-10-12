import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Markdown } from "@/components/markdown";
import { verifyAndBuildGroundedResearchReport, type GroundedResearchReportInput } from "@/lib/workshops/grounded-research-report";

const method = "The scheduling method estimates waiting time from observed queue lengths.";
const experiment = "Queue-Model-7B achieves 72.6% accuracy on QueueBench 2024 in the reported test.";
const limitation = "The study does not evaluate workloads outside the observed queue distribution.";
const body = [method, experiment, limitation].join("\n\n");
const eventId = "e4f2b0c8-443e-4e4d-9ae3-62e4c188c0bb";
const sourceId = "queue-study";
const url = "https://papers.example.com/queue-study-v1";
const evidenceId = "queue-study-snapshot";
const contentHash = "a".repeat(64);
vi.mock("@/lib/tauri", () => ({ openUrl: vi.fn() }));

function fixture(): GroundedResearchReportInput {
  return { runId: "reader-run", report: { researchEvidence: { reportVersion: "grounded-report/v1", gaps: [], works: [{
    sourceId, supportedClaims: [
      { kind: "method", claim: "该调度方法从观测到的队列长度估计等待时间。", quote: method, locator: "正文", evidenceEventId: eventId },
      { kind: "experiment", claim: "Queue-Model-7B 在 QueueBench 2024 测试中准确率为 72.6%。", quote: experiment, locator: "正文", evidenceEventId: eventId },
      { kind: "limitation", claim: "研究未评估观测队列分布之外的工作负载。", quote: limitation, locator: "正文", evidenceEventId: eventId },
    ],
  }] } }, coverage: [{ sourceId, label: "队列调度研究", urls: [url], status: "complete", evidenceId,
    contentHash, totalChars: body.length, coveredChars: body.length, eventIds: [eventId] }],
  snapshots: [{ sourceId, evidenceId, contentHash, url, content: body }],
  events: [{ id: eventId, runId: "reader-run", type: "source_checked", metadata: {
    receiptAuthority: "runtime", toolName: "webReadPage", method: "jina_defuddle", ok: true,
    url, finalUrl: url, finalUrlVerified: false, evidenceId, contentHash, offset: 0,
    contentLength: body.length, totalChars: body.length, nextOffset: null, qualityScore: 80,
  } }] };
}

function evidenceOf(input: GroundedResearchReportInput): Record<string, unknown> {
  return (input.report as { researchEvidence: Record<string, unknown> }).researchEvidence;
}
function brief() {
  return { title: "队列调度：方法、实验与适用范围", question: "如何用队列观测估计等待时间？",
    findings: [
      { text: "方法以观测到的队列长度作为等待时间估计的输入。", claimRefs: [{ sourceId, kind: "method" }] },
      { text: "实验结果限于 QueueBench 2024；分布外工作负载仍缺少评估。", claimRefs: [
        { sourceId, kind: "experiment" }, { sourceId, kind: "limitation" },
      ] },
    ], readingPath: [{ sourceId, focus: "先理解队列观测与等待时间估计的关系，再核对实验范围。" }] };
}

describe("research reports for readers", () => {
  it("puts substantive verified findings before an evidence appendix for legacy submissions", () => {
    const result = verifyAndBuildGroundedResearchReport(fixture());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.issues.join(" "));
    const reader = result.structured.presentation.researchBriefMarkdown;
    expect(reader).toContain("该调度方法从观测到的队列长度估计等待时间");
    expect(reader).toContain("QueueBench");
    expect(reader).not.toContain(eventId);
    expect(reader).not.toContain("The scheduling method");
    expect(result.structured.presentation.evidenceMarkdown).toContain(eventId.replace(/-/g, "\\-"));
    expect(result.structured.presentation.evidenceMarkdown).toContain("The scheduling method");
    expect(result.structured.presentation.reportMarkdown.indexOf("该调度方法")).toBeLessThan(
      result.structured.presentation.reportMarkdown.indexOf("正文回执"));
    expect(result.structured.presentation.warnings.join(" ")).toContain("独立抽查");
  });

  it("accepts one cited interpretation layer without competing free-form reports", () => {
    const input = fixture(); evidenceOf(input).brief = brief();
    const result = verifyAndBuildGroundedResearchReport(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.issues.join(" "));
    expect(result.structured.presentation.title).toBe(brief().title);
    expect(result.structured.presentation.summary).toContain("队列长度");
    expect(result.structured.presentation.researchBriefMarkdown).toContain("## 关键认识");
    expect(result.structured.presentation.researchBriefMarkdown).toContain("## 阅读顺序");
    expect(result.structured.presentation.researchBriefMarkdown).not.toContain("DeepSeek");
    expect(result.structured.researchEvidence.brief).toEqual(brief());
    const rendered = renderToStaticMarkup(createElement(Markdown, { renderInstructionBadges: false,
      children: result.structured.presentation.researchBriefMarkdown }));
    expect(rendered).toContain("<table");
    expect(rendered).toContain("<th");
    expect(rendered).toContain("<td");
    expect(rendered).not.toContain(eventId);
    expect(rendered).not.toContain("data-badge-kind=\"skill\"");
  });

  it.each(["unknown-source", "unknown-kind"])("rejects interpretation references that have no verified claim: %s", change => {
    const input = fixture(); const value = brief();
    if (change === "unknown-source") value.findings[0].claimRefs[0].sourceId = "other-study";
    else (value.findings[0].claimRefs[0] as { kind: string }).kind = "benchmark";
    evidenceOf(input).brief = value;
    expect(verifyAndBuildGroundedResearchReport(input).ok).toBe(false);
  });

  it("does not let a cited interpretation invent a numeric result absent from its cited claims", () => {
    const input = fixture(); const value = brief();
    value.findings[0].text = "该方法在所有任务上准确率为 99.9%。";
    evidenceOf(input).brief = value;
    const result = verifyAndBuildGroundedResearchReport(input);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("99.9");
  });

  it("rejects an unrelated paper in the reading guide and preserves the evidence submission", () => {
    const input = fixture(); const value = brief(); value.readingPath[0].sourceId = "outside-source";
    evidenceOf(input).brief = value;
    const before = JSON.stringify(input.report);
    expect(verifyAndBuildGroundedResearchReport(input).ok).toBe(false);
    expect(JSON.stringify(input.report)).toBe(before);
  });
});
