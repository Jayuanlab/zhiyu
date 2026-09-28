import { createWorkshopPiTools } from "./pi-domain-tools";
import { PI_LOCAL_TOOL_NAMES, stagePiWorkshopFileSources } from "./pi-local-tools";
import { verifyDocumentCleanerArtifactRun } from "@/lib/loops/document-artifact-verifier";
import { WORKSHOP_ALLOWED_TOOLS } from "./executor-tools";
import type { ExecutionLease } from "@/lib/work-runtime/execution-lease";
import {createExecutionGuard} from "@/lib/work-runtime/execution-guard";
import {ExecutionLeaseError} from "@/lib/work-runtime/execution-errors";
import {withExecutionContext} from "@/lib/work-runtime/execution-context";
﻿import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@openzhiyu/ai/agent/types";
import {
  createPiRuntimeOptionsFromModelConfig,
  type PiModelProtocol,
} from "@openzhiyu/ai/agent/runtime";
import { createAgentRuntime } from "@/lib/ai/runtime/agent-factory";
import { buildAgentRuntimeRunSnapshot } from "@/lib/ai/runtime/run-snapshot";
import {
  summarizeWorkshopRuntimeToolClassifications,
} from "@/lib/workshops/tool-classification";
import { normalizeAgentRuntimeError } from "@/lib/ai/agent-runtime-error";
import { buildContextBudgetReport } from "@/lib/ai/context-budget";
import { resolveWorkshopContextProfile } from "@/lib/ai/context-profile";
import {
  resolveAgentModelConfig,
  resolvePiAgentModelConfig,
  resolveWorkshopAgentRuntime,
  resolveWorkshopModelTier,
} from "@/lib/ai/model-policy";
import { getUserLlmProviderConfig } from "@/lib/ai/user-llm-api-settings";
import { db as database } from "@/lib/db/client";
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
import { extractJsonObjectSpan } from "./json-output";
import { buildWorkshopMemoryContextPack } from './memory-context';
import { unavailableInformationReadiness } from '@/lib/brain/information-needs';
import { composeWorkshopRunPrompt } from "./run-prompt";
import { loadWorkshopRunSkills } from "./run-prompt-skills";
import { createWorkshopMcpServer } from "./mcp-tools";
import { resolveWorkshopRuntimeWithPiGreyDefault } from "./pi-runtime-readiness";
import { persistWorkRunRuntimeSnapshot } from "@/lib/work-runtime/runtime-snapshot";
import { workDisplayLabel } from "./display-labels";
import { appendWorkshopEvent, listWorkshopEvents } from "./service";
import { resolveWorkshopSdkAllowedTools, restrictWorkshopPiRequestedTools } from "./tool-access";
import { buildWorkshopToolProfile } from "./tool-profile";
import {
  createConversationFileSources, formatWorkshopConversation, isConversationToolAllowed,
  parseConversationInputFiles, PERSISTENT_CONVERSATION_TOOLS, type WorkshopConversationContext,
} from "./conversation-input";

