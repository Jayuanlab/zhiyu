import { WORKSHOP_ALLOWED_TOOLS } from "./executor-tools";
import type { ExecutionLease } from "@/lib/work-runtime/execution-lease";
import {createExecutionGuard} from "@/lib/work-runtime/execution-guard";
import {ExecutionLeaseError} from "@/lib/work-runtime/execution-errors";
import {withExecutionContext} from "@/lib/work-runtime/execution-context";
﻿import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@openzhiyu/ai/agent/types";
import { createClaudeAgent } from "@/lib/ai/extensions";
import { normalizeAgentRuntimeError } from "@/lib/ai/agent-runtime-error";
import { buildContextBudgetReport } from "@/lib/ai/context-budget";
import { resolveWorkshopContextProfile } from "@/lib/ai/context-profile";
import {
  resolveAgentModelConfig,
  resolveWorkshopModelTier,
} from "@/lib/ai/model-policy";
import { getUserLlmProviderConfig } from "@/lib/ai/user-llm-api-settings";
import { getUserInsightSettings } from "@/lib/db/insight-queries";
import { getUserTypeForService } from "@/lib/db/user-queries";
import { getAppDir } from "@/lib/env/config/constants";
import { AI_PROXY_BASE_URL, DEFAULT_AI_MODEL } from "@/lib/env/constants";
import { summarizeBrainContextPackForTrace } from "@/lib/brain/context";
import { buildBrainContextFromMemoryRequest } from "@/lib/brain/service";
import { parseBrainRecallProfilesFromModelConfig } from "@/lib/brain/recall-profiles";
import {
  brainContextPackToWorkshopMemoryContextPack,
  createWorkshopBrainRequester,
} from "@/lib/brain/workshop-memory";
import type {
  Workshop,
  WorkshopDirective,
  WorkshopEvent,
  WorkshopMemory,
  WorkshopOutboxItem,
  WorkshopSource,
} from "@/lib/db/schema";
import { buildWorkshopPrompt, extractJsonBlock } from "./context-window";
import { createWorkshopMcpServer } from "./mcp-tools";
import { workDisplayLabel } from "./display-labels";
import { appendWorkshopEvent } from "./service";
import { resolveWorkshopSdkAllowedTools } from "./tool-access";
import { buildWorkshopToolProfile } from "./tool-profile";

type WorkshopStructuredOutput = {
  summary?: string;
  logEvents?: Array<Record<string, unknown>>;
  memoryCandidates?: Array<Record<string, unknown>>;
  outboxDrafts?: Array<Record<string, unknown>>;
  nextWakeupSuggestion?: Record<string, unknown> | null;
};

export type WorkshopExecutionResult = {
  status: "success" | "error";
  output: string;
  structured: WorkshopStructuredOutput | null;
  error?: string;
  toolCallCount: number;
  durationMs: number;
};

function normalizeOptionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePositiveIntEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getWorkshopAgentEnvConfig() {
  return {
    apiKey: normalizeOptionalEnv(
      process.env.ANTHROPIC_API_KEY ??
        process.env.ANTHROPIC_AUTH_TOKEN ??
        process.env.LLM_API_KEY,
    ),
    baseUrl: normalizeOptionalEnv(
      process.env.ANTHROPIC_BASE_URL ?? process.env.LLM_BASE_URL,
    ),
    model: normalizeOptionalEnv(
      process.env.ANTHROPIC_MODEL ?? process.env.LLM_MODEL,
    ),
  };
}

function messageText(message: AgentMessage): string {
  if (message.type !== "text") return "";
  return typeof message.content === "string" ? message.content : "";
}

function compact(value: unknown, maxLength = 700) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function shouldFlushAgentText(text: string, force = false) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (force) return true;
  if (trimmed.length >= 240) return true;
  return /[。！？.!?]\s*$/.test(trimmed);
}

function isEmptyObject(value: unknown) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length === 0
  );
}

