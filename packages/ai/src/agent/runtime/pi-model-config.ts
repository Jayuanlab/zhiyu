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
  OpenAICompletionsCompat,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import type { PiAgentRuntimeAdapterOptions } from "./pi-agent-adapter";
import { randomUUID } from 'node:crypto';
import { isOfficialOpenCodeGoBaseUrl, resolveOpenCodeGoModelEndpoint } from './opencode-go-endpoint';

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

const openAiCompletionsCompat = {
  maxTokensField: "max_tokens",
  supportsStore: false,
  supportsUsageInStreaming: false,
  sendSessionAffinityHeaders: false,
} satisfies OpenAICompletionsCompat;

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
  return isOfficialOpenCodeGoBaseUrl(baseUrl);
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
  return {
    "x-opencode-session": `zhiyu-pi-runtime-${randomUUID()}`,
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
    ...(input.protocol === "openai-completions"
      ? { compat: { ...openAiCompletionsCompat } }
      : {}),
  };
}

function createStreamFn(input: {
  protocol: PiModelProtocol;
  apiKey: string;
  headers?: Record<string, string>;
  openCodeGo: boolean;
  explicitSessionHeader: boolean;
}): PiAgentRuntimeAdapterOptions["streamFn"] {
  const headersFor = (options?: SimpleStreamOptions) => {
    const headers = { ...input.headers, ...options?.headers };
    if (input.openCodeGo && !Object.keys(headers).some(key => key.toLowerCase() === 'user-agent')) {
      headers['user-agent'] = 'zhiyu-agent/0.5.0';
    }
    if (input.openCodeGo && !input.explicitSessionHeader && options?.sessionId
      && !Object.keys(options.headers ?? {}).some(key => key.toLowerCase() === 'x-opencode-session')) {
      // One conversation retains its routing key. Unrelated runs must not all
      // share a model-derived session key; caller-supplied headers still win.
      const sessionId = options.sessionId.trim();
      if (sessionId && !/[\r\n]/.test(sessionId)) headers['x-opencode-session'] = sessionId;
    }
    return headers;
  };
  if (input.protocol === "anthropic-messages") {
    return (model, context, options?: SimpleStreamOptions) =>
      anthropicStreamSimple(model as Model<"anthropic-messages">, context, {
        ...options,
        apiKey: input.apiKey,
        headers: headersFor(options),
      });
  }
  if (input.protocol === "openai-responses") {
    return (model, context, options?: SimpleStreamOptions) =>
      openAiResponsesStreamSimple(model as Model<"openai-responses">, context, {
        ...options,
        apiKey: input.apiKey,
        headers: headersFor(options),
      });
  }
  if (input.protocol === "openai-completions") {
    return (model, context, options?: SimpleStreamOptions) =>
      openAiCompletionsStreamSimple(
        {
          ...model,
          // The installed SDK reads compatibility from Model, and drops
          // unknown SimpleStreamOptions fields before serializing a request.
          compat: {
            ...openAiCompletionsCompat,
            ...(model as Model<"openai-completions">).compat,
            ...((options as SimpleStreamOptions & {
              compat?: OpenAICompletionsCompat;
            })?.compat ?? {}),
          },
        } as Model<"openai-completions">,
        context,
        {
          ...options,
          apiKey: input.apiKey,
          headers: headersFor(options),
        },
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

  const endpoint = resolveOpenCodeGoModelEndpoint({ baseUrl: input.baseUrl?.trim(), model: modelId, protocol: input.protocol });
  const protocol = endpoint.protocol ?? "anthropic-messages";
  const baseUrl = normalizeBaseUrl(
    endpoint.baseUrl || defaultBaseUrl(protocol),
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
      openCodeGo: isOpenCodeGoRuntimeBaseUrl(baseUrl),
      explicitSessionHeader: Object.keys(input.headers ?? {}).some(key => key.toLowerCase() === 'x-opencode-session'),
    }),
  };
}
