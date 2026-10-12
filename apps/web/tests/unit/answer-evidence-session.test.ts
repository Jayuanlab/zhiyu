import { describe, expect, it, vi } from "vitest";
import type { AgentMessage, AgentRuntimeTerminal } from "@openzhiyu/ai/agent/types";
import { createAnswerEvidenceSession, answerTextHash, exactCurrentLoopEvidenceSubject } from "@/lib/ai/runtime/answer-evidence-session";
import { guardExactLoopAnswer } from "@/lib/ai/runtime/answer-evidence-loop-gate";
import type { ToolConstruction, AnswerEvidenceSessionOptions, AnswerEvidenceAuditEvent } from "@/lib/ai/runtime/answer-evidence-contract";
import { createGuardedPiTool } from "@/lib/ai/runtime/pi-tool-adapter";
import { createMemoryAccessTool } from "@/lib/ai/memory-access";
import { withMemoryReadBudget } from "@/lib/ai/memory-read-budget";
import { Type } from "@earendil-works/pi-ai";

const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const at = "2026-10-02T10:00:00.000Z";
const terminal: AgentRuntimeTerminal = { schemaVersion: "agent-runtime-terminal.v1", status: "completed", cleanupStatus: "completed" };
function construction(overrides: Partial<ToolConstruction> = {}): ToolConstruction {
  const value: ToolConstruction = { toolCallId: "read-1", toolName: "platformRecall", params: { runtimeRead: { loopId: id } },
    result: { ok: true, runtime: { provider: "workshop_execution_leases", loopId: id, observedAt: at,
      status: "no_active_linked_execution_observed", observationScope: "active_linked_execution_mapping_only", linkedExecution: null,
      loopConfiguration: { status: "active", updatedAt: at } } },
    trace: { type: "tool_result", title: "completed", detail: null, toolName: "platformRecall", toolUseId: "read-1",
      status: "completed", timestamp: at, durationMs: 1,
      metadata: { decision: "allow", reason: "allowed", matchedRule: "platformRecall", deniedBeforeHandler: false } }, ...overrides };
  if (!overrides.trace) value.trace = { ...value.trace, toolUseId: value.toolCallId, toolName: value.toolName };
  if (!Object.hasOwn(overrides, "modelText")) value.modelText = value.toolName === "askMemory"
    ? (value.result as any).content.map((block: any) => block.text).join("\n")
    : JSON.stringify((value.result as any).runtime ?? value.result);
  return value;
}
function emitted(c: ToolConstruction): AgentMessage {
  return { type: "tool_result", toolUseId: c.toolCallId, output: c.modelText, isError: false,
    toolResultDetails: { result: c.result, trace: c.trace } };
}
function setup(overrides: Partial<AnswerEvidenceSessionOptions> = {}) {
  const auditSink = vi.fn(async (_event: AnswerEvidenceAuditEvent) => undefined);
  return { auditSink, session: createAnswerEvidenceSession({ mode: "enforce_critical", turnId: "turn-1", ownerId: "owner-1", policyHash: "policy-1",
    runtimeHash: "runtime-1", question: `Loop ${id} 当前是否正在运行？`, auditSink,
    authorizeFinal: async () => true, now: () => new Date(at), ...overrides }) };
}
async function finish(session: ReturnType<typeof setup>["session"], state = terminal) {
  return session.finalize({ terminal: state, rawDraft: "执行器已停止" });
}
async function* stream(events: AgentMessage[]) { for (const event of events) yield event; }
async function collect(events: AsyncGenerator<AgentMessage>) { const output: AgentMessage[] = []; for await (const event of events) output.push(event); return output; }

