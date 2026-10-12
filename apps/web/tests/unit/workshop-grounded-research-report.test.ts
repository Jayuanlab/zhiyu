import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  verifyAndBuildGroundedResearchReport,
  type GroundedResearchClaim,
  type GroundedResearchReportInput,
} from "@/lib/workshops/grounded-research-report";
import { verifyWorkshopResearchEvidence } from "@/lib/workshops/research-evidence-verification";

const runId = "current-research-run";
const sourceId = "original-paper";
const url = "https://papers.example.com/html/paper-v1";
const evidenceId = "0d6f1520-4e28-4f4d-adc5-3ae7fb4440dd";
const contentHash = "a".repeat(64);
const eventId = "8379608f-bdc1-4dc7-adfc-905c52592778";
const nextEventId = "2abd0967-837c-427a-a835-ba4261f8ee02";
const sourceLabel = "持久研究智能体的原论文";
const firstText = "The method estimates a baseline from group scores. Model-Qwen-32B scores 72.6% on AIME 2024. The study does not measure training latency.";
const secondText = "\nThe second page reports no new experiments. External validity remains limited to the tested tasks.";
const content = firstText + secondText;
function claim(kind: GroundedResearchClaim["kind"], text: string, quote: string, ref = eventId): GroundedResearchClaim {
  return { kind, claim: text, locator: kind === "experiment" ? "Table 1" : "Section 2", quote, evidenceEventId: ref };
}
function fixture(): GroundedResearchReportInput {
  const event = (id: string, offset: number, length: number) => ({ id, runId, type: "source_checked", metadata: {
    receiptAuthority: "runtime", toolName: "webReadPage", method: "jina_defuddle", ok: true,
    url, finalUrl: url, finalUrlVerified: false, evidenceId, contentHash, offset, contentLength: length,
    totalChars: content.length, nextOffset: offset + length < content.length ? offset + length : null, qualityScore: 80,
  } });
  return { runId, report: { researchEvidence: { reportVersion: "grounded-report/v1", works: [{ sourceId,
    supportedClaims: [
      claim("method", "该方法从 group scores 估计 baseline。", "The method estimates a baseline from group scores."),
      claim("experiment", "Model-Qwen-32B 在 AIME 2024 得分 72.6%。", "Model-Qwen-32B scores 72.6% on AIME 2024."),
      claim("limitation", "该研究未测量 training latency。", "The study does not measure training latency."),
    ],
  }], gaps: [] } }, coverage: [{ sourceId, label: sourceLabel, urls: [url], status: "complete",
    evidenceId, contentHash, totalChars: content.length, coveredChars: content.length, eventIds: [eventId, nextEventId] }],
  events: [event(eventId, 0, firstText.length), event(nextEventId, firstText.length, secondText.length)],
  snapshots: [{ sourceId, evidenceId, contentHash, url, content }] };
}
type Report = { researchEvidence: { reportVersion: string; works: Array<{ sourceId: string; supportedClaims: GroundedResearchClaim[] }>; gaps: string[] } };
const reportOf = (input: GroundedResearchReportInput) => input.report as Report;
const issuesOf = (input: GroundedResearchReportInput) => verifyAndBuildGroundedResearchReport(input).issues.join(" ");
const historic = JSON.parse(readFileSync(new URL("../fixtures/grounded-research-report-failures.json", import.meta.url), "utf8")) as {
  cases: Array<{ id: string; claim: string; quote: string; expectedMissingNumber: string }>;
  invalidReferences: string[];
};

