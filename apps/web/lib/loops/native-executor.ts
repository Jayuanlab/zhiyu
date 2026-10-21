import { createHash } from "node:crypto";
import { fileSourceDescriptors } from '@/lib/memory/files/descriptors';
import { commandPayloadHash } from '@/lib/work-runtime/command-payload';
import { createWorkshopPiTools } from "@/lib/workshops/pi-domain-tools";
import {prepareBusinessCheckpoint,scopedBusinessCheckpoint,verifyBusinessCheckpointReceipt,projectBusinessCheckpointQuestions} from '@/lib/memory/continuity/business-checkpoint';
import {getWorkshopEvent} from '@/lib/workshops/service';
import {validateResearchOutput} from './research-output-validation';
import {researchProviderRecoveryPolicy} from '@/lib/ai/research-provider-recovery-policy';
import { researchToolInput, researchToolResult } from "./research-tool-evidence";
import { PI_LOCAL_TOOL_NAMES, stagePiWorkshopFileSources } from "@/lib/workshops/pi-local-tools";
import { buildWorkshopMemoryContextPack, resolveWorkingMemoryClaimGuard } from '@/lib/workshops/memory-context';
import { resolveLoopMemoryRecallRiskLevel } from './memory-recall-risk';
import { formatInformationReadiness, unavailableInformationReadiness } from '@/lib/memory/retrieval/information-needs';
import { composeWorkshopRunPrompt, resolveWorkshopRunRole } from "@/lib/workshops/run-prompt";
import { loadWorkshopRunSkills } from "@/lib/workshops/run-prompt-skills";
import { resolveWorkshopWorkingMemoryPolicy, WORKING_MEMORY_TOOL_NAME } from "@/lib/workshops/working-memory-policy";
import { loadWorkingMemoryContinuity, formatWorkingMemoryContinuityGuidance, type WorkingMemoryContinuityResult } from "@/lib/memory/continuity/working-memory";
import { buildHostContinuityRuntimeBinding, continuityControllerHash } from "@/lib/workshops/continuity-runtime-binding";
import { createContinuitySourceVerifier } from "@/lib/memory/continuity/source-validation";
import { checkWorkingMemoryDelivery, type WorkingMemoryDeliveryResult } from "@/lib/workshops/working-memory-delivery-contract";
import type { WorkingMemorySnapshot } from "@openzhiyu/ai/agent/runtime/host-working-memory";
import type { WorkshopEvent } from "@/lib/workshops/run-history-types";
import {resolveExecutionLease} from '@/lib/work-runtime/execution-context';
import {ExecutionLeaseError} from '@/lib/work-runtime/execution-errors';
import {createExecutionGuard} from '@/lib/work-runtime/execution-guard';
import type { AgentMessage, AgentRuntimeTerminal } from "@openzhiyu/ai/agent/types";
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
import {
  type ContextProfile,
  resolveLoopContextProfile,
} from "@/lib/ai/context-profile";
import {
  resolveAgentModelConfig,
  resolveLoopAgentRuntime,
  resolveLoopModelTier,
  resolvePiAgentModelConfig,
} from "@/lib/ai/model-policy";
import { getUserLlmProviderConfig } from "@/lib/ai/user-llm-api-settings";
import { db as database } from "@/lib/db/client";
import { getUserInsightSettings } from "@/lib/db/insight-queries";
import { getUserTypeForService } from "@/lib/db/user-queries";
import { prepareWorkspace, workspacePrompt } from "@/lib/workshops/workspace";
import { AI_PROXY_BASE_URL, DEFAULT_AI_MODEL } from "@/lib/env/constants";
import { summarizeBrainContextPackForTrace } from "@/lib/memory/context/pack";
import { buildBrainContextFromMemoryRequest } from "@/lib/memory/retrieval/recall";
import { workMemorySourceFilters, workMemoryApplicabilityHash, memoryApplicabilityMatches } from '@/lib/memory/context/runtime-applicability';
import { parseBrainRecallProfilesFromModelConfig } from "@/lib/memory/retrieval/recall-profiles";
import { brainContextPackToWorkshopMemoryContextPack } from "@/lib/memory/context/workshop-memory";
import { createWorkshopBrainRequester } from "@/lib/memory/records/workshop-memory";
import { assertMemoryDispatchCurrent, bindMemoryDispatchRuntime, withMemoryDispatchContext } from '@/lib/memory/context/dispatch';
import { admitHostSourceRows } from '@/lib/memory/sources/host-context';
import { memoryRecallPlanForTrace } from '@/lib/memory/context/dispatch-trace';
import { stripMalformedToolCalls } from "@/lib/utils/tool-names";
import {
  buildStructuredExecutionReport,
  parseStructuredOutput,
  type ExecutionTraceEvent,
} from "@/lib/types/execution-result";
import type { JobExecutionResult } from "@/lib/cron/types";
import type { Loop, LoopState, Workshop, WorkshopSource } from "@/lib/db/schema";
import {
  appendWorkshopEvent,
  getWorkshop,
  listActiveDirectives,
  listWorkshopEvents,
  listWorkshopMemories,
  listWorkshopSources,
} from "@/lib/workshops/service";
import { persistWorkRunRuntimeSnapshot } from "@/lib/memory/continuity/runtime-snapshot";
import { workshopBoundaryToLoopPolicies } from "@/lib/workshops/boundary-policy";
import { createWorkshopMcpServer } from "@/lib/workshops/mcp-tools";
import { resolveWorkshopRuntimeWithPiGreyDefault } from "@/lib/workshops/pi-runtime-readiness";
import { resolveWorkshopSdkAllowedTools, restrictWorkshopPiRequestedTools } from "@/lib/workshops/tool-access";
import { buildWorkshopToolProfile } from "@/lib/workshops/tool-profile";
import type { LoopJson } from "./types";
import { parseLoopSpec, safeParseLoopSpec, parseLoopWorkingMemoryCheckpoint } from "./spec";
import {
  prepareLoopContextWindow,
  prepareLoopWorkshopContext,
  type LoopContextWindowResult,
  type LoopWorkshopContextResult,
} from "./context-window";
import {
  createLoopToolPermissionHandler,
  summarizeLoopToolGate,
  type LoopToolGateDecision,
} from "./tool-gate";
import { buildLoopCurrentTimeContext } from "./time-context";

type LoadedWorkshopLoopContext = {
  workshop: Workshop;
  promptContext: LoopWorkshopContextResult;
  actionPolicy: LoopJson;
  approvalPolicy: LoopJson;
  boundaryMetadata: LoopJson;
  contextProfile: ContextProfile;
  readonlyToolSnapshots: {
    sources: Awaited<ReturnType<typeof listWorkshopSources>>;
    memories: Awaited<ReturnType<typeof listWorkshopMemories>>;
    directives: Awaited<ReturnType<typeof listActiveDirectives>>;
  };
};

export { LOOP_WORKSHOP_ALLOWED_TOOLS } from "@/lib/workshops/executor-tools";
import { LOOP_WORKSHOP_ALLOWED_TOOLS } from "@/lib/workshops/executor-tools";

export interface ExecuteNativeLoopAgentInput {
  userId: string;
  loop: Loop;
  previousState: LoopState | null;
  runId: string;
  abortController?: AbortController;
  attemptContext?: {
    attemptNumber: number;
    maxAttempts: number;
    previousFeedback?: string | null;
    previousResult?: Record<string, unknown> | null;
  };
}

function asPrettyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function buildWorkshopSkillRule(input: {
  workshopContext: LoopWorkshopContextResult | null;
  loopName: string;
}) {
  const workshop = input.workshopContext?.workshop;
  const workshopRecord = asRecord(workshop);
  const modelConfig = asRecord(workshopRecord.modelConfig);
  const primarySkills = stringArray(modelConfig.primarySkills);
  const loopSkillMap = stringRecord(modelConfig.loopSkillMap);
  const mappedSkill = loopSkillMap[input.loopName];
  const activeSkills = mappedSkill ? [mappedSkill] : primarySkills;

  if (activeSkills.length === 0) return "";

  const skillLines = [...new Set(activeSkills)]
    .map((skill) => `- ${skill}`)
    .join("\n");

  return [
    "Workshop primary skills:",
    skillLines,
    mappedSkill
      ? `- This loop is mapped to skill: ${mappedSkill}. Before collecting market/account data, call the Skill tool with this exact skill name and follow its workflow unless the Skill tool is unavailable.`
      : "- Before collecting market/account data, call the Skill tool for the most relevant skill above and follow its workflow unless the Skill tool is unavailable.",
    "- If the Skill tool fails or is unavailable, continue only with the same conservative rules and log `methodologyLoaded: skill unavailable` using workshopLogEvent.",
    "- Do not treat a skill as permission to trade. Tools, boundary policy, data gates, and the loop verification contract still control action.",
  ].join("\n");
}

function compactJson(value: unknown, maxLength = 500): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const text =
      typeof value === "string" ? value : JSON.stringify(value, null, 0);
    const compacted = text.replace(/\s+/g, " ").trim();
    return compacted.length > maxLength
      ? `${compacted.slice(0, maxLength - 1)}…`
      : compacted;
  } catch {
    const text = String(value).replace(/\s+/g, " ").trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  }
}

function traceWorkshopEventType(event: ExecutionTraceEvent) {
  if (event.type === "model_text") return "agent_text";
  if (event.type === "tool_used") return "tool_call";
  if (event.type === "tool_result") {
    return event.status === "error" ? "tool_error" : "tool_result";
  }
  if (
    event.type === "permission_decision" ||
    event.type === "budget_exceeded" ||
    event.type === "error"
  ) {
    return event.status === "error" ? "tool_error" : "agent_trace";
  }
  if (event.type === "completed") return "agent_trace_completed";
  return "agent_trace";
}

function traceWorkshopEventTitle(event: ExecutionTraceEvent) {
  if (event.type === "model_text") return "智能体阶段输出";
  if (event.type === "tool_used") {
    return event.toolName ? `准备调用：${event.toolName}` : "准备调用工具";
  }
  if (event.type === "tool_result") {
    return event.status === "error" ? "工具返回异常" : "工具返回结果";
  }
  if (event.type === "permission_decision") {
    return event.status === "error" ? "工具权限被拒绝" : "工具权限确认";
  }
  if (event.type === "budget_exceeded") return "运行预算触发保护";
  if (event.type === "completed") return "智能体运行过程完成";
  if (event.type === "error") return "智能体运行异常";
  return event.title ?? "智能体运行记录";
}

