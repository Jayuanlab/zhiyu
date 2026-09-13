import { z } from "zod";
import { generateText, type ModelMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { jsonrepair } from "jsonrepair";
import { getModelProvider } from "@/lib/ai";
import { getUserLlmProviderConfig } from "@/lib/ai/user-llm-api-settings";
import { isTauriMode } from "@/lib/env/constants";
import type { InteractionEvent } from "@/lib/db/schema";
import {
  applyInteractionProcessingMode,
  type InteractionProcessingMode,
} from "@/lib/knowledge-pipeline/source-policy-runtime";
import { listInteractionSourcePolicies } from "@/lib/knowledge-pipeline/source-policies";
import {
  claimInteractionProcessingJob,
  beginInteractionProcessingWrites,
  assertInteractionProcessingWrites,
  applyInteractionProcessingWrites,
  createInteractionProcessingJob,
  failInteractionProcessingJob,
} from "./processing-jobs";
import {
  createInteractionBrainMemory,
  createInteractionNote,
  createInteractionSummaryNoteFromEvents,
  createInteractionTask,
  getInteractionEventsByIds,
  promoteInteractionMemoryCandidates,
} from "./service";
import { indexInteractionAnalysisToGraph } from "./graph";
import { INTERACTION_MEMORY_AUTO_PROMOTION_POLICY_VERSION } from "./memory-promotion";
import {readInteractionProcessingPlan,saveInteractionProcessingPlan,interactionPlanContext} from './processing-plans';
import {
  buildInteractionScenarioSnapshots,
  createInteractionScenarioSnapshots,
  type InteractionScenarioSourceItem,
} from "./scenarios";

type LocalModelProviderConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  providerType: "openai_compatible" | "anthropic_compatible";
};

const DEFAULT_INTERACTION_PROCESSOR_LLM_MODEL = "qwen-flash";

const privacyClassSchema = z
  .enum(["normal", "private", "sensitive", "regulated"])
  .default("normal");
const riskLevelSchema = z.enum(["low", "medium", "high"]).default("low");
const atomTypeSchema = z
  .enum([
    "todo",
    "reply_needed",
    "commitment",
    "fact",
    "preference",
    "relationship",
    "risk",
    "decision",
  ])
  .default("fact");
const scenarioHintsSchema = z
  .array(
    z.object({
      type: z.enum([
        "person",
        "group",
        "project",
        "topic",
        "transaction",
        "family",
        "work",
      ]),
      key: z.string().min(1),
      title: z.string().min(1),
    }),
  )
  .default([]);

const processorSchema = z.object({
  notes: z
    .array(
      z.object({
        noteType: z
          .enum([
            "summary",
            "classification",
            "reply_need",
            "risk",
            "relationship",
            "project_context",
          ])
          .default("summary"),
        title: z.string().min(1),
        body: z.string().min(1),
        confidence: z.coerce.number().min(0).max(100).default(60),
        sourceEventIds: z.array(z.string()).min(1),
        privacyClass: privacyClassSchema,
        riskLevel: riskLevelSchema,
        scenarioHints: scenarioHintsSchema,
      }),
    )
    .default([]),
  tasks: z
    .array(
      z.object({
        title: z.string().min(1),
        description: z.string().nullable().optional(),
        dueAt: z.string().nullable().optional(),
        assigneeName: z.string().nullable().optional(),
        requesterName: z.string().nullable().optional(),
        confidence: z.coerce.number().min(0).max(100).default(60),
        sourceEventIds: z.array(z.string()).min(1),
        atomType: atomTypeSchema.default("todo"),
        privacyClass: privacyClassSchema,
        riskLevel: riskLevelSchema,
        scenarioHints: scenarioHintsSchema,
      }),
    )
    .default([]),
  memories: z
    .array(
      z.object({
        memoryType: z
          .enum([
            "person",
            "preference",
            "project",
            "relationship",
            "commitment",
            "routine",
            "boundary",
            "mistake",
          ])
          .default("project"),
        subject: z.string().min(1),
        content: z.string().min(1),
        confidence: z.coerce.number().min(0).max(100).default(60),
        tags: z.array(z.string()).default([]),
        sourceEventIds: z.array(z.string()).min(1),
        atomType: atomTypeSchema,
        privacyClass: privacyClassSchema,
        riskLevel: riskLevelSchema,
        scenarioHints: scenarioHintsSchema,
        expiresAt: z.string().nullable().optional(),
      }),
    )
    .default([]),
});

const analysisSchema = z.object({
  summary: z.string().min(1),
  topics: z.array(z.string()).default([]),
  entities: z
    .array(z.object({ name: z.string(), type: z.string(), role: z.string() }))
    .default([]),
  facts: z
    .array(
      z.object({
        claim: z.string(),
        sourceEventIds: z.array(z.string()).min(1),
        evidenceStrength: z.enum(["high", "medium", "low"]),
      }),
    )
    .default([]),
  decisions: z.array(z.string()).default([]),
  commitments: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  contradictions: z.array(z.string()).default([]),
  recommendations: z.array(z.string()).default([]),
});

