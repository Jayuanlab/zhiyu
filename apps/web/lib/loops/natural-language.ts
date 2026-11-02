import { modelApiUrl } from "@openzhiyu/shared/model-configuration";
import { requireModelConfiguration } from "@/lib/ai/model-configuration";
import { z } from "zod";
import type { Loop } from "@/lib/db/schema";
import { createLoop } from "./service";
import { loopSpecToCreateLoopInput, parseLoopSpec, type LoopSpec } from "./spec";

export interface NaturalLanguageLoopDraft {
  name: string;
  description: string;
  spec: LoopSpec;
  planner: {
    agent: "natural-language-planner";
    model: string;
    parser: "local_llm_api" | "local_rules";
  };
  extracted: {
    scheduleLabel: string;
    timezone: string;
    recipientName?: string;
    city?: string;
    deliveryPlatform?: "wechat_desktop";
    externalWriteMode: "manual_approval" | "loop_approved";
    missingFields: string[];
  };
}

export interface NaturalLanguageLoopInput {
  userId: string;
  workshopId?: string | null;
  intent: string;
  timezone?: string;
  externalWriteMode?: "manual_approval" | "loop_approved";
}

type LocalModelProviderConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

const nullableOptionalString = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().optional(),
);

const nullableOptionalPositiveInt = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.number().int().positive().optional(),
);

const nullableOptionalSendMode = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.enum(["manual_approval", "loop_approved"]).optional(),
);

const stringArrayFromModel = z.preprocess((value) => {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  return value;
}, z.array(z.string()).default([]));

const naturalLanguageLoopInputSchema = z.object({
  userId: z.string().min(1),
  workshopId: z.string().min(1).nullable().optional(),
  intent: z.string().min(4),
  timezone: z.string().optional(),
  externalWriteMode: z.enum(["manual_approval", "loop_approved"]).optional(),
});

const localModelLoopDraftSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    goal: z.string().min(1),
    schedule: z
      .object({
        type: z.enum(["manual", "cron", "interval", "once"]),
        cronExpression: nullableOptionalString,
        timezone: nullableOptionalString,
        label: nullableOptionalString,
        intervalMinutes: nullableOptionalPositiveInt,
        onceAt: nullableOptionalString,
      })
      .strict(),
    taskKind: z.string().min(1).default("general_loop"),
    contextInstructions: nullableOptionalString,
    weather: z
      .object({
        city: nullableOptionalString,
        date: nullableOptionalString,
      })
      .strict()
      .optional(),
    delivery: z
      .object({
        platform: z.enum(["wechat_desktop", "none"]).default("none"),
        recipientName: nullableOptionalString,
        sendMode: nullableOptionalSendMode,
      })
      .strict()
      .optional(),
    missingFields: stringArrayFromModel,
    allowedActions: stringArrayFromModel,
    requiredApprovalActions: stringArrayFromModel,
    successCriteria: stringArrayFromModel,
  })
  .strict();

type LocalModelLoopDraft = z.infer<typeof localModelLoopDraftSchema>;

type LoopDraftParser = "local_llm_api" | "local_rules";

function parsePositiveIntEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isRuleParserEnabled() {
  return process.env.LOOP_NL_RULE_PARSER === "true";
}

function defaultTimezone(input?: string) {
  return input?.trim() || "Asia/Shanghai";
}

function normalizeOptionalString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function buildChatCompletionsUrl(baseUrl: string) {
  return modelApiUrl(baseUrl, "chat/completions");
}

function chineseNumberToInt(value: string): number | null {
  const normalized = value
    .trim()
    .replace(/两/g, "二")
    .replace(/〇/g, "零");
  if (/^\d+$/.test(normalized)) return Number(normalized);

  const digits: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };

  if (normalized === "十") return 10;
  if (normalized.startsWith("十")) {
    const ones = normalized.slice(1);
    return 10 + (ones ? (digits[ones] ?? Number.NaN) : 0);
  }
  if (normalized.includes("十")) {
    const [tensRaw, onesRaw] = normalized.split("十");
    const tens = digits[tensRaw] ?? Number.NaN;
    const ones = onesRaw ? (digits[onesRaw] ?? Number.NaN) : 0;
    return Number.isNaN(tens) || Number.isNaN(ones)
      ? null
      : tens * 10 + ones;
  }

  return normalized.length === 1 ? (digits[normalized] ?? null) : null;
}

