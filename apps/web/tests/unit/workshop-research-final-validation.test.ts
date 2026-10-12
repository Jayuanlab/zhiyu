import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const load = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/jina-page-reader", () => ({ loadWebEvidence: load }));
import { validateWorkshopResearchGroundedFinal as validateWorkshopResearchFinal, WORKSHOP_RESEARCH_FINAL_FEEDBACK_MAX_CHARS } from "@/lib/workshops/research-final-validation";
import type { WorkshopResearchEvidenceEvent } from "@/lib/workshops/research-evidence-verification";

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
const bodyEvent = (overrides: Record<string, unknown> = {}): WorkshopResearchEvidenceEvent => ({
  id: "body-event", runId: "run", type: "source_checked", metadata: { receiptAuthority: "runtime",
    toolName: "webReadPage", method: "jina_defuddle", ok: true, url, finalUrl: url,
    evidenceId: "snapshot", contentHash: hash, qualityScore: 80, offset: 0, contentLength: content.length,
    totalChars: content.length, nextOffset: null, ...overrides },
});
const input = () => ({ workshopId: "work", runId: "run", modelConfig: { researchEvidenceContract: structuredClone(contract) },
  taskText: "Read DeepSeek", events: [bodyEvent()], rawText: JSON.stringify(report()) });
async function feedback(args = input()) {
  const observed = await validateWorkshopResearchFinal(args);
  expect(observed.ok).toBe(false);
  if (observed.ok) throw Error("expected_failed_feedback");
  expect(observed.feedback.length).toBeLessThanOrEqual(WORKSHOP_RESEARCH_FINAL_FEEDBACK_MAX_CHARS);
  return observed.feedback;
}

