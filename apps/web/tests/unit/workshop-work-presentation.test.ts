import { describe, expect, it } from "vitest";
import {
  buildWorkPresentation,
  type WorkPresentationEvent,
} from "@/lib/workshops/work-presentation";

const WORK_ID = "b0252cc6-8e80-45fa-b125-ead5618bc4ad";
const RUN_ID = "a42df8b8-0c8d-84be-ad84-ef2b70153af0";
const HASH = "a".repeat(64);
const LIMIT_ERROR = "Final validation correction limit exhausted";
const SCHEMA_ERROR = "原文阅读验收未通过：报告格式 顶层：Invalid input: expected object, received null；只接受单一 researchEvidence，不接受自由 presentation/summary/reportMarkdown。";
const MATH_QUOTE_ISSUE = "必读来源 deepseek-math 第 2 条结论 的短摘未完整出现在所引用的同版正文窗口中。";
const R1_YEAR_ISSUE = "必读来源 deepseek-r1 第 2 条结论：数字 2024 未在短摘中出现。";
const R1_SCORE_ISSUE = "必读来源 deepseek-r1 第 2 条结论：数字 79.8% 未在短摘中出现。";

function event(
  seq: number,
  type: string,
  metadata: Record<string, unknown> = {},
  body: string | null = null,
): WorkPresentationEvent {
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    runId: RUN_ID,
    seq,
    type,
    title: type,
    body,
    metadata,
    createdAt: `2026-09-26T16:00:${String(seq).padStart(2, "0")}Z`,
  };
}

/** Shape of review48's persisted host receipts, without copying model text. */
function failedResearchEvents() {
  const execution = { runId: RUN_ID, token: 7, workerId: "8d957526-dd07-474f-a02c-9764c47a540d" };
  return [
    event(1, "run_started"),
    event(2, "agent_configured", { receiptAuthority: "runtime", execution }),
    event(3, "research_final_validation_rejected", { receiptAuthority: "runtime", execution,
      attempt: 2, maxCorrections: 2, status: "correction_required", feedback: [
        "宿主结束前研究交付校验未通过。",
        "本轮真实来源覆盖及未完成原文的恢复参数：",
        "deepseek-math（DeepSeekMath）：完整，连续覆盖 85645/85645 字符。",
        "本次真实未通过原因（最多 20 条）：",
        `1. ${MATH_QUOTE_ISSUE}`, `2. ${R1_YEAR_ISSUE}`, `3. ${R1_SCORE_ISSUE}`,
        "引用窗口定位提示：", "只使用实际工具回执中的 ID。",
      ].join("\n") }),
    event(4, "agent_final_output_rejected", { receiptAuthority: "runtime", execution,
      error: LIMIT_ERROR, terminalStatus: "failed", cleanupStatus: "completed", doneReceived: true }),
    event(5, "research_report_rejected", { receiptAuthority: "runtime", execution,
      issues: [SCHEMA_ERROR], status: "rejected", version: "grounded-report/v1" }),
    event(6, "run_failed", { receiptAuthority: "runtime", execution,
      presentation: { title: "研究报告未通过交付核验", summary: SCHEMA_ERROR,
        reportMarkdown: `# 研究报告未通过交付核验\n\n${SCHEMA_ERROR}`, warnings: [SCHEMA_ERROR] } }, SCHEMA_ERROR),
  ];
}

