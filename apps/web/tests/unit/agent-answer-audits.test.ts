import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db/client", () => ({ db: {}, withDatabaseTransaction: vi.fn() }));
import { AgentAnswerAuditError, buildAgentAnswerAuditSummary, hashAgentAnswerPayload } from "@/lib/db/agent-answer-audits";
import { sanitizeClientAnswerEvidence } from "@/lib/db/owned-chat-messages";
import type { AgentAnswerAuditRow } from "@/lib/db/schema.pg";

const turnId = "11111111-1111-4111-8111-111111111111";
function event(eventType: string, payload: Record<string, unknown> = {}): AgentAnswerAuditRow {
  return { id: turnId, seq: 1, ownerId: turnId, turnId, chatId: turnId, assistantMessageId: turnId, workId: null, eventKey: eventType, eventType, requestKey: eventType === "turn_started" ? "request" : null, requestPayloadHash: null, schemaVersion: "answer-evidence.v1", ruleVersion: "test", runtimeHash: "server-only", payloadHash: "hash", payload, createdAt: new Date() };
}
const decision = { schemaVersion: "answer-decision.v1", ruleVersion: "test", runtimeHash: "private-runtime", outcome: "unknown", displayText: "当前执行活性未知。", rawDraftHash: "private-draft-hash", rawDraft: { text: "Private raw model draft" }, authorization: { ownerId: turnId }, resolutions: [{ requirementId: "activity", state: "unknown", reason: "No activity observation", evidenceIds: ["r1"], presentationIncluded: true, ownerId: turnId }], evidenceRefs: [{ evidenceId: "r1", observedAt: "2026-10-02T00:00:00Z", status: "unknown", policyHash: "secret" }] };
const platformDecision = { ...decision, schemaVersion: "platform-answer-decision.v1", mode: "enforce_supported", contractKind: "chat_identity",
  displayText: "对话标题已读取。", outcome: "supported_fields", questionComplete: true,
  evidenceCoverage: { supported: 1, notRecorded: 0, unknown: 0, denied: 0, total: 1 },
  resolutions: [{ requirementId: "chat.title", state: "supported", reason: "指定标题字段已读", evidenceIds: ["r1"], presentationIncluded: true }],
  evidenceRefs: [{ evidenceId: "r1", observedAt: "2026-10-04T00:00:00Z", status: "read", source: "chat", scope: "owner_exact_record", query: "secret query" }] };

