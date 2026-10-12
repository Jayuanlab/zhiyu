import { describe, expect, it } from "vitest";
import { presentAnswerEvidence, type AuditSummary } from "@/components/message/answer-evidence-presentation";

const turnId = "11111111-1111-4111-8111-111111111111";
const base: AuditSummary = {
  turnId, chatId: "owned-chat", assistantMessageId: "owned-answer", status: "completed", mode: "enforce_supported", finalText: "已读取指定对话标题。",
  runtimeTerminal: { schemaVersion: "agent-runtime-terminal.v1", status: "completed", cleanupStatus: "completed" },
  evidence: { schemaVersion: "platform-answer-summary.v1", kind: "platform", contractKind: "chat_identity", mode: "enforce_supported", auditPersisted: true,
    outcome: "supported_fields", questionComplete: true, evidenceCoverage: { supported: 1, notRecorded: 0, unknown: 0, denied: 0, total: 1 },
    resolutions: [{ requirementId: "chat.title", state: "supported", reason: "字段已读", presentationIncluded: true }],
    evidenceRefs: [{ evidenceId: "read-1", status: "read", source: "chat", observedAt: "2026-10-04T01:00:00Z", scope: "owner_exact_record" }] },
};
function present(summary: AuditSummary = base, extra: Partial<Parameters<typeof presentAnswerEvidence>[0]> = {}) {
  return presentAnswerEvidence({ turnId, chatId: "owned-chat", assistantMessageId: "owned-answer", displayedText: base.finalText!, valid: true, summary, ...extra });
}