describe("host answer evidence session", () => {
  it.each([
    `Loop ${id} 当前是否正在运行？`,
    `请查看 Loop ${id} 目前的执行器租约和心跳状态`,
    `Is Loop ${id} currently running?`,
  ])("selects only the bounded current-state read: %s", (question) => {
    expect(exactCurrentLoopEvidenceSubject(question)).toBe(id);
  });
  it.each([
    `暂停 Loop ${id}，然后确认当前是否运行`,
    `请把 Loop ${id} 暂停，并查看当前运行状态`,
    `Loop ${id} 当前是否运行？暂停后是不是生效了`,
    `Loop ${id} 当前是否运行，为什么故障？`,
    `Loop ${id} 当前是否运行，下次执行是什么时候？`,
    `Pause Loop ${id} and check if it is currently running`,
    `Is Loop ${id} currently running, and when is its next scheduled run?`,
    `Loop ${id} currently running? Please click the confirm button to change its config.`,
    `Loop ${id} 当前运行结果是否成功？`,
    `Loop ${id} 和 Loop ${other} 当前是否都运行？`,
  ])("leaves unsupported or mixed goals on the legacy path: %s", (question) => {
    expect(exactCurrentLoopEvidenceSubject(question)).toBeNull();
    expect(setup({ question }).session.supported).toBe(false);
  });
  it("does not grant evidence from model text, unregistered details or construction alone", async () => {
    const c = construction();
    for (const variant of ["text", "unregistered", "constructed"] as const) {
      const { session } = setup();
      if (variant === "text") await session.observeToolResult({ type: "text", content: JSON.stringify(c.result) });
      if (variant === "unregistered") await session.observeToolResult(emitted(c));
      if (variant === "constructed") await session.observeToolConstruction(c);
      const d = await finish(session);
      expect(d.outcome).toBe("unknown"); expect(d.evidenceRefs).toEqual([]);
    }
  });

  it("renders only delivered exact observations and keeps mapping absence separate from liveness", async () => {
    const { session, auditSink } = setup(), c = construction();
    await session.observeToolConstruction(c); await session.observeToolResult(emitted(c));
    const d = await finish(session);
    expect(d.outcome).toBe("supported_fields");
    expect(d.renderedText).toContain("没有评估"); expect(d.renderedText).toContain("仍在运行未知");
    expect(d.renderedText).not.toContain("执行器已停止"); expect(d.auditPersisted).toBe(true);
    expect(d.rawDraftHash).toBe(answerTextHash("执行器已停止"));
    expect(auditSink.mock.calls.map(([e]) => e.eventKey)).toEqual(["read-1:observed_server", "read-1:result_constructed", "read-1:tool_result_emitted", "runtime_terminal", "final_evidence", "turn_terminal"]);
    expect(auditSink.mock.calls.find(([e]) => e.eventKey === "read-1:observed_server")?.[0].payload).toMatchObject({
      stage: "observed_server", registrationStage: "result_constructed_callback", recordedAt: at, sourceObservedAt: at,
    });
    expect(auditSink.mock.calls.find(([e]) => e.eventKey === "turn_terminal")?.[0].payload).toMatchObject({ terminal, mode: "enforce_critical" });
  });

  it.each(["subject", "inner_error", "missing_ok", "success_false", "trace_denied", "trace_id", "result_changed", "snapshot", "stale", "outer_error", "construction_conflict"])("rejects %s evidence", async (kind) => {
    const { session } = setup(); const c = construction();
    const result = c.result as any;
    if (kind === "subject") result.runtime.loopId = other;
    if (kind === "inner_error") result.ok = false;
    if (kind === "missing_ok") delete result.ok;
    if (kind === "success_false") result.success = false;
    if (kind === "trace_denied") c.trace.metadata.decision = "deny";
    if (kind === "trace_id") c.trace.toolUseId = "other";
    if (kind === "snapshot") result.frozenSnapshotCapturedAt = at;
    if (kind === "stale") result.runtime.observedAt = "2026-10-02T09:00:00.000Z";
    c.modelText = JSON.stringify(result.runtime);
    await session.observeToolConstruction(c);
    if (kind === "construction_conflict") await session.observeToolConstruction({ ...c, result: { ...result, revision: 2 } });
    const event = emitted(c);
    if (kind === "result_changed") event.toolResultDetails = { result: { ...result, changed: true }, trace: c.trace };
    if (kind === "outer_error") event.isError = true;
    await session.observeToolResult(event);
    expect((await finish(session)).outcome).toBe("unknown");
  });

  it.each(["revoked", "missing_recheck", "audit_failure", "cleanup_failure", "overflow"])("does not display a verified state on %s", async (kind) => {
    const { session } = setup(kind === "revoked" ? { authorizeFinal: async () => false }
      : kind === "missing_recheck" ? { authorizeFinal: undefined }
      : kind === "audit_failure" ? { auditSink: async () => { throw Error("DB unavailable"); } } : {});
    const c = construction(); await session.observeToolConstruction(c); await session.observeToolResult(emitted(c));
    const d = await session.finalize({ terminal: kind === "cleanup_failure" ? { ...terminal, cleanupStatus: "failed" } : terminal,
      rawDraft: "success", draftOverflow: kind === "overflow" });
    expect(["unknown", "execution_failed"]).toContain(d.outcome); expect(d.evidenceRefs).toEqual([]);
  });

  it("requires both matching outer and inner host receipts for untruncated askMemory delivery", async () => {
    for (const complete of [true, false]) {
      const { session } = setup(), inner = construction({ toolCallId: "ask-1:platform" });
      const outer = construction({ toolCallId: "ask-1", toolName: "askMemory", result: { content: [{ type: "text", text: JSON.stringify({ observations: [
        { tool: "platformRecall", status: "retrieved", truncated: !complete, evidence: complete ? inner.modelText : inner.modelText?.slice(0, 20) },
      ] }) }], details: { delegatedReceipts: [{ toolCallId: inner.toolCallId, toolName: inner.toolName, result: inner.result,
        trace: inner.trace, modelText: inner.modelText, deliveredComplete: complete }] } } });
      outer.trace = { ...outer.trace, toolName: "askMemory", toolUseId: "ask-1" };
      await session.observeToolConstruction(inner); await session.observeToolConstruction(outer);
      await session.observeToolResult(emitted(outer));
      expect((await finish(session)).outcome).toBe(complete ? "supported_fields" : "unknown");
    }
  });

  it.each(["missing_model_text", "empty_formatter", "stripped_fields", "changed_emitted_text"])("does not upgrade details when formatted delivery is %s", async (kind) => {
    const { session } = setup(), c = construction();
    if (kind === "missing_model_text") c.modelText = undefined;
    if (kind === "empty_formatter") c.modelText = "";
    if (kind === "stripped_fields") c.modelText = JSON.stringify({ loopId: id, status: "no_active_linked_execution_observed" });
    await session.observeToolConstruction(c);
    const event = emitted(c);
    if (kind === "changed_emitted_text") event.output = "runtime fields withheld";
    await session.observeToolResult(event);
    expect((await finish(session)).outcome).toBe("unknown");
  });

  it("rejects a self-declared complete delegated receipt whose actual outer text was truncated", async () => {
    const { session } = setup(), inner = construction({ toolCallId: "ask-1:platform" });
    const outer = construction({ toolCallId: "ask-1", toolName: "askMemory", result: {
      content: [{ type: "text", text: JSON.stringify({ observations: [{ tool: "platformRecall", status: "retrieved", truncated: true, evidence: "short excerpt" }] }) }],
      details: { delegatedReceipts: [{ toolCallId: inner.toolCallId, toolName: inner.toolName, result: inner.result,
        trace: inner.trace, modelText: inner.modelText, deliveredComplete: true }] },
    } });
    await session.observeToolConstruction(inner); await session.observeToolConstruction(outer);
    await session.observeToolResult(emitted(outer));
    expect((await finish(session)).outcome).toBe("unknown");
    expect(session.snapshot().gaps).toContain("delegated_result_not_fully_visible");
  });

  it.each(["complete", "whole_structured", "outer_truncated", "withheld"])("joins actual guarded formatter and memory access for %s", async (variant) => {
    const { session, auditSink } = setup(), sample = construction();
    const runtime = { ...(sample.result as any).runtime,
      ...(variant === "complete" ? {} : { warning: variant === "outer_truncated" ? "\\".repeat(7000) : "x".repeat(variant === "withheld" ? 25000 : 13000) }) };
    const [definition] = withMemoryReadBudget([{ name: "platformRecall", description: "read exact runtime",
      parameters: Type.Object({ question: Type.String(), limit: Type.Number() }),
      execute: async () => ({ ok: true, data: { runtimeObservation: runtime }, text: JSON.stringify(runtime) }),
      formatResult: value => (value as any).text,
    }]);
    const reader = createGuardedPiTool({ ...definition, onResultConstructed: receipt => session.observeToolConstruction(receipt) });
    const access = createMemoryAccessTool({ tools: [reader], identity: { kind: "chat" } });
    const outer = createGuardedPiTool({ name: access.name, description: access.description, parameters: access.parameters,
      execute: (params, context) => access.execute(context.toolCallId, params, context.signal),
      formatResult: value => value.content.filter(block => block.type === "text").map(block => (block as { text: string }).text).join("\n"),
      onResultConstructed: receipt => session.observeToolConstruction(receipt),
    });
    const result = await outer.execute("access-1", { question: `Loop ${id} 当前是否运行？`, domains: ["platform"] });
    await session.observeToolResult({ type: "tool_result", toolUseId: "access-1", isError: false,
      output: result.content.filter(block => block.type === "text").map(block => (block as { text: string }).text).join("\n"),
      toolResultDetails: result.details,
    });
    expect((await finish(session)).outcome).toBe(variant === "complete" || variant === "whole_structured" ? "supported_fields" : "unknown");
    const deliveredText = result.content.filter(block => block.type === "text").map(block => (block as { text: string }).text).join("\n");
    expect(deliveredText.length).toBeLessThanOrEqual(24000);
    if (variant === "whole_structured") {
      const packet = JSON.parse(deliveredText);
      expect(packet.observations[0].truncated).toBe(false);
      expect(packet.observations[0].evidence).toBe(JSON.stringify(runtime));
      expect(auditSink.mock.calls.some(([event]) => event.eventKey === "access-1:platform:tool_result_emitted")).toBe(true);
    }
    if (variant === "outer_truncated") {
      expect(JSON.stringify(runtime).length).toBeLessThan(24000);
      expect(JSON.parse(deliveredText).observations[0].evidence).toBe("");
      expect(JSON.parse(deliveredText).observations[0].truncated).toBe(true);
    }
    if (variant === "withheld") expect(auditSink.mock.calls.some(([event]) => event.eventKey.startsWith("access-1:platform:"))).toBe(false);
    if (variant === "outer_truncated") expect(auditSink.mock.calls.some(([event]) => event.eventKey === "access-1:platform:tool_result_emitted")).toBe(false);
  });

  it("does not trust forged active-lease flags without matching observation fields", async () => {
    const { session } = setup(), c = construction();
    (c.result as any).runtime.status = "active_lease_recent_heartbeat";
    c.modelText = JSON.stringify((c.result as any).runtime);
    await session.observeToolConstruction(c); await session.observeToolResult(emitted(c));
    expect((await finish(session)).outcome).toBe("unknown");
  });

  it("retains unknown configuration and executor state without inventing empty fields", async () => {
    const { session } = setup(), c = construction();
    const runtime = (c.result as any).runtime;
    runtime.status = "not_currently_verified";
    runtime.loopConfiguration = { status: "active" };
    c.modelText = JSON.stringify(runtime);
    await session.observeToolConstruction(c); await session.observeToolResult(emitted(c));
    const decision = await finish(session);
    expect(decision.outcome).toBe("partial");
    expect(decision.resolutions.find(item => item.requirementId === "loop_configuration")?.state).toBe("unknown");
    expect(decision.renderedText).toContain("任务配置状态未核实");
    expect(decision.renderedText).toContain("未能核实正在活动的执行器");
    expect(decision.renderedText).toContain("不能证明回答瞬间");
  });

  function linkedConstruction() {
    const c = construction();
    const runtime = (c.result as any).runtime;
    Object.assign(runtime, { status: "not_currently_verified", maximumHeartbeatAgeMs: 120_000,
      observationScope: "linked_execution_and_matching_lease", linkedExecution: {
        workRunStatus: "running", leaseMatchesRun: true, leasePhase: "running", leaseUntil: "2026-10-02T09:59:50.000Z",
        leaseUnexpired: false, heartbeatAt: "2026-10-02T09:59:56.000Z", heartbeatAgeMs: 4_000, heartbeatFresh: true,
      } });
    c.modelText = JSON.stringify(runtime);
    return c;
  }

  it("keeps specifically requested lease and heartbeat facts in committed delivery and separate audit layers", async () => {
    const { session, auditSink } = setup({ question: `核对 Loop ${id} 当前是否在线，并列出租约和心跳观测。` });
    const c = linkedConstruction();
    await session.observeToolConstruction(c); await session.observeToolResult(emitted(c));
    const decision = await finish(session);
    expect(decision.ruleVersion).toBe("exact-loop-observation.v2");
    expect(decision.renderedText).toContain(`数据库于 ${at}`);
    expect(decision.renderedText).toContain("租约在读取时是否未到期：否（读取时已到期）");
    expect(decision.renderedText).toContain("心跳在读取时是否较新：是");
    expect(decision.renderedText).toContain("读取时的心跳年龄（毫秒）：4000");
    expect(decision.renderedText).toContain("不能证明心跳持续更新或进程当前在线");
    expect(decision.renderedText).toContain("未能核实正在活动的执行器");
    expect(decision.resolutions).toHaveLength(10);
    expect(decision.resolutions.every(item => item.state === "supported" && item.presentationIncluded)).toBe(true);
    const saved = auditSink.mock.calls.find(([event]) => event.eventKey === "final_evidence")?.[0].payload;
    expect(saved?.rawDraft).toMatchObject({ text: "执行器已停止", sha256: answerTextHash("执行器已停止") });
    expect(saved?.displayText).toBe(decision.renderedText);
    const receipt = auditSink.mock.calls.find(([event]) => event.eventKey === "read-1:tool_result_emitted")?.[0].payload.receipt as any;
    expect(receipt.facts.find((fact: any) => fact.key === "lease_unexpired")).toMatchObject({ state: "observed", value: false });
  });

  it("identifies lease-to-linked-run mismatch without assigning the other run's heartbeat to this Loop", async () => {
    const { session } = setup({ question: `Loop ${id} 当前的租约与心跳是否匹配？` }), c = linkedConstruction();
    (c.result as any).runtime.linkedExecution.leaseMatchesRun = false;
    c.modelText = JSON.stringify((c.result as any).runtime);
    await session.observeToolConstruction(c); await session.observeToolResult(emitted(c));
    const decision = await finish(session);
    expect(decision.renderedText).toContain("租约与该 Loop 的关联执行记录匹配：否");
    expect(decision.renderedText).toContain("不能归为该 Loop 已核实的执行器心跳");
    expect(decision.renderedText).not.toContain("租约与心跳不匹配");
  });

  it.each(["not_found", "missing_receipt", "stale", "revoked", "audit_failure"])("explicitly answers requested lease and heartbeat unknown on %s", async kind => {
    const { session } = setup({ question: `Loop ${id} 当前执行器租约和心跳能否核实？`,
      ...(kind === "revoked" ? { authorizeFinal: async () => false } : {}),
      ...(kind === "audit_failure" ? { auditSink: async () => { throw Error("offline"); } } : {}) });
    const c = linkedConstruction();
    if (kind === "not_found") (c.result as any).runtime = { provider: "workshop_execution_leases", status: "loop_not_found_in_scope" };
    if (kind === "stale") (c.result as any).runtime.observedAt = "2026-10-02T09:00:00.000Z";
    c.modelText = JSON.stringify((c.result as any).runtime);
    await session.observeToolConstruction(c);
    if (kind !== "missing_receipt") await session.observeToolResult(emitted(c));
    const decision = await finish(session);
    expect(decision.renderedText).toContain("租约在读取时是否未到期：未知（未核实）");
    expect(decision.renderedText).toContain("心跳在读取时是否较新：未知（未核实）");
    expect(decision.renderedText).not.toContain("读取时已到期");
    expect(decision.renderedText).not.toContain("4000");
    expect(decision.evidenceRefs).toEqual([]);
    expect(decision.resolutions).toHaveLength(10);
    expect(decision.resolutions.every(item => item.state === (kind === "revoked" ? "denied" : "unknown") && item.evidenceIds.length === 0)).toBe(true);
  });

  it("does not claim a heartbeat was observed when only a missing mapping was read", async () => {
    const { session } = setup({ question: `Loop ${id} 当前租约和心跳状态是什么？` }), c = construction();
    await session.observeToolConstruction(c); await session.observeToolResult(emitted(c));
    const decision = await finish(session);
    expect(decision.outcome).toBe("partial");
    expect(decision.renderedText).toContain("本次没有评估");
    expect(decision.renderedText).toContain("记录的心跳时间：未知（未核实）");
    expect(decision.renderedText).not.toContain("心跳只表示读取时的单次记录");
  });

  it("retains field-level unknown when a freshness flag conflicts with its timestamp", async () => {
    const { session } = setup({ question: `Loop ${id} 当前心跳状态是否新鲜？` }), c = linkedConstruction();
    (c.result as any).runtime.linkedExecution.heartbeatFresh = false;
    c.modelText = JSON.stringify((c.result as any).runtime);
    await session.observeToolConstruction(c); await session.observeToolResult(emitted(c));
    const decision = await finish(session);
    expect(decision.outcome).toBe("partial");
    expect(decision.resolutions.find(item => item.requirementId === "heartbeat_fresh")?.state).toBe("unknown");
    expect(decision.renderedText).toContain("心跳在读取时是否较新：未知（未核实）");
    expect(decision.renderedText).toContain("读取时的心跳年龄（毫秒）：4000");
  });

  it("keeps a shadow draft intact while auditing the requested-facet candidate separately", async () => {
    const { session } = setup({ mode: "shadow", question: `Loop ${id} 当前租约和心跳是什么状态？` }), c = linkedConstruction();
    await session.observeToolConstruction(c); await session.observeToolResult(emitted(c));
    const decision = await finish(session);
    expect(decision.renderedText).toBe("执行器已停止");
    expect(decision.candidateDisplayText).toContain("读取时已到期");
    expect(decision.resolutions).toHaveLength(10);
    expect(decision.resolutions.every(item => !item.presentationIncluded)).toBe(true);
  });

  it.each(["continuous", "transient"])("preserves a final denial through %s audit failure", async failure => {
    for (const mode of ["enforce_critical", "shadow"] as const) {
      let first = true;
      const saved: AnswerEvidenceAuditEvent[] = [];
      const { session } = setup({ mode, question: `Loop ${id} 当前租约和心跳状态是什么？`,
        authorizeFinal: async () => false, auditSink: async event => {
          if (failure === "continuous" || first) { first = false; throw Error("audit offline"); }
          saved.push(event);
        } });
      const c = linkedConstruction();
      await session.observeToolConstruction(c); await session.observeToolResult(emitted(c));
      const decision = await finish(session);
      expect(decision).toMatchObject({ outcome: "unknown", auditIncomplete: true, auditPersisted: failure === "transient", evidenceRefs: [] });
      expect(decision.resolutions).toHaveLength(10);
      expect(decision.resolutions.every(item => item.state === "denied" && item.evidenceIds.length === 0)).toBe(true);
      expect(decision.resolutions.every(item => item.presentationIncluded === (mode === "enforce_critical"))).toBe(true);
      const display = mode === "shadow" ? decision.candidateDisplayText : decision.renderedText;
      expect(display).toContain("租约在读取时是否未到期：未知");
      expect(display).not.toContain("4000");
      if (failure === "transient") {
        const final = saved.find(event => event.eventKey === "final_evidence_audit_failure");
        expect((final?.payload.resolutions as any[]).every(item => item.state === "denied")).toBe(true);
      }
    }
  });

  it.each(["stale_flag", "wrong_age", "missing_threshold"])("does not assert a recent heartbeat from contradictory active evidence: %s", async kind => {
    const { session } = setup(), c = linkedConstruction(), runtime = (c.result as any).runtime;
    runtime.status = "active_lease_recent_heartbeat";
    runtime.linkedExecution.leaseUntil = "2026-10-02T10:01:00.000Z";
    runtime.linkedExecution.leaseUnexpired = true;
    if (kind === "stale_flag") {
      runtime.linkedExecution.heartbeatAt = "2026-10-02T09:57:59.999Z";
      runtime.linkedExecution.heartbeatAgeMs = 120_001;
    }
    if (kind === "wrong_age") runtime.linkedExecution.heartbeatAgeMs = 0;
    if (kind === "missing_threshold") delete runtime.maximumHeartbeatAgeMs;
    c.modelText = JSON.stringify(runtime);
    await session.observeToolConstruction(c); await session.observeToolResult(emitted(c));
    const decision = await finish(session);
    expect(decision.outcome).toBe("unknown");
    expect(decision.renderedText).not.toContain("观察到匹配的有效租约与近期心跳");
    expect(decision.evidenceRefs).toEqual([]);
  });

  it("accepts a consistent active observation without claiming current process liveness", async () => {
    const { session } = setup({ question: `Loop ${id} 当前租约和心跳状态是什么？` }), c = linkedConstruction(), runtime = (c.result as any).runtime;
    runtime.status = "active_lease_recent_heartbeat";
    runtime.linkedExecution.leaseUntil = "2026-10-02T10:01:00.000Z";
    runtime.linkedExecution.leaseUnexpired = true;
    c.modelText = JSON.stringify(runtime);
    await session.observeToolConstruction(c); await session.observeToolResult(emitted(c));
    const decision = await finish(session);
    expect(decision.outcome).toBe("supported_fields");
    expect(decision.renderedText).toContain("观察到匹配的有效租约与近期心跳");
    expect(decision.renderedText).toContain("不能证明回答瞬间的进程状态");
  });

  it("keeps heartbeat attribution unknown when a partial reader omitted lease matching", async () => {
    const { session } = setup({ question: `Loop ${id} 当前心跳状态是否新鲜？` }), c = linkedConstruction();
    delete (c.result as any).runtime.linkedExecution.leaseMatchesRun;
    c.modelText = JSON.stringify((c.result as any).runtime);
    await session.observeToolConstruction(c); await session.observeToolResult(emitted(c));
    const decision = await finish(session);
    expect(decision.renderedText).toContain("匹配关系未知");
    expect(decision.renderedText).toContain("不能把所列心跳归为该 Loop 已核实的执行器心跳");
  });

  it("finalizes once, with no duplicate audit appends", async () => {
    const { session, auditSink } = setup();
    const [a, b] = await Promise.all([finish(session), finish(session)]);
    expect(a).toBe(b); expect(auditSink.mock.calls.filter(([e]) => e.eventType === "final_evidence")).toHaveLength(1);
  });

  it.each(["read-1:observed_server", "final_evidence", "turn_terminal"])("records only safe unknown and failed after transient audit loss at %s", async (failedKey) => {
    const saved: AnswerEvidenceAuditEvent[] = []; let interrupted = false;
    const auditSink = vi.fn(async (event: AnswerEvidenceAuditEvent) => {
      if (!interrupted && event.eventKey === failedKey) { interrupted = true; throw Error("transient DB failure"); }
      saved.push(event);
    });
    const { session } = setup({ auditSink }), c = construction();
    await session.observeToolConstruction(c); await session.observeToolResult(emitted(c));
    const decision = await finish(session);
    expect(decision).toMatchObject({ outcome: "unknown", auditPersisted: true, auditIncomplete: true, evidenceRefs: [] });
    expect(saved.filter(event => event.eventKey === failedKey)).toHaveLength(0);
    const safeFinal = saved.find(event => event.eventKey === "final_evidence_audit_failure");
    expect(safeFinal?.payload).toMatchObject({ outcome: "unknown", auditIncomplete: true, evidenceRefs: [] });
    expect(safeFinal?.payload.renderedTextHash).toBe(answerTextHash(String(safeFinal?.payload.displayText)));
    expect(saved.find(event => event.eventKey === "turn_terminal_audit_failure")).toMatchObject({ eventType: "turn_failed",
      payload: { auditIncomplete: true, terminal: { status: "failed", runtimeStatus: "completed", completionScope: "answer_delivery" } } });
    expect(saved.some(event => event.eventType === "turn_completed")).toBe(false);
  });

  it("keeps a continuous audit outage explicit without claiming a saved terminal", async () => {
    const auditSink = vi.fn(async (_event: AnswerEvidenceAuditEvent) => { throw Error("DB offline"); });
    const { session } = setup({ auditSink }); const c = construction();
    await session.observeToolConstruction(c); await session.observeToolResult(emitted(c));
    const decision = await finish(session);
    expect(decision).toMatchObject({ outcome: "unknown", auditPersisted: false, auditIncomplete: true, evidenceRefs: [] });
    expect(auditSink.mock.calls.some(([event]) => event.eventKey === "final_evidence_audit_failure")).toBe(true);
    expect(auditSink.mock.calls.some(([event]) => event.eventType === "turn_completed")).toBe(false);
  });

  it("keeps shadow draft unchanged and does not claim safe unknown clauses were displayed after audit loss", async () => {
    let failOnce = true;
    const { session } = setup({ mode: "shadow", auditSink: async () => {
      if (failOnce) { failOnce = false; throw Error("transient DB failure"); }
    } });
    const c = construction(); await session.observeToolConstruction(c); await session.observeToolResult(emitted(c));
    const decision = await finish(session);
    expect(decision).toMatchObject({ outcome: "unknown", auditIncomplete: true, auditPersisted: true,
      renderedText: "执行器已停止", renderedTextHash: answerTextHash("执行器已停止") });
    expect(decision.candidateDisplayText).toContain("核验审计未能保存");
    expect(decision.resolutions.every(item => item.state === "unknown" && !item.presentationIncluded)).toBe(true);
  });

  it("does not overwrite a sealed completed turn when its acknowledgement was lost", async () => {
    const saved: AnswerEvidenceAuditEvent[] = []; let sealed = false;
    const auditSink = vi.fn(async (event: AnswerEvidenceAuditEvent) => {
      if (sealed) throw Error("turn sealed");
      saved.push(event);
      if (event.eventType === "turn_completed") { sealed = true; throw Error("acknowledgement lost"); }
    });
    const { session } = setup({ auditSink }), c = construction();
    await session.observeToolConstruction(c); await session.observeToolResult(emitted(c));
    const decision = await finish(session);
    expect(decision).toMatchObject({ outcome: "unknown", auditPersisted: false, auditIncomplete: true });
    expect(saved.filter(event => event.eventType.startsWith("turn_"))).toHaveLength(1);
    expect(saved.at(-1)?.eventType).toBe("turn_completed");
    expect(saved.find(event => event.eventKey === "final_evidence")?.payload.outcome).toBe("supported_fields");
  });
});

