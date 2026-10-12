import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkshopExecutionResult } from "@/lib/workshops/executor";
import type { WorkshopResearchEvidenceEvent } from "@/lib/workshops/research-evidence-verification";
const load = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/jina-page-reader", () => ({ loadWebEvidence: load }));
import { finalizeWorkshopResearchDelivery } from "@/lib/workshops/research-report-delivery";
import { selectWorkshopResearchQuotes } from "@/lib/workshops/research-quote-selection";

const url = "https://arxiv.org/html/2501.12948v1";
const quotes = {
  method: "The method uses rule-based accuracy rewards for reinforcement learning without a neural reward model.",
  experiment: "Model Qwen-32B achieves 72.6 on the AIME 2024 benchmark under the reported evaluation settings.",
  limitation: "The authors report that the model still has limitations in language mixing and software engineering tasks.",
};
const content = Object.values(quotes).join("\n\n");
const hash = createHash("sha256").update(content).digest("hex");
const contract = { version: "primary-reading/v1", taskKeywords: ["deepseek"], reportDelivery: "grounded-report/v1",
  requiredPrimarySources: [{ id: "r1", label: "DeepSeek-R1", urls: [url] }] };
const report = () => ({ researchEvidence: { reportVersion: "grounded-report/v1", works: [{ sourceId: "r1", supportedClaims: [
  { kind: "method", claim: "使用规则式准确性奖励，不采用神经奖励模型。", locator: "Section 2", quote: quotes.method, evidenceEventId: "body-event" },
  { kind: "experiment", claim: "Qwen-32B 在 AIME 2024 得分 72.6，条件见原文。", locator: "Table 5", quote: quotes.experiment, evidenceEventId: "body-event" },
  { kind: "limitation", claim: "仍存在语言混合和软件工程任务的局限。", locator: "Section 5", quote: quotes.limitation, evidenceEventId: "body-event" },
] }], gaps: [] } });
const result = (): WorkshopExecutionResult => ({ status: "success", output: "unrendered model JSON", structured: report(), toolCallCount: 1, durationMs: 5 });
const events: WorkshopResearchEvidenceEvent[] = [{ id: "body-event", runId: "run", type: "source_checked", metadata: { receiptAuthority: "runtime",
  toolName: "webReadPage", method: "jina_defuddle", ok: true, url, finalUrl: url,
  evidenceId: "snapshot", contentHash: hash, qualityScore: 80, offset: 0, contentLength: content.length,
  totalChars: content.length, nextOffset: null } }];
const input = () => ({ workshopId: "work", runId: "run", modelConfig: { researchEvidenceContract: structuredClone(contract) },
  taskText: "Read DeepSeek", events, result: result() });

