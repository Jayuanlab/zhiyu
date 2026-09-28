import { describe, expect, it, vi } from "vitest";
import {
  buildNativePiOpenAICompatibleModel,
  buildNativePiOpenAICompatiblePrompt,
  createNativePiOpenAICompatibleMessageStream,
} from "@/lib/ai/native-pi-openai-fallback";

async function collect<T>(iterable: AsyncIterable<T>) {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

async function* events(items: unknown[]) {
  for (const item of items) yield item as any;
}

describe("native Pi OpenAI-compatible fallback", () => {
  it("folds chat history into a single user prompt for simple Pi requests", () => {
    expect(
      buildNativePiOpenAICompatiblePrompt({
        prompt: "继续",
        conversation: [
          { role: "user", content: "先解释目标" },
          { role: "assistant", content: "目标是迁移底座" },
        ],
      }),
    ).toBe("User: 先解释目标\n\nAssistant: 目标是迁移底座\n\nUser: 继续");
  });

  it("builds an OpenAI-compatible Pi model without leaking credentials", () => {
    expect(
      buildNativePiOpenAICompatibleModel({
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/",
        apiKey: "secret",
        model: "qwen-plus",
      }),
    ).toMatchObject({
      id: "qwen-plus",
      name: "qwen-plus",
      api: "openai-completions",
      provider: "native-agent-openai-compatible",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      reasoning: true,
      input: ["text"],
    });
  });

  it("normalizes OpenCode Go base URLs for OpenAI-compatible fallback", () => {
    expect(
      buildNativePiOpenAICompatibleModel({
        baseUrl: "https://opencode.ai/zen/go",
        apiKey: "secret",
        model: "minimax-m3",
      }),
    ).toMatchObject({
      id: "minimax-m3",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });
  });

  it("maps Pi stream events to native AgentMessage chunks", async () => {
    const streamSimple = vi.fn(() =>
      events([
        { type: "thinking_delta", delta: "思考" },
        { type: "text_delta", delta: "回答" },
        { type: "error", error: { errorMessage: "provider failed" } },
      ]),
    );

    const stream = await createNativePiOpenAICompatibleMessageStream(
      {
        prompt: "hello",
        conversation: [{ role: "assistant", content: "context" }],
        config: {
          baseUrl: "https://example.test/v1/",
          apiKey: "key",
          model: "model-a",
        },
      },
      {
        now: () => 123,
        streamSimple,
      },
    );

    await expect(collect(stream)).resolves.toEqual([
      { type: "reasoning", content: "思考" },
      { type: "text", content: "回答" },
      { type: "error", message: "provider failed" },
    ]);
    expect(streamSimple).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "model-a",
        baseUrl: "https://example.test/v1",
      }),
      {
        messages: [
          {
            role: "user",
            content: "Assistant: context\n\nUser: hello",
            timestamp: 123,
          },
        ],
      },
      expect.objectContaining({
        apiKey: "key",
        toolChoice: "none",
        headers: {},
        samplingParams: { enable_thinking: true },
        metadata: expect.objectContaining({
          runtime: "pi-ai-openai-compatible-fallback",
        }),
      }),
    );
  });

  it("adds the OpenCode Go session header for native fallback streams", async () => {
    const streamSimple = vi.fn(() => events([{ type: "text_delta", delta: "ok" }]));

    const stream = await createNativePiOpenAICompatibleMessageStream(
      {
        prompt: "hello",
        config: {
          baseUrl: "https://opencode.ai/zen/go",
          apiKey: "key",
          model: "minimax-m3",
        },
      },
      {
        now: () => 123,
        streamSimple,
      },
    );

    await expect(collect(stream)).resolves.toEqual([
      { type: "text", content: "ok" },
    ]);
    expect(streamSimple).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-opencode-session": expect.stringMatching(
            /^zhiyu-native-agent-/,
          ),
        }),
      }),
    );
  });

  it("turns stream failures into visible native error messages", async () => {
    async function* failingEvents() {
      yield { type: "text_delta", delta: "before" } as any;
      throw new Error("stream broke");
    }

    const stream = await createNativePiOpenAICompatibleMessageStream(
      {
        prompt: "hello",
        config: {
          baseUrl: "https://example.test/v1",
          apiKey: "key",
          model: "model-a",
        },
      },
      {
        streamSimple: vi.fn(() => failingEvents()),
      },
    );

    await expect(collect(stream)).resolves.toEqual([
      { type: "text", content: "before" },
      { type: "error", message: "stream broke" },
    ]);
  });
});