type WorkshopStructuredOutput = {
  summary?: string;
  presentation?: Record<string, unknown> | null;
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

function getWorkshopPiAgentEnvConfig() {
  const baseUrl =
    normalizeOptionalEnv(process.env.LLM_BASE_URL) ??
    normalizeOptionalEnv(process.env.WORKSHOP_PLANNER_LLM_BASE_URL) ??
    normalizeOptionalEnv(process.env.INTERACTION_PROCESSOR_LLM_BASE_URL) ??
    normalizeOptionalEnv(process.env.OPENCODE_BASE_URL);
  const openCodeGo = Boolean(baseUrl?.includes("opencode.ai/zen/go"));
  return {
    apiKey:
      normalizeOptionalEnv(process.env.LLM_API_KEY) ??
      normalizeOptionalEnv(process.env.WORKSHOP_PLANNER_LLM_API_KEY) ??
      normalizeOptionalEnv(process.env.INTERACTION_PROCESSOR_LLM_API_KEY) ??
      normalizeOptionalEnv(process.env.OPENCODE_API_KEY),
    baseUrl,
    model:
      normalizeOptionalEnv(process.env.LLM_MODEL) ??
      normalizeOptionalEnv(process.env.WORKSHOP_PLANNER_LLM_MODEL) ??
      normalizeOptionalEnv(process.env.INTERACTION_PROCESSOR_LLM_MODEL) ??
      normalizeOptionalEnv(process.env.OPENCODE_MODEL) ??
      (openCodeGo ? "minimax-m3" : undefined),
    piProtocol:
      normalizePiProtocolEnv(process.env.PI_AGENT_PROTOCOL) ??
      (openCodeGo ? "openai-completions" : undefined),
    providerId:
      normalizeOptionalEnv(process.env.LLM_PROVIDER_ID) ??
      (openCodeGo ? "opencode-go" : undefined),
  };
}

function normalizePiProtocolEnv(
  value: string | undefined,
): PiModelProtocol | undefined {
  return value === "anthropic-messages" ||
    value === "openai-responses" ||
    value === "openai-completions"
    ? value
    : undefined;
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
        "workshopListColleagues",
        "workshopAskColleague",
        "workshopReadCollaborationInbox",
        "workshopRespondCollaboration",
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
  const json = extractJsonObjectSpan(text);
  if (!json) return text.trim();
  return `${text.slice(0, json.start).replace(/```json\s*$/i, "")}${text.slice(json.end).replace(/^\s*```/, "")}`.trim();
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
  conversation?: WorkshopConversationContext;
};
export function executeWorkshopAgent(input: WorkshopAgentInput): Promise<WorkshopExecutionResult> {
  return withExecutionContext(input.executionLease, () => executeWorkshopAgentInContext(input));
}
async function executeWorkshopAgentInContext(input: WorkshopAgentInput): Promise<WorkshopExecutionResult> {
  const startedAt = Date.now();
  if (input.conversation) {
    const config = input.workshop.modelConfig as Record<string, unknown>;
    input = { ...input, workshop: { ...input.workshop, modelConfig: {
      ...config,
      disallowedTools: [...(Array.isArray(config?.disallowedTools) ? config.disallowedTools : []), ...PERSISTENT_CONVERSATION_TOOLS],
    } } };
  }
  const conversationSources = input.conversation ? createConversationFileSources({
    workshopId: input.workshop.id, runId: input.runId, inputFiles: input.conversation.inputFiles,
  }) : undefined;
  const processingSources = conversationSources ?? input.sources;
  const configuredToolCallLimit = parsePositiveIntEnv("WORKSHOP_MAX_TOOL_CALLS", 30);
  const maxToolCalls = (input.workshop.modelConfig as Record<string, unknown> | null)?.role === "document_markdown_cleaner"
    ? Math.max(configuredToolCallLimit, processingSources.filter(source => source.type === "file" && source.enabled).length + 5)
    : configuredToolCallLimit;
  const abortController = input.abortController ?? new AbortController();
  if (input.executionLease && (input.executionLease.userId !== input.userId || input.executionLease.workshopId !== input.workshop.id || input.executionLease.runId !== input.runId)) throw new ExecutionLeaseError("invalid_lease");
  const executionGuard = input.executionLease ? createExecutionGuard(input.executionLease, abortController) : undefined;
  await executionGuard?.();
  const sessionId = input.conversation ? `workshop-conversation-${input.runId}` : `workshop-${input.workshop.id}`;
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
  const userOpenAiConfig = await getUserLlmProviderConfig({
    userId: input.userId,
    providerType: "openai_compatible",
  });
  const envConfig = getWorkshopAgentEnvConfig();
  const piEnvConfig = getWorkshopPiAgentEnvConfig();
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
  const configuredRuntimeSelection = resolveWorkshopAgentRuntime({
    workshop: input.workshop,
  });
  const claudeConfig = {
    provider: agentModelConfig.provider,
    baseUrl: agentModelConfig.baseUrl,
    apiKey: agentModelConfig.apiKey,
    model: agentModelConfig.model,
  };
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
    // An empty authorized result still carries gaps/denials; do not replace it with legacy memories.
    memoryContext = brainContextPackToWorkshopMemoryContextPack({ taskIntent, pack: brainContext });
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
    memoryContext = buildWorkshopMemoryContextPack({ workshop: input.workshop,
      directives: input.directives, events: input.events, memories: input.memories });
    memoryContext.informationReadiness = unavailableInformationReadiness(memoryContext.taskIntent, 'workshop_prompt');
    memoryRecall = {
      backend: "legacy",
      error: brainContextError,
    };
  }
  const baseTaskPrompt = buildWorkshopPrompt({
    workshop: input.workshop,
    sources: input.sources,
    memories: input.memories,
    directives: input.directives,
    events: input.events,
    outbox: input.outbox,
    maxToolCalls,
    memoryContext,
    contextProfile,
    separateSystemPrompt: configuredRuntimeSelection.engine === "pi",
  });
  const taskPrompt = input.conversation ? `${baseTaskPrompt}\n\n${formatWorkshopConversation(input.conversation)}` : baseTaskPrompt;
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
  const legacyAllowedTools = resolveWorkshopSdkAllowedTools(
    input.workshop,
    toolProfile.tools,
  );
  const piRequestedTools = restrictWorkshopPiRequestedTools(input.workshop, legacyAllowedTools);
  const configuredLocalTools = Array.isArray((input.workshop.modelConfig as Record<string, unknown>)?.allowedTools)
    ? ((input.workshop.modelConfig as Record<string, unknown>).allowedTools as unknown[])
        .filter((name): name is string => typeof name === "string" && PI_LOCAL_TOOL_NAMES.some(local => local.toLowerCase() === name.toLowerCase()))
    : [];
  const configuredConversionTool = Array.isArray((input.workshop.modelConfig as Record<string, unknown>)?.allowedTools) &&
    ((input.workshop.modelConfig as Record<string, unknown>).allowedTools as unknown[])
      .some(name => typeof name === "string" && name.toLowerCase() === "workshopconvertdocument");
  const stagedFiles = input.conversation || (configuredRuntimeSelection.engine === "pi" && (configuredLocalTools.length || configuredConversionTool))
    ? await stagePiWorkshopFileSources(sessionDir, processingSources)
    : null;
  if (stagedFiles) {
    await appendWorkshopEvent({
      workshopId: input.workshop.id,
      runId: input.runId,
      type: stagedFiles.warnings.length ? "degraded" : "source_checked",
      title: input.conversation ? "临时任务文件读取回执" : "Pi local file sources staged",
      body: `${stagedFiles.staged.length} file sources staged; ${stagedFiles.warnings.length} unavailable`,
      metadata: { receiptAuthority: "runtime", stagedFiles, ...(input.conversation ? { inputReceipts: [
        ...stagedFiles.staged.map(file => ({ path: file.inputPath, status: "staged", detail: `已读取本轮副本并核验 SHA-256；${file.size} 字节，尚未确认处理完成` })),
        ...stagedFiles.warnings.map(file => ({ path: file.inputPath, status: "failed", detail: file.reason })),
      ] } : {}) },
    });
  }
  const domainPiTools = configuredRuntimeSelection.engine === "pi" ? createWorkshopPiTools({
    workshop: input.workshop, workshopId: input.workshop.id, runId: input.runId,
    executionLease: input.executionLease, allowedTools: piRequestedTools, workDir: sessionDir,
    conversationSources,
  }) : [];
  const allowedTools = configuredRuntimeSelection.engine === "pi" ? domainPiTools.map(tool => tool.name) : legacyAllowedTools;
  const runtimeResolution = resolveWorkshopRuntimeWithPiGreyDefault({
    runtimeSelection: configuredRuntimeSelection,
    tools: allowedTools,
    implementedTools: configuredRuntimeSelection.engine === "pi" ? allowedTools : undefined,
  });
  const runtimeSelection = runtimeResolution.runtimeSelection;
  const conversionInstruction = input.conversation && !parseConversationInputFiles(input.conversation.content).length
    ? "These are reference copies inherited from the selected conversation. Answer the current question directly; call workshopConvertDocument only if the current request needs a new conversion. Do not repeat previous completed actions."
    : "Call workshopConvertDocument with each staged sourceId; verify its receipt, paths, hashes, chunk count, and warnings before reporting completion.";
  const stagedFilePrompt = stagedFiles
    ? configuredConversionTool
      ? `${taskPrompt}\n\nStaged file sourceIds and SHA-256:\n${stagedFiles.staged.map(file => `- ${file.sourceId} sha256=${file.sha256}`).join("\n") || "- No local source files staged."}\n${stagedFiles.warnings.map(warning => `- Unavailable source ${warning.sourceId}: ${warning.reason}`).join("\n")}\n${conversionInstruction} If a required source is unavailable, report that limitation rather than inventing results.`
      : `${taskPrompt}\n\nPi local run directory: ${sessionDir}. Source copies:\n${stagedFiles.staged.map(file => `- ${file.runPath} (sourceId=${file.sourceId}, sha256=${file.sha256})`).join("\n") || "- No local source files staged."}\n${stagedFiles.warnings.map(warning => `- Unavailable source ${warning.sourceId}: ${warning.reason}`).join("\n")}\nOnly use staged copies as input. Write outputs under the run directory and inspect them before reporting completion. If a required source is unavailable, report that limitation rather than inventing results.`
    : taskPrompt;
  if (configuredConversionTool && stagedFilePrompt.length > 160_000) {
    throw new Error(`Document cleaner prompt exceeds 160000 characters for ${stagedFiles?.staged.length ?? 0} staged sources; run a smaller source set.`);
  }
  const promptAssembly = runtimeSelection.engine === "pi"
    ? composeWorkshopRunPrompt({
        workshop: input.workshop,
        prompt: stagedFilePrompt,
        allowedTools,
        skills: loadWorkshopRunSkills(input.workshop),
      })
    : null;
  const prompt = promptAssembly?.prompt ?? stagedFilePrompt;
  const piGreyReadiness = runtimeResolution.piGreyReadiness;
  const piAgentModelConfig = resolvePiAgentModelConfig({
    userConfig: userOpenAiConfig,
    envConfig: piEnvConfig,
    runtimeProtocol: runtimeSelection.piProtocol,
    fallbackModel: agentModelConfig.model,
  });
  const effectiveRuntimeModel =
    runtimeSelection.engine === "pi"
      ? piAgentModelConfig.model
      : agentModelConfig.model;
  const effectiveRuntimeModelSource =
    runtimeSelection.engine === "pi"
      ? piAgentModelConfig.source
      : agentModelConfig.source;
  if (runtimeSelection.engine === "pi" && !piGreyReadiness.eligible) {
    const blockedToolNames = [
      ...piGreyReadiness.blockedTools.map((tool) => tool.toolName),
      ...piGreyReadiness.needsMigrationTools.map((tool) => tool.toolName),
    ];
    const detail =
      blockedToolNames.length > 0
        ? `Pi runtime is not ready for this Work. Blocked or unmigrated tools: ${blockedToolNames.join(", ")}.`
        : "Pi runtime is not ready for this Work.";
    await appendWorkshopEvent({
      workshopId: input.workshop.id,
      runId: input.runId,
      type: "error",
      title: "Pi runtime grey run blocked",
      body: detail,
      metadata: {
        runtimeTrace: true,
        runtimeSelection,
        piGreyReadiness,
      },
    });
    return {
      status: "error",
      output: detail,
      structured: null,
      error: detail,
      toolCallCount: 0,
      durationMs: Date.now() - startedAt,
    };
  }
  let piRuntimeOptions:
    | ReturnType<typeof createPiRuntimeOptionsFromModelConfig>
    | undefined;
  try {
    piRuntimeOptions =
      runtimeSelection.engine === "pi"
        ? createPiRuntimeOptionsFromModelConfig({
            apiKey: piAgentModelConfig.apiKey,
            baseUrl: piAgentModelConfig.baseUrl,
            model: piAgentModelConfig.model,
            protocol: piAgentModelConfig.piProtocol,
            providerId: piAgentModelConfig.providerId,
          })
        : undefined;
  } catch (error) {
    const normalizedError = normalizeAgentRuntimeError(error);
    await appendWorkshopEvent({
      workshopId: input.workshop.id,
      runId: input.runId,
      type: "error",
      title: "Agent runtime configuration blocked",
      body: normalizedError.message,
      metadata: {
        ...normalizedError,
        runtimeSelection,
        modelTier,
        modelSource: effectiveRuntimeModelSource,
      },
    });
    return {
      status: "error",
      output: normalizedError.message,
      structured: null,
      error: normalizedError.message,
      toolCallCount: 0,
      durationMs: Date.now() - startedAt,
    };
  }
  const agentRuntime = createAgentRuntime({
    engine: runtimeSelection.engine,
    claudeConfig,
    pi: piRuntimeOptions
      ? {
          ...piRuntimeOptions,
          systemPrompt: promptAssembly?.systemPrompt,
          tools: domainPiTools,
        }
      : undefined,
  });
  const contextBudgetReport = buildContextBudgetReport({
    profile: contextProfile,
    model: effectiveRuntimeModel,
    prompt: [promptAssembly?.systemPrompt, prompt].filter(Boolean).join("\n\n"),
    maxToolCalls,
    allowedTools,
    toolProfile: toolProfile.name,
    modelTier: agentModelConfig.tier,
    modelSource: effectiveRuntimeModelSource,
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
  const runtimeRunSnapshot = buildAgentRuntimeRunSnapshot({
    runtime: agentRuntime.metadata,
    runtimeSelection,
    model: {
      model: effectiveRuntimeModel,
      tier: agentModelConfig.tier,
      source: effectiveRuntimeModelSource,
    },
    prompt,
    systemPrompt: promptAssembly?.systemPrompt,
    allowedTools,
    policy: {
      boundaryPolicy: input.workshop.boundaryPolicy,
      modelConfig: input.workshop.modelConfig,
      toolProfile: toolProfile.name,
      toolClassification: summarizeWorkshopRuntimeToolClassifications(allowedTools),
    },
    extra: {
      promptAssembly: promptAssembly?.manifest ?? null,
      contextProfile,
      maxToolCalls,
      piTools: piRuntimeOptions
        ? {
            domain: domainPiTools.map(tool => tool.name),
          }
        : null,
    },
  });

  const runtimeConfiguredEvent = await appendWorkshopEvent({
    workshopId: input.workshop.id,
    runId: input.runId,
    type: "agent_configured",
    title: "Agent runtime configured",
    body: "Preparing workshop context and starting one open exploration run.",
    metadata: {
      maxToolCalls,
      sessionDir,
      memoryBackend: memoryRecall?.backend ?? "legacy",
      brainContextError,
      memoryRecall,
      contextBudget: contextBudgetReport,
      toolProfile,
      modelTier: agentModelConfig.tier,
      modelSource: effectiveRuntimeModelSource,
      runtime: agentRuntime.metadata,
      runtimeSelection,
      runtimeRunSnapshot,
      piDomainTools: piRuntimeOptions
        ? {
            enabled: true,
            sourceCount: input.sources.length,
            memoryCount: input.memories.length,
            directiveCount: input.directives.length,
            domainTools: domainPiTools.map(tool => tool.name),
          }
        : null,
      modelPricing: {
        inputUsdPerMillionTokens:
          agentModelConfig.inputPriceUsdPerMillionTokens,
        outputUsdPerMillionTokens:
          agentModelConfig.outputPriceUsdPerMillionTokens,
      },
      piModelSource:
        runtimeSelection.engine === "pi" ? piAgentModelConfig.source : null,
    },
  });
  try {
    await persistWorkRunRuntimeSnapshot(database, {
      workshopId: input.workshop.id,
      runId: input.runId,
      eventId: runtimeConfiguredEvent.id,
      snapshot: runtimeRunSnapshot,
    });
  } catch (error) {
    await appendWorkshopEvent({
      workshopId: input.workshop.id,
      runId: input.runId,
      type: "error",
      title: "运行快照结构化投影写入失败",
      body: error instanceof Error ? error.message : String(error),
      visibility: "debug",
      metadata: {
        runtimeSnapshotPersistenceFailed: true,
        runtimeHash: runtimeRunSnapshot.runtimeHash,
        policyHash: runtimeRunSnapshot.policyHash,
      },
    });
  }
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
    const generator = agentRuntime.run({
      operation: "run",
      prompt,
      options: {
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
        authToken:
          runtimeSelection.engine === "pi"
            ? piAgentModelConfig.apiKey
            : agentModelConfig.apiKey,
        skillsConfig: {
          enabled: true,
          userDirEnabled: true,
          appDirEnabled: false,
        },
        aiSoulPrompt: userSettings?.aiSoulPrompt ?? null,
        language: userSettings?.language ?? null,
        abortController,
        onBeforeToolUse: async data => {
          await executionGuard?.();
          if (input.conversation && !isConversationToolAllowed(data.toolName)) {
            throw new Error("临时对话不能自动转为长期记忆、持续任务或外部通知。");
          }
        },
      },
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
  let output =
    structured?.summary ??
    lastText.trim() ??
    (hasError ? errorMessage : "Workshop run completed") ??
    "Workshop run completed";

  if (input.conversation && parseConversationInputFiles(input.conversation.content).length && stagedFiles?.warnings.length) {
    const detail = stagedFiles.warnings.map(warning => `${warning.inputPath ?? warning.sourceId}: ${warning.reason}`).join("\n");
    hasError = true;
    errorMessage = `本次任务的文件未全部读取成功：\n${detail}`;
    output = `${output}\n\n${errorMessage}`;
  }

  if ((input.workshop.modelConfig as Record<string, unknown> | null)?.role === "document_markdown_cleaner" &&
      (!input.conversation || input.conversation.inputFiles.length > 0)) {
    try {
      const conversionEvents = await listWorkshopEvents(input.workshop.id, {
        runId: input.runId, types: ["document_converted"], limit: 1001,
      });
      const shouldVerify = !input.conversation || parseConversationInputFiles(input.conversation.content).length > 0 || conversionEvents.length > 0;
      const artifactIssues = shouldVerify ? await verifyDocumentCleanerArtifactRun({
        runDir: sessionDir,
        events: conversionEvents.filter((event: WorkshopEvent) => event.runId === input.runId),
      }) : [];
      if (artifactIssues.length > 0) {
        const detail = artifactIssues.slice(0, 5).map(issue => issue.message).join("; ");
        const summary = `Document conversion verification failed: ${detail}${artifactIssues.length > 5 ? `; ${artifactIssues.length - 5} more issues` : ""}`;
        hasError = true;
        errorMessage = errorMessage ? `${errorMessage}; ${summary}` : summary;
        output = `${output}\n\n${summary}`;
        await appendWorkshopEvent({
          workshopId: input.workshop.id, runId: input.runId, type: "error",
          title: "Document conversion verification failed", body: summary,
          metadata: { issues: artifactIssues },
        });
      }
    } catch (error) {
      const summary = `Document conversion verification could not run: ${error instanceof Error ? error.message : String(error)}`;
      hasError = true;
      errorMessage = errorMessage ? `${errorMessage}; ${summary}` : summary;
      output = `${output}\n\n${summary}`;
      await appendWorkshopEvent({
        workshopId: input.workshop.id, runId: input.runId, type: "error",
        title: "Document conversion verification unavailable", body: summary,
      });
    }
  }

  return {
    status: hasError ? "error" : "success",
    output,
    structured,
    error: hasError ? errorMessage : undefined,
    toolCallCount: budgetedToolCallCount,
    durationMs: Date.now() - startedAt,
  };
}
