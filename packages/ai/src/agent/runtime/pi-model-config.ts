import {
  streamSimple as anthropicStreamSimple,
} from "@earendil-works/pi-ai/api/anthropic-messages";
import {
  streamSimple as openAiResponsesStreamSimple,
} from "@earendil-works/pi-ai/api/openai-responses";
import {
  streamSimple as openAiCompletionsStreamSimple,
} from "@earendil-works/pi-ai/api/openai-completions";
import type {
  Api,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import type { PiAgentRuntimeAdapterOptions } from "./pi-agent-adapter";

export type PiModelProtocol =
  | "anthropic-messages"
  | "openai-responses"
  | "openai-completions";

export interface PiModelRuntimeConfig {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  protocol?: PiModelProtocol;
  providerId?: string;
  providerName?: string;
  headers?: Record<string, string>;
}

export class PiModelConfigError extends Error {
  readonly code: "missing_api_key" | "missing_model" | "unsupported_protocol";

  constructor(code: PiModelConfigError["code"], message: string) {
    super(message);
    this.name = "PiModelConfigError";
    this.code = code;
  }
}

function defaultBaseUrl(protocol: PiModelProtocol): string {
  if (protocol === "anthropic-messages") return "https://api.anthropic.com";
  return "https://api.openai.com/v1";
}

function defaultProviderId(protocol: PiModelProtocol): string {
  if (protocol === "anthropic-messages") return "zhiyu-anthropic-compatible";
  if (protocol === "openai-completions") return "zhiyu-openai-completions";
  return "zhiyu-openai-compatible";
}

function normalizeBaseUrl(baseUrl: string, protocol: PiModelProtocol): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (
    protocol === "openai-completions" &&
    /^https:\/\/opencode\.ai\/zen\/go$/i.test(trimmed)
  ) {
    return `${trimmed}/v1`;
  }
  return trimmed;
}

export function isOpenCodeGoRuntimeBaseUrl(baseUrl: string): boolean {
  return /opencode\.ai\/zen\/go(?:\/|$)/i.test(baseUrl);
}

function buildOpenCodeGoSessionHeader(input: {
  baseUrl: string;
  model: string;
  headers?: Record<string, string>;
}): Record<string, string> {
  if (!isOpenCodeGoRuntimeBaseUrl(input.baseUrl)) return {};
  if (
    Object.keys(input.headers ?? {}).some(
      (key) => key.toLowerCase() === "x-opencode-session",
    )
  ) {
    return {};
  }
  const safeModel = input.model
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return {
    "x-opencode-session": `zhiyu-pi-runtime-${safeModel || "model"}`,
  };
}

function createModel(input: Required<PiModelRuntimeConfig> & {
  protocol: PiModelProtocol;
}): Model<Api> {
  return {
    id: input.model,
    name: input.model,
    api: input.protocol,
    provider: input.providerId,
    baseUrl: input.baseUrl,
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function createStreamFn(input: {
  protocol: PiModelProtocol;
  apiKey: string;
  headers?: Record<string, string>;
}): PiAgentRuntimeAdapterOptions["streamFn"] {
  if (input.protocol === "anthropic-messages") {
    return (model, context, options?: SimpleStreamOptions) =>
      anthropicStreamSimple(model as Model<"anthropic-messages">, context, {
        ...options,
        apiKey: input.apiKey,
        headers: {
          ...input.headers,
          ...options?.headers,
        },
      });
  }
  if (input.protocol === "openai-responses") {
    return (model, context, options?: SimpleStreamOptions) =>
      openAiResponsesStreamSimple(model as Model<"openai-responses">, context, {
        ...options,
        apiKey: input.apiKey,
        headers: {
          ...input.headers,
          ...options?.headers,
        },
      });
  }
  if (input.protocol === "openai-completions") {
    return (model, context, options?: SimpleStreamOptions) =>
      openAiCompletionsStreamSimple(
        model as Model<"openai-completions">,
        context,
        {
          ...options,
          apiKey: input.apiKey,
          headers: {
            ...input.headers,
            ...options?.headers,
          },
          compat: {
            maxTokensField: "max_tokens",
            supportsStore: false,
            supportsUsageInStreaming: false,
            sendSessionAffinityHeaders: false,
            ...((options as SimpleStreamOptions & {
              compat?: Record<string, unknown>;
            })?.compat ?? {}),
          },
        } as SimpleStreamOptions,
      );
  }
  throw new PiModelConfigError(
    "unsupported_protocol",
    `Unsupported Pi model protocol: ${input.protocol}`,
  );
}

export function createPiRuntimeOptionsFromModelConfig(
  input: PiModelRuntimeConfig,
): PiAgentRuntimeAdapterOptions {
  const modelId = input.model.trim();
  if (!modelId) {
    throw new PiModelConfigError(
      "missing_model",
      "Pi runtime requires a model id.",
    );
  }

  const apiKey = input.apiKey?.trim();
  if (!apiKey) {
    throw new PiModelConfigError(
      "missing_api_key",
      "Pi runtime requires an API key.",
    );
  }

  const protocol = input.protocol ?? "anthropic-messages";
  const baseUrl = normalizeBaseUrl(
    input.baseUrl?.trim() || defaultBaseUrl(protocol),
    protocol,
  );
  const headers = {
    ...buildOpenCodeGoSessionHeader({
      baseUrl,
      model: modelId,
      headers: input.headers,
    }),
    ...(input.headers ?? {}),
  };
  const normalized = {
    apiKey,
    baseUrl,
    model: modelId,
    protocol,
    providerId: input.providerId?.trim() || defaultProviderId(protocol),
    providerName: input.providerName?.trim() || defaultProviderId(protocol),
    headers,
  };

  return {
    model: createModel(normalized),
    streamFn: createStreamFn({
      protocol,
      apiKey,
      headers,
    }),
  };
}
