import { z } from "zod";
import { getUserLlmProviderConfig } from "@/lib/ai/user-llm-api-settings";
import { getContextProfileBudget, resolveWorkshopContextProfile } from "@/lib/ai/context-profile";
import {
  fitWorkshopRequiredPrompt,
  formatWorkshopPrimaryDirective,
} from "./context-window";
import {
  formatChatContinuation,
  type ChatContinuationInput,
} from "@/lib/work-runtime/chat-continuation";
import type {
  Loop,
  Workshop,
  WorkshopDirective,
  WorkshopEvent,
  WorkshopMemory,
  WorkshopSource,
} from "@/lib/db/schema";

export type WorkshopDirectivePlanAction =
  | "run_once"
  | "create_loop_task"
  | "ask_clarification"
  | "spawn_subtask"
  | "ignore_duplicate";

export type WorkshopDirectivePlan = {
  action: WorkshopDirectivePlanAction;
  confidence: number;
  reason: string;
  taskIntent?: string;
  clarificationQuestion?: string;
  subtasks?: Array<{ title: string; prompt: string }>;
  duplicateOf?: string;
};

type LocalModelProviderConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

const PLANNER_SYSTEM_PROMPT =
  "You are a precise planning router for an autonomous workshop. Output valid JSON only.";

const directivePlanSchema = z.object({
  action: z.enum([
    "run_once",
    "create_loop_task",
    "ask_clarification",
    "spawn_subtask",
    "ignore_duplicate",
  ]),
  confidence: z.coerce.number().min(0).max(1).default(0.5),
  reason: z.string().min(1),
  taskIntent: z.string().optional(),
  clarificationQuestion: z.string().optional(),
  subtasks: z
    .array(
      z.object({
        title: z.string().min(1),
        prompt: z.string().min(1),
      }),
    )
    .optional(),
  duplicateOf: z.string().optional(),
});