describe("bounded before-final research feedback", () => {
  beforeEach(() => { load.mockReset().mockResolvedValue({ snapshot: { evidenceId: "snapshot", contentHash: hash, url, content } }); });

  it("accepts an exact single report only after owned body provenance checks and returns no deliverable", async () => {
    expect(await validateWorkshopResearchFinal(input())).toEqual({ ok: true });
    expect(load).toHaveBeenCalledWith("workshop:work", "snapshot", url);
  });

  it("reports malformed final JSON and actual reading gaps together without scanning the fenced suffix", async () => {
    const args = input();
    args.rawText = `Here is my report:\n\`\`\`json\n${JSON.stringify(report())}\n\`\`\``;
    args.events = [bodyEvent({ contentLength: 100, nextOffset: 100 })];
    const text = await feedback(args);
    expect(text).toContain("最终 JSON 不合法");
    expect(text).toContain(`连续覆盖 100/${content.length}`);
    expect(text).toContain(`"url":"${url}"`);
    expect(text).toContain('"nextOffset":100');
    expect(text).toContain('"offset":100');
    expect(text).toContain('"evidenceId":"snapshot"');
    expect(text).toContain('"eventId":"body-event"');
    expect(load).not.toHaveBeenCalled();
  });

  it("provides the verified contiguous next offset instead of jumping to a later page", async () => {
    const args = input();
    args.events = [bodyEvent({ contentLength: 100, nextOffset: 100 }), {
      ...bodyEvent({ offset: 200, contentLength: content.length - 200, nextOffset: null }), id: "jump-event",
    }];
    const text = await feedback(args);
    expect(text).toContain('"nextOffset":100');
    expect(text).not.toContain('"eventId":"jump-event"');
    expect(text).not.toContain('"nextOffset":200');
  });

  it("returns real quote issues, actual event ranges and concise correction instructions", async () => {
    const args = input();
    const bad = report(); bad.researchEvidence.works[0].supportedClaims[0].quote = "The method uses rule-based [...] without a neural reward model.";
    args.rawText = JSON.stringify(bad);
    const text = await feedback(args);
    expect(text).toContain("短摘未完整出现在所引用的同版正文窗口中");
    expect(text).toContain('"eventId":"body-event"');
    expect(text).toContain('"offset":0');
    expect(text).toContain(`"endOffset":${content.length}`);
    expect(text).toContain("仅 3 条 claim");
    expect(text).toContain("80–800");
    expect(text).toContain("硬上限1600");
    expect(text).toContain("保留 brief");
    expect(text).toContain("不能用 [...]");
    expect(text).toContain("不等于语义独立审核通过");
    expect(text).toContain("也不会直接投递");
  });

  it("offers the exact saved Math sentence including inline citations without repairing the rejected candidate", async () => {
    // Verbatim sentence from review48's owned 2402.03300v3 body. The model
    // deleted [^9]/[^17], so repeating only the error did not help it recover.
    const exact = "The evaluation results indicate that the large-scale corpus is of high quality, as our base model DeepSeekMath-Base 7B achieves 64.2% on GSM8K [^9] and 36.2% on the competition-level MATH dataset [^17], outperforming Minerva 540B [^25].";
    const body = `${quotes.method}\n\n## 1 Introduction\n\n${exact}\n\n${quotes.limitation}`;
    const bodyHash = createHash("sha256").update(body).digest("hex");
    load.mockResolvedValue({ snapshot: { evidenceId: "snapshot", contentHash: bodyHash, url, content: body } });
    const args = input();
    args.events = [bodyEvent({ contentHash: bodyHash, contentLength: body.length, totalChars: body.length })];
    const bad = report();
    bad.researchEvidence.works[0].supportedClaims[1] = { kind: "experiment", claim: "DeepSeekMath-Base 7B 在 GSM8K 达64.2%，MATH达36.2%，超过Minerva 540B。", locator: "Section 1 Introduction", quote: "DeepSeekMath-Base 7B achieves 64.2% on GSM8K and 36.2% on the competition-level MATH dataset, outperforming Minerva 540B", evidenceEventId: "body-event" };
    args.rawText = JSON.stringify(bad);
    const original = args.rawText;
    const text = await feedback(args);
    expect(text).toContain(`"quote":${JSON.stringify(exact)}`);
    expect(text).toContain('"sectionHeading":"## 1 Introduction"');
    expect(text).toContain("只作为纠正候选");
    expect(args.rawText).toBe(original);
    const rejected = await validateWorkshopResearchFinal(args);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.issues.some(issue => issue.includes("短摘未完整"))).toBe(true);
  });

  it("offers a numeric R1 passage instead of only repeating that its qualitative quote lacks 79.8 and 2024", async () => {
    // Verbatim review48 introduction sentence, with the reported metric and
    // comparison scope together. The suggestion itself grants no approval.
    const exact = "- Reasoning tasks: (1) DeepSeek-R1 achieves a score of 79.8% Pass@1 on AIME 2024, slightly surpassing OpenAI-o1-1217.";
    const qualitative = "On math tasks, DeepSeek-R1 demonstrates performance on par with OpenAI-o1-1217, surpassing other models by a large margin.";
    const body = `${quotes.method}\n\n## 1 Introduction\n\n${exact} On MATH-500, it attains an impressive score of 97.3%, performing on par with OpenAI-o1-1217 and significantly outperforming other models.\n\n## 3 Evaluation\n\n${qualitative}\n\n${quotes.limitation}`;
    const bodyHash = createHash("sha256").update(body).digest("hex");
    load.mockResolvedValue({ snapshot: { evidenceId: "snapshot", contentHash: bodyHash, url, content: body } });
    const args = input(); args.events = [bodyEvent({ contentHash: bodyHash, contentLength: body.length, totalChars: body.length })];
    const bad = report(); bad.researchEvidence.works[0].supportedClaims[1] = { kind: "experiment", claim: "DeepSeek-R1在AIME 2024达79.8% Pass@1，与OpenAI-o1-1217性能相当", locator: "Section 3", quote: qualitative, evidenceEventId: "body-event" };
    args.rawText = JSON.stringify(bad);
    const text = await feedback(args);
    expect(text).toContain(`"quote":${JSON.stringify(exact)}`);
    expect(text).toContain('"sectionHeading":"## 1 Introduction"');
    expect(text).toContain("不是语义支持证明");
    expect(text).toContain("数字 79.8% 未在短摘中出现");
  });

  it("includes a real duplicate read ID in correction suggestions while excluding conflicting, stale and forged receipts", async () => {
    const args = input(); const bad = report();
    bad.researchEvidence.works[0].supportedClaims[0].quote = "The method uses rule-based [...] without a neural reward model.";
    bad.researchEvidence.works[0].supportedClaims[0].evidenceEventId = "duplicate-event";
    args.rawText = JSON.stringify(bad);
    args.events = [bodyEvent(), { ...bodyEvent(), id: "duplicate-event" },
      { ...bodyEvent(), id: "stale-event", runId: "old-run" },
      { ...bodyEvent({ receiptAuthority: "agent" }), id: "forged-event" },
      { ...bodyEvent(), id: "conflict-event" }, { ...bodyEvent({ offset: 1 }), id: "conflict-event" }];
    const text = await feedback(args);
    expect(text).toContain('"eventId":"duplicate-event"');
    expect(text).not.toContain('"eventId":"stale-event"');
    expect(text).not.toContain('"eventId":"forged-event"');
    expect(text).not.toContain('"eventId":"conflict-event"');
  });

  it("rejects false numeric claims rather than repairing their digits", async () => {
    const args = input();
    const bad = report(); bad.researchEvidence.works[0].supportedClaims[1].claim = "Qwen-32B 在 AIME 2024 得分 64.6。";
    args.rawText = JSON.stringify(bad);
    expect(await feedback(args)).toContain("数字 64.6 未在短摘中出现");
  });

  it("never offers IDs from a different run or agent-authored source logs as true windows", async () => {
    const args = input();
    args.events = [{ ...bodyEvent(), id: "other-run-event", runId: "other-run" }, {
      ...bodyEvent({ receiptAuthority: "agent" }), id: "agent-event",
    }];
    const text = await feedback(args);
    expect(text).toContain("连续覆盖 0/未知");
    expect(text).toContain('"nextOffset":0');
    expect(text).not.toContain('"eventId":"other-run-event"');
    expect(text).not.toContain('"eventId":"agent-event"');
    expect(text).not.toContain('"evidenceId":"snapshot"');
  });

  it("limits citation window hints to five real windows per source", async () => {
    const args = input();
    args.rawText = "invalid";
    args.events = Array.from({ length: 6 }, (_, index) => {
      const offset = Math.floor(content.length * index / 6);
      const end = Math.floor(content.length * (index + 1) / 6);
      return { ...bodyEvent({ offset, contentLength: end - offset, nextOffset: index === 5 ? null : end }), id: `window-${index}` };
    });
    const text = await feedback(args);
    for (let index = 0; index < 5; index++) expect(text).toContain(`"eventId":"window-${index}"`);
    expect(text).not.toContain('"eventId":"window-5"');
    expect(text).toContain("另有 1 个真实窗口");
  });

  it("caps returned issues at twenty while keeping the schema strict", async () => {
    const args = input();
    args.rawText = JSON.stringify({ researchEvidence: { reportVersion: "grounded-report/v1", works: [{ sourceId: "r1",
      supportedClaims: Array.from({ length: 9 }, () => ({ kind: "wrong", claim: "", locator: "", quote: "", evidenceEventId: "" })) }], gaps: [] } });
    const text = await feedback(args);
    expect(text.match(/^\d+\. /gmu)).toHaveLength(20);
    expect(text).toContain("未通过原因未列出");
  });

  it("caps feedback length without truncating the closing boundary and correction guidance", async () => {
    const args = input();
    args.events = [];
    args.rawText = "invalid";
    args.modelConfig.researchEvidenceContract.requiredPrimarySources = Array.from({ length: 20 }, (_, index) => ({
      id: `source-${index}`, label: `Source ${index}`, urls: [`https://example.com/paper-${index}?q=${"x".repeat(1900)}`],
    }));
    const text = await feedback(args);
    expect(text).toContain("反馈内容已达长度上限");
    expect(text.endsWith("也不会直接投递。")).toBe(true);
  });

  it("rejects an overflowing receipt collection and missing saved bodies without refetch", async () => {
    expect(await feedback({ ...input(), eventsOverflow: true } as ReturnType<typeof input>)).toContain("来源事件超过核验上限");
    expect(load).not.toHaveBeenCalled();
    load.mockRejectedValueOnce(Error("unavailable"));
    expect(await feedback()).toContain("快照缺失或身份校验失败");
    expect(load).toHaveBeenCalledOnce();
  });

  it("leaves unrelated admitted tasks and the previous delivery format untouched", async () => {
    const args = input();
    args.taskText = "Check current status";
    args.rawText = "ordinary reply";
    expect(await validateWorkshopResearchFinal(args)).toEqual({ ok: true });
    args.taskText = "Read DeepSeek";
    delete (args.modelConfig.researchEvidenceContract as Partial<typeof contract>).reportDelivery;
    expect(await validateWorkshopResearchFinal(args)).toEqual({ ok: true });
    expect(load).not.toHaveBeenCalled();
  });
});