describe("owned snapshot research report delivery", () => {
  beforeEach(() => { load.mockReset().mockResolvedValue({ snapshot: { evidenceId: "snapshot", contentHash: hash, url, content } }); });
  it("builds one stable owner report from checked claims and current run bodies", async () => {
    const first = await finalizeWorkshopResearchDelivery(input());
    const replay = await finalizeWorkshopResearchDelivery(input());
    expect(first.verification.status).toBe("sufficient");
    expect(first.audit).toMatchObject({ status: "verified", semanticStatus: "not_independently_verified" });
    expect(first.audit?.canonicalHash).toBe(replay.audit?.canonicalHash);
    expect(first.result.structured?.presentation).toMatchObject({ source: "host_grounded_report", evidenceEventIds: ["body-event"] });
    expect(first.result.structured?.presentation?.reportMarkdown).toContain("72\\.6");
    expect(first.result.output).not.toBe("unrendered model JSON");
    expect(load).toHaveBeenCalledWith("workshop:work", "snapshot", url);
  });
  it("uses actually saved direct Defuddle windows and refs without approving fabricated numbers", async () => {
    const args = input();
    args.events = [{ ...events[0], metadata: { ...(events[0].metadata as Record<string, unknown>),
      method: "direct_defuddle", provider: "direct_http", cleaner: "defuddle-0.19.4/zhiyu-2",
      warnings: ["direct_source_defuddle_fallback"], fallbackErrors: ["Jina Reader HTTP 403"] } }];
    const selected = await selectWorkshopResearchQuotes({ ...args, url, evidenceId: "snapshot",
      queries: Object.values(quotes).map(text => ({ text: text.slice(0, 60) })) });
    expect(selected.candidates).toHaveLength(3);
    args.events.push({ id: "direct-selected", runId: "run", type: "research_quote_selected", metadata: {
      ...selected, receiptAuthority: "runtime", toolName: "webReadPage", workshopId: "work" } });
    const referenceReport = { researchEvidence: { reportVersion: "grounded-report/v1", works: [{ sourceId: "r1", supportedClaims:
      report().researchEvidence.works[0].supportedClaims.map((claim, index) => ({ kind: claim.kind, claim: claim.claim,
        quoteRef: { selectionEventId: "direct-selected", index } })) }], gaps: [] } };
    args.result.structured = referenceReport;
    const unchanged = JSON.stringify(referenceReport);
    const accepted = await finalizeWorkshopResearchDelivery(args);
    expect(accepted.audit?.status).toBe("verified");
    expect(accepted.verification.warnings).toContain("direct_source_defuddle_fallback");
    expect(JSON.stringify(referenceReport)).toBe(unchanged);
    referenceReport.researchEvidence.works[0].supportedClaims[1].claim = "Qwen-32B 在 AIME 2024 得分 99.9。";
    const badBytes = JSON.stringify(referenceReport);
    expect((await finalizeWorkshopResearchDelivery(args)).audit?.status).toBe("rejected");
    expect(JSON.stringify(referenceReport)).toBe(badBytes);
    expect(load).toHaveBeenCalledWith("workshop:work", "snapshot", url);
  });
  it.each([
    { method: "direct_fetch", provider: "direct_http", cleaner: "defuddle-0.19.4/zhiyu-2" },
    { method: "direct_defuddle", cleaner: "defuddle-0.19.4/zhiyu-2" },
    { method: "direct_defuddle", provider: "jina_reader", cleaner: "defuddle-0.19.4/zhiyu-2" },
    { method: "direct_defuddle", provider: "direct_http", cleaner: "turndown" },
  ])("refuses unsupported or mislabeled direct receipt provenance: %j", async provenance => {
    const args = input();
    args.events = [{ ...events[0], metadata: { ...(events[0].metadata as Record<string, unknown>), ...provenance } }];
    const observed = await finalizeWorkshopResearchDelivery(args);
    expect(observed.verification.coverage[0]).toMatchObject({ status: "incomplete", coveredChars: 0 });
    expect(observed.audit?.status).toBe("rejected");
    expect(load).not.toHaveBeenCalled();
  });
  it("rejects unavailable bodies without refetch, retry or an unverified final report", async () => {
    load.mockRejectedValue(new Error("missing"));
    const observed = await finalizeWorkshopResearchDelivery(input());
    expect(observed.verification.status).toBe("evidence_insufficient");
    expect(observed.audit?.status).toBe("rejected");
    expect(observed.result.structured?.presentation?.reportMarkdown).toContain("快照缺失");
    expect(observed.result.structured?.presentation?.reportMarkdown).not.toContain("unrendered model JSON");
    expect(load).toHaveBeenCalledOnce();
  });
  it("refuses a changed snapshot even when model references a real host event", async () => {
    load.mockResolvedValue({ snapshot: { evidenceId: "snapshot", contentHash: "a".repeat(64), url, content } });
    const observed = await finalizeWorkshopResearchDelivery(input());
    expect(observed.audit?.status).toBe("rejected");
    expect(observed.verification.gaps.join(" ")).toContain("身份校验失败");
  });
  it("loads the actually read approved alternate URL rather than guessing first configured URL", async () => {
    const args = input();
    args.modelConfig.researchEvidenceContract = { ...contract, requiredPrimarySources: [{ ...contract.requiredPrimarySources[0], urls: ["https://arxiv.org/html/2501.12948v2", url] }] };
    expect((await finalizeWorkshopResearchDelivery(args)).audit?.status).toBe("verified");
    expect(load).toHaveBeenCalledWith("workshop:work", "snapshot", url);
  });
  it("leaves unrelated tasks and legacy report protocols unchanged", async () => {
    const unrelated = input(); unrelated.taskText = "Other topic";
    const observed = await finalizeWorkshopResearchDelivery(unrelated);
    expect(observed.result).toBe(unrelated.result);
    expect(observed.verification.status).toBe("inactive");
    expect(observed.audit).toBeUndefined();
    const legacy = input();
    delete (legacy.modelConfig.researchEvidenceContract as Partial<typeof contract>).reportDelivery;
    expect((await finalizeWorkshopResearchDelivery(legacy)).audit).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });
  it("fails closed before snapshot loads when the current receipt collection exceeds the bound", async () => {
    const observed = await finalizeWorkshopResearchDelivery({ ...input(), eventsOverflow: true });
    expect(observed.audit?.status).toBe("rejected");
    expect(load).not.toHaveBeenCalled();
  });
  it("rejects a false number instead of repairing it or rendering it as completed", async () => {
    const args = input();
    const bad = report(); bad.researchEvidence.works[0].supportedClaims[1].claim = "Qwen-32B 在 AIME 2024 得分 64.6。";
    args.result.structured = bad;
    const observed = await finalizeWorkshopResearchDelivery(args);
    expect(observed.audit?.status).toBe("rejected");
    expect(observed.result.structured?.presentation?.reportMarkdown).not.toContain("得分 64.6");
  });
  it("replays selected verbatim quotes through the original final gate without changing model claims", async () => {
    const selected = await selectWorkshopResearchQuotes({ ...input(), url, evidenceId: "snapshot",
      queries: Object.values(quotes).map(text => ({ text: text.slice(0, 60) })) });
    expect(selected.candidates).toHaveLength(3);
    const args = input();
    args.events = [...events, { id: "selected-event", runId: "run", type: "research_quote_selected", metadata: {
      ...selected, receiptAuthority: "runtime", toolName: "webReadPage", workshopId: "work" } }];
    const original = report().researchEvidence.works[0].supportedClaims;
    const refReport = { researchEvidence: { reportVersion: "grounded-report/v1", works: [{ sourceId: "r1", supportedClaims:
      original.map((claim, index) => ({ kind: claim.kind, claim: claim.claim, quoteRef: { selectionEventId: "selected-event", index } })) }], gaps: [] } };
    args.result.structured = refReport;
    const raw = JSON.stringify(refReport);
    const first = await finalizeWorkshopResearchDelivery(args);
    const replay = await finalizeWorkshopResearchDelivery(args);
    expect(first.audit?.status).toBe("verified");
    expect(first.audit?.canonicalHash).toBe(replay.audit?.canonicalHash);
    expect(first.result.structured?.researchEvidence).toMatchObject({ works: [{ supportedClaims:
      original.map(claim => ({ claim: claim.claim, quote: claim.quote, evidenceEventId: "body-event" })) }] });
    expect(JSON.stringify(refReport)).toBe(raw);
    const malformedCases = [
      (value: typeof refReport) => Object.assign(value, { unknownField: true }),
      (value: typeof refReport) => Object.assign(value.researchEvidence, { unknownField: true }),
      (value: typeof refReport) => Object.assign(value.researchEvidence.works[0], { unknownField: true }),
      (value: typeof refReport) => Object.assign(value.researchEvidence.works[0].supportedClaims[0], { unknownField: true }),
      (value: typeof refReport) => Object.assign(value.researchEvidence, { gaps: ["Current claim lacks required evidence."] }),
      (value: typeof refReport) => Object.assign(value.researchEvidence, { works: null }),
    ];
    for (const mutate of malformedCases) {
      const changed = structuredClone(refReport); mutate(changed); args.result.structured = changed;
      const beforeValidation = JSON.stringify(changed);
      expect((await finalizeWorkshopResearchDelivery(args)).audit?.status).toBe("rejected");
      expect(JSON.stringify(changed)).toBe(beforeValidation);
    }
    args.result.structured = refReport;
    const originalSource = args.events[0];
    args.events[0] = { ...originalSource, runId: "old-run" };
    expect((await finalizeWorkshopResearchDelivery(args)).audit?.status).toBe("rejected");
    args.events[0] = originalSource;
    refReport.researchEvidence.works[0].supportedClaims[1].claim = "Qwen-32B 在 AIME 2024 得分 64.6。";
    const wrong = await finalizeWorkshopResearchDelivery(args);
    expect(wrong.audit?.status).toBe("rejected");
    expect(wrong.audit?.issues.join(" ")).toContain("数字 64.6");
    expect(refReport.researchEvidence.works[0].supportedClaims[1].claim).toContain("64.6");
    args.events[1] = { ...args.events[1], runId: "old-run" };
    expect((await finalizeWorkshopResearchDelivery(args)).audit?.status).toBe("rejected");
  });
});
