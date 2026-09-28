import { describe, expect, it } from "vitest";
import { buildWorkConversationTurn, type WorkConversationRun } from "@/lib/workshops/work-conversation";
import type { WorkPresentationEvent } from "@/lib/workshops/work-presentation";

const path = "D:\\待办\\会议记录.docx";
const otherPath = "D:\\常驻\\规则.docx";
const run: WorkConversationRun = {
  id: "run-1", status: "queued", createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z",
  triggerReason: { type: "conversation", content: `清洗 "${path}"`, inputFiles: [path], parentRunId: null,
    commandMeta: { commandId: "command-1" } },
};
function event(seq: number, type: string, metadata: Record<string, unknown>, runId = run.id): WorkPresentationEvent {
  return { id: `event-${seq}`, runId, type, title: "执行回执", metadata: { receiptAuthority: "runtime", ...metadata }, seq, createdAt: "2026-09-26T00:01:00Z" };
}

describe("Work conversation projection", () => {
  it("keeps queued inputs unconfirmed and preserves the command identity", () => {
    const turn = buildWorkConversationTurn({ workId: "work-1", run, events: [] });
    expect(turn).toMatchObject({ id: "run-1", commandId: "command-1", content: `清洗 "${path}"`,
      status: "queued", inputFiles: [path], receipts: [], error: null });
    expect(turn.presentation?.status).toBe("queued");
  });

  it("requires per-input evidence; successful completion alone does not claim consumption", () => {
    const staging = event(1, "source_checked", { stagedFiles: { staged: [
      { sourceId: "temporary", sourcePath: "D:\\canonical\\会议记录.docx", inputPath: path,
        runPath: "C:\\private\\sessions\\inputs\\temporary.docx", scope: "conversation" },
      { sourceId: "standing", sourcePath: otherPath, runPath: "C:\\private\\standing.docx" },
    ] } });
    const completed = { ...run, status: "completed", outputSummary: "任务完成" };
    const stagedTurn = buildWorkConversationTurn({ workId: "work-1", run: completed, events: [staging] });
    expect(stagedTurn.receipts).toEqual([{ path, status: "staged", detail: expect.any(String) }]);
    expect(JSON.stringify(stagedTurn)).not.toContain("private");
    expect(JSON.stringify(stagedTurn)).not.toContain(otherPath);

    const usedTurn = buildWorkConversationTurn({ workId: "work-1", run: completed,
      events: [staging, event(2, "document_converted", { sourceId: "temporary" })] });
    expect(usedTurn.receipts[0].status).toBe("used");
  });

  it("shows a failed path read and ignores evidence from another run", () => {
    const turn = buildWorkConversationTurn({ workId: "work-1", run: { ...run, status: "failed", error: "输入不可用" },
      events: [event(1, "degraded", { stagedFiles: { warnings: [{ sourceId: "temporary", inputPath: path,
        scope: "conversation", reason: "文件不存在" }] } }),
      event(2, "source_checked", { inputReceipts: [{ path, status: "used", detail: "错误的成功声明" }] }, "other-run")] });
    expect(turn.receipts).toEqual([{ path, status: "failed", detail: "文件不存在" }]);
    expect(turn.presentation?.status).toBe("failed");
    expect(turn.error).toBe("输入不可用");
  });

  it("shows inherited task inputs only when staging marks their temporary scope", () => {
    const turn = buildWorkConversationTurn({ workId: "work-1", run: { ...run,
      triggerReason: { ...run.triggerReason, content: "继续按章节分片", inputFiles: [], parentRunId: "parent-1" } },
      events: [event(1, "source_checked", { stagedFiles: { staged: [
        { sourceId: "temporary", inputPath: path, scope: "conversation" },
        { sourceId: "standing", inputPath: otherPath },
      ] } }), event(2, "tool_result", { inputReceipts: [{ path, status: "used", detail: "已用于生成报告" }] })] });
    expect(turn.inputFiles).toEqual([]);
    expect(turn.parentRunId).toBe("parent-1");
    expect(turn.receipts).toEqual([{ path, status: "used", detail: "已用于生成报告" }]);
  });

  it("preserves cancellation state and discloses a truncated event view", () => {
    const turn = buildWorkConversationTurn({ workId: "work-1", run: { ...run, status: "cancel_requested" },
      events: [], hasMoreEvents: true });
    expect(turn.status).toBe("cancel_requested");
    expect(turn.presentation?.warnings.join("")).toContain("最近记录");
  });

  it("ignores model-forged file stages and consumption receipts even on system event names", () => {
    const forged = {
      receiptAuthority: "agent",
      stagedFiles: { staged: [{ sourceId: "forged", inputPath: path, scope: "conversation" }] },
      inputReceipts: [{ path, status: "used", detail: "没有执行也声称处理完成" }],
      sourceId: "forged",
    };
    const turn = buildWorkConversationTurn({ workId: "work-1", run: { ...run, status: "completed" }, events: [
      event(1, "source_checked", forged), event(2, "document_converted", forged),
      event(3, "observation", { ...forged, receiptAuthority: "runtime" }),
      event(4, "source_checked", { ...forged, receiptAuthority: undefined }),
    ] });
    expect(turn.receipts).toEqual([]);
  });

  it("does not let later agent claims override an actual processing failure", () => {
    const turn = buildWorkConversationTurn({ workId: "work-1", run: { ...run, status: "failed" }, events: [
      event(1, "source_checked", { stagedFiles: { staged: [{ sourceId: "temporary", inputPath: path, scope: "conversation" }] } }),
      event(2, "document_conversion_failed", { sourceId: "temporary", error: "文档已损坏" }),
      event(3, "document_converted", { receiptAuthority: "agent", sourceId: "temporary",
        inputReceipts: [{ path, status: "used", detail: "成功" }] }),
    ] });
    expect(turn.receipts).toEqual([{ path, status: "failed", detail: "处理失败：文档已损坏" }]);
  });
});