function normalizeHour(hour: number, periodHint: string) {
  if (/下午|晚上|傍晚/.test(periodHint) && hour < 12) return hour + 12;
  if (/中午/.test(periodHint) && hour < 11) return hour + 12;
  if (/凌晨/.test(periodHint) && hour === 12) return 0;
  return hour;
}

function parseDailyTime(intent: string) {
  const numericMatch = intent.match(
    /(凌晨|早上|上午|中午|下午|晚上|傍晚)?\s*(\d{1,2})\s*[:：点时]\s*(?:(\d{1,2})\s*分?)?/,
  );
  if (numericMatch) {
    const hour = normalizeHour(Number(numericMatch[2]), numericMatch[1] ?? "");
    const minute = Number(numericMatch[3] ?? 0);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute };
    }
  }

  const chineseMatch = intent.match(
    /(凌晨|早上|上午|中午|下午|晚上|傍晚)?\s*([零一二两三四五六七八九十]{1,3})\s*[点时]\s*(半|([零一二两三四五六七八九十]{1,3})\s*分?)?/,
  );
  if (!chineseMatch) return null;

  const rawHour = chineseNumberToInt(chineseMatch[2]);
  const rawMinute = chineseMatch[3]
    ? chineseMatch[3] === "半"
      ? 30
      : chineseNumberToInt(chineseMatch[4] ?? "")
    : 0;
  if (rawHour === null || rawMinute === null) return null;

  const hour = normalizeHour(rawHour, chineseMatch[1] ?? "");
  if (hour < 0 || hour > 23 || rawMinute < 0 || rawMinute > 59) return null;
  return { hour, minute: rawMinute };
}

function parseIntervalMinutes(intent: string): number | null {
  const match = intent.match(
    /(?:每隔|每|every)\s*([0-9]{1,4}|[零一二两三四五六七八九十]{1,4})\s*(分钟|分|小时|钟头|minutes?|hours?)/i,
  );
  if (!match) return null;

  const amount = /^\d+$/.test(match[1])
    ? Number(match[1])
    : chineseNumberToInt(match[1]);
  if (!amount || amount <= 0) return null;

  return /小时|钟头|hours?/i.test(match[2]) ? amount * 60 : amount;
}

function parseMarketSessionTime(intent: string) {
  if (/开盘前|盘前|before\s+(?:market\s+)?open|pre-?market/i.test(intent)) {
    return { hour: 9, minute: 0 };
  }
  if (/开盘后|盘中|market\s+open/i.test(intent)) {
    return { hour: 9, minute: 35 };
  }
  if (/收盘后|盘后|after\s+(?:market\s+)?close|post-?market/i.test(intent)) {
    return { hour: 15, minute: 10 };
  }
  return null;
}

function hasTradingDayScheduleIntent(intent: string) {
  return /交易日|工作日|开盘前|开盘后|收盘后|盘前|盘中|盘后|trading\s+day|weekdays?|market\s+open|market\s+close|pre-?market|post-?market/i.test(
    intent,
  );
}

function shouldPreferRuleDraft(intent: string) {
  return (
    isOwnerContextIntervalTask(intent) ||
    hasTradingDayScheduleIntent(intent) &&
    /关注列表|观察列表|观察名单|自选|异动|风险|机会|简报|报告|watchlist|brief|report|signals?/i.test(
      intent,
    )
  );
}

function isOwnerContextIntervalTask(intent: string) {
  return (
    parseIntervalMinutes(intent) !== null &&
    /微信|消息|聊天|个人记忆|主人知识库|知识库|记忆|待办|笔记|候选|证据|ownerContext|wechat/i.test(
      intent,
    )
  );
}

function inferWechatRecipient(intent: string) {
  if (/文件传输助手/.test(intent)) return "文件传输助手";

  const patterns = [
    /给\s*([^，。,.]{1,24}?)\s*(?:发|发送|推送|通知|汇报)/,
    /发给\s*([^，。,.]{1,24}?)(?:\s|$|一条|消息|微信)/,
    /发送给\s*([^，。,.]{1,24}?)(?:\s|$|一条|消息|微信)/,
  ];

  for (const pattern of patterns) {
    const matched = intent.match(pattern)?.[1]?.trim();
    if (matched) return matched.replace(/^我的/, "").trim();
  }

  return undefined;
}

