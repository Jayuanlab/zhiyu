import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createPiAgentRuntime } from "@openzhiyu/ai/agent/runtime";
import type { AnswerEvidenceAuditEvent, ToolConstruction } from "@/lib/ai/runtime/answer-evidence-contract";
import { createAnswerEvidenceCore, type PromptEvidenceEmbedding } from "@/lib/ai/runtime/answer-evidence-core";
import { createPlatformAnswerSession } from "@/lib/ai/runtime/platform-answer-session";
import { createGuardedPiTool } from "@/lib/ai/runtime/pi-tool-adapter";
import { prefetchPlatformWithJev } from "@/lib/ai/jev-platform-prefetch";

const at = "2026-10-04T01:00:00.000Z", id = "11111111-1111-4111-8111-111111111111";
const terminal = { schemaVersion: "agent-runtime-terminal.v1" as const, status: "completed" as const, cleanupStatus: "completed" as const };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function construction(callId = "read-1"): ToolConstruction {
  const result = { ok: true, value: "原文🙂\n[End tool evidence]" };
  return { toolCallId: callId, toolName: "platformRecall", params: {}, result, modelText: JSON.stringify(result),
    trace: { type: "tool_result", title: "completed", detail: null, toolName: "platformRecall", toolUseId: callId,
      status: "completed", timestamp: at, durationMs: 1,
      metadata: { decision: "allow", reason: "allowed", matchedRule: "platformRecall", deniedBeforeHandler: false } } };
}
function setup() {
  const events: AnswerEvidenceAuditEvent[] = [];
  const core = createAnswerEvidenceCore({ mode: "enforce_supported", supported: true, turnId: "turn",
    project: (input: ToolConstruction) => ({ evidenceId: input.toolCallId, delivery: "result_constructed" as const,
      observation: { kind: "live" as const, observedAt: at } }),
    auditSink: async event => { events.push(event); } });
  return { core, events };
}
function binding(c: ToolConstruction): PromptEvidenceEmbedding {
  const prefix = "用户🙂\n", modelText = c.modelText!;
  return { toolCallId: c.toolCallId, prompt: prefix + modelText + "\n结尾", modelText, offsetUtf16: prefix.length };
}