describe("answer audit contract", () => {
  it("hashes semantic JSON deterministically and rejects unsupported or cyclic data", () => {
    expect(hashAgentAnswerPayload({ b: 2, a: { z: "中文", x: 1 }, omitted: undefined })).toBe(hashAgentAnswerPayload({ a: { x: 1, z: "中文" }, b: 2 }));
    expect(hashAgentAnswerPayload({ value: null })).not.toBe(hashAgentAnswerPayload({}));
    expect(() => hashAgentAnswerPayload({ n: NaN })).toThrow(AgentAnswerAuditError);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => hashAgentAnswerPayload(cycle)).toThrow(AgentAnswerAuditError);
  });
  it("does not promote final_evidence or runtime_terminal into a completed turn", () => {
    const summary = buildAgentAnswerAuditSummary([event("turn_started", { answerEvidenceMode: "shadow" }), event("final_evidence", decision), event("runtime_terminal", { status: "completed" })]);
    expect(summary).toMatchObject({ status: "running", mode: "shadow" });
    expect(summary?.evidence).toBeUndefined();
    expect(summary?.finalText).toBeUndefined();
    expect(summary?.runtimeTerminal).toBeUndefined();
  });
  it("projects only host display fields and the actual supplied terminal", () => {
    const summary = buildAgentAnswerAuditSummary([event("turn_started"), event("final_evidence", decision), event("turn_completed", { terminal: { schemaVersion: "agent-runtime-terminal.v1", status: "completed", cleanupStatus: "completed", ownerId: turnId, rawDraft: "secret" } })]);
    expect(summary).toMatchObject({ status: "completed", finalText: decision.displayText, runtimeTerminal: { status: "completed", cleanupStatus: "completed" }, evidence: { auditPersisted: true, outcome: "unknown" } });
    const serialized = JSON.stringify(summary);
    for (const forbidden of ["rawDraft", "ownerId", "policyHash", "private-runtime", "authorization"]) expect(serialized).not.toContain(forbidden);
    expect(serialized).toContain("当前执行活性未知。");
  });
  it("does not fabricate cleanup success or parse unknown final schemas", () => {
    const summary = buildAgentAnswerAuditSummary([event("turn_started"), event("final_evidence", { ...decision, schemaVersion: "future.v2" }), event("turn_failed", { terminal: { status: "failed", error: "Interrupted" } })]);
    expect(summary?.status).toBe("failed");
    expect(summary?.evidence).toBeUndefined();
    expect(summary?.runtimeTerminal).toEqual({ status: "failed", error: "Interrupted" });
    expect(buildAgentAnswerAuditSummary([event("turn_completed")])).toBeNull();
  });
  it("keeps an incomplete audit separate from the original runtime outcome", () => {
    const safe = { ...decision, outcome: "unknown", auditIncomplete: true, evidenceRefs: [] };
    const summary = buildAgentAnswerAuditSummary([event("turn_started"), event("final_evidence", { ...decision, outcome: "supported_fields" }), event("final_evidence", safe), event("turn_failed", { terminal: { status: "failed", cleanupStatus: "completed", completionScope: "answer_delivery", runtimeStatus: "completed", privatePolicy: "secret" } })]);
    expect(summary).toMatchObject({ status: "failed", evidence: { auditPersisted: true, auditIncomplete: true, outcome: "unknown", evidenceRefs: [] }, runtimeTerminal: { status: "failed", completionScope: "answer_delivery", runtimeStatus: "completed", cleanupStatus: "completed" } });
    expect(JSON.stringify(summary)).not.toContain("privatePolicy");
    const invalid = buildAgentAnswerAuditSummary([event("turn_started"), event("final_evidence", { ...safe, auditIncomplete: "false" }), event("turn_failed", { terminal: { status: "failed", completionScope: "loop_stopped", runtimeStatus: "active" } })]);
    expect(invalid?.evidence).not.toHaveProperty("auditIncomplete");
    expect(invalid?.runtimeTerminal).toEqual({ status: "failed" });
  });
  it("turns client evidence into an audit reference, retaining unrelated message parts", () => {
    const safe = sanitizeClientAnswerEvidence([{ type: "text", text: "text" }, { type: "data-answerEvidence", data: { turnId, auditPersisted: true, outcome: "supported_fields", displayText: "fake" } }, { type: "data-answerEvidence", data: { outcome: "supported_fields" } }], { usage: { total: 4 }, answerEvidence: { turnId, verified: true }, answer_evidence: { verified: true } });
    expect(safe).toEqual({ parts: [{ type: "text", text: "text" }, { type: "data-answerEvidence", data: { turnId } }], metadata: { usage: { total: 4 }, answerEvidence: { turnId } } });
  });
  it("projects the new platform decision without leaking storage or query details", () => {
    const summary = buildAgentAnswerAuditSummary([event("turn_started", { platformAnswerMode: "enforce_supported", answerEvidenceMode: "enforce_critical" }), event("final_evidence", platformDecision),
      event("turn_completed", { terminal: { schemaVersion: "agent-runtime-terminal.v1", status: "completed", cleanupStatus: "completed" } })]);
    expect(summary).toMatchObject({ mode: "enforce_supported", status: "completed", finalText: platformDecision.displayText,
      evidence: { schemaVersion: "platform-answer-summary.v1", kind: "platform", contractKind: "chat_identity", mode: "enforce_supported", questionComplete: true,
        evidenceCoverage: platformDecision.evidenceCoverage, auditPersisted: true,
        evidenceRefs: [{ source: "chat", scope: "owner_exact_record", observedAt: "2026-10-04T00:00:00Z" }] } });
    expect(JSON.stringify(summary)).not.toMatch(/rawDraft|private-runtime|ownerId|authorization|query|secret/);
  });
  it("rejects unknown platform contracts and contradictory coverage instead of granting a summary", () => {
    const summarize = (payload: Record<string, unknown>) => buildAgentAnswerAuditSummary([event("turn_started"), event("final_evidence", payload), event("turn_completed")]);
    for (const payload of [
      { ...platformDecision, contractKind: "future_contract" }, { ...platformDecision, mode: "enforce_critical" },
      { ...platformDecision, evidenceCoverage: { ...platformDecision.evidenceCoverage, total: 2 } },
      { ...platformDecision, questionComplete: "true" }, { ...platformDecision, resolutions: [...platformDecision.resolutions, ...platformDecision.resolutions] },
    ]) expect(summarize(payload)?.evidence).toBeUndefined();
    const safe = summarize({ ...platformDecision, evidenceRefs: [{ evidenceId: "r1", source: "private query", scope: "all_users", observedAt: "secret-token", status: "read" }] });
    expect(safe?.evidence?.evidenceRefs).toEqual([{ evidenceId: "r1", observedAt: undefined, status: "read" }]);
  });
  it("exposes only versioned planned question progress, never an early final claim", () => {
    const summary = buildAgentAnswerAuditSummary([event("turn_started", { platformAnswerMode: "shadow" }),
      event("requirements_planned", { schemaVersion: "platform-answer-progress.v1", requirements: [{ id: "chat.title", label: "对话标题", clause: "private question", source: "chat", ownerId: turnId }] }),
      event("requirement_resolved", { schemaVersion: "platform-answer-progress.v1", resolution: platformDecision.resolutions[0], rawDraft: "private" }),
      event("requirement_resolved", { schemaVersion: "future.v2", resolution: { ...platformDecision.resolutions[0], state: "denied" } }),
      event("requirement_resolved", { schemaVersion: "platform-answer-progress.v1", resolution: { ...platformDecision.resolutions[0], requirementId: "unplanned" } }),
      event("read_phase_closed", { schemaVersion: "platform-answer-progress.v1", reason: "private internals" }), event("final_evidence", platformDecision)]);
    expect(summary).toMatchObject({ status: "running", mode: "shadow", progress: { schemaVersion: "platform-answer-progress.v1", phase: "read_closed",
      totalRequirements: 1, resolvedRequirements: 1, requirements: [{ requirementId: "chat.title", label: "对话标题", state: "supported", reason: "指定标题字段已读" }] } });
    expect(summary?.evidence).toBeUndefined();
    expect(summary?.finalText).toBeUndefined();
    expect(JSON.stringify(summary)).not.toMatch(/ownerId|clause|rawDraft|private|unplanned/);
    expect(buildAgentAnswerAuditSummary([event("turn_started"), event("requirements_planned", { schemaVersion: "future.v2", requirements: [] })])?.progress).toBeUndefined();
  });
});
