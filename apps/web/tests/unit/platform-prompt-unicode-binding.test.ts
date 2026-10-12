import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createPiAgentRuntime } from "@openzhiyu/ai/agent/runtime";
import type { AnswerEvidenceAuditEvent, ToolConstruction } from "@/lib/ai/runtime/answer-evidence-contract";
import { answerTextHash, createAnswerEvidenceCore } from "@/lib/ai/runtime/answer-evidence-core";
import { createGuardedPiTool } from "@/lib/ai/runtime/pi-tool-adapter";

const at = "2026-10-04T01:00:00.000Z";
const ordinaryResult = { ok: true, value: "ordinary-json-result" };
const jsonStringHash = (text: string) => createHash("sha256").update(JSON.stringify(text)).digest("hex");
afterEach(() => { vi.unstubAllGlobals(); });

function setup() {
  const events: AnswerEvidenceAuditEvent[] = [];
  const core = createAnswerEvidenceCore({ mode: "enforce_supported", supported: true, turnId: "unicode-binding-turn",
    project: (input: ToolConstruction) => ({ evidenceId: input.toolCallId, delivery: "result_constructed" as const,
      observation: { kind: "live" as const, observedAt: at } }),
    auditSink: async event => { events.push(event); } });
  return { core, events };
}

function construction(modelText = JSON.stringify(ordinaryResult)): ToolConstruction {
  return { toolCallId: "unicode-read", toolName: "platformRecall", params: {}, result: ordinaryResult, modelText,
    trace: { type: "tool_result", title: "completed", detail: null, toolName: "platformRecall", toolUseId: "unicode-read",
      status: "completed", timestamp: at, durationMs: 1,
      metadata: { decision: "allow", reason: "allowed", matchedRule: "platformRecall", deniedBeforeHandler: false } } };
}

async function commitActualUserEntry(prompt: string, callback: (input: { entryId: string; modelText: string }) => Promise<void>) {
  const transport = vi.fn(() => { throw Error("external transport forbidden"); });
  vi.stubGlobal("fetch", transport);
  const faux = createFauxCore({});
  faux.setResponses([fauxAssistantMessage("done")]);
  const runtime = createPiAgentRuntime({ adapter: "harness", model: faux.getModel(), streamFn: faux.streamSimple, tools: [] });
  let receipt: { entryId: string; modelText: string } | undefined;
  for await (const _event of runtime.run({ operation: "run", prompt, options: {
    onPromptContextCommitted: async input => { receipt = input; await callback(input); },
  } })) { /* The actual local SDK emits entry_added. No provider transport runs. */ }
  expect(transport).not.toHaveBeenCalled();
  expect(receipt).toBeDefined();
  expect(receipt?.entryId).toBeTruthy();
  expect(receipt?.modelText).toBe(prompt);
  return receipt!;
}

