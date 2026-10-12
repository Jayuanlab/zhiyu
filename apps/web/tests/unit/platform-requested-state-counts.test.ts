import { describe, expect, it } from "vitest";
import type { ToolConstruction } from "@/lib/ai/runtime/answer-evidence-contract";
import { createPlatformAnswerSession } from "@/lib/ai/runtime/platform-answer-session";
import { selectPlatformAnswerContract, type PlatformAnswerSessionOptions } from "@/lib/ai/runtime/platform-answer-contract";
import { createLivePlatformStatisticsProof, createFrozenPlatformStatisticsProof } from "@/lib/ai/platform-statistics-proof";

const at = "2026-10-04T01:00:00.000Z", source = "interactionProcessingJobs.status";
const groups = [{ value: "completed", count: 5 }, { value: "running", count: 2 }, { value: "future_custom_state", count: 1 }, { value: null, count: 1 }];
function metric(overrides: Record<string, unknown> = {}) {
  const member = { source, status: "ok", total: 9, groups, observedAt: at,
    scopeProof: createLivePlatformStatisticsProof({ ownerId: "owner", source, total: 9, groups, observedAt: at }) };
  return { ...member, ...overrides };
}
function setup(question: string, options: Partial<PlatformAnswerSessionOptions> = {}) {
  return createPlatformAnswerSession({ mode: "enforce_supported", question, turnId: "turn", ownerId: "owner", policyHash: "policy", runtimeHash: "runtime",
    auditSink: async () => undefined, authorizeFinal: async () => true, now: () => new Date(at), ...options });
}
function construction(member: unknown, toolCallId = "read", modelText?: string): ToolConstruction {
  const result = { statistics: { results: [member] } };
  return { toolName: "platformRecall", toolCallId, params: { question: "counts" }, result, modelText: modelText ?? JSON.stringify(result),
    trace: { type: "tool_result", title: "completed", detail: null, toolName: "platformRecall", toolUseId: toolCallId, status: "completed", timestamp: at, durationMs: 1,
      metadata: { decision: "allow", reason: "allowed", matchedRule: "platformRecall", deniedBeforeHandler: false } } };
}
async function deliver(session: ReturnType<typeof setup>, c: ToolConstruction, delivery = "emitted") {
  await session.observeToolConstruction(c);
  if (delivery === "context") await session.observeContextCommitted({ toolCallId: c.toolCallId, entryId: "entry", modelText: c.modelText! });
  if (delivery === "emitted") await session.observeToolResult({ type: "tool_result", toolUseId: c.toolCallId, output: c.modelText, isError: false,
    toolResultDetails: { result: c.result, trace: c.trace } });
}
const finish = (session: ReturnType<typeof setup>) => session.finalize({ terminal: { schemaVersion: "agent-runtime-terminal.v1", status: "completed", cleanupStatus: "completed" }, rawDraft: "all good" });
const stateRequests = (question: string) => selectPlatformAnswerContract(question)?.requirements.filter(item => (item as any).metricRequest).map(item => ({ source: item.source, request: (item as any).metricRequest })) ?? [];

