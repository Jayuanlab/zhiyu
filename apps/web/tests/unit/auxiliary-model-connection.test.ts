import { describe, expect, it } from "vitest";
import {
  readAuxiliaryModelResponse,
  resolveAuxiliaryModelConnection,
} from "@/lib/ai/auxiliary-model-connection";

describe("auxiliary model connection admission", () => {
  it.each([
    { baseUrl: "https://example.invalid/zen/go", model: "qwen3.7-plus", protocol: "openai-completions" as const },
    { baseUrl: "https://opencode.ai/zen/go", model: "another-model", protocol: "openai-completions" as const },
    { baseUrl: "http://opencode.ai/zen/go", model: "qwen3.7-plus", protocol: "anthropic-messages" as const },
  ])("retains explicit connection identity outside the canonical model route: %o", config => {
    const result = resolveAuxiliaryModelConnection({ ...config, apiKey: "test-private-key", source: "user_anthropic_compatible" });
    expect(result).toMatchObject({ ...config, apiKey: "test-private-key", provider: { ...config, migrated: false } });
    expect(result.requestBudget).toEqual({});
    expect(JSON.stringify(result.provider)).not.toContain("test-private-key");
  });
  it("keeps the actual migration source and both connection identities", () => {
    const result = resolveAuxiliaryModelConnection({ apiKey: "test-private-key", source: "user_openai_compatible",
      baseUrl: "https://opencode.ai/zen/go/v1", model: "qwen3.7-plus", protocol: "openai-completions" });
    expect(result.provider).toEqual({ source: "user_openai_compatible", model: "qwen3.7-plus", migrated: true,
      baseUrl: "https://opencode.ai/inference/go/anthropic", protocol: "anthropic-messages",
      configuredBaseUrl: "https://opencode.ai/zen/go/v1", configuredProtocol: "openai-completions", thinkingMode: "disabled" });
    expect(result.requestBudget).toEqual({ thinking: { type: "disabled" } });
  });
  it("keeps credentials and query strings out of the public provider receipt", () => {
    const result = resolveAuxiliaryModelConnection({ apiKey: "private-key", source: "env_openai_compatible",
      baseUrl: "https://user:private-key@example.invalid/v1?api_key=private-key", model: "configured-model", protocol: "openai-completions" });
    expect(result.baseUrl).toBe("https://user:private-key@example.invalid/v1?api_key=private-key");
    expect(result.provider.baseUrl).toBe("https://example.invalid/v1");
    expect(JSON.stringify(result.provider)).not.toContain("private-key");
  });
  it.each(["end_turn", "stop_sequence"])("admits text only with the Anthropic terminal %s", stopReason => {
    expect(readAuxiliaryModelResponse({ stop_reason: stopReason, content: [
      { type: "thinking", thinking: "not a report" }, { type: "text", text: " complete text " },
    ] }, "anthropic-messages", "test_provider")).toEqual({ text: "complete text", finishReason: stopReason });
  });
  it("rejects a concealed tool call even beside a valid end_turn and JSON text", () => {
    expect(() => readAuxiliaryModelResponse({ stop_reason: "end_turn", content: [
      { type: "text", text: "{}" }, { type: "tool_use", name: "not_authorized", input: {} },
    ] }, "anthropic-messages", "test_provider")).toThrow("test_provider_incomplete_response");
  });
  it.each([
    { error: { message: "provider private detail" }, choices: [{ finish_reason: "stop", message: { content: "{}" } }] },
    { choices: [{ finish_reason: "stop", message: { content: "{}", tool_calls: [{ id: "tool-1" }] } }] },
    { choices: [{ finish_reason: "stop", message: { content: "{}", refusal: "refused" } }] },
    { choices: [{ finish_reason: "stop", message: { content: "{}" } }, { finish_reason: "stop", message: { content: "{}" } }] },
  ])("rejects error, tools, refusal and ambiguous choices without copying provider detail", payload => {
    expect(() => readAuxiliaryModelResponse(payload, "openai-completions", "test_provider"))
      .toThrow(/^test_provider_incomplete_response$/);
  });
  it("admits a single explicitly completed OpenAI text response", () => {
    expect(readAuxiliaryModelResponse({ choices: [{ finish_reason: "stop", message: { content: "{}" } }] },
      "openai-completions", "test_provider")).toEqual({ text: "{}", finishReason: "stop" });
  });
});
