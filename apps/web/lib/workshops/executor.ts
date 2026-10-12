import { createWorkshopPiTools } from "./pi-domain-tools";
import { PI_LOCAL_TOOL_NAMES, stagePiWorkshopFileSources } from "./pi-local-tools";
import { verifyDocumentCleanerArtifactRun } from "@/lib/loops/document-artifact-verifier";
import { WORKSHOP_ALLOWED_TOOLS } from "./executor-tools";
import type { ExecutionLease } from "@/lib/work-runtime/execution-lease";
import {createExecutionGuard} from "@/lib/work-runtime/execution-guard";
import {ExecutionLeaseError} from "@/lib/work-runtime/execution-errors";
import {withExecutionContext} from "@/lib/work-runtime/execution-context";
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
import { getContextProfileBudget, resolveWorkshopContextProfile } from "@/lib/ai/context-profile";
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
import { buildStructuredExecutionReport } from "@/lib/types/execution-result";
import { prepareWorkspace, workspacePrompt } from "./workspace";
import { AI_PROXY_BASE_URL, DEFAULT_AI_MODEL } from "@/lib/env/constants";
import { summarizeBrainContextPackForTrace } from "@/lib/brain/context";
import { buildBrainContextFromMemoryRequest } from "@/lib/brain/service";
import { resolveWorkshopWorkingMemoryPolicy, WORKING_MEMORY_TOOL_NAME } from './working-memory-policy';
import { getWorkshopBoundaryPolicy } from './boundary-policy';
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
import { buildWorkshopPrompt, extractJsonBlock, WorkshopRequiredInputError } from "./context-window";
import { extractJsonObjectSpan } from "./json-output";
import { createWorkshopRuntimeFinalOutput } from "./runtime-final-output";
import { parseGroundedResearchFinalJson } from "./grounded-final-json";
import { resolveWorkshopResearchContract } from "./research-evidence-verification";
import { validateWorkshopResearchFinal } from "./research-final-validation";
import { resolveWorkshopRuntimeFailure, type WorkshopRuntimeFailure, type WorkshopRuntimeFailureEvent } from "./runtime-failure";
import { buildWorkshopMemoryContextPack } from './memory-context';
import { unavailableInformationReadiness } from '@/lib/brain/information-needs';
import { composeWorkshopRunPrompt, resolveWorkshopRunRole } from "./run-prompt";
import { loadWorkshopRunSkills } from "./run-prompt-skills";
import { createWorkshopMcpServer } from "./mcp-tools";
import { resolveWorkshopRuntimeWithPiGreyDefault } from "./pi-runtime-readiness";
import { persistWorkRunRuntimeSnapshot } from "@/lib/work-runtime/runtime-snapshot";
import type { ChatContinuationInput } from "@/lib/work-runtime/chat-continuation";
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
  researchEvidence?: unknown;
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
  /** Pin the loaded reading contract with the immutable model-output checkpoint. */
  researchEvidenceContext?: { modelConfig: { researchEvidenceContract?: unknown }; taskText: string };
  /** Host-only interpretation bound to the failed runtime and its real receipts. */
  runtimeFailure?: WorkshopRuntimeFailure;
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

