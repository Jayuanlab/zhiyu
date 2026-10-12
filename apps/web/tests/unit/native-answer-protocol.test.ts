import { afterEach, describe, expect, it, vi } from "vitest";
import { streamNativeAgentResponse } from "@/lib/ai/router/index";

const ids = { chatId: "11111111-1111-4111-8111-111111111111", clientRequestId: "request-once",
  userMessageId: "22222222-2222-4222-8222-222222222222", assistantMessageId: "33333333-3333-4333-8333-333333333333" };
const turnId = "44444444-4444-4444-8444-444444444444";
const terminal = { schemaVersion: "agent-runtime-terminal.v1", status: "completed", cleanupStatus: "completed" };
function sse(events: unknown[], audited = true) {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream", ...(audited ? { "x-answer-evidence-protocol": "v1" } : {}) },
  });
}
afterEach(() => vi.restoreAllMocks());

describe("native answer commit protocol", () => {
  it("does not turn intermediate result and EOF into audited completion", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sse([{ type: "result", content: "draft" }, { type: "done" }]));
    const onDone = vi.fn();
    const error = await new Promise<Error>(resolve => {
      void streamNativeAgentResponse("state", { ...ids, onDone, onError: resolve });
    });
    expect(onDone).not.toHaveBeenCalled();
    expect((error as any).isRetryable).toBe(false);
  });
  it("waits for a replayed active turn without starting another model", async () => {
    const binding = { turnId, chatId: ids.chatId, assistantMessageId: ids.assistantMessageId };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ...binding, status: "running" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ...binding, status: "completed", runtimeTerminal: terminal, finalText: "bounded observation" }));
    const updates: any[] = [];
    await new Promise<void>((resolve, reject) => {
      void streamNativeAgentResponse("state", { ...ids, onUpdate: event => updates.push(event), onDone: resolve, onError: reject });
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/native/answer-audits/${turnId}`);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject(ids);
    expect(updates.some(event => event.type === "runtime_terminal")).toBe(true);
    expect(updates.find(event => event.type === "text")?.content).toBe("bounded observation");
  });
  it("refuses a cached turn for another assistant message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ turnId, chatId: ids.chatId, assistantMessageId: ids.userMessageId, status: "completed", runtimeTerminal: terminal }));
    const onDone = vi.fn();
    await new Promise<Error>(resolve => { void streamNativeAgentResponse("state", { ...ids, onDone, onError: resolve }); });
    expect(onDone).not.toHaveBeenCalled();
  });
  it("accepts audited completion only with the runtime terminal and stream end", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sse([{ type: "runtime_terminal", runtimeTerminal: terminal }, { type: "done" }]));
    await new Promise<void>((resolve, reject) => { void streamNativeAgentResponse("state", { ...ids, onDone: resolve, onError: reject }); });
  });
});
