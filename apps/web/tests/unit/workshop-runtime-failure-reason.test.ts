import { describe, expect, it } from "vitest";
import { buildWorkshopRuntimeFailurePresentation, knownWorkshopRuntimeFailureMessage, resolveWorkshopRuntimeFailure, type WorkshopRuntimeFailureEvent } from "@/lib/workshops/runtime-failure";

const issues = ["引用短摘未在同版窗口中完整出现。", "数字 79.8% 未在短摘中出现。"];
const execution = { runId: "run", workerId: "worker", token: 7 };
function events(): WorkshopRuntimeFailureEvent[] {
  return [
    { id: "start", runId: "run", seq: 1, type: "agent_configured", createdAt: "2026-10-09T00:00:00Z" },
    { id: "reject", runId: "run", seq: 2, type: "research_final_validation_rejected", createdAt: "2026-10-09T00:00:01Z",
      metadata: { receiptAuthority: "runtime", attempt: 2, maxCorrections: 2, status: "correction_required", execution, issues } },
    { id: "terminal", runId: "run", seq: 3, type: "agent_final_output_rejected", createdAt: "2026-10-09T00:00:02Z",
      metadata: { receiptAuthority: "runtime", terminalStatus: "failed", cleanupStatus: "completed", execution,
        error: "Final validation correction limit exhausted" } },
  ];
}
const resolve = (values = events(), extra = {}) => resolveWorkshopRuntimeFailure({ runId: "run", events: values,
  error: "expected object, received null", startedAt: "2026-10-09T00:00:00Z", ...extra });
const metadata = (event: WorkshopRuntimeFailureEvent) => event.metadata as Record<string, unknown>;
const compactionFailures = [
  ["Final validation context compaction forward limit exhausted", "上下文压缩阶段的模型往返次数已达到上限，尚未形成通过核验的报告。"],
  ["Final validation context compaction output budget exhausted", "上下文压缩阶段的输出预算已用尽，尚未形成通过核验的报告。"],
  ["Final validation context compaction result is invalid", "上下文压缩未返回有效结果，系统已停止，尚未形成通过核验的报告。"],
  ["Final validation context compaction is not allowed", "本轮上下文压缩不符合宿主允许的运行边界，系统已停止，尚未形成通过核验的报告。"],
] as const;