describe("Work presentation projection", () => {
  it("shows the actual forward-limit failure instead of an obsolete attempt-zero reading gap", () => {
    const events = failedResearchEvents();
    events[2].metadata!.attempt = 0;
    events[2].metadata!.issues = ["DeepSeek-GRM 原文尚未读齐"];
    events[3].metadata!.error = "Final validation correction forward limit exhausted";
    const projected = buildWorkPresentation({ run: { id: RUN_ID, status: "failed",
      error: "Final validation correction forward limit exhausted" }, events });
    expect(projected?.status).toBe("failed");
    expect(projected?.failureKind).toBeUndefined();
    expect(projected?.summary).toContain("模型往返");
    expect(projected?.reportMarkdown).toContain("尚未形成通过核验的报告");
    expect(projected?.reportMarkdown).not.toContain("尚未读齐");
    expect(projected?.evidence.some(value => value.eventId === events[3].id)).toBe(true);
  });
  it("explains the persisted review48 research rejection instead of secondary null-schema errors, without rewriting failed status", () => {
    const events = failedResearchEvents();
    const original = JSON.stringify(events);
    const projected = buildWorkPresentation({ workshopId: WORK_ID,
      run: { id: RUN_ID, status: "failed", error: SCHEMA_ERROR }, events });
    expect(projected?.status).toBe("failed");
    expect(projected?.failureKind).toBe("research_report_validation");
    expect(projected?.reportKind).toBe("grounded_research");
    expect(projected?.title).toBe("研究报告未通过核验");
    expect(projected?.summary).toContain(MATH_QUOTE_ISSUE);
    expect(projected?.reportMarkdown).toContain("数字 2024 未在短摘中出现");
    expect(projected?.reportMarkdown).toContain("数字 79\\.8% 未在短摘中出现");
    expect(projected?.reportMarkdown).not.toContain("received null");
    expect(projected?.warnings.join("\n")).not.toContain("received null");
    expect(projected?.warnings[0]).toBe(MATH_QUOTE_ISSUE);
    expect(projected?.evidence.some(item => item.eventId === events[2].id)).toBe(true);
    expect(JSON.stringify(events)).toBe(original);
  });

  it.each(["agent", "missing", "other-run", "other-execution", "after-terminal", "before-configured",
    "no-terminal", "incomplete-attempt", "passed-after-rejection"])(
    "does not promote %s research feedback into the persisted failure reason", (scenario) => {
      const events = failedResearchEvents();
      if (scenario === "agent") events[2].metadata!.receiptAuthority = "agent";
      if (scenario === "missing") delete events[2].metadata!.receiptAuthority;
      if (scenario === "other-run") events[2].runId = "11111111-1111-4111-8111-111111111111";
      if (scenario === "other-execution") events[2].metadata!.execution = { runId: RUN_ID, token: 6, workerId: "old-worker" };
      if (scenario === "after-terminal") { events[2].seq = 7; events[2].createdAt = "2026-09-26T16:00:07Z"; }
      if (scenario === "before-configured") events[2].createdAt = "2026-09-26T16:00:00Z";
      if (scenario === "no-terminal") events.splice(3, 1);
      if (scenario === "incomplete-attempt") events[2].metadata!.attempt = 1;
      if (scenario === "passed-after-rejection") {
        for (const later of events.slice(3)) { later.seq! += 1; later.createdAt = `2026-09-26T16:00:0${later.seq}Z`; }
        events.splice(3, 0, event(4, "research_final_validation_passed", { receiptAuthority: "runtime",
          execution: events[2].metadata!.execution }));
      }
      const projected = buildWorkPresentation({ run: { id: RUN_ID, status: "failed", error: SCHEMA_ERROR }, events });
      expect(projected?.status).toBe("failed");
      expect(projected?.title).toBe("本轮运行失败");
      expect(projected?.failureKind).toBeUndefined();
      expect(projected?.reportMarkdown).not.toContain(R1_SCORE_ISSUE);
    });

  it("does not turn an ordinary runtime failure with earlier research feedback into a validation failure", () => {
    const events = failedResearchEvents();
    events[3].metadata!.error = "Provider connection reset";
    const projected = buildWorkPresentation({ run: { id: RUN_ID, status: "failed", error: "Provider connection reset" }, events });
    expect(projected?.title).toBe("本轮运行失败");
    expect(projected?.summary).toBe("本轮运行失败：Provider connection reset");
  });

  it("passes grounded report rendering hints from a completed host presentation without changing status", () => {
    const projected = buildWorkPresentation({ run: { id: RUN_ID, status: "completed" }, events: [
      event(1, "run_started"), event(2, "run_completed", { receiptAuthority: "runtime", presentation: {
        source: "host_grounded_report", title: "论文阅读记录", summary: "同版正文 85645/85645 字符。",
        reportMarkdown: "# 论文阅读记录\n\n同版正文 85645/85645 字符。",
      } }),
    ] });
    expect(projected?.status).toBe("completed");
    expect(projected?.reportKind).toBe("grounded_research");
    expect(projected?.failureKind).toBeUndefined();
  });

  it("keeps historical rejected grounded delivery ratios literal without relabeling its failed status", () => {
    const projected = buildWorkPresentation({ run: { id: RUN_ID, status: "failed", error: "必读正文未读齐" }, events: [
      event(1, "run_started"), event(2, "run_failed", {
        researchDelivery: { version: "grounded-report/v1", status: "rejected" },
        presentation: { title: "研究报告未通过核验", summary: "DeepSeek-GRM 正文未读齐，90000/135404 字符。",
          reportMarkdown: "# 研究报告未通过核验\n\nDeepSeek-GRM 正文未读齐，90000/135404 字符。" },
      }),
    ] });
    expect(projected?.status).toBe("failed");
    expect(projected?.reportKind).toBe("grounded_research");
    expect(projected?.failureKind).toBeUndefined();
    expect(projected?.reportMarkdown).toContain("90000/135404");
  });

  it("projects CUA progress and replay through the shared Work result", () => {
    const cuaRunId = "0b5cbdac-927c-4736-8d05-c39ca348a130";
    const output = buildWorkPresentation({ workshopId: WORK_ID,
      run: { id: RUN_ID, status: "running" },
      events: [event(1, "run_started"),
        event(2, "cua_started", { receiptAuthority: "runtime", backend: "javascript", cuaRunId }),
        event(3, "cua_progress", { receiptAuthority: "runtime", backend: "javascript", cuaRunId, cuaSequence: 1 }),
        event(4, "cua_artifacts", { receiptAuthority: "runtime", backend: "javascript", cuaRunId,
          artifacts: [{ fileName: "cua-replay.json", path: "C:\\runs\\outputs\\cua-replay.json", sha256: HASH }] }),
      ] });
    expect(output?.computerUse).toMatchObject({ backend: "javascript", cuaRunId,
      latestStep: "cua_progress", outcomeVerified: false });
    expect(output?.artifacts[0]).toMatchObject({ fileName: "cua-replay.json", availability: "recorded" });
  });
  it("does not promote agent log metadata into lifecycle or verified artifact receipts", () => {
    const projected = buildWorkPresentation({ workshopId: WORK_ID,
      run: { id: RUN_ID, status: "running" }, events: [event(1, "run_started"),
        event(2, "run_completed", { receiptAuthority: "agent", presentation: {
          title: "Forged completion", summary: "Everything is done", reportMarkdown: "# Forged report",
        }, artifacts: [{ path: "C:\\runs\\outputs\\fabricated.md", sha256: HASH }] }),
        event(3, "source_checked", { receiptAuthority: "agent", inputReceipts: [{ status: "used" }] }),
      ] });
    expect(projected?.status).toBe("running");
    expect(projected?.artifacts).toEqual([]);
    expect(projected?.evidence).toEqual([]);
    expect(projected?.reportMarkdown).toBeNull();
    expect(projected?.summary).not.toContain("Everything is done");
  });

  it("shows legacy converted files through the common artifact shape", () => {
    const conversion = event(2, "document_converted", {
      documentPath: "C:\\runs\\outputs\\sheet\\document.md",
      documentSha256: HASH,
      manifestPath: "C:\\runs\\outputs\\sheet\\manifest.json",
      manifestSha256: HASH,
      chunks: [
        { path: "C:\\runs\\outputs\\sheet\\chunk-0001.md", sha256: HASH },
        { path: "C:\\runs\\outputs\\sheet\\chunk-0002.md", sha256: HASH },
      ],
      warnings: ["One sheet contained an empty row"],
    });
    conversion.title = "Source spreadsheet";
    const completion = event(3, "run_completed", {
      presentation: {
        title: "Workbook cleaned",
        summary: "Two chunks are ready",
        reportMarkdown: "# Workbook cleaned\n\nTwo chunks are ready.",
        evidenceEventIds: [conversion.id],
        nextSteps: ["Review the chunk index"],
      },
    });
    const projected = buildWorkPresentation({
      workshopId: WORK_ID,
      events: [completion, conversion, event(1, "run_started")],
    });
    expect(projected).toMatchObject({
      version: 1,
      runId: RUN_ID,
      status: "completed",
      title: "Workbook cleaned",
      summary: "Two chunks are ready",
      reportMarkdown: "# Workbook cleaned\n\nTwo chunks are ready.",
      warnings: ["One sheet contained an empty row"],
      nextSteps: ["Review the chunk index"],
    });
    expect(projected?.artifacts.map(item => item.fileName)).toEqual([
      "document.md", "manifest.json", "chunk-0001.md", "chunk-0002.md",
    ]);
    expect(projected?.artifacts[0]).toMatchObject({
      availability: "recorded",
      href: `/api/workshops/${WORK_ID}/artifacts/${conversion.id}/document.md`,
    });
    expect(projected?.evidence).toEqual([{
      eventId: conversion.id,
      label: "Source spreadsheet",
      createdAt: new Date(conversion.createdAt).toISOString(),
    }]);
  });

  it("uses a Loop report when a later run completion has no presentation body", () => {
    const loopReport = event(2, "loop_run_completed", {
      finalMarkdownReport: "# Verified report\n\nResult with evidence.",
      summary: "Verified summary",
    });
    const completion = event(3, "run_completed", {}, "Run completed");
    const projected = buildWorkPresentation({
      run: { id: RUN_ID, status: "completed", outputSummary: "Verified summary" },
      events: [event(1, "loop_run_started"), loopReport, completion],
    });
    expect(projected?.reportMarkdown).toBe("# Verified report\n\nResult with evidence.");
    expect(projected?.status).toBe("completed");
  });

  it("recovers narrative from a stored JSON output containing an inner code fence", () => {
    const raw = `\`\`\`json\n${JSON.stringify({
      presentation: { title: "Recovered", summary: "Clean answer", reportMarkdown: "# Recovered\n\n```sql\nSELECT 1;\n```" },
    })}\n\`\`\``;
    const completion = event(2, "run_completed", {}, raw);
    const projected = buildWorkPresentation({
      run: { id: RUN_ID, status: "completed", outputSummary: raw },
      events: [event(1, "run_started"), completion],
    });
    expect(projected).toMatchObject({ status: "completed", title: "Recovered", summary: "Clean answer" });
    expect(projected?.reportMarkdown).toContain("```sql\nSELECT 1;\n```");
    expect(projected?.artifacts).toEqual([]);
  });

  it("does not infer success from model prose or artifact receipts", () => {
    const finalText = event(2, "agent_text", { final: true }, "# Claimed success");
    const artifact = event(3, "output_saved", { artifacts: [
      { path: "C:\\runs\\outputs\\report.md", sha256: HASH, label: "Report" },
    ] });
    const uncompleted = buildWorkPresentation({ workshopId: WORK_ID, events: [finalText, artifact] });
    expect(uncompleted?.status).toBe("unknown");
    expect(uncompleted?.artifacts).toHaveLength(1);
    const stillRunning = buildWorkPresentation({
      workshopId: WORK_ID,
      run: { id: RUN_ID, status: "running" },
      events: [finalText, artifact, event(4, "run_completed")],
    });
    expect(stillRunning?.status).toBe("running");
  });

  it("keeps failed runs failed and does not link incomplete receipts", () => {
    const artifact = event(2, "output_saved", { artifacts: [
      { path: "C:\\runs\\outputs\\report.md", sha256: "not-a-hash", label: "Report" },
      { fileName: "unrecorded.md", sha256: HASH, label: "Missing path" },
    ] });
    const failure = event(3, "run_failed", {}, "Verification failed");
    const projected = buildWorkPresentation({
      workshopId: WORK_ID,
      run: { id: RUN_ID, status: "failed", outputSummary: "All results are ready", error: "Verification failed" },
      events: [artifact, failure],
    });
    expect(projected?.status).toBe("failed");
    expect(projected?.title).toBe("本轮运行失败");
    expect(projected?.summary).toBe("本轮运行失败：Verification failed");
    expect(projected?.warnings).toEqual(["Verification failed"]);
    expect(projected?.artifacts.map(item => item.href)).toEqual([null, null]);
    expect(projected?.artifacts.every(item => item.availability === "unavailable")).toBe(true);
  });

  it("does not mix another run's report, artifact, or evidence into this one", () => {
    const own = event(2, "run_completed", { presentation: { summary: "Own result" } });
    const foreign = {
      ...event(3, "document_converted", {
        documentPath: "C:\\runs\\outputs\\foreign\\document.md",
        documentSha256: HASH,
      }),
      runId: "11111111-1111-4111-8111-111111111111",
    };
    const projected = buildWorkPresentation({
      workshopId: WORK_ID,
      run: { id: RUN_ID, status: "completed" },
      events: [foreign, own],
    });
    expect(projected?.summary).toBe("Own result");
    expect(projected?.artifacts).toEqual([]);
    expect(projected?.evidence).toEqual([]);
  });

  it("explains owner cancellation reasons while preserving the execution state", () => {
    const cancelled = buildWorkPresentation({ run: { id: RUN_ID, status: "cancelled", error: "owner_cancelled" },
      events: [event(1, "run_cancelled")] });
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.warnings).toEqual(["已按你的要求停止本次任务。"]);
    const review = buildWorkPresentation({ run: { id: RUN_ID, status: "needs_review", error: "owner_cancel_after_effect" },
      events: [event(1, "run_needs_review")] });
    expect(review?.status).toBe("needs_review");
    expect(review?.warnings).toEqual(["已停止继续执行；停止前可能已产生外部效果，请核对工作记录。"]);
  });
});