describe("canonical host-grounded research report", () => {
  it("keeps model-name hyphens separate from mathematical minus signs in numeric bindings", () => {
    const input = fixture();
    const sentence = "DeepSeek-GRM-27B is evaluated with 32 samples; the reported signed change is -2.9 points.";
    const body = `${content}\n${sentence}`;
    input.snapshots = [{ ...input.snapshots[0], content: body }];
    input.coverage = [{ ...input.coverage[0], totalChars: body.length, coveredChars: body.length, eventIds: [eventId] }];
    input.events = [{ ...input.events[0], metadata: { ...input.events[0].metadata as object,
      offset: 0, contentLength: body.length, totalChars: body.length, nextOffset: null } }];
    reportOf(input).researchEvidence.works[0].supportedClaims[1] = claim("experiment", "DeepSeek-GRM-27B 以 27B 模型、32 samples 评测，变化为 -2.9 points。", sentence);
    expect(verifyAndBuildGroundedResearchReport(input).ok).toBe(true);
    reportOf(input).researchEvidence.works[0].supportedClaims[1].claim = "DeepSeek-GRM-27B 以 27B 模型、32 samples 评测，变化为 2.9 points。";
    expect(issuesOf(input)).toContain("数字 2.9");
  });
  it("generates one report from the canonical claims and actual receipts, compatible with the reading verifier", () => {
    const input = fixture();
    const result = verifyAndBuildGroundedResearchReport(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(result.issues.join(" "));
    expect(result.structured.presentation.source).toBe("host_grounded_report");
    expect(result.structured.presentation.evidenceEventIds).toEqual([eventId, nextEventId]);
    expect(result.structured.presentation.reportMarkdown).toContain(url);
    expect(result.structured.presentation.reportMarkdown).toContain(sourceLabel);
    expect(result.structured.presentation.reportMarkdown).toContain("72\\.6%");
    expect(result.structured.presentation.reportMarkdown).toContain("Model\\-Qwen\\-32B scores 72\\.6% on AIME 2024\\.");
    expect(result.structured.researchEvidence.works[0].experiments).toBe(reportOf(input).researchEvidence.works[0].supportedClaims[1].claim);
    expect(result.structured.presentation.warnings.join(" ")).toContain("逻辑支持");
    expect(result.structured.presentation.warnings.join(" ")).toContain("重定向");
    expect(verifyWorkshopResearchEvidence({ modelConfig: { researchEvidenceContract: { version: "primary-reading/v1",
      requiredPrimarySources: [{ id: sourceId, label: sourceLabel, urls: [url] }] } }, taskText: "read", runId,
    events: input.events, report: result.structured }).status).toBe("sufficient");
  });

  it("only normalizes whitespace in an exact complete short excerpt", () => {
    const input = fixture();
    reportOf(input).researchEvidence.works[0].supportedClaims[0].quote = "The method\n estimates  a baseline from\tgroup scores.";
    expect(verifyAndBuildGroundedResearchReport(input).ok).toBe(true);
    reportOf(input).researchEvidence.works[0].supportedClaims[0].quote = "The method estimates a baseline ... from group scores.";
    expect(issuesOf(input)).toContain("短摘未完整");
  });

  it.each(historic.cases)("rejects the saved historical wrong claim $id without repairing it", historical => {
    const input = fixture();
    const extendedContent = firstText + " " + historical.quote + secondText;
    input.snapshots = [{ ...input.snapshots[0], content: extendedContent }];
    input.coverage = [{ ...input.coverage[0], totalChars: extendedContent.length, coveredChars: extendedContent.length,
      eventIds: [eventId] }];
    input.events = [{ ...input.events[0], metadata: { ...input.events[0].metadata as object,
      offset: 0, contentLength: extendedContent.length, totalChars: extendedContent.length, nextOffset: null } }];
    reportOf(input).researchEvidence.works[0].supportedClaims[1] = claim("experiment", historical.claim, historical.quote);
    const result = verifyAndBuildGroundedResearchReport(input);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain(`数字 ${historical.expectedMissingNumber}`);
    expect("structured" in result).toBe(false);
    expect(reportOf(input).researchEvidence.works[0].supportedClaims[1].claim).toBe(historical.claim);
  });

  it.each(historic.invalidReferences)("rejects a fabricated UUID or snapshot identity as an event reference %s", badId => {
    const input = fixture();
    reportOf(input).researchEvidence.works[0].supportedClaims[1].evidenceEventId = badId;
    expect(issuesOf(input)).toContain("真实正文窗口");
  });

  it("does not cite an excerpt from a different page window of the same paper", () => {
    const input = fixture();
    reportOf(input).researchEvidence.works[0].supportedClaims[1].evidenceEventId = nextEventId;
    expect(issuesOf(input)).toContain("短摘未完整");
  });

  it.each([
    { runId: "previous-run" }, { type: "agent_log" }, { type: "tool_result" },
    { metadata: { receiptAuthority: "agent" } }, { metadata: { toolName: "webSearch" } },
    { metadata: { method: "web_figure" } }, { metadata: { method: "direct_fetch" } },
    { metadata: { ok: false } }, { metadata: { evidenceId: "old-snapshot" } },
    { metadata: { contentHash: "b".repeat(64) } }, { metadata: { url: "https://papers.example.com/html/another-paper" } },
    { metadata: { finalUrl: "https://secondary.example.com/summary" } },
  ])("rejects other runs, assertions, figures, old snapshots and wrong sources %j", patch => {
    const input = fixture();
    input.events = input.events.map(event => ({ ...event, ...patch,
      metadata: { ...event.metadata as object, ...patch.metadata } }));
    expect(issuesOf(input)).toContain("本轮");
  });

  it("rejects conflicting receipt IDs instead of choosing a favorable duplicate", () => {
    const input = fixture();
    input.events = [...input.events, { ...input.events[0], metadata: { ...input.events[0].metadata as object, evidenceId: "different" } }];
    expect(issuesOf(input)).toContain("真实同版正文");
  });

  it("rejects a snapshot with the wrong source ID, hash, length or version URL", () => {
    for (const patch of [{ sourceId: "other-paper" }, { contentHash: "b".repeat(64) },
      { content: content.slice(1) }, { url: "https://papers.example.com/html/paper-v2" }]) {
      const input = fixture();
      input.snapshots = [{ ...input.snapshots[0], ...patch }];
      expect(issuesOf(input)).toContain("同版正文 snapshot");
    }
  });

  it("requires one report per required source and each method, experiment and limitation", () => {
    for (const change of ["unknown", "missing", "duplicate", "no-limitation", "declared-gap"]) {
      const input = fixture();
      const evidence = reportOf(input).researchEvidence;
      if (change === "unknown") evidence.works[0].sourceId = url;
      if (change === "missing") evidence.works = [];
      if (change === "duplicate") evidence.works.push(evidence.works[0]);
      if (change === "no-limitation") evidence.works[0].supportedClaims[2].kind = "method";
      if (change === "declared-gap") evidence.gaps.push("需要继续核对剩余正文。");
      expect(verifyAndBuildGroundedResearchReport(input).ok).toBe(false);
    }
  });

  it("rejects any competing free presentation, Markdown, summary or action output", () => {
    for (const competing of [{ presentation: { reportMarkdown: "模型重新写一份不同报告" } },
      { summary: "另一份结论" }, { reportMarkdown: "另一份报告" }, { memoryCandidates: [] }, { outboxDrafts: [] }]) {
      const input = fixture();
      input.report = { ...input.report as object, ...competing };
      expect(issuesOf(input)).toContain("单一 researchEvidence");
    }
  });

  it("rejects wrong versions, empty locators, long fields and excessive claims without truncation", () => {
    for (const change of ["version", "locator", "quote", "claim", "too-many-claims"]) {
      const input = fixture();
      const evidence = reportOf(input).researchEvidence;
      if (change === "version") evidence.reportVersion = "old-report";
      if (change === "locator") evidence.works[0].supportedClaims[0].locator = " ";
      if (change === "quote") evidence.works[0].supportedClaims[0].quote = "x".repeat(1601);
      if (change === "claim") evidence.works[0].supportedClaims[0].claim = "x".repeat(501);
      if (change === "too-many-claims") evidence.works[0].supportedClaims = Array(10).fill(evidence.works[0].supportedClaims[0]);
      expect(verifyAndBuildGroundedResearchReport(input).ok).toBe(false);
    }
  });

  it("binds numbered model identities and numeric tokens rather than substring matching", () => {
    for (const statement of ["Model-Qwen32 在 AIME 2024 得分 72.6%。", "Model-Qwen-32M 得分 72.6%。",
      "o1-1217 得分 72.6%。", "该结果为 2.6%。", "该结果为 72.6。", "该结果为 -72.6%。"]) {
      const input = fixture();
      reportOf(input).researchEvidence.works[0].supportedClaims[1].claim = statement;
      expect(verifyAndBuildGroundedResearchReport(input).ok).toBe(false);
    }
  });

  it("retains explicitly supported signed values, units and identifiers", () => {
    const input = fixture();
    const quote = "o1-1217 delta is -12.5%; Qwen32 count is 32. The tolerance is 1e-3.";
    const extendedContent = firstText + " " + quote + secondText;
    input.snapshots = [{ ...input.snapshots[0], content: extendedContent }];
    input.coverage = [{ ...input.coverage[0], eventIds: [eventId], totalChars: extendedContent.length, coveredChars: extendedContent.length }];
    input.events = [{ ...input.events[0], metadata: { ...input.events[0].metadata as object,
      contentLength: extendedContent.length, totalChars: extendedContent.length, nextOffset: null } }];
    reportOf(input).researchEvidence.works[0].supportedClaims[1] = claim("experiment", "o1-1217 的 delta 为 -12.5%；Qwen32 count 为 32，tolerance 为 1e-3。", quote);
    expect(verifyAndBuildGroundedResearchReport(input).ok).toBe(true);
  });

  it("states the semantic boundary when a true quote and matching numbers still form an unsupported comparison", () => {
    const input = fixture();
    const quote = "Model-Qwen-32B scores 72.6% on AIME 2024; o1-1217 scores 79.2% on the same benchmark.";
    const extendedContent = firstText + " " + quote + secondText;
    input.snapshots = [{ ...input.snapshots[0], content: extendedContent }];
    input.coverage = [{ ...input.coverage[0], eventIds: [eventId], totalChars: extendedContent.length, coveredChars: extendedContent.length }];
    input.events = [{ ...input.events[0], metadata: { ...input.events[0].metadata as object,
      contentLength: extendedContent.length, totalChars: extendedContent.length, nextOffset: null } }];
    reportOf(input).researchEvidence.works[0].supportedClaims[1] = claim("experiment", "Model-Qwen-32B 在 AIME 2024 以 72.6% 超过 o1-1217 的 79.2%。", quote);
    const result = verifyAndBuildGroundedResearchReport(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(result.issues.join(" "));
    expect(result.structured.presentation.warnings.join(" ")).toContain("比较条件");
    expect(result.structured.presentation.warnings.join(" ")).toContain("不等于中文结论已被逻辑支持");
  });

  it("retains a warning when a real passage could still be paraphrased into a confused training/inference mechanism", () => {
    const input = fixture();
    const quote = "Training uses rule-based rewards. Meta RM selects reasoning traces for inference-time voting.";
    const extendedContent = firstText + " " + quote + secondText;
    input.snapshots = [{ ...input.snapshots[0], content: extendedContent }];
    input.coverage = [{ ...input.coverage[0], eventIds: [eventId], totalChars: extendedContent.length, coveredChars: extendedContent.length }];
    input.events = [{ ...input.events[0], metadata: { ...input.events[0].metadata as object,
      contentLength: extendedContent.length, totalChars: extendedContent.length, nextOffset: null } }];
    reportOf(input).researchEvidence.works[0].supportedClaims[0] = claim("method", "训练使用 Meta RM 作为奖励信号。", quote);
    const result = verifyAndBuildGroundedResearchReport(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(result.issues.join(" "));
    expect(result.structured.presentation.warnings.join(" ")).toContain("机制");
    expect(result.structured.presentation.warnings.join(" ")).toContain("独立抽查");
  });

  it("escapes model text while preserving its visible content and the host source link", () => {
    const input = fixture();
    reportOf(input).researchEvidence.works[0].supportedClaims[0].claim = "<script>alert()</script> [虚构引用](javascript:bad)";
    const result = verifyAndBuildGroundedResearchReport(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(result.issues.join(" "));
    expect(result.structured.presentation.reportMarkdown).toContain("&lt;script&gt;");
    expect(result.structured.presentation.reportMarkdown).not.toContain("[虚构引用](javascript:bad)");
    expect(result.structured.presentation.reportMarkdown).toContain(`[同版原文](<${url}>)`);
  });

  it("does not manufacture a successful report from incomplete coverage", () => {
    const input = fixture();
    input.coverage = [{ ...input.coverage[0], status: "incomplete", coveredChars: firstText.length }];
    const result = verifyAndBuildGroundedResearchReport(input);
    expect(result.ok).toBe(false);
    expect("structured" in result).toBe(false);
  });
});
