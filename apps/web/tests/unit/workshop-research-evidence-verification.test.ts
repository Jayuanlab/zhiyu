import { describe, expect, it } from "vitest";
import {
  formatWorkshopResearchContract,
  resolveWorkshopResearchContract,
  verifyWorkshopResearchEvidence,
  type WorkshopResearchEvidenceEvent,
} from "@/lib/workshops/research-evidence-verification";

const runId = "research-run";
const taskText = "重点看 DeepSeek 的强化学习工作";
const sources = [
  { id: "math", label: "DeepSeekMath", urls: ["https://arxiv.org/html/2402.03300v3"] },
  { id: "r1", label: "DeepSeek-R1", urls: ["https://arxiv.org/html/2501.12948v1"] },
  { id: "grm", label: "GRM/SPCT", urls: ["https://arxiv.org/html/2504.02495v1"] },
];
const modelConfig = () => ({ researchEvidenceContract: { version: "primary-reading/v1", taskKeywords: ["deepseek"], requiredPrimarySources: sources, minQualityScore: 55 } });
function event(sourceIndex: number, offset = 0, contentLength = 30000, totalChars = 30000,
  metadata: Record<string, unknown> = {}, overrides: Partial<WorkshopResearchEvidenceEvent> = {}): WorkshopResearchEvidenceEvent {
  return { id: `event-${sourceIndex}-${offset}`, runId, type: "source_checked", metadata: {
    receiptAuthority: "runtime", toolName: "webReadPage", ok: true, url: sources[sourceIndex].urls[0],
    finalUrl: sources[sourceIndex].urls[0], finalUrlVerified: false, evidenceId: `paper-${sourceIndex}`,
    contentHash: String(sourceIndex + 1).repeat(64), offset, contentLength, totalChars,
    nextOffset: offset + contentLength < totalChars ? offset + contentLength : null,
    qualityScore: 80, method: "jina_defuddle", warnings: ["figures_require_on_demand_visual_read"], ...metadata,
  }, ...overrides };
}
const events = () => sources.flatMap((_, index) => [event(index, 0, 30000, 45000), event(index, 30000, 15000, 45000, { truncated: true })]);
const report = () => ({ researchEvidence: { works: sources.map((source, index) => ({
  sourceId: source.id, evidenceEventIds: [`event-${index}-0`, `event-${index}-30000`],
  method: "原文所述方法及适用条件", experiments: "原文实验设置与比较", limitations: "原文报告的局限",
  locators: { method: "Section 2", experiments: "Section 3, Table 1", limitations: "Section 4" },
  supportedClaims: [{ claim: "实验比较采用原文所列条件", locator: "Table 1" }],
})), gaps: [] as string[] } });
const verify = (overrides: Partial<Parameters<typeof verifyWorkshopResearchEvidence>[0]> = {}) =>
  verifyWorkshopResearchEvidence({ modelConfig: modelConfig(), taskText, runId, events: events(), report: report(), ...overrides });

