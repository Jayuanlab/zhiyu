import type {
  Workshop,
  WorkshopDirective,
  WorkshopEvent,
  WorkshopMemory,
  WorkshopOutboxItem,
  WorkshopSource,
} from "@/lib/db/schema";
import { formatWorkshopPresentationDesign, resolveWorkshopRunRole } from "./run-prompt";
import {
  getContextProfileBudget,
  resolveWorkshopContextProfile,
  type ContextProfile,
} from "@/lib/ai/context-profile";
import {
  formatWorkshopBoundaryPolicy,
  getWorkshopBoundaryPolicy,
} from "./boundary-policy";
import {
  buildWorkshopMemoryContextPack,
  formatWorkshopMemoryContextPack,
  type WorkshopMemoryContextPack,
} from "./memory-context";
import {
  buildWorkshopRunTimeContext,
  formatWorkshopRunTimeContext,
  type WorkshopRunTimeContext,
} from "./time-context";
import { extractJsonObjectSpan } from "./json-output";

const MAX_TEXT = 24_000;

function truncate(value: string, max = 1_200) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function eventLine(event: WorkshopEvent) {
  const body = event.body ? ` - ${truncate(event.body, 300)}` : "";
  return `#${event.seq} ${event.type}: ${event.title}${body}`;
}

function sourceLine(source: WorkshopSource) {
  const ref = source.uri ?? "";
  return `- [${source.type}] ${source.name}${ref ? `: ${truncate(ref, 500)}` : ""}`;
}

function directiveLine(directive: WorkshopDirective) {
  return `- (${directive.scope}, priority=${directive.priority}) ${truncate(directive.content, 800)}`;
}

function outboxLine(item: WorkshopOutboxItem) {
  return `- [${item.status}, ${item.riskLevel}, ${item.confidence}%] ${truncate(item.message, 500)}`;
}

const HIGH_VALUE_PROMPT_EVENT_TYPES = new Set([
  "blocked",
  "budget_exceeded",
  "decision",
  "degraded",
  "directive_planned",
  "error",
  "memory_written",
  "permission_decision",
  "source_checked",
  "tool_error",
  "watchlist_proposal",
  "workshop_agent_change_proposed",
  "workshop_insight_change_proposed",
]);

const LOW_VALUE_PROMPT_EVENT_TYPES = new Set([
  "review_assistant_completed",
  "agent_text",
  "context_budget_report",
  "loop_run_completed",
  "loop_run_started",
  "run_completed",
  "run_started",
  "tool_result",
]);

function selectPromptEvents(events: WorkshopEvent[], maxEvents: number) {
  const selected = new Map<string, WorkshopEvent>();
  for (const event of events) {
    if (HIGH_VALUE_PROMPT_EVENT_TYPES.has(event.type)) {
      selected.set(event.id, event);
    }
  }
  for (const event of events.slice(-maxEvents)) {
    if (!LOW_VALUE_PROMPT_EVENT_TYPES.has(event.type)) {
      selected.set(event.id, event);
    }
  }
  return [...selected.values()]
    .sort((left, right) => left.seq - right.seq)
    .slice(-maxEvents);
}

function hasAStockIntent(input: {
  workshop: Workshop;
  directives: WorkshopDirective[];
}) {
  const text = [
    input.workshop.name,
    input.workshop.mission,
    ...input.directives.map((directive) => directive.content),
  ]
    .join("\n")
    .toLowerCase();

  return (
    /a[-\s]?share|china stock|stock analyst|market mood|quote|fund flow|main capital|eastmoney/.test(
      text,
    ) ||
    /股票|a股|沪深|主力资金|资金流向|板块|个股|涨停|跌停|趋势|均线|止损|ATR|研报|东方财富|同花顺/.test(
      text,
    )
  );
}

