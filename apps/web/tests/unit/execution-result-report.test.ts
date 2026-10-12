import { describe, expect, it } from "vitest";
import {
  buildStructuredExecutionReport,
  normalizeReasoningSourceType,
  parseStructuredOutput,
} from "@/lib/types/execution-result";
import { verifyLoopRun } from "@/lib/loops";

describe("structured execution report", () => {
  it("displays the complete JSON-only research report without a summary or repair truncation", () => {
    const fullReport = "外部方法在不同恢复边界下的证据与适用条件。\n\n".repeat(2000) + "末尾反例与最小验证方案必须保留。";
    const rawText = `<structured-output>${JSON.stringify({ summary: "短摘要", reportMarkdown: fullReport,
      researchProcess: {}, projectAssessment: {}, checkpoint: {}, warnings: [] })}</structured-output>`;
    const parsed = parseStructuredOutput(rawText);
    expect(parsed.cleanText).toBe("");
    const report = buildStructuredExecutionReport({ structuredData: parsed.data, cleanText: parsed.cleanText, rawText,
      requiredFields: ["reportMarkdown", "researchProcess", "projectAssessment", "checkpoint", "warnings"] });
    expect(report.finalMarkdownReport).toBe(fullReport);
    expect(report.reportMarkdown).toBe(fullReport);
    expect(report.finalMarkdownReport?.endsWith("末尾反例与最小验证方案必须保留。")).toBe(true);
    expect(report.diagnostics?.warnings).not.toContain("required_fields_repaired_from_full_report");
  });

  it("opts in to authored report priority while explicit finalMarkdownReport always wins", () => {
    const run = (structuredData: Record<string, unknown>, cleanText = "可见正文", preferReportMarkdown = false) => buildStructuredExecutionReport({
      structuredData, cleanText, rawText: cleanText, preferReportMarkdown,
    }).finalMarkdownReport;
    expect(run({ finalMarkdownReport: "指定正文", reportMarkdown: "研究正文" })).toBe("指定正文");
    expect(run({ finalMarkdownReport: "指定正文", reportMarkdown: "研究正文" }, "可见正文", true)).toBe("指定正文");
    expect(run({ finalMarkdownReport: "  ", reportMarkdown: "研究正文" })).toBe("可见正文");
    expect(run({ finalMarkdownReport: "  ", reportMarkdown: "研究正文" }, "可见正文", true)).toBe("研究正文");
    expect(run({ reportMarkdown: "研究正文" }, "")).toBe("研究正文");
    for (const reportMarkdown of [undefined, null, "", " \n\t ", { text: "不是正文字符串" }]) {
      for (const preferReportMarkdown of [false, true]) {
        expect(run({ reportMarkdown }, "可见正文", preferReportMarkdown)).toBe("可见正文");
      }
    }
    expect(run({ summary: "仅摘要", reportMarkdown: "  " }, "")).toBe("# 仅摘要");
  });

  it("keeps a complete visible article ahead of a short alias by default", () => {
    const fullArticle = "完整正文的机制、项目证据和反例。\n\n".repeat(500) + "最后的验证条件。";
    const report = buildStructuredExecutionReport({
      structuredData: { reportMarkdown: "短别名正文" }, cleanText: fullArticle, rawText: fullArticle,
    });
    expect(report.finalMarkdownReport).toBe(fullArticle);
    expect(report.summary).toBe("完整正文的机制、项目证据和反例。");
  });

  it("derives an opted-in missing summary from the actual article ahead of an English preface", () => {
    const article = "恢复边界决定方法对知遇的适用性。\n\n" + "机制、代码证据和反例。".repeat(500);
    const preface = "Now I have enough information to write the report.";
    const rawText = `${preface}\n<structured-output>${JSON.stringify({ reportMarkdown: article })}</structured-output>`;
    const parsed = parseStructuredOutput(rawText);
    const report = buildStructuredExecutionReport({
      structuredData: parsed.data, cleanText: parsed.cleanText, rawText, preferReportMarkdown: true,
    });
    expect(report.summary).toBe("恢复边界决定方法对知遇的适用性。");
    expect(report.finalMarkdownReport).toBe(article);
    expect(report.summary).not.toContain("Now I have");
    const explicit = buildStructuredExecutionReport({
      structuredData: { ...parsed.data, finalMarkdownReport: "显式最终正文首行。\n\n最终论证。" },
      cleanText: parsed.cleanText, rawText, preferReportMarkdown: true,
    });
    expect(explicit.summary).toBe("显式最终正文首行。");
  });

  it("does not let a repaired mandatory reportMarkdown preview hide the full visible article", () => {
    const fullReport = "完整论证需要保留机制、项目匹配、边界和反例。\n\n".repeat(500) + "最后一段是可证伪验证方案。";
    for (const reportMarkdown of [undefined, null, "", "  "]) {
      const report = buildStructuredExecutionReport({ structuredData: { summary: "短摘要", reportMarkdown },
        cleanText: fullReport, rawText: fullReport, requiredFields: ["reportMarkdown"] });
      expect(report.finalMarkdownReport).toBe(fullReport);
    }
  });

  it("derives a missing short summary from JSON-only article prose rather than exposing metadata", () => {
    const fullReport = "恢复边界决定外部方法对知遇的适用性。\n\n" + "机制、证据和反例。".repeat(500);
    const rawText = `<structured-output>${JSON.stringify({ reportMarkdown: fullReport })}</structured-output>`;
    const parsed = parseStructuredOutput(rawText);
    const report = buildStructuredExecutionReport({ structuredData: parsed.data, cleanText: parsed.cleanText, rawText });
    expect(report.summary).toBe("恢复边界决定外部方法对知遇的适用性。");
    expect(report.finalMarkdownReport).toBe(fullReport);
    expect(report.summary).not.toContain("structured-output");
  });

  it("builds stable reasoning steps when model structured output is missing", () => {
    const report = buildStructuredExecutionReport({
      structuredData: {},
      cleanText: "之前的搜索任务没有返回有用内容，但日报已生成。",
      rawText: "之前的搜索任务没有返回有用内容，但日报已生成。",
      taskText: "生成每日汇报",
      traceEvents: [
        { type: "tool_used", toolName: "webSearch", status: "running" },
        { type: "tool_result", status: "completed" },
      ],
    });

    expect(report.summary).toBe(
      "之前的搜索任务没有返回有用内容，但日报已生成。",
    );
    expect(report.reasoningChain?.length).toBeGreaterThanOrEqual(3);
    expect(
      report.reasoningChain?.some((step) => step.sourceType === "unknown"),
    ).toBe(false);
    expect(report.diagnostics?.warnings).toContain("model_reasoning_missing");
  });

  it("keeps model-provided English summaries intact", () => {
    const parsed = parseStructuredOutput(`<structured-output>
{
  "summary": "No platform data available because Telegram Slack and Gmail are not connected",
  "subtitle": "Telegram/Slack/Gmail not connected"
}
</structured-output>`);

    expect(parsed.data.summary).toBe(
      "No platform data available because Telegram Slack and Gmail are not connected",
    );
    expect(parsed.data.subtitle).toBe("Telegram/Slack/Gmail not connected");
  });

  it("localizes system-generated reasoning steps for English users", () => {
    const report = buildStructuredExecutionReport({
      structuredData: {},
      cleanText: "Collected 12 insights and extracted 11 action items.",
      rawText: "Collected 12 insights and extracted 11 action items.",
      taskText: "Collect today's information from Telegram Slack and Gmail",
      traceEvents: [
        { type: "tool_used", toolName: "chatInsight", status: "running" },
        { type: "tool_result", status: "completed" },
        { type: "tool_result", status: "error" },
      ],
      sessionFiles: [
        {
          name: "action-items.md",
          path: "/tmp/session/action-items.md",
          type: "md",
          role: "output",
        },
      ],
      language: "en-US",
    });

    expect(report.subtitle).toBe("Generated 1 file");
    expect(report.reasoningChain?.map((step) => step.summary)).toEqual(
      expect.arrayContaining([
        "Task received",
        "Collected information with tools",
        "Organized execution result",
        "Generated files",
        "Run completed",
      ]),
    );
    expect(report.reasoningChain?.map((step) => step.sourceLabel)).toEqual(
      expect.arrayContaining([
        "Task configuration",
        "Tool execution",
        "System summary",
        "Output files",
        "Execution result",
      ]),
    );
    expect(
      report.reasoningChain?.some((step) =>
        /[\u4e00-\u9fff]/u.test(
          `${step.summary} ${step.description ?? ""} ${step.sourceLabel ?? ""}`,
        ),
      ),
    ).toBe(false);
    expect(report.suggestedActions?.[0]).toMatchObject({
      type: "open_file",
      label: "Open action-items.md",
    });
  });

  it("normalizes unsupported source types instead of leaking unknown", () => {
    expect(normalizeReasoningSourceType("local_file")).toBe("file");
    expect(normalizeReasoningSourceType("browser")).toBe("web");
    expect(normalizeReasoningSourceType("task")).toBe("system");
  });

  it("normalizes model source type aliases during parsing", () => {
    const parsed = parseStructuredOutput(`<structured-output>
{
  "summary": "完成演示文稿",
  "reasoningChain": [
    { "summary": "读取 PPT", "sourceType": "pptx" }
  ]
}
</structured-output>`);

    expect(parsed.data.reasoningChain?.[0]?.sourceType).toBe("file");
  });

  it("adds generated files to reasoning and suggested actions", () => {
    const report = buildStructuredExecutionReport({
      structuredData: {
        summary: "完成演示文稿",
        reasoningChain: [
          {
            summary: "整理内容",
            sourceType: "pptx" as any,
          },
        ],
      },
      cleanText: "已生成文件。",
      rawText: "已生成文件。",
      taskText: "制作 PPT",
      sessionFiles: [
        {
          name: "Presentation.pptx",
          path: "/tmp/session/Presentation.pptx",
          type: "pptx",
          role: "output",
        },
      ],
    });

    expect(report.files).toHaveLength(1);
    expect(report.reasoningChain?.map((step) => step.stepType)).toContain(
      "generate",
    );
    expect(report.suggestedActions?.[0]).toMatchObject({
      type: "open_file",
      label: "Open Presentation.pptx",
    });
  });

  it("repairs required loop fields from a markdown trading report", () => {
    const rawText = [
      "All data collected. Final report follows.",
      "## 2026-08-12 midday trading check",
      "### Account state",
      "Total assets 1,009,362; cash 567,983; holdings 9.",
      "### Trade plan ledger",
      "Reviewed due plans and marked blocked items.",
      "### Trend state review",
      "Robot ETF is in break_warning; no add until repaired.",
      "### Rotation decision",
      "Hold existing positions; no replacement order now.",
      "### Action taken",
      "No new order submitted.",
      "### Risk assessment",
      "Keep cash buffer and protect profitable holdings.",
      "### Learning feedback",
      "Trend warnings must become explicit control decisions.",
    ].join("\n");

    const report = buildStructuredExecutionReport({
      structuredData: {},
      cleanText: rawText,
      rawText,
      taskText: "Run intraday paper trading check",
      requiredFields: [
        "accountState",
        "tradePlanLedger",
        "trendStateReview",
        "rotationDecision",
        "actionTaken",
        "riskAssessment",
        "learningFeedback",
        "trendFollowDecision",
      ],
    });

    const result = verifyLoopRun({
      verificationConfig: {
        type: "structured_check",
        requiredFields: [
          "accountState",
          "tradePlanLedger",
          "trendStateReview",
          "rotationDecision",
          "actionTaken",
          "riskAssessment",
          "learningFeedback",
          "trendFollowDecision",
        ],
        requiredSources: [],
      },
      result: {
        status: "success",
        output: rawText,
        duration: 10,
        result: { structuredReport: report },
      },
    });

    expect(report.accountState).toContain("Total assets");
    expect(report.trendFollowDecision).toMatchObject({
      marketState: "unknown",
      candidateDecisions: [
        expect.objectContaining({
          decision: "blocked",
          blockerType: "missing_structured_output",
          blockedReason: expect.stringContaining("structured"),
        }),
      ],
    });
    expect(report.diagnostics?.warnings).toEqual(
      expect.arrayContaining([
        "required_fields_repaired_from_markdown",
        "trend_follow_decision_repaired_as_blocked",
      ]),
    );
    expect(result.passed, JSON.stringify(result.issues)).toBe(true);
  });

  it("repairs required loop fields from compact Chinese trading report headings", () => {
    const rawText = [
      "## 2026-08-12 trading check",
      "### 账户状态",
      "Total assets reviewed.",
      "### 持仓盈亏排行",
      "Robot ETF warning noted.",
      "### 6个计划评估",
      "No planned trigger fired.",
      "### 关键风险",
      "Protect profit and keep cash buffer.",
      "### 决策",
      "No new order; hold and verify again.",
    ].join("\n");
    const requiredFields = [
      "accountState",
      "tradePlanLedger",
      "trendStateReview",
      "rotationDecision",
      "actionTaken",
      "riskAssessment",
      "learningFeedback",
      "trendFollowDecision",
    ];
    const report = buildStructuredExecutionReport({
      structuredData: {},
      cleanText: rawText,
      rawText,
      taskText: "Run intraday paper trading check",
      requiredFields,
    });
    const result = verifyLoopRun({
      verificationConfig: {
        type: "structured_check",
        requiredFields,
        requiredSources: [],
      },
      result: {
        status: "success",
        output: rawText,
        duration: 10,
        result: { structuredReport: report },
      },
    });

    expect(report.tradePlanLedger).toContain("planned trigger");
    expect(report.riskAssessment).toContain("cash buffer");
    expect(result.passed, JSON.stringify(result.issues)).toBe(true);
  });
});