describe("requested state obligations from the host original question", () => {
  it("creates separate completed and failed counts while preserving the waiting-definition obligation", () => {
    const question = "当前用户的消息理解作业，等待、完成、失败等状态各有多少个？失败作业不等于消息消失。";
    const plan = selectPlatformAnswerContract(question)!;
    expect(plan.ruleVersion).toBe("platform-compact-interpretation.v7");
    expect(stateRequests(question)).toEqual([
      { source: "interaction_processing_jobs.status", request: { kind: "dimension_value", requestedLabel: "完成", value: "completed" } },
      { source: "interaction_processing_jobs.status", request: { kind: "dimension_value", requestedLabel: "失败", value: "failed" } },
    ]);
    expect(plan.requirements.some(item => (item as any).boundaryKind === "waiting_definition")).toBe(true);
    expect(plan.requirements.some(item => item.id === "processing_failure_not_disappearance")).toBe(true);
  });
  it("keeps an explicit waiting=pending definition separate from actual runnable eligibility", () => {
    const question = "消息理解作业，等待=pending，完成、失败各有多少个？可领取作业数量是多少？";
    expect(stateRequests(question).map(item => item.request.value)).toEqual(["pending", "completed", "failed"]);
    expect(selectPlatformAnswerContract(question)?.requirements.some(item => (item as any).boundaryKind === "runnable_job_count")).toBe(true);
    expect(selectPlatformAnswerContract(question)?.requirements.some(item => (item as any).boundaryKind === "waiting_definition")).toBe(false);
  });
  it("honors an explicit source-unambiguous definition without upgrading quoted data to that definition", () => {
    const question = "消息理解作业，等待定义为 status='pending'。等待、完成、失败各有多少个？";
    expect(stateRequests(question).map(item => item.request.value)).toEqual(["pending", "completed", "failed"]);
    expect(selectPlatformAnswerContract(question)?.requirements.some(item => item.boundaryKind === "waiting_definition")).toBe(false);
    const literal = "消息理解作业 status='等待=pending' 数量是多少？等待作业数量是多少？";
    expect(selectPlatformAnswerContract(literal)?.requirements.some(item => item.boundaryKind === "waiting_definition")).toBe(true);
    expect(stateRequests(literal).map(item => item.request.value)).toEqual(["等待=pending"]);
  });
  it("does not transfer another population's definition across sentences or ambiguous multiple populations", () => {
    for (const question of ["记忆的等待指pending。消息理解作业等待数量是多少？", "记忆和消息理解作业，等待=pending，各有多少？"]) {
      expect(stateRequests(question)).toEqual([]);
      expect(selectPlatformAnswerContract(question)?.requirements.some(item => item.id === "unassessed_clause")).toBe(true);
    }
    expect(selectPlatformAnswerContract("记忆的等待指pending。消息理解作业等待数量是多少？")?.requirements.some(item => item.source === "interaction_processing_jobs.status" && item.boundaryKind === "waiting_definition")).toBe(true);
  });
  it.each(["未完成", "尚未完成", "不是失败", "not completed", "not failed"])("does not turn the negative neighbor %s into a positive state", label => {
    const question = `消息理解作业，${label}的数量是多少？`;
    expect(stateRequests(question)).toEqual([]);
    expect(selectPlatformAnswerContract(question)?.requirements.some(item => item.id === "unassessed_clause")).toBe(true);
  });
  it("binds raw requested labels to the explicitly named source rather than broadcasting across populations", () => {
    const requests = stateRequests("消息理解作业完成、失败各有多少？记忆 status='active' 的数量是多少？");
    expect(requests.map(item => [item.source, item.request.value])).toEqual([
      ["interaction_processing_jobs.status", "completed"], ["interaction_processing_jobs.status", "failed"], ["brain_memories.status", "active"],
    ]);
    expect(stateRequests("消息理解作业和记忆，完成、失败各有多少？")).toEqual([]);
  });
  it("accepts explicit open raw status labels without interpreting their spelling as business aliases", () => {
    const requests = stateRequests("消息理解作业 status='brand_new_value' 和 status='waiting' 数量分别是多少？");
    expect(requests.map(item => item.request.value)).toEqual(["brand_new_value", "waiting"]);
    expect(selectPlatformAnswerContract("消息理解作业 status='waiting' 的数量是多少？")?.requirements.some(item => (item as any).boundaryKind === "waiting_definition")).toBe(false);
  });
  it("accepts bare active, candidate and rejected as literal source-bound status counts", () => {
    expect(stateRequests("记忆 active、candidate、rejected 各有多少？").map(item => [item.source, item.request.value])).toEqual([
      ["brain_memories.status", "active"], ["brain_memories.status", "candidate"], ["brain_memories.status", "rejected"],
    ]);
    expect(stateRequests("车间 active 数量多少？记忆 candidate 数量多少？外发队列 rejected 数量多少？").map(item => [item.source, item.request.value])).toEqual([
      ["workshops.status", "active"], ["brain_memories.status", "candidate"], ["workshop_outbox.status", "rejected"],
    ]);
  });
  it.each(["记忆 not active 数量是多少？", "记忆不是 candidate 数量是多少？", "记忆和车间 active 各有多少？", "记忆 'rejected' 数量是多少？"])("does not make a raw count from negated, quoted or ambiguous syntax: %s", question => {
    expect(stateRequests(question)).toEqual([]);
    expect(selectPlatformAnswerContract(question)?.requirements.some(item => item.id === "unassessed_clause")).toBe(true);
  });
  it("does not drop unknown waiting or runnable clauses when no raw label is requested", () => {
    for (const term of ["等待", "待处理", "待领取"]) {
      expect(selectPlatformAnswerContract(`消息理解作业${term}数量是多少？`)?.requirements.some(item => (item as any).boundaryKind === "waiting_definition")).toBe(true);
    }
  });
  it.each(["成功", "错误", "运行中"])("does not certify an unregistered natural state concept %s", label => {
    const question = `消息理解作业${label}数量是多少？`;
    expect(stateRequests(question)).toEqual([]);
    expect(selectPlatformAnswerContract(question)?.requirements.some(item => item.id === "unassessed_clause")).toBe(true);
  });
  it("keeps NULL unclassified separate from a literal string label and rejects other dimensions", () => {
    expect(stateRequests("消息理解作业 status=NULL 与 status='NULL' 各有多少？").map(item => item.request.value)).toEqual([null, "NULL"]);
    expect(stateRequests("消息理解作业 processed_status='failed' 数量是多少？")).toEqual([]);
    expect(selectPlatformAnswerContract("消息理解作业 processed_status='failed' 数量是多少？")?.requirements.some(item => item.id === "unassessed_clause")).toBe(true);
  });
  it("does not infer a complement count for negated or non-count prose", () => {
    for (const question of ["消息理解作业 status!='failed' 的数量是多少？", "消息理解作业并非 status='failed' 的数量是多少？", "消息理解作业 not (status='failed') 的数量是多少？", "消息理解作业不是(status=failed)的数量是多少？", "消息理解作业完成之前会失败，总数是多少？"]) {
      expect(stateRequests(question)).toEqual([]);
      expect(selectPlatformAnswerContract(question)?.requirements.some(item => item.id === "unassessed_clause")).toBe(true);
    }
  });
  it("caps public obligations and preserves an explicit unassessed overflow instead of certifying the omitted requests", () => {
    const plan = selectPlatformAnswerContract(`消息理解作业 ${Array.from({ length: 80 }, (_, index) => `status='custom_${index}'`).join("、")} 数量分别是多少？`)!;
    expect(plan.requirements.length).toBeLessThanOrEqual(64);
    expect(plan.requirements.some(item => item.id === "unassessed_clause")).toBe(true);
  });
});

