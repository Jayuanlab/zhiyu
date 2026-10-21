import {
  resolveOpenCodeGoModelEndpoint,
  isOpenCodeGoRuntimeBaseUrl,
  type PiModelProtocol,
} from "@openzhiyu/ai/agent/runtime";
import { randomUUID } from "node:crypto";

export function auxiliaryModelSessionHeader(baseUrl: string, prefix: string): Record<string, string> {
  return isOpenCodeGoRuntimeBaseUrl(baseUrl)
    ? { "User-Agent": "zhiyu-agent/0.5.0", "x-opencode-session": `${prefix}-${randomUUID()}` } : {};
}

export type AuxiliaryModelProvider = {
  source: "env_openai_compatible" | "env_anthropic_compatible" | "user_openai_compatible" | "user_anthropic_compatible";
  baseUrl: string;
  model: string;
  protocol: PiModelProtocol;
  migrated: boolean;
  configuredBaseUrl?: string;
  configuredProtocol?: PiModelProtocol;
  thinkingMode?: "disabled";
  /** Present only after the response passed terminal and text admission. */
  finishReason?: string;
};

function publicBaseUrl(baseUrl: string, apiKey: string) {
  let identity = baseUrl;
  try {
    const url = new URL(baseUrl);
    identity = `${url.origin}${url.pathname}`;
  } catch {
    identity = "invalid_provider_base_url";
  }
  return apiKey ? identity.replaceAll(apiKey, "[redacted]") : identity;
}

/** Keep credentials private; the provider receipt contains connection identity only. */
export function resolveAuxiliaryModelConnection(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  protocol: PiModelProtocol;
  source: AuxiliaryModelProvider["source"];
}) {
  const resolved = resolveOpenCodeGoModelEndpoint(input);
  const protocol = resolved.protocol ?? input.protocol;
  const baseUrl = resolved.baseUrl ?? input.baseUrl;
  // Omitting a requested protocol lets the shared allowlist identify its own
  // model route; unrecognized providers return no protocol and keep defaults.
  const boundedGoJson = resolveOpenCodeGoModelEndpoint({ baseUrl: input.baseUrl, model: input.model }).protocol === "anthropic-messages";
  const requestBudget = boundedGoJson ? { thinking: { type: "disabled" as const } } : {};
  const provider: AuxiliaryModelProvider = {
    source: input.source,
    baseUrl: publicBaseUrl(baseUrl, input.apiKey),
    model: input.model,
    protocol,
    migrated: resolved.migrated,
    ...(boundedGoJson ? { thinkingMode: "disabled" as const } : {}),
    ...(resolved.migrated ? {
      configuredBaseUrl: publicBaseUrl(input.baseUrl, input.apiKey),
      configuredProtocol: input.protocol,
    } : {}),
  };
  return { apiKey: input.apiKey, baseUrl, model: input.model, protocol, provider, requestBudget };
}

export function assertAuxiliaryModelCompletion(input: {
  protocol: PiModelProtocol;
  finishReason: unknown;
  hasToolCall?: boolean;
  hasError?: boolean;
}, code: string): asserts input is typeof input & { finishReason: string } {
  const complete = input.protocol === "anthropic-messages"
    ? input.finishReason === "end_turn" || input.finishReason === "stop_sequence"
    : input.finishReason === "stop";
  if (!complete || input.hasError || input.hasToolCall) {
    throw new Error(`${code}_incomplete_response`);
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** A parseable JSON body is not evidence that the provider completed its answer. */
export function readAuxiliaryModelResponse(
  payload: unknown,
  protocol: PiModelProtocol,
  code: string,
): { text: string; finishReason: string } {
  const body = record(payload);
  let text: unknown;
  let finishReason: unknown;
  let hasToolCall = false;
  if (protocol === "anthropic-messages") {
    const parts = Array.isArray(body.content) ? body.content.map(record) : [];
    text = parts.filter(part => part.type === "text" && typeof part.text === "string")
      .map(part => part.text).join("\n");
    finishReason = body.stop_reason;
    hasToolCall = parts.some(part => part.type === "tool_use" || part.type === "server_tool_use");
  } else {
    const choices = Array.isArray(body.choices) ? body.choices : [];
    if (choices.length !== 1) throw new Error(`${code}_incomplete_response`);
    const choice = record(choices[0]);
    const message = record(choice.message);
    text = message.content;
    finishReason = choice.finish_reason;
    hasToolCall = (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
      || message.function_call != null || message.refusal != null;
  }
  const terminal = { protocol, finishReason, hasToolCall, hasError: body.error != null };
  assertAuxiliaryModelCompletion(terminal, code);
  if (typeof text !== "string" || !text.trim()) throw new Error(`${code}_empty_response`);
  return { text: text.trim(), finishReason: terminal.finishReason };
}
