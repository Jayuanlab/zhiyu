import { describe, expect, it } from "vitest";
import { normalizeAgentRuntimeError } from "@/lib/ai/agent-runtime-error";

describe("normalizeAgentRuntimeError", () => {
  it("classifies socket close errors as retryable provider connection errors", () => {
    const result = normalizeAgentRuntimeError(
      new Error(
        "API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
      ),
    );

    expect(result.kind).toBe("provider_connection_closed");
    expect(result.retryable).toBe(true);
    expect(result.message).toContain("模型供应商连接中途断开");
    expect(result.rawMessage).toContain("socket connection was closed");
  });

  it("classifies timeout errors as retryable provider timeout errors", () => {
    const result = normalizeAgentRuntimeError("ETIMEDOUT while calling model");

    expect(result.kind).toBe("provider_timeout");
    expect(result.retryable).toBe(true);
  });

  it("classifies auth errors as non-retryable provider auth errors", () => {
    const result = normalizeAgentRuntimeError("401 invalid_api_key");

    expect(result.kind).toBe("provider_auth");
    expect(result.retryable).toBe(false);
  });

  it("uses provider-neutral compatibility wording for process exit errors", () => {
    const result = normalizeAgentRuntimeError("agent runtime exited with code 1");

    expect(result.kind).toBe("provider_compatibility");
    expect(result.retryable).toBe(true);
    expect(result.message).toContain("模型供应商接口、协议或运行时适配器不兼容");
    expect(result.message).not.toContain("Claude Agent SDK");
  });
});
