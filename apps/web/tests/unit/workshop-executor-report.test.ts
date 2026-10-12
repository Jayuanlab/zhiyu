import { describe, expect, it } from "vitest";
import type { Workshop } from "@/lib/db/schema";
import { normalizeWorkshopAgentReport } from "@/lib/workshops/executor";

function workshop(config: Record<string, unknown> = {}): Workshop {
  return {
    id: "research", userId: "owner", name: "知遇技术研究院",
    mission: "研究外部材料与项目的真实匹配和新增价值。",
    status: "active", autonomyLevel: "auto", boundaryPolicy: {},
    modelConfig: { role: "agent_frontier_researcher", researchReportStyle: "freeform_project_value", ...config },
    createdAt: new Date("2026-10-02"), updatedAt: new Date("2026-10-02"),
  } as Workshop;
}

function jsonReport(value: Record<string, unknown>, preface = "") {
  return `${preface}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

describe("ordinary Work authored report adaptation", () => {
  it("uses the complete final object only for the active grounded research contract", () => {
    const configured = workshop({ researchEvidenceContract: {
      version: "primary-reading/v1", reportDelivery: "grounded-report/v1", taskKeywords: ["deepseek"],
      requiredPrimarySources: [{ id: "paper", label: "Paper", urls: ["https://example.com/paper"] }],
    } });
    const report = { researchEvidence: { reportVersion: "grounded-report/v1", works: [], gaps: [] } };
    const valid = JSON.stringify(report);
    expect(normalizeWorkshopAgentReport({ workshop: configured, researchTask: "deepseek", rawText: valid }).structured).toEqual(report);
    for (const rawText of [valid + "\n" + valid, "Draft\n" + valid, '{"broken":' + valid]) {
      expect(normalizeWorkshopAgentReport({ workshop: configured, researchTask: "deepseek", rawText }).structured).toBeNull();
    }
    expect(normalizeWorkshopAgentReport({ workshop: configured, researchTask: "unrelated", rawText: "Draft\n" + valid }).structured).not.toBeNull();
  });

  it("stores a complete JSON-only article in the presentation without model duplication", () => {
    const article = "恢复机制的项目匹配需要核验外部副作用边界。\n\n" + "机制、代码证据与反例。\n\n".repeat(1_000) + "最后的可证伪验证条件。";
    const rawText = jsonReport({ reportMarkdown: article, checkpoint: { cursor: "fixture" } });
    const result = normalizeWorkshopAgentReport({ workshop: workshop(), rawText });

    expect(result.output).toBe("恢复机制的项目匹配需要核验外部副作用边界。");
    expect(result.structured?.presentation?.reportMarkdown).toBe(article);
    expect(result.structured).toMatchObject({ checkpoint: { cursor: "fixture" } });
    expect(result.structured?.presentation?.reportMarkdown).toEqual(expect.stringContaining("最后的可证伪验证条件。"));
  });

  it("selects article prose for the owner summary despite an English preface", () => {
    const article = "外部方案只在可重放动作边界内有新增价值。\n\n明确假设、反例与验证。";
    const result = normalizeWorkshopAgentReport({ workshop: workshop(),
      rawText: jsonReport({ reportMarkdown: article }, "Now I have enough information to write the report.") });

    expect(result.output).toBe("外部方案只在可重放动作边界内有新增价值。");
    expect(result.structured?.presentation?.summary).toBe(result.output);
    expect(result.structured?.presentation?.reportMarkdown).toBe(article);
  });

  it("preserves presentation evidence and limits while an explicit final report wins", () => {
    const presentation = {
      title: "恢复边界研究", summary: "旧摘要", reportMarkdown: "旧正文",
      evidenceEventIds: ["actual-source-event"], warnings: ["未做实际恢复测试"],
      nextSteps: ["在受控环境验证重放"],
    };
    const finalArticle = "最终正文说明已核与未核边界。\n\n保留反例。";
    const result = normalizeWorkshopAgentReport({ workshop: workshop(), rawText: jsonReport({
      finalMarkdownReport: finalArticle, reportMarkdown: "另一个正文别名", presentation,
    }) });

    expect(result.output).toBe("最终正文说明已核与未核边界。");
    expect(result.structured?.presentation).toEqual({
      ...presentation, summary: result.output, reportMarkdown: finalArticle,
    });

    const presentationOnly = normalizeWorkshopAgentReport({ workshop: workshop(), rawText: jsonReport({
      presentation: { ...presentation, reportMarkdown: finalArticle },
    }, "Now I have enough information.") });
    expect(presentationOnly.output).toBe("最终正文说明已核与未核边界。");
    expect(presentationOnly.structured?.presentation).toEqual({
      ...presentation, summary: presentationOnly.output, reportMarkdown: finalArticle,
    });
  });

  it("retains the existing return shape for other roles and unconfigured researchers", () => {
    const original = { summary: "原摘要", reportMarkdown: "别名正文", presentation: { title: "原标题", reportMarkdown: "原展示正文" } };
    const rawText = jsonReport(original, "Original visible text.");
    for (const config of [{ role: "writing_assistant" }, { researchReportStyle: undefined }]) {
      expect(normalizeWorkshopAgentReport({ workshop: workshop(config), rawText })).toEqual({
        output: "原摘要", structured: original,
      });
    }
  });
});
