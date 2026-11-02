import { modelApiUrl } from "@openzhiyu/shared/model-configuration";
import type { LoopCheckerResult, LoopModelChecker } from "./checker";
import { loopVerificationSchema } from "./spec";
import type { LoopJson } from "./types";
import type { LoopVerificationResult } from "./verifier";

const DEFAULT_MAX_INPUT_CHARS = 12_000;
const MAX_STRING_CHARS = 1_200;
const MAX_ARRAY_ITEMS = 40;
const MAX_OBJECT_KEYS = 80;
const MAX_FEEDBACK_CHARS = 2_000;

export interface LoopModelCheckerPrompt {
  system: string;
  user: string;
  estimatedChars: number;
  truncated: boolean;
}

export interface LoopModelCheckerTransport {
  complete: (prompt: LoopModelCheckerPrompt) => Promise<string>;
}

export interface LoopPromptModelCheckerOptions {
  transport: LoopModelCheckerTransport;
  maxInputChars?: number;
}

export interface OpenAICompatibleModelCheckerTransportOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchFn?: typeof fetch;
}

export interface LoopModelCheckerResolution {
  enabled: boolean;
  modelChecker: LoopModelChecker | null;
  reason: string | null;
  maxInputChars?: number;
}

export interface LoopModelCheckerConfig {
  enabled: boolean;
  provider?: string;
  model?: string;
  maxInputChars?: number;
}

export interface LoopModelCheckerProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface RuntimeLoopModelCheckerInput {
  verificationConfig: LoopJson;
  candidate?: LoopModelChecker | null;
  userProviderConfig?: LoopModelCheckerProviderConfig | null;
  envProviderConfig?: LoopModelCheckerProviderConfig | null;
  fetchFn?: typeof fetch;
}

export interface LoopModelCheckerParsedResponse {
  passed: boolean;
  feedback: string;
  retryRecommended?: boolean;
  requiresHumanApproval?: boolean;
  modelFeedback?: LoopJson | null;
}

function truncateText(value: string, maxChars = MAX_STRING_CHARS): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}... [truncated ${value.length - maxChars} chars]`;
}

function toBoundedValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return truncateText(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => toBoundedValue(item, depth + 1));

    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[truncated ${value.length - MAX_ARRAY_ITEMS} array items]`);
    }

    return items;
  }

  if (typeof value === "object") {
    if (depth > 8) {
      return "[truncated nested object]";
    }

    const entries = Object.entries(value as Record<string, unknown>);
    const boundedEntries = entries.slice(0, MAX_OBJECT_KEYS).map(([key, item]) => [
      key,
      toBoundedValue(item, depth + 1),
    ]);

    const result = Object.fromEntries(boundedEntries);
    if (entries.length > MAX_OBJECT_KEYS) {
      result.__truncatedKeys = entries.length - MAX_OBJECT_KEYS;
    }

    return result;
  }

  return String(value);
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");

  if (start < 0 || end < start) {
    throw new Error("Model response did not contain a JSON object.");
  }

  return candidate.slice(start, end + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalBoolean(
  value: unknown,
  fieldName: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`Model response field "${fieldName}" must be boolean.`);
  }

  return value;
}

export function buildLoopModelCheckerPrompt(input: {
  verification: LoopVerificationResult;
  deterministic: LoopCheckerResult;
  maxInputChars?: number;
}): LoopModelCheckerPrompt {
  const maxInputChars = Math.max(2_000, input.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS);
  const payload = {
    verification: input.verification,
    deterministic: input.deterministic,
    instructions: {
      task: "Review whether the loop checker result should pass, retry, or ask for human review.",
      constraints: [
        "Return only a JSON object.",
        "Do not invent evidence that is not present in the payload.",
        "Set requiresHumanApproval=true when the evidence is ambiguous or safety-critical.",
      ],
      outputSchema: {
        passed: "boolean",
        feedback: "short string",
        retryRecommended: "optional boolean",
        requiresHumanApproval: "optional boolean",
        confidence: "optional number from 0 to 1",
        notes: "optional array of short strings",
      },
    },
  };
  const boundedPayload = toBoundedValue(payload);
  const serialized = JSON.stringify(boundedPayload, null, 2);
  const truncated = serialized.length > maxInputChars;
  const userPayload = truncated
    ? `${serialized.slice(0, maxInputChars)}\n... [prompt payload truncated]`
    : serialized;
  const system = [
    "You are a Loop Engineering checker.",
    "You review maker/verifier output and produce a conservative JSON decision.",
    "Prefer human approval over passing uncertain, unsafe, or externally visible actions.",
  ].join(" ");
  const user = `Evaluate this loop verification payload:\n${userPayload}`;

  return {
    system,
    user,
    estimatedChars: system.length + user.length,
    truncated,
  };
}