/** Adapt the authored report contract to the ordinary Work presentation storage path. */
export function normalizeWorkshopAgentReport(input: {
  workshop: Workshop;
  rawText: string;
  hasError?: boolean;
  errorMessage?: string;
  researchTask?: string;
}): Pick<WorkshopExecutionResult, "structured" | "output"> {
  const contract = resolveWorkshopResearchContract(input.workshop.modelConfig, input.researchTask ?? "");
  const grounded = contract.active && contract.contract?.reportDelivery === "grounded-report/v1";
  const rawStructured = grounded ? parseGroundedResearchFinalJson(input.rawText) : extractJsonBlock(input.rawText);
  const structured = rawStructured as WorkshopStructuredOutput | null;
  const config = input.workshop.modelConfig as Record<string, unknown> | null;
  const preferReportMarkdown =
    !grounded &&
    resolveWorkshopRunRole(input.workshop) === "agent_frontier_researcher" &&
    config?.researchReportStyle === "freeform_project_value";
  if (preferReportMarkdown) {
    const authoredReport = rawStructured?.reportMarkdown;
    const reportMarkdown = typeof authoredReport === "string" && authoredReport.trim()
      ? authoredReport : structured?.presentation?.reportMarkdown;
    const report = buildStructuredExecutionReport({
      structuredData: { ...rawStructured, reportMarkdown },
      cleanText: stripStructuredJson(input.rawText),
      rawText: input.rawText,
      taskText: input.workshop.mission,
      hasError: input.hasError,
      errorMessage: input.errorMessage,
      preferReportMarkdown: true,
    });
    return {
      structured: {
        ...structured,
        summary: report.summary,
        presentation: {
          ...structured?.presentation,
          summary: report.summary,
          reportMarkdown: report.finalMarkdownReport,
        },
      },
      output: report.summary ?? "Workshop run completed",
    };
  }
  return {
    structured,
    output: structured?.summary ?? (input.rawText.trim() ||
      (input.hasError ? input.errorMessage : undefined) || "Workshop run completed"),
  };
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
  continuationContext?: ChatContinuationInput;
  primaryDirectiveId?: string;
};
export function executeWorkshopAgent(input: WorkshopAgentInput): Promise<WorkshopExecutionResult> {
  return withExecutionContext(input.executionLease, () => executeWorkshopAgentInContext(input));
}
async function executeWorkshopAgentInContext(input: WorkshopAgentInput): Promise<WorkshopExecutionResult> {
  const startedAt = Date.now();
  const researchTask = input.directives.find(directive => directive.id === input.primaryDirectiveId)?.content
    ?? input.conversation?.content ?? "";
  const researchConfig = (input.workshop.modelConfig as Record<string, unknown> | null) ?? {};
  const researchEvidenceContext = { modelConfig: Object.hasOwn(researchConfig, 'researchEvidenceContract')
    ? { researchEvidenceContract: researchConfig.researchEvidenceContract } : {}, taskText: researchTask };
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
  const workspace = await prepareWorkspace({ userId: input.userId, workshopId: input.workshop.id, runId: input.runId });
  const sessionDir = workspace.runDir!;
  await appendWorkshopEvent({
    workshopId: input.workshop.id, runId: input.runId, type: "workspace_prepared",
    title: "车间与本轮运行空间已准备", body: sessionDir,
    metadata: { workspace },
  });

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
  const workspaceContext = workspacePrompt(workspace);
  const conversationContext = input.conversation ? formatWorkshopConversation(input.conversation) : "";
  const buildBaseTaskPrompt = (additionalReserveChars = 0) => buildWorkshopPrompt({
    workshop: input.workshop,
    sources: input.sources,
    memories: input.memories,
    directives: input.directives,
    primaryDirectiveId: input.primaryDirectiveId,
    researchTask,
    continuationContext: input.continuationContext,
    promptReserveChars: workspaceContext.length + conversationContext.length + additionalReserveChars + 8,
    events: input.events,
    outbox: input.outbox,
    maxToolCalls,
    memoryContext,
    contextProfile,
    separateSystemPrompt: configuredRuntimeSelection.engine === "pi",
  });
  const baseTaskPrompt = buildBaseTaskPrompt();
  const scopedTaskPrompt = `${baseTaskPrompt}\n\n${workspaceContext}`;
  const taskPrompt = input.conversation ? `${scopedTaskPrompt}\n\n${conversationContext}` : scopedTaskPrompt;
  const workshopMcpServer = createWorkshopMcpServer({
    workshop: input.workshop,
    workshopId: input.workshop.id,
    runId: input.runId,
    executionLease: input.executionLease,
    researchEvidenceContext,
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
    researchEvidenceContext,
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
  let stagedFilePrompt = stagedFiles
    ? configuredConversionTool
      ? `${taskPrompt}\n\nStaged file sourceIds and SHA-256:\n${stagedFiles.staged.map(file => `- ${file.sourceId} sha256=${file.sha256}`).join("\n") || "- No local source files staged."}\n${stagedFiles.warnings.map(warning => `- Unavailable source ${warning.sourceId}: ${warning.reason}`).join("\n")}\n${conversionInstruction} If a required source is unavailable, report that limitation rather than inventing results.`
      : `${taskPrompt}\n\nPi local run directory: ${sessionDir}. Source copies:\n${stagedFiles.staged.map(file => `- ${file.runPath} (sourceId=${file.sourceId}, sha256=${file.sha256})`).join("\n") || "- No local source files staged."}\n${stagedFiles.warnings.map(warning => `- Unavailable source ${warning.sourceId}: ${warning.reason}`).join("\n")}\nOnly use staged copies as input. Write outputs under the run directory and inspect them before reporting completion. If a required source is unavailable, report that limitation rather than inventing results.`
    : taskPrompt;
  if (configuredConversionTool && stagedFilePrompt.length > 160_000) {
    throw new Error(`Document cleaner prompt exceeds 160000 characters for ${stagedFiles?.staged.length ?? 0} staged sources; run a smaller source set.`);
  }
  const loadedRunSkills = runtimeSelection.engine === "pi" ? loadWorkshopRunSkills(input.workshop) : undefined;
  if (input.primaryDirectiveId || input.continuationContext) {
    const assemblyOverhead = runtimeSelection.engine === "pi" ? composeWorkshopRunPrompt({ workshop: input.workshop, prompt: "", researchTask, allowedTools, skills: loadedRunSkills }) : null;
    const finalReserve = (assemblyOverhead?.systemPrompt.length ?? 0) + (assemblyOverhead?.prompt.length ?? 0)
      + Math.max(0, stagedFilePrompt.length - taskPrompt.length) + 4;
    const requiredTaskPrompt = `${buildBaseTaskPrompt(finalReserve)}\n\n${workspaceContext}${input.conversation ? `\n\n${conversationContext}` : ""}`;
    stagedFilePrompt = requiredTaskPrompt + stagedFilePrompt.slice(taskPrompt.length);
  }
  const promptAssembly = runtimeSelection.engine === "pi"
    ? composeWorkshopRunPrompt({
        workshop: input.workshop,
        prompt: stagedFilePrompt,
        researchTask,
        allowedTools,
        skills: loadedRunSkills,
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
  if ((input.primaryDirectiveId || input.continuationContext) && [promptAssembly?.systemPrompt, prompt].filter(Boolean).join("\n\n").length > getContextProfileBudget(contextProfile).promptMaxChars) {
    throw new WorkshopRequiredInputError("required_input_budget_exceeded");
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
  const finalValidationContract = resolveWorkshopResearchContract(researchEvidenceContext.modelConfig, researchTask);
  const workingMemoryPolicy = resolveWorkshopWorkingMemoryPolicy({
    adapter: agentRuntime.metadata.adapter,
    modelConfig: input.workshop.modelConfig,
    taskText: researchTask,
    registeredToolNames: domainPiTools.map(tool => tool.name),
    deniedToolNames: getWorkshopBoundaryPolicy(input.workshop).hardDeniedActions,
  });
  const runtimeAllowedTools = [...allowedTools,
    ...(workingMemoryPolicy.enabled ? [WORKING_MEMORY_TOOL_NAME] : [])];
  const finalValidationPolicy = agentRuntime.metadata.adapter === "pi-agent-harness" &&
    finalValidationContract.active && finalValidationContract.contract?.reportDelivery === "grounded-report/v1"
    ? { maxCorrections: 2 as const, maxExtraForwards: 4, timeoutMs: 600_000, reservedOutputTokens: 16_384,
        maxCompactionForwards: 2, totalCompactionOutputTokens: 4096, compactionOutputTokens: 3072 }
    : null;
  const contextBudgetReport = buildContextBudgetReport({
    profile: contextProfile,
    model: effectiveRuntimeModel,
    prompt: [promptAssembly?.systemPrompt, prompt].filter(Boolean).join("\n\n"),
    maxToolCalls,
    allowedTools: runtimeAllowedTools,
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
    allowedTools: runtimeAllowedTools,
    policy: {
      boundaryPolicy: input.workshop.boundaryPolicy,
      modelConfig: input.workshop.modelConfig,
      toolProfile: toolProfile.name,
      toolClassification: summarizeWorkshopRuntimeToolClassifications(runtimeAllowedTools),
    },
    extra: {
      finalValidationPolicy,
      workingMemoryPolicy,
      runtimeIntrinsicTools: workingMemoryPolicy.enabled ? [WORKING_MEMORY_TOOL_NAME] : [],
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
  let researchToolCallCount = 0;
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
      title: "Agent audit transcript",
      body: compact(displayText, 4_000),
      metadata: {
        final: false,
        transcriptEnded: true,
        transcriptChars: nextText.length,
        displayTruncated: displayText.length > 4_000,
      },
    });
  };

  const finalOutputCollector = createWorkshopRuntimeFinalOutput(agentRuntime.metadata);
  const finalValidationEvents: WorkshopRuntimeFailureEvent[] = [];
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
        allowedTools: runtimeAllowedTools,
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
        ...(workingMemoryPolicy.enabled ? { hostWorkingMemory: {
          mode: workingMemoryPolicy.mode,
          readonlyToolNames: workingMemoryPolicy.readonlyToolNames,
          retainedReadCautions: workingMemoryPolicy.retainedReadCautions,
          maxEdits: workingMemoryPolicy.maxEdits,
          maxSummaryChars: workingMemoryPolicy.maxSummaryChars,
          onAudit: async (event: import('@openzhiyu/ai/agent/runtime').HostWorkingMemoryAuditEvent) => {
            abortController.signal.throwIfAborted();
            await executionGuard?.();
            await appendWorkshopEvent({ workshopId: input.workshop.id, runId: input.runId,
              type: event.operation === 'restore' ? 'working_memory_restored' : 'working_memory_updated',
              title: event.operation === 'restore' ? '本轮工作记忆恢复已保存' :
                event.mode === 'shadow' ? '工作记忆影子建议已保存' : '本轮工作记忆整理已保存',
              metadata: { receiptAuthority: 'runtime', ...event,
                semanticStatus: workingMemoryPolicy.semanticStatus, recoveryScope: workingMemoryPolicy.recoveryScope } });
            abortController.signal.throwIfAborted();
            await executionGuard?.();
          },
          onProjection: async (event: import('@openzhiyu/ai/agent/runtime').HostWorkingMemoryProjectionEvent) => {
            abortController.signal.throwIfAborted();
            await executionGuard?.();
            await appendWorkshopEvent({ workshopId: input.workshop.id, runId: input.runId,
              type: 'working_memory_projected', title: '模型请求的工作上下文已准备',
              metadata: { receiptAuthority: 'runtime', ...event, semanticStatus: workingMemoryPolicy.semanticStatus } });
            abortController.signal.throwIfAborted();
            await executionGuard?.();
          },
          onRejected: async (event: import('@openzhiyu/ai/agent/runtime').HostWorkingMemoryRejectedEvent) => {
            abortController.signal.throwIfAborted();
            await executionGuard?.();
            await appendWorkshopEvent({ workshopId: input.workshop.id, runId: input.runId,
              type: 'working_memory_rejected', title: '工作记忆整理未通过宿主检查',
              metadata: { receiptAuthority: 'runtime', ...event, reason: event.code, mode: workingMemoryPolicy.mode } });
            abortController.signal.throwIfAborted();
            await executionGuard?.();
          },
        } } : {}),
        ...(finalValidationPolicy ? { hostFinalValidation: {
          maxCorrections: finalValidationPolicy.maxCorrections,
          maxExtraForwards: finalValidationPolicy.maxExtraForwards,
          timeoutMs: finalValidationPolicy.timeoutMs,
          reserveOutputTokens: () => finalValidationPolicy.reservedOutputTokens,
          boundedCompaction: {
            maxForwards: finalValidationPolicy.maxCompactionForwards,
            totalOutputTokens: finalValidationPolicy.totalCompactionOutputTokens,
            perForwardOutputTokens: finalValidationPolicy.compactionOutputTokens,
          },
          onForward: async (budget: { phase: string; forward: number; maxForwards: number; maxTokens: number; remainingOutputTokens: number }) => {
            abortController.signal.throwIfAborted();
            await executionGuard?.();
            await appendWorkshopEvent({ workshopId: input.workshop.id, runId: input.runId,
              type: "research_final_validation_forward", title: budget.phase === "source_recovery" ? "补读必读原文" :
                budget.phase === "context_compaction" ? "压缩上下文（未生成研究报告）" : "纠正研究报告",
              metadata: { receiptAuthority: "runtime", ...budget } });
          },
          validate: async ({ text, attempt, signal }: { text: string; attempt: number; signal: AbortSignal }) => {
            signal.throwIfAborted();
            await executionGuard?.();
            const sourceEvents = await listWorkshopEvents(input.workshop.id, {
              runId: input.runId, types: ["source_checked", "research_quote_selected"], order: "asc", limit: 1001,
            });
            signal.throwIfAborted();
            let validation = await validateWorkshopResearchFinal({
              ...researchEvidenceContext, workshopId: input.workshop.id, runId: input.runId,
              events: sourceEvents, rawText: text, eventsOverflow: sourceEvents.length > 1000,
            });
            signal.throwIfAborted();
            await executionGuard?.();
            signal.throwIfAborted();
            const validationEvent = await appendWorkshopEvent({ workshopId: input.workshop.id, runId: input.runId,
              type: validation.ok ? "research_final_validation_passed" : "research_final_validation_rejected",
              title: validation.ok ? "候选报告已通过交付预检，等待运行终态" : "候选报告待按实际缺口纠正",
              body: text,
              metadata: { receiptAuthority: "runtime", attempt, ...finalValidationPolicy,
                status: validation.ok ? "ready_for_runtime_commit" : "correction_required",
                semanticStatus: "not_independently_verified", feedback: validation.ok ? null : validation.feedback,
                ...(validation.ok ? {} : { issues: validation.issues }) },
            });
            finalValidationEvents.push(validationEvent);
            signal.throwIfAborted();
            await executionGuard?.();
            return validation;
          },
        } } : {}),
        onBeforeToolUse: async data => {
          await executionGuard?.();
          if (finalValidationPolicy) {
            researchToolCallCount += 1;
            if (researchToolCallCount > maxToolCalls) throw new Error(`Research tool budget exhausted: ${researchToolCallCount}/${maxToolCalls}`);
            await appendWorkshopEvent({ workshopId: input.workshop.id, runId: input.runId,
              type: "research_tool_admitted", title: "研究工具请求通过预算检查",
              metadata: { receiptAuthority: "runtime", toolName: data.toolName, toolUseId: data.toolUseId,
                toolCallCount: researchToolCallCount, maxToolCalls } });
            abortController.signal.throwIfAborted();
            await executionGuard?.();
          }
          if (input.conversation && !isConversationToolAllowed(data.toolName)) {
            throw new Error("临时对话不能自动转为长期记忆、持续任务或外部通知。");
          }
        },
      },
    });

    for await (const message of generator) {
      await executionGuard?.();
      finalOutputCollector.observe(message);
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
          metadata: {
            ...normalizedError,
            ...(message.providerStreamDiagnostics ? { providerStreamDiagnostics: message.providerStreamDiagnostics } : {}),
          },
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

  const finalOutput = finalOutputCollector.finish();
  if (!finalOutput.ok) {
    hasError = true;
    errorMessage = errorMessage ?? finalOutput.error ?? "Runtime final output was not committed.";
  }
  const finalOutputEvent = await appendWorkshopEvent({ workshopId: input.workshop.id, runId: input.runId,
    type: finalOutput.ok ? "agent_final_output" : "agent_final_output_rejected",
    title: finalOutput.ok ? "最终答复已按运行消息边界保存" : "最终答复未通过运行终态核验",
    body: finalOutput.ok ? finalOutput.text : finalOutput.transcript,
    metadata: { receiptAuthority: "runtime", ...finalOutput.metadata,
      finalChars: finalOutput.text.length, transcriptChars: finalOutput.transcript.length,
      error: finalOutput.error ?? null },
  });
  const lastText = finalOutput.text;
  const reportResult = normalizeWorkshopAgentReport({
    workshop: input.workshop,
    researchTask,
    rawText: lastText,
    hasError,
    errorMessage,
  });
  const structured = finalOutput.ok ? reportResult.structured : null;
  let output = finalOutput.ok ? reportResult.output : errorMessage ?? "Runtime final output was not committed.";

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
    toolCallCount: finalValidationPolicy ? researchToolCallCount : budgetedToolCallCount,
    durationMs: Date.now() - startedAt,
    researchEvidenceContext,
    ...(hasError ? { runtimeFailure: resolveWorkshopRuntimeFailure({ runId: input.runId,
      error: errorMessage, events: [...finalValidationEvents, finalOutputEvent] }) } : {}),
  };
}
