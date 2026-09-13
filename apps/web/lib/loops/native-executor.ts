import { mkdirSync } from "node:fs";
import {resolveExecutionLease} from '@/lib/work-runtime/execution-context';
import {ExecutionLeaseError} from '@/lib/work-runtime/execution-errors';
import {createExecutionGuard} from '@/lib/work-runtime/execution-guard';
import { join } from "node:path";
import type { AgentMessage } from "@openzhiyu/ai/agent/types";
import { createClaudeAgent } from "@/lib/ai/extensions";
import { normalizeAgentRuntimeError } from "@/lib/ai/agent-runtime-error";
import { buildContextBudgetReport } from "@/lib/ai/context-budget";
import {
  type ContextProfile,
  resolveLoopContextProfile,
} from "@/lib/ai/context-profile";
import {
  resolveAgentModelConfig,
  resolveLoopModelTier,
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
import { stripMalformedToolCalls } from "@/lib/utils/tool-names";
import {
  buildStructuredExecutionReport,
  parseStructuredOutput,
  type ExecutionTraceEvent,
} from "@/lib/types/execution-result";
import type { JobExecutionResult } from "@/lib/cron/types";
import type { Loop, LoopState, Workshop } from "@/lib/db/schema";
import {
  appendWorkshopEvent,
  getWorkshop,
  listActiveDirectives,
  listWorkshopEvents,
  listWorkshopMemories,
  listWorkshopSources,
} from "@/lib/workshops/service";
import { workshopBoundaryToLoopPolicies } from "@/lib/workshops/boundary-policy";
import { createWorkshopMcpServer } from "@/lib/workshops/mcp-tools";
import { resolveWorkshopSdkAllowedTools } from "@/lib/workshops/tool-access";
import { buildWorkshopToolProfile } from "@/lib/workshops/tool-profile";
import type { LoopJson } from "./types";
import { parseLoopSpec, safeParseLoopSpec } from "./spec";
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

function extractLoopSpec(loop: Loop, state: LoopState | null) {
  const fromState =
    state?.stateJson &&
    typeof state.stateJson === "object" &&
    !Array.isArray(state.stateJson)
      ? (state.stateJson as Record<string, unknown>).loopSpec
      : null;
  const parsed = safeParseLoopSpec(fromState);
  if (parsed.success) return mergeLoopContextMetadata(loop, parsed.data);

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

export async function loadWorkshopContextForLoop(input: {
  userId: string;
  loop: Loop;
}): Promise<LoadedWorkshopLoopContext | null> {
  if (!input.loop.workshopId) return null;

  const workshop = await getWorkshop(input.userId, input.loop.workshopId);
  if (!workshop) {
    throw new Error("Workshop not found for loop context");
  }

  const [sources, memories, directives, events] = await Promise.all([
    listWorkshopSources(workshop.id, 20),
    listWorkshopMemories(workshop.id, 30),
    listActiveDirectives(workshop.id, 25),
    listWorkshopEvents(workshop.id, { limit: 40, order: "latest" }),
  ]);

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
    const actionPolicyText = JSON.stringify(bridge.actionPolicy ?? {});
    const brainContext = await buildBrainContextFromMemoryRequest({
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
        riskLevel:
          /quantPaper(PlaceOrder|CancelOrder)|realBroker|payment|externalWrites|wechat/i.test(
            actionPolicyText,
          )
            ? "high"
            : "normal",
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

    if (brainContext.items.length > 0) {
      memoryContext = brainContextPackToWorkshopMemoryContextPack({
        taskIntent,
        pack: brainContext,
      });
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
          evidenceQuality: result.evidenceQuality ?? null,
        })),
        fallbackReason: null,
      };
    } else {
      memoryRecall = {
        backend: "legacy",
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
          evidenceQuality: result.evidenceQuality ?? null,
        })),
        fallbackReason: "brain_context_empty",
      };
    }
  } catch (error) {
    memoryRecall = {
      backend: "legacy",
      fallbackReason: "brain_recall_error",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    workshop,
    promptContext: prepareLoopWorkshopContext({
      workshop,
      sources,
      memories,
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
  };
}

function buildNativeLoopPrompt(input: {
  loop: Loop;
  loopSpec: ReturnType<typeof parseLoopSpec>;
  contextWindow: LoopContextWindowResult;
  workshopContext: LoopWorkshopContextResult | null;
  sessionDir: string;
  language: string | null;
  maxToolCalls: number;
  attemptContext?: ExecuteNativeLoopAgentInput["attemptContext"];
}): string {
  const currentTime = buildLoopCurrentTimeContext({
    timezone:
      typeof input.loop.triggerConfig?.timezone === "string"
        ? input.loop.triggerConfig.timezone
        : input.loopSpec.trigger.type === "cron"
          ? input.loopSpec.trigger.timezone
          : "Asia/Shanghai",
  });
  const outputLanguage = input.language?.toLowerCase().startsWith("en")
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
  const paperTradingRule = actions.allowed.some((action) =>
    /quantPaper(PlaceOrder|CancelOrder|GetAccount|GetWatchlist|ProposeWatchlistChange)/i.test(
      action,
    ),
  )
    ? [
        "Paper-trading simulator rules:",
        "- quantPaper* tools operate only on the internal paper-trading simulator. They are not real broker, payment, or external-write actions.",
        "- Real broker/placeOrder/buy/sell/trade actions remain forbidden unless explicitly allowed by a future real-broker policy.",
        "- At the start of every paper-trading run, call quantTradePlanList when available. Use the ledger as hard prior state: evaluate due plans before making fresh decisions.",
        "- When a prior plan is executed, partially executed, blocked, skipped, stale, or not executable, call quantTradePlanReview with executionStatus plus orderId, blockerReason, or completionNote. Do not leave due plans silently pending.",
        "- When the run creates or revises a plan for today, the next trading session, Monday, or another explicit horizon, call quantTradePlanUpsert with planDate, code, action, triggerCondition, invalidation, rationale, dueAt when known, and sourceDecision.",
        "- Use an aggressive paper-learning posture: prefer action over passive observation when boundaries, data, and risk are adequate. Target 1-3 auditable simulated actions per trading day, using 8%-15% initial capital per experiment and normally no more than 18% in one symbol.",
        "- Watchlist selection is a three-layer control system: candidate pool for broad discovery, active core/trading watchlist for focused observation and paper-trader consumption, and holding/order tracking for protected exposure.",
        "- If the loop discovers new opportunities and quantMarketDiscoverCandidates is allowed, call it first. Treat returned symbols as non-trading candidates until a later promotion decision is justified.",
        "- If the loop decides a symbol should enter or leave the active core/trading watchlist and quantPaperProposeWatchlistChange is allowed, call quantPaperProposeWatchlistChange in this run with concrete add/remove codes, evidence, strategy fit, and risk. The tool auto-applies valid changes after validation and records invalid changes without applying them.",
        "- Before calling quantPaperProposeWatchlistChange, compare the proposal against the latest quantPaperGetWatchlist result from this run. remove may include only symbols already in the active core/trading watchlist; candidate-pool cleanup/archive must be recorded as candidate maintenance or a follow-up task instead.",
        "- If quantPaperGetWatchlist, quantMarketDiscoverCandidates, or quantPaperProposeWatchlistChange fails, or if the quant dashboard reports sample/unavailable data, stop the watchlist control action and record the exact blocker. Never invent, randomize, or hand-compose a replacement active watchlist.",
        "- Data-source fallback or sourceSwitch is not a control blocker by itself. Disclose provider/detail/warning, but do not reduce action strength unless the returned data is sample, unavailable, empty, stale, or missing required fields.",
        "- Do not merely say 建议移除, 建议加入, 建议主人确认后移除, or 符合移除标准. Either call the watchlist-change tool or record the precise rule/data blocker.",
        "- Do not remove symbols with current paper positions or open paper orders from the quote universe; they remain under holding/order tracking until exposure is resolved.",
        "- If the loop decides a simulated buy/sell condition is satisfied and quantPaperPlaceOrder is allowed, call quantPaperPlaceOrder in this run. Do not merely say 准备买入, 拟买入, or 下一交易日试探建仓.",
        "- For agile paper-trading rotation, inspect weak holdings before new opportunities. When a held symbol has two or more weak signals, prefer a simulated reduce/exit order before replacement buys. Compare at least one weak holding against one stronger watchlist candidate when rotationDecision is required.",
        "- Replacement buys must stay inside the current watchlist and should compare the weak source holding with the stronger candidate on relative strength, liquidity, risk/reward, news, invalidation line, and data quality.",
        "- For simulated buys, enforce the execution price-deviation gate: pass plannedPrice to quantPaperPlaceOrder, normally set maxBuyDeviationPct=3, and do not buy when the executable limit price is more than 3% above the planned entry price unless a fresh risk/reward plan replaces the old one.",
        "- For trend-following paper trades, call aStockTrendStateHistory first when prior state matters, then call aStockTrendSystem for current watchlist-level K-line structure, RS ranking, lifecycle state, stop plan, and strategy stats. Call aStockTrendStrategyStats before changing rules or writing learning from outcomes. Use aStockTrend for single-symbol drilldown, then include trendState, trendScore, RS rank, MA/ATR/trailing stop, invalidation, and evidence in quantPaperPlaceOrder.tradeThesis or the no-action reason.",
        "- Treat aStockTrendSystem as observation, not the final action. Convert every relevant lifecycleState/controlAction into a trendFollowDecision.candidateDecisions entry with code, positionState, lifecycleState, trendScore, controlAction, decision, and either orderId/orderResult or blockedReason/notTradedReason.",
        "- Interpret trend trade permission by direction. tradeAllowed means at least one direction is allowed; buyAllowed controls new/add buys, sellAllowed controls reduce/exit handling, and allowedDirections lists the executable side. Never treat sell_watch with sellAllowed=true as a global blocked state.",
        "- When lifecycleState or controlAction includes break_warning, reduce_watch, exit_required, or broken, write breakWarningHandling for that symbol. Include profitState, availableQuantity/T+1 status, trailingStop or invalidation line, chosen action, and next verification. Profitable break_warning is normally handled by protecting profit first: tighten trailing stop or reduce only if the warning is confirmed, persistent, or below stop/invalidation; do not add until repaired.",
        "- A trend decision may result in no order, but it may not result in vague observation. No order must have a machine-readable blocker such as data_quality, price_deviation, trend_not_confirmed, t1_unavailable, cash, lot_size, limit_price, risk_reward, market_state, or break_warning_ambiguous. Generic caution is not a blocker.",
        "- Include rotationDecision when the loop verification asks for it: sell_only, replace, hold, buy_only, or blocked, with concrete sell candidates, buy candidates, replacement pairs, and blockers.",
        "- If a planned paper trade is not executable now, record the exact blocking rule or missing data in actionTaken/riskAssessment and, when useful, persist a structured workshop memory with code, direction, trigger, quantity or target cash, invalidation rule, and next verification run.",
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
      ].join("\n")
    : "";
  const requiredFieldOutputRule = buildRequiredFieldOutputRule(
    stringArray(asRecord(input.loopSpec.verification).requiredFields),
  );
  const requiredSourceToolRule = buildRequiredSourceToolRule(
    stringArray(asRecord(input.loopSpec.verification).requiredSources),
  );
  const workshopSkillRule = buildWorkshopSkillRule({
    workshopContext: input.workshopContext,
    loopName: input.loop.name,
  });
  const workshopContextText = input.workshopContext
    ? [
        "Workshop context:",
        asPrettyJson({
          workshop: input.workshopContext.workshop,
          boundaryPolicy: input.workshopContext.boundaryPolicy,
          sources: input.workshopContext.sources,
          memoryContext: input.workshopContext.memoryContext,
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
  const workshopExecutionRules = input.workshopContext
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
- Produce a complete owner-facing Markdown work report first, then append a <structured-output> JSON block.
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
}

Now execute the loop once.`;
}

function messageText(message: AgentMessage): string {
  if (message.type !== "text") return "";
  return typeof message.content === "string" ? message.content : "";
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

export async function executeNativeLoopAgent(
  input: ExecuteNativeLoopAgentInput,
): Promise<JobExecutionResult> {
  const startedAt = Date.now();
  const userSettings = await getUserInsightSettings(input.userId);
  const loopSpec = extractLoopSpec(input.loop, input.previousState);
  const initialContextProfile = resolveLoopContextProfile(input.loop);
  const workshopContext = await loadWorkshopContextForLoop({
    userId: input.userId,
    loop: input.loop,
  });
  const contextProfile = workshopContext?.contextProfile ?? initialContextProfile;
  const contextWindow = prepareLoopContextWindow({
    state: input.previousState,
    loopSpec,
    contextProfile,
  });
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
  const maxToolCalls = parsePositiveIntEnv("LOOP_MAX_TOOL_CALLS", 40);
  const agentAbortController = input.abortController ?? new AbortController();
  const executionLease=resolveExecutionLease();
  if(executionLease&&(executionLease.userId!==input.userId||executionLease.workshopId!==input.loop.workshopId||executionLease.runId!==input.runId))throw new ExecutionLeaseError('invalid_lease');
  const executionGuard=executionLease?createExecutionGuard(executionLease,agentAbortController):undefined;
  await executionGuard?.();
  const sessionId = `loop-${input.loop.id}`;
  const sessionDir = join(
    getAppDir(),
    "sessions",
    "loops",
    input.loop.id,
    input.runId,
  );
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(join(sessionDir, "temp"), { recursive: true });

  const userAnthropicConfig = await getUserLlmProviderConfig({
    userId: input.userId,
    providerType: "anthropic_compatible",
  });
  const envAnthropicConfig = getLoopAgentEnvConfig();
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
  const agent = createClaudeAgent({
    provider: agentModelConfig.provider,
    baseUrl: agentBaseUrl,
    apiKey: agentModelConfig.apiKey,
    model: agentModel,
  });

  const userType = await getUserTypeForService(input.userId);
  const workshopMcpServer = workshopContext
    ? createWorkshopMcpServer({
        workshop: workshopContext.workshop,
        workshopId: workshopContext.workshop.id,
        loopId: input.loop.id,
        loopRunId: input.runId,
        runId: executionLease?.runId,
        executionLease,
      })
    : null;
  const prompt = buildNativeLoopPrompt({
    loop: input.loop,
    loopSpec: effectiveLoopSpec,
    contextWindow,
    workshopContext: workshopContext?.promptContext ?? null,
    sessionDir,
    language: userSettings?.language ?? null,
    maxToolCalls,
    attemptContext: input.attemptContext,
  });
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
  const allowedTools = workshopContext
    ? resolveWorkshopSdkAllowedTools(
        workshopContext.workshop,
        toolProfile?.tools ?? LOOP_WORKSHOP_ALLOWED_TOOLS,
      )
    : LOOP_WORKSHOP_ALLOWED_TOOLS;
  const contextBudgetReport = buildContextBudgetReport({
    profile: contextProfile,
    model: agentModel,
    prompt,
    maxToolCalls,
    allowedTools: workshopContext ? allowedTools : null,
    toolProfile: toolProfile?.name ?? null,
    modelTier: agentModelConfig.tier,
    modelSource: agentModelConfig.source,
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
        sessionDir,
      },
    },
    {
      type: "agent_configured",
      title: "Agent configured",
      detail: agentModel,
      status: "completed",
      timestamp: new Date().toISOString(),
      metadata: {
        provider: "claude",
        model: agentModel,
        baseUrl: redactedBaseUrl(agentBaseUrl),
        userProviderConfigured: Boolean(userAnthropicConfig),
        modelTier: agentModelConfig.tier,
        modelSource: agentModelConfig.source,
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

  let lastTextContent = "";
  let hasError = false;
  let errorMessage: string | undefined;
  let toolCallCount = 0;
  const toolGateDecisions: LoopToolGateDecision[] = [];
  const runtimeWorkshopId = workshopContext?.promptContext.workshop.id ?? null;
  const recordTraceEvent = async (event: ExecutionTraceEvent) => {
    traceEvents.push(event);
    await appendRuntimeTraceWorkshopEvent({
      workshopId: runtimeWorkshopId,
      loopId: input.loop.id,
      loopRunId: input.runId,
      event,
    });
  };

  try {
    console.info("[LoopNativeExecutor] starting native agent", {
      loopId: input.loop.id,
      runId: input.runId,
      userId: input.userId,
      sessionDir,
      model: agentModel,
      baseUrl: agentBaseUrl,
      workshopId: workshopContext?.promptContext.workshop.id ?? null,
      hasApiKey: Boolean(
        agentModelConfig.apiKey,
      ),
      userType,
    });

    const generator = agent.run(prompt, {
      sessionId,
      cwd: sessionDir,
      taskId: `loops/${input.loop.id}/${input.runId}`,
      conversation: [],
      permissionMode: "default",
      stream: false,
      excludeTools: ["createLoopTask"],
      ...(workshopMcpServer
        ? {
            customMcpServers: {
              "workshop-tools": workshopMcpServer,
            },
            allowedTools,
          }
        : {}),
      onPermissionRequest: createLoopToolPermissionHandler({
        actionPolicy: workshopContext?.actionPolicy ?? input.loop.actionPolicy,
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
            detail: decision.reason ?? decision.message ?? decision.actionName,
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
      authToken: agentModelConfig.apiKey,
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
      onBeforeToolUse: executionGuard,
    });

    for await (const message of generator) {
      await executionGuard?.();
      if (message.type === "text") {
        lastTextContent = messageText(message);
        if (lastTextContent.trim()) {
          await recordTraceEvent({
            type: "model_text",
            title: "Agent response received",
            detail: compactJson(lastTextContent, 1200),
            status: "completed",
            timestamp: new Date().toISOString(),
          });
        }
      } else if (message.type === "tool_use") {
        toolCallCount += 1;
        await recordTraceEvent({
          type: "tool_used",
          title: message.name ?? "Tool used",
          toolName: message.name,
          toolUseId: message.id,
          detail: compactJson(message.input),
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
        await recordTraceEvent({
          type: "tool_result",
          title: message.isError ? "Tool error" : "Tool completed",
          detail: compactJson(message.output),
          toolUseId: message.toolUseId,
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
          metadata: normalizedError,
        });
      }
    }
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

  const { data: parsedStructuredData, cleanText } =
    parseStructuredOutput(lastTextContent);
  const structuredReport = buildStructuredExecutionReport({
    structuredData: parsedStructuredData,
    cleanText,
    rawText: lastTextContent,
    taskText: input.loop.goal,
    requiredFields: stringArray(asRecord(effectiveLoopSpec.verification).requiredFields),
    traceEvents,
    sessionFiles: [],
    hasError,
    errorMessage,
    language: userSettings?.language ?? null,
  });

  const visibleOutput = stripMalformedToolCalls(cleanText).trim();
  const output =
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
