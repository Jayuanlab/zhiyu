import type { AgentMessage } from "@openzhiyu/ai/agent/types";
import {
  streamSimple as openAiCompletionsStreamSimple,
} from "@earendil-works/pi-ai/api/openai-completions";
import type {
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
} from "@earendil-works/pi-ai";

export interface NativePiOpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
}

export interface NativePiOpenAICompatibleRequest {
  prompt: string;
  conversation?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface NativePiOpenAICompatibleDeps {
  now?: () => number;
  streamSimple?: (
    model: Model<"openai-completions">,
    context: {
      messages: Array<{ role: "user"; content: string; timestamp: number }>;
    },
    options: Record<string, unknown>,
  ) => AssistantMessageEventStream | AsyncIterable<AssistantMessageEvent>;
}

function normalizeBaseUrl(baseUrl: string) {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) return trimmed;
  if (trimmed.includes("opencode.ai/zen/go")) return `${trimmed}/v1`;
  return trimmed;
}

function openCodeGoSessionHeader(
  config: NativePiOpenAICompatibleConfig,
): Record<string, string> {
  if (!config.baseUrl.includes("opencode.ai/zen/go")) return {};
  return {
    "x-opencode-session": `zhiyu-native-agent-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}`,
  };
}

export function buildNativePiOpenAICompatiblePrompt(
  input: NativePiOpenAICompatibleRequest,
) {
  const conversationContext = (input.conversation || [])
    .map((message) =>
      `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`,
    )
    .join("\n\n");
  return conversationContext
    ? `${conversationContext}\n\nUser: ${input.prompt}`
    : input.prompt;
}

export function buildNativePiOpenAICompatibleModel(
  config: NativePiOpenAICompatibleConfig,
): Model<"openai-completions"> {
  return {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: "native-agent-openai-compatible",
    baseUrl: normalizeBaseUrl(config.baseUrl),
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

export async function createNativePiOpenAICompatibleMessageStream(
  input: NativePiOpenAICompatibleRequest & {
    config: NativePiOpenAICompatibleConfig;
  },
  deps: NativePiOpenAICompatibleDeps = {},
): Promise<AsyncGenerator<AgentMessage>> {
  const now = deps.now ?? Date.now;
  const streamSimple = deps.streamSimple ?? openAiCompletionsStreamSimple;

  const upstream = streamSimple(
    buildNativePiOpenAICompatibleModel(input.config),
    {
      messages: [
        {
          role: "user",
          content: buildNativePiOpenAICompatiblePrompt(input),
          timestamp: now(),
        },
      ],
    },
    {
      apiKey: input.config.apiKey,
      temperature: 0.4,
      maxTokens: 4096,
      toolChoice: "none",
      headers: {
        ...openCodeGoSessionHeader(input.config),
        ...input.config.headers,
      },
      samplingParams: {
        enable_thinking: true,
      },
      metadata: {
        route: "/api/native/agent",
        runtime: "pi-ai-openai-compatible-fallback",
      },
    },
  );

  return (async function* () {
    try {
      for await (const event of upstream) {
        if (event.type === "thinking_delta" && event.delta) {
          yield { type: "reasoning", content: event.delta };
        } else if (event.type === "text_delta" && event.delta) {
          yield { type: "text", content: event.delta };
        } else if (event.type === "error") {
          yield {
            type: "error",
            message:
              event.error.errorMessage ??
              "Pi AI OpenAI-compatible stream failed",
          };
        }
      }
    } catch (error) {
      yield {
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Pi AI OpenAI-compatible stream failed",
      };
    }
  })();
}