function aStockPriorityInstructions(enabled: boolean) {
  if (!enabled) return [];
  return [
    "",
    "A-share tool priority for this run:",
    "- This workshop or directive appears to be about China A-shares. Before using webSearch, WebFetch, webReadPage, or Bash for market/company data, call the relevant aStock* tool first.",
    "- For broad market heat, limit-up sentiment, hot topics, or sector/theme mood, start with aStockMarketMood.",
    "- For stock codes, current prices, valuation, turnover, or market cap, use aStockQuote before generic web tools.",
    "- For stock-level fund flow, concept/sector attribution, industry ranking, or lockup risk, use aStockSignals before generic web tools.",
    "- For trend-following portfolio decisions, use aStockTrendStateHistory when prior state matters, then use aStockTrendSystem to get current K-line structure, relative-strength ranking, lifecycle state, stop plan, and strategy statistics; use aStockTrendStrategyStats before changing rules or learning from outcomes; use aStockTrend for single-symbol drilldown.",
    "- For ETF holding baskets, constituent weights, report dates, or disclosed holding freshness, use aStockEtfHoldings before generic web tools.",
    "- For company fundamentals, financing balance, holder count, or dividends, use aStockFundamentals before generic web tools.",
    "- For announcements, filings, investor Q&A, or company/news checks, use aStockNewsAndFilings before generic web tools.",
    "- Use webSearch/WebFetch/webReadPage only after the matching aStock* tool returns empty, stale, incomplete, or clearly irrelevant data, and log the fallback reason with workshopLogEvent.",
    "- Avoid Bash for A-share data collection unless the aStock* tools and page-reading tools have already failed. If two external fallbacks fail, stop collecting and summarize the data-source limitation instead of trying more endpoints.",
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringRecordValue(value: unknown): Record<string, string> {
  const record = isRecord(value) ? value : {};
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function workshopSkillInstructions(workshop: Workshop) {
  const config = isRecord(workshop.modelConfig) ? workshop.modelConfig : {};
  const primarySkills = stringArrayValue(config.primarySkills);
  const loopSkillMap = stringRecordValue(config.loopSkillMap);
  const skills = [...primarySkills, ...Object.values(loopSkillMap)].filter(
    (skill, index, all) => all.indexOf(skill) === index,
  );

  if (skills.length === 0) return [];

  return [
    "",
    "Workshop primary skills:",
    ...skills.map((skill) => `- ${skill}`),
    "- Before collecting mission data, call the Skill tool for the most relevant primary skill above and follow its workflow unless the Skill tool is unavailable.",
    "- If the Skill tool fails or is unavailable, continue only with the same conservative rules and log `methodologyLoaded: skill unavailable` using workshopLogEvent.",
    "- Do not treat a skill as permission to act. Tool permissions, boundary policy, data gates, and owner approval still control action.",
  ];
}

function workshopCanMaintainPaperWatchlist(workshop: Workshop) {
  const config = isRecord(workshop.modelConfig) ? workshop.modelConfig : {};
  const configuredTools = [
    ...stringArrayValue(config.allowedTools),
    ...stringArrayValue(config.primaryTools),
  ];

  return (
    config.role === "watchlist_selector" ||
    configuredTools.includes("quantMarketDiscoverCandidates") ||
    configuredTools.includes("quantPaperProposeWatchlistChange")
  );
}

function workshopConfiguredTools(workshop: Workshop) {
  const config = isRecord(workshop.modelConfig) ? workshop.modelConfig : {};
  return [
    ...stringArrayValue(config.allowedTools),
    ...stringArrayValue(config.primaryTools),
    ...stringArrayValue(config.observationTools),
  ];
}

function workshopIsPaperTrader(workshop: Workshop) {
  return resolveWorkshopRunRole(workshop) === "paper_trader";
}

function workshopUsesWechatOwnerContext(workshop: Workshop) {
  return workshopConfiguredTools(workshop).some((tool) =>
    /^(wechat|interaction|ownerContext)/.test(tool),
  );
}

function workshopUsesContentPublishing(workshop: Workshop) {
  return workshopConfiguredTools(workshop).some((tool) =>
    /^(video|douyin)/.test(tool),
  );
}

function paperTradingInstructions(enabled: boolean) {
  if (!enabled) return [];
  return [
    "- For paper-trading watchlist reports, quantPaperGetWatchlist returns a current quote snapshot in items. Use those items or a same-run aStockQuote result for current prices. Never use prices from recent workshop logs as current market data.",
    "- The active paper-trading watchlist is a controlled object. If the quant service is unavailable or only returns sample/unavailable data, do not infer or invent the watchlist; record a blocker and wait for a fresh quant observation.",
    "- Paper-trading simulator actions are internal sandbox actions, not real broker orders. Real broker/placeOrder/buy/sell/trade actions remain forbidden, but quantPaperPlaceOrder may be used when the current task policy allows it and the simulated trading rules are satisfied.",
    "- For paper-trading decisions, price, volume, fund flow, valuation, position, T+1, take-profit, and stop-loss rules remain the primary control signals. News and filings are supporting evidence only: use them to adjust confidence, explain catalysts/risks, or require owner review, not to trigger a trade by themselves.",
    "- For paper-trading rotation, sell/reduce weak holdings before considering new buys. A holding with two or more weak signals (stop/invalidation breach, sector/watchlist underperformance, negative fund flow, theme collapse, material negative news, or volume-price deterioration) should normally trigger simulated reduction when available quantity permits, especially if a stronger current-watchlist replacement exists.",
    "- Replacement buys must stay inside the current watchlist and should use cash released from weak holdings. Compare the source holding and replacement candidate on relative strength, liquidity, risk/reward, news, invalidation line, and data quality before placing a simulated order.",
    "- For trend-following paper-trading decisions, call aStockTrendStateHistory first when evaluating deterioration/improvement, then call aStockTrendSystem. Call aStockTrendStrategyStats before changing rules or writing post-market learning. Include lifecycleState, relativeStrength rank, trendScore, MA/ATR/trailing stop, invalidation, and risk/reward in the trade thesis or no-action reason.",
    "- Before concrete paper-trading buy/sell decisions or abnormal move explanations, call aStockNewsAndFilings for the relevant code when tool budget permits. If it returns empty, stale, irrelevant, or times out, proceed with market-data rules and log the news-data limitation.",
    '- When news/filings are checked, include a concise "news reference" in the visible judgment: material positive, material negative, neutral/no material news, stale, or unverified. Treat rumors and old news as low-confidence context.',
    '- When you decide a paper-trading buy/sell condition is satisfied, call quantPaperPlaceOrder in the same run. Do not only write "\u51c6\u5907\u4e70\u5165", "\u62df\u4e70\u5165", or "\u4e0b\u4e00\u4ea4\u6613\u65e5\u8bd5\u63a2\u5efa\u4ed3" unless you also record a concrete rule/data reason why no simulated order is submitted.',
    '- When a future paper-trading condition should be monitored instead of executed now, write a workshop memory with kind "watchlist" or "finding" that includes code, direction, trigger price/zone, quantity or target cash, invalidation rule, and the next run that should verify it.',
  ];
}

function wechatOwnerContextInstructions(enabled: boolean) {
  if (!enabled) return [];
  return [
    "- Start WeChat monitoring by persisting messages with wechatRecordNewMessages, then work from durable eventIds.",
    "- Use interaction or ownerContext tools only to derive evidence-linked notes, tasks, or memory candidates. Leave low-signal chatter and unsupported claims as raw evidence.",
    "- Use wechatLocalHistory or wechatLocalSearch only when persisted events need more conversation context.",
    "- To reply, create an evidence-linked draft. The host may auto-send only when the recipient is whitelisted and the outbox boundary passes.",
  ];
}

function contentPublishingInstructions(enabled: boolean) {
  if (!enabled) return [];
  return [
    "- For investment video production, prefer videoRenderInvestmentBrief as the final renderer. Use videoGenerateInvestmentBrief only for optional background material.",
    "- For Douyin publishing, check the local account before creating a publishing plan. Do not claim publication unless the tool result explicitly reports an executed or published status.",
    "- Keep exact outgoing content and AI-generated disclosure visible for owner review before public publishing.",
  ];
}

function paperWatchlistInstructions(canMaintainWatchlist: boolean) {
  if (canMaintainWatchlist) {
    return [
      "- Watchlist selection controls a three-layer universe: candidate pool for broad market discovery, core watchlist for focused daily observation, and trading/holding pools for paper-trading consumption and protected positions.",
      "- Keep the candidate pool broad and evidence-rich. When discovering opportunities, call quantMarketDiscoverCandidates with clear themes/filters; returned candidates are persisted into the non-trading candidate pool and do not automatically become tradable watchlist symbols.",
      "- Promote only high-conviction candidates into the active core/trading watchlist. Use quantPaperProposeWatchlistChange only when there is a concrete add/remove set with evidence, strategy fit, risk, and why the change improves the active pool.",
      "- Before calling quantPaperProposeWatchlistChange, compare add/remove/keep against the latest quantPaperGetWatchlist result from this run. The remove list may include only current active core/trading watchlist symbols; candidate-pool-only cleanup must be logged as candidate maintenance or a follow-up task, not submitted as a watchlist-change proposal.",
      "- If quantPaperGetWatchlist, quantMarketDiscoverCandidates, or quantPaperProposeWatchlistChange fails, or if the quant dashboard reports sample/unavailable data, stop the watchlist control action and log the exact blocker. Never invent, randomize, or hand-compose a replacement active watchlist.",
      "- Data-source fallback or sourceSwitch is not a watchlist blocker by itself. Disclose provider/detail/warning, but do not reduce proposal strength unless the returned data is sample, unavailable, empty, stale, or missing required fields.",
      "- Do not remove symbols with current paper positions or open paper orders from the quote universe; they must remain under holding/order tracking until the exposure is resolved.",
      '- If you write that a watchlist stock is "建议移除", "建议加入", "建议主人确认后移除", "符合移除标准", or an equivalent concrete watchlist action, call quantPaperProposeWatchlistChange in the same run. If you intentionally do not create a proposal, log the exact reason.',
      "- Treat quantPaperProposeWatchlistChange as an auditable internal control action. The tool auto-applies valid changes after validation; invalid changes are recorded but not applied.",
    ];
  }

  return [
    "- This workshop is not responsible for maintaining the paper-trading watchlist. Do not discover, add, remove, replace, or propose changes to symbols outside the current watchlist.",
    "- If you notice an out-of-watchlist opportunity or a watchlist-maintenance idea, do not call quantMarketDiscoverCandidates or quantPaperProposeWatchlistChange. Log at most a brief boundary note and leave watchlist maintenance to the dedicated watchlist-selection workshop.",
  ];
}

export function buildWorkshopPrompt(input: {
  workshop: Workshop;
  sources: WorkshopSource[];
  memories: WorkshopMemory[];
  directives: WorkshopDirective[];
  events: WorkshopEvent[];
  outbox: WorkshopOutboxItem[];
  maxToolCalls: number;
  memoryContext?: WorkshopMemoryContextPack;
  runTimeContext?: WorkshopRunTimeContext;
  contextProfile?: ContextProfile;
  /** Role and skills are already assembled in the runtime system prompt. */
  separateSystemPrompt?: boolean;
}) {
  const contextProfile =
    input.contextProfile ?? resolveWorkshopContextProfile(input.workshop);
  const profileBudget = getContextProfileBudget(contextProfile);
  const boundaryPolicy = getWorkshopBoundaryPolicy(input.workshop);
  const presentationDesign = formatWorkshopPresentationDesign(input.workshop);
  const runTimeContext =
    input.runTimeContext ??
    buildWorkshopRunTimeContext({ timezone: "Asia/Shanghai" });
  const shouldPrioritizeAStock = hasAStockIntent({
    workshop: input.workshop,
    directives: input.directives,
  });
  const canMaintainPaperWatchlist = workshopCanMaintainPaperWatchlist(
    input.workshop,
  );
  const isPaperTrader = workshopIsPaperTrader(input.workshop);
  const usesWechatOwnerContext = workshopUsesWechatOwnerContext(input.workshop);
  const usesContentPublishing = workshopUsesContentPublishing(input.workshop);
  const memoryContext =
    input.memoryContext ??
    buildWorkshopMemoryContextPack({
      workshop: input.workshop,
      directives: input.directives,
      events: input.events,
      memories: input.memories,
    });
  const prompt = [
    "You are working inside an open-ended Work Workshop.",
    "",
    "Run Time Context (authoritative):",
    formatWorkshopRunTimeContext(runTimeContext),
    "",
    "Time rules:",
    "- Treat Run Time Context as the only authoritative source for the current date, time, weekday, and timezone.",
    "- Interpret today, yesterday, tomorrow, this morning, this week, current trading day, and similar relative time phrases relative to Run Time Context.localDate.",
    "- Memories, prior events, source notes, and search results may contain relative time words from their own historical context; never reuse those words as the current date unless their timestamp matches this run.",
    "- Before using a recalled memory as current-day evidence, compare its createdAt/updatedAt/source event time with Run Time Context.localDate and verify stale or ambiguous facts with current sources.",
    "",
    ...(input.separateSystemPrompt ? [] : [
    "Core behavior:",
    "- Explore autonomously within the workshop mission.",
    "- Decide what to inspect next, but keep the run bounded and useful.",
    "- Use workshopSearchMemory for durable memory recall. It asks the unified memory platform to plan recall, apply permissions, deduplicate canonical memories, and return an auditable ContextPack.",
    "- Use knowledge tools only when the task needs uploaded documents or source documents. Do not use raw-message or broad legacy memory search as the default workshop memory path.",
    "- Use webReadPage for finance/news/company pages, old pages, or any web page where WebFetch returns garbled or incomplete content.",
    "- Use workshopLogEvent during the run to make your work visible.",
    "- When a concrete problem exceeds your Work's responsibility, you may inspect colleagues and request bounded help if collaboration is explicitly allowed. Include evidence and a clear acceptance condition. Do not treat a colleague's reply as proof until you verify the original problem.",
    "- Use workshopSearchMemory/workshopGetMemoryEvidence/workshopListMemoryCandidates/workshopReviewMemory/workshopReadMemory/workshopWriteMemory for durable workshop memory.",
    "- Use workshopRecordMemoryRecallFeedback when recall materially helps or fails. Feedback is an observation and must not directly mutate memory or recall policy.",
    "- Treat the Control Memory Context as the current self-evolving state estimate. It is filtered for this mission, but can be incomplete; use workshopSearchMemory when the task needs a narrower recall.",
    "- New reusable workshop experience should usually be written as active memory so future runs can learn from it. Use candidate only for owner facts, weak evidence, or information that should wait for stewardship.",
    "- Upgrade active memory to verified after repeated supporting evidence or outcomes. Mark memory weakened when counter-evidence appears, and dismissed when stale, duplicate, or unsupported.",
    "- Candidate memories are not part of the default Control Memory Context until activated or verified; use workshopListMemoryCandidates and workshopReviewMemory when doing memory stewardship.",
    "- Before relying on a recalled memory for high-impact decisions, external actions, owner notifications, or contradiction resolution, call workshopGetMemoryEvidence and inspect its source events.",
    "- If a memory has no resolvable evidence and the action is high impact, treat it as a hypothesis and verify with current sources before acting.",
    "- Memory comes before notification: stable findings, preferences, boundaries, reusable rules, source lessons, and recurring mistakes should be written to workshop memory instead of sent to the owner.",
    "- Before ending a run, decide whether the run produced reusable memory. If yes, write memoryCandidates or call workshopWriteMemory with sourceEventIds.",
    "- Use workshopListSources and workshopGetDirectives when you need the latest workshop inputs.",
    "- Use workshopCreateLoopTask only when a durable recurring, scheduled, or background task would materially improve the workshop mission. It creates a paused task proposal that the owner must review and activate before it can run.",
    "- Treat active user directives that ask for recurring, scheduled, background monitor, reminder, or conditional follow-up work as task-proposal candidates.",
    "- For one-off analysis or work that can be completed in this run, complete it in this run instead of creating a Loop task.",
    "- Do not create overlapping task proposals. If you propose one, include cadence, sources, action boundary, and success criteria in the intent.",
    "- Choose the tool that gives the best evidence, not the newest tool by default: specialized tools first when they cover the task, generic tools as fallback when they are more complete, fresher, or the specialized tool returns empty/incomplete data.",
    ...paperTradingInstructions(!input.separateSystemPrompt && isPaperTrader),
    ...(!input.separateSystemPrompt && (isPaperTrader || canMaintainPaperWatchlist)
      ? paperWatchlistInstructions(canMaintainPaperWatchlist)
      : []),
    ...wechatOwnerContextInstructions(!input.separateSystemPrompt && usesWechatOwnerContext),
    ...contentPublishingInstructions(!input.separateSystemPrompt && usesContentPublishing),
    "- When any tool result creates or returns a sourceEventId, cite that id in workshopWriteMemory.sourceEventIds. Cite sourceEventIds in workshopCreateOutboxDraft only when an owner notification is truly required. If you omit sourceEventIds, the host may auto-attach recent source_checked events.",
    "- Do not use global WeChat preview/send tools. All owner notifications must go through workshopCreateOutboxDraft and the workshop outbox boundary.",
    "- If the boundary mode is observe or external messages are blocked, do not create outbox drafts.",
    "- Do not create outbox drafts for routine summaries, normal market observations, completed checks, reusable findings, or status updates. Use events, memory, tasks, or proposals instead.",
    "- Create an outbox draft only when the owner must act or know now: needs_owner_decision, urgent_risk, reply_required, approval_required, or owner_requested. Include notifyReason and whyNow. The host may auto-send only when the recipient is whitelisted and the boundary passes.",
    ...(shouldPrioritizeAStock
      ? [
          "- Do not provide real-money trading instructions. For market analysis, include confidence, sources, and opposing risks.",
        ]
      : []),
    "- Do not reveal hidden reasoning. Logs should be concise user-visible summaries.",
    ...(input.separateSystemPrompt ? [] : workshopSkillInstructions(input.workshop)),
    ...aStockPriorityInstructions(shouldPrioritizeAStock),
    ]),
    "",
    `Workshop: ${input.workshop.name}`,
    `Autonomy level: ${input.workshop.autonomyLevel}`,
    ...(input.separateSystemPrompt ? [] : [`Mission: ${input.workshop.mission}`]),
    `Max tool calls for this run: ${input.maxToolCalls}`,
    "",
    "Current boundary policy:",
    formatWorkshopBoundaryPolicy(boundaryPolicy),
    "",
    "Current sources:",
    input.sources.length > 0
      ? input.sources
          .filter((source) => source.enabled)
          .slice(0, profileBudget.sourceLimit)
          .map(sourceLine)
          .join("\n")
      : "- No explicit sources yet.",
    "",
    "Active user directives:",
    input.directives.length > 0
      ? input.directives
          .slice(0, profileBudget.directiveLimit)
          .map(directiveLine)
          .join("\n")
      : "- No active directives.",
    "",
    "Control Memory Context:",
    formatWorkshopMemoryContextPack(input.separateSystemPrompt
      ? { ...memoryContext, taskIntent: input.directives.map(item => item.content).join("\n") || `Current run of ${input.workshop.name}` }
      : memoryContext),
    "",
    "Recent events:",
    input.events.length > 0
      ? selectPromptEvents(input.events, profileBudget.eventLimit)
          .map(eventLine)
          .join("\n")
      : "- No prior events.",
    "",
    "Recent outbox:",
    input.outbox.length > 0
      ? input.outbox.slice(0, profileBudget.outboxLimit).map(outboxLine).join("\n")
      : "- No recent outbox drafts.",
    "",
    ...(presentationDesign ? ["Owner presentation design (expectations, not proof):", presentationDesign, ""] : []),
    "Close this run with an owner-facing work presentation inside the JSON below: goal and actual result, verified deliverables with evidence, limitations or failures, owner decisions, and next steps. Narrative is not proof of execution; cite real event IDs and tool receipts. Follow the same presentation shape for every Work role.",
    "",
    "At the end, return a compact strict JSON summary inside a single ```json fenced block with this shape. If you already wrote logs/memories/outbox via tools, avoid duplicating them here:",
    JSON.stringify(
      {
        summary: "short run summary for the owner",
        presentation: {
          title: "short meeting title",
          summary: "what was actually achieved in this run",
          reportMarkdown: "owner-facing work report with results, evidence, limits and next steps",
          evidenceEventIds: ["IDs of actual source or tool receipt events"],
          warnings: ["unresolved limitations or failures, if any"],
          nextSteps: ["specific next action or owner decision"],
        },
        logEvents: [
          {
            type: "observation|source_checked|hypothesis|decision|plan|blocked",
            title: "short title",
            body: "what happened, user-visible, no hidden reasoning",
            metadata: {},
          },
        ],
        memoryCandidates: [
          {
            kind: "finding|hypothesis|watchlist|preference|boundary|source_note|mistake|outbox_summary",
            content: "durable memory worth retaining",
            confidence: 0,
            tags: ["optional"],
          },
        ],
        outboxDrafts: [
          {
            channel: "wechat_desktop",
            recipientName: "optional exact recipient",
            message: "draft message, do not send",
            notifyReason:
              "needs_owner_decision|urgent_risk|reply_required|approval_required|owner_requested",
            whyNow:
              "why this needs owner attention now instead of memory/event/task/proposal",
            confidence: 0,
            riskLevel: "low|medium|high",
            sourceEventIds: [],
          },
        ],
        nextWakeupSuggestion: {
          reason: "why to wake up again",
          delayMinutes: 0,
        },
      },
      null,
      2,
    ),
  ].join("\n");

  const maxText = profileBudget.promptMaxChars || MAX_TEXT;
  if (prompt.length <= maxText) return prompt;
  const contractStart = prompt.indexOf("At the end, return a compact strict JSON summary");
  const contract = contractStart >= 0 ? prompt.slice(contractStart) : "";
  const notice = "\n\n[Context truncated to fit workshop run budget.]\n\n";
  return `${prompt.slice(0, Math.max(0, maxText - contract.length - notice.length))}${notice}${contract}`;
}

export function extractJsonBlock(text: string): Record<string, unknown> | null {
  return extractJsonObjectSpan(text)?.value ?? null;
}
