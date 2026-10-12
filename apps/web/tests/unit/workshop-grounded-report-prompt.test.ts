import { describe, expect, it } from "vitest";
import type { Workshop, WorkshopDirective } from "@/lib/db/schema";
import { buildWorkshopPrompt } from "@/lib/workshops/context-window";
import { composeWorkshopRunPrompt, WORKSHOP_BASE_SYSTEM_PROMPT } from "@/lib/workshops/run-prompt";
import { formatWorkshopResearchContract, resolveWorkshopResearchContract } from "@/lib/workshops/research-evidence-verification";
import { buildWorkshopRunTimeContext } from "@/lib/workshops/time-context";

const contract = {
  version: "primary-reading/v1", taskKeywords: ["deepseek"], minQualityScore: 60,
  reportDelivery: "grounded-report/v1",
  requiredPrimarySources: [
    { id: "deepseek-r1", label: "DeepSeek-R1", urls: ["https://arxiv.org/html/2501.12948v1"] },
  ],
};
const task = "让强化学习前沿学习者，重点看deepseek关于这方面的工作";
function workshop(researchContract: unknown = contract): Workshop {
  return {
    id: "researcher", userId: "owner", name: "强化学习前沿学习者", mission: "观察强化学习研究及其局限。",
    status: "active", autonomyLevel: "draft", boundaryPolicy: { deniedPrecedence: true },
    modelConfig: { role: "rl_researcher", contextProfile: "full", researchEvidenceContract: researchContract,
      manifestSpec: { presentation: { purpose: "LEGACY_PRESENTATION_PURPOSE", requiredSections: ["旧文章章节"] } } },
    createdAt: new Date("2026-10-09"), updatedAt: new Date("2026-10-09"),
  } as Workshop;
}
function legacyPrompt(work: Workshop, admittedTask = task, overrides: Partial<Parameters<typeof buildWorkshopPrompt>[0]> = {}) {
  return buildWorkshopPrompt({
    workshop: work, sources: [], memories: [], directives: [{
      id: "primary", workshopId: work.id, runId: null, content: admittedTask,
      priority: 0, scope: "current_run", status: "active", createdAt: new Date("2026-10-09"),
    } as WorkshopDirective], primaryDirectiveId: "primary", events: [], outbox: [], maxToolCalls: 30,
    runTimeContext: buildWorkshopRunTimeContext({ now: new Date("2026-10-09T00:00:00Z") }), ...overrides,
  });
}

