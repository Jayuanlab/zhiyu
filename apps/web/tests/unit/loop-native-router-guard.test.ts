import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseNativeAgentErrorResponse,
  streamNativeAgentResponse,
} from "@/lib/ai/router/index";

function createSseResponse() {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
    },
  });
}

describe("native agent router loop guard forwarding", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards loopIdForGuard to the native agent request body", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(createSseResponse());
    const done = new Promise<void>((resolve) => {
      void streamNativeAgentResponse("check loop state", {
        chatId: "chat-1",
        loopIdForGuard: "loop-guard-1",
        onDone: resolve,
      });
    });

    await done;

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/native/agent",
      expect.objectContaining({
        method: "POST",
        body: expect.any(String),
      }),
    );
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) throw new Error("expected native agent request");
    const [, init] = firstCall;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      prompt: "check loop state",
      sessionId: "chat-1",
      loopIdForGuard: "loop-guard-1",
    });
  });

  it("forwards explicit provider selection to the native agent request body", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(createSseResponse());
    const done = new Promise<void>((resolve) => {
      void streamNativeAgentResponse("use pi", {
        chatId: "chat-2",
        provider: "pi",
        onDone: resolve,
      });
    });

    await done;

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) throw new Error("expected native agent request");
    const [, init] = firstCall;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      prompt: "use pi",
      sessionId: "chat-2",
      provider: "pi",
    });
  });

  it("forwards plan and execute phase fields to the native agent request body", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => createSseResponse());
    const planDone = new Promise<void>((resolve) => {
      void streamNativeAgentResponse("plan this", {
        chatId: "chat-3",
        provider: "pi",
        phase: "plan",
        onDone: resolve,
      });
    });

    await planDone;

    const executeDone = new Promise<void>((resolve) => {
      void streamNativeAgentResponse("execute this", {
        chatId: "chat-3",
        provider: "pi",
        phase: "execute",
        planId: "plan-1",
        onDone: resolve,
      });
    });

    await executeDone;

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      prompt: "plan this",
      sessionId: "chat-3",
      provider: "pi",
      phase: "plan",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      prompt: "execute this",
      sessionId: "chat-3",
      provider: "pi",
      phase: "execute",
      planId: "plan-1",
    });
  });

  it("parses native agent capability boundary errors into readable details", () => {
    expect(
      parseNativeAgentErrorResponse(
        JSON.stringify({
          error: "Pi provider cannot handle this request.",
          unsupportedCapabilities: ["mcp", "sandbox"],
        }),
      ),
    ).toEqual({
      message:
        "Pi provider cannot handle this request. Unsupported capabilities: mcp, sandbox.",
      unsupportedCapabilities: ["mcp", "sandbox"],
    });
  });

  it("surfaces 400 capability boundary errors without marking them retryable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "Pi provider cannot handle this request.",
          unsupportedCapabilities: ["file_attachments"],
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const error = await new Promise<Error>((resolve) => {
      void streamNativeAgentResponse("use pi with pdf", {
        chatId: "chat-4",
        provider: "pi",
        onError: (err) => resolve(err),
      });
    });

    expect(error.name).toBe("NativeAgentRequestError");
    expect((error as any).isRetryable).toBe(false);
    expect((error as any).unsupportedCapabilities).toEqual([
      "file_attachments",
    ]);
    expect(error.message).toContain(
      "Unsupported capabilities: file_attachments.",
    );
  });
});