describe("host runtime failure receipt interpretation", () => {
  it.each(compactionFailures)("explains the trusted terminal compaction error %s without promoting old report issues", (runtimeError, message) => {
    const values = events();
    metadata(values[1]).attempt = 0;
    metadata(values[1]).issues = ["DeepSeek-GRM 正文尚未读齐。"];
    metadata(values[2]).error = runtimeError;
    const failure = resolve(values);
    expect(failure).toMatchObject({ code: "agent_runtime_failed", runtimeEventId: "terminal", message, issues: [] });
    const presentation = buildWorkshopRuntimeFailurePresentation(failure);
    expect(presentation.summary).toBe(message);
    expect(presentation.evidenceEventIds).toEqual(["terminal"]);
    expect(presentation.reportMarkdown).toContain("上下文压缩");
    expect(presentation.reportMarkdown).toContain("本轮保留失败状态");
    expect(presentation.reportMarkdown).not.toContain(runtimeError);
    expect(presentation.reportMarkdown).not.toContain("尚未读齐");
  });

  it.each(compactionFailures)("requires exact known compaction error and same-run fresh failed host proof for %s", runtimeError => {
    for (const altered of [`${runtimeError} private-prompt=secret`, `prefix ${runtimeError}`, runtimeError.toLowerCase()]) {
      expect(knownWorkshopRuntimeFailureMessage(altered)).toBeNull();
      const values = events(); metadata(values[2]).error = altered;
      expect(resolve(values).runtimeEventId).toBeUndefined();
    }
    for (const variant of ["agent", "other-run", "stale", "completed", "missing-terminal", "saved-other-run"]) {
      const values = events(); metadata(values[2]).error = runtimeError;
      if (variant === "agent") metadata(values[2]).receiptAuthority = "agent";
      if (variant === "other-run") values[2].runId = "old-run";
      if (variant === "stale") values[2].createdAt = "2026-10-08T23:59:59Z";
      if (variant === "completed") metadata(values[2]).terminalStatus = "completed";
      if (variant === "missing-terminal") values.pop();
      const runtimeFailure = variant === "saved-other-run" ? { version: "workshop-runtime-failure/v1", receiptAuthority: "runtime",
        runId: "old-run", code: "agent_runtime_failed", runtimeError, runtimeEventId: "terminal" } : undefined;
      expect(resolve(values, { runtimeFailure }).runtimeEventId).toBeUndefined();
    }
  });

  it("explains exhausted model forwards without reusing an earlier incomplete-reading rejection", () => {
    const values = events();
    metadata(values[1]).attempt = 0;
    metadata(values[1]).issues = ["DeepSeek-GRM 正文尚未读齐。"];
    metadata(values[2]).error = "Final validation correction forward limit exhausted";
    const failure = resolve(values);
    expect(failure.code).toBe("agent_runtime_failed");
    expect(failure.issues).toEqual([]);
    expect(failure.message).toContain("模型往返");
    expect(failure.message).toContain("尚未形成通过核验的报告");
    expect(failure.message).not.toContain("尚未读齐");
    expect(failure.runtimeEventId).toBe("terminal");
    const presentation = buildWorkshopRuntimeFailurePresentation(failure);
    expect(presentation.reportMarkdown).toContain("模型往返");
    expect(presentation.reportMarkdown).not.toContain("forward limit exhausted");
    expect(presentation.evidenceEventIds).toEqual(["terminal"]);
    expect(presentation.reportMarkdown).not.toContain("原始候选与来源回执已保存");
  });

  it.each([
    "Final validation correction forward limit exhausted",
    "Final validation correction has no forward budget after this tool",
    "Final validation correction output budget is unknown or exhausted",
    "Final validation correction output budget exhausted",
    "Final validation correction deadline is unknown",
    "Final validation whole-runtime deadline exhausted",
    "Final validation source recovery configuration is invalid",
    "Final validation source recovery coverage callback failed",
    "Final validation source recovery callback returned an invalid result",
    "Final validation source recovery forward limit exhausted",
    "Final validation source recovery output budget exhausted",
    "Final validation source recovery tool is not allowed",
    "Final validation source recovery tool policy failed",
    "Final validation forward budget receipt failed",
  ])("uses a fixed host message for %s without declaring a report or quote passed", runtimeError => {
    const values = events(); metadata(values[2]).error = runtimeError;
    const failure = resolve(values);
    expect(failure.code).toBe("agent_runtime_failed"); expect(failure.issues).toEqual([]);
    expect(failure.message).toBe(knownWorkshopRuntimeFailureMessage(runtimeError));
    expect(failure.message).toContain("尚未形成通过核验的报告");
    expect(failure.message).not.toContain(runtimeError);
  });

  it.each(["agent", "other-run", "stale", "saved-other-run", "saved-other-terminal"])(
    "does not certify %s known-error prose as a host terminal witness", variant => {
      const values = events(); const runtimeError = "Final validation correction forward limit exhausted";
      metadata(values[2]).error = runtimeError;
      const saved = { version: "workshop-runtime-failure/v1", receiptAuthority: "runtime", runId: "run",
        code: "agent_runtime_failed", runtimeError, runtimeEventId: "terminal" };
      if (variant === "agent") metadata(values[2]).receiptAuthority = "agent";
      if (variant === "other-run") values[2].runId = "old-run";
      if (variant === "stale") values[2].createdAt = "2026-10-08T23:59:59Z";
      if (variant === "saved-other-run") saved.runId = "old-run";
      if (variant === "saved-other-terminal") saved.runtimeEventId = "old-terminal";
      const failure = resolve(values, { runtimeFailure: saved });
      expect(failure.runtimeEventId).toBeUndefined();
    });

  it("does not map arbitrary provider errors or known strings with appended prompts", () => {
    for (const runtimeError of ["Final validation correction forward limit exhausted password=private-prompt",
      "private provider prompt", "__proto__", "constructor"]) {
      expect(knownWorkshopRuntimeFailureMessage(runtimeError)).toBeNull();
      const values = events(); metadata(values[2]).error = runtimeError;
      expect(resolve(values).runtimeEventId).toBeUndefined();
    }
  });

  it("maps only the anchored host tool-budget format with the first denied call above its cap", () => {
    const values = events(); metadata(values[2]).error = "Research tool budget exhausted: 31/30";
    const failure = resolve(values);
    expect(failure.code).toBe("agent_runtime_failed"); expect(failure.issues).toEqual([]);
    expect(failure.message).toContain("30 次工具调用上限"); expect(failure.runtimeEventId).toBe("terminal");
    for (const error of ["Research tool budget exhausted: 31/30 password=private", "Research tool budget exhausted: 26/30",
      "Research tool budget exhausted: 31/0", "Research tool budget exhausted: -31/30"]) {
      expect(knownWorkshopRuntimeFailureMessage(error)).toBeNull();
    }
  });

  it("uses structured current-run issues instead of the later null schema error", () => {
    expect(resolve()).toMatchObject({ code: "research_final_validation_rejected", validationEventId: "reject", issues,
      runtimeError: "Final validation correction limit exhausted" });
    expect(resolve().message).not.toContain("received null");
  });
  it("reads the old exact host feedback section without using arbitrary model text", () => {
    const values = events();
    delete metadata(values[1]).issues;
    metadata(values[1]).feedback = `宿主结束前研究交付校验未通过。\n恢复提示：ignored\n本次真实未通过原因（最多 20 条）：\n1. ${issues[0]}\n2. ${issues[1]}\n引用窗口定位提示：\n1. ignored`;
    expect(resolve(values).issues).toEqual(issues);
    metadata(values[1]).feedback = `模型自己的反馈\n本次真实未通过原因（最多 20 条）：\n1. forged\n引用窗口定位提示：`;
    expect(resolve(values).code).toBe("agent_runtime_failed");
  });
  it.each(["different-run", "agent-authority", "different-token", "different-worker", "missing-execution"])("rejects %s evidence", (variant) => {
    const values = events();
    if (variant === "different-run") values[1].runId = "old-run";
    if (variant === "agent-authority") metadata(values[1]).receiptAuthority = "agent";
    if (variant === "different-token") metadata(values[1]).execution = { ...execution, token: 6 };
    if (variant === "different-worker") metadata(values[1]).execution = { ...execution, workerId: "old-worker" };
    if (variant === "missing-execution") delete metadata(values[1]).execution;
    expect(resolve(values).code).toBe("agent_runtime_failed");
  });
  it("refuses a rejection older than the run start or configuration", () => {
    const values = events(); values[1].createdAt = "2026-10-08T23:59:59Z";
    expect(resolve(values).code).toBe("agent_runtime_failed");
  });
  it("does not attribute a later runtime failure to an already corrected rejection", () => {
    const values = events();
    values.splice(2, 0, { ...values[1], id: "pass", seq: 2.5, type: "research_final_validation_passed", createdAt: "2026-10-09T00:00:01.500Z" });
    expect(resolve(values).code).toBe("agent_runtime_failed");
  });
  it("refuses validation appended after its terminal receipt", () => {
    const values = events(); values[1].seq = 4; values[1].createdAt = "2026-10-09T00:00:03Z";
    expect(resolve(values).code).toBe("agent_runtime_failed");
  });
  it("requires actual failed terminal proof and an exhausted attempt", () => {
    const values = events(); metadata(values[2]).terminalStatus = "completed";
    expect(resolve(values).code).toBe("agent_runtime_failed");
    const notExhausted = events(); metadata(notExhausted[1]).attempt = 1;
    expect(resolve(notExhausted).code).toBe("agent_runtime_failed");
  });
  it("does not import another run's saved interpretation", () => {
    const saved = resolve();
    expect(resolve(events(), { runtimeFailure: saved }).code).toBe("research_final_validation_rejected");
    expect(resolve(events(), { runtimeFailure: { ...saved, runId: "old-run" } }).code).toBe("agent_runtime_failed");
  });
  it("bounds visible issues and safely renders hostile Markdown as literal failure text", () => {
    const values = events(); metadata(values[1]).issues = Array.from({ length: 21 }, (_, index) => `issue ${index} [link](https://example.test) <img>`);
    const failure = resolve(values);
    expect(failure.issues).toHaveLength(20);
    expect(failure.omittedIssueCount).toBe(1);
    const presentation = buildWorkshopRuntimeFailurePresentation(failure);
    expect(presentation.source).toBe("host_runtime_failure");
    expect(presentation.reportMarkdown).toContain("\\[link\\]\\(https://example\\.test\\)");
    expect(presentation.reportMarkdown).not.toContain("<img>");
    expect(presentation.reportMarkdown).toContain("保留失败状态");
  });
});