describe("value-first research delivery prompt", () => {
  it("makes readable Markdown the default and preserves evidence as an optional audit", () => {
    const formatted = formatWorkshopResearchContract(workshop().modelConfig, task)!;
    expect(formatted).toContain("deepseek-r1（DeepSeek-R1）：https://arxiv.org/html/2501.12948v1");
    expect(formatted).toContain("最终默认直接交付 Markdown 研究正文");
    expect(formatted).toContain("章节、字数和结论数量由内容决定");
    expect(formatted).toContain("不要求每篇凑齐方法、实验、局限三类");
    expect(formatted).toContain("不必为了生成报告读完所有全文");
    expect(formatted).toContain("不因有缺口而丢弃整篇报告");
    expect(formatted).toContain("论文对照、例子和阅读建议");
    expect(formatted).toContain("真实来源链接或章节位置");
    expect(formatted).toContain("报告区分作者报告的事实、你的理解和仍待确认的问题");
    expect(formatted).toContain("模型版本、基准和采样条件");
    expect(formatted).toContain("报告已交付不代表引文、科学语义、复现或项目适用性已经核验");
    expect(formatted).toContain("结构化 researchEvidence JSON 是兼容的可选附件");
    expect(formatted).toContain("机器核验仍按原证据规则独立判断");
    expect(formatted).toContain("真实 selectionEventId 和 index");
    expect(formatted).toContain("不能构造引用、事件 ID 或章节");
    expect(formatted).toContain("不授予新工具、权限或预算");
    expect(formatted).not.toContain("最终答复只能交付一个完整、严格有效的 JSON");
    expect(formatted).not.toContain("顶层仅 researchEvidence");
    expect(formatted).not.toContain("brief 建议共 250–450 汉字");
    expect(formatted).not.toContain("phase=read_sources 时只按 pendingReadRequests 补读");
  });

  it("removes the contradictory default final report only for a matching opted-in system prompt", () => {
    const output = composeWorkshopRunPrompt({ workshop: workshop(), prompt: "已装配的任务上下文", researchTask: task });
    expect(output.systemPrompt).toContain("Markdown");
    expect(output.systemPrompt).not.toContain("最终仅交付本轮 grounded-report/v1");
    expect(output.systemPrompt).toContain("denied 优先于 allowed");
    expect(output.systemPrompt).not.toContain("presentation 含 title、summary、reportMarkdown");
    expect(output.systemPrompt).not.toContain("并补充 summary 与 presentation");
    expect(output.systemPrompt).not.toContain("LEGACY_PRESENTATION_PURPOSE");
    expect(output.manifest).toMatchObject({ researchContractActive: true, researchReportDelivery: "grounded-report/v1" });
    expect(output.prompt).toBe("已装配的任务上下文");
  });

  it("keeps value-first delivery for the configured freeform research role", () => {
    const work = workshop();
    work.modelConfig = { ...(work.modelConfig as Record<string, unknown>), role: "agent_frontier_researcher", researchReportStyle: "freeform_project_value" };
    const output = composeWorkshopRunPrompt({ workshop: work, prompt: task });
    expect(output.systemPrompt).toContain("最终默认直接交付 Markdown 研究正文");
    expect(output.systemPrompt).not.toContain("顶层仅 researchEvidence");
    const legacy = legacyPrompt(work);
    expect(legacy).toContain("最终默认直接交付 Markdown 研究正文");
    expect(legacy).not.toContain("顶层仅 researchEvidence");
    expect(legacy).not.toContain("在结尾的单一 ```json 代码块内用顶层 reportMarkdown");
  });

  it("uses one grounded final-output contract in legacy and no duplicate in separated Pi task context", () => {
    const work = workshop();
    const legacy = legacyPrompt(work);
    expect(legacy).toContain(formatWorkshopResearchContract(work.modelConfig, task)!);
    expect(legacy).not.toContain("Follow the same presentation shape for every Work role.");
    expect(legacy).not.toContain('"presentation":');
    expect(legacy).not.toContain('"logEvents":');
    expect(legacy).not.toContain("LEGACY_PRESENTATION_PURPOSE");
    const piTask = legacyPrompt(work, task, { separateSystemPrompt: true });
    expect(piTask).not.toContain("grounded-report/v1");
    expect(piTask).not.toContain('"presentation":');
    expect(piTask).toContain(task);
  });

  it("preserves the grounded contract when optional historical context exceeds the budget", () => {
    const work = workshop();
    work.mission = "optional historical context ".repeat(5_000);
    const legacy = legacyPrompt(work);
    expect(legacy).toContain("[Context truncated to fit workshop run budget.]");
    expect(legacy).toContain(formatWorkshopResearchContract(work.modelConfig, task)!);
    expect(legacy).toContain(task);
    expect(legacy.length).toBeLessThanOrEqual(40_000);
  });

  it("preserves ordinary reporting for an unrelated admitted task despite DeepSeek history", () => {
    const work = workshop();
    const output = composeWorkshopRunPrompt({ workshop: work, prompt: "历史任务是 DeepSeek", researchTask: "查看任务状态" });
    expect(output.systemPrompt).toContain(WORKSHOP_BASE_SYSTEM_PROMPT);
    expect(output.systemPrompt).toContain("LEGACY_PRESENTATION_PURPOSE");
    expect(output.systemPrompt).not.toContain("grounded-report/v1");
    expect(output.manifest).toMatchObject({ researchContractActive: false, researchReportDelivery: null });
    const legacy = legacyPrompt(work, "查看任务状态");
    expect(legacy).toContain('"presentation":');
    expect(legacy).not.toContain("grounded-report/v1");
  });

  it("keeps the previous reading/report protocol when reportDelivery is absent", () => {
    const { reportDelivery: _reportDelivery, ...previousContract } = contract;
    const work = workshop(previousContract);
    const output = composeWorkshopRunPrompt({ workshop: work, prompt: task });
    expect(output.systemPrompt).toContain(WORKSHOP_BASE_SYSTEM_PROMPT);
    expect(output.systemPrompt).toContain('"evidenceEventIds"');
    expect(output.systemPrompt).not.toContain("grounded-report/v1");
    expect(legacyPrompt(work)).toContain('"presentation":');
  });

  it("rejects unknown explicit delivery versions instead of silently weakening verification", () => {
    const work = workshop({ ...contract, reportDelivery: "grounded-report/v99" });
    const resolution = resolveWorkshopResearchContract(work.modelConfig, task);
    expect(resolution.active).toBe(true);
    expect(resolution.issues.join(" ")).toContain("reportDelivery");
    expect(() => composeWorkshopRunPrompt({ workshop: work, prompt: task }))
      .toThrow("Invalid workshop research evidence contract");
  });
});