describe("exact Loop stream gate", () => {
  it("persists a safe terminal on consumer return without another pull, after upstream cleanup", async () => {
    const { session, auditSink } = setup();
    let allowCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => { allowCleanup = resolve; });
    let cleanupStarted = false, cleanupCompleted = false;
    async function* source(): AsyncGenerator<AgentMessage> {
      try {
        yield { type: "text", content: "raw candidate" };
        yield { type: "tool_use", id: "read", name: "platformRecall" };
        yield { type: "runtime_terminal", runtimeTerminal: terminal };
      } finally {
        cleanupStarted = true; await cleanup; cleanupCompleted = true;
      }
    }
    const gate = guardExactLoopAnswer(source(), session);
    expect((await gate.next()).value?.type).toBe("tool_use");
    const closing = gate.return(undefined as never);
    await Promise.resolve(); await Promise.resolve();
    expect(cleanupStarted).toBe(true);
    expect(auditSink.mock.calls.some(([event]) => event.eventKey === "turn_terminal")).toBe(false);
    allowCleanup(); await closing;
    expect(cleanupCompleted).toBe(true);
    const savedTerminal = auditSink.mock.calls.find(([event]) => event.eventKey === "turn_terminal")?.[0];
    expect(savedTerminal?.eventType).toBe("turn_failed");
    expect(savedTerminal?.payload.terminal).toMatchObject({ status: "failed", cleanupStatus: "failed", completionScope: "answer_delivery" });
    expect((savedTerminal?.payload.terminal as any)?.error).toContain("cleanup completion is unknown");
    expect(session.snapshot().decision?.rawDraftHash).toBe(answerTextHash("raw candidate"));
    expect(session.snapshot().decision?.evidenceRefs).toEqual([]);
    await gate.return(undefined as never);
    expect(auditSink.mock.calls.filter(([event]) => event.eventKey === "turn_terminal")).toHaveLength(1);
  });

  it("audits delivery failure if the consumer disconnects while forwarding an observed runtime terminal in shadow", async () => {
    const { session, auditSink } = setup({ mode: "shadow" });
    const gate = guardExactLoopAnswer(stream([{ type: "runtime_terminal", runtimeTerminal: terminal }, { type: "done" }]), session);
    await gate.next(); await gate.return(undefined as never);
    expect(auditSink.mock.calls.find(([event]) => event.eventKey === "turn_terminal")?.[0].payload.terminal).toMatchObject({
      status: "failed", runtimeStatus: "completed", cleanupStatus: "completed", completionScope: "answer_delivery",
    });
    expect(session.snapshot().decision?.outcome).toBe("execution_failed");
  });

  it.each(["off", "unsupported"])("preserves the legacy stream for %s", async (mode) => {
    const { session } = setup(mode === "off" ? { mode: "off" } : { question: "Explain architecture" });
    const input: AgentMessage[] = [{ type: "text", content: "original" }, { type: "done" }];
    const output = await collect(guardExactLoopAnswer(stream(input), session));
    expect(output).toEqual(input);
  });
  it("audits shadow mode without changing model output", async () => {
    const { session, auditSink } = setup({ mode: "shadow" });
    const input: AgentMessage[] = [{ type: "text", content: "original" }, { type: "runtime_terminal", runtimeTerminal: terminal }, { type: "done" }];
    const output = await collect(guardExactLoopAnswer(stream(input), session));
    expect(output.filter(e => e.type !== "answer_evidence")).toEqual(input);
    expect(output.at(-2)?.type).toBe("answer_evidence");
    expect(output.at(-2)?.answerEvidence).toMatchObject({ mode: "shadow", displayText: "original", renderedTextHash: answerTextHash("original") });
    expect(auditSink.mock.calls.some(([e]) => e.eventType === "final_evidence")).toBe(true);
    expect(auditSink.mock.calls.find(([e]) => e.eventType === "final_evidence")?.[0].payload).toMatchObject({
      mode: "shadow", displayText: "original", renderedTextHash: answerTextHash("original"),
    });
  });
  it.each(["missing_terminal", "error_then_done", "cleanup_failed"])("never commits a successful model answer on %s", async (kind) => {
    const { session } = setup();
    const input: AgentMessage[] = [{ type: "text", content: "Loop 已停止" }];
    if (kind !== "missing_terminal") input.push({ type: "runtime_terminal", runtimeTerminal: kind === "cleanup_failed" ? { ...terminal, cleanupStatus: "failed" } : terminal });
    if (kind === "error_then_done") input.push({ type: "error", message: "terminated" });
    input.push({ type: "done" });
    const output = await collect(guardExactLoopAnswer(stream(input), session));
    expect(output.find(e => e.type === "answer_evidence")?.answerEvidence?.outcome).toBe("execution_failed");
    expect(output.some(e => e.content === "Loop 已停止")).toBe(false);
    expect(output.find(e => e.type === "runtime_terminal")?.runtimeTerminal?.status).toBe("failed");
    expect(output.at(-1)?.type).toBe("done");
  });
  it("fails answer delivery when audit commit fails without hiding actual runtime completion", async () => {
    const { session } = setup({ auditSink: async () => { throw Error("DB unavailable"); } });
    const output = await collect(guardExactLoopAnswer(stream([{ type: "text", content: "Loop 已停止" },
      { type: "runtime_terminal", runtimeTerminal: terminal }, { type: "done" }]), session));
    expect(output.find(e => e.type === "answer_evidence")?.answerEvidence?.auditPersisted).toBe(false);
    expect(output.find(e => e.type === "runtime_terminal")?.runtimeTerminal).toMatchObject({
      status: "failed", runtimeStatus: "completed", completionScope: "answer_delivery",
    });
    expect(output.find(e => e.type === "text")?.content).toContain("审计未能保存");
  });
  it("keeps tools visible, suppresses reasoning and avoids hashing text twice", async () => {
    const { session, auditSink } = setup(), c = construction(); await session.observeToolConstruction(c);
    const output = await collect(guardExactLoopAnswer(stream([{ type: "reasoning", content: "stopped" }, { type: "text", content: "draft" },
      { type: "result", content: "draft", answerPhase: "candidate_final" }, emitted(c), { type: "runtime_terminal", runtimeTerminal: terminal }, { type: "done" }]), session));
    expect(output.some(e => e.type === "reasoning")).toBe(false);
    expect(output.some(e => e.type === "tool_result")).toBe(true);
    expect(output.find(e => e.type === "text")?.content).toContain("没有评估");
    const final = auditSink.mock.calls.find(([e]) => e.eventType === "final_evidence")?.[0];
    expect(final?.payload.rawDraftHash).toBe(answerTextHash("draft"));
  });
});