function normalizeOptionalString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePositiveIntEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function buildChatCompletionsUrl(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/chat/completions")) return normalized;
  if (normalized.endsWith("/v1")) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

async function resolvePlannerProviderConfig(
  userId: string,
): Promise<LocalModelProviderConfig> {
  const plannerApiKey =
    normalizeOptionalString(process.env.WORKSHOP_PLANNER_LLM_API_KEY) ??
    normalizeOptionalString(process.env.LOOP_NL_LLM_API_KEY) ??
    normalizeOptionalString(process.env.LLM_API_KEY);
  const plannerBaseUrl =
    normalizeOptionalString(process.env.WORKSHOP_PLANNER_LLM_BASE_URL) ??
    normalizeOptionalString(process.env.LOOP_NL_LLM_BASE_URL) ??
    normalizeOptionalString(process.env.LLM_BASE_URL);
  const plannerModel =
    normalizeOptionalString(process.env.WORKSHOP_PLANNER_LLM_MODEL) ??
    normalizeOptionalString(process.env.LOOP_NL_LLM_MODEL) ??
    normalizeOptionalString(process.env.LLM_MODEL);
  if (plannerApiKey && plannerBaseUrl && plannerModel) {
    return {
      apiKey: plannerApiKey,
      baseUrl: plannerBaseUrl,
      model: plannerModel,
    };
  }

  const userConfig = await getUserLlmProviderConfig({
    userId,
    providerType: "openai_compatible",
  });
  if (userConfig) return userConfig;

  throw new Error(
    "Workshop planner LLM is not configured. Set WORKSHOP_PLANNER_LLM_API_KEY, WORKSHOP_PLANNER_LLM_BASE_URL, and WORKSHOP_PLANNER_LLM_MODEL, or save an OpenAI-compatible provider in Preferences.",
  );
}

function compact(value: string | null | undefined, max = 700) {
  const text = (value ?? "").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function directiveLine(directive: WorkshopDirective) {
  return `- ${directive.id} (${directive.scope}, priority=${directive.priority}): ${compact(directive.content)}`;
}

function loopLine(loop: Loop) {
  const status = loop.status;
  const schedule =
    loop.triggerConfig && typeof loop.triggerConfig === "object"
      ? JSON.stringify(loop.triggerConfig)
      : "";
  return `- ${loop.id} [${status}] ${loop.name}: ${compact(loop.description ?? loop.goal, 500)} ${schedule}`;
}

function sourceLine(source: WorkshopSource) {
  return `- [${source.type}] ${source.name}: ${compact(source.uri ?? source.content, 500)}`;
}

function memoryLine(memory: WorkshopMemory) {
  return `- [${memory.kind}, ${memory.confidence}%] ${compact(memory.content, 500)}`;
}

function eventLine(event: WorkshopEvent) {
  return `- #${event.seq} ${event.type}: ${event.title}${event.body ? ` - ${compact(event.body, 400)}` : ""}`;
}

export function buildWorkshopDirectivePlannerPrompt(input: {
  workshop: Workshop;
  directive: WorkshopDirective;
  activeDirectives: WorkshopDirective[];
  loops: Loop[];
  sources: WorkshopSource[];
  memories: WorkshopMemory[];
  events: WorkshopEvent[];
  continuationContext?: ChatContinuationInput;
}) {
  const primaryDirective = formatWorkshopPrimaryDirective(input.directive);
  const auxiliaryDirectives = input.activeDirectives.filter(
    (directive) => directive.id !== input.directive.id,
  );
  const requiredPrompt = [
    "You are the planning gate for an Zhiyu Work Workshop.",
    "Your job is to classify the user's active directive into exactly one structured action before the main workshop agent runs.",
    "Do not execute the task. Do not call tools. Decide what should happen next.",
    "",
    "Action semantics:",
    '- run_once: the directive can be handled in the current workshop run and does not need durable scheduling.',
    '- create_loop_task: the directive asks for recurring, scheduled, background, reminder, monitor, trading-day, pre-open, or conditional follow-up work. Return a durable taskIntent with cadence, sources, action boundary, and success criteria.',
    "- ask_clarification: the directive cannot be safely planned because a required field is missing.",
    "- spawn_subtask: the directive has independent research/work streams that should be delegated before a final answer.",
    "- ignore_duplicate: an equivalent active or pending task already exists.",
    "",
    "Important examples:",
    '- "每个交易日开盘前生成关注列表" => create_loop_task',
    '- "帮我看一下今天有哪些风险" => run_once',
    '- "每天提醒我复盘" => create_loop_task',
    '- "监控微信里客户是否回复并草拟回复" => create_loop_task',
    "",
    "Return JSON only with this shape:",
    JSON.stringify(
      {
        action: "run_once|create_loop_task|ask_clarification|spawn_subtask|ignore_duplicate",
        confidence: 0.0,
        reason: "short user-visible reason",
        taskIntent: "required for create_loop_task",
        clarificationQuestion: "required for ask_clarification",
        subtasks: [{ title: "short title", prompt: "delegation prompt" }],
        duplicateOf: "loop id or directive id when action is ignore_duplicate",
      },
      null,
      2,
    ),
    "",
    `Workshop: ${input.workshop.name}`,
    `Mission: ${input.workshop.mission}`,
    `Autonomy level: ${input.workshop.autonomyLevel}`,
    "",
    "Directive to classify:",
    primaryDirective,
    ...(input.continuationContext
      ? ["", formatChatContinuation(input.continuationContext)]
      : []),
    "",
  ].join("\n");
  const auxiliaryContext = [
    "",
    "Existing workshop tasks:",
    input.loops.length > 0
      ? input.loops.slice(0, 30).map(loopLine).join("\n")
      : "- None",
    "",
    "Active directives:",
    auxiliaryDirectives.length > 0
      ? auxiliaryDirectives.slice(0, 20).map(directiveLine).join("\n")
      : "- None",
    "",
    "Sources:",
    input.sources.length > 0
      ? input.sources.slice(0, 20).map(sourceLine).join("\n")
      : "- None",
    "",
    "Durable memories:",
    input.memories.length > 0
      ? input.memories.slice(0, 20).map(memoryLine).join("\n")
      : "- None",
    "",
    "Recent events:",
    input.events.length > 0
      ? input.events.slice(-20).map(eventLine).join("\n")
      : "- None",
  ].join("\n");
  return fitWorkshopRequiredPrompt({
    requiredPrefix: requiredPrompt,
    auxiliaryContext,
    maxChars: getContextProfileBudget(resolveWorkshopContextProfile(input.workshop)).promptMaxChars
      - PLANNER_SYSTEM_PROMPT.length - 2,
    truncationNotice: "\n\n[Auxiliary context truncated to fit workshop planner budget.]",
  });
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(fenced);
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Workshop planner did not return JSON.");
  }
}

export function parseWorkshopDirectivePlan(text: string): WorkshopDirectivePlan {
  const parsed = directivePlanSchema.parse(extractJsonObject(text));
  return {
    action: parsed.action,
    confidence: parsed.confidence,
    reason: parsed.reason,
    taskIntent: parsed.taskIntent?.trim() || undefined,
    clarificationQuestion: parsed.clarificationQuestion?.trim() || undefined,
    subtasks: parsed.subtasks,
    duplicateOf: parsed.duplicateOf?.trim() || undefined,
  };
}

export async function planWorkshopDirective(input: {
  userId: string;
  workshop: Workshop;
  directive: WorkshopDirective;
  activeDirectives: WorkshopDirective[];
  loops: Loop[];
  sources: WorkshopSource[];
  memories: WorkshopMemory[];
  events: WorkshopEvent[];
  continuationContext?: ChatContinuationInput;
}): Promise<WorkshopDirectivePlan & { model: string }> {
  const prompt = buildWorkshopDirectivePlannerPrompt(input);
  const config = await resolvePlannerProviderConfig(input.userId);
  const jsonMode = process.env.WORKSHOP_PLANNER_LLM_JSON_MODE !== "0";
  const timeoutMs = parsePositiveIntEnv("WORKSHOP_PLANNER_LLM_TIMEOUT_MS", 20_000);
  const requestBody = {
    model: config.model,
    temperature: 0,
    max_tokens: parsePositiveIntEnv("WORKSHOP_PLANNER_LLM_MAX_TOKENS", 700),
    stream: false,
    messages: [
      {
        role: "system",
        content: PLANNER_SYSTEM_PROMPT,
      },
      { role: "user", content: prompt },
    ],
  };

  let response = await fetch(buildChatCompletionsUrl(config.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      jsonMode
        ? { ...requestBody, response_format: { type: "json_object" } }
        : requestBody,
    ),
    signal: AbortSignal.timeout(timeoutMs),
  });

  let payload = await response.json().catch(() => null);
  if (jsonMode && !response.ok && response.status === 400) {
    response = await fetch(buildChatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
    payload = await response.json().catch(() => null);
  }

  if (!response.ok) {
    const error = payload as { error?: { message?: unknown } } | null;
    throw new Error(
      typeof error?.error?.message === "string"
        ? error.error.message
        : `Workshop planner LLM returned HTTP ${response.status}`,
    );
  }

  const choices = (payload as {
    choices?: Array<{ message?: { content?: unknown } }>;
  } | null)?.choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Workshop planner LLM returned an empty decision.");
  }

  return {
    ...parseWorkshopDirectivePlan(content),
    model: config.model,
  };
}