function isWorkshopTool(name: string | undefined) {
  return Boolean(
    name &&
    (name.startsWith("mcp__workshop-tools__") ||
      [
        "workshopLogEvent",
        "workshopListSources",
        "workshopGetDirectives",
        "workshopReadLinkedWorkshopEvents",
        "workshopReadMemory",
        "workshopSearchMemory",
        "workshopRecordMemoryRecallFeedback",
        "workshopInspectMemoryRecallQuality",
        "workshopGetMemoryEvidence",
        "workshopListMemoryCandidates",
        "workshopReviewMemory",
        "workshopWriteMemory",
        "workshopCreateLoopTask",
        "workshopCreateOutboxDraft",
        "wechatLocalHealth",
        "wechatRecordNewMessages",
        "wechatListRecordedMessages",
        "wechatMarkMessagesProcessed",
        "interactionProcessRecordedMessages",
        "interactionCreateWikiNote",
        "interactionCreateTaskCandidate",
        "interactionCreateMemoryCandidate",
        "interactionListWiki",
        "wechatLocalCheckNewMessages",
        "wechatLocalSessions",
        "wechatLocalHistory",
        "wechatLocalSearch",
        "wechatCreateReplyDraft",
        "webReadPage",
        "aStockQuote",
        "aStockResearch",
        "aStockSignals",
        "aStockTrend",
        "aStockTrendSystem",
        "aStockTrendStateHistory",
        "aStockTrendStrategyStats",
        "aStockEtfHoldings",
        "aStockFundamentals",
        "aStockNewsAndFilings",
        "aStockMarketMood",
        "quantPaperGetAccount",
        "quantRuleEvaluate",
        "watchlistFollowupTaskUpsert",
        "watchlistFollowupTaskList",
        "watchlistCandidateAgeReview",
        "quantCandidatePoolMaintain",
        "watchlistChangeHistory",
        "watchlistPerformanceReview",
        "quantMarketDiscoverCandidates",
        "quantPaperGetWatchlist",
        "quantPaperProposeWatchlistChange",
        "quantPaperPlaceOrder",
        "quantPaperCancelOrder",
        "videoRenderInvestmentBrief",
        "videoGenerateInvestmentBrief",
        "douyinCheckAccount",
        "douyinCreatePublishDraft",
        "douyinPrepareUpload",
        "douyinPublishApprovedDraft",
      ].includes(name)),
  );
}

function compactToolInput(input: unknown) {
  if (input === undefined || input === null || isEmptyObject(input)) {
    return null;
  }
  return compact(input);
}

function compactToolOutput(output: string | undefined, isError = false) {
  if (!output?.trim()) return null;
  if (isError) return compact(output, 1_200);
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      const rc = parsed.rc;
      const data = parsed.data;
      if (rc !== undefined) {
        return `工具已返回 JSON：rc=${String(rc)}，data=${
          data === null || data === undefined ? "为空" : "已返回"
        }。`;
      }
      return `工具已返回 JSON 输出（${output.length} 个字符）。`;
    }
  } catch {}
  return compact(output, 900);
}

function isTraceableFallbackTool(name: string | undefined) {
  return Boolean(name && ["Bash", "webSearch", "WebFetch"].includes(name));
}

function fallbackSourceTitle(name: string | undefined, input: unknown) {
  const inputText = compact(input, 500).toLowerCase();
  if (name === "Bash" && inputText.includes("reportapi.eastmoney.com")) {
    return "备用数据源：通过命令读取东财研报接口";
  }
  if (name === "Bash" && inputText.includes("eastmoney.com")) {
    return "备用数据源：通过命令读取东财";
  }
  if (name === "Bash") return "备用数据源：命令执行结果";
  return `备用数据源：${name ? workDisplayLabel(name) : "通用工具"}`;
}

function stripStructuredJson(text: string) {
  return text
    .replace(/```json\s*[\s\S]*?```/gi, "")
    .replace(/^\s*\{[\s\S]*\}\s*$/g, "")
    .trim();
}