describe("scope-proved absent state counts", () => {
  it("renders bare memory status counts only from a complete emitted owner proof", async () => {
    const memorySource = "brain_memories.status", memoryGroups = [{ value: "active", count: 4 }, { value: "candidate", count: 2 }, { value: null, count: 1 }];
    const session = setup("记忆 active、candidate、rejected 各有多少？");
    await deliver(session, construction(metric({ source: memorySource, total: 7, groups: memoryGroups,
      scopeProof: createLivePlatformStatisticsProof({ ownerId: "owner", source: memorySource, total: 7, groups: memoryGroups, observedAt: at }) })));
    const decision = await finish(session);
    expect(decision.renderedText).toMatch(/原始标签[^\n]*active[^\n]*数量 4/u);
    expect(decision.renderedText).toMatch(/原始标签[^\n]*candidate[^\n]*数量 2/u);
    expect(decision.renderedText).toMatch(/原始标签[^\n]*rejected[^\n]*数量 0/u);
    expect(decision.questionComplete).toBe(true);
    expect(decision.resolutions.filter(item => item.reason === "absent_dimension_value_in_complete_query")).toHaveLength(1);
  });
  it.each(["missing_proof", "different_owner", "constructed", "final_denied"])("keeps bare memory counts unknown without valid delivery/authority: %s", async variant => {
    const memorySource = "brain_memories.status", memoryGroups = [{ value: "active", count: 4 }];
    const session = setup("记忆 active、candidate、rejected 各有多少？", variant === "final_denied" ? { authorizeFinal: async () => false } : {});
    const member = metric({ source: memorySource, total: 4, groups: memoryGroups,
      scopeProof: variant === "missing_proof" ? undefined : createLivePlatformStatisticsProof({ ownerId: variant === "different_owner" ? "other" : "owner", source: memorySource, total: 4, groups: memoryGroups, observedAt: at }) });
    await deliver(session, construction(member), variant === "constructed" ? "constructed" : "emitted");
    const decision = await finish(session);
    expect(decision.questionComplete).toBe(false);
    expect(decision.resolutions.some(item => item.reason === "absent_dimension_value_in_complete_query")).toBe(false);
    expect(decision.evidenceRefs).toEqual([]);
    expect(decision.renderedText).not.toMatch(/数量 [04]/u);
  });
  it("answers every named raw state, retaining full groups, NULL and the waiting boundary", async () => {
    const session = setup("消息理解作业，等待、完成、失败等状态各有多少个？");
    await deliver(session, construction(metric())); const decision = await finish(session);
    expect(decision.renderedText).toContain('"failed"'); expect(decision.renderedText).toMatch(/原始标签[^\n]*failed[^\n]*数量 0/u);
    expect(decision.renderedText).toMatch(/原始标签[^\n]*completed[^\n]*数量 5/u);
    expect(decision.renderedText).toContain("future_custom_state"); expect(decision.renderedText).toContain("null");
    expect(decision.renderedText).toContain("等待"); expect(decision.renderedText).toContain("尚未明确");
    expect(decision.resolutions.some(item => item.reason === "absent_dimension_value_in_complete_query" && item.state === "supported" && item.evidenceIds.length === 1)).toBe(true);
    expect(decision.questionComplete).toBe(false);
  });
  it("can count explicitly defined pending while not presenting running as waiting or worker activity", async () => {
    const session = setup("消息理解作业，等待=pending，完成、失败各有多少个？");
    await deliver(session, construction(metric())); const decision = await finish(session);
    expect(decision.renderedText).toMatch(/原始标签[^\n]*pending[^\n]*数量 0/u); expect(decision.renderedText).toContain('"running"');
    expect(decision.questionComplete).toBe(true);
  });
  it("proves zero in a genuinely empty complete owner query without inventing a closed status catalog", async () => {
    const session = setup("消息理解作业完成、失败各有多少？");
    await deliver(session, construction(metric({ total: 0, groups: [], scopeProof: createLivePlatformStatisticsProof({ ownerId: "owner", source, total: 0, groups: [], observedAt: at }) })));
    const decision = await finish(session);
    expect(decision.resolutions.filter(item => item.reason === "absent_dimension_value_in_complete_query")).toHaveLength(2);
    expect(decision.questionComplete).toBe(true); expect(decision.renderedText).not.toContain("resume_pending");
  });
  it("counts an actual open raw label and NULL without equating them to a missing string label", async () => {
    const session = setup("消息理解作业 status='future_custom_state'、status=NULL 与 status='null' 各有多少？");
    await deliver(session, construction(metric())); const decision = await finish(session);
    expect(decision.renderedText).toMatch(/原始标签[^\n]*future_custom_state[^\n]*数量 1/u);
    expect(decision.renderedText).toMatch(/未分类（NULL）分组数量 1/u); expect(decision.renderedText).toContain("并非 SQL 等值谓词");
    expect(decision.renderedText).toMatch(/原始标签[^\n]*"null"[^\n]*数量 0/u);
    expect(decision.questionComplete).toBe(true);
  });
  it.each([true, false])("requires the explicitly requested captured instant to match host snapshot metadata: %s", async matched => {
    const captured = matched ? at : "2026-10-03T01:00:00.000Z";
    const query = 'SELECT s."status" AS value, count(*)::int AS count FROM "interaction_processing_jobs" s WHERE s.user_id = $1 GROUP BY s."status" ORDER BY s."status" NULLS FIRST';
    const session = setup(`在随题提供的只读数据快照（${at}）中，消息理解作业完成、失败各有多少？`, { snapshotAt: captured, timePolicy: { mode: "unconstrained" } });
    await deliver(session, construction(metric({ observedAt: captured, scopeProof: createFrozenPlatformStatisticsProof({ ownerId: "owner", source, total: 9, groups,
      observedAt: captured, query, parameters: ["owner"], captureHash: "a".repeat(64) }) })));
    const decision = await finish(session);
    expect(decision.resolutions.some(item => item.reason === "absent_dimension_value_in_complete_query")).toBe(matched);
    expect(decision.questionComplete).toBe(matched);
    if (!matched) { expect(decision.evidenceRefs).toEqual([]); expect(decision.renderedText).not.toMatch(/数量 0/u); }
  });
  it("does not reuse a stale whole-query proof for a current zero request", async () => {
    const session = setup("当前消息理解作业失败数量是多少？", { timePolicy: { mode: "current", now: at, maxAgeMs: 300_000 } });
    const old = "2026-10-03T01:00:00.000Z";
    await deliver(session, construction(metric({ observedAt: old, scopeProof: createLivePlatformStatisticsProof({ ownerId: "owner", source, total: 9, groups, observedAt: old }) })));
    const decision = await finish(session);
    expect(decision.questionComplete).toBe(false); expect(decision.evidenceRefs).toEqual([]); expect(decision.renderedText).not.toMatch(/数量 0/u);
  });
  it("cannot pick zero from competing complete queries at the same observation time", async () => {
    const session = setup("消息理解作业失败数量是多少？");
    await deliver(session, construction(metric()));
    const otherGroups = [{ value: "failed", count: 9 }];
    await deliver(session, construction(metric({ groups: otherGroups, scopeProof: createLivePlatformStatisticsProof({ ownerId: "owner", source, total: 9, groups: otherGroups, observedAt: at }) }), "read-other"));
    const decision = await finish(session);
    expect(decision.resolutions.some(item => item.reason === "absent_dimension_value_in_complete_query")).toBe(false);
    expect(decision.questionComplete).toBe(false); expect(decision.evidenceRefs).toEqual([]);
  });
  it("keeps an arbitrary raw label out of progress Markdown and safely quotes its literal value", async () => {
    const dangerous = "[open](https://example.com) <img src=x> ```";
    const question = `消息理解作业 status='${dangerous}' 的数量是多少？`;
    const plan = selectPlatformAnswerContract(question)!;
    expect(plan.requirements.find(item => item.metricRequest)?.label).toBe("原问指定原始标签数量");
    const session = setup(question); await deliver(session, construction(metric())); const decision = await finish(session);
    expect(decision.renderedText).toContain('```` "[open](https://example.com) <img src=x> ```" ````');
    expect(decision.questionComplete).toBe(true);
  });
  it.each(["missing_proof", "different_owner", "changed_result", "unavailable", "constructed", "context", "formatted_mismatch", "snapshot_mismatch", "final_denied"])("never manufactures zero from %s", async variant => {
    const session = setup("消息理解作业失败数量是多少？", variant === "final_denied" ? { authorizeFinal: async () => false }
      : variant === "snapshot_mismatch" ? { snapshotAt: "2026-10-03T01:00:00.000Z" } : {});
    const member = metric(variant === "missing_proof" ? { scopeProof: undefined } : variant === "different_owner" ? {
      scopeProof: createLivePlatformStatisticsProof({ ownerId: "other", source, total: 9, groups, observedAt: at }) }
      : variant === "changed_result" ? { total: 8 } : variant === "unavailable" ? { status: "unavailable" } : {});
    const c = construction(member, "read", variant === "formatted_mismatch" ? JSON.stringify({ statistics: { results: [] } }) : undefined);
    await deliver(session, c, variant === "constructed" ? "constructed" : variant === "context" ? "context" : "emitted");
    const decision = await finish(session);
    expect(decision.resolutions.some(item => item.reason === "absent_dimension_value_in_complete_query")).toBe(false);
    expect(decision.renderedText).not.toMatch(/数量 0/u); expect(decision.questionComplete).toBe(false);
    expect(decision.evidenceRefs).toEqual([]);
  });
  it("does not extrapolate runnable counts from pending, retryable failures or unclassified states", async () => {
    const queryGroups = [{ value: "pending", count: 3 }, { value: "failed", count: 2 }, { value: "resume_pending", count: 1 }];
    const session = setup("消息理解作业等待=pending 的数量和可领取作业数量是多少？");
    await deliver(session, construction(metric({ groups: queryGroups, total: 6, scopeProof: createLivePlatformStatisticsProof({ ownerId: "owner", source, groups: queryGroups, total: 6, observedAt: at }) })));
    const decision = await finish(session);
    expect(decision.renderedText).toMatch(/原始标签[^\n]*pending[^\n]*数量 3/u);
    expect(decision.renderedText).toContain("计划时间"); expect(decision.renderedText).toContain("重试次数"); expect(decision.questionComplete).toBe(false);
  });
  it("keeps multiple business-waiting interpretations separate and cited without giving a unique total", async () => {
    const session = setup("消息理解作业等待数量是多少？"); await deliver(session, construction(metric()));
    const decision = await finish(session), resolution = decision.resolutions.find(item => item.reason === "waiting_has_multiple_feature_definitions");
    expect(resolution).toMatchObject({ state: "unknown", evidenceIds: ["turn:read"] });
    expect(decision.renderedText).toContain("pending 标签：0 条"); expect(decision.renderedText).toContain("resume_pending 标签：0 条"); expect(decision.renderedText).toContain("needs_review 标签：0 条");
    expect(decision.renderedText).toContain("按现有服务规则，对该次已存状态观测作条件计算");
    expect(decision.renderedText).toContain("未核实观测时点的服务规则版本");
    expect(decision.renderedText).toContain("不合并成唯一等待量"); expect(decision.renderedText).toContain("future_custom_state"); expect(decision.questionComplete).toBe(false);
  });
  it("proves runnable zero only when every fixed necessary status is absent in a complete query", async () => {
    const session = setup("消息理解作业可领取数量是多少？"); await deliver(session, construction(metric()));
    const decision = await finish(session);
    expect(decision.resolutions.find(item => item.reason === "fixed_service_necessary_status_empty")).toMatchObject({ state: "supported", evidenceIds: ["turn:read"] });
    expect(decision.renderedText).toContain("可领取作业数为 0"); expect(decision.renderedText).toContain("future_custom_state"); expect(decision.questionComplete).toBe(true);
  });
  it("labels current-policy calculations on a historical snapshot without asserting historical policy or realtime eligibility", async () => {
    const query = 'SELECT s."status" AS value, count(*)::int AS count FROM "interaction_processing_jobs" s WHERE s.user_id = $1 GROUP BY s."status" ORDER BY s."status" NULLS FIRST';
    const session = setup(`在随题提供的只读数据快照（${at}）中，消息理解作业等待和可领取数量是多少？`, { snapshotAt: at, timePolicy: { mode: "unconstrained" } });
    await deliver(session, construction(metric({ scopeProof: createFrozenPlatformStatisticsProof({ ownerId: "owner", source, total: 9, groups,
      observedAt: at, query, parameters: ["owner"], captureHash: "a".repeat(64) }) })));
    const decision = await finish(session);
    expect(decision.renderedText.match(/按现有服务规则，对该只读快照作条件计算/gu)).toHaveLength(2);
    expect(decision.renderedText).toContain("未核实观测时点的服务规则版本，也不代表实时领取状态");
    expect(decision.resolutions.find(item => item.reason === "waiting_has_multiple_feature_definitions")?.state).toBe("unknown");
    expect(decision.resolutions.find(item => item.reason === "fixed_service_necessary_status_empty")?.state).toBe("supported");
    expect(decision.questionComplete).toBe(false);
  });
  it.each(["missing_proof", "context", "final_denied", "conflict"])("does not manufacture conditional waiting/runnable zeros with %s", async variant => {
    const session = setup("消息理解作业等待和可领取数量是多少？", variant === "final_denied" ? { authorizeFinal: async () => false } : {});
    await deliver(session, construction(metric(variant === "missing_proof" ? { scopeProof: undefined } : {})), variant === "context" ? "context" : "emitted");
    if (variant === "conflict") {
      const changed = [{ value: "pending", count: 9 }]; await deliver(session, construction(metric({ groups: changed, scopeProof: createLivePlatformStatisticsProof({ ownerId: "owner", source, total: 9, groups: changed, observedAt: at }) }), "other"));
    }
    const decision = await finish(session);
    expect(decision.renderedText).not.toContain("可领取作业数为 0"); expect(decision.renderedText).not.toContain("pending 标签：0 条");
    expect(decision.questionComplete).toBe(false);
  });
});
