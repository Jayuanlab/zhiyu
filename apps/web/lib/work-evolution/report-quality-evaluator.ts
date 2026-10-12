import { z } from "zod";
import { randomUUID } from "node:crypto";
import type {DrizzleDB} from '@/lib/db/types';
import {resolveExecutionLease} from '@/lib/work-runtime/execution-context';
import {ExecutionLeaseError} from '@/lib/work-runtime/execution-errors';
import {applyLoopExecutionStep,readLoopExecutionStep} from '@/lib/work-runtime/loop-execution';
import { jsonrepair } from "jsonrepair";
import type { JobExecutionResult } from "@/lib/cron/types";
import type { Loop, Workshop, WorkshopEvent } from "@/lib/db/schema";
import { getUserLlmProviderConfig } from "@/lib/ai/user-llm-api-settings";
import { getLoopInWorkshop } from "@/lib/loops/service";
import type { WorkshopJson } from "@/lib/workshops/types";
import {
  appendWorkshopEvent,
  getWorkshop,
  listWorkshopEvents,
} from "@/lib/workshops/service";
import { upsertWorkshopReviewItemFromProposalEvent } from "@/lib/workshops/review-items";

const MAX_REPORT_CHARS = 12_000;
const MAX_EVENT_BODY_CHARS = 800;
const MAX_RUN_EVENTS = 120;
const DEFAULT_PASSING_SCORE = 80;

type ReportQualityProblem = {
  type:
    | "missing_final_markdown"
    | "report_too_short"
    | "missing_required_section"
    | "missing_tool_reasoning"
    | "tool_error_noise"
    | "verification_gap"
    | "boundary_language_risk"
    | "formatting_gap";
  severity: "low" | "medium" | "high";
  evidence: string;
  yamlTarget: string;
  suggestedChange: string;
};

export type ReportQualityReview = {
  score: number;
  passed: boolean;
  summary: string;
  problems: ReportQualityProblem[];
  strengths: string[];
  proposedYamlPatch: WorkshopJson | null;
  riskLevel: "low" | "medium" | "high";
  needsOwnerReview: boolean;
  evaluatorMode: "llm" | "rule_based";
  model: string | null;
  error: string | null;
};

type StructuredReportLike = {
  summary?: unknown;
  finalMarkdownReport?: unknown;
  outcome?: unknown;
  reasoningChain?: unknown;
  suggestedActions?: unknown;
  requiredFieldsMissing?: unknown;
};

type EvaluatorProviderType = "openai_compatible" | "anthropic_compatible";

type EvaluatorModelConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  providerType: EvaluatorProviderType;
};

const reportQualityProblemTypeSchema = z.preprocess(
  (value) =>
    typeof value === "string" &&
    [
      "missing_final_markdown",
      "report_too_short",
      "missing_required_section",
      "missing_tool_reasoning",
      "tool_error_noise",
      "verification_gap",
      "boundary_language_risk",
      "formatting_gap",
    ].includes(value)
      ? value
      : "formatting_gap",
  z.enum([
    "missing_final_markdown",
    "report_too_short",
    "missing_required_section",
    "missing_tool_reasoning",
    "tool_error_noise",
    "verification_gap",
    "boundary_language_risk",
    "formatting_gap",
  ]),
);

const llmReviewSchema = z.object({
  score: z.coerce.number().min(0).max(100),
  passed: z.boolean().optional(),
  summary: z.string().min(1),
  problems: z
    .array(
      z.object({
        type: reportQualityProblemTypeSchema.default("formatting_gap"),
        severity: z.enum(["low", "medium", "high"]).default("medium"),
        evidence: z.string().min(1),
        yamlTarget: z.string().min(1),
        suggestedChange: z.string().min(1),
      }),
    )
    .default([]),
  strengths: z.array(z.string()).default([]),
  proposedYamlPatch: z.record(z.string(), z.unknown()).nullable().default(null),
  riskLevel: z.enum(["low", "medium", "high"]).default("low"),
  needsOwnerReview: z.boolean().default(true),
});

