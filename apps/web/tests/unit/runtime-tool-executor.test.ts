import { describe, expect, it, vi } from "vitest";
import { executeGuardedRuntimeTool } from "@/lib/ai/runtime/tool-executor";

function fixedClock() {
  const values = [
    new Date("2026-09-13T12:00:00.000Z"),
    new Date("2026-09-13T12:00:00.125Z"),
  ];
  return () => values.shift() ?? new Date("2026-09-13T12:00:00.125Z");
}

describe("runtime tool executor", () => {
  it("lets explicit denied tools win before the handler is called", async () => {
    const handler = vi.fn(async () => "should not run");
    const onDecision = vi.fn();

    const outcome = await executeGuardedRuntimeTool({
      toolName: "quantPaperPlaceOrder",
      toolUseId: "tool-1",
      input: { symbol: "002716" },
      policy: {
        allowedTools: ["quantPaperPlaceOrder"],
        deniedTools: ["quantPaperPlaceOrder"],
        onDecision,
      },
      handler,
      now: fixedClock(),
    });

    expect(outcome.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "deny",
        matchedRule: "quantPaperPlaceOrder",
      }),
    );
    expect(outcome.trace).toMatchObject({
      status: "denied",
      durationMs: 125,
      metadata: {
        decision: "deny",
        deniedBeforeHandler: true,
      },
    });
  });

  it("lets explicit allowlist matches win over a deny-by-default policy", async () => {
    const handler = vi.fn(async () => ({ ok: true }));

    const outcome = await executeGuardedRuntimeTool({
      toolName: "workshopReadMemory",
      input: { query: "owner" },
      policy: {
        allowedTools: ["workshopReadMemory"],
        defaultDecision: "deny",
      },
      handler,
      now: fixedClock(),
    });

    expect(outcome.ok).toBe(true);
    expect(handler).toHaveBeenCalledWith({ query: "owner" });
    expect(outcome.trace).toMatchObject({
      status: "completed",
      metadata: {
        decision: "allow",
        matchedRule: "workshopReadMemory",
        deniedBeforeHandler: false,
      },
    });
  });

  it("denies tools missing from a non-empty allowlist", async () => {
    const handler = vi.fn(async () => ({ ok: true }));

    const outcome = await executeGuardedRuntimeTool({
      toolName: "externalPayment",
      input: {},
      policy: {
        allowedTools: ["workshopReadMemory"],
      },
      handler,
      now: fixedClock(),
    });

    expect(outcome.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(outcome.trace.detail).toBe(
      "Tool is not present in the runtime allowlist.",
    );
  });

  it("treats approval-required tools as blocked in autonomous execution", async () => {
    const handler = vi.fn(async () => ({ ok: true }));

    const outcome = await executeGuardedRuntimeTool({
      toolName: "wechatSendMessage",
      input: {},
      policy: {
        requiresApprovalTools: ["wechatSendMessage"],
      },
      handler,
      now: fixedClock(),
    });

    expect(outcome.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(outcome.decision).toMatchObject({
      decision: "require_approval",
      matchedRule: "wechatSendMessage",
    });
  });

  it("matches MCP wrapper names by leaf tool name", async () => {
    const handler = vi.fn(async () => "memory result");

    const outcome = await executeGuardedRuntimeTool({
      toolName: "mcp__workshop-tools__workshopReadMemory",
      toolUseId: "tool-2",
      input: { query: "owner" },
      policy: {
        allowedTools: ["workshopReadMemory"],
      },
      handler,
      now: fixedClock(),
    });

    expect(outcome.ok).toBe(true);
    expect(handler).toHaveBeenCalledWith({ query: "owner" });
    expect(outcome.trace).toMatchObject({
      status: "completed",
      detail: "memory result",
      metadata: {
        decision: "allow",
        matchedRule: "workshopReadMemory",
        deniedBeforeHandler: false,
      },
    });
  });

  it("captures handler failures as error trace events", async () => {
    const handler = vi.fn(async () => {
      throw new Error("provider down");
    });

    const outcome = await executeGuardedRuntimeTool({
      toolName: "webReadPage",
      input: { url: "https://example.com" },
      policy: {
        allowedTools: ["webReadPage"],
      },
      handler,
      now: fixedClock(),
    });

    expect(outcome.ok).toBe(false);
    expect(handler).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({
      error: "provider down",
      trace: {
        status: "error",
        detail: "provider down",
        metadata: {
          decision: "allow",
          deniedBeforeHandler: false,
        },
      },
    });
  });
});