export type InteractionAnalysis = z.infer<typeof analysisSchema>;
export type InteractionProcessorResult = {
  mode: "llm" | "fallback_summary" | "skipped";
  model?: string;
  processedEventIds: string[];
  notes: Array<Awaited<ReturnType<typeof createInteractionNote>>>;
  tasks: Array<Awaited<ReturnType<typeof createInteractionTask>>>;
  memories: Array<Awaited<ReturnType<typeof createInteractionBrainMemory>>>;
  graphIndex?: {
    entities: number;
    relations: number;
    evidence: number;
  };
  scenarioSnapshots?: {
    createdCount: number;
    scenarioKeys: string[];
  };
  memoryPromotion?: Awaited<
    ReturnType<typeof promoteInteractionMemoryCandidates>
  >;
  graphIndexError?: string;
  error?: string;
};

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

function buildOpenAICompatibleBaseUrl(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/chat/completions")) {
    return normalized.replace(/\/chat\/completions$/, "");
  }
  if (normalized.endsWith("/v1")) return normalized;
  return `${normalized}/v1`;
}

function buildAnthropicMessagesUrl(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/v1/messages")) return normalized;
  if (normalized.endsWith("/v1")) return `${normalized}/messages`;
  return `${normalized}/v1/messages`;
}

function normalizeProcessorProviderType(
  value: string | null | undefined,
): LocalModelProviderConfig["providerType"] | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "openai_compatible" ||
    normalized === "anthropic_compatible"
    ? normalized
    : null;
}

function inferProcessorProviderType(baseUrl: string) {
  return baseUrl.includes("opencode.ai/zen/go")
    ? "anthropic_compatible"
    : "openai_compatible";
}

function createProcessorModel(config: LocalModelProviderConfig) {
  if (config.providerType !== "openai_compatible") {
    throw new Error(
      `Interaction processor provider "${config.providerType}" is not OpenAI-compatible.`,
    );
  }

  return createOpenAICompatible({
    baseURL: buildOpenAICompatibleBaseUrl(config.baseUrl),
    name: "interaction-processor",
    apiKey: config.apiKey,
  }).chatModel(config.model);
}

async function resolveProcessorProviderConfig(
  userId: string,
): Promise<LocalModelProviderConfig> {
  const apiKey =
    normalizeOptionalString(process.env.INTERACTION_PROCESSOR_LLM_API_KEY) ??
    normalizeOptionalString(process.env.WORKSHOP_PLANNER_LLM_API_KEY) ??
    normalizeOptionalString(process.env.LLM_API_KEY);
  const baseUrl =
    normalizeOptionalString(process.env.INTERACTION_PROCESSOR_LLM_BASE_URL) ??
    normalizeOptionalString(process.env.WORKSHOP_PLANNER_LLM_BASE_URL) ??
    normalizeOptionalString(process.env.LLM_BASE_URL);
  const model =
    normalizeOptionalString(process.env.INTERACTION_PROCESSOR_LLM_MODEL) ??
    normalizeOptionalString(process.env.WORKSHOP_PLANNER_LLM_MODEL) ??
    normalizeOptionalString(process.env.LLM_MODEL) ??
    DEFAULT_INTERACTION_PROCESSOR_LLM_MODEL;
  if (apiKey && baseUrl && model) {
    return {
      apiKey,
      baseUrl,
      model,
      providerType:
        normalizeProcessorProviderType(
          process.env.INTERACTION_PROCESSOR_LLM_PROVIDER,
        ) ?? inferProcessorProviderType(baseUrl),
    };
  }

  const userConfig = await getUserLlmProviderConfig({
    userId,
    providerType: "openai_compatible",
  });
  if (userConfig) return { ...userConfig, providerType: "openai_compatible" };

  const userAnthropicConfig = await getUserLlmProviderConfig({
    userId,
    providerType: "anthropic_compatible",
  });
  if (userAnthropicConfig) {
    return { ...userAnthropicConfig, providerType: "anthropic_compatible" };
  }

  throw new Error(
    "Interaction processor LLM is not configured. Set INTERACTION_PROCESSOR_LLM_API_KEY, INTERACTION_PROCESSOR_LLM_BASE_URL, and INTERACTION_PROCESSOR_LLM_MODEL, or save an OpenAI-compatible provider in Preferences.",
  );
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(jsonrepair(fenced));
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(jsonrepair(trimmed.slice(start, end + 1)));
    }
    try {
      return JSON.parse(jsonrepair(trimmed));
    } catch {
      // Fall through to the clearer domain error below.
    }
    throw new Error("Interaction processor did not return JSON.");
  }
}