function enabled() {
  const value = process.env.REPORT_QUALITY_EVALUATOR_ENABLED?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

function optionalEnv(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function positiveIntEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function buildAnthropicMessagesUrl(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/v1/messages")) return normalized;
  if (normalized.endsWith("/v1")) return `${normalized}/messages`;
  return `${normalized}/v1/messages`;
}

function buildOpenAiChatCompletionsUrl(baseUrl: string) {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/v1/chat/completions")) return normalized;
  if (normalized.endsWith("/chat/completions")) return normalized;
  if (normalized.endsWith("/v1")) return `${normalized}/chat/completions`;
  if (normalized.endsWith("/compatible-mode")) return `${normalized}/v1/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

function isOpenCodeGoBaseUrl(baseUrl: string) {
  return /opencode\.ai\/zen\/go(?:\/|$)/i.test(baseUrl);
}

function openCodeGoSessionHeader(baseUrl: string): Record<string, string> {
  if (!isOpenCodeGoBaseUrl(baseUrl)) return {};
  return {
    "x-opencode-session": `zhiyu-report-quality-${randomUUID()}`,
  };
}

export function buildReportQualityOpenAiCompatibleHeaders(config: {
  apiKey: string;
  baseUrl: string;
}): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
    ...openCodeGoSessionHeader(config.baseUrl),
  };
}

function normalizeEvaluatorProviderType(
  value: string | null | undefined,
): EvaluatorProviderType | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "openai_compatible" ||
    normalized === "anthropic_compatible"
    ? normalized
    : null;
}

async function resolveEvaluatorModelConfig(
  userId: string,
): Promise<EvaluatorModelConfig | undefined> {
  const envProviderType = normalizeEvaluatorProviderType(
    optionalEnv("REPORT_QUALITY_EVALUATOR_LLM_PROVIDER"),
  );
  const envConfig = {
    apiKey:
      optionalEnv("REPORT_QUALITY_EVALUATOR_LLM_API_KEY") ??
      optionalEnv("OPENCODE_API_KEY") ??
      optionalEnv("WORKSHOP_PLANNER_LLM_API_KEY") ??
      optionalEnv("LLM_API_KEY"),
    baseUrl:
      optionalEnv("REPORT_QUALITY_EVALUATOR_LLM_BASE_URL") ??
      optionalEnv("OPENCODE_BASE_URL") ??
      optionalEnv("WORKSHOP_PLANNER_LLM_BASE_URL") ??
      optionalEnv("LLM_BASE_URL"),
    model:
      optionalEnv("REPORT_QUALITY_EVALUATOR_LLM_MODEL") ??
      optionalEnv("OPENCODE_MODEL") ??
      optionalEnv("WORKSHOP_PLANNER_LLM_MODEL") ??
      optionalEnv("LLM_MODEL"),
  };
  if (envConfig.apiKey && envConfig.baseUrl && envConfig.model) {
    return {
      apiKey: envConfig.apiKey,
      baseUrl: envConfig.baseUrl,
      model: envConfig.model,
      providerType: envProviderType ?? "openai_compatible",
    };
  }

  const userOpenAiConfig = await getUserLlmProviderConfig({
    userId,
    providerType: "openai_compatible",
  });
  if (userOpenAiConfig) {
    return { ...userOpenAiConfig, providerType: "openai_compatible" };
  }

  const anthropicEnvConfig = {
    apiKey:
      optionalEnv("REPORT_QUALITY_EVALUATOR_ANTHROPIC_API_KEY") ??
      optionalEnv("ANTHROPIC_API_KEY") ??
      optionalEnv("ANTHROPIC_AUTH_TOKEN"),
    baseUrl:
      optionalEnv("REPORT_QUALITY_EVALUATOR_ANTHROPIC_BASE_URL") ??
      optionalEnv("ANTHROPIC_BASE_URL"),
    model:
      optionalEnv("REPORT_QUALITY_EVALUATOR_ANTHROPIC_MODEL") ??
      optionalEnv("ANTHROPIC_MODEL"),
  };
  if (
    anthropicEnvConfig.apiKey &&
    anthropicEnvConfig.baseUrl &&
    anthropicEnvConfig.model
  ) {
    if (isOpenCodeGoBaseUrl(anthropicEnvConfig.baseUrl)) {
      return {
        apiKey: anthropicEnvConfig.apiKey,
        baseUrl: anthropicEnvConfig.baseUrl,
        model: anthropicEnvConfig.model,
        providerType: "openai_compatible",
      };
    }
    return {
      apiKey: anthropicEnvConfig.apiKey,
      baseUrl: anthropicEnvConfig.baseUrl,
      model: anthropicEnvConfig.model,
      providerType: "anthropic_compatible",
    };
  }

  const userAnthropicConfig = await getUserLlmProviderConfig({
    userId,
    providerType: "anthropic_compatible",
  });
  if (userAnthropicConfig) {
    return { ...userAnthropicConfig, providerType: "anthropic_compatible" };
  }

  return undefined;
}

function truncate(value: unknown, max: number) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function reportTextForEvaluator(report: string, freeformProjectValue: boolean) {
  if (!freeformProjectValue || report.length <= MAX_REPORT_CHARS) {
    return truncate(report, MAX_REPORT_CHARS);
  }
  const notice = `以下仅为报告头尾摘录（原文 ${report.length} 字符），中间内容未送审。不能声称完整报告已全面审阅，不得将摘录中看不到的内容认定为全篇缺失。\n[报告开头]\n`;
  const separator = "\n[中间内容省略；以下为报告结尾]\n";
  const available = MAX_REPORT_CHARS - notice.length - separator.length;
  const headChars = Math.floor(available / 2);
  return `${notice}${report.slice(0, headChars)}${separator}${report.slice(-(available - headChars))}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function structuredReport(result: JobExecutionResult): StructuredReportLike {
  const root = asRecord(result.result);
  return asRecord(root.structuredReport) as StructuredReportLike;
}

function finalReportText(result: JobExecutionResult) {
  const report = structuredReport(result);
  return (
    (typeof report.finalMarkdownReport === "string" &&
      report.finalMarkdownReport.trim()) ||
    (typeof result.output === "string" && result.output.trim()) ||
    ""
  );
}

function eventFact(event: WorkshopEvent) {
  return {
    id: event.id,
    seq: event.seq,
    type: event.type,
    title: event.title,
    body: truncate(event.body ?? "", MAX_EVENT_BODY_CHARS),
    metadata: {
      toolName: asRecord(event.metadata).toolName ?? null,
      traceStatus: asRecord(event.metadata).traceStatus ?? null,
      traceTitle: asRecord(event.metadata).traceTitle ?? null,
      decision: asRecord(event.metadata).decision ?? null,
    },
    createdAt:
      event.createdAt instanceof Date
        ? event.createdAt.toISOString()
        : String(event.createdAt),
  };
}

function runEventsForReview(events: WorkshopEvent[], loopRunId: string | null) {
  const selected = loopRunId
    ? events.filter((event) => event.loopRunId === loopRunId)
    : events;
  return selected
    .sort((left, right) => left.seq - right.seq)
    .slice(-MAX_RUN_EVENTS);
}

function markdownSectionCount(markdown: string) {
  return (markdown.match(/^#{1,3}\s+\S+/gm) ?? []).length;
}

function containsToolReasoning(markdown: string) {
  return /为什么|原因|依据|证据|调用|工具|数据源|reason|because|evidence/i.test(
    markdown,
  );
}

function containsBoundaryRisk(markdown: string, freeformProjectValue: boolean) {
  const riskWords = /立即下单|马上买入|马上卖出|全仓买入|全仓卖出|真实下单|帮我买|帮我卖/;
  if (!freeformProjectValue) return riskWords.test(markdown);

  return markdown.split(/[\n。！？!?]/).some((sentence) => {
    if (!riskWords.test(sentence)) return false;
    // A quoted risk term in a rule explanation is observation, not advice.
    // Recommendations retain precedence even when the action is quoted.
    if (/建议|推荐|应该|应当|必须|务必|(?:请|要求)(?:主人|用户|你|您)|(?:主人|用户|你|您)[,，：:\s]*(?:现在|立即|马上|立刻|可以)|(?:请|执行|照做|操作)[^。！？\n]{0,12}(?:立即下单|马上买入|马上卖出|全仓买入|全仓卖出|真实下单|帮我买|帮我卖)/.test(sentence)) {
      return true;
    }
    const describesRule = /规则|源码|正则|检测器|边界语言|风险词|禁止词/.test(sentence) &&
      /检测|检查|包含|匹配|拦截|识别|过滤|禁止/.test(sentence);
    if (!describesRule) return true;
    const unquotedText = sentence.replace(
      /["“'‘`]\s*(?:立即下单|马上买入|马上卖出|全仓买入|全仓卖出|真实下单|帮我买|帮我卖)\s*["”'’`]/g,
      "",
    );
    return riskWords.test(unquotedText);
  });
}

function usesFreeformProjectValueReport(workshop: Pick<Workshop, "modelConfig">) {
  const config = asRecord(workshop.modelConfig);
  return config.role === "agent_frontier_researcher" &&
    config.researchReportStyle === "freeform_project_value";
}

function ruleBasedReview(input: {
  loop: Loop;
  result: JobExecutionResult;
  events: WorkshopEvent[];
  freeformProjectValue: boolean;
}): ReportQualityReview {
  const report = finalReportText(input.result);
  const parsed = structuredReport(input.result);
  const requiredFields = asStringArray(asRecord(input.loop.verificationConfig).requiredFields);
  const missingRequired = [
    ...asStringArray(parsed.requiredFieldsMissing),
    ...(input.freeformProjectValue ? [] : requiredFields.filter((field) => {
      const normalized = field.toLowerCase();
      return !report.toLowerCase().includes(normalized) && !(field in parsed);
    })),
  ];
  const toolErrors = input.events.filter((event) => event.type === "tool_error");
  const denied = input.events.filter(
    (event) =>
      event.type === "permission_decision" &&
      asRecord(event.metadata).decision === "deny",
  );
  const problems: ReportQualityProblem[] = [];

  if (!report.trim() || (!input.freeformProjectValue && !/^#\s+/m.test(report))) {
    problems.push({
      type: "missing_final_markdown",
      severity: "high",
      evidence: input.freeformProjectValue
        ? "The final report is empty."
        : "The final output does not contain a complete Markdown report with a top heading.",
      yamlTarget: "loop.outputContract.finalMarkdownReport",
      suggestedChange: input.freeformProjectValue
        ? "Require a substantive report that assesses an article's value for the current project with evidence."
        : "Require the last assistant output to be a complete Markdown report headed by the loop result title.",
    });
  }
  if (!input.freeformProjectValue && report.trim().length > 0 && report.trim().length < 600) {
    problems.push({
      type: "report_too_short",
      severity: "medium",
      evidence: `Final report is only ${report.trim().length} characters.`,
      yamlTarget: "loop.outputContract.minimumReportDetail",
      suggestedChange:
        "Require conclusion, evidence, unavailable data, decision reasoning, and next observation sections.",
    });
  }
  if (!input.freeformProjectValue && report && markdownSectionCount(report) < 3) {
    problems.push({
      type: "formatting_gap",
      severity: "medium",
      evidence: "Final report has fewer than three Markdown sections.",
      yamlTarget: "loop.outputContract.requiredSections",
      suggestedChange:
        "Add a required Markdown section list for conclusion, evidence, reasoning, blockers, and next step.",
    });
  }
  if (!input.freeformProjectValue && report && !containsToolReasoning(report)) {
    problems.push({
      type: "missing_tool_reasoning",
      severity: "high",
      evidence:
        "The report does not explain why key tools or data sources were used before the conclusion.",
      yamlTarget: "loop.outputContract.reasoningTrace",
      suggestedChange:
        "Require a user-readable reasoning trace that maps each important tool call to the question it answered.",
    });
  }
  if (toolErrors.length > 0 && input.result.status === "success") {
    problems.push({
      type: "tool_error_noise",
      severity: "medium",
      evidence: `${toolErrors.length} tool error event(s) occurred during a successful run.`,
      yamlTarget: "loop.toolUsePolicy.recovery",
      suggestedChange:
        "Require recovered tool errors to be summarized as recovered noise and avoid leaving owner review items.",
    });
  }
  if (denied.length > 0) {
    problems.push({
      type: "verification_gap",
      severity: "medium",
      evidence: `${denied.length} denied tool decision(s) occurred.`,
      yamlTarget: "loop.toolUsePolicy.deniedFallback",
      suggestedChange:
        "Tell the agent how to proceed when a denied tool is unavailable instead of trying fallback commands.",
    });
  }
  if (missingRequired.length > 0) {
    problems.push({
      type: "missing_required_section",
      severity: "high",
      evidence: `Missing required fields or sections: ${Array.from(new Set(missingRequired)).join(", ")}.`,
      yamlTarget: "loop.verification.requiredFields",
      suggestedChange:
        "Align requiredFields with explicit output sections and verify them in the final Markdown report.",
    });
  }
  if (containsBoundaryRisk(report, input.freeformProjectValue)) {
    problems.push({
      type: "boundary_language_risk",
      severity: "high",
      evidence: "The report contains wording that may be interpreted as real trading instruction.",
      yamlTarget: "loop.boundaryPolicy.outputLanguage",
      suggestedChange:
        "Forbid real-trading imperative wording in reports unless the loop explicitly has real-broker permission.",
    });
  }

  const penalty = problems.reduce((total, problem) => {
    if (problem.severity === "high") return total + 22;
    if (problem.severity === "medium") return total + 12;
    return total + 5;
  }, 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  return {
    score,
    passed: score >= DEFAULT_PASSING_SCORE && problems.length === 0,
    summary:
      problems.length === 0
        ? "Report quality passed the deterministic checks."
        : `Found ${problems.length} report quality issue(s).`,
    problems,
    strengths: report
      ? ["A final output was produced.", `Report length: ${report.length} characters.`]
      : [],
    proposedYamlPatch:
      problems.length === 0
        ? null
        : {
            loops: {
              [input.loop.id]: {
                outputContract: {
                  ...(input.freeformProjectValue
                    ? {
                        finalOutput: "freeform_project_value_report",
                        reviewCriteria: [
                          "article_claims_and_primary_evidence",
                          "current_project_evidence_and_incremental_value",
                          "applicability_conditions_and_counterexamples",
                          "falsifiable_validation_and_source_limitations",
                        ],
                      }
                    : {
                        finalOutput: "complete_markdown_report",
                        requiredSections: [
                          "current_conclusion",
                          "key_evidence",
                          "decision_reasoning_trace",
                          "data_gaps_or_recovered_errors",
                          "next_observation",
                        ],
                      }),
                },
              },
            },
          },
    riskLevel: "low",
    needsOwnerReview: problems.length > 0,
    evaluatorMode: "rule_based",
    model: null,
    error: null,
  };
}

function extractJsonObject(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  const jsonText = start >= 0 && end >= start ? candidate.slice(start, end + 1) : candidate;
  return JSON.parse(jsonrepair(jsonText));
}

export function parseReportQualityLlmReview(text: string) {
  return llmReviewSchema.parse(extractJsonObject(text));
}

function buildPrompt(input: {
  workshopName: string;
  loop: Loop;
  ruleReview: ReportQualityReview;
  finalReport: string;
  events: WorkshopEvent[];
  freeformProjectValue: boolean;
}) {
  return [
    "你是 ReportQualityEvaluator，一个平台内置的质量评审子 agent。",
    input.freeformProjectValue
      ? "你评审文章核心主张对知遇项目的实际价值、项目证据、适用条件和验证深度；不要求工具流水账或固定写作模板。"
      : "你只评审智能体最终报告质量、工具调用解释、证据完整性、边界表达，以及它们对应的 YAML 配置改进。",
    "你不能提出股票买卖建议，不能改变业务结论，不能要求扩大真实外部动作权限。",
    "你的输出必须是 JSON，不要 Markdown、不要代码块。",
    "",
    "评分维度：",
    ...(input.freeformProjectValue
      ? [
          "本车间按自由形式评估文章对知遇项目的价值。不得因字数、章节数量、标题格式或正文未出现内部字段名而扣分。以下是研究深度的评判依据，不是必填章节或报告模板：",
          "- 文章论点：是否准确理解作者的具体主张、适用范围与一手证据，而非转载摘要或术语堆积。",
          "- 项目证据：是否读取当前相关源码、追查调用或依赖，并将文章论点对应到知遇实际机制；未核验的内容明确限定。",
          "- 有效增量：是否说明现有项目已经具备什么、文章新增什么，以及现在是否值得采用；同义改名或泛化建议不算增量。",
          "- 成立条件与反例：是否分析方案所需条件、成本与失败方式，区分已证实事实、推断和待验证假设。",
          "- 可证伪验证：是否给出针对核心价值判断的最小验证、可观察的通过与失败信号，并诚实区分建议验证与实际执行。",
          "- 来源限制：是否保留缺失、过期、抓取降级、证据冲突与研究覆盖不足，不将未找到等同于不存在。",
        ]
      : ["- 完整性：最终报告是否是完整 Markdown。"]),
    "- 可读性：主人是否一眼知道结论。",
    input.freeformProjectValue
      ? "- 因果性：文章主张如何与项目当前机制关联，为什么所述增量在适用条件下可能成立。"
      : "- 因果性：报告是否解释为什么读取这些数据/工具。",
    "- 证据性：结论是否能对应到观察和数据源。",
    "- 边界性：是否有越权或真实交易指令风险。",
    input.freeformProjectValue
      ? "- 项目价值与可检验性：建议是否服务项目真实目标、依据是否足以支持判断、是否可用有限验证检验；确认项目已经足够或文章不适用也可有价值，不必产出 YAML 改动。只有存在具体配置缺陷时才提出可审阅配置建议；没有配置问题时 proposedYamlPatch 可为 null 或 {}，不得为满足字段虚构改动。"
      : "- 配置可改性：问题是否能落到 Workshop/Loop YAML 的 outputContract、verification、toolUsePolicy、memoryPolicy 或 contextPolicy。",
    "",
    "返回 JSON shape:",
    JSON.stringify({
      score: 0,
      passed: false,
      summary: "简短中文总结",
      problems: [
        {
          type: input.freeformProjectValue ? "verification_gap" : "missing_tool_reasoning",
          severity: "high",
          evidence: input.freeformProjectValue ? "文章主张尚未对应当前项目源码，增量判断缺少依据。" : "证据",
          yamlTarget: input.freeformProjectValue
            ? "not_applicable"
            : "loops.<loopId>.outputContract.reasoningTrace",
          suggestedChange: input.freeformProjectValue
            ? "说明有限验证、成立条件或不采用依据；只有真实配置缺陷才建议配置改动。"
            : "建议如何改 YAML",
        },
      ],
      strengths: ["做得好的地方"],
      proposedYamlPatch: input.freeformProjectValue ? null : {
        loops: {
          "<loopId>": {
            outputContract: {
              requiredSections: ["当前结论", "关键证据", "决策路径"],
            },
          },
        },
      },
      riskLevel: "low",
      needsOwnerReview: true,
    }),
    "",
    "目标 Work:",
    input.workshopName,
    "",
    "Loop YAML-like config:",
    JSON.stringify({
      id: input.loop.id,
      name: input.loop.name,
      goal: input.loop.goal,
      triggerConfig: input.loop.triggerConfig,
      contextConfig: input.loop.contextConfig,
      actionPolicy: input.loop.actionPolicy,
      verificationConfig: input.loop.verificationConfig,
      approvalPolicy: input.loop.approvalPolicy,
    }),
    "",
    "Rule-based review:",
    JSON.stringify(input.ruleReview),
    "",
    "Run events:",
    JSON.stringify(input.events.map(eventFact)),
    "",
    input.freeformProjectValue ? "Project value report:" : "Final Markdown report:",
    reportTextForEvaluator(input.finalReport, input.freeformProjectValue),
  ].join("\n");
}

async function callEvaluatorLlm(input: {
  userId: string;
  workshopName: string;
  loop: Loop;
  ruleReview: ReportQualityReview;
  finalReport: string;
  events: WorkshopEvent[];
  freeformProjectValue: boolean;
}): Promise<ReportQualityReview | null> {
  const config = await resolveEvaluatorModelConfig(input.userId);
  if (!config) return null;

  const prompt = buildPrompt(input);
  const timeout = AbortSignal.timeout(
    positiveIntEnv("REPORT_QUALITY_EVALUATOR_TIMEOUT_MS", 45_000),
  );
  const maxTokens = positiveIntEnv("REPORT_QUALITY_EVALUATOR_MAX_TOKENS", 1800);
  const system =
    "You are a report quality evaluator. Return valid JSON only. Never provide trading advice.";

  const response =
    config.providerType === "anthropic_compatible"
      ? await fetch(buildAnthropicMessagesUrl(config.baseUrl), {
          method: "POST",
          headers: {
            "x-api-key": config.apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: config.model,
            system,
            max_tokens: maxTokens,
            temperature: 0,
            messages: [
              {
                role: "user",
                content: prompt,
              },
            ],
          }),
          signal: timeout,
        })
      : await fetch(buildOpenAiChatCompletionsUrl(config.baseUrl), {
          method: "POST",
          headers: buildReportQualityOpenAiCompatibleHeaders(config),
          body: JSON.stringify({
            model: config.model,
            temperature: 0,
            max_tokens: maxTokens,
            messages: [
              {
                role: "system",
                content: system,
              },
              {
                role: "user",
                content: prompt,
              },
            ],
          }),
          signal: timeout,
        });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = asRecord(asRecord(payload).error).message;
    throw new Error(
      typeof message === "string"
        ? message
        : `Report quality evaluator returned HTTP ${response.status}`,
    );
  }

  const text =
    config.providerType === "anthropic_compatible"
      ? (
          payload as {
            content?: Array<{ type?: string; text?: unknown }>;
          } | null
        )?.content
          ?.map((part) =>
            part.type === "text" && typeof part.text === "string"
              ? part.text
              : "",
          )
          .join("")
          .trim()
      : (
          payload as {
            choices?: Array<{ message?: { content?: unknown } }>;
          } | null
        )?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new Error("Report quality evaluator returned empty text.");
  }
  if (!text) throw new Error("Report quality evaluator returned empty text.");

  const parsed = parseReportQualityLlmReview(text);
  return {
    score: Math.round(parsed.score),
    passed: parsed.passed ?? parsed.score >= DEFAULT_PASSING_SCORE,
    summary: parsed.summary,
    problems: parsed.problems,
    strengths: parsed.strengths,
    proposedYamlPatch: parsed.proposedYamlPatch,
    riskLevel: parsed.riskLevel,
    needsOwnerReview: parsed.needsOwnerReview,
    evaluatorMode: "llm",
    model: config.model,
    error: null,
  };
}

async function appendReviewEvent(input: {
  workshopId: string;
  loopId: string;
  loopRunId: string | null;
  completionEventId: string | null;
  review: ReportQualityReview;
  reportSampling?: { mode: "head_tail"; originalChars: number; maxInputChars: number };
}) {
  const rulesOnly = input.review.evaluatorMode === "rule_based";
  const event = await appendWorkshopEvent({
    workshopId: input.workshopId,
    loopId: input.loopId,
    loopRunId: input.loopRunId,
    type: "report_quality_review",
    title: rulesOnly
      ? `报告评审降级：仅规则检查（${input.review.score}/100）`
      : `报告质量评审：${input.review.score}/100`,
    body: [
      ...(input.reportSampling
        ? ["模型评审预算有限，输入采用报告头尾摘录；中间内容未送审，不能代表全篇已核验。"]
        : []),
      ...(rulesOnly
        ? [
            "模型评审未完成，已降级为规则检查。",
            `降级原因：${input.review.error ?? "未配置可用的模型评审器。"}`,
            `规则检查${input.review.passed ? "通过" : "未通过"}：${input.review.score}/100。该分数仅反映确定性规则，不能证明报告结论或研究证据正确。`,
          ]
        : []),
      input.review.summary,
      input.review.problems.length > 0
        ? `问题：${input.review.problems
            .map((problem) => `${problem.severity}:${problem.type}`)
            .join("；")}`
        : rulesOnly
          ? "规则检查未发现问题；来源覆盖、事实正确性与业务价值尚未完成模型评审。"
          : "未发现需要配置改进的问题。",
    ].join("\n"),
    metadata: {
      kind: "report_quality_review",
      status: rulesOnly
        ? "degraded"
        : input.review.passed ? "passed" : "needs_improvement",
      completionEventId: input.completionEventId,
      ...input.review,
      degraded: rulesOnly,
      semanticReviewStatus: rulesOnly ? "not_completed" : "completed",
      ruleBasedScore: rulesOnly ? input.review.score : null,
      ruleBasedPassed: rulesOnly ? input.review.passed : null,
      ...(input.reportSampling ? {
        reviewScope: "report_head_tail_excerpt",
        reportSampling: input.reportSampling,
      } : {}),
    },
  });
  return event;
}

async function appendImprovementProposalEvent(input: {
  workshopId: string;
  loopId: string;
  loopRunId: string | null;
  reviewEventId: string;
  review: ReportQualityReview;
},store?:DrizzleDB) {
  if (input.review.passed || !input.review.needsOwnerReview) return null;
  if (!input.review.proposedYamlPatch) return null;

  const event=await appendWorkshopEvent({
    workshopId: input.workshopId,
    loopId: input.loopId,
    loopRunId: input.loopRunId,
    type: "report_quality_config_proposed",
    title: "报告质量配置改进提案",
    body: [
      input.review.summary,
      "",
      "Proposed YAML patch:",
      JSON.stringify(input.review.proposedYamlPatch, null, 2),
    ].join("\n"),
    metadata: {
      kind: "report_quality_config_proposal",
      status: "pending_owner_review",
      sourceReviewEventId: input.reviewEventId,
      riskLevel: input.review.riskLevel,
      proposedYamlPatch: input.review.proposedYamlPatch,
      problems: input.review.problems,
      controlObject: "workshop_loop_yaml",
      appliesAutomatically: false,
    },
  });
  if (!event) return null;
  const proposalEvent = event as unknown as WorkshopEvent;
  await upsertWorkshopReviewItemFromProposalEvent(proposalEvent,store);
  return proposalEvent;
}

export async function evaluateLoopReportQuality(input: {
  userId: string;
  workshopId: string;
  loopId: string;
  loopRunId: string | null;
  completionEventId?: string | null;
  result: JobExecutionResult;
}):Promise<{review:ReportQualityReview;reviewEvent:WorkshopEvent;proposalEvent:WorkshopEvent|null}|null> {
  const lease=resolveExecutionLease();
  if(lease){
    if(lease.userId!==input.userId||lease.workshopId!==input.workshopId||lease.runId!==input.loopRunId)throw new ExecutionLeaseError('invalid_lease');
    const saved=await readLoopExecutionStep<{review:ReportQualityReview;reviewEvent:WorkshopEvent;proposalEvent:WorkshopEvent|null}|null>(input.loopId,'quality');
    if(saved.found)return saved.value;
  }
  if (!enabled()) return lease?applyLoopExecutionStep(input.loopId,'quality',async()=>null):null;

  const [workshop, loop, allEvents] = await Promise.all([
    getWorkshop(input.userId, input.workshopId),
    getLoopInWorkshop({
      userId: input.userId,
      workshopId: input.workshopId,
      loopId: input.loopId,
    }),
    listWorkshopEvents(input.workshopId, { limit: 500, order: "latest" }),
  ]);
  if (!workshop || !loop) return null;

  const events = runEventsForReview(allEvents, input.loopRunId);
  const freeformProjectValue = usesFreeformProjectValueReport(workshop);
  const ruleReview = ruleBasedReview({
    loop,
    result: input.result,
    events,
    freeformProjectValue,
  });
  const finalReport = finalReportText(input.result);
  let review = ruleReview;
  try {
    const llmReview = await callEvaluatorLlm({
      userId: input.userId,
      workshopName: workshop.name,
      loop,
      ruleReview,
      finalReport,
      events,
      freeformProjectValue,
    });
    if (llmReview) review = llmReview;
  } catch (error) {
    review = {
      ...ruleReview,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const persist=async(store?:DrizzleDB)=>{
  const reviewEvent = await appendReviewEvent({
    workshopId: input.workshopId,
    loopId: input.loopId,
    loopRunId: input.loopRunId,
    completionEventId: input.completionEventId ?? null,
    review,
    ...(freeformProjectValue && finalReport.length > MAX_REPORT_CHARS ? {
      reportSampling: {
        mode: "head_tail" as const,
        originalChars: finalReport.length,
        maxInputChars: MAX_REPORT_CHARS,
      },
    } : {}),
  });
  const proposalEvent = await appendImprovementProposalEvent({
    workshopId: input.workshopId,
    loopId: input.loopId,
    loopRunId: input.loopRunId,
    reviewEventId: reviewEvent.id,
    review,
  },store);

  return { review, reviewEvent, proposalEvent };
  };
  return lease?applyLoopExecutionStep(input.loopId,'quality',({db})=>persist(db)):persist();
}

export function enqueueLoopReportQualityEvaluation(input: {
  userId: string;
  workshopId: string;
  loopId: string;
  loopRunId: string | null;
  completionEventId?: string | null;
  result: JobExecutionResult;
}) {
  if (!enabled()) return;
  setTimeout(() => {
    evaluateLoopReportQuality(input).catch((error) => {
      console.warn("[ReportQualityEvaluator] failed", {
        workshopId: input.workshopId,
        loopId: input.loopId,
        loopRunId: input.loopRunId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, 250);
}