describe("exact Unicode binding of host evidence to SDK context", () => {
  it("rejects a real SDK prompt entry with a changed lone surrogate despite the same legacy UTF8 hash", async () => {
    const { core, events } = setup(), c = construction();
    // The construction is ordinary valid JSON. Only the user prompt prefix differs.
    expect(JSON.parse(c.modelText!)).toEqual(ordinaryResult);
    const prefix = "\uD800\n", changedPrefix = "\uD801\n";
    const registered = prefix + c.modelText + "\nend", changed = changedPrefix + c.modelText + "\nend";
    expect(registered).not.toBe(changed);
    expect(answerTextHash(registered)).toBe(answerTextHash(changed));
    expect(jsonStringHash(registered)).not.toBe(jsonStringHash(changed));
    expect(changed.slice(prefix.length, prefix.length + c.modelText!.length)).toBe(c.modelText);
    await core.observeToolConstruction(c);
    await core.bindPromptEvidence({ toolCallId: c.toolCallId, prompt: registered, modelText: c.modelText!, offsetUtf16: prefix.length });
    await commitActualUserEntry(changed, core.observePromptContextCommitted);
    expect(core.snapshot().contextReceiptCount).toBe(0);
    expect(events.filter(event => event.eventType === "context_committed")).toHaveLength(0);
  });

  it("does not emit a result when its exact model text differs despite the same legacy UTF8 hash", async () => {
    const { core } = setup();
    const text = JSON.stringify(ordinaryResult) + "\n\uD800", changed = JSON.stringify(ordinaryResult) + "\n\uD801";
    expect(text).not.toBe(changed); expect(answerTextHash(text)).toBe(answerTextHash(changed));
    const c = construction(text);
    await core.observeToolConstruction(c);
    await core.observeToolResult({ type: "tool_result", toolUseId: c.toolCallId, output: changed,
      toolResultDetails: { result: c.result, trace: c.trace } });
    expect(core.snapshot().receiptCount).toBe(0);
  });

  it("does not commit a tool context when its exact model text differs despite the same legacy UTF8 hash", async () => {
    const { core, events } = setup();
    const text = JSON.stringify(ordinaryResult) + "\n\uD800", changed = JSON.stringify(ordinaryResult) + "\n\uD801";
    expect(text).not.toBe(changed); expect(answerTextHash(text)).toBe(answerTextHash(changed));
    const c = construction(text);
    await core.observeToolConstruction(c);
    await core.observeContextCommitted({ toolCallId: c.toolCallId, entryId: "sdk-tool-entry", modelText: changed });
    expect(core.snapshot().contextReceiptCount).toBe(0);
    expect(events.filter(event => event.eventType === "context_committed")).toHaveLength(0);
  });

  it("commits exact Chinese and emoji prompt text from a real SDK entry only once", async () => {
    const { core, events } = setup(), c = construction();
    const prefix = "\u4E2D\u6587\uD83D\uDE42\n", prompt = prefix + c.modelText + "\n\u7ED3\u5C3E";
    await core.observeToolConstruction(c);
    await core.bindPromptEvidence({ toolCallId: c.toolCallId, prompt, modelText: c.modelText!, offsetUtf16: prefix.length });
    const entry = await commitActualUserEntry(prompt, core.observePromptContextCommitted);
    await core.observePromptContextCommitted(entry);
    await core.observePromptContextCommitted({ ...entry, entryId: "duplicate-exact-entry" });
    expect(core.snapshot().contextReceiptCount).toBe(1);
    expect(events.filter(event => event.eventType === "context_committed")).toHaveLength(1);
    expect(events.find(event => event.eventType === "context_committed")?.payload).toMatchObject({
      source: "sdk_prompt_entry", entryId: entry.entryId,
    });
  });

  it("accepts an unchanged lone surrogate prompt when the actual SDK entry is exactly the registered text", async () => {
    const { core } = setup(), c = construction();
    const prefix = "\uD800\n", prompt = prefix + c.modelText;
    await core.observeToolConstruction(c);
    await core.bindPromptEvidence({ toolCallId: c.toolCallId, prompt, modelText: c.modelText!, offsetUtf16: prefix.length });
    await commitActualUserEntry(prompt, core.observePromptContextCommitted);
    expect(core.snapshot().contextReceiptCount).toBe(1);
  });

  it("declares JSON string UTF8 encoding on prompt bindings and commits without changing the general text hash", async () => {
    const { core, events } = setup(), c = construction();
    const prefix = "\u4E2D\u6587\uD83D\uDE42\n", prompt = prefix + c.modelText;
    await core.observeToolConstruction(c);
    await core.bindPromptEvidence({ toolCallId: c.toolCallId, prompt, modelText: c.modelText!, offsetUtf16: prefix.length });
    await commitActualUserEntry(prompt, core.observePromptContextCommitted);
    for (const type of ["prompt_evidence_embedded", "context_committed"]) {
      expect(events.find(event => event.eventType === type)?.payload).toMatchObject({
        promptHashEncoding: "json_string_utf8", promptHash: jsonStringHash(prompt), modelTextHash: answerTextHash(c.modelText!),
      });
    }
    expect(answerTextHash("\uD800")).toBe(answerTextHash("\uD801"));
  });

  it("commits the exact text of a real SDK tool result once and preserves its emission", async () => {
    const { core, events } = setup();
    const transport = vi.fn(() => { throw Error("external transport forbidden"); }); vi.stubGlobal("fetch", transport);
    const result = { ok: true, value: "\u4E2D\u6587\uD83D\uDE42" };
    const tool = createGuardedPiTool({ name: "platformRecall", description: "local Unicode fixture", parameters: Type.Object({}),
      execute: () => result, formatResult: JSON.stringify, onResultConstructed: core.observeToolConstruction });
    const faux = createFauxCore({});
    faux.setResponses([fauxAssistantMessage(fauxToolCall("platformRecall", {}), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
    const runtime = createPiAgentRuntime({ adapter: "harness", model: faux.getModel(), streamFn: faux.streamSimple, tools: [tool] });
    let entry: { toolCallId: string; entryId: string; modelText: string } | undefined;
    for await (const event of runtime.run({ operation: "run", prompt: "local test", options: {
      onToolContextCommitted: async input => { entry = input; await core.observeContextCommitted(input); },
    } })) await core.observeToolResult(event);
    expect(entry).toBeDefined(); expect(entry?.modelText).toBe(JSON.stringify(result));
    await core.observeContextCommitted(entry!);
    await core.observeContextCommitted({ ...entry!, entryId: "duplicate-exact-tool-entry" });
    expect(core.snapshot()).toMatchObject({ receiptCount: 1, contextReceiptCount: 1 });
    expect(events.filter(event => event.eventType === "context_committed")).toHaveLength(1);
    expect(events.find(event => event.eventType === "context_committed")?.payload.source).toBe("sdk_tool_result_entry");
    expect(transport).not.toHaveBeenCalled();
  });
});
