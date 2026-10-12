import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
const load = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/jina-page-reader", () => ({ loadWebEvidence: load }));
import { finalizeWorkshopResearchReaderDelivery } from "@/lib/workshops/research-reader-delivery";
import type { WorkshopExecutionResult } from "@/lib/workshops/executor";
import { validateWorkshopResearchFinal } from "@/lib/workshops/research-final-validation";

const modelConfig = { researchEvidenceContract: { version: "primary-reading/v1", taskKeywords: ["queue"],
  reportDelivery: "grounded-report/v1", requiredPrimarySources: [{ id: "queue-study", label: "Queue Study",
    urls: ["https://example.com/study"] }] } };
const report = "# 排队系统研究\n\n核心问题是到达率变化如何影响等待时间。\n\n在已读章节中，反馈调整优于固定阈值的地方在于能够响应突发请求。我的理解是先识别系统负载再调整服务能力；这仍需在实际场景中验证。\n\n## 下一步阅读\n\n先看方法，再核对实验条件。尚未读完附录。";
function input(output = report, structured: WorkshopExecutionResult["structured"] = null) {
  return { workshopId: "work", runId: "run", modelConfig, taskText: "Read queue study", events: [],
    result: { status: "success" as const, output, structured, toolCallCount: 1, durationMs: 5 } };
}
const naturalCandidate = readFileSync(new URL("../fixtures/research-reader-natural-a71a7f43.md", import.meta.url), "utf8").trimEnd();
describe("reader-first research delivery with independent verification", () => {
  beforeEach(() => load.mockReset());
  it("delivers useful Markdown with partial reading and explicitly unverified evidence", async () => {
    const observed = await finalizeWorkshopResearchReaderDelivery(input());
    expect(observed.audit).toMatchObject({ version: "reader-report/v1", status: "delivered", verificationStatus: "unverified" });
    expect(observed.verification.status).toBe("evidence_insufficient");
    expect(observed.result.structured?.presentation).toMatchObject({ source: "host_research_reader", researchBriefMarkdown: report });
    expect(observed.result.structured?.presentation?.warnings).toContain("报告已生成；来源覆盖与逐条引用尚未全部核验，请结合下方依据与限制阅读。");
    expect(load).not.toHaveBeenCalled();
  });
  it("keeps author prose intact without a fixed section, claim count or word count", async () => {
    const prose = "我的理解是先分清训练目标与使用条件，再决定该方法是否值得复现。具体分数还需要核对。";
    expect((await finalizeWorkshopResearchReaderDelivery(input(prose))).result.structured?.presentation?.researchBriefMarkdown).toBe(prose);
  });
  it.each([
    "# 规则奖励\n\n数学题要求把最终答案放在 \\boxed{} 中，再用规则匹配核对；这只是已读方法的说明。",
    "正文中的空对象 `{}` 和非空对象 `{\"setting\":true}` 都是示例，尚未验证设置的效果。",
    "# 参数示例\n\n论文方法可用下面的结构说明。\n\n```json\n{\"setting\":true}\n```\n\n它是一个配置示例，效果仍需根据实验核对。",
    "# 程序示例\n\n```js\nconst sample = {\"setting\":true};\n```\n\n对象属于代码示例，保留原文供阅读。",
    "这个对象展示参数如何传入，效果仍需实验核对。\n```json\n{\"setting\":true}\n```",
    "# 参数示例：\n```json\n{\"setting\":true}\n```",
    "正文用对象 {\"presentation\":{\"reportMarkdown\":\"示例字段\"}} 展示存储格式，不能把示例字段替代真实段落。",
    naturalCandidate,
  ])("preserves Markdown formulas and object examples through precheck and delivery: %#", async markdown => {
    const args = input(markdown);
    expect(await validateWorkshopResearchFinal({ ...args, rawText: markdown })).toEqual({ ok: true });
    const observed = await finalizeWorkshopResearchReaderDelivery(args);
    expect(observed.audit).toMatchObject({ status: "delivered", verificationStatus: "unverified" });
    expect(observed.result.structured?.presentation?.researchBriefMarkdown).toBe(markdown);
    expect(load).not.toHaveBeenCalled();
  });
  it("uses the complete captured natural candidate, including its boxed formula", () => {
    expect(naturalCandidate).toHaveLength(7906);
    expect(naturalCandidate).toContain("\\boxed{}");
    expect(naturalCandidate.startsWith("# DeepSeek 三篇论文")).toBe(true);
  });
  it.each([
    JSON.stringify({ reportMarkdown: report }),
    "```json\n" + JSON.stringify({ presentation: { reportMarkdown: report } }) + "\n```",
  ])("continues rendering a complete explicit JSON report: %#", async json => {
    const observed = await finalizeWorkshopResearchReaderDelivery(input(json));
    expect(observed.audit).toMatchObject({ status: "delivered", verificationStatus: "unverified" });
    expect(observed.result.structured?.presentation?.researchBriefMarkdown).toBe(report);
  });
  it("keeps Markdown code blocks inside a complete JSON report as report content", async () => {
    const markdown = "# 方法\n\n```json\n{\"setting\":true}\n```\n\n示例参数尚需实验核对。";
    const json = "以下是报告：\n```json\n" + JSON.stringify({ reportMarkdown: markdown }) + "\n```";
    const observed = await finalizeWorkshopResearchReaderDelivery(input(json));
    expect(observed.audit?.status).toBe("delivered");
    expect(observed.result.structured?.presentation?.researchBriefMarkdown).toBe(markdown);
  });
  it.each([
    "{}", '{"summary":"Work will start shortly."}', '[{"reportMarkdown":"正文不能从数组中捞出。"}]',
    "```json\n{}\n```", "以下是报告：\n```json\n{}\n```",
    '{"reportMarkdown":"unfinished', '{"reportMarkdown":"正文"} trailing',
    '{broken} {"reportMarkdown":"不能从错误包络后捞出正文。"}',
    '```json\n{"reportMarkdown":"正文"}\n```\nextra',
    '以下是报告：\n```json\n{"reportMarkdown":"unfinished',
    '以下是报告：\n```json\n{"outer":{"reportMarkdown":"内层对象不代表完整包络。"}\n```',
    '```json\n{"reportMarkdown":"正文"}\n```\n```json\n{}\n```',
  ])("rejects absent, malformed or multiple explicit JSON envelopes: %#", async json => {
    expect((await finalizeWorkshopResearchReaderDelivery(input(json))).audit?.status).toBe("rejected");
    expect((await validateWorkshopResearchFinal({ ...input(json), rawText: json })).ok).toBe(false);
  });
  it.each([{}, { summary: "Work will start shortly." }, { researchEvidence: { works: [] } }])(
    "rejects an explicitly supplied structured payload without report content: %#", async structured => {
      const observed = await finalizeWorkshopResearchReaderDelivery(input(report, structured));
      expect(observed.audit?.status).toBe("rejected");
    });
  it("renders a complete structured draft with a preface without claiming strict approval or executing its fields", async () => {
    const candidate = { researchEvidence: { reportVersion: "grounded-report/v1", works: [{ sourceId: "queue-study", supportedClaims: [
      { kind: "method", claim: "使用反馈式容量调节。" }, { kind: "experiment", claim: "模型在指定设置下得分 99.9，仍待核对。" },
    ] }], gaps: ["附录没有读取。"], brief: { title: "反馈为什么有用", question: "如何处理突发负载？", findings: [{ text: "响应当前负载比固定阈值更贴近实际需求。", claimRefs: [] }], readingPath: [] } },
      memoryCandidates: [{ content: "do not write" }], outboxDrafts: [{ message: "do not send" }] };
    const text = "以下是阶段报告：\n```json\n" + JSON.stringify(candidate) + "\n```";
    const before = JSON.stringify(candidate);
    const observed = await finalizeWorkshopResearchReaderDelivery(input(text));
    expect(observed.audit).toMatchObject({ status: "delivered", verificationStatus: "unverified" });
    expect(observed.result.structured?.presentation?.researchBriefMarkdown).toContain("反馈为什么有用");
    expect(observed.result.structured?.presentation?.researchBriefMarkdown).toContain("99.9");
    expect(observed.result.structured?.presentation?.reportMarkdown).toContain("未完成逐条引用核验");
    expect(observed.result.structured?.memoryCandidates).toBeUndefined();
    expect(observed.result.structured?.outboxDrafts).toBeUndefined();
    expect(JSON.stringify(candidate)).toBe(before);
  });
  it("does not turn empty output, truncated JSON or host error checkpoints into reports", async () => {
    for (const text of ["", '{"researchEvidence":{"works":[', "Final validation correction limit exhausted", "Workshop run completed"]) {
      const observed = await finalizeWorkshopResearchReaderDelivery(input(text));
      expect(observed.audit?.status, text).toBe("rejected");
    }
  });
  it("does not convert runtime failure into completed delivery even when a draft exists", async () => {
    const args = input();
    const observed = await finalizeWorkshopResearchReaderDelivery({ ...args, result: { ...args.result, status: "error", error: "aborted" } });
    expect(observed.audit?.status).toBe("rejected");
    expect(observed.result.status).toBe("error");
  });
  it("has a stable canonical delivery hash and leaves unrelated tasks unchanged", async () => {
    const first = await finalizeWorkshopResearchReaderDelivery(input());
    expect(first.audit?.canonicalHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await finalizeWorkshopResearchReaderDelivery(input())).audit?.canonicalHash).toBe(first.audit?.canonicalHash);
    const other = { ...input(), taskText: "check status" };
    expect((await finalizeWorkshopResearchReaderDelivery(other)).result).toBe(other.result);
    expect((await finalizeWorkshopResearchReaderDelivery(other)).audit).toBeUndefined();
  });
});