describe("answer evidence presentation", () => {
  it("separates saved-body observations from answer correctness and rejects mismatched display bodies", () => {
    const mirror = { schemaVersion: "answer-body-mirror.v1" as const, state: "stored_matching" as const, reason: "exact_body_and_turn_reference" as const, observedAt: "2026-10-04T00:00:00Z" };
    expect(present({ ...base, bodyMirror: mirror })).toMatchObject({ bodyMirrorTitle: "聊天正文已保存，与本轮答文一致", checked: 1 });
    expect(present({ ...base, bodyMirror: mirror }, { displayedText: base.finalText + "extra" })).toMatchObject({ bodyMirrorTitle: "聊天正文保存尚未确认", checked: 0 });
    expect(present({ ...base, bodyMirror: { ...mirror, state: "unavailable", reason: "storage_read_unavailable" } })).toMatchObject({ bodyMirrorTitle: "聊天正文保存状态暂不可核实", checked: 1 });
    expect(present({ ...base, bodyMirror: { ...mirror, schemaVersion: "future" } as never })).toMatchObject({ bodyMirrorTitle: "聊天正文保存尚未确认" });
  });
  it("verifies only the owned complete answer within the recorded source and scope", () => {
    const result = present();
    expect(result).toMatchObject({ title: "已核对本轮问项（限读取范围）", checked: 1, total: 1, gaps: 0,
      rows: [{ label: "对话标题", value: "已核对读取到的字段" }], sources: [{ source: "对话记录", scope: "当前用户的指定记录", observedAt: "2026-10-04T01:00:00Z" }] });
    expect(JSON.stringify(result)).not.toContain("read-1");
  });
  it.each(["supported", "unknown", "denied"] as const)("keeps %s evidence state independent of an unknown reason code", state => {
    const result = present({ ...base, evidence: { ...base.evidence,
      outcome: state === "supported" ? "supported_fields" : "partial", questionComplete: state === "supported",
      evidenceCoverage: { supported: state === "supported" ? 1 : 0, notRecorded: 0,
        unknown: state === "unknown" ? 1 : 0, denied: state === "denied" ? 1 : 0, total: 1 },
      resolutions: [{ requirementId: "chat.title", state, reason: "future_reason_code", presentationIncluded: true }],
    } });
    expect(result.rows[0]?.reason).toBe("该项核验说明暂不可用。");
    expect(result.rows[0]?.value).toBe(state === "supported" ? "已核对读取到的字段"
      : state === "unknown" ? "未知，证据不足" : "权限边界拒绝读取");
    expect(result.checked).toBe(state === "supported" ? 1 : 0);
    expect(result.gaps).toBe(state === "supported" ? 0 : 1);
  });
  it("rejects mismatched references and compares the entire displayed answer", () => {
    for (const summary of [{ ...base, chatId: "other-chat" }, { ...base, assistantMessageId: "other-answer" }, { ...base, turnId: "other-turn" }]) {
      expect(present(summary)).toMatchObject({ title: "核验记录暂不可用", checked: 0, sources: [] });
    }
    for (const displayedText of [base.finalText! + "另一条无依据的结论。", base.finalText!.slice(0, 3)]) {
      expect(present(base, { displayedText })).toMatchObject({ title: "显示正文尚未与核验记录一致", checked: 0, sources: [] });
    }
    expect(present(base, { unavailable: true })).toMatchObject({ title: "核验记录暂不可用", checked: 0, sources: [] });
  });
  it("requires actual successful runtime cleanup, audit persistence and included claims", () => {
    for (const summary of [
      { ...base, runtimeTerminal: undefined }, { ...base, runtimeTerminal: { ...base.runtimeTerminal, cleanupStatus: "unknown" } },
      { ...base, evidence: { ...base.evidence, auditIncomplete: true } }, { ...base, evidence: { ...base.evidence, auditPersisted: false } },
      { ...base, evidence: { ...base.evidence, resolutions: [{ ...base.evidence!.resolutions![0]!, presentationIncluded: false }] } },
    ]) {
      expect(present(summary).title).not.toBe("已核对本轮问项（限读取范围）");
      expect(present(summary).checked).toBe(0);
    }
  });
  it("never labels shadow, unchecked or unknown schemas as verified even with a matching body", () => {
    const shadow = present({ ...base, mode: "shadow", evidence: { ...base.evidence, mode: "shadow" } });
    expect(shadow).toMatchObject({ title: "影子对照：正文尚未受核验约束", checked: 0, shadow: true });
    expect(shadow.rows[0]?.value).toBe("候选依据已读取，正文尚未核验");
    expect(present({ ...base, evidence: { ...base.evidence, outcome: "unchecked" } })).toMatchObject({ title: "本轮回答尚未核验", checked: 0 });
    expect(present({ ...base, evidence: { ...base.evidence, schemaVersion: "future.v2" } })).toMatchObject({ title: "本轮回答尚未核验", checked: 0, rows: [], sources: [] });
    expect(present({ ...base, mode: "off" })).toMatchObject({ title: "本轮回答尚未核验", checked: 0 });
  });
  it("keeps unknown and denied questions as explicit gaps", () => {
    const result = present({ ...base, evidence: { ...base.evidence, outcome: "partial", questionComplete: false,
      evidenceCoverage: { supported: 1, notRecorded: 0, unknown: 1, denied: 1, total: 3 }, resolutions: [
        ...base.evidence!.resolutions!, { requirementId: "current_worker_activity", state: "unknown", reason: "缺少当前观测", presentationIncluded: true },
        { requirementId: "business_effective_count", state: "denied", reason: "边界拒绝", presentationIncluded: true },
      ] } });
    expect(result).toMatchObject({ title: "部分问项存在证据缺口", checked: 1, total: 3, gaps: 2 });
    expect(result.rows.map(r => r.value)).toEqual(["已核对读取到的字段", "未知，证据不足", "权限边界拒绝读取"]);
  });
  it("shows safe reading progress without granting completed claims", () => {
    const result = present({ ...base, status: "running", progress: { schemaVersion: "platform-answer-progress.v1", phase: "reading", lastEventAt: "2026-10-04T01:00:00Z",
      totalRequirements: 2, resolvedRequirements: 1, requirements: [{ requirementId: "chat.title", label: "对话标题", state: "supported" }, { requirementId: "message.role", label: "消息角色", state: "pending" }] } });
    expect(result).toMatchObject({ title: "正在读取并核对本轮问项", checked: 0, sources: [], progress: { resolvedRequirements: 1 } });
    expect(result.rows.map(r => r.value)).toEqual(["已判断，等待回答与终态确认", "等待读取"]);
    expect(present({ ...base, status: "running", progress: { ...result.progress!, schemaVersion: "future.v2" } }).rows).toEqual([]);
  });
  it("shows delivered interpretations without upgrading them to verified facts or user permission", () => {
    const summary: AuditSummary = { ...base, evidence: { ...base.evidence, outcome: "partial", questionComplete: false,
      evidenceCoverage: { supported: 1, notRecorded: 0, unknown: 2, denied: 0, total: 3 }, resolutions: [
        ...base.evidence!.resolutions!,
        { requirementId: "message.interpretation", state: "unknown", reason: "message_interpretation_candidate_available", presentationIncluded: true },
        { requirementId: "original_user_decision", state: "unknown", reason: "message_decision_candidate_available", presentationIncluded: true },
      ] } };
    const result = present(summary);
    expect(result).toMatchObject({ checked: 1, total: 3, gaps: 2, title: "部分问项存在证据缺口" });
    expect(result.rows[1]).toMatchObject({ label: "消息含义解读", value: "已交付解读，语义尚未核实" });
    expect(result.rows[2]?.value).toBe("已交付判断，不代表用户授权");
    expect(result.rows[2]?.reason).toContain("不授予动作权限");
    expect(present(summary, { displayedText: "a different body" }).checked).toBe(0);
    const denied = present({ ...summary, evidence: { ...summary.evidence,
      resolutions: [{ requirementId: "message.interpretation", state: "denied", reason: "message_interpretation_candidate_available", presentationIncluded: true }],
      evidenceCoverage: { supported: 0, notRecorded: 0, unknown: 0, denied: 1, total: 1 } } });
    expect(denied.rows[0]?.value).toBe("权限边界拒绝读取");
  });
  it("preserves the Loop card and its separate observation and business-effect boundaries", () => {
    const summary: AuditSummary = { ...base, mode: "enforce_critical", evidence: { schemaVersion: "answer-evidence-summary.v1", outcome: "supported_fields", auditPersisted: true,
      resolutions: [{ requirementId: "loop_configuration", state: "supported", reason: "", presentationIncluded: true }, { requirementId: "runtime_observation", state: "supported", reason: "", presentationIncluded: true }] } };
    const result = present(summary);
    expect(result.title).toBe("已核验本次读取到的状态");
    expect(result.rows.map(r => r.value)).toEqual(["已读取配置状态", "已核验读取时的有限观测", "本轮未核验任务结果或回答瞬间的进程状态"]);
    const tampered = present(summary, { displayedText: "改写后的正文" });
    expect(tampered.title).toBe("显示正文尚未与核验记录一致");
    expect(tampered.rows.map(r => r.value)).toEqual(["未核实", "未核实", "本轮未核验任务结果或回答瞬间的进程状态"]);
  });
  it.each(["aborted", "failed"] as const)("explains the target state remains unverified after %s, including before any evidence", status => {
    const noEvidence: AuditSummary = { turnId: base.turnId, chatId: base.chatId, assistantMessageId: base.assistantMessageId, status };
    const result = present(noEvidence);
    expect(result.title).toBe(status === "aborted" ? "本轮回答已中断" : "本轮回答未正常完成");
    expect(result.runtimeNotice).toBe("本轮未完成可靠核验交付；相关任务的执行状态和实际效果尚未核实。");
    expect(result.checked).toBe(0);
    expect(result.rows).toEqual([]);
    expect(result.sources).toEqual([]);
    const priorEvidence = present({ ...base, status });
    expect(priorEvidence.checked).toBe(0);
    expect(priorEvidence.rows.every(row => row.value === "尚未核实")).toBe(true);
    expect(priorEvidence.runtimeNotice).toBe(result.runtimeNotice);
    for (const input of [{ unavailable: true }, { assistantMessageId: "another-message" }]) {
      expect(present(noEvidence, input).runtimeNotice).toBeUndefined();
    }
    expect(present(base).runtimeNotice).toBeUndefined();
  });
});