describe("Workshop primary reading evidence", () => {
  it("is inactive without a contract or for an unrelated original task", () => {
    expect(verify({ modelConfig: {} }).status).toBe("inactive");
    expect(verify({ taskText: "只做部署验收，写两句话" }).status).toBe("inactive");
    expect(formatWorkshopResearchContract(modelConfig(), "报告运行状态")).toBeNull();
    expect(resolveWorkshopResearchContract(modelConfig(), "DEEPSEEK research").active).toBe(true);
  });

  it.each([
    { researchEvidenceContract: null },
    { researchEvidenceContract: { version: "old", requiredPrimarySources: sources } },
    { researchEvidenceContract: { version: "primary-reading/v1", requiredPrimarySources: [] } },
    { researchEvidenceContract: { version: "primary-reading/v1", requiredPrimarySources: sources, taskKeywords: [] } },
    { researchEvidenceContract: { version: "primary-reading/v1", requiredPrimarySources: sources, minQualityScore: 200 } },
  ])("fails closed for an invalid explicit contract %j", config => {
    const resolution = resolveWorkshopResearchContract(config, "unrelated task");
    expect(resolution.active).toBe(true);
    expect(resolution.issues.length).toBeGreaterThan(0);
    expect(verify({ modelConfig: config }).status).toBe("evidence_insufficient");
  });

  it("does not let an abstract or one full body satisfy two required works", () => {
    const config = modelConfig();
    config.researchEvidenceContract.requiredPrimarySources = [
      { ...sources[0], urls: ["https://arxiv.org/abs/2402.03300"] },
    ];
    expect(verify({ modelConfig: config }).status).toBe("evidence_insufficient");
    config.researchEvidenceContract.requiredPrimarySources = [sources[0], { ...sources[1], urls: sources[0].urls }];
    expect(resolveWorkshopResearchContract(config, taskText).issues.join(" ")).toContain("两项必读");
  });

  it("rejects the baseline of seven searches, one secondary body and a claimed six sources", () => {
    const baseline: WorkshopResearchEvidenceEvent[] = Array.from({ length: 7 }, (_, index) => ({
      id: `search-${index}`, runId, type: "source_checked", metadata: { receiptAuthority: "runtime", toolName: "webSearch", ok: true, resultCount: 8 },
    }));
    baseline.push(event(0, 0, 14168, 14168, { url: "https://cloud.tencent.com/developer/article/2671456", finalUrl: "https://cloud.tencent.com/developer/article/2671456" }));
    baseline.push({ id: "self-report", runId, type: "source_checked", metadata: { receiptAuthority: "agent", sources_checked: 6 } });
    const result = verify({ events: baseline });
    expect(result.status).toBe("evidence_insufficient");
    expect(result.coverage.every(source => source.coveredChars === 0)).toBe(true);
    expect(result.verifiedEventIds).toEqual([]);
  });

  it("accepts three observed complete bodies with traceable method, experiments, limitations and claims", () => {
    const result = verify();
    expect(result.status).toBe("sufficient");
    expect(result.coverage.map(source => source.coveredChars)).toEqual([45000, 45000, 45000]);
    expect(result.verifiedEventIds).toHaveLength(6);
    expect(result.warnings).toContain("redirect_destination_not_independently_verified");
    expect(result.warnings).toContain("extraction_not_independently_verified");
  });

  it("does not treat a final page as complete when the beginning or a middle interval was skipped", () => {
    const missingBeginning = events().filter(item => item.id !== "event-0-0");
    expect(verify({ events: missingBeginning }).status).toBe("evidence_insufficient");
    const missingMiddle = events().filter(item => !item.id.startsWith("event-0-"));
    missingMiddle.push(event(0, 0, 10000, 45000), event(0, 30000, 15000, 45000));
    const result = verify({ events: missingMiddle });
    expect(result.status).toBe("evidence_insufficient");
    expect(result.coverage[0].coveredChars).toBe(10000);
  });

  it("rejects an abstract, a near-match URL, a secondary redirect and a page with a different paper version", () => {
    for (const metadata of [
      { url: "https://arxiv.org/abs/2402.03300v3", finalUrl: "https://arxiv.org/abs/2402.03300v3" },
      { url: "https://arxiv.org/html/2402.03300v3?different=true", finalUrl: sources[0].urls[0] },
      { finalUrl: "https://cloud.tencent.com/developer/article/2671456" },
      { url: "https://arxiv.org/html/2402.03300v4", finalUrl: "https://arxiv.org/html/2402.03300v4" },
    ]) {
      const observed = events().map(item => item.id.startsWith("event-0-") ? { ...item, metadata: { ...item.metadata as object, ...metadata } } : item);
      expect(verify({ events: observed }).status).toBe("evidence_insufficient");
    }
  });

  it("does not count agent assertions, other-run receipts, orphan tool results or permission decisions", () => {
    for (const replacement of [
      { metadata: { receiptAuthority: "agent" } },
      { runId: "other-run" },
      { type: "tool_result" },
      { type: "permission_decision" },
      { metadata: { toolName: "webSearch" } },
    ]) {
      const observed = events().map(item => item.id.startsWith("event-0-") ? { ...item, ...replacement,
        metadata: { ...item.metadata as object, ...replacement.metadata } } : item);
      expect(verify({ events: observed }).status).toBe("evidence_insufficient");
    }
  });

  it("deduplicates repeated events without multiplying coverage and quarantines conflicting IDs", () => {
    expect(verify({ events: [...events(), ...events()] }).verifiedEventIds).toHaveLength(6);
    const duplicate = event(0, 0, 30000, 45000, { contentHash: "f".repeat(64) });
    expect(verify({ events: [...events(), duplicate] }).status).toBe("evidence_insufficient");
  });

  it("does not require redundant same-window receipt IDs when the cited minimal chain is complete", () => {
    const redundant = event(0, 0, 10000, 45000, {}, { id: "redundant-small-first-page" });
    const repeated = event(0, 30000, 15000, 45000, {}, { id: "redundant-last-page" });
    expect(verify({ events: [...events(), redundant, repeated] }).status).toBe("sufficient");
    expect(verify({ events: [...events(), redundant, repeated] }).coverage[0].eventIds).toHaveLength(2);
  });

  it("rejects a missing extraction method, figure read or unsaved direct fetch with body-shaped metadata", () => {
    for (const method of [undefined, "web_figure", "direct_fetch", "official_rss"]) {
      const observed = events().map(item => item.id.startsWith("event-0-")
        ? { ...item, metadata: { ...item.metadata as object, method } } : item);
      expect(verify({ events: observed }).status).toBe("evidence_insufficient");
    }
  });

  it("does not combine different hashes, evidence snapshots or contradictory total lengths", () => {
    for (const metadata of [{ contentHash: "f".repeat(64) }, { evidenceId: "another-version" }, { totalChars: 46000, nextOffset: 45000 }]) {
      const observed = events().map(item => item.id === "event-0-30000" ? { ...item, metadata: { ...item.metadata as object, ...metadata } } : item);
      expect(verify({ events: observed }).status).toBe("evidence_insufficient");
    }
  });

  it("rejects unsuccessful, low quality, malformed, unsaved and inconsistent reader windows", () => {
    for (const metadata of [{ ok: false }, { qualityScore: 20 }, { qualityScore: Number.NaN },
      { evidenceId: undefined }, { contentHash: undefined }, { offset: -1 }, { contentLength: 0 },
      { totalChars: 100 }, { nextOffset: null }, { nextOffset: 31000 }]) {
      const observed = events().map(item => item.id === "event-0-0" ? { ...item, metadata: { ...item.metadata as object, ...metadata } } : item);
      expect(verify({ events: observed }).status).toBe("evidence_insufficient");
    }
  });

  it("requires all report dimensions, concrete locators, claims and exact body event references", () => {
    for (const patch of [
      { method: " " }, { experiments: "" }, { limitations: undefined },
      { locators: { method: "Section 2", experiments: "Section 3" } },
      { supportedClaims: [] }, { supportedClaims: [{ claim: "A mechanism", locator: "" }] },
      { evidenceEventIds: ["search-1"] }, { evidenceEventIds: ["event-0-0"] },
      { evidenceEventIds: ["event-1-0", "event-1-30000"] },
    ]) {
      const value = report();
      value.researchEvidence.works[0] = { ...value.researchEvidence.works[0], ...patch } as typeof value.researchEvidence.works[0];
      expect(verify({ report: value }).status).toBe("evidence_insufficient");
    }
    expect(verify({ report: { summary: "全部精读完成", sources_checked: 6 } }).status).toBe("evidence_insufficient");
  });

  it("keeps genuine partial coverage and declared gaps for recovery rather than a completed outcome", () => {
    const value = report();
    value.researchEvidence.gaps = ["R1 的第二个窗口未读，下一轮继续 offset 30000。"];
    const result = verify({ events: events().filter(item => item.id !== "event-1-30000"), report: value });
    expect(result.status).toBe("evidence_insufficient");
    expect(result.coverage[1]).toMatchObject({ status: "incomplete", coveredChars: 30000, totalChars: 45000 });
    expect(result.coverage[0].status).toBe("complete");
    expect(result.gaps.join(" ")).toContain("下一轮继续");
    expect(result.verifiedEventIds).not.toContain("event-1-0");
  });

  it("formats the bounded original-reading workflow and structured report contract", () => {
    const prompt = formatWorkshopResearchContract(modelConfig(), taskText)!;
    for (const required of ["30000", "evidenceId", "nextOffset", "search", "researchEvidence", "supportedClaims", "locators", "表号"]) {
      if (required !== "search") expect(prompt).toContain(required);
    }
    expect(prompt).toContain("搜索摘要");
    expect(prompt).toContain("不能证明公式");
    expect(prompt).toContain(sources[0].urls[0]);
  });
});
