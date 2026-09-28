import {
  PiModelConfigError,
  createPiRuntimeOptionsFromModelConfig,
  isOpenCodeGoRuntimeBaseUrl,
} from "@openzhiyu/ai/agent/runtime";
import { describe, expect, it } from "vitest";

describe("Pi model runtime config", () => {
  it("creates Anthropic-compatible Pi runtime options by default", () => {
    const options = createPiRuntimeOptionsFromModelConfig({
      apiKey: "test-key",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-test",
    });

    expect(options.model).toMatchObject({
      id: "claude-sonnet-test",
      api: "anthropic-messages",
      provider: "zhiyu-anthropic-compatible",
      baseUrl: "https://api.anthropic.com",
    });
    expect(options.streamFn).toEqual(expect.any(Function));
  });

  it("creates OpenAI Responses Pi runtime options when requested", () => {
    const options = createPiRuntimeOptionsFromModelConfig({
      apiKey: "test-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-test",
      protocol: "openai-responses",
      providerId: "zhiyu-openai",
    });

    expect(options.model).toMatchObject({
      id: "gpt-test",
      api: "openai-responses",
      provider: "zhiyu-openai",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("creates OpenAI Chat Completions Pi runtime options for OpenCode Go", () => {
    const options = createPiRuntimeOptionsFromModelConfig({
      apiKey: "test-key",
      baseUrl: "https://opencode.ai/zen/go",
      model: "minimax-m3",
      protocol: "openai-completions",
      providerId: "opencode-go",
    });

    expect(options.model).toMatchObject({
      id: "minimax-m3",
      api: "openai-completions",
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });
    expect(options.streamFn).toEqual(expect.any(Function));
  });

  it("recognizes OpenCode Go runtime URLs after normalization", () => {
    expect(isOpenCodeGoRuntimeBaseUrl("https://opencode.ai/zen/go")).toBe(true);
    expect(isOpenCodeGoRuntimeBaseUrl("https://opencode.ai/zen/go/v1")).toBe(
      true,
    );
    expect(isOpenCodeGoRuntimeBaseUrl("https://api.openai.com/v1")).toBe(false);
  });

  it("rejects missing API keys before creating a runtime", () => {
    expect(() =>
      createPiRuntimeOptionsFromModelConfig({
        model: "claude-sonnet-test",
      }),
    ).toThrow(PiModelConfigError);
  });

  it("rejects missing model ids before creating a runtime", () => {
    expect(() =>
      createPiRuntimeOptionsFromModelConfig({
        apiKey: "test-key",
        model: " ",
      }),
    ).toThrow(PiModelConfigError);
  });
});