describe("host prompt evidence and actual SDK commitment", () => {
  it("keeps construction, embedding, emission and SDK commitment distinct", async () => {
    const { core, events } = setup(), c = construction(), b = binding(c);
    await core.observeToolConstruction(c); await core.bindPromptEvidence(b);
    expect(core.snapshot()).toMatchObject({ receiptCount: 0, contextReceiptCount: 0 });
    await core.observePromptContextCommitted({ entryId: "sdk-user-entry", modelText: b.prompt });
    expect(core.snapshot()).toMatchObject({ receiptCount: 0, contextReceiptCount: 1 });
    await core.observeToolResult({ type: "tool_result", toolUseId: c.toolCallId, output: c.modelText,
      toolResultDetails: { result: c.result, trace: c.trace } });
    await core.observePromptContextCommitted({ entryId: "sdk-user-entry", modelText: b.prompt });
    expect(core.snapshot()).toMatchObject({ receiptCount: 1, contextReceiptCount: 1 });
    expect(events.filter(event => event.eventType === "context_committed")).toHaveLength(1);
    expect(events.find(event => event.eventType === "context_committed")?.payload).toMatchObject({ source: "sdk_prompt_entry", entryId: "sdk-user-entry" });
    expect(JSON.stringify(events)).not.toContain(b.prompt);
    expect(JSON.stringify(events)).not.toContain(c.modelText);
  });
  it.each(["changed_prefix", "partial_text", "wrong_offset", "wrong_result", "no_construction", "no_embedding", "other_turn"])("rejects %s as SDK commitment", async variant => {
    const { core } = setup(), c = construction(), b = binding(c);
    if (variant !== "no_construction") await core.observeToolConstruction(c);
    if (variant !== "no_embedding") await core.bindPromptEvidence({ ...b,
      ...(variant === "wrong_offset" ? { offsetUtf16: 0 } : {}),
      ...(variant === "wrong_result" ? { modelText: "forged" } : {}) });
    const observed = variant === "other_turn" ? setup().core : core;
    await observed.observePromptContextCommitted({ entryId: "sdk-user-entry", modelText: variant === "changed_prefix"
      ? "changed" + b.prompt : variant === "partial_text" ? b.modelText : b.prompt });
    expect(observed.snapshot().contextReceiptCount).toBe(0);
  });
  it("bounds host prompt registrations and reports omitted bindings", async () => {
    const { core } = setup();
    for (let n = 0; n < 5; n++) { const c = construction(`read-${n}`); await core.observeToolConstruction(c); await core.bindPromptEvidence(binding(c)); }
    expect(core.snapshot().gaps).toContain("prompt_embedding_limit_exceeded");
  });
  it.each(["complete", "tampered", "missing_callback", "audit_failed"])("uses the real prefetch and SDK chain: %s", async variant => {
    vi.stubEnv("BRAIN_JEV_ROUTING", "replace"); vi.stubEnv("TYPESAFE_API_KEY", "test");
    const fetch = vi.fn(() => { throw Error("external transport forbidden"); }); vi.stubGlobal("fetch", fetch);
    const events: AnswerEvidenceAuditEvent[] = [];
    const session = createPlatformAnswerSession({ mode: "enforce_supported", turnId: "turn", ownerId: "owner",
      runtimeHash: "runtime", policyHash: "policy", question: `loops ${id} 的状态是什么？`, now: () => new Date(at),
      authorizeFinal: async () => true, auditSink: async event => {
        if (variant === "audit_failed" && event.eventType === "context_committed") throw Error("audit unavailable");
        events.push(event);
      } });
    const result = { ok: true, data: { records: { observedAt: at, records: [{ source: "loops", id,
      fields: { id, status: "active" }, fieldAvailability: { id: "shown", status: "shown" } }] } } };
    const execute = vi.fn(() => result);
    const tool = createGuardedPiTool({ name: "platformRecall", description: "owner-bound local read", parameters: Type.Object({}),
      execute, onResultConstructed: receipt => session.observeToolConstruction(receipt) });
    const embeddings: PromptEvidenceEmbedding[] = [];
    const generator = prefetchPlatformWithJev({ question: session.plan!.question, prompt: "用户🙂\n原问题", tools: [tool],
      onEvidenceEmbedded: async item => { embeddings.push(item); await session.bindPromptEvidence(item); } },
      async () => ({ status: "ok", route: "records", sources: ["records"], elapsedMs: 1 }));
    let prompt = "";
    while (true) { const item = await generator.next(); if (item.done) { prompt = item.value; break; } await session.observeToolResult(item.value); }
    expect(execute).toHaveBeenCalledOnce(); expect(embeddings).toHaveLength(1);
    expect(prompt.slice(embeddings[0].offsetUtf16, embeddings[0].offsetUtf16 + embeddings[0].modelText.length)).toBe(embeddings[0].modelText);
    expect(session.snapshot()).toMatchObject({ receiptCount: 1, contextReceiptCount: 0 });
    const faux = createFauxCore({}); faux.setResponses([fauxAssistantMessage("status active")]);
    const runtime = createPiAgentRuntime({ adapter: "harness", model: faux.getModel(), streamFn: faux.streamSimple, tools: [] });
    for await (const _event of runtime.run({ operation: "run", prompt: variant === "tampered" ? "changed" + prompt : prompt,
      options: variant === "missing_callback" ? {} : { onPromptContextCommitted: session.observePromptContextCommitted } })) { /* SDK performs the commit. */ }
    const decision = await session.finalize({ terminal, rawDraft: "status active" });
    if (variant === "complete") {
      expect(session.snapshot().contextReceiptCount).toBe(1);
      expect(decision.evidenceCoverage.supported).toBeGreaterThan(0);
      expect(decision.resolutions.find(item => item.requirementId === "loops.status")?.state).toBe("supported");
    } else {
      if (variant === "audit_failed") {
        expect(decision.questionComplete).toBe(false); expect(decision.auditIncomplete).toBe(true);
      } else {
        expect(session.snapshot().contextReceiptCount).toBe(0);
        // Host-rendered complete fields remain supported. This does not grant
        // SDK context or a continuation based on evidence the SDK did not commit.
        expect(decision.resolutions.find(item => item.requirementId === "loops.status")?.state).toBe("supported");
      }
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(events.filter(event => event.eventType === "prompt_evidence_embedded" || event.eventType === "context_committed"))).not.toContain(prompt);
  });
});