export function parseLoopModelCheckerResponse(
  responseText: string,
): LoopModelCheckerParsedResponse {
  try {
    const parsed = JSON.parse(extractJsonObject(responseText));

    if (!isRecord(parsed)) {
      throw new Error("Model response root must be an object.");
    }

    if (typeof parsed.passed !== "boolean") {
      throw new Error('Model response field "passed" must be boolean.');
    }

    if (typeof parsed.feedback !== "string" || !parsed.feedback.trim()) {
      throw new Error('Model response field "feedback" must be a non-empty string.');
    }

    const retryRecommended = optionalBoolean(
      parsed.retryRecommended,
      "retryRecommended",
    );
    const requiresHumanApproval = optionalBoolean(
      parsed.requiresHumanApproval,
      "requiresHumanApproval",
    );

    return {
      passed: parsed.passed,
      feedback: truncateText(parsed.feedback.trim(), MAX_FEEDBACK_CHARS),
      retryRecommended,
      requiresHumanApproval,
      modelFeedback: toBoundedValue(parsed) as LoopJson,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      passed: false,
      feedback: `Model checker returned an invalid response: ${message}`,
      retryRecommended: false,
      requiresHumanApproval: true,
      modelFeedback: {
        parseError: message,
        rawResponsePreview: truncateText(responseText, MAX_STRING_CHARS),
      },
    };
  }
}

export function createPromptModelChecker(
  options: LoopPromptModelCheckerOptions,
): LoopModelChecker {
  return {
    check: async ({ verification, deterministic }) => {
      const prompt = buildLoopModelCheckerPrompt({
        verification,
        deterministic,
        maxInputChars: options.maxInputChars,
      });
      const responseText = await options.transport.complete(prompt);

      return parseLoopModelCheckerResponse(responseText);
    },
  };
}

export function createOpenAICompatibleModelCheckerTransport(
  options: OpenAICompatibleModelCheckerTransportOptions,
): LoopModelCheckerTransport {
  const endpoint = modelApiUrl(options.baseUrl, "chat/completions");
  const fetchFn = options.fetchFn ?? fetch;

  return {
    complete: async (prompt) => {
      const response = await fetchFn(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
          stream: false,
          temperature: 0,
          response_format: { type: "json_object" },
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `Model checker provider error: ${response.status} ${detail}`.trim(),
        );
      }

      const payload = (await response.json()) as {
        choices?: Array<{
          message?: { content?: unknown };
          text?: unknown;
        }>;
      };
      const content =
        payload.choices?.[0]?.message?.content ?? payload.choices?.[0]?.text;

      if (typeof content !== "string" || !content.trim()) {
        throw new Error("Model checker provider returned empty content.");
      }

      return content;
    },
  };
}

export function createUnavailableModelChecker(reason: string): LoopModelChecker {
  return {
    check: async () => ({
      passed: false,
      feedback: reason,
      retryRecommended: false,
      requiresHumanApproval: true,
      modelFeedback: {
        status: "unavailable",
        reason,
      },
    }),
  };
}

export function getLoopModelCheckerConfig(
  verificationConfig: LoopJson,
): LoopModelCheckerConfig | null {
  const parsed = loopVerificationSchema.safeParse(verificationConfig);

  return parsed.success ? (parsed.data.modelChecker ?? null) : null;
}

export function createRuntimeLoopModelChecker(
  input: RuntimeLoopModelCheckerInput,
): LoopModelChecker | null {
  const config = getLoopModelCheckerConfig(input.verificationConfig);
  if (!config?.enabled) {
    return input.candidate ?? null;
  }
  if (input.candidate) {
    return input.candidate;
  }

  const provider = config.provider ?? "openai_compatible";
  if (provider !== "openai_compatible") {
    return createUnavailableModelChecker(
      `Model checker provider "${provider}" is not supported by the runtime adapter.`,
    );
  }

  const apiKey =
    input.userProviderConfig?.apiKey ?? input.envProviderConfig?.apiKey;
  const baseUrl =
    input.userProviderConfig?.baseUrl ?? input.envProviderConfig?.baseUrl;
  const model =
    config.model ??
    input.userProviderConfig?.model ??
    input.envProviderConfig?.model;

  if (!apiKey || !baseUrl || !model) {
    return createUnavailableModelChecker(
      "Model checker is enabled, but no OpenAI-compatible model settings are configured.",
    );
  }

  return createPromptModelChecker({
    maxInputChars: config.maxInputChars,
    transport: createOpenAICompatibleModelCheckerTransport({
      apiKey,
      baseUrl,
      model,
      fetchFn: input.fetchFn,
    }),
  });
}

export function resolveLoopModelChecker(input: {
  verificationConfig: LoopJson;
  candidate?: LoopModelChecker | null;
}): LoopModelCheckerResolution {
  const modelCheckerConfig = getLoopModelCheckerConfig(input.verificationConfig);

  if (!modelCheckerConfig?.enabled) {
    return {
      enabled: false,
      modelChecker: null,
      reason: null,
    };
  }

  if (input.candidate) {
    return {
      enabled: true,
      modelChecker: input.candidate,
      reason: null,
      maxInputChars: modelCheckerConfig.maxInputChars,
    };
  }

  const reason =
    "Model checker is enabled for this loop, but no model checker adapter is configured.";

  return {
    enabled: true,
    modelChecker: createUnavailableModelChecker(reason),
    reason,
    maxInputChars: modelCheckerConfig.maxInputChars,
  };
}