async function appendRuntimeTraceWorkshopEvent(input: {
  workshopId: string | null;
  loopId: string;
  loopRunId: string;
  event: ExecutionTraceEvent;
}) {
  if (!input.workshopId) return;
  try {
    await appendWorkshopEvent({
      workshopId: input.workshopId,
      loopId: input.loopId,
      loopRunId: input.loopRunId,
      type: traceWorkshopEventType(input.event),
      title: traceWorkshopEventTitle(input.event),
      body: input.event.detail,
      visibility:
        input.event.type === "context_budget_report" ? "debug" : "user",
      metadata: {
        runtimeTrace: true,
        traceType: input.event.type,
        traceTitle: input.event.title ?? null,
        traceStatus: input.event.status ?? null,
        toolName: input.event.toolName ?? null,
        toolUseId: input.event.toolUseId ?? null,
        durationMs: input.event.durationMs ?? null,
        timestamp: input.event.timestamp ?? null,
        ...(input.event.metadata ?? {}),
      },
    });
  } catch (error) {
    console.warn("[LoopNativeExecutor] failed to append runtime trace event", {
      workshopId: input.workshopId,
      loopId: input.loopId,
      loopRunId: input.loopRunId,
      traceType: input.event.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildRequiredFieldOutputRule(requiredFields: string[]) {
  if (requiredFields.length === 0) return "";

  const exampleFields = Object.fromEntries(
    requiredFields.map((field) => [field, `${field} result`]),
  );
  const needsTrendDecision = requiredFields.some((field) =>
    /^trend(Follow|Trade)Decision$/i.test(field),
  );
  const trendDecisionExample = needsTrendDecision
    ? [
        "trendFollowDecision schema:",
        asPrettyJson({
          trendFollowDecision: {
            marketState: "risk_off|mixed|risk_on|overheated|unknown",
            candidateDecisions: [
              {
                code: "159278.SZ",
                positionState: "no_position|holding|open_order|holding_and_order",
                profitState: "positive|negative|flat|unknown",
                availableQuantity: 0,
                lifecycleState:
                  "watch_setup|breakout_confirmed|trend_holding|add_candidate|break_warning|exit_required|avoid|unknown",
                trendScore: 65,
                controlAction:
                  "buy_allowed|hold|add_watch|reduce_watch|sell_watch|blocked",
                decision:
                  "enter|add|hold|tighten_stop|reduce_partial|exit|blocked",
                orderIntent: "buy/sell quantity and limit, or none",
                orderId: "paper order id when submitted",
                blockedReason:
                  "required when no order is submitted for an actionable signal",
                breakWarningHandling:
                  "required for break_warning/reduce_watch/exit_required/broken",
                nextVerification: "next trigger, time, or price condition",
              },
            ],
            orders: [],
            blockedReasons: [],
            nextVerification: [],
          },
        }),
      ].join("\n")
    : "";

  return [
    "Required structured fields:",
    `- The loop verifier requires these exact top-level <structured-output> JSON fields: ${requiredFields.join(", ")}.`,
    "- Include every required field as an exact top-level key in the final JSON, even if the same information is also in summary, outcome, reasoningChain, workshopLogEvent, or Markdown headings.",
    "- If you use workshopLogEvent for these fields, put the exact field name at the start of the event title, for example `marketScanSummary: ...`, and still include the matching top-level JSON key.",
    trendDecisionExample,
    "Required field JSON example:",
    asPrettyJson(exampleFields),
  ]
    .filter(Boolean)
    .join("\n");
}

function buildRequiredSourceToolRule(requiredSources: string[]) {
  if (requiredSources.length === 0) return "";

  const toolLikeSources = requiredSources.filter((source) =>
    /^(mcp__|quant|aStock|workshop|wechat|douyin|video|webRead|Read$|Bash$)/i.test(
      source,
    ),
  );
  const sourceLines = requiredSources.map((source) => `- ${source}`).join("\n");
  const toolLines =
    toolLikeSources.length > 0
      ? [
          "Required source tools:",
          toolLikeSources.map((source) => `- ${source}`).join("\n"),
          "- Call each required source tool during this run before finalizing, unless the tool is unavailable or explicitly denied.",
          "- A source tool is explicitly denied only when the exact tool name appears in actions.denied or the tool gate returns a denial. Do not infer denial from broad words such as trade, buy, or sell.",
          "- If a required source tool cannot be called, state the exact blocker in the final structured output and do not substitute memory, old logs, or prose summaries as the source.",
        ].join("\n")
      : "";

  return [
    "Required verification sources:",
    "- The loop verifier requires evidence from these source names in this same run:",
    sourceLines,
    toolLines,
    "- A prior memory, workshop event, or final report paragraph does not satisfy a required source when the required source is a tool name.",
  ]
    .filter(Boolean)
    .join("\n");
}

function redactedBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return value.replace(/(sk-|Bearer\s+)[\w.-]+/gi, "$1***");
  }
}

function loopContextMetadata(loop: Loop) {
  return asRecord(asRecord(loop.contextConfig).metadata);
}

function mergeLoopContextMetadata<T extends { metadata: Record<string, unknown> }>(
  loop: Loop,
  spec: T,
): T {
  const contextMetadata = loopContextMetadata(loop);
  if (Object.keys(contextMetadata).length === 0) return spec;
  return {
    ...spec,
    metadata: {
      ...contextMetadata,
      ...spec.metadata,
      delivery: asRecord(spec.metadata.delivery).platform
        ? spec.metadata.delivery
        : contextMetadata.delivery,
      createOutboxDraftsFromSuggestedActions:
        spec.metadata.createOutboxDraftsFromSuggestedActions ??
        contextMetadata.createOutboxDraftsFromSuggestedActions,
    },
  };
}

function extractLoopSpec(loop: Loop, state: LoopState | null,
  currentCheckpointContract: ReturnType<typeof parseLoopWorkingMemoryCheckpoint>) {
  const fromState =
    state?.stateJson &&
    typeof state.stateJson === "object" &&
    !Array.isArray(state.stateJson)
      ? (state.stateJson as Record<string, unknown>).loopSpec
      : null;
  const parsed = safeParseLoopSpec(fromState);
  if (parsed.success) {
    // Durable task details retain their legacy precedence, but an explicitly
    // owner-controlled delivery contract is always the current row's policy.
    // Clone before projection so old state remains an immutable observation.
    const verification = { ...parsed.data.verification };
    delete verification.workingMemoryCheckpoint;
    if (currentCheckpointContract) verification.workingMemoryCheckpoint = currentCheckpointContract;
    return mergeLoopContextMetadata(loop, { ...parsed.data, verification });
  }

  return parseLoopSpec({
    version: 1,
    goal: loop.goal,
    trigger: loop.triggerConfig,
    context: loop.contextConfig,
    actions: loop.actionPolicy,
    verification: loop.verificationConfig,
    retry: loop.retryPolicy,
    approval: loop.approvalPolicy,
    escalation: loop.escalationPolicy,
    metadata: loopContextMetadata(loop),
  });
}

export function selectLoopFileSourceScope(input: {
  configuredTools: string[]; allowedActions: string[]; deniedActions: string[]; sources: unknown;
}) {
  const readAllowed = input.configuredTools.some(name => name.toLowerCase() === 'read') &&
    input.allowedActions.some(name => name.toLowerCase() === 'read') &&
    !input.deniedActions.some(name => name.toLowerCase() === 'read');
  if (!readAllowed || !Array.isArray(input.sources)) return null;
  const names = [...new Set(input.sources.map(source => asRecord(source).name)
    .filter((name): name is string => typeof name === 'string' && Boolean(name.trim())))];
  if (names.length > 1000) throw new Error('Loop has more than 1000 declared sources; reduce the source set.');
  return names.length ? names : null;
}

export async function loadWorkshopContextForLoop(input: {
  userId: string;
  loop: Loop;
}): Promise<LoadedWorkshopLoopContext | null> {
  if (!input.loop.workshopId) return null;

  const workshop = await getWorkshop(input.userId, input.loop.workshopId);
  if (!workshop) {
    throw new Error("Workshop not found for loop context");
  }

  const memorySourceFilters = workMemorySourceFilters(workshop.modelConfig);
  const documentCleaner = asRecord(workshop.modelConfig).role === "document_markdown_cleaner";
  const declaredSourceNames = selectLoopFileSourceScope({
    configuredTools: stringArray(asRecord(workshop.modelConfig).allowedTools),
    allowedActions: stringArray(asRecord(input.loop.actionPolicy).allowed),
    deniedActions: [...stringArray(asRecord(input.loop.actionPolicy).denied),
      ...stringArray(asRecord(workshop.boundaryPolicy).hardDeniedActions)],
    sources: asRecord(input.loop.contextConfig).sources,
  });
  let [sources, memories, directives, events] = await Promise.all([
    listWorkshopSources(workshop.id, documentCleaner ? 1001 : declaredSourceNames?.length ?? 20,
      database, documentCleaner ? undefined : declaredSourceNames ?? undefined),
    listWorkshopMemories(workshop.id, 30),
    listActiveDirectives(workshop.id, 25),
    // Same-Work event bodies cannot establish scenario applicability for automatic replay.
    memorySourceFilters ? Promise.resolve([]) : listWorkshopEvents(workshop.id, { limit: 40, order: "latest" }),
  ]);
  if (documentCleaner && sources.length > 1000) {
    throw new Error("Document cleaner has more than 1000 sources; reduce the source set before running this Loop.");
  }
  const sourcePolicy = { requester: { ...createWorkshopBrainRequester(workshop), type: 'loop' as const, id: input.loop.id, workId: workshop.id },
    sourceFilters: memorySourceFilters, purpose: 'loop_prompt_stored_sources' };
  await admitHostSourceRows(sourcePolicy, 'workshops', [workshop]);
  await admitHostSourceRows(sourcePolicy, 'loops', [input.loop]);
  sources = fileSourceDescriptors(sources);
  await admitHostSourceRows(sourcePolicy, 'workshopSources', sources);
  await admitHostSourceRows(sourcePolicy, 'workshopDirectives', directives);
  if (!memorySourceFilters) {
    await admitHostSourceRows(sourcePolicy, 'workshopEvents', events);
    await admitHostSourceRows(sourcePolicy, 'workshopMemories', memories);
  }

  const bridge = workshopBoundaryToLoopPolicies({
    workshop,
    actionPolicy: input.loop.actionPolicy,
    approvalPolicy: input.loop.approvalPolicy,
  });
  const contextProfile = resolveLoopContextProfile(input.loop, workshop);
  const taskIntent = [input.loop.name, input.loop.description, input.loop.goal]
    .filter(Boolean)
    .join("\n");
  const recallProfileResult = parseBrainRecallProfilesFromModelConfig(
    workshop.modelConfig,
  );
  let memoryContext: LoopWorkshopContextResult["memoryContext"] | undefined;
  let memoryRecall: LoopWorkshopContextResult["memoryRecall"] = {
    backend: "legacy",
    fallbackReason: "brain_not_attempted",
  };

  try {
    const brainContext = await buildBrainContextFromMemoryRequest({
      sourceFilters: memorySourceFilters,
      requester: {
        ...createWorkshopBrainRequester(workshop),
        type: "loop",
        id: input.loop.id,
        workId: workshop.id,
      },
      taskIntent,
      platformState: {
        platform: "loop",
        phase: "loop_prompt",
        riskLevel: resolveLoopMemoryRecallRiskLevel(bridge.actionPolicy),
        notes: compactJson({
          loopName: input.loop.name,
          workshopName: workshop.name,
          trigger: input.loop.triggerConfig,
        }),
      },
      action: {
        kind: "execute",
        description: "Build Loop prompt memory context.",
      },
      maxItems: 10,
      memoryLimit: 160,
      recallProfiles: recallProfileResult.profiles,
      metadata: {
        source: "loop_prompt",
        workshopId: workshop.id,
        loopId: input.loop.id,
        recallProfileIds: recallProfileResult.profiles.map(
          (profile) => profile.id,
        ),
        recallProfileIssueCodes: recallProfileResult.issues.map(
          (issue) => issue.code,
        ),
      },
    });

    {
      memoryContext = brainContextPackToWorkshopMemoryContextPack({
        taskIntent,
        pack: brainContext,
      });
      memoryRecall = {
        backend: "brain",
        contextLogId: brainContext.contextLogId,
        recallPlan: memoryRecallPlanForTrace(brainContext.recallPlan),
        selection: brainContext.selection,
        explanation: brainContext.explanation,
        contextPack: summarizeBrainContextPackForTrace(brainContext),
        routeResults: brainContext.routeResults.map((result) => ({
          route: result.route,
          purpose: result.purpose,
          status: result.status,
          count: result.count,
          error: result.error ?? null,
          evidenceQuality: result.evidenceQuality ?? null,
        })),
        fallbackReason: null,
      };
    }
  } catch (error) {
    memoryRecall = {
      // Source failure remains explicit even when local legacy context is retained.
      backend: "legacy",
      fallbackReason: "brain_recall_error",
      error: error instanceof Error ? error.message : String(error),
    };
    memoryContext = buildWorkshopMemoryContextPack({ workshop,
      memories: memorySourceFilters ? [] : memories, directives: memorySourceFilters ? [] : directives,
      events: memorySourceFilters ? [] : events, taskIntent });
    if (memorySourceFilters) memoryContext.openQuestions.push('Scoped Brain recall is unavailable; legacy memory was withheld because its scenario applicability cannot be established.');
    memoryContext.informationReadiness = unavailableInformationReadiness(taskIntent, 'loop_prompt');
  }
  if (memorySourceFilters && memoryContext) {
    memoryContext.openQuestions.push('ambient_event_applicability_unverified: Automatic historical workshop events are withheld because their scenario applicability has not been verified.');
  }

  return {
    workshop,
    promptContext: prepareLoopWorkshopContext({
      workshop,
      sources,
      memories: memorySourceFilters ? [] : memories,
      directives,
      events,
      taskIntent,
      memoryContext,
      memoryRecall,
      contextProfile,
    }),
    actionPolicy: bridge.actionPolicy,
    approvalPolicy: bridge.approvalPolicy,
    boundaryMetadata: bridge.metadata,
    contextProfile,
    readonlyToolSnapshots: {
      sources,
      memories,
      directives,
    },
  };
}

export function buildNativeLoopPrompt(input: {
  loop: Loop;
  loopSpec: ReturnType<typeof parseLoopSpec>;
  contextWindow: LoopContextWindowResult;
  workshopContext: LoopWorkshopContextResult | null;
  sessionDir: string;
  language: string | null;
  maxToolCalls: number;
  workshopRole?: string | null;
  reportStyle?: string | null;
  separateSystemPrompt?: boolean;
  attemptContext?: ExecuteNativeLoopAgentInput["attemptContext"];
}): string {
  const freeformResearchReport = input.workshopRole === "agent_frontier_researcher" &&
    input.reportStyle === "freeform_project_value";
  const currentTime = buildLoopCurrentTimeContext({
    timezone:
      typeof input.loop.triggerConfig?.timezone === "string"
        ? input.loop.triggerConfig.timezone
        : input.loopSpec.trigger.type === "cron"
          ? input.loopSpec.trigger.timezone
          : "Asia/Shanghai",
  });
  const outputLanguage = !freeformResearchReport && input.language?.toLowerCase().startsWith("en")
    ? "English"
    : "Simplified Chinese";
  const approval = input.loopSpec.approval;
  const actions = input.loopSpec.actions;
  const allowsWechatSend = actions.allowed.some(
    (action) =>
      action.toLowerCase().includes("wechatdesktopsendmessage") ||
      action.toLowerCase().includes("workshopcreateoutboxdraft"),
  );
  const externalWritesAllowed =
    approval.externalWrites === "allow" && allowsWechatSend;
  const externalWriteRule = externalWritesAllowed
    ? [
        "- External writes are allowed only because this loop's task policy explicitly allows them.",
        "- Before any external write, verify the exact recipient, destination platform, and message content from the loop spec.",
        "- Record the delivery attempt and result in the structured output.",
      ].join("\n")
    : [
        "- Do not perform external writes such as sending messages, emails, calendar invites, or ticket updates.",
        "- If an external write would be useful, return it as a suggested action only.",
      ].join("\n");
  const paperTradingRule = input.workshopRole === "paper_trader"
    ? [
        "Paper-trading tool contracts:",
        "- quantPaper* tools operate only on the internal simulator; their availability does not authorize real broker actions or watchlist maintenance.",
        "- Use the current Loop's explicit strategy parameters and verification fields. Do not invent fixed action quotas, exposure targets, or trade thresholds from generic examples.",
        "- Distinguish plans, submitted orders, fills, and verified outcomes using current tool receipts. If an authorized action is blocked, report the exact data or rule blocker.",
        "- If trendFollowDecision or rotationDecision is required, populate its required fields from observed state and actual order results; a no-order decision needs a concrete reason.",
      ].join("\n")
    : "";
  const metadata = asRecord(input.loopSpec.metadata);
  const delivery = asRecord(metadata.delivery);
  const deliveryPlatform =
    typeof delivery.platform === "string" ? delivery.platform : null;
  const recipientName =
    typeof delivery.recipientName === "string"
      ? delivery.recipientName.trim()
      : "";
  const mandatoryDeliveryRule =
    deliveryPlatform === "wechat_desktop" && recipientName
      ? externalWritesAllowed
        ? actions.allowed.some((action) =>
            action.toLowerCase().includes("workshopcreateoutboxdraft"),
          )
          ? [
              "Mandatory delivery step:",
              `- This loop is not complete until you call workshopCreateOutboxDraft with channel "wechat_desktop" and recipientName exactly "${recipientName}".`,
              "- First collect or generate the requested content, then create the final WeChat outbox draft for that recipient.",
              "- Use notifyReason='owner_requested' unless the result is an urgent risk notice, and set whyNow to explain that the owner requested this loop result on WeChat.",
              "- Set confidence to at least 85 when the report has current source evidence; use riskLevel \"medium\" for normal research reports and \"high\" only for urgent unresolved risk that should require approval.",
              "- Include sourceEventIds from this run when available; if you omit them, the host may auto-attach recent source_checked events.",
              "- Do not stop after searching, browsing, or writing internal logs. Internal records are context for the final outbox message.",
              "- In the structured output, include a deliver/verify reasoning step that says whether workshopCreateOutboxDraft returned an autoSend result of sent, approval_required, blocked, or failed.",
            ].join("\n")
          : [
              "Mandatory delivery step:",
              `- This loop is not complete until you call wechatDesktopSendMessage with recipientName exactly "${recipientName}".`,
              "- First collect or generate the requested content, then send that final content through desktop WeChat.",
              "- Do not stop after searching, browsing, or drafting. Search results are only context for the final WeChat message.",
              "- In the structured output, include a deliver/verify reasoning step that says whether the WeChat send tool returned success.",
            ].join("\n")
        : [
            "Delivery is requested, but external writes are not allowed for this loop.",
            `- Prepare the message for WeChat recipient "${recipientName}" as a suggested action requiring confirmation.`,
            "- Do not call wechatDesktopSendMessage.",
          ].join("\n")
      : "";
  const retryContext = input.attemptContext?.previousFeedback
    ? [
        "Retry context:",
        asPrettyJson({
          attemptNumber: input.attemptContext.attemptNumber,
          maxAttempts: input.attemptContext.maxAttempts,
          previousFeedback: input.attemptContext.previousFeedback,
          previousResult: input.attemptContext.previousResult,
        }),
        "Use this feedback as an observation from the verifier/checker. Fix the missing or incorrect parts before finishing.",
        "Before repeating a write, read its previous execution receipt. Unknown outcome is not failure; reconcile it before retrying. Memory recall never grants permission or proves an action did not execute.",
      ].join("\n")
    : "";
  const requiredFieldOutputRule = buildRequiredFieldOutputRule(
    stringArray(asRecord(input.loopSpec.verification).requiredFields),
  );
  const requiredSourceToolRule = buildRequiredSourceToolRule(
    stringArray(asRecord(input.loopSpec.verification).requiredSources),
  );
  const workshopSkillRule = input.separateSystemPrompt ? "" : buildWorkshopSkillRule({
    workshopContext: input.workshopContext,
    loopName: input.loop.name,
  });
  const workshopContextText = input.workshopContext
    ? [
        "Workshop context:",
        asPrettyJson({
          workshop: input.separateSystemPrompt
            ? { ...input.workshopContext.workshop, mission: undefined }
            : input.workshopContext.workshop,
          boundaryPolicy: input.workshopContext.boundaryPolicy,
          sources: input.workshopContext.sources,
          memoryContext: input.separateSystemPrompt
            ? { ...input.workshopContext.memoryContext, taskIntent: input.loop.goal }
            : input.workshopContext.memoryContext,
          memoryRecall: input.workshopContext.memoryRecall,
          memories: input.workshopContext.memories,
          directives: input.workshopContext.directives,
          recentEvents: input.workshopContext.recentEvents,
          compacted: input.workshopContext.compacted,
          originalChars: input.workshopContext.originalChars,
          compactedChars: input.workshopContext.compactedChars,
          maxChars: input.workshopContext.maxChars,
          omittedSections: input.workshopContext.omittedSections,
        }),
      ].join("\n")
    : "Workshop context:\nNo workshop context is attached to this loop.";
  const workshopExecutionRules = input.workshopContext && !input.separateSystemPrompt
    ? [
        "- Treat Workshop context as durable background for this loop.",
        "- Workshop sources and memories are default context; the Loop spec remains the task-specific contract.",
        "- If Workshop context conflicts with the Loop spec, prefer the Loop spec for task details but obey the stricter safety or external-action boundary.",
        "- Persistent Workshop directives are owner instructions for this loop. Respect them unless they conflict with explicit Loop verification or safety policy.",
        "- Treat memoryContext as the memory platform's control-state estimate. When memoryRecall.backend is brain, it came from Brain RecallPlan + ContextPack with permissions and canonical deduplication. When it is legacy, treat it as fallback evidence and use workshopSearchMemory for narrower Brain recall before relying on it.",
        "- Use workshopSearchMemory for narrower recall, workshopGetMemoryEvidence before relying on recalled memory for high-impact decisions, and workshopReviewMemory to mark memories verified, weakened, or dismissed after outcome review.",
        "- Write new reusable workshop experience as active memory by default. Use candidate only for owner facts, weak evidence, or information that should wait for stewardship.",
        "- If a recalled memory has no resolvable evidence and the loop action is high impact, treat it as a hypothesis and verify with current sources before acting.",
        "- Prefer durable Workshop memory over owner notifications for reusable findings, preferences, boundaries, strategy rules, data-source lessons, and recurring mistakes.",
        "- Do not create Workshop outbox drafts for routine summaries, completed checks, reusable findings, or status updates. Outbox drafts require notifyReason and whyNow, and should be limited to decisions, approvals, replies, owner-requested notices, or urgent risks.",
        "- External writes must satisfy both the Loop approval/action policy and the Workshop boundary policy. If uncertain, return a suggested action requiring confirmation.",
      ].join("\n")
    : "";

  const reportOutputRule = freeformResearchReport
    ? `- 面向主人写自由组织的完整中文技术研究正文：围绕实际问题展开论证，不固定标题、章节、字数或结论数量，不按内部字段排章节。
- 理解外部材料实际提出的机制、证据、假设与限制，比较知遇当前实现是否已有等价能力，说明材料对项目具体问题的新增价值、适用条件、反例和不成立的情形；不能只介绍摘要或贴论文术语。
- 有增量价值时说明能否被否定的最小验证思路；证据不足时自然说明缺口与下一步，不把未知写成无变化，不冒充已执行实验。
- 不展示工具流水账或验收对勾。使用真实来源和可核查理由支持论点；过程记录不能替代对项目价值的判断。
- 在独立的 <structured-output> JSON 中保留 reportMarkdown、researchProcess、projectAssessment、checkpoint、warnings 五项内部验收记录，可另附简短 summary。researchProcess 使用本轮真实工具回执，其他结构按当前技能与验收合同填写。
- reportMarkdown 保存完整正文原文，展示层会读取它；JSON 外可以有正文，但不要求重复同一文章，也无需再复制到 finalMarkdownReport 或 presentation.reportMarkdown。内部 JSON 字段不是必填正文章节。`
    : `- Produce a complete owner-facing Markdown work report first, then append a <structured-output> JSON block.
- The final Markdown work report is the primary report shown in the workshop. It must be complete enough to read without opening raw event logs.
- Start the Markdown report with one # heading that states the run conclusion. Include these sections when applicable: 当前结论, 关键依据, 指标/规则验证, 已执行动作, 未执行动作及原因, 风险与阻断, 下一步关注.
- Do not make the visible report only a short summary. If data is blocked or empty, explain exactly which source was blocked or empty and whether the conclusion is still reliable.
- The reasoningChain is owner-visible work reasoning, not hidden chain-of-thought. Write concise, auditable reasons for each major step: what question you were trying to answer, why that source/tool was needed, what you observed, and how it affected the conclusion.
- Do not use reasoningChain as a tool log. Tool names belong in sourceLabel; the step summary and description must explain the business/decision reason.

The <structured-output> JSON should include:
{
  "summary": "short result summary",
  "finalMarkdownReport": "the same complete Markdown work report shown above, without the structured-output block",
  "outcome": "what changed or what was learned",
  "riskAssessment": "risk assessment, trade-off, or why no risky action was taken",
  "actionTaken": "the concrete action taken, or 'no operation' with the reason",
  "reasoningChain": [
    {
      "summary": "step summary",
      "description": "why this step was needed, what was checked, and what it changed in the judgment",
      "sourceType": "insight|memory|connector|file|tool|system",
      "sourceLabel": "source name",
      "stepType": "input|collect|analyze|generate|deliver|verify"
    }
  ],
  "suggestedActions": [
    {
      "type": "custom",
      "label": "action label",
      "content": "draft or next step",
      "requiresConfirmation": true
    }
  ]
}`;

  return `You are executing an Zhiyu Loop Engineering loop.

Output language: ${outputLanguage}

Loop name:
${input.loop.name}

Loop goal:
${input.loop.goal}

Loop spec:
${asPrettyJson(input.loopSpec)}

Current durable state:
${asPrettyJson(input.contextWindow.durableState)}

Context window:
${asPrettyJson({
  compacted: input.contextWindow.compacted,
  originalChars: input.contextWindow.originalChars,
  compactedChars: input.contextWindow.compactedChars,
  maxChars: input.contextWindow.maxChars,
  omittedStateKeys: input.contextWindow.omittedStateKeys,
})}

${workshopContextText}

Execution budget:
${asPrettyJson({
  maxToolCalls: input.maxToolCalls,
})}

Current execution time:
${asPrettyJson(currentTime)}

${retryContext}

${input.workshopContext?.memoryContext.informationReadiness ? formatInformationReadiness(input.workshopContext.memoryContext.informationReadiness) : ''}

Execution workspace:
${input.sessionDir}

Execution rules:
- Use a Codex-style model/tool/observation loop: decide the next action, call tools when needed, read tool results as observations, then continue until the loop success criteria are satisfied or a blocker is explicit.
- Keep tool use within the execution budget. If the budget is not enough, stop and report the concrete blocker instead of looping.
- Before finishing, verify the result against the loop spec verification section and the mandatory delivery rule, if present.
- Stop only when you can produce the final <structured-output> JSON, or when you must report a concrete blocker.
- Treat Current execution time as the authoritative source for dates, weekdays, and timezone. If a report title or summary includes today's date or weekday, use currentTime.localDateWithWeekday exactly; do not infer or guess the weekday from memory.
- If the report, trade plan, nextDayControlPlan, next-session plan, or Monday plan references the next A-share trading session, use currentTime.nextAShareTradingDayWithWeekday exactly. Do not calculate weekdays yourself, and never pair a date with a guessed weekday.
- Collect context using the loop spec context sources when tools are available.
${externalWriteRule}
${paperTradingRule}
${mandatoryDeliveryRule}
${workshopExecutionRules}
${workshopSkillRule}
${requiredFieldOutputRule}
${requiredSourceToolRule}
- You may read, analyze, summarize, and create internal notes/insights only when allowed by the action policy.
${reportOutputRule}

Now execute the loop once.`;
}

function messageText(message: AgentMessage): string {
  if (message.type !== "text") return "";
  return typeof message.content === "string" ? message.content : "";
}

function hasReadableTraceBoundary(text: string) {
  return (
    /\n\s*\n/.test(text) ||
    /^#{1,4}\s+\S/m.test(text) ||
    /[。！？!?]\s*$/.test(text)
  );
}

/** Staging is scoped to a Pi Work grant and this Loop's effective allowlist. */
export async function prepareLoopPiDocumentSources(input: {
  workshop: Pick<Workshop, "modelConfig"> | null;
  runtimeEngine: string;
  allowedActions: readonly string[];
  sources: WorkshopSource[];
  sessionDir: string;
  maxToolCalls: number;
}) {
  const configured = Boolean(input.workshop && input.runtimeEngine === "pi" &&
    stringArray(asRecord(input.workshop.modelConfig).allowedTools)
      .some((name) => name.toLowerCase() === "workshopconvertdocument"));
  const loopAllowed = configured && input.allowedActions
    .some((name) => name.toLowerCase() === "workshopconvertdocument");
  const configuredLocal = input.workshop && input.runtimeEngine === "pi"
    ? stringArray(asRecord(input.workshop.modelConfig).allowedTools)
        .filter(name => PI_LOCAL_TOOL_NAMES.some(local => local.toLowerCase() === name.toLowerCase()))
    : [];
  const localAllowed = configuredLocal.some(name => input.allowedActions.some(action => action.toLowerCase() === name.toLowerCase()));
  const stagedFiles = loopAllowed || localAllowed
    ? await stagePiWorkshopFileSources(input.sessionDir, input.sources)
    : null;
  return {
    workDir: loopAllowed || localAllowed ? input.sessionDir : undefined,
    convertDocuments: loopAllowed && Boolean(stagedFiles?.staged.length),
    stagedFiles,
    maxToolCalls: stagedFiles?.staged.length
      ? Math.max(input.maxToolCalls, stagedFiles.staged.length + 5)
      : input.maxToolCalls,
  };
}

export function appendLoopPiDocumentSourcesToPrompt(
  taskPrompt: string,
  stagedFiles: Awaited<ReturnType<typeof stagePiWorkshopFileSources>> | null,
  convertDocuments = true,
) {
  if (!stagedFiles) return taskPrompt;
  if (!stagedFiles.staged.length) return `${taskPrompt}\n\nmemory_source_unregistered: No registered Work file binding is available; no private local source bytes were staged. Owner import as a managed artifact does not grant Work file permission.\n${stagedFiles.warnings.map(warning => `- Unavailable source ${warning.sourceId}: ${warning.reason}`).join('\n')}`;
  if (!convertDocuments) {
    return `${taskPrompt}\n\nAuthorized immutable file source descriptors (body not yet read):\n${stagedFiles.staged.map(file => `- ${file.runPath} (sourceId=${file.sourceId}, sha256=${file.sha256})`).join("\n") || "- No bound file descriptors available."}\n${stagedFiles.warnings.map(warning => `- Unavailable source ${warning.sourceId}: ${warning.reason}`).join("\n")}\nThese are virtual source locators, not local copies or successful content observations. Read resolves the current formal binding, verifies physical managed bytes and saves a read receipt. If separately granted project-codebase tools are available, Glob/Grep can discover repo/ paths under that separate codebase contract. Original paths never grant arbitrary filesystem access. Missing or changed sources are evidence gaps.`;
  }
  const prompt = `${taskPrompt}\n\nBound immutable file sourceIds and saved SHA-256 (body not yet read):\n${stagedFiles.staged.map(file => `- ${file.sourceId} sha256=${file.sha256}`).join("\n") || "- No bound file descriptors available."}\n${stagedFiles.warnings.map(warning => `- Unavailable source ${warning.sourceId}: ${warning.reason}`).join("\n")}\nThe catalog lists versions, not copied or observed content. Call workshopConvertDocument with each permitted sourceId; it verifies current binding, physical bytes and a read receipt, then saves a separate managed derived artifact. Verify its actual receipt, hashes, chunk count and warnings before reporting completion. Original files are never edited. Missing sources remain explicit gaps.`;
  if (prompt.length > 160_000) {
    throw new Error(`Document cleaner Loop prompt exceeds 160000 characters for ${stagedFiles.staged.length} staged sources; run a smaller source set.`);
  }
  return prompt;
}

function shouldFlushAgentText(text: string, force = false, final = false) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (final) return true;
  if (force) {
    return (
      trimmed.length >= 160 &&
      (hasReadableTraceBoundary(trimmed) || trimmed.length >= 700)
    );
  }
  if (trimmed.length >= 1200) return true;
  return trimmed.length >= 700 && hasReadableTraceBoundary(trimmed);
}

function stripStructuredTraceText(text: string) {
  return text
    .replace(/```json\s*[\s\S]*?```/gi, "")
    .replace(/<structured-output\b[\s\S]*$/i, "")
    .replace(/^\s*<\/structured-output>\s*$/i, "")
    .replace(/^\s*\{[\s\S]*\}\s*$/g, "")
    .trim();
}

export function createLoopAgentTextBuffer() {
  let accumulatedText = "";
  let approvedFinalText: string | null = null;
  let loggedTextOffset = 0;
  let suppressStructuredTrace = false;

  return {
    append(text: string) {
      accumulatedText += text;
    },
    acceptFinalResult(message: AgentMessage) {
      if (message.type !== 'result' || message.answerPhase !== 'candidate_final') return false;
      if (approvedFinalText !== null) throw new Error('[provider_incomplete_output] Duplicate approved final candidate');
      if (typeof message.content !== 'string' || !message.content.trim()) throw new Error('[provider_incomplete_output] Empty approved final candidate');
      approvedFinalText = message.content;
      return true;
    },
    hasFinalCandidate() { return approvedFinalText !== null; },
    finalText() { return approvedFinalText ?? accumulatedText; },
    flush(force = false, options?: { final?: boolean }) {
      if (suppressStructuredTrace) return null;
      const nextText = accumulatedText.slice(loggedTextOffset);
      const marker = nextText.search(/<structured-output\b|```json\b/i);
      const traceText = marker === -1 ? nextText : nextText.slice(0, marker);
      const finalFlush = options?.final === true;
      if (!shouldFlushAgentText(traceText, force, finalFlush)) return null;
      loggedTextOffset = accumulatedText.length;
      if (marker !== -1) suppressStructuredTrace = true;
      return stripStructuredTraceText(traceText) || null;
    },
    text() {
      return accumulatedText;
    },
  };
}

function normalizeOptionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePositiveIntEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getLoopAgentEnvConfig() {
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

function normalizePiProtocolEnv(
  value: string | undefined,
): PiModelProtocol | undefined {
  return value === "anthropic-messages" ||
    value === "openai-responses" ||
    value === "openai-completions"
    ? value
    : undefined;
}

function getLoopPiAgentEnvConfig() {
  const baseUrl =
    normalizeOptionalEnv(process.env.LLM_BASE_URL) ??
    normalizeOptionalEnv(process.env.INTERACTION_PROCESSOR_LLM_BASE_URL) ??
    normalizeOptionalEnv(process.env.WORKSHOP_PLANNER_LLM_BASE_URL) ??
    normalizeOptionalEnv(process.env.OPENCODE_BASE_URL);
  const openCodeGo = Boolean(baseUrl?.includes("opencode.ai/zen/go"));
  return {
    apiKey:
      normalizeOptionalEnv(process.env.LLM_API_KEY) ??
      normalizeOptionalEnv(process.env.INTERACTION_PROCESSOR_LLM_API_KEY) ??
      normalizeOptionalEnv(process.env.WORKSHOP_PLANNER_LLM_API_KEY) ??
      normalizeOptionalEnv(process.env.OPENCODE_API_KEY),
    baseUrl,
    model:
      normalizeOptionalEnv(process.env.LLM_MODEL) ??
      normalizeOptionalEnv(process.env.INTERACTION_PROCESSOR_LLM_MODEL) ??
      normalizeOptionalEnv(process.env.WORKSHOP_PLANNER_LLM_MODEL) ??
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

export function executeNativeLoopAgent(
  input: ExecuteNativeLoopAgentInput,
): Promise<JobExecutionResult> {
  return withMemoryDispatchContext(() => executeNativeLoopAgentInMemoryContext(input));
}
async function executeNativeLoopAgentInMemoryContext(
  input: ExecuteNativeLoopAgentInput,
): Promise<JobExecutionResult> {
  const startedAt = Date.now();
  // Inspect the raw field before legacy spec normalization can discard it.
  const workingMemoryDeliveryContract = parseLoopWorkingMemoryCheckpoint(input.loop.verificationConfig);
  const userSettings = await getUserInsightSettings(input.userId);
  const initialContextProfile = resolveLoopContextProfile(input.loop);
  const workshopContext = await loadWorkshopContextForLoop({
    userId: input.userId,
    loop: input.loop,
  });
  const preferReportMarkdown =
    resolveWorkshopRunRole(workshopContext?.workshop ?? null) === "agent_frontier_researcher" &&
    asRecord(workshopContext?.workshop.modelConfig).researchReportStyle === "freeform_project_value";
  const contextProfile = workshopContext?.contextProfile ?? initialContextProfile;
  const storedBusinessCheckpoint=asRecord(input.previousState?.stateJson).businessCheckpoint;
  const previousStateJson=asRecord(input.previousState?.stateJson);
  const controllerHash=continuityControllerHash(workshopContext?.workshop,input.loop);
  const durableContinuityChanged=!!input.previousState&&(!controllerHash
    ||asRecord(previousStateJson.continuityBinding).controllerHash!==controllerHash);
  const checkpointScope={userId:input.userId,workshopId:input.loop.workshopId??'',loopId:input.loop.id,
    applicabilityHash:workMemoryApplicabilityHash(workshopContext?.workshop.modelConfig)};
  const scopedCheckpoint=durableContinuityChanged?null:scopedBusinessCheckpoint(storedBusinessCheckpoint,checkpointScope);
  const checkpointReceipt=scopedCheckpoint&&typeof scopedCheckpoint.receiptEventId==='string'
    ?await getWorkshopEvent(checkpointScope.workshopId,scopedCheckpoint.receiptEventId):null;
  const verifiedBusinessCheckpoint=durableContinuityChanged?null:verifyBusinessCheckpointReceipt(storedBusinessCheckpoint,checkpointScope,checkpointReceipt);
  const admittedBusinessCheckpoint=verifiedBusinessCheckpoint?projectBusinessCheckpointQuestions(verifiedBusinessCheckpoint):null;
  const priorApplicabilityHash=Object.hasOwn(previousStateJson,'memoryApplicabilityHash')
    ?previousStateJson.memoryApplicabilityHash:asRecord(storedBusinessCheckpoint).applicabilityHash;
  const durableApplicabilityChanged=!!input.previousState&&(durableContinuityChanged||previousStateJson.memoryApplicabilityStatus==='unknown'
    ||!memoryApplicabilityMatches(priorApplicabilityHash,checkpointScope.applicabilityHash));
  // Resolve the effective spec only after the saved state has passed the same
  // applicability fence; otherwise old instructions can survive state cleanup.
  const loopSpec=extractLoopSpec(input.loop,null,workingMemoryDeliveryContract);
  // A different task context must not inherit old summaries, plans or arbitrary
  // model state around a correctly rejected checkpoint. Stored history remains intact.
  const promptState=input.previousState ? { ...input.previousState, currentPhase:'idle', memorySummary:null,
    openQuestions:admittedBusinessCheckpoint ? [...admittedBusinessCheckpoint.progress.nextQuestions,
      ...admittedBusinessCheckpoint.progress.pendingVerification] : [], lastObservation:null, nextAction:null, blockedReason:null,
    stateJson:{ memoryApplicabilityHash:checkpointScope.applicabilityHash,
      previousStateWithheld:durableApplicabilityChanged?'memory_applicability_changed':'historical_free_text_unverified',
      ...(admittedBusinessCheckpoint?{businessCheckpoint:admittedBusinessCheckpoint}:{}) } } : null;
  const contextWindow = prepareLoopContextWindow({
    state: promptState,
    loopSpec,
    contextProfile,
  });
  const businessCheckpointInPrompt=admittedBusinessCheckpoint&&JSON.stringify(contextWindow.durableState.stateJson.businessCheckpoint)===JSON.stringify(admittedBusinessCheckpoint);
  const effectiveLoopSpec = workshopContext
    ? parseLoopSpec({
        ...loopSpec,
        actions: workshopContext.actionPolicy,
        approval: workshopContext.approvalPolicy,
        metadata: {
          ...loopSpec.metadata,
          workshopBoundary: workshopContext.boundaryMetadata,
        },
      })
    : loopSpec;
  const researchEvidenceContext = workshopContext ? {
    modelConfig: workshopContext.workshop.modelConfig,
    taskText: [input.loop.goal, effectiveLoopSpec.context.instructions].filter(Boolean).join("\n"),
  } : undefined;
  let maxToolCalls = parsePositiveIntEnv("LOOP_MAX_TOOL_CALLS", 40);
  const agentAbortController = input.abortController ?? new AbortController();
  const executionLease=resolveExecutionLease();
  if(executionLease&&(executionLease.userId!==input.userId||executionLease.workshopId!==input.loop.workshopId||executionLease.runId!==input.runId))throw new ExecutionLeaseError('invalid_lease');
  const executionGuard=executionLease?createExecutionGuard(executionLease,agentAbortController):undefined;
  await executionGuard?.();
  const sessionId = `loop-${input.loop.id}`;
  const workspace = await prepareWorkspace({ userId: input.userId, workshopId: input.loop.workshopId, loopId: input.loop.id, runId: input.runId });
  const sessionDir = workspace.runDir!;
  if(durableApplicabilityChanged&&input.loop.workshopId)await appendWorkshopEvent({workshopId:input.loop.workshopId,
    runId:executionLease?.runId??input.runId,loopId:input.loop.id,loopRunId:input.runId,type:'loop_memory_applicability_changed',
    title:'旧任务状态未进入本轮上下文：适用范围已变化或无法核对',
    metadata:{receiptAuthority:'runtime',applicabilityHash:checkpointScope.applicabilityHash,reason:'memory_applicability_changed',
      historicalStatePreserved:true,loadedHistoricalAssertions:false}});

  if (input.loop.workshopId) await appendWorkshopEvent({
    workshopId: input.loop.workshopId, loopId: input.loop.id, loopRunId: input.runId, type: "workspace_prepared",
    title: "车间、Loop 与本轮运行空间已准备", body: sessionDir,
    metadata: { workspace },
  });

  const userAnthropicConfig = await getUserLlmProviderConfig({
    userId: input.userId,
    providerType: "anthropic_compatible",
  });
  const userOpenAiConfig = await getUserLlmProviderConfig({
    userId: input.userId,
    providerType: "openai_compatible",
  });
  const envAnthropicConfig = getLoopAgentEnvConfig();
  const piEnvConfig = getLoopPiAgentEnvConfig();
  const modelTier = resolveLoopModelTier({
    loop: input.loop,
    workshop: workshopContext?.workshop ?? null,
    contextProfile,
  });
  const agentModelConfig = resolveAgentModelConfig({
    tier: modelTier,
    userConfig: userAnthropicConfig,
    envConfig: envAnthropicConfig,
    fallbackBaseUrl: AI_PROXY_BASE_URL,
    fallbackModel: DEFAULT_AI_MODEL,
  });
  const agentBaseUrl = agentModelConfig.baseUrl;
  const agentModel = agentModelConfig.model;
  const configuredRuntimeSelection = resolveLoopAgentRuntime({
    loop: input.loop,
    workshop: workshopContext?.workshop ?? null,
  });
  const claudeConfig = {
    provider: agentModelConfig.provider,
    baseUrl: agentBaseUrl,
    apiKey: agentModelConfig.apiKey,
    model: agentModel,
  };

  const userType = await getUserTypeForService(input.userId);
  const workshopMcpServer = workshopContext
    ? createWorkshopMcpServer({
        workshop: workshopContext.workshop,
        workshopId: workshopContext.workshop.id,
        loopId: input.loop.id,
        loopRunId: input.runId,
        runId: executionLease?.runId,
        executionLease,
        researchEvidenceContext,
      })
    : null;
  const toolProfile = workshopContext
    ? buildWorkshopToolProfile({
        workshop: workshopContext.workshop,
        contextProfile,
        baseTools: LOOP_WORKSHOP_ALLOWED_TOOLS,
        requestedTools: [
          ...effectiveLoopSpec.actions.allowed,
          ...effectiveLoopSpec.actions.requiresApproval,
          ...effectiveLoopSpec.verification.requiredSources,
        ],
      })
    : null;
  const legacyAllowedTools = workshopContext
    ? resolveWorkshopSdkAllowedTools(
        workshopContext.workshop,
        toolProfile?.tools ?? LOOP_WORKSHOP_ALLOWED_TOOLS,
      )
    : LOOP_WORKSHOP_ALLOWED_TOOLS;
  await executionGuard?.();
  const documentSources = await prepareLoopPiDocumentSources({
    workshop: workshopContext?.workshop ?? null,
    runtimeEngine: configuredRuntimeSelection.engine,
    allowedActions: effectiveLoopSpec.actions.allowed,
    sources: workshopContext?.readonlyToolSnapshots.sources ?? [],
    sessionDir,
    maxToolCalls,
  });
  await executionGuard?.();
  const stagedFiles = documentSources.stagedFiles;
  maxToolCalls = documentSources.maxToolCalls;
  if (stagedFiles && workshopContext) {
    await appendWorkshopEvent({
      workshopId: workshopContext.workshop.id,
      runId: executionLease?.runId ?? input.runId,
      loopId: input.loop.id,
      loopRunId: input.runId,
      type: stagedFiles.warnings.length ? "degraded" : "source_checked",
      title: "Pi Loop bound file source catalog prepared",
      body: `${stagedFiles.staged.length} authorized immutable source descriptors; ${stagedFiles.warnings.length} unavailable. Catalog preparation has not loaded file bodies.`,
      metadata: { stagedFiles },
    });
  }
  const taskPrompt = buildNativeLoopPrompt({
    loop: input.loop,
    loopSpec: effectiveLoopSpec,
    contextWindow,
    workshopContext: workshopContext?.promptContext ?? null,
    workshopRole: resolveWorkshopRunRole(workshopContext?.workshop ?? null),
    reportStyle: typeof asRecord(workshopContext?.workshop.modelConfig).researchReportStyle === "string"
      ? asRecord(workshopContext?.workshop.modelConfig).researchReportStyle as string : null,
    separateSystemPrompt: configuredRuntimeSelection.engine === "pi",
    sessionDir,
    language: userSettings?.language ?? null,
    maxToolCalls,
    attemptContext: input.attemptContext,
  });
  const scopedTaskPrompt = `${taskPrompt}\n\n${workspacePrompt(workspace)}`;
  const piTaskPrompt = appendLoopPiDocumentSourcesToPrompt(scopedTaskPrompt, stagedFiles, documentSources.convertDocuments);
  const domainPiTools = workshopContext && configuredRuntimeSelection.engine === "pi" ? createWorkshopPiTools({
    workshop: workshopContext.workshop, workshopId: workshopContext.workshop.id,
    runId: executionLease?.runId ?? input.runId, loopId: input.loop.id, loopRunId: input.runId,
    executionLease, allowedTools: restrictWorkshopPiRequestedTools(workshopContext.workshop, legacyAllowedTools),
    workDir: documentSources.workDir,
    researchEvidenceContext,
  }) : [];
  const allowedTools = workshopContext && configuredRuntimeSelection.engine === "pi" ? domainPiTools.map(tool => tool.name) : legacyAllowedTools;
  const runtimeResolution = workshopContext
    ? resolveWorkshopRuntimeWithPiGreyDefault({
        runtimeSelection: configuredRuntimeSelection,
        tools: allowedTools,
        implementedTools: configuredRuntimeSelection.engine === "pi" ? allowedTools : undefined,
      })
    : {
        runtimeSelection: configuredRuntimeSelection,
        piGreyReadiness: null,
        defaultPiSelected: false,
      };
  const runtimeSelection = runtimeResolution.runtimeSelection;
  const promptMemoryPolicy=resolveWorkshopWorkingMemoryPolicy({workshopId:workshopContext?.workshop.id,
    adapter:runtimeSelection.engine==='pi'?'pi-agent-harness':'claude-agent-sdk',modelConfig:workshopContext?.workshop.modelConfig,
    taskText:input.loop.goal,registeredToolNames:domainPiTools.map(t=>t.name),
    deniedToolNames:[...effectiveLoopSpec.actions.denied,...stringArray(asRecord(workshopContext?.workshop.boundaryPolicy).hardDeniedActions)],
    requiresApprovalToolNames:effectiveLoopSpec.actions.requiresApproval});
  const promptAssembly = runtimeSelection.engine === "pi"
    ? composeWorkshopRunPrompt({
        workshop: workshopContext?.workshop ?? null,
        prompt: piTaskPrompt,
        loop: { id: input.loop.id, name: input.loop.name },
        allowedTools,
        actionPolicy: effectiveLoopSpec.actions,
        approvalPolicy: effectiveLoopSpec.approval,
        skills: loadWorkshopRunSkills(workshopContext?.workshop ?? null, input.loop.name),
        workingMemory:promptMemoryPolicy,
      })
    : null;
  let prompt = promptAssembly?.prompt ?? scopedTaskPrompt;
  if (workingMemoryDeliveryContract) prompt += '\n\nRequired delivery: save a real current-run workingMemory update with phase=LOG before completing. Read the actual version/evidenceCatalog, bind notes to an authorized current source, and preserve genuine unresolved openQuestions for safe continuity under current corrections. A read, workshopLogEvent, or a claim in the final report is not a save. Existing permissions and budgets apply; report a blocker if safe delivery is impossible.';
  if (workingMemoryDeliveryContract?.requireFreshSource) prompt += '\nThis explicit fresh-source delivery contract requires one authorized source observation in this run, even when historical notes were inherited. Save the actual new observation and its limits; do not rewrite old notes merely to claim a save. Historical sourceRefs cannot substitute for current evidenceCatalog IDs.';
  if (workingMemoryDeliveryContract) prompt += '\nKeep the notebook concise. Keep the final human report within 600 Chinese characters, then provide only compact required structured-output fields; do not repeat the full report in multiple forms or add long tool transcripts. A correction must fit the same whole-run deadline and its finite output grant.';
  const piAgentModelConfig = resolvePiAgentModelConfig({
    userConfig: userOpenAiConfig,
    envConfig: piEnvConfig,
    runtimeProtocol: runtimeSelection.piProtocol,
    fallbackModel: agentModelConfig.model,
  });
  const effectiveRuntimeModel =
    runtimeSelection.engine === "pi"
      ? piAgentModelConfig.model
      : agentModel;
  const effectiveRuntimeBaseUrl =
    runtimeSelection.engine === "pi"
      ? piAgentModelConfig.baseUrl
      : agentBaseUrl;
  const effectiveRuntimeModelSource =
    runtimeSelection.engine === "pi"
      ? piAgentModelConfig.source
      : agentModelConfig.source;
  let workingMemoryContinuity: WorkingMemoryContinuityResult | undefined;
  let pendingContinuityLoadEvent: Parameters<typeof appendWorkshopEvent>[0] | undefined;
  let workingMemoryCorrectionsPresent = false;
  const continuityPolicy = resolveWorkshopWorkingMemoryPolicy({
    workshopId: workshopContext?.workshop.id,
    adapter: runtimeSelection.engine === 'pi' ? 'pi-agent-harness' : 'claude-agent-sdk',
    modelConfig: workshopContext?.workshop.modelConfig,
    taskText: [input.loop.goal, effectiveLoopSpec.context.instructions].filter(Boolean).join('\n'),
    registeredToolNames: domainPiTools.map(tool => tool.name),
    deniedToolNames: [...effectiveLoopSpec.actions.denied,
      ...stringArray(asRecord(workshopContext?.workshop.boundaryPolicy).hardDeniedActions)],
    requiresApprovalToolNames: [...effectiveLoopSpec.actions.requiresApproval,
      ...stringArray(asRecord(workshopContext?.workshop.modelConfig).requiresApprovalTools)],
  });
  const preparedContinuityBinding = buildHostContinuityRuntimeBinding({ userId: input.userId,
    workshop: workshopContext?.workshop, loop: input.loop, runId: input.runId,
    runtime: { engine: runtimeSelection.engine, adapter: runtimeSelection.engine === 'pi' ? 'pi-agent-harness' : 'claude-agent-sdk',
      model: effectiveRuntimeModel, protocol: runtimeSelection.engine === 'pi' ? piAgentModelConfig.piProtocol : undefined },
    policy: continuityPolicy, allowedToolNames: domainPiTools.map(tool => tool.name),
    deniedToolNames: [...effectiveLoopSpec.actions.denied, ...stringArray(asRecord(workshopContext?.workshop.boundaryPolicy).hardDeniedActions)],
    requiresApprovalToolNames: [...effectiveLoopSpec.actions.requiresApproval, ...stringArray(asRecord(workshopContext?.workshop.modelConfig).requiresApprovalTools)] });
  if (continuityPolicy.enabled && workshopContext) {
    await executionGuard?.();
    const claimGuard = resolveWorkingMemoryClaimGuard(workshopContext.promptContext.memoryContext, workshopContext.promptContext.memoryRecall);
    workingMemoryCorrectionsPresent = claimGuard.suppressHistoricalClaims;
    workingMemoryContinuity = await loadWorkingMemoryContinuity({
      userId: input.userId, workshopId: workshopContext.workshop.id, currentRunId: input.runId,
      scope: { kind: 'loop', loopId: input.loop.id }, policyIdentity: continuityPolicy.policyIdentity,
      applicabilityHash: continuityPolicy.applicabilityHash,
      runtimeBinding: preparedContinuityBinding,
      verifySources: createContinuitySourceVerifier({ requester: createWorkshopBrainRequester(workshopContext.workshop),
        sourceFilters: workMemorySourceFilters(workshopContext.workshop.modelConfig), accessMode: 'strict' }),
      correctionsPresent: claimGuard.suppressHistoricalClaims,
    });
    workingMemoryContinuity = { ...workingMemoryContinuity, warnings: [...workingMemoryContinuity.warnings, ...claimGuard.warnings] };
    const guidance = formatWorkingMemoryContinuityGuidance(workingMemoryContinuity);
    // Share the existing durable-state window. System/role instructions are a
    // separate input section and must not consume this task-state allowance twice.
    const durableStateChars = JSON.stringify(contextWindow.durableState).length;
    const remainingGuidanceChars = Math.max(0, contextWindow.maxChars - durableStateChars - 2);
    if (workingMemoryContinuity.status === 'inherited' && guidance.length > remainingGuidanceChars) {
      workingMemoryContinuity = { schemaVersion: 'working-memory-continuity.v1', status: 'skipped', reason: 'continuity_state_budget',
        warnings: ['Historical notes were not loaded because the shared Loop durable-state window is full.', ...claimGuard.warnings], checkpoint: null };
    }
    const admittedGuidance = formatWorkingMemoryContinuityGuidance(workingMemoryContinuity, { maxChars: remainingGuidanceChars });
    if (!admittedGuidance) workingMemoryContinuity.warnings = [...workingMemoryContinuity.warnings,
      'Continuity guidance was not added because the remaining input budget is insufficient.'];
    const continuityStateBudget = { maxChars: contextWindow.maxChars, durableStateChars,
      historyChars: admittedGuidance.length, requestedHistoryChars: guidance.length,
      remainingGuidanceChars, guidanceSeparatorChars: admittedGuidance ? 2 : 0 };
    const guidanceAdmission = { status: admittedGuidance ? 'admitted' : 'not_admitted', chars: admittedGuidance.length,
      maxChars: remainingGuidanceChars };
    await executionGuard?.();
    pendingContinuityLoadEvent = { workshopId: workshopContext.workshop.id, loopId: input.loop.id, loopRunId: input.runId,
      type: 'working_memory_continuity_loaded', title: workingMemoryContinuity.status === 'inherited' ? '已准备同 Loop 历史工作状态' : '历史工作状态未接续',
      ...(workingMemoryContinuity.status === 'skipped' ? { body: `历史工作检查点未接续：${workingMemoryContinuity.reason}。未装载不表示历史为空或首次运行；当前 run 的 version=0 也不能证明没有历史。` } : {}),
      metadata: { receiptAuthority: 'runtime', ...workingMemoryContinuity, currentRunId: input.runId,
        runtimeBinding: preparedContinuityBinding, bindingStage: 'prepared_before_runtime_selection',
        applicabilityHash: continuityPolicy.applicabilityHash,
        claimGuard,
        contextBudget: continuityStateBudget, guidanceAdmission,
        scope: { kind: 'loop', loopId: input.loop.id } }  };
    await executionGuard?.();
    if (admittedGuidance) prompt += `\n\n${admittedGuidance}`;
  }
  const contextBudgetReport = buildContextBudgetReport({
    profile: contextProfile,
    model: effectiveRuntimeModel,
    prompt: [promptAssembly?.systemPrompt, prompt].filter(Boolean).join("\n\n"),
    maxToolCalls,
    allowedTools: workshopContext ? allowedTools : null,
    toolProfile: toolProfile?.name ?? null,
    modelTier: agentModelConfig.tier,
    modelSource: effectiveRuntimeModelSource,
    inputPriceUsdPerMillionTokens:
      agentModelConfig.inputPriceUsdPerMillionTokens,
    sections: [
      {
        name: "loopDurableState",
        value: contextWindow.durableState,
        maxChars: contextWindow.maxChars,
      },
      {
        name: "workshopContext",
        value: workshopContext?.promptContext ?? null,
        maxChars: workshopContext?.promptContext.maxChars ?? null,
      },
      { name: "loopSpec", value: effectiveLoopSpec },
      { name: "attemptContext", value: input.attemptContext ?? null },
      { name: "workingMemoryContinuity", value: workingMemoryContinuity ?? null },
    ],
  });
  const traceEvents: ExecutionTraceEvent[] = [
    {
      type: "task_received",
      title: "Native loop received",
      detail: input.loop.name,
      timestamp: new Date().toISOString(),
      metadata: {
        loopId: input.loop.id,
        runId: input.runId,
        triggerType: input.loop.triggerConfig?.type,
        attemptNumber: input.attemptContext?.attemptNumber ?? 1,
        maxAttempts: input.attemptContext?.maxAttempts ?? 1,
      },
    },
    ...(input.attemptContext?.previousFeedback
      ? [
          {
            type: "task_received" as const,
            title: "Retry feedback received",
            detail: compactJson(input.attemptContext.previousFeedback, 240),
            status: "completed" as const,
            timestamp: new Date().toISOString(),
            metadata: {
              attemptNumber: input.attemptContext.attemptNumber,
              maxAttempts: input.attemptContext.maxAttempts,
              previousResult: input.attemptContext.previousResult,
            },
          },
        ]
      : []),
    {
      type: "workspace_prepared",
      title: "Workspace prepared",
      detail: sessionDir,
      status: "completed",
      timestamp: new Date().toISOString(),
      metadata: {
        sessionDir, workspace,
      },
    },
    {
      type: "agent_configured",
      title: "Agent configured",
      detail: effectiveRuntimeModel,
      status: "completed",
      timestamp: new Date().toISOString(),
      metadata: {
        provider: runtimeSelection.engine,
        runtimeSelection,
        model: effectiveRuntimeModel,
        baseUrl: redactedBaseUrl(effectiveRuntimeBaseUrl),
        userProviderConfigured:
          runtimeSelection.engine === "pi"
            ? Boolean(userOpenAiConfig)
            : Boolean(userAnthropicConfig),
        modelTier: agentModelConfig.tier,
        modelSource: effectiveRuntimeModelSource,
        piModelSource:
          runtimeSelection.engine === "pi" ? piAgentModelConfig.source : null,
        modelPricing: {
          inputUsdPerMillionTokens:
            agentModelConfig.inputPriceUsdPerMillionTokens,
          outputUsdPerMillionTokens:
            agentModelConfig.outputPriceUsdPerMillionTokens,
        },
        toolProfile,
      },
    },
    {
      type: "context_prepared",
      title: contextWindow.compacted
        ? "Loop context compacted"
        : "Loop context prepared",
      detail: contextWindow.compacted
        ? `Compacted durable state from ${contextWindow.originalChars} to ${contextWindow.compactedChars} chars`
        : `Durable state fits context budget (${contextWindow.originalChars} chars)`,
      status: "completed",
      timestamp: new Date().toISOString(),
      metadata: {
        compacted: contextWindow.compacted,
        originalChars: contextWindow.originalChars,
        compactedChars: contextWindow.compactedChars,
        maxChars: contextWindow.maxChars,
        contextProfile: contextWindow.contextProfile,
        omittedStateKeys: contextWindow.omittedStateKeys,
      },
    },
    ...(workshopContext
      ? [
          {
            type: "context_prepared" as const,
            title: workshopContext.promptContext.compacted
              ? "Workshop context compacted"
              : "Workshop context prepared",
            detail: `Workshop context loaded for ${workshopContext.promptContext.workshop.name}`,
            status: "completed" as const,
            timestamp: new Date().toISOString(),
            metadata: {
              workshopId: workshopContext.promptContext.workshop.id,
              sourceCount: workshopContext.promptContext.sources.length,
              memoryCount: workshopContext.promptContext.memories.length,
              directiveCount: workshopContext.promptContext.directives.length,
              recentEventCount:
                workshopContext.promptContext.recentEvents.length,
              compacted: workshopContext.promptContext.compacted,
              originalChars: workshopContext.promptContext.originalChars,
              compactedChars: workshopContext.promptContext.compactedChars,
              maxChars: workshopContext.promptContext.maxChars,
              contextProfile: workshopContext.promptContext.contextProfile,
              omittedSections: workshopContext.promptContext.omittedSections,
              boundary: workshopContext.boundaryMetadata,
            },
          },
        ]
      : []),
    {
      type: "budget_configured",
      title: "Loop execution budget configured",
      detail: `Max tool calls: ${maxToolCalls}`,
      status: "completed",
      timestamp: new Date().toISOString(),
      metadata: {
        maxToolCalls,
      },
    },
    {
      type: "prompt_built",
      title: "Loop prompt built",
      detail: loopSpec.goal,
      status: "completed",
      timestamp: new Date().toISOString(),
      metadata: {
        approvalExternalWrites: effectiveLoopSpec.approval.externalWrites,
        allowedActionCount: effectiveLoopSpec.actions.allowed.length,
        trigger: effectiveLoopSpec.trigger,
        workshopId: workshopContext?.promptContext.workshop.id ?? null,
        workshopBoundary: workshopContext?.boundaryMetadata ?? null,
      },
    },
    {
      type: "context_budget_report",
      title: "Agent context budget report",
      detail: `Prompt ${contextBudgetReport.promptChars} chars, approx ${contextBudgetReport.estimatedPromptTokens} tokens.`,
      status: "completed",
      timestamp: new Date().toISOString(),
      metadata: contextBudgetReport,
    },
  ];

  if (workshopContext) {
    await appendWorkshopEvent({
      workshopId: workshopContext.workshop.id,
      loopId: input.loop.id,
      loopRunId: input.runId,
      type: "context_budget_report",
      title: "Loop context budget report",
      body: `Prompt ${contextBudgetReport.promptChars} chars, approx ${contextBudgetReport.estimatedPromptTokens} tokens.`,
      visibility: "debug",
      metadata: contextBudgetReport,
    });
  }

  const textBuffer = createLoopAgentTextBuffer();
  let hasError = false;
  let errorMessage: string | undefined;
  let runtimeTerminal: AgentRuntimeTerminal | undefined;
  let runtimeTerminalCount = 0;
  let toolCallCount = 0;
  const researchToolCalls = new Map<string, string>();
  const toolGateDecisions: LoopToolGateDecision[] = [];
  const runtimeWorkshopId = workshopContext?.promptContext.workshop.id ?? null;
  let logicalProviderPrepared: { eventId: string; seq: number; createdAt: string; version: number;
    policyIdentity: unknown } | null = null;
  const recordTraceEvent = async (event: ExecutionTraceEvent) => {
    traceEvents.push(event);
    await appendRuntimeTraceWorkshopEvent({
      workshopId: runtimeWorkshopId,
      loopId: input.loop.id,
      loopRunId: input.runId,
      event,
    });
  };
  const flushAgentText = async (force = false, final = false) => {
    const displayText = textBuffer.flush(force, { final });
    if (!displayText) return;
    await recordTraceEvent({
      type: "model_text",
      title: "Agent response received",
      detail: compactJson(displayText, 2000),
      status: "completed",
      timestamp: new Date().toISOString(),
    });
  };

  if (runtimeSelection.engine === "pi" && workshopContext) {
    const piGreyReadiness =
      runtimeResolution.piGreyReadiness ??
      resolveWorkshopRuntimeWithPiGreyDefault({
        runtimeSelection,
        tools: allowedTools,
      }).piGreyReadiness;
    if (!piGreyReadiness.eligible) {
      const blockedToolNames = [
        ...piGreyReadiness.blockedTools.map((tool) => tool.toolName),
        ...piGreyReadiness.needsMigrationTools.map((tool) => tool.toolName),
      ];
      const detail =
        blockedToolNames.length > 0
          ? `Pi runtime is not ready for this Loop. Blocked or unmigrated tools: ${blockedToolNames.join(", ")}.`
          : "Pi runtime is not ready for this Loop.";
      await recordTraceEvent({
        type: "error",
        title: "Pi runtime grey loop blocked",
        detail,
        status: "error",
        timestamp: new Date().toISOString(),
        metadata: {
          runtimeSelection,
          piGreyReadiness,
        },
      });
      const structuredReport = buildStructuredExecutionReport({
        preferReportMarkdown,
        structuredData: {},
        cleanText: "",
        rawText: "",
        taskText: input.loop.goal,
        requiredFields: stringArray(
          asRecord(effectiveLoopSpec.verification).requiredFields,
        ),
        traceEvents,
        sessionFiles: [],
        hasError: true,
        errorMessage: detail,
        language: userSettings?.language ?? null,
      });
      return {
        status: "error",
        output: detail,
        error: detail,
        result: {
          executionMode: "native_agent",
          loopId: input.loop.id,
          runId: input.runId,
          sessionDir,
          executionTrace: {
            events: traceEvents,
            toolCallCount: 0,
            maxToolCalls,
            budgetExceeded: false,
            failedToolCallCount: 0,
            permissionDecisionCount: toolGateDecisions.length,
            durationMs: Date.now() - startedAt,
          },
          toolGate: summarizeLoopToolGate(toolGateDecisions),
          structuredReport,
        },
        duration: Date.now() - startedAt,
      };
    }
  }

  try {
    const agentRuntime = createAgentRuntime({
      engine: runtimeSelection.engine,
      claudeConfig,
      pi:
        runtimeSelection.engine === "pi"
          ? {
              ...createPiRuntimeOptionsFromModelConfig({
                apiKey: piAgentModelConfig.apiKey,
                baseUrl: piAgentModelConfig.baseUrl,
                model: piAgentModelConfig.model,
                protocol: piAgentModelConfig.piProtocol,
                providerId: piAgentModelConfig.providerId,
              }),
              tools: domainPiTools,
              systemPrompt: promptAssembly?.systemPrompt,
            }
          : undefined,
    });
    bindMemoryDispatchRuntime(agentRuntime.metadata);
    // Only Harness promises this completion/cleanup contract. Legacy Claude
    // and the explicitly selected Pi rollback adapter retain their own EOF
    // contracts; a draft alone cannot complete an actual Harness run.
    const requiresRuntimeTerminal = agentRuntime.metadata.engine === "pi" &&
      agentRuntime.metadata.adapter === "pi-agent-harness";
    const expectsApprovedFinalCandidate = requiresRuntimeTerminal && (!!workingMemoryDeliveryContract ||
      preferReportMarkdown && effectiveLoopSpec.verification.requiredFields.includes('researchProcess'));
    const workingMemoryPolicy = resolveWorkshopWorkingMemoryPolicy({
      workshopId: workshopContext?.workshop.id,
      adapter: agentRuntime.metadata.adapter,
      modelConfig: workshopContext?.workshop.modelConfig,
      taskText: [input.loop.goal, effectiveLoopSpec.context.instructions].filter(Boolean).join("\n"),
      registeredToolNames: domainPiTools.map(tool => tool.name),
      deniedToolNames: [
        ...effectiveLoopSpec.actions.denied,
        ...stringArray(asRecord(workshopContext?.workshop.boundaryPolicy).hardDeniedActions),
      ],
      requiresApprovalToolNames: [
        ...effectiveLoopSpec.actions.requiresApproval,
        ...stringArray(asRecord(workshopContext?.workshop.modelConfig).requiresApprovalTools),
      ],
    });
    const continuityBinding = buildHostContinuityRuntimeBinding({ userId: input.userId, workshop: workshopContext?.workshop,
      loop: input.loop, runId: input.runId, runtime: { ...agentRuntime.metadata, model: effectiveRuntimeModel,
        protocol: runtimeSelection.engine === 'pi' ? piAgentModelConfig.piProtocol : undefined }, policy: workingMemoryPolicy,
      allowedToolNames: domainPiTools.map(tool => tool.name),
      deniedToolNames: [...effectiveLoopSpec.actions.denied, ...stringArray(asRecord(workshopContext?.workshop.boundaryPolicy).hardDeniedActions)],
      requiresApprovalToolNames: [...effectiveLoopSpec.actions.requiresApproval, ...stringArray(asRecord(workshopContext?.workshop.modelConfig).requiresApprovalTools)] });
    if (workingMemoryContinuity?.status === 'inherited' && (!continuityBinding || !preparedContinuityBinding
      || continuityBinding.configHash !== preparedContinuityBinding.configHash)) {
      throw new Error('[memory_continuity_runtime_changed] Prepared historical context does not match the actual selected runtime');
    }
    if (businessCheckpointInPrompt && (!continuityBinding
      || asRecord(verifiedBusinessCheckpoint?.runtimeBinding).configHash !== continuityBinding.configHash)) {
      throw new Error('[memory_continuity_runtime_changed] Historical business questions do not match the actual selected runtime');
    }
    // A load receipt records the actual selected runtime, never the prepared guess.
    await executionGuard?.();
    if(storedBusinessCheckpoint&&input.loop.workshopId)await appendWorkshopEvent({workshopId:input.loop.workshopId,
      runId:executionLease?.runId??input.runId,loopId:input.loop.id,loopRunId:input.runId,type:'business_checkpoint_loaded',
      title:businessCheckpointInPrompt?'已准备同 Loop 业务进度（未经独立核验）':'业务进度未接续：作用域、有效期、原始回执或输入预算不匹配',
      metadata:{receiptAuthority:'runtime',status:businessCheckpointInPrompt?'inherited':'skipped',
        runtimeBinding:continuityBinding,bindingStage:'actual_runtime_confirmed',
        applicabilityHash:checkpointScope.applicabilityHash,
        ...(businessCheckpointInPrompt?{sourceRunId:admittedBusinessCheckpoint!.sourceRunId,receiptEventId:admittedBusinessCheckpoint!.receiptEventId,
          checkpointHash:admittedBusinessCheckpoint!.checkpointHash,expiresAt:admittedBusinessCheckpoint!.expiresAt}:{}),
        recoveryScope:'questions-and-review-conditions-only',automaticPromotion:false}});
    if (pendingContinuityLoadEvent) await appendWorkshopEvent({ ...pendingContinuityLoadEvent,
      metadata: { ...pendingContinuityLoadEvent.metadata, runtimeBinding: continuityBinding, bindingStage: 'actual_runtime_confirmed' } });
    await executionGuard?.();
    if (workingMemoryDeliveryContract && (!requiresRuntimeTerminal || !workingMemoryPolicy.enabled
      || workingMemoryPolicy.mode !== 'apply' || !runtimeWorkshopId || !executionLease)) {
      throw new Error('[working_memory_delivery_unavailable] Required LOG delivery needs an admitted apply-mode Harness and an active same-Work execution lease; existing permissions cannot be expanded by this contract');
    }
    const deliveryBudget = { maxCorrections: 1, maxExtraForwards: 4, reservedOutputTokens: 16384, wholeTimeoutMs: 420000,
      boundedCompaction: { maxForwards: 1, totalOutputTokens: 2048, perForwardOutputTokens: 2048 } } as const;
    let deliveredSnapshot: WorkingMemorySnapshot | undefined;
    let deliveredAttempt = -1;
    let candidateDeliveryApproved = false;
    const checkDelivery = async (stage: 'candidate' | 'runtime_commit', attempt: number,
      snapshot: WorkingMemorySnapshot | undefined): Promise<WorkingMemoryDeliveryResult> => {
      const guardDelivery = async () => {
        agentAbortController.signal.throwIfAborted();
        await executionGuard?.();
        if (Date.now() - startedAt >= deliveryBudget.wholeTimeoutMs) throw new Error('Required LOG delivery whole-runtime deadline exhausted');
      };
      await guardDelivery();
      const rows: Array<Omit<WorkshopEvent, 'createdAt'> & { createdAt: Date | string }> = await listWorkshopEvents(runtimeWorkshopId!, { loopRunId: input.runId, order: 'asc', limit: 501 });
      await guardDelivery();
      const result = checkWorkingMemoryDelivery({ contract: workingMemoryDeliveryContract,
        scope: { userId: input.userId, workshopId: runtimeWorkshopId!, runId: input.runId, loopId: input.loop.id,
          startedAt: new Date(startedAt).toISOString(), policyIdentity: workingMemoryPolicy.policyIdentity,
          applicabilityHash: workingMemoryPolicy.applicabilityHash },
        snapshot, durableEvents: rows.slice(0, 500).map(row => ({ ...row, createdAt: new Date(row.createdAt).toISOString() })),
        eventsTruncated: rows.length > 500, attempt, correctionsPresent: workingMemoryCorrectionsPresent });
      await guardDelivery();
      await appendWorkshopEvent({ workshopId: runtimeWorkshopId!, runId: executionLease!.runId,
        loopId: input.loop.id, loopRunId: input.runId, type: 'working_memory_delivery_checked',
        title: result.ok ? '必需的 LOG 检查点已核对' : '必需的 LOG 检查点尚未交付',
        body: result.ok ? '实际笔记快照与持久 LOG、来源证据一致。' : result.feedback,
        metadata: { ...result, stage, attempt, receiptAuthority: 'runtime', currentRunId: input.runId,
          scope: { kind: 'loop', loopId: input.loop.id }, policyIdentity: workingMemoryPolicy.policyIdentity,
          correctionsPresent: workingMemoryCorrectionsPresent, contract: workingMemoryDeliveryContract, budget: deliveryBudget } });
      await guardDelivery();
      return result;
    };
    // This grant only governs this live run's host-managed context. Neither
    // the stored Loop nor the Work's tool permissions are changed.
    const runtimeActionPolicy = workingMemoryPolicy.enabled
      ? { ...effectiveLoopSpec.actions,
          allowed: [...new Set([...effectiveLoopSpec.actions.allowed, WORKING_MEMORY_TOOL_NAME])] }
      : effectiveLoopSpec.actions;
    const intrinsicTools = workingMemoryPolicy.enabled ? [WORKING_MEMORY_TOOL_NAME] : [];
    const runtimeAllowedTools = [...allowedTools, ...intrinsicTools];
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
      allowedTools: workshopContext ? runtimeAllowedTools : null,
      policy: {
        actionPolicy: runtimeActionPolicy,
        approvalPolicy:
          workshopContext?.approvalPolicy ?? input.loop.approvalPolicy,
        verificationConfig: input.loop.verificationConfig,
        toolProfile: toolProfile?.name ?? null,
        toolClassification: summarizeWorkshopRuntimeToolClassifications(
          workshopContext ? runtimeAllowedTools : [],
        ),
        workingMemoryPolicy,
      },
      extra: {
        workingMemoryPolicy,
        continuityBinding,
        workingMemoryContinuity: workingMemoryContinuity ?? null,
        promptAssembly: promptAssembly?.manifest ?? null,
        contextProfile,
        maxToolCalls,
        workshopId: workshopContext?.workshop.id ?? null,
        piTools:
          runtimeSelection.engine === "pi" && Boolean(workshopContext)
            ? {
                domain: domainPiTools.map(tool => tool.name),
                intrinsic: intrinsicTools,
              }
            : null,
      },
    });
    await recordTraceEvent({
      type: "agent_configured",
      title: "Agent runtime configured",
      detail: agentRuntime.metadata.engine,
      status: "completed",
      timestamp: new Date().toISOString(),
      metadata: {
        runtime: agentRuntime.metadata,
        runtimeSelection,
        runtimeRunSnapshot,
        workingMemoryPolicy,
      },
    });
    if (runtimeWorkshopId && executionLease?.runId) {
      try {
        await persistWorkRunRuntimeSnapshot(database, {
          workshopId: runtimeWorkshopId,
          runId: executionLease.runId,
          loopId: input.loop.id,
          loopRunId: input.runId,
          snapshot: runtimeRunSnapshot,
        });
      } catch (error) {
        await recordTraceEvent({
          type: "error",
          title: "Runtime snapshot projection failed",
          detail: error instanceof Error ? error.message : String(error),
          status: "error",
          timestamp: new Date().toISOString(),
          metadata: {
            runtimeSnapshotPersistenceFailed: true,
            runtimeHash: runtimeRunSnapshot.runtimeHash,
            policyHash: runtimeRunSnapshot.policyHash,
          },
        });
      }
    }

    console.info("[LoopNativeExecutor] starting native agent", {
      loopId: input.loop.id,
      runId: input.runId,
      userId: input.userId,
      sessionDir,
      model: effectiveRuntimeModel,
      baseUrl: effectiveRuntimeBaseUrl,
      workshopId: workshopContext?.promptContext.workshop.id ?? null,
      hasApiKey: Boolean(
        runtimeSelection.engine === "pi"
          ? piAgentModelConfig.apiKey
          : agentModelConfig.apiKey,
      ),
      userType,
    });

    let admittedToolCallCount = 0;
    if (workingMemoryDeliveryContract && Date.now() - startedAt >= deliveryBudget.wholeTimeoutMs) {
      throw new Error('Required LOG delivery whole-runtime deadline exhausted before model dispatch');
    }
    const generator = agentRuntime.run({
      operation: "run",
      prompt,
      options: {
        sessionId,
        cwd: sessionDir,
        taskId: `loops/${input.loop.id}/${input.runId}`,
        conversation: [],
        permissionMode: "default",
        onBeforeProviderRequest: async () => {
          await executionGuard?.();
          await assertMemoryDispatchCurrent();
        },
        stream: false,
        excludeTools: ["createLoopTask"],
        ...(workshopMcpServer
          ? {
              customMcpServers: {
                "workshop-tools": workshopMcpServer,
              },
              allowedTools: runtimeAllowedTools,
            }
          : {}),
        onPermissionRequest: createLoopToolPermissionHandler({
          actionPolicy: runtimeActionPolicy,
          approvalPolicy:
            workshopContext?.approvalPolicy ?? input.loop.approvalPolicy,
          onDecision: (decision) => {
            toolGateDecisions.push(decision);
            void recordTraceEvent({
              type: "permission_decision",
              title:
                decision.decision === "allow"
                  ? "Tool permission allowed"
                  : decision.decision === "deny"
                    ? "Tool permission denied"
                    : "Tool permission requires approval",
              detail:
                decision.reason ?? decision.message ?? decision.actionName,
              toolName: decision.actionName,
              toolUseId: decision.toolUseID,
              status:
                decision.decision === "deny"
                  ? "error"
                  : decision.decision === "require_approval"
                    ? "running"
                    : "completed",
              timestamp: new Date().toISOString(),
              metadata: {
                decision: decision.decision,
                capability: decision.capability,
              },
            });
          },
        }),
        session: {
          user: { id: input.userId, type: userType },
          platform: "loop",
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
        timezone:
          typeof input.loop.triggerConfig?.timezone === "string"
            ? input.loop.triggerConfig.timezone
            : null,
        abortController: agentAbortController,
        ...(workingMemoryDeliveryContract ? { hostFinalValidation: {
          maxCorrections: deliveryBudget.maxCorrections,
          maxExtraForwards: deliveryBudget.maxExtraForwards,
          timeoutMs: Math.max(1, deliveryBudget.wholeTimeoutMs - (Date.now() - startedAt)),
          reserveOutputTokens: () => deliveryBudget.reservedOutputTokens,
          boundedCompaction: deliveryBudget.boundedCompaction,
          validate: async (candidate: { text: string; attempt: number; signal: AbortSignal; workingMemory?: WorkingMemorySnapshot }) => {
            candidate.signal.throwIfAborted();
            const snapshot = candidate.workingMemory ? structuredClone(candidate.workingMemory) : undefined;
            const result = await checkDelivery('candidate', candidate.attempt, snapshot);
            deliveredSnapshot = snapshot;
            deliveredAttempt = candidate.attempt;
            candidateDeliveryApproved = result.ok;
            return result.ok ? { ok: true as const } : { ok: false as const, feedback: result.feedback! };
          },
          onForward: async (event: Record<string, unknown>) => {
            agentAbortController.signal.throwIfAborted();
            await executionGuard?.();
            await appendWorkshopEvent({ workshopId: runtimeWorkshopId!, runId: executionLease!.runId,
              loopId: input.loop.id, loopRunId: input.runId, type: 'working_memory_delivery_forward',
              title: 'LOG 交付修正预算已准入', metadata: { ...event, receiptAuthority: 'runtime', currentRunId: input.runId,
                scope: { kind: 'loop', loopId: input.loop.id }, policyIdentity: workingMemoryPolicy.policyIdentity, budget: deliveryBudget } });
            agentAbortController.signal.throwIfAborted();
            await executionGuard?.();
          },
        } } : preferReportMarkdown && effectiveLoopSpec.verification.requiredFields.includes('researchProcess') ? {hostFinalValidation:{
          maxCorrections:2 as const,maxExtraForwards:4,timeoutMs:Math.max(1,900_000-(Date.now()-startedAt)),
          reserveOutputTokens:()=>65_536,perForwardOutputTokens:16_384,
          ...(workingMemoryPolicy.enabled&&workingMemoryPolicy.mode==='apply'&&runtimeWorkshopId&&executionLease?{
            progressFromValidatedReport:(text:string)=>{
              const progress=prepareBusinessCheckpoint({userId:input.userId,workshopId:runtimeWorkshopId,loopId:input.loop.id,
                runId:input.runId,report:parseStructuredOutput(text).data,verificationPassed:true,
                applicabilityHash:workingMemoryPolicy.applicabilityHash,runtimeBinding:continuityBinding});
              return progress.status==='saved'&&progress.openQuestions.length?{openQuestions:progress.openQuestions,
                checkpointHash:progress.state.checkpointHash}:null;
            },
          }:{}),
          onForward:async(event:Record<string,unknown>)=>{
            agentAbortController.signal.throwIfAborted();await executionGuard?.();
            if(runtimeWorkshopId)await appendWorkshopEvent({workshopId:runtimeWorkshopId,runId:executionLease?.runId??input.runId,
              loopId:input.loop.id,loopRunId:input.runId,type:'business_output_correction_budget',title:'本轮研究交付修正预算已使用',
              metadata:{receiptAuthority:'runtime',...event,reservedOutputTokens:65536,lastReportForwardHasNoTools:true}});
          },
          validate:async(candidate:{text:string;attempt:number;signal:AbortSignal})=>{
            candidate.signal.throwIfAborted();await executionGuard?.();
            const checked=validateResearchOutput(candidate.text,effectiveLoopSpec.verification.requiredFields,{events:traceEvents});
            if(runtimeWorkshopId)await appendWorkshopEvent({workshopId:runtimeWorkshopId,runId:executionLease?.runId??input.runId,
              loopId:input.loop.id,loopRunId:input.runId,type:'business_output_validation',title:checked.ok?'研究交付通过本轮业务检查':'研究交付需要修正真实字段或证据',
              metadata:{receiptAuthority:'runtime',attempt:candidate.attempt,passed:checked.ok,...(!checked.ok?{feedback:checked.feedback}:{}),
                extraMemoryDeliveryRequirement:false}});
            candidate.signal.throwIfAborted();return checked;
          },
        }} : {}),
        ...(preferReportMarkdown&&!workingMemoryDeliveryContract?{hostReportReserve:{allowClosingSearch:true,outputTokens:16384,observationHeadroomTokens:32768,
          onReserve:async(event:{forward:number;inputTokens:number;outputTokens:number;remainingTools:string[]})=>{
            agentAbortController.signal.throwIfAborted();await executionGuard?.();
            if(runtimeWorkshopId)await appendWorkshopEvent({workshopId:runtimeWorkshopId,runId:executionLease?.runId??input.runId,
              loopId:input.loop.id,loopRunId:input.runId,type:'research_report_reserve',title:'已保留研究报告交付空间',metadata:{receiptAuthority:'runtime',...event}});
          }}}:{}),
        ...(runtimeSelection.engine === 'pi' && workingMemoryPolicy.enabled && runtimeWorkshopId && executionLease ? {
          hostProviderRecovery: {
            policy: researchProviderRecoveryPolicy({freeformReport:preferReportMarkdown,protectedDelivery:!!workingMemoryDeliveryContract}),
            onTransportAttempt: async (event: import('@openzhiyu/ai/agent/runtime').HostProviderTransportAttempt) => {
              agentAbortController.signal.throwIfAborted();
              await executionGuard?.();
              if (!logicalProviderPrepared) throw new Error('Provider transport audit requires an admitted logical context');
              await appendWorkshopEvent({ workshopId: runtimeWorkshopId, runId: executionLease.runId,
                loopId: input.loop.id, loopRunId: input.runId, type: 'provider_transport_attempt',
                title: event.phase === 'prepared' ? '模型传输已准入' : event.phase === 'finished' ? '模型传输观测已记录' : '模型有限恢复决策已记录',
                metadata: { ...event, receiptAuthority: 'runtime', currentRunId: input.runId,
                  scope: { kind: 'loop', loopId: input.loop.id }, logicalPrepared: { ...logicalProviderPrepared } } });
              agentAbortController.signal.throwIfAborted();
              await executionGuard?.();
            },
          },
        } : {}),
        onBeforeToolUse: async () => {
          agentAbortController.signal.throwIfAborted();
          await executionGuard?.();
          admittedToolCallCount += 1;
          if (admittedToolCallCount > maxToolCalls) {
            const detail = `Loop execution budget exceeded: ${admittedToolCallCount} tool calls used, max ${maxToolCalls}`;
            await recordTraceEvent({ type: "budget_exceeded", title: "Loop execution budget exceeded",
              detail, status: "error", timestamp: new Date().toISOString(),
              metadata: { admittedToolCallCount, maxToolCalls, dispatchBlocked: true } });
            throw new Error(detail);
          }
          agentAbortController.signal.throwIfAborted();
        },
        ...(workingMemoryPolicy.enabled && runtimeWorkshopId ? { hostWorkingMemory: {
          mode: workingMemoryPolicy.mode,
          modelSaveFeedback: preferReportMarkdown && !workingMemoryDeliveryContract,
          policyIdentity: workingMemoryPolicy.policyIdentity,
          memoryProtocol: workingMemoryPolicy.memoryProtocol,
          readonlyToolNames: workingMemoryPolicy.readonlyToolNames,
          retainedReadCautions: workingMemoryPolicy.retainedReadCautions,
          deniedToolNames: [
            ...effectiveLoopSpec.actions.denied,
            ...effectiveLoopSpec.actions.requiresApproval,
            ...stringArray(asRecord(workshopContext?.workshop.boundaryPolicy).hardDeniedActions),
            ...stringArray(asRecord(workshopContext?.workshop.modelConfig).disallowedTools),
            ...stringArray(asRecord(workshopContext?.workshop.modelConfig).requiresApprovalTools),
          ],
          maxEdits: workingMemoryPolicy.maxEdits,
          maxSummaryChars: workingMemoryPolicy.maxSummaryChars,
          onAudit: async event => {
            agentAbortController.signal.throwIfAborted();
            await executionGuard?.();
            await appendWorkshopEvent({
              workshopId: runtimeWorkshopId,
              runId: executionLease?.runId ?? input.runId,
              loopId: input.loop.id,
              loopRunId: input.runId,
              type: event.operation === "restore" ? "working_memory_restored" : "working_memory_updated",
              title: event.operation === "restore" ? "本轮原始读取上下文待恢复" :
                event.commitOrigin === 'validated_report_checkpoint' ? "已由宿主提交报告中的待办问题，等待下轮接续" :
                event.mode === "shadow" ? "工作记忆候选已记录" : "工作记忆状态已保存，等待下次请求使用",
              metadata: { ...event, receiptAuthority: "runtime", policyIdentity: workingMemoryPolicy.policyIdentity,
                runtimeBinding: continuityBinding,
                applicabilityHash: workingMemoryPolicy.applicabilityHash,
                recoveryScope: workingMemoryPolicy.recoveryScope,
                semanticStatus: workingMemoryPolicy.semanticStatus },
            });
            agentAbortController.signal.throwIfAborted();
            await executionGuard?.();
          },
          onProjection: async event => {
            agentAbortController.signal.throwIfAborted();
            await executionGuard?.();
            const projectedEvent = await appendWorkshopEvent({
              workshopId: runtimeWorkshopId,
              runId: executionLease?.runId ?? input.runId,
              loopId: input.loop.id,
              loopRunId: input.runId,
              type: "working_memory_projected",
              title: event.mode === "shadow" ? "工作记忆候选已检查，原上下文保持可见" : "下一次模型请求的工作上下文已准备",
              metadata: { ...event, receiptAuthority: "runtime", policyIdentity: workingMemoryPolicy.policyIdentity,
                applicabilityHash: workingMemoryPolicy.applicabilityHash,
                recoveryScope: workingMemoryPolicy.recoveryScope,
                semanticStatus: workingMemoryPolicy.semanticStatus },
            });
            if (executionLease && runtimeSelection.engine === 'pi') logicalProviderPrepared = {
              eventId: projectedEvent.id, seq: projectedEvent.seq,
              createdAt: new Date(projectedEvent.createdAt).toISOString(), version: event.version,
              policyIdentity: event.policyIdentity ?? workingMemoryPolicy.policyIdentity };
            agentAbortController.signal.throwIfAborted();
            await executionGuard?.();
          },
          onRejected: async event => {
            agentAbortController.signal.throwIfAborted();
            await executionGuard?.();
            await appendWorkshopEvent({
              workshopId: runtimeWorkshopId,
              runId: executionLease?.runId ?? input.runId,
              loopId: input.loop.id,
              loopRunId: input.runId,
              type: "working_memory_rejected",
              title: "工作记忆整理未应用",
              body: event.detail,
              metadata: { ...event, receiptAuthority: "runtime", policyIdentity: workingMemoryPolicy.policyIdentity,
                recoveryScope: workingMemoryPolicy.recoveryScope,
                semanticStatus: workingMemoryPolicy.semanticStatus },
            });
            agentAbortController.signal.throwIfAborted();
            await executionGuard?.();
          },
          onUsage: async event => {
            agentAbortController.signal.throwIfAborted();
            await executionGuard?.();
            await appendWorkshopEvent({ workshopId: runtimeWorkshopId,
              runId: executionLease?.runId ?? input.runId, loopId: input.loop.id, loopRunId: input.runId,
              type: 'working_memory_usage', title: '本轮模型实际用量回执',
              metadata: { ...event, receiptAuthority: 'runtime', policyIdentity: workingMemoryPolicy.policyIdentity } });
            agentAbortController.signal.throwIfAborted();
            await executionGuard?.();
          },
        } } : {}),
      },
    });

    for await (const message of generator) {
      await executionGuard?.();
      if (requiresRuntimeTerminal && runtimeTerminalCount > 0 &&
        message.type !== "runtime_terminal" && message.type !== "done") {
        throw new Error("[provider_incomplete_output] Pi Harness emitted data after its runtime terminal");
      }
      if (message.type === "runtime_terminal") {
        runtimeTerminalCount += 1;
        runtimeTerminal = message.runtimeTerminal ? structuredClone(message.runtimeTerminal) : undefined;
        const successfulTerminal = runtimeTerminal?.schemaVersion === "agent-runtime-terminal.v1" &&
          runtimeTerminal.status === "completed" && runtimeTerminal.cleanupStatus === "completed" &&
          runtimeTerminal.completionScope === "runtime" && !runtimeTerminal.error &&
          (runtimeTerminal.runtimeStatus === undefined || runtimeTerminal.runtimeStatus === "completed");
        const metadata = {
          receiptAuthority: "runtime", runtime: agentRuntime.metadata,
          currentRunId: input.runId, scope: { kind: "loop", loopId: input.loop.id },
          runtimeTerminal: runtimeTerminal ?? null, ordinal: runtimeTerminalCount,
          ...(message.providerStreamDiagnostics ? { providerStreamDiagnostics: message.providerStreamDiagnostics } : {}),
        };
        // This is an acceptance receipt, not best-effort display tracing.
        // appendWorkshopEvent uses the ambient execution lease transaction;
        // fence both sides and propagate storage/fence failures to the run.
        await executionGuard?.();
        if (runtimeWorkshopId) await appendWorkshopEvent({
          workshopId: runtimeWorkshopId, runId: executionLease?.runId ?? input.runId,
          loopId: input.loop.id, loopRunId: input.runId, type: "agent_runtime_terminal",
          title: "Agent runtime terminal observed", visibility: "debug", metadata,
        });
        await executionGuard?.();
        traceEvents.push({ type: "agent_runtime_terminal", title: "Agent runtime terminal observed",
          status: successfulTerminal && runtimeTerminalCount === 1 ? "completed" : "error",
          timestamp: new Date().toISOString(), metadata });
        if (requiresRuntimeTerminal && runtimeTerminalCount !== 1) {
          throw new Error("[provider_incomplete_output] Pi Harness emitted duplicate runtime terminals");
        }
        if (requiresRuntimeTerminal && !successfulTerminal) {
          throw new Error(runtimeTerminal?.error || "[provider_incomplete_output] Pi Harness did not confirm completed runtime and cleanup");
        }
      } else if (message.type === "done" && requiresRuntimeTerminal && runtimeTerminalCount === 0) {
        throw new Error("[provider_incomplete_output] Pi Harness reached EOF without a runtime terminal");
      } else if (message.type === "text") {
        textBuffer.append(messageText(message));
        await flushAgentText(false);
      } else if (expectsApprovedFinalCandidate && textBuffer.acceptFinalResult(message)) {
        // Harness emits this unique candidate only after validation and full
        // cleanup. Keep drafts for audit, but never parse their concatenation
        // as the delivered report (adjacent JSON fences need not compose).
        await executionGuard?.();
        const authored = parseStructuredOutput(textBuffer.finalText()).data;
        const selectedFields = ['reportMarkdown','researchProcess','projectAssessment','checkpoint','warnings']
          .filter(key => authored[key] !== undefined);
        if (runtimeWorkshopId) await appendWorkshopEvent({ workshopId: runtimeWorkshopId,
          runId: executionLease?.runId ?? input.runId, loopId: input.loop.id, loopRunId: input.runId,
          type: 'business_final_candidate_selected', title: '本轮报告已选用校验通过的最终版本', visibility: 'debug',
          metadata: { schemaVersion: 'loop-approved-final.v1', receiptAuthority: 'runtime', currentRunId: input.runId,
            source: 'pi_harness_validated_final_candidate', answerPhase: 'candidate_final',
            reportHash: createHash('sha256').update(textBuffer.finalText()).digest('hex'),
            selectedFields, authoredFieldsHash: commandPayloadHash(Object.fromEntries(selectedFields.map(key => [key,authored[key]]))),
            characters: textBuffer.finalText().length } });
        await executionGuard?.();
      } else if (message.type === "tool_use") {
        await flushAgentText(true);
        toolCallCount += 1;
        if (message.id && message.name) researchToolCalls.set(message.id, message.name);
        await recordTraceEvent({
          type: "tool_used",
          title: message.name ?? "Tool used",
          toolName: message.name,
          toolUseId: message.id,
          detail: compactJson(message.input),
          metadata: { toolInput: researchToolInput(message.name ?? "", message.input) },
          status: "running",
          timestamp: new Date().toISOString(),
        });
        if (toolCallCount > maxToolCalls) {
          hasError = true;
          errorMessage = `Loop execution budget exceeded: ${toolCallCount} tool calls used, max ${maxToolCalls}`;
          await recordTraceEvent({
            type: "budget_exceeded",
            title: "Loop execution budget exceeded",
            detail: errorMessage,
            status: "error",
            timestamp: new Date().toISOString(),
            metadata: {
              toolCallCount,
              maxToolCalls,
            },
          });
          agentAbortController.abort(errorMessage);
          break;
        }
      } else if (message.type === "tool_result") {
        await flushAgentText(true);
        const toolName = researchToolCalls.get(message.toolUseId ?? "") ?? "";
        researchToolCalls.delete(message.toolUseId ?? "");
        await recordTraceEvent({
          type: "tool_result",
          title: message.isError ? "Tool error" : "Tool completed",
          detail: compactJson(message.output),
          toolUseId: message.toolUseId,
          toolName: toolName || undefined,
          metadata: { toolResult: researchToolResult(toolName, message.output) },
          status: message.isError ? "error" : "completed",
          timestamp: new Date().toISOString(),
        });
      } else if (message.type === "error") {
        hasError = true;
        const normalizedError = normalizeAgentRuntimeError(
          message.message || "Native loop agent error",
        );
        errorMessage = normalizedError.message;
        await recordTraceEvent({
          type: "error",
          title: "Agent error",
          detail: errorMessage,
          status: "error",
          timestamp: new Date().toISOString(),
          metadata: {
            ...normalizedError,
            ...(message.providerStreamDiagnostics ? { providerStreamDiagnostics: message.providerStreamDiagnostics } : {}),
          },
        });
      }
    }
    if (requiresRuntimeTerminal && runtimeTerminalCount !== 1) {
      throw new Error("[provider_incomplete_output] Pi Harness ended without exactly one runtime terminal");
    }
    if (expectsApprovedFinalCandidate && !textBuffer.hasFinalCandidate()) {
      throw new Error('[provider_incomplete_output] Harness completed without its approved final candidate');
    }
    if (requiresRuntimeTerminal && !textBuffer.finalText().trim()) {
      throw new Error("[provider_incomplete_output] Pi Harness completed without assistant output");
    }
    if (workingMemoryDeliveryContract) {
      if (!candidateDeliveryApproved || deliveredAttempt < 0) throw new Error('[working_memory_delivery_unchecked] Harness did not approve a committed LOG snapshot');
      const committed = await checkDelivery('runtime_commit', deliveredAttempt, deliveredSnapshot);
      if (!committed.ok) throw new Error(`[working_memory_delivery_failed] ${committed.code}`);
    }
    await flushAgentText(true, true);
  } catch (error) {
    hasError = true;
    const normalizedError = normalizeAgentRuntimeError(error);
    errorMessage = normalizedError.message;
    console.error("[LoopNativeExecutor] agent execution threw", {
      loopId: input.loop.id,
      runId: input.runId,
      userId: input.userId,
      sessionDir,
      errorName: error instanceof Error ? error.name : typeof error,
      message: normalizedError.rawMessage,
      normalizedKind: normalizedError.kind,
      retryable: normalizedError.retryable,
      stack: error instanceof Error ? error.stack : undefined,
    });
    await recordTraceEvent({
      type: "error",
      title: "Agent execution threw",
      detail: errorMessage,
      status: "error",
      timestamp: new Date().toISOString(),
      metadata: normalizedError,
    });
  }

  await recordTraceEvent({
    type: hasError ? "error" : "completed",
    title: hasError ? "Native loop failed" : "Native loop completed",
    detail: hasError ? errorMessage : `Used ${toolCallCount} tool calls`,
    status: hasError ? "error" : "completed",
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  });

  const finalTextContent = textBuffer.finalText();
  const { data: parsedStructuredData, cleanText } =
    parseStructuredOutput(finalTextContent);
  const structuredReport = buildStructuredExecutionReport({
    preferReportMarkdown,
    structuredData: parsedStructuredData,
    cleanText,
    rawText: finalTextContent,
    taskText: input.loop.goal,
    requiredFields: stringArray(asRecord(effectiveLoopSpec.verification).requiredFields),
    traceEvents,
    sessionFiles: [],
    hasError,
    errorMessage,
    language: userSettings?.language ?? null,
  });

  if (textBuffer.hasFinalCandidate() && !workingMemoryDeliveryContract && preferReportMarkdown
    && effectiveLoopSpec.verification.requiredFields.includes('researchProcess')) {
    const fields = ['reportMarkdown','researchProcess','projectAssessment','checkpoint','warnings'];
    const identity = (data: Record<string, unknown>) => commandPayloadHash(Object.fromEntries(
      fields.filter(key => data[key] !== undefined).map(key => [key,data[key]])));
    if (identity(parsedStructuredData) !== identity(structuredReport)) {
      throw new Error('[approved_final_mismatch] Prepared report changed the approved final candidate fields');
    }
  }

  const visibleOutput = stripMalformedToolCalls(cleanText).trim();
  const output =
    (preferReportMarkdown ? structuredReport.finalMarkdownReport : undefined) ||
    visibleOutput ||
    structuredReport.finalMarkdownReport ||
    structuredReport.summary ||
    (hasError ? errorMessage : "Loop completed") ||
    "Loop completed";

  return {
    status: hasError ? "error" : "success",
    output,
    error: hasError ? errorMessage : undefined,
    result: {
      executionMode: "native_agent",
      loopId: input.loop.id,
      runId: input.runId,
      sessionDir,
      executionTrace: {
        events: traceEvents,
        runtimeTerminal: runtimeTerminal ?? null,
        runtimeTerminalCount,
        toolCallCount,
        maxToolCalls,
        budgetExceeded: traceEvents.some(
          (event) => event.type === "budget_exceeded",
        ),
        failedToolCallCount: traceEvents.filter(
          (event) => event.type === "tool_result" && event.status === "error",
        ).length,
        permissionDecisionCount: toolGateDecisions.length,
        durationMs: Date.now() - startedAt,
      },
      toolGate: summarizeLoopToolGate(toolGateDecisions),
      structuredReport,
    },
    duration: Date.now() - startedAt,
  };
}