function compact(value: string | null | undefined, max = 800) {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function eventLine(event: InteractionEvent) {
  const sender =
    event.senderDisplayName ?? event.senderName ?? event.conversationName;
  const time =
    event.messageTime instanceof Date
      ? event.messageTime.toISOString()
      : String(event.messageTime);
  return [
    `id=${event.id}`,
    `time=${time}`,
    `conversation=${event.conversationName}`,
    `sender=${sender}`,
    `direction=${event.direction}`,
    `type=${event.contentType}`,
    `content=${compact(event.content || event.contentPreview, 900)}`,
  ].join(" | ");
}

function sourceFingerprint(events: InteractionEvent[]) {
  const conversations = [
    ...new Set(
      events
        .map((event) => event.conversationId ?? event.conversationName)
        .filter(Boolean),
    ),
  ];
  const conversationTypes = [
    ...new Set(events.map((event) => event.conversationType).filter(Boolean)),
  ];
  return {
    sourceKind: "wechat",
    platform: events[0]?.platform ?? "wechat",
    conversationIds: conversations.slice(0, 8),
    conversationTypes: conversationTypes.slice(0, 8),
  };
}

async function sourcePolicyFingerprint(input: {
  userId: string;
  events: InteractionEvent[];
}) {
  const policies = await listInteractionSourcePolicies({
    userId: input.userId,
    platform: "wechat",
  });
  const policyBySourceId = new Map(
    policies.map((policy) => [policy.sourceId, policy]),
  );
  const matchedPolicies = input.events
    .map((event) =>
      event.conversationId
        ? policyBySourceId.get(event.conversationId)
        : undefined,
    )
    .filter(
      (policy): policy is NonNullable<typeof policy> => Boolean(policy),
    );
  const policyValues = [
    ...new Set(matchedPolicies.map((policy) => policy.policy)),
  ];
  const sourcePolicy = policyValues.includes("ignore")
    ? "ignore"
    : policyValues.includes("mention_only")
      ? "mention_only"
      : policyValues.includes("summary")
        ? "summary"
        : policyValues.includes("sync")
          ? "sync"
          : "unknown";
  const privacyClasses = [
    ...new Set(
      matchedPolicies
        .map((policy) => policy.metadata.privacyClass)
        .filter((value): value is string => typeof value === "string"),
    ),
  ];
  return {
    sourcePolicy,
    sourcePolicies: policyValues,
    sourcePrivacyClasses: privacyClasses,
  };
}

function candidateLayerMetadata(input: {
  layer: "L1" | "L3";
  atomType?: string;
  privacyClass?: string;
  riskLevel?: string;
  scenarioHints?: Array<{ type: string; key: string; title: string }>;
  processingMode: InteractionProcessingMode;
  model?: string;
  analysisSummary?: string;
  extra?: Record<string, unknown>;
}) {
  return {
    sourceKind: "wechat",
    layer: input.layer,
    atomType: input.atomType,
    privacyClass: input.privacyClass ?? "normal",
    riskLevel: input.riskLevel ?? "low",
    scenarioHints: input.scenarioHints ?? [],
    processingMode: input.processingMode,
    model: input.model,
    analysisSummary: input.analysisSummary,
    promotionPolicy: INTERACTION_MEMORY_AUTO_PROMOTION_POLICY_VERSION,
    ...(input.extra ?? {}),
  };
}

function buildAnalysisPrompt(events: InteractionEvent[]) {
  return [
    "You are the analysis stage for the owner's workbench knowledge base.",
    "Return valid JSON only. Do not return Markdown or explanations.",
    "Analyze the WeChat events as factual source material for the whole workbench, not as a chat archive. Do not invent relationships, intent, or long-term facts.",
    "Every factual claim must cite sourceEventIds that exist in the input.",
    "Separate facts, decisions, commitments, risks, contradictions, and recommendations.",
    JSON.stringify(
      {
        summary: "Chinese conversation summary",
        topics: ["topic"],
        entities: [
          {
            name: "name",
            type: "person|organization|project|product|other",
            role: "role",
          },
        ],
        facts: [
          {
            claim: "verifiable factual claim in Chinese",
            sourceEventIds: ["event id"],
            evidenceStrength: "high|medium|low",
          },
        ],
        decisions: [],
        commitments: [],
        risks: [],
        contradictions: [],
        recommendations: [],
      },
      null,
      2,
    ),
    "Events:",
    events.map(eventLine).join("\n"),
  ].join("\n");
}

function buildProcessorPrompt(
  events: InteractionEvent[],
  analysis?: InteractionAnalysis,
) {
  return [
    "You are a Chinese Owner Context processor for a personal AI workbench.",
    "Your job is to distill raw WeChat events into traceable Owner Knowledge candidates: notes, tasks, and long-term context memories.",
    "Return valid JSON only. Do not return Markdown, comments, code fences, or explanations.",
    "Use Simplified Chinese for title, body, description, subject, content, and tags, except for names, product names, group names, URLs, and enum values.",
    "",
    "Rules:",
    "- Raw messages are source facts and evidence. They are not themselves long-term knowledge.",
    "- The output is a candidate layer. It must not be treated as confirmed Owner Context until the owner/system confirms it.",
    "- Every note, task, and memory must cite sourceEventIds from the input events.",
    "- Create notes for useful context, group-chat topics, relationship signals, risks, project background, or reply-needed situations that may help any workbench module later.",
    "- Create tasks only when there is an explicit request, promise, follow-up, reminder, confirmation need, or reply need.",
    "- Create memories only for stable Owner Context that will be useful later: preferences, long-term identity, people background, project context, commitments, routines, boundaries, or repeated problems.",
    "- Assign atomType to each task and memory: todo, reply_needed, commitment, fact, preference, relationship, risk, or decision.",
    "- Assign privacyClass: normal for ordinary work context, private for personal relationship details, sensitive for finance/health/legal/account/private identity data, regulated for medical/legal/financial compliance-like material.",
    "- Assign riskLevel: high for money, trading, contract, medical, legal, credentials, privacy, external commitments, or anything that could cause harm if used incorrectly; medium for relationship-sensitive or ambiguous obligations; low only for safe durable context.",
    "- Add scenarioHints for the person, group, project, topic, transaction, family, or work scenario that should later receive an L2 state update.",
    "- Prefer information about the owner, owner relationships, owner commitments, owner projects, and persistent operating rules.",
    "- Do not store market spam, ads, listings, forwarded promotion text, or group noise as memory unless it clearly affects the owner's durable goals, relationships, or decisions.",
    "- Do not put temporary state into memory, such as traffic, current location, one-off meeting status, or just-left/just-arrived messages.",
    "- Ignore jokes, casual banter, greetings, memes, low-value game chatter, and short ambiguous messages unless they reveal a stable preference or long-term relationship.",
    "- If the content is low value, too sparse, or lacks evidence, return empty arrays.",
    "- Prefer fewer high-confidence items over many weak items.",
    "",
    "Confidence:",
    "- 80-100: clear message, strong evidence, high future reuse value.",
    "- 60-79: evidenced but context or long-term value is moderate.",
    "- Below 60: do not emit the item.",
    "- Do not use confidence 0. If unsure, omit the item.",
    "",
    "Field requirements:",
    "- noteType and memoryType must use the enum values shown in the JSON schema below.",
    "- dueAt must be null unless an explicit due time exists in the messages.",
    "- assigneeName and requesterName must be null when unclear.",
    "- sourceEventIds must only contain ids from the input Events.",
    "",
    "Required JSON shape:",
    JSON.stringify(
      {
        notes: [
          {
            noteType:
              "summary|classification|reply_need|risk|relationship|project_context",
            title: "Chinese short title",
            body: "Chinese distilled content with facts and evidence basis",
            confidence: 80,
            sourceEventIds: ["event id"],
            privacyClass: "normal|private|sensitive|regulated",
            riskLevel: "low|medium|high",
            scenarioHints: [
              {
                type: "person|group|project|topic|transaction|family|work",
                key: "stable scenario key",
                title: "display title",
              },
            ],
          },
        ],
        tasks: [
          {
            title: "Chinese task candidate title",
            description:
              "Chinese explanation of why this is a task and what to follow up",
            dueAt: "ISO time or null",
            assigneeName: "person name or null",
            requesterName: "person name or null",
            confidence: 80,
            sourceEventIds: ["event id"],
            atomType: "todo|reply_needed|commitment",
            privacyClass: "normal|private|sensitive|regulated",
            riskLevel: "low|medium|high",
            scenarioHints: [],
          },
        ],
        memories: [
          {
            memoryType:
              "person|preference|project|relationship|commitment|routine|boundary|mistake",
            subject: "person/project/topic",
            content: "Chinese stable long-term memory content",
            confidence: 80,
            tags: ["Chinese tag"],
            sourceEventIds: ["event id"],
            atomType:
              "fact|preference|relationship|commitment|risk|decision",
            privacyClass: "normal|private|sensitive|regulated",
            riskLevel: "low|medium|high",
            scenarioHints: [],
            expiresAt: "ISO time or null",
          },
        ],
      },
      null,
      2,
    ),
    "",
    analysis
      ? `Stage-one analysis for reference only:\n${JSON.stringify(analysis)}`
      : "",
    "Events:",
    events.map(eventLine).join("\n"),
  ].join("\n");
}
function parseMaybeDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function callProjectProcessorLlm(input: { events: InteractionEvent[]; signal?:AbortSignal }) {
  const provider = getModelProvider(isTauriMode());
  const analysisResponse = await generateText({
    abortSignal: input.signal,
    model: provider.languageModel("chat-model"),
    messages: [
      {
        role: "system",
        content:
          "You are a careful Chinese knowledge analyst. Return valid JSON only.",
      },
      { role: "user", content: buildAnalysisPrompt(input.events) },
    ],
    temperature: 0,
    maxOutputTokens: 1_600,
    maxRetries: 2,
  });
  const analysis = analysisSchema.parse(
    extractJsonObject(analysisResponse.text),
  );
  const prompt = buildProcessorPrompt(input.events, analysis);
  const messages: ModelMessage[] = [
    {
      role: "system",
      content:
        "You are a careful Chinese Owner Context processor. Return valid JSON only, with no Markdown or explanation.",
    },
    { role: "user", content: prompt },
  ];
  const response = await generateText({
    abortSignal: input.signal,
    model: provider.languageModel("chat-model"),
    messages,
    temperature: 0,
    maxOutputTokens: parsePositiveIntEnv(
      "INTERACTION_PROCESSOR_LLM_MAX_TOKENS",
      1_600,
    ),
    maxRetries: 2,
  });
  const raw = extractJsonObject(response.text);
  return {
    model: "chat-model",
    plan: processorSchema.parse(raw),
    analysis,
  };
}

async function callAnthropicCompatibleProcessorText(input: {
  signal?: AbortSignal;
  config: LocalModelProviderConfig;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  system: string;
  maxOutputTokens: number;
}) {
  const timeoutMs = parsePositiveIntEnv(
    "INTERACTION_PROCESSOR_LLM_TIMEOUT_MS",
    25_000,
  );
  const response = await fetch(buildAnthropicMessagesUrl(input.config.baseUrl), {
    method: "POST",
    headers: {
      "x-api-key": input.config.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.config.model,
      system: input.system,
      max_tokens: input.maxOutputTokens,
      temperature: 0,
      messages: input.messages,
    }),
    signal: input.signal ? AbortSignal.any([input.signal,AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = payload as { error?: { message?: unknown } } | null;
    throw new Error(
      typeof error?.error?.message === "string"
        ? error.error.message
        : `Interaction processor LLM returned HTTP ${response.status}`,
    );
  }

  const content = (
    payload as {
      content?: Array<{ type?: string; text?: unknown }>;
    } | null
  )?.content;
  const text = content
    ?.map((part) =>
      part.type === "text" && typeof part.text === "string" ? part.text : "",
    )
    .join("")
    .trim();

  if (!text) {
    throw new Error("Interaction processor LLM returned an empty result.");
  }

  return text;
}

async function callAnthropicCompatibleProcessorLlm(input: {
  signal?: AbortSignal;
  config: LocalModelProviderConfig;
  events: InteractionEvent[];
}) {
  const analysisText = await callAnthropicCompatibleProcessorText({
    signal: input.signal,
    config: input.config,
    system: "You are a careful Chinese knowledge analyst. Return valid JSON only.",
    messages: [
      {
        role: "user",
        content: buildAnalysisPrompt(input.events),
      },
    ],
    maxOutputTokens: 1_600,
  });
  const analysis = analysisSchema.parse(extractJsonObject(analysisText));
  const responseText = await callAnthropicCompatibleProcessorText({
    signal: input.signal,
    config: input.config,
    system:
      "You are a careful Chinese Owner Context processor. Return valid JSON only, with no Markdown or explanation.",
    messages: [
      {
        role: "user",
        content: buildProcessorPrompt(input.events, analysis),
      },
    ],
    maxOutputTokens: parsePositiveIntEnv(
      "INTERACTION_PROCESSOR_LLM_MAX_TOKENS",
      1_600,
    ),
  });

  return {
    model: input.config.model,
    plan: processorSchema.parse(extractJsonObject(responseText)),
    analysis,
  };
}

async function callConfiguredProcessorLlm(input: {
  signal?: AbortSignal;
  userId: string;
  events: InteractionEvent[];
}) {
  const config = await resolveProcessorProviderConfig(input.userId);
  if (config.providerType === "anthropic_compatible") {
    return callAnthropicCompatibleProcessorLlm({
      signal: input.signal,
      config,
      events: input.events,
    });
  }

  const model = createProcessorModel(config);
  const analysisResponse = await generateText({
    model,
    abortSignal: input.signal,
    messages: [
      {
        role: "system",
        content:
          "You are a careful Chinese knowledge analyst. Return valid JSON only.",
      },
      { role: "user", content: buildAnalysisPrompt(input.events) },
    ],
    temperature: 0,
    maxOutputTokens: 1_600,
    maxRetries: 2,
  });
  const analysis = analysisSchema.parse(
    extractJsonObject(analysisResponse.text),
  );
  const response = await generateText({
    model,
    abortSignal: input.signal,
    messages: [
      {
        role: "system",
        content:
          "You are a careful Chinese Owner Context processor. Return valid JSON only, with no Markdown or explanation.",
      },
      {
        role: "user",
        content: buildProcessorPrompt(input.events, analysis),
      },
    ],
    temperature: 0,
    maxOutputTokens: parsePositiveIntEnv(
      "INTERACTION_PROCESSOR_LLM_MAX_TOKENS",
      1_600,
    ),
    maxRetries: 2,
  });

  return {
    model: config.model,
    plan: processorSchema.parse(extractJsonObject(response.text)),
    analysis,
  };
}
async function callLegacyProcessorLlm(input: {
  signal?: AbortSignal;
  userId: string;
  events: InteractionEvent[];
}) {
  const config = await resolveProcessorProviderConfig(input.userId);
  const prompt = buildProcessorPrompt(input.events);
  const jsonMode = process.env.INTERACTION_PROCESSOR_LLM_JSON_MODE !== "0";
  const timeoutMs = parsePositiveIntEnv(
    "INTERACTION_PROCESSOR_LLM_TIMEOUT_MS",
    25_000,
  );
  const requestBody = {
    model: config.model,
    temperature: 0,
    max_tokens: parsePositiveIntEnv(
      "INTERACTION_PROCESSOR_LLM_MAX_TOKENS",
      1_600,
    ),
    stream: false,
    messages: [
      {
        role: "system",
        content:
          "You are a careful Chinese Owner Context processor. Return valid JSON only, with no Markdown or explanation.",
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
    signal: input.signal ? AbortSignal.any([input.signal,AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
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
      signal: input.signal ? AbortSignal.any([input.signal,AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    payload = await response.json().catch(() => null);
  }

  if (!response.ok) {
    const error = payload as { error?: { message?: unknown } } | null;
    throw new Error(
      typeof error?.error?.message === "string"
        ? error.error.message
        : `Interaction processor LLM returned HTTP ${response.status}`,
    );
  }

  const choices = (
    payload as {
      choices?: Array<{ message?: { content?: unknown } }>;
    } | null
  )?.choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Interaction processor LLM returned an empty result.");
  }

  return {
    model: config.model,
    plan: processorSchema.parse(extractJsonObject(content)),
    analysis: undefined,
  };
}

async function callProcessorLlm(input: {
  signal?: AbortSignal;
  userId: string;
  events: InteractionEvent[];
}) {
  try {
    return await callConfiguredProcessorLlm(input);
  } catch (configuredError) {
    input.signal?.throwIfAborted();
    try {
      return await callLegacyProcessorLlm(input);
    } catch (legacyError) {
      input.signal?.throwIfAborted();
      try {
        return await callProjectProcessorLlm({ events: input.events, signal:input.signal });
      } catch (projectError) {
        const configuredMessage =
          configuredError instanceof Error
            ? configuredError.message
            : String(configuredError);
        const legacyMessage =
          legacyError instanceof Error
            ? legacyError.message
            : String(legacyError);
        const projectMessage =
          projectError instanceof Error
            ? projectError.message
            : String(projectError);
        throw new Error(
          `Configured processor LLM failed: ${configuredMessage}; legacy processor LLM failed: ${legacyMessage}; project LLM failed: ${projectMessage}`,
        );
      }
    }
  }
}

export async function processInteractionEvents(input: {
  signal?: AbortSignal;
  userId: string;
  eventIds: string[];
  fallbackToSummary?: boolean;
  processingMode?: InteractionProcessingMode;
  processingJobId?: string;
  runtimeInstanceId?: string;
}): Promise<InteractionProcessorResult> {
  input.signal?.throwIfAborted();
  const eventIds = [...new Set(input.eventIds.map((id) => id.trim()))].filter(
    Boolean,
  );
  if (eventIds.length === 0) {
    return {
      mode: "skipped",
      processedEventIds: [],
      notes: [],
      tasks: [],
      memories: [],
    };
  }

  const events = await getInteractionEventsByIds({
    userId: input.userId,
    ids: eventIds,
  });
  const selectedEvents = events.filter((event) => eventIds.includes(event.id));
  if (selectedEvents.length === 0) {
    return {
      mode: "skipped",
      processedEventIds: [],
      notes: [],
      tasks: [],
      memories: [],
      error: "No accessible events to process.",
    };
  }

  const processingMode = input.processingMode ?? "full";
  input.signal?.throwIfAborted();
  const pendingJob = input.processingJobId
    ? { id: input.processingJobId }
    : await createInteractionProcessingJob({
        userId: input.userId,
        eventIds: selectedEvents.map((event) => event.id),
        processingMode,
      });
  input.signal?.throwIfAborted();
  const claimedJob = await claimInteractionProcessingJob({
    userId: input.userId,
    jobId: pendingJob.id,
    runtimeInstanceId: input.runtimeInstanceId,
  });
  if (!claimedJob) {
    throw new Error("Interaction processing job is not runnable");
  }

  let writesStarted = false;
  const attempt = {userId:input.userId,jobId:claimedJob.id,attempt:claimedJob.attempts,...(input.runtimeInstanceId?{runtimeInstanceId:input.runtimeInstanceId}:{})};
  const assertWrites = async () => {
    input.signal?.throwIfAborted();
    await assertInteractionProcessingWrites(attempt);
  };
  const beginWrites = async () => {
    input.signal?.throwIfAborted();
    await beginInteractionProcessingWrites(attempt);
    writesStarted = true;
  };
  let canFallback=false;
  const applyFallback=async(error:unknown,saved?:Record<string,unknown>):Promise<InteractionProcessorResult>=>{
    const contextHash=await interactionPlanContext(input.userId,selectedEvents,processingMode);
    const payload=saved??{version:1,mode:'fallback_summary',contextHash,processingMode,error:error instanceof Error?error.message:String(error)};
    if(payload.contextHash!==contextHash)throw Error('interaction_plan_context_changed');
    await saveInteractionProcessingPlan({...attempt,payload});
    await beginWrites();
    return applyInteractionProcessingWrites(attempt,async()=>{
      if(await interactionPlanContext(input.userId,selectedEvents,processingMode)!==payload.contextHash)throw Error('interaction_plan_context_changed');
      const note=await createInteractionSummaryNoteFromEvents({userId:input.userId,eventIds:selectedEvents.map(event=>event.id),
        metadata:{processingJobId:claimedJob.id,processingAttempt:claimedJob.attempts}});
      await assertWrites();
      return {mode:'fallback_summary',processedEventIds:selectedEvents.map(event=>event.id),notes:[note],tasks:[],memories:[],error:String(payload.error)};
    });
  };
  try {
    input.signal?.throwIfAborted();
    if(JSON.stringify([...claimedJob.eventIds].sort())!==JSON.stringify(selectedEvents.map(event=>event.id).sort())||claimedJob.processingMode!==processingMode)throw Error('interaction_job_context_mismatch');
    const stored=await readInteractionProcessingPlan(input.userId,claimedJob.id);
    const contextHash=await interactionPlanContext(input.userId,selectedEvents,processingMode);
    const saved=stored?.payload as Record<string,any>|undefined;
    if(saved&&(saved.version!==1||saved.processingMode!==processingMode||saved.contextHash!==contextHash))throw Error('interaction_plan_context_changed');
    if(saved?.mode==='fallback_summary')return await applyFallback(saved.error,saved);
    if(saved&&saved.mode!=='llm')throw Error('interaction_plan_version_unsupported');
    canFallback=!saved;
    const generated=saved?{model:String(saved.model),plan:processorSchema.parse(saved.plan),analysis:saved.analysis?analysisSchema.parse(saved.analysis):undefined}:await callProcessorLlm({signal:input.signal,userId:input.userId,events:selectedEvents});
    canFallback=false;
    const payload=saved??{version:1,mode:'llm',contextHash,processingMode,...generated};
    await saveInteractionProcessingPlan({...attempt,payload});
    const {
      model,
      plan: rawPlan,
      analysis,
    } = generated;
    input.signal?.throwIfAborted();
    const plan = applyInteractionProcessingMode(rawPlan, processingMode);
    const allowedIds = new Set(selectedEvents.map((event) => event.id));
    const source = {
      processingJobId: claimedJob.id,
      processingAttempt: claimedJob.attempts,
      ...sourceFingerprint(selectedEvents),
      ...(await sourcePolicyFingerprint({
        userId: input.userId,
        events: selectedEvents,
      })),
    };
    const cleanIds = (ids: string[]) => [
      ...new Set(ids.filter((id) => allowedIds.has(id))),
    ];

    await beginWrites();
    return await applyInteractionProcessingWrites(attempt, async ():Promise<InteractionProcessorResult> => {
    if(await interactionPlanContext(input.userId,selectedEvents,processingMode)!==contextHash)throw Error('interaction_plan_context_changed');
    const notes = [];
    for (const note of plan.notes) {
      await assertWrites();
      const sourceEventIds = cleanIds(note.sourceEventIds);
      if (sourceEventIds.length === 0) continue;
      notes.push(
        await createInteractionNote({
          userId: input.userId,
          noteType: note.noteType,
          title: note.title,
          body: note.body,
          confidence: note.confidence,
          model,
          sourceEventIds,
          metadata: {
            generatedBy: "owner_context_processor_llm",
            contextLayer: "owner_context.v1",
            ...candidateLayerMetadata({
              layer: "L1",
              privacyClass: note.privacyClass,
              riskLevel: note.riskLevel,
              scenarioHints: note.scenarioHints,
              processingMode,
              model,
              analysisSummary: analysis?.summary,
              extra: source,
            }),
            analysis: analysis
              ? {
                  summary: analysis.summary,
                  topics: analysis.topics,
                  contradictions: analysis.contradictions,
                }
              : undefined,
          },
        }),
      );
    }

    const tasks = [];
    for (const task of plan.tasks) {
      await assertWrites();
      const sourceEventIds = cleanIds(task.sourceEventIds);
      if (sourceEventIds.length === 0) continue;
      tasks.push(
        await createInteractionTask({
          userId: input.userId,
          title: task.title,
          description: task.description ?? null,
          dueAt: parseMaybeDate(task.dueAt),
          assigneeName: task.assigneeName ?? null,
          requesterName: task.requesterName ?? null,
          confidence: task.confidence,
          sourceEventIds,
          metadata: {
            generatedBy: "owner_context_processor_llm",
            contextLayer: "owner_context.v1",
            ...candidateLayerMetadata({
              layer: "L1",
              atomType: task.atomType,
              privacyClass: task.privacyClass,
              riskLevel: task.riskLevel,
              scenarioHints: task.scenarioHints,
              processingMode,
              model,
              analysisSummary: analysis?.summary,
              extra: source,
            }),
            topics: analysis?.topics,
          },
        }),
      );
    }

    const memories = [];
    for (const memory of plan.memories) {
      await assertWrites();
      const sourceEventIds = cleanIds(memory.sourceEventIds);
      if (sourceEventIds.length === 0) continue;
      memories.push(
        await createInteractionBrainMemory({
          userId: input.userId,
          memoryType: memory.memoryType,
          subject: memory.subject,
          content: memory.content,
          confidence: memory.confidence,
          tags: memory.tags,
          sourceEventIds,
          expiresAt: parseMaybeDate(memory.expiresAt),
          metadata: candidateLayerMetadata({
            layer: "L3",
            atomType: memory.atomType,
            privacyClass: memory.privacyClass,
            riskLevel: memory.riskLevel,
            scenarioHints: memory.scenarioHints,
            processingMode,
            model,
            analysisSummary: analysis?.summary,
            extra: source,
          }),
        }),
      );
    }
    const scenarioDrafts = buildInteractionScenarioSnapshots({
      items: [
        ...notes.map(
          (note): InteractionScenarioSourceItem => ({
            id: note.id,
            kind: "note",
            title: note.title,
            content: note.body,
            confidence: note.confidence,
            sourceEventIds: note.sourceEventIds as string[],
            metadata: note.metadata,
          }),
        ),
        ...tasks.map(
          (task): InteractionScenarioSourceItem => ({
            id: task.id,
            kind: "task",
            title: task.title,
            content: task.description ?? task.title,
            status: task.status,
            confidence: task.confidence,
            sourceEventIds: task.sourceEventIds as string[],
            metadata: task.metadata,
          }),
        ),
        ...memories.map(
          (memory): InteractionScenarioSourceItem => ({
            id: memory.id,
            kind: "memory",
            subject: memory.subject,
            content: memory.content,
            status: memory.status,
            confidence: memory.confidence,
            sourceEventIds: memory.sourceEventIds as string[],
            metadata: memory.metadata,
          }),
        ),
      ],
      processingMode,
      model,
    });
    await assertWrites();
    const scenarioSnapshots = await createInteractionScenarioSnapshots({
      userId: input.userId,
      drafts: scenarioDrafts,
    });
    await assertWrites();
    const memoryPromotion = await promoteInteractionMemoryCandidates({
      userId: input.userId,
      limit: 100,
    });

    let graphIndex: InteractionProcessorResult["graphIndex"];
    let graphIndexError: string | undefined;
    if (analysis) {
      try {
        await assertWrites();
        const indexed = await indexInteractionAnalysisToGraph({
          userId: input.userId,
          events: selectedEvents,
          analysis,
          model,
        });
        graphIndex = {
          entities: indexed.entities.length,
          relations: indexed.relations.length,
          evidence: indexed.evidence.length,
        };
      } catch (graphError) {
        graphIndexError =
          graphError instanceof Error ? graphError.message : String(graphError);
        console.warn("[InteractionGraph] Failed to index analysis", graphError);
      }
    }

    await assertWrites();
    return {
      mode: "llm",
      model,
      processedEventIds: selectedEvents.map((event) => event.id),
      notes,
      tasks,
      memories,
      scenarioSnapshots: {
        createdCount: scenarioSnapshots.length,
        scenarioKeys: scenarioDrafts.map(
          (draft) => `${draft.scenarioType}:${draft.scenarioKey}`,
        ),
      },
      memoryPromotion,
      graphIndex,
      graphIndexError,
    };
    });
  } catch (error) {
    if (canFallback && !writesStarted && !input.signal?.aborted && input.fallbackToSummary !== false) {
      try {
        return await applyFallback(error);
      } catch (fallbackError) { error=fallbackError; }
    }
    await failInteractionProcessingJob({
      userId: input.userId,
      jobId: claimedJob.id,
      attempt: claimedJob.attempts,
      error,
      retryAt: new Date(Date.now() + 60_000),
    });
    throw error;
  }
}
