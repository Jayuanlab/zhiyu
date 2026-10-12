import { describe, expect, it, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createPiAgentRuntime } from "@openzhiyu/ai/agent/runtime";
import { createGuardedPiTool } from "@/lib/ai/runtime/pi-tool-adapter";

describe("SDK transcript commit receipts", () => {
  it("commits the exact initial user prompt before the first forward", async () => {
    const faux = createFauxCore({});
    const prompt = "预读🙂\n[End tool evidence]\n原文";
    const order: string[] = [];
    const committed = vi.fn(async (receipt: { entryId: string; modelText: string }) => {
      expect(receipt.entryId).toBeTruthy(); expect(receipt.modelText).toBe(prompt); order.push("committed");
    });
    const streamFn = vi.fn<StreamFn>(async (...args) => {
      order.push("forward"); expect(committed).toHaveBeenCalledOnce();
      expect(args[1].messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: prompt }] });
      return faux.streamSimple(...args);
    });
    faux.setResponses([fauxAssistantMessage("final")]);
    const runtime = createPiAgentRuntime({ adapter: "harness", model: faux.getModel(), streamFn, tools: [] });
    const events = [];
    for await (const event of runtime.run({ operation: "run", prompt, options: { onPromptContextCommitted: committed } })) events.push(event);
    expect(order).toEqual(["committed", "forward"]);
    expect(committed).toHaveBeenCalledOnce();
    expect(events.find(event => event.type === "runtime_terminal")?.runtimeTerminal?.status).toBe("completed");
  });
  it("does not forward when the initial prompt commit callback rejects", async () => {
    const faux = createFauxCore({});
    const streamFn = vi.fn<StreamFn>(faux.streamSimple);
    const runtime = createPiAgentRuntime({ adapter: "harness", model: faux.getModel(), streamFn, tools: [] });
    const events = [];
    for await (const event of runtime.run({ operation: "run", prompt: "read", options: {
      onPromptContextCommitted: async () => { throw Error("prompt audit unavailable"); },
    } })) events.push(event);
    expect(streamFn).not.toHaveBeenCalled();
    expect(events.some(event => event.type === "error")).toBe(true);
    expect(events.find(event => event.type === "runtime_terminal")?.runtimeTerminal?.status).toBe("failed");
  });
  it("records exact text after host construction and before the next model request", async () => {
    const faux = createFauxCore({});
    const order: string[] = [];
    let committedText = "";
    const streamFn = vi.fn<StreamFn>(async (...args) => {
      if (streamFn.mock.calls.length === 2) {
        order.push("next_forward");
        expect(committedText).toBe('{"value":"actual-field"}');
        expect(JSON.stringify(args[1].messages)).toContain("actual-field");
      }
      return faux.streamSimple(...args);
    });
    const tool = createGuardedPiTool({ name: "observe", description: "local read", parameters: Type.Object({}),
      execute: () => ({ value: "actual-field" }), formatResult: JSON.stringify,
      onResultConstructed: () => { order.push("constructed"); } });
    const runtime = createPiAgentRuntime({ adapter: "harness", model: faux.getModel(), streamFn, tools: [tool] });
    faux.setResponses([fauxAssistantMessage(fauxToolCall("observe", {}), { stopReason: "toolUse" }), fauxAssistantMessage("final")]);
    const committed = vi.fn(async (receipt: { toolCallId: string; entryId: string; modelText: string }) => {
      order.push("context_committed"); committedText = receipt.modelText;
      expect(receipt.entryId).toBeTruthy(); expect(receipt.toolCallId).toBeTruthy();
    });
    const messages = [];
    for await (const event of runtime.run({ operation: "run", prompt: "read", options: { onToolContextCommitted: committed } })) messages.push(event);
    expect(committed).toHaveBeenCalledOnce();
    expect(order).toEqual(["constructed", "context_committed", "next_forward"]);
    expect(messages.find(event => event.type === "runtime_terminal")?.runtimeTerminal?.status).toBe("completed");
  });
  it("does not require the outer stream consumer to receive a queued tool result", async () => {
    const faux = createFauxCore({});
    const tool = createGuardedPiTool({ name: "observe", description: "local read", parameters: Type.Object({}), execute: () => "receipt" });
    const runtime = createPiAgentRuntime({ adapter: "harness", model: faux.getModel(), streamFn: faux.streamSimple, tools: [tool] });
    faux.setResponses([fauxAssistantMessage(fauxToolCall("observe", {}), { stopReason: "toolUse" }), fauxAssistantMessage("final")]);
    let resolveCommit!: () => void;
    const committed = new Promise<void>(resolve => { resolveCommit = resolve; });
    const source = runtime.run({ operation: "run", prompt: "read", options: { onToolContextCommitted: async () => { resolveCommit(); } } });
    await source.next();
    await committed;
    await source.return(undefined);
  });
  it("fails the run when a host commit callback fails instead of silently signing success", async () => {
    const faux = createFauxCore({});
    const tool = createGuardedPiTool({ name: "observe", description: "local read", parameters: Type.Object({}), execute: () => "receipt" });
    const runtime = createPiAgentRuntime({ adapter: "harness", model: faux.getModel(), streamFn: faux.streamSimple, tools: [tool] });
    faux.setResponses([fauxAssistantMessage(fauxToolCall("observe", {}), { stopReason: "toolUse" }), fauxAssistantMessage("final")]);
    const messages = [];
    for await (const event of runtime.run({ operation: "run", prompt: "read", options: { onToolContextCommitted: async () => { throw Error("audit unavailable"); } } })) messages.push(event);
    expect(messages.some(event => event.type === "error")).toBe(true);
    expect(messages.find(event => event.type === "runtime_terminal")?.runtimeTerminal?.status).not.toBe("completed");
  });
});