type WorkshopAgentInput = {
  userId: string;
  workshop: Workshop;
  runId: string;
  sources: WorkshopSource[];
  memories: WorkshopMemory[];
  directives: WorkshopDirective[];
  events: WorkshopEvent[];
  outbox: WorkshopOutboxItem[];
  abortController?: AbortController;
  executionLease?: ExecutionLease;
};
export function executeWorkshopAgent(input: WorkshopAgentInput): Promise<WorkshopExecutionResult> {
  return withExecutionContext(input.executionLease, () => executeWorkshopAgentInContext(input));
}
async function executeWorkshopAgentInContext(input: WorkshopAgentInput): Promise<WorkshopExecutionResult> {
  const startedAt = Date.now();
  const maxToolCalls = parsePositiveIntEnv("WORKSHOP_MAX_TOOL_CALLS", 30);
  const abortController = input.abortController ?? new AbortController();
  if (input.executionLease && (input.executionLease.userId !== input.userId || input.executionLease.workshopId !== input.workshop.id || input.executionLease.runId !== input.runId)) throw new ExecutionLeaseError("invalid_lease");
  const executionGuard = input.executionLease ? createExecutionGuard(input.executionLease, abortController) : undefined;
  await executionGuard?.();
  const sessionId = `workshop-${input.workshop.id}`;
  const sessionDir = join(
    getAppDir(),
    "sessions",
    "workshops",
    input.workshop.id,
    input.runId,
  );
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(join(sessionDir, "temp"), { recursive: true });

  const userSettings = await getUserInsightSettings(input.userId);
  const userAnthropicConfig = await getUserLlmProviderConfig({
    userId: input.userId,
    providerType: "anthropic_compatible",
  });
  const envConfig = getWorkshopAgentEnvConfig();
  const contextProfile = resolveWorkshopContextProfile(input.workshop);
  const modelTier = resolveWorkshopModelTier({
    workshop: input.workshop,
    contextProfile,
  });
  const agentModelConfig = resolveAgentModelConfig({
    tier: modelTier,
    userConfig: userAnthropicConfig,
    envConfig,
    fallbackBaseUrl: AI_PROXY_BASE_URL,
    fallbackModel: DEFAULT_AI_MODEL,
  });
  const agent = createClaudeAgent({
    provider: agentModelConfig.provider,
    baseUrl: agentModelConfig.baseUrl,
    apiKey: agentModelConfig.apiKey,
    model: agentModelConfig.model,
  });
  const userType = await getUserTypeForService(input.userId);
  let memoryContext:
    | Parameters<typeof buildWorkshopPrompt>[0]["memoryContext"]
    | undefined;
  let brainContextError: string | null = null;
  let memoryRecall:
    | {
        backend: "brain";
        contextLogId?: string;
        recallPlan: Awaited<
          ReturnType<typeof buildBrainContextFromMemoryRequest>
        >["recallPlan"];
        selection: Awaited<
          ReturnType<typeof buildBrainContextFromMemoryRequest>
        >["selection"];
        explanation: Awaited<
          ReturnType<typeof buildBrainContextFromMemoryRequest>
        >["explanation"];
        contextPack: ReturnType<typeof summarizeBrainContextPackForTrace>;
        routeResults: Array<{
          route: string;
          purpose: string;
          status: string;
          count: number;
          error: string | null;
        }>;
      }
    | {
        backend: "legacy";
        error: string | null;
      }
    | null = null;
  try {
    const recallProfileResult = parseBrainRecallProfilesFromModelConfig(
      input.workshop.modelConfig,
    );
    const taskIntent = [
      input.workshop.name,
      input.workshop.mission,
      ...input.directives.slice(0, 6).map((directive) => directive.content),
    ]
      .filter(Boolean)
      .join("\n");
    const brainContext = await buildBrainContextFromMemoryRequest({
      requester: createWorkshopBrainRequester(input.workshop),
      taskIntent,
      platformState: {
        platform: "workshop",
        phase: "workshop_prompt",
        riskLevel: "normal",
        notes: input.workshop.mission ?? undefined,
      },
      action: {
        kind: "execute",
        description: "Build the workshop run prompt memory context.",
      },
      maxItems: 12,
      memoryLimit: 200,
      recallProfiles: recallProfileResult.profiles,
      metadata: {
        source: "workshop_prompt",
        workshopId: input.workshop.id,
        runId: input.runId,
        recallProfileIds: recallProfileResult.profiles.map(
          (profile) => profile.id,
        ),
        recallProfileIssueCodes: recallProfileResult.issues.map(
          (issue) => issue.code,
        ),
      },
    });
    if (brainContext.items.length > 0) {
      memoryContext = brainContextPackToWorkshopMemoryContextPack({
        taskIntent,
        pack: brainContext,
      });
    }
    memoryRecall = {
      backend: "brain",
      contextLogId: brainContext.contextLogId,
      recallPlan: brainContext.recallPlan,
      selection: brainContext.selection,
      explanation: brainContext.explanation,
      contextPack: summarizeBrainContextPackForTrace(brainContext),
      routeResults: brainContext.routeResults.map((result) => ({
        route: result.route,
        purpose: result.purpose,
        status: result.status,
        count: result.count,
        error: result.error ?? null,
      })),
    };
  } catch (error) {
    brainContextError = error instanceof Error ? error.message : String(error);
    memoryRecall = {
      backend: "legacy",
      error: brainContextError,
    };
  }
  const prompt = buildWorkshopPrompt({
    workshop: input.workshop,
    sources: input.sources,
    memories: input.memories,
    directives: input.directives,
    events: input.events,
    outbox: input.outbox,
    maxToolCalls,
    memoryContext,
    contextProfile,
  });
  const workshopMcpServer = createWorkshopMcpServer({
    workshop: input.workshop,
    workshopId: input.workshop.id,
    runId: input.runId,
    executionLease: input.executionLease,
  });
  const toolProfile = buildWorkshopToolProfile({
    workshop: input.workshop,
    contextProfile,
    baseTools: WORKSHOP_ALLOWED_TOOLS,
  });
  const allowedTools = resolveWorkshopSdkAllowedTools(
    input.workshop,
    toolProfile.tools,
  );
  const contextBudgetReport = buildContextBudgetReport({
    profile: contextProfile,
    model: agentModelConfig.model,
    prompt,
    maxToolCalls,
    allowedTools,
    toolProfile: toolProfile.name,
    modelTier: agentModelConfig.tier,
    modelSource: agentModelConfig.source,
    inputPriceUsdPerMillionTokens:
      agentModelConfig.inputPriceUsdPerMillionTokens,
    sections: [
      { name: "sources", value: input.sources },
      { name: "memories", value: input.memories },
      { name: "memoryContext", value: memoryContext },
      { name: "directives", value: input.directives },
      { name: "events", value: input.events },
      { name: "outbox", value: input.outbox },
    ],
  });

  await appendWorkshopEvent({
    workshopId: input.workshop.id,
    runId: input.runId,
    type: "agent_configured",
    title: "CC SDK executor configured",
    body: "Preparing workshop context and starting one open exploration run.",
    metadata: {
      maxToolCalls,
      sessionDir,
      memoryBackend: memoryContext ? "brain" : "legacy",
      brainContextError,
      memoryRecall,
      contextBudget: contextBudgetReport,
      toolProfile,
      modelTier: agentModelConfig.tier,
      modelSource: agentModelConfig.source,
      modelPricing: {
        inputUsdPerMillionTokens:
          agentModelConfig.inputPriceUsdPerMillionTokens,
        outputUsdPerMillionTokens:
          agentModelConfig.outputPriceUsdPerMillionTokens,
      },
    },
  });
  await appendWorkshopEvent({
    workshopId: input.workshop.id,
    runId: input.runId,
    type: "context_budget_report",
    title: "Agent context budget report",
    body: `Prompt ${contextBudgetReport.promptChars} chars, approx ${contextBudgetReport.estimatedPromptTokens} tokens.`,
    visibility: "debug",
    metadata: contextBudgetReport,
  });

  let accumulatedText = "";
  let loggedTextOffset = 0;
  let toolCallCount = 0;
  let budgetedToolCallCount = 0;
  const toolUseNames = new Map<string, string>();
  const toolUseInputs = new Map<string, unknown>();
  let hasError = false;
  let errorMessage: string | undefined;

  const flushAgentText = async (force = false) => {
    if (!force) return;
    const nextText = accumulatedText.slice(loggedTextOffset);
    if (!shouldFlushAgentText(nextText, force)) return;
    loggedTextOffset = accumulatedText.length;
    const displayText = stripStructuredJson(nextText);
    if (!displayText) return;
    await appendWorkshopEvent({
      workshopId: input.workshop.id,
      runId: input.runId,
      type: "agent_text",
      title: "Agent final output",
      body: compact(displayText, 4_000),
      metadata: {
        final: true,
      },
    });
  };

  try {
    const generator = agent.run(prompt, {
      sessionId,
      cwd: sessionDir,
      taskId: `workshops/${input.workshop.id}/${input.runId}`,
      conversation: [],
      permissionMode: "bypassPermissions",
      stream: true,
      excludeTools: [
        "wechatDesktopPreviewMessage",
        "wechatDesktopSendMessage",
        "mcp__business-tools__wechatDesktopPreviewMessage",
        "mcp__business-tools__wechatDesktopSendMessage",
      ],
      customMcpServers: {
        "workshop-tools": workshopMcpServer,
      },
      allowedTools,
      session: {
        user: { id: input.userId, type: userType },
        platform: "workshop",
        expires: new Date(Date.now() + 3600000),
      } as any,
      authToken: agentModelConfig.apiKey,
      skillsConfig: {
        enabled: true,
        userDirEnabled: true,
        appDirEnabled: false,
      },
      aiSoulPrompt: userSettings?.aiSoulPrompt ?? null,
      language: userSettings?.language ?? null,
      abortController,
      onBeforeToolUse: executionGuard,
    });

    for await (const message of generator) {
      await executionGuard?.();
      if (message.type === "text") {
        accumulatedText += messageText(message);
        await flushAgentText(false);
      } else if (message.type === "tool_use") {
        await flushAgentText(false);
        toolCallCount += 1;
        if (message.id && message.name) {
          toolUseNames.set(message.id, message.name);
          toolUseInputs.set(message.id, message.input);
        }
        const isInternalWorkshopTool = isWorkshopTool(message.name);
        if (!isInternalWorkshopTool) {
          budgetedToolCallCount += 1;
          await appendWorkshopEvent({
            workshopId: input.workshop.id,
            runId: input.runId,
            type: "tool_call",
            title: message.name
              ? `调用工具：${workDisplayLabel(message.name)}`
              : "调用工具",
            body: compactToolInput(message.input),
            metadata: {
              toolName: message.name,
              toolUseId: message.id,
              toolCallCount,
              budgetedToolCallCount,
            },
          });
        }
        if (budgetedToolCallCount > maxToolCalls) {
          hasError = true;
          errorMessage = `Workshop external tool budget exceeded: ${budgetedToolCallCount}/${maxToolCalls}`;
          abortController.abort(errorMessage);
          break;
        }
      } else if (message.type === "tool_result") {
        await flushAgentText(false);
        const toolName = message.toolUseId
          ? toolUseNames.get(message.toolUseId)
          : undefined;
        if (!isWorkshopTool(toolName)) {
          const body = compactToolOutput(message.output, message.isError);
          const toolResultEvent = await appendWorkshopEvent({
            workshopId: input.workshop.id,
            runId: input.runId,
            type: message.isError ? "tool_error" : "tool_result",
            title: message.isError
              ? `工具失败：${workDisplayLabel(toolName ?? "通用工具")}`
              : `工具完成：${workDisplayLabel(toolName ?? "通用工具")}`,
            body,
            metadata: {
              toolUseId: message.toolUseId,
              toolName,
            },
          });

          if (!message.isError && isTraceableFallbackTool(toolName)) {
            const toolInput = message.toolUseId
              ? toolUseInputs.get(message.toolUseId)
              : undefined;
            await appendWorkshopEvent({
              workshopId: input.workshop.id,
              runId: input.runId,
              type: "source_checked",
              title: fallbackSourceTitle(toolName, toolInput),
              body:
                body ??
                "Generic tool returned data and was captured as a traceable source.",
              metadata: {
                provider: "agent-fallback-tool",
                toolName,
                toolUseId: message.toolUseId,
                toolInput: toolInput ? compact(toolInput, 1_000) : null,
                toolResultEventId: toolResultEvent.id,
                fallback: true,
                note: "Generic tools are allowed when they produce the best result; this event makes that result citable by memories and outbox drafts.",
              },
            });
          }
        }
      } else if (message.type === "error") {
        await flushAgentText(false);
        hasError = true;
        const normalizedError = normalizeAgentRuntimeError(
          message.message || "Workshop agent error",
        );
        errorMessage = normalizedError.message;
        await appendWorkshopEvent({
          workshopId: input.workshop.id,
          runId: input.runId,
          type: "error",
          title: "Agent runtime error",
          body: errorMessage,
          metadata: normalizedError,
        });
      }
    }
    await executionGuard?.();
    await flushAgentText(true);
  } catch (error) {
    if (input.executionLease && abortController.signal.aborted) throw error;
    hasError = true;
    const normalizedError = normalizeAgentRuntimeError(error);
    errorMessage = normalizedError.message;
    await appendWorkshopEvent({
      workshopId: input.workshop.id,
      runId: input.runId,
      type: "error",
      title: "CC SDK execution error",
      body: errorMessage,
      metadata: normalizedError,
    });
  }

  const lastText = accumulatedText;
  const structured = extractJsonBlock(
    lastText,
  ) as WorkshopStructuredOutput | null;
  const output =
    structured?.summary ??
    lastText.trim() ??
    (hasError ? errorMessage : "Workshop run completed") ??
    "Workshop run completed";

  return {
    status: hasError ? "error" : "success",
    output,
    structured,
    error: hasError ? errorMessage : undefined,
    toolCallCount: budgetedToolCallCount,
    durationMs: Date.now() - startedAt,
  };
}
