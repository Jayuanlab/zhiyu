import { Type } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createGuardedPiTool,
  GuardedPiToolExecutionError,
} from "@/lib/ai/runtime/pi-tool-adapter";

describe("guarded Pi tool adapter", () => {
  it("wraps an allowed handler as a Pi AgentTool result", async () => {
    const onTrace = vi.fn();
    const handler = vi.fn(async (input: { id: string }) => ({
      value: `fact:${input.id}`,
    }));
    const tool = createGuardedPiTool({
      name: "workshopReadMemory",
      label: "Read memory",
      description: "Read scoped workshop memory.",
      parameters: Type.Object({ id: Type.String() }),
      policy: {
        allowedTools: ["workshopReadMemory"],
      },
      execute: handler,
      formatResult: (result) => result.value,
      onTrace,
    });

    const result = await tool.execute("tool-1", { id: "42" });

    expect(handler).toHaveBeenCalledWith(
      { id: "42" },
      { toolCallId: "tool-1", signal: undefined },
    );
    expect(result.content).toEqual([{ type: "text", text: "fact:42" }]);
    expect(result.details.trace).toMatchObject({
      toolName: "workshopReadMemory",
      toolUseId: "tool-1",
      status: "completed",
      metadata: {
        decision: "allow",
        deniedBeforeHandler: false,
      },
    });
    expect(onTrace).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("blocks denied tools before calling the wrapped handler", async () => {
    const handler = vi.fn(async () => "should not run");
    const onTrace = vi.fn();
    const tool = createGuardedPiTool({
      name: "quantPaperPlaceOrder",
      description: "Place paper order.",
      parameters: Type.Object({ symbol: Type.String() }),
      policy: {
        allowedTools: ["quantPaperPlaceOrder"],
        deniedTools: ["quantPaperPlaceOrder"],
      },
      execute: handler,
      onTrace,
    });

    await expect(
      tool.execute("tool-2", { symbol: "002716" }),
    ).rejects.toThrow(GuardedPiToolExecutionError);

    expect(handler).not.toHaveBeenCalled();
    expect(onTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "denied",
        metadata: expect.objectContaining({
          decision: "deny",
          deniedBeforeHandler: true,
        }),
      }),
    );
  });

  it("surfaces handler failures with the guarded trace attached", async () => {
    const tool = createGuardedPiTool({
      name: "webReadPage",
      description: "Read web page.",
      parameters: Type.Object({ url: Type.String() }),
      policy: {
        allowedTools: ["webReadPage"],
      },
      execute: async () => {
        throw new Error("provider down");
      },
    });

    try {
      await tool.execute("tool-3", { url: "https://example.com" });
      throw new Error("expected guarded tool error");
    } catch (error) {
      expect(error).toBeInstanceOf(GuardedPiToolExecutionError);
      expect(error).toMatchObject({
        message: "provider down",
        trace: {
          status: "error",
          detail: "provider down",
          metadata: {
            decision: "allow",
            deniedBeforeHandler: false,
          },
        },
      });
    }
  });
});
