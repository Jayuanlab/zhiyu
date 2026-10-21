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

  it("recognizes an expired credential even without an HTTP status", () => {
    const result = normalizeAgentRuntimeError("api_key_expired");

    expect(result.kind).toBe("provider_auth");
    expect(result.retryable).toBe(false);
    expect(result.message).toContain("已过期");
    expect(result.rawMessage).toBe("api_key_expired");
  });

  it.each([
    "[provider_content_rejected] Streaming response failed: [data_inspection_failed] <400> InternalError.Algo.DataInspectionFailed: Output data may contain inappropriate content.",
    "Streaming response failed: [data_inspection_failed] stream terminated",
    "InternalError.Algo.DataInspectionFailed",
  ])("preserves an explicit provider refusal without recommending a blind retry: %s", (raw) => {
    const result = normalizeAgentRuntimeError(raw);

    expect(result.kind).toBe("provider_content_rejected");
    expect(result.retryable).toBe(false);
    expect(result.message).toContain("内容检查");
    expect(result.rawMessage).toBe(raw);
  });

  it("reports a length-limited draft as incomplete, preserving the raw cause", () => {
    const raw = "[provider_output_truncated] Provider ended with finish_reason=length; the partial output is incomplete.";
    const result = normalizeAgentRuntimeError(raw);

    expect(result.kind).toBe("provider_output_truncated");
    expect(result.retryable).toBe(false);
    expect(result.message).toContain("输出长度上限");
    expect(result.message).toContain("未完成");
    expect(result.rawMessage).toBe(raw);
  });

  it("distinguishes an interrupted stream from a complete response", () => {
    const result = normalizeAgentRuntimeError("Stream ended without finish_reason");

    expect(result.kind).toBe("provider_incomplete_output");
    expect(result.retryable).toBe(true);
    expect(result.message).toContain("未返回完整结束标记");
  });

  it("explains an opaque provider stream failure without inventing its cause or retrying the task", () => {
    const raw = '[provider_stream_interrupted] Provider stream returned an unspecified error (raw: {}).';
    const result = normalizeAgentRuntimeError(raw);
    expect(result.kind).toBe('provider_incomplete_output');
    expect(result.message).toContain('未说明原因');
    expect(result.message).toContain('未完成');
    expect(result.message).not.toContain('Key');
    expect(result.message).not.toContain('内容检查');
    expect(result.retryable).toBe(false);
    expect(result.rawMessage).toBe(raw);
  });

  it.each([
    "[provider_incomplete_output] Pi Harness reached EOF without a runtime terminal",
    "[provider_incomplete_output] Pi Harness emitted data after its runtime terminal",
  ])("explains an invalid runtime receipt without hiding its cause: %s", (raw) => {
    const result = normalizeAgentRuntimeError(raw);

    expect(result.kind).toBe("provider_incomplete_output");
    expect(result.retryable).toBe(false);
    expect(result.message).toContain("结束回执缺失或不一致");
    expect(result.rawMessage).toBe(raw);
  });

  it("uses provider-neutral compatibility wording for process exit errors", () => {
    const result = normalizeAgentRuntimeError("agent runtime exited with code 1");

    expect(result.kind).toBe("provider_compatibility");
    expect(result.retryable).toBe(true);
    expect(result.message).toContain("模型供应商接口、协议或运行时适配器不兼容");
    expect(result.message).not.toContain("Claude Agent SDK");
  });
});