function inferWeatherCity(intent: string) {
  if (!/天气|天气预报|气温/.test(intent)) return undefined;
  const knownCities = [
    "北京",
    "上海",
    "广州",
    "深圳",
    "杭州",
    "成都",
    "重庆",
    "天津",
    "南京",
    "武汉",
    "西安",
    "苏州",
    "郑州",
    "长沙",
    "青岛",
    "厦门",
    "福州",
    "合肥",
    "沈阳",
    "大连",
    "宁波",
    "无锡",
    "佛山",
    "东莞",
  ];
  return knownCities.find((city) => intent.includes(city));
}

function tryBuildRuleBasedLoopDraft(
  input: Required<NaturalLanguageLoopInput>,
): LocalModelLoopDraft | null {
  const intent = input.intent.trim();
  const intervalMinutes = parseIntervalMinutes(intent);
  const time = parseDailyTime(intent) ?? parseMarketSessionTime(intent);
  const isTradingDay = hasTradingDayScheduleIntent(intent);
  const isRecurringDaily =
    /每天|每日|天天|每早|每晚|每个交易日|每个工作日|每交易日|每工作日|every\s+day|daily|weekdays?/i.test(
      intent,
    ) || isTradingDay;
  const isWeatherTask = /天气|天气预报|气温/.test(intent);
  const isMarketReportTask =
    /A股|Ａ股|股市|股票|行情|市场报告|关注列表|观察列表|观察名单|自选|异动|开盘|收盘|盘前|盘后|market|stock|watchlist|signals?/i.test(
      intent,
    );
  const mentionsWechat = /微信|文件传输助手|发给|发送给|推送|通知/.test(intent);
  const recipientName = mentionsWechat
    ? inferWechatRecipient(intent)
    : undefined;
  const city = inferWeatherCity(intent);

  if (intervalMinutes && isOwnerContextIntervalTask(intent)) {
    const scheduleLabel = `每 ${intervalMinutes} 分钟`;
    return {
      name: "主人知识库定时处理",
      description: `${scheduleLabel}检查微信来源并处理个人记忆候选`,
      goal: intent,
      schedule: {
        type: "interval",
        intervalMinutes,
        label: scheduleLabel,
      },
      taskKind: "owner_context_memory_processing",
      contextInstructions: [
        "检查已配置的微信来源是否有新消息，必要时记录新消息。",
        "调用 ownerContextProcessRecordedMessages 提取主人知识库候选。",
        "调用 ownerContextListCandidates 和 ownerContextGetEvidence 审核证据。",
        "只确认与主人工作、联系人关系、承诺、偏好、项目、边界、风险相关且证据充分的记忆、待办或笔记。",
        "驳回广告、群聊噪声、重复项、无上下文闲聊和证据不足内容。",
        "每次运行用 workshopLogEvent 汇报采集数量、候选数量、确认/驳回数量和数据源问题。",
        "不外发消息，不删除原始证据，不处理量化和交易，所有外部动作必须人工确认。",
      ].join("\n"),
      delivery: {
        platform: "none" as const,
        sendMode: input.externalWriteMode,
      },
      missingFields: [],
      allowedActions: [
        "wechatRecordNewMessages",
        "wechatListRecordedMessages",
        "ownerContextProcessRecordedMessages",
        "ownerContextListCandidates",
        "ownerContextGetEvidence",
        "ownerContextReviewCandidate",
        "interactionCreateWikiNote",
        "interactionCreateTaskCandidate",
        "interactionCreateMemoryCandidate",
        "workshopWriteMemory",
        "workshopLogEvent",
      ],
      requiredApprovalActions: [
        "sendMessage",
        "sendEmail",
        "wechatDesktopSendMessage",
        "deleteOriginalEvidence",
      ],
      successCriteria: [
        "已检查微信来源并记录新消息或说明没有新消息",
        "已处理主人知识库候选并保留原始证据关联",
        "确认、驳回和待确认候选均有理由",
        "处理结果已写入车间工作记录",
      ],
    };
  }

  if (!time || (!isRecurringDaily && !isWeatherTask && !isMarketReportTask)) {
    return null;
  }

  const scheduleLabel = `${isTradingDay ? "每个交易日" : "每天"} ${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
  const schedule = {
    type: "cron" as const,
    cronExpression: `${time.minute} ${time.hour} * * ${isTradingDay ? "1-5" : "*"}`,
    timezone: input.timezone,
    label: scheduleLabel,
  };
  const delivery =
    mentionsWechat || recipientName
      ? {
          platform: "wechat_desktop" as const,
          recipientName,
          sendMode: input.externalWriteMode,
        }
      : {
          platform: "none" as const,
          sendMode: input.externalWriteMode,
        };
  const missingFields = [
    ...(mentionsWechat && !recipientName ? ["recipientName"] : []),
    ...(isWeatherTask && !city ? ["city"] : []),
  ];

  if (isWeatherTask) {
    const target = city ? `${city}天气预报` : "天气预报";
    return {
      name: `每日${target}推送`,
      description: `${scheduleLabel}生成${target}${recipientName ? `并发送给${recipientName}` : ""}`,
      goal: intent,
      schedule,
      taskKind: "weather_wechat_delivery",
      contextInstructions: `获取${city ?? "指定城市"}当日天气预报，整理为简洁消息${recipientName ? `，发送给${recipientName}` : ""}。`,
      weather: {
        city,
        date: "today",
      },
      delivery,
      missingFields,
      allowedActions: ["getWeather"],
      requiredApprovalActions: [],
      successCriteria: [
        "成功获取当日天气预报",
        recipientName ? `消息成功发送至${recipientName}` : "消息发送目标明确",
      ],
    };
  }

  if (isMarketReportTask) {
    const isWatchlistTask =
      /关注列表|观察列表|观察名单|自选|watchlist/i.test(intent);
    return {
      name: isWatchlistTask ? "交易日盘前关注列表" : "每日A股报告推送",
      description: `${scheduleLabel}${isWatchlistTask ? "生成盘前关注列表" : "生成A股市场报告"}${recipientName ? `并发送给${recipientName}` : ""}`,
      goal: intent,
      schedule,
      taskKind: "market_report_wechat_delivery",
      contextInstructions: isWatchlistTask
        ? `在开盘前获取A股市场、公告、研报、新闻、异动和风险信号，生成结构化关注列表：标的/主题、关注原因、证据来源、风险、优先级${recipientName ? `，发送给${recipientName}` : ""}。`
        : `获取当日A股主要指数、涨跌幅及市场热点，生成结构化简报${recipientName ? `，发送给${recipientName}` : ""}。`,
      delivery,
      missingFields,
      allowedActions: ["fetchMarketData", "generateReport"],
      requiredApprovalActions: [],
      successCriteria: [
        isWatchlistTask
          ? "成功生成包含标的/主题、关注原因、证据来源、风险和优先级的盘前关注列表"
          : "成功获取并整理当日A股市场数据",
        isWatchlistTask ? "关注列表可用于开盘前快速决策" : "报告内容准确且格式清晰",
        recipientName ? `消息成功发送至${recipientName}` : "消息发送目标明确",
      ],
    };
  }

  return {
    name: "每日自动任务",
    description: `${scheduleLabel}执行：${intent}`,
    goal: intent,
    schedule,
    taskKind: "general_loop",
    contextInstructions: intent,
    delivery,
    missingFields,
    allowedActions: [],
    requiredApprovalActions: [],
    successCriteria: ["任务按计划执行", "任务结果已记录"],
  };
}

async function resolveLocalModelProviderConfig(userId: string): Promise<LocalModelProviderConfig> {
  return requireModelConfiguration({ userId, purpose: "loop_parser" });
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
    throw new Error("Local LLM did not return JSON.");
  }
}

function buildParserPrompt(input: Required<NaturalLanguageLoopInput>) {
  return [
    "Convert the user's natural-language automation request into strict JSON for an Zhiyu Loop draft.",
    "Return JSON only. Do not include markdown or comments.",
    "",
    "Required JSON shape:",
    JSON.stringify(
      {
        name: "short task card title",
        description: "short human-readable summary",
        goal: "full task goal",
        schedule: {
          type: "manual|cron|interval|once",
          cronExpression: "45 15 * * *",
          timezone: "Asia/Shanghai",
          label: "every day 15:45",
          intervalMinutes: 60,
          onceAt: "2026-06-27T15:45:00+08:00",
        },
        taskKind: "weather_wechat_delivery|general_loop",
        contextInstructions: "execution instructions",
        weather: { city: "Beijing", date: "today" },
        delivery: {
          platform: "wechat_desktop|none",
          recipientName: "File Transfer Assistant",
          sendMode: "loop_approved|manual_approval",
        },
        missingFields: ["recipientName"],
        allowedActions: ["getWeather", "wechatDesktopSendMessage"],
        requiredApprovalActions: [],
        successCriteria: ["criteria"],
      },
      null,
      2,
    ),
    "",
    "Rules:",
    "- Infer schedule parameters from Chinese or English time expressions.",
    "- Omit unknown optional fields instead of returning null.",
    "- For '下午三点45', '下午三点四十五', '15:45', use cronExpression '45 15 * * *'.",
    "- For '每天早上九点', use cronExpression '0 9 * * *'.",
    "- For '每5分钟', '每 5 分钟', or 'every 5 minutes', use schedule.type='interval' and intervalMinutes=5.",
    "- If the user says WeChat, file transfer assistant, send, push, notify, or message, infer delivery when the recipient is explicit.",
    "- For desktop WeChat delivery, set delivery.platform to 'wechat_desktop'.",
    "- Set delivery.sendMode to the requested externalWriteMode.",
    "- Do not invent missing recipients, cities, projects, or platforms; put missing field names in missingFields.",
    "- Keep Chinese requests in Chinese where possible.",
    "",
    `Default timezone: ${input.timezone}`,
    `Requested externalWriteMode: ${input.externalWriteMode}`,
    `User request: ${input.intent}`,
  ].join("\n");
}

function buildCompactParserPrompt(input: Required<NaturalLanguageLoopInput>) {
  return [
    "Return JSON only for an Zhiyu Loop draft.",
    "Keys: name, description, goal, schedule, taskKind, contextInstructions, weather, delivery, missingFields, allowedActions, requiredApprovalActions, successCriteria.",
    "schedule={type:'manual|cron|interval|once',cronExpression?,timezone?,label?,intervalMinutes?,onceAt?}.",
    "delivery={platform:'wechat_desktop|none',recipientName?,sendMode:'loop_approved|manual_approval'}. weather={city?,date?}.",
    "missingFields, allowedActions, requiredApprovalActions, successCriteria must be string arrays.",
    "Omit unknown optional fields. Never return null.",
    "Infer Chinese/English time into cron when recurring. Examples: every day 9am => 0 9 * * *; 15:45 => 45 15 * * *.",
    "Use schedule.type='interval' for every-N-minutes/hour requests, e.g. 每5分钟 => intervalMinutes=5.",
    "If WeChat/file transfer/send/push/notify is explicit and recipient is explicit, use delivery.platform='wechat_desktop'; otherwise add missingFields.",
    `timezone=${input.timezone}`,
    `externalWriteMode=${input.externalWriteMode}`,
    `request=${input.intent}`,
  ].join("\n");
}

async function callLocalModelForLoopDraft(
  input: Required<NaturalLanguageLoopInput>,
): Promise<{ draft: LocalModelLoopDraft; model: string }> {
  const startedAt = Date.now();
  const config = await resolveLocalModelProviderConfig(input.userId);
  const configLoadedAt = Date.now();
  const jsonMode = process.env.LOOP_NL_LLM_JSON_MODE !== "0";
  const timeoutMs = parsePositiveIntEnv("LOOP_NL_LLM_TIMEOUT_MS", 20_000);
  const requestBody = {
    model: config.model,
    temperature: 0,
    max_tokens: parsePositiveIntEnv("LOOP_NL_LLM_MAX_TOKENS", 900),
    stream: false,
    messages: [
      {
        role: "system",
        content: "You are a precise automation parser. Output valid JSON only.",
      },
      {
        role: "user",
        content: buildCompactParserPrompt(input),
      },
    ],
  };
  let retriedWithoutJsonMode = false;
  let response = await fetch(buildChatCompletionsUrl(config.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      jsonMode
        ? {
            ...requestBody,
            response_format: { type: "json_object" },
          }
        : requestBody,
    ),
    signal: AbortSignal.timeout(timeoutMs),
  });

  let payload = await response.json().catch(() => null);
  if (jsonMode && !response.ok && response.status === 400) {
    retriedWithoutJsonMode = true;
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
  const fetchedAt = Date.now();

  if (!response.ok) {
    const error = payload as { error?: { message?: unknown } } | null;
    const message =
      typeof error?.error?.message === "string"
        ? error.error.message
        : `Local LLM API returned HTTP ${response.status}`;
    throw new Error(message);
  }

  const choices = (payload as {
    choices?: Array<{ message?: { content?: unknown } }>;
  } | null)?.choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Local LLM API returned an empty draft.");
  }
  const draft = localModelLoopDraftSchema.parse(extractJsonObject(content));
  console.log(
    `[LoopsNaturalLanguage] llm model=${config.model} configMs=${configLoadedAt - startedAt} fetchMs=${fetchedAt - configLoadedAt} parseMs=${Date.now() - fetchedAt} retriedWithoutJsonMode=${retriedWithoutJsonMode}`,
  );

  return {
    draft,
    model: config.model,
  };
}

function buildTrigger(input: {
  schedule: LocalModelLoopDraft["schedule"];
  timezone: string;
  tradingDayOnly?: boolean;
}) {
  const schedule = input.schedule;
  if (schedule.type === "cron") {
    return {
      type: "cron" as const,
      expression: schedule.cronExpression || "0 9 * * *",
      timezone: schedule.timezone || input.timezone,
      ...(input.tradingDayOnly
        ? { tradingCalendar: "a-share" as const, tradingDayOnly: true }
        : {}),
    };
  }
  if (schedule.type === "interval") {
    return {
      type: "interval" as const,
      minutes: schedule.intervalMinutes || 60,
    };
  }
  if (schedule.type === "once") {
    return {
      type: "once" as const,
      at: schedule.onceAt || new Date().toISOString(),
    };
  }
  return { type: "manual" as const };
}

function buildLoopSpecFromModelDraft(input: {
  intent: string;
  timezone: string;
  externalWriteMode: "manual_approval" | "loop_approved";
  modelDraft: LocalModelLoopDraft;
  parser: LoopDraftParser;
}): LoopSpec {
  const delivery = input.modelDraft.delivery;
  const weather = input.modelDraft.weather;
  const deliveryIsWechat = delivery?.platform === "wechat_desktop";
  const sendMode = delivery?.sendMode ?? input.externalWriteMode;
  const allowed = new Set([
    "searchUnifiedMemory",
    "chatInsight",
    ...input.modelDraft.allowedActions,
  ]);

  if (weather?.city) {
    allowed.add("getWeather");
  }
  if (deliveryIsWechat) {
    allowed.add("wechatDesktopPreviewMessage");
  }
  if (deliveryIsWechat && sendMode === "loop_approved") {
    allowed.add("wechatDesktopSendMessage");
  }

  const requiresApproval =
    sendMode === "loop_approved"
      ? []
      : [
          ...input.modelDraft.requiredApprovalActions,
          ...(deliveryIsWechat ? ["wechatDesktopSendMessage"] : []),
        ];
  const requiredSources =
    deliveryIsWechat && sendMode === "loop_approved"
      ? ["wechatDesktopSendMessage"]
      : [];

  return parseLoopSpec({
    version: 1,
    templateId: "natural-language",
    goal: input.modelDraft.goal || input.intent,
    trigger: buildTrigger({
      schedule: input.modelDraft.schedule,
      timezone: input.timezone,
      tradingDayOnly: hasTradingDayScheduleIntent(input.intent),
    }),
    context: {
      sources: [],
      instructions: [
        input.modelDraft.contextInstructions,
        weather?.city
          ? `Fetch weather forecast for ${weather.city}.`
          : undefined,
        delivery?.recipientName && deliveryIsWechat
          ? `Deliver the message to desktop WeChat recipient "${delivery.recipientName}".`
          : deliveryIsWechat
            ? "Ask for the WeChat recipient before delivering."
            : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    },
    actions: {
      allowed: [...allowed],
      requiresApproval,
      denied: [],
    },
    verification: {
      type: "structured_check",
      successCriteria: [
        ...input.modelDraft.successCriteria,
        ...(deliveryIsWechat && sendMode === "loop_approved"
          ? [
              `Desktop WeChat message is sent to ${delivery?.recipientName ?? "the requested recipient"}`,
            ]
          : []),
        "The task result is recorded",
      ],
      requiredFields: ["summary", "suggestedActions"],
      requiredSources,
    },
    retry: {
      maxAttempts: 2,
      onFailure: "summarize_and_block",
    },
    approval: {
      defaultMode: "require_approval",
      externalWrites:
        sendMode === "loop_approved" ? "allow" : "require_approval",
    },
    escalation: {
      onBlocked: "notify_user",
      onNeedsApproval: "notify_user",
    },
    metadata: {
      createdFrom: "natural_language",
      harness: "loop-run-harness",
      agents: {
        planner: "natural-language-planner",
        executor: "native-loop-executor",
        verifier: "loop-verifier",
        toolGate: "loop-tool-gate",
      },
      naturalLanguageIntent: input.intent,
      parser: input.parser,
      taskKind: input.modelDraft.taskKind,
      weather: {
        city: weather?.city,
        date: weather?.date ?? "today",
      },
      delivery: {
        platform: delivery?.platform,
        recipientName: delivery?.recipientName,
        sendMode,
      },
    },
  });
}

export async function draftLoopFromNaturalLanguage(
  rawInput: NaturalLanguageLoopInput,
): Promise<NaturalLanguageLoopDraft> {
  const input = naturalLanguageLoopInputSchema.parse(rawInput);
  const normalizedInput = {
    userId: input.userId,
    workshopId: input.workshopId ?? null,
    intent: input.intent.trim(),
    timezone: defaultTimezone(input.timezone),
    externalWriteMode: input.externalWriteMode ?? "loop_approved",
  };
  const startedAt = Date.now();
  const preferRuleDraft = shouldPreferRuleDraft(normalizedInput.intent);
  const ruleDraft =
    isRuleParserEnabled() || preferRuleDraft
      ? tryBuildRuleBasedLoopDraft(normalizedInput)
      : null;
  const plannerResult = ruleDraft
    ? { draft: ruleDraft, model: "local-rules", parser: "local_rules" as const }
    : {
        ...(await callLocalModelForLoopDraft(normalizedInput)),
        parser: "local_llm_api" as const,
      };
  console.log(
    `[LoopsNaturalLanguage] draft parser=${plannerResult.parser} model=${plannerResult.model} elapsedMs=${Date.now() - startedAt}`,
  );
  const modelDraft = plannerResult.draft;
  const delivery = modelDraft.delivery;
  const weather = modelDraft.weather;
  const spec = buildLoopSpecFromModelDraft({
    intent: normalizedInput.intent,
    timezone: normalizedInput.timezone,
    externalWriteMode: normalizedInput.externalWriteMode,
    modelDraft,
    parser: plannerResult.parser,
  });
  const description = [
    modelDraft.schedule.label,
    delivery?.recipientName ? `发送到 ${delivery.recipientName}` : null,
    weather?.city ? `${weather.city}天气预报` : null,
    modelDraft.description,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    name: modelDraft.name,
    description,
    spec,
    planner: {
      agent: "natural-language-planner",
      model: plannerResult.model,
      parser: plannerResult.parser,
    },
    extracted: {
      scheduleLabel:
        modelDraft.schedule.label ??
        modelDraft.schedule.cronExpression ??
        modelDraft.schedule.type,
      timezone: modelDraft.schedule.timezone ?? normalizedInput.timezone,
      recipientName: delivery?.recipientName,
      city: weather?.city,
      deliveryPlatform:
        delivery?.platform === "wechat_desktop" ? "wechat_desktop" : undefined,
      externalWriteMode: normalizedInput.externalWriteMode,
      missingFields: modelDraft.missingFields,
    },
  };
}

export async function createLoopFromNaturalLanguage(
  input: NaturalLanguageLoopInput,
): Promise<{ loop: Loop; draft: NaturalLanguageLoopDraft }> {
  const draft = await draftLoopFromNaturalLanguage(input);
  if (draft.extracted.missingFields.length > 0) {
    throw new Error(
      `Missing required loop fields: ${draft.extracted.missingFields.join(", ")}`,
    );
  }

  const loop = await createLoop(
    loopSpecToCreateLoopInput({
      userId: input.userId,
      workshopId: input.workshopId ?? null,
      name: draft.name,
      description: draft.description,
      spec: draft.spec,
    }),
  );

  return { loop, draft };
}
