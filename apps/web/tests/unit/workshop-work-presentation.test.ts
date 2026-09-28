import { describe, expect, it } from "vitest";
import {
  buildWorkPresentation,
  type WorkPresentationEvent,
} from "@/lib/workshops/work-presentation";

const WORK_ID = "b0252cc6-8e80-45fa-b125-ead5618bc4ad";
const RUN_ID = "a42df8b8-0c8d-84be-ad84-ef2b70153af0";
const HASH = "a".repeat(64);

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

describe("Work presentation projection", () => {
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
