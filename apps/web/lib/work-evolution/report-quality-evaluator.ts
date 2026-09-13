import { z } from "zod";
import type {DrizzleDB} from '@/lib/db/types';
import {resolveExecutionLease} from '@/lib/work-runtime/execution-context';
import {ExecutionLeaseError} from '@/lib/work-runtime/execution-errors';
import {applyLoopExecutionStep,readLoopExecutionStep} from '@/lib/work-runtime/loop-execution';
import { jsonrepair } from "jsonrepair";
import type { JobExecutionResult } from "@/lib/cron/types";
import type { Loop, WorkshopEvent } from "@/lib/db/schema";
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

const llmReviewSchema = z.object({
  score: z.coerce.number().min(0).max(100),
  passed: z.boolean().optional(),
  summary: z.string().min(1),
  problems: z
    .array(
      z.object({
        type: z
          .enum([
            "missing_final_markdown",
            "report_too_short",
            "missing_required_section",
            "missing_tool_reasoning",
            "tool_error_noise",
            "verification_gap",
            "boundary_language_risk",
            "formatting_gap",
          ])
          .default("formatting_gap"),
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

async function resolveEvaluatorModelConfig(userId: string) {
  const envConfig = {
    apiKey:
      optionalEnv("REPORT_QUALITY_EVALUATOR_LLM_API_KEY") ??
      optionalEnv("ANTHROPIC_API_KEY") ??
      optionalEnv("ANTHROPIC_AUTH_TOKEN") ??
      optionalEnv("LLM_API_KEY"),
    baseUrl:
      optionalEnv("REPORT_QUALITY_EVALUATOR_LLM_BASE_URL") ??
      optionalEnv("ANTHROPIC_BASE_URL") ??
      optionalEnv("LLM_BASE_URL"),
    model:
      optionalEnv("REPORT_QUALITY_EVALUATOR_LLM_MODEL") ??
      optionalEnv("ANTHROPIC_MODEL") ??
      optionalEnv("LLM_MODEL"),
  };
  if (envConfig.apiKey && envConfig.baseUrl && envConfig.model) {
    return {
      apiKey: envConfig.apiKey,
      baseUrl: envConfig.baseUrl,
      model: envConfig.model,
    };
  }

  return getUserLlmProviderConfig({
    userId,
    providerType: "anthropic_compatible",
  });
}

function truncate(value: unknown, max: number) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
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

function containsBoundaryRisk(markdown: string) {
  return /立即下单|马上买入|马上卖出|全仓买入|全仓卖出|真实下单|帮我买|帮我卖/.test(
    markdown,
  );
}

function ruleBasedReview(input: {
  loop: Loop;
  result: JobExecutionResult;
  events: WorkshopEvent[];
}): ReportQualityReview {
  const report = finalReportText(input.result);
  const parsed = structuredReport(input.result);
  const requiredFields = asStringArray(asRecord(input.loop.verificationConfig).requiredFields);
  const missingRequired = [
    ...asStringArray(parsed.requiredFieldsMissing),
    ...requiredFields.filter((field) => {
      const normalized = field.toLowerCase();
      return !report.toLowerCase().includes(normalized) && !(field in parsed);
    }),
  ];
  const toolErrors = input.events.filter((event) => event.type === "tool_error");
  const denied = input.events.filter(
    (event) =>
      event.type === "permission_decision" &&
      asRecord(event.metadata).decision === "deny",
  );
  const problems: ReportQualityProblem[] = [];

  if (!report.trim() || !/^#\s+/m.test(report)) {
    problems.push({
      type: "missing_final_markdown",
      severity: "high",
      evidence: "The final output does not contain a complete Markdown report with a top heading.",
      yamlTarget: "loop.outputContract.finalMarkdownReport",
      suggestedChange:
        "Require the last assistant output to be a complete Markdown report headed by the loop result title.",
    });
  }
  if (report.trim().length > 0 && report.trim().length < 600) {
    problems.push({
      type: "report_too_short",
      severity: "medium",
      evidence: `Final report is only ${report.trim().length} characters.`,
      yamlTarget: "loop.outputContract.minimumReportDetail",
      suggestedChange:
        "Require conclusion, evidence, unavailable data, decision reasoning, and next observation sections.",
    });
  }
  if (report && markdownSectionCount(report) < 3) {
    problems.push({
      type: "formatting_gap",
      severity: "medium",
      evidence: "Final report has fewer than three Markdown sections.",
      yamlTarget: "loop.outputContract.requiredSections",
      suggestedChange:
        "Add a required Markdown section list for conclusion, evidence, reasoning, blockers, and next step.",
    });
  }
  if (report && !containsToolReasoning(report)) {
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
  if (containsBoundaryRisk(report)) {
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
                  finalOutput: "complete_markdown_report",
                  requiredSections: [
                    "current_conclusion",
                    "key_evidence",
                    "decision_reasoning_trace",
                    "data_gaps_or_recovered_errors",
                    "next_observation",
                  ],
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

function buildPrompt(input: {
  workshopName: string;
  loop: Loop;
  ruleReview: ReportQualityReview;
  finalReport: string;
  events: WorkshopEvent[];
}) {
  return [
    "你是 ReportQualityEvaluator，一个平台内置的质量评审子 agent。",
    "你只评审智能体最终报告质量、工具调用解释、证据完整性、边界表达，以及它们对应的 YAML 配置改进。",
    "你不能提出股票买卖建议，不能改变业务结论，不能要求扩大真实外部动作权限。",
    "你的输出必须是 JSON，不要 Markdown、不要代码块。",
    "",
    "评分维度：",
    "- 完整性：最终报告是否是完整 Markdown。",
    "- 可读性：主人是否一眼知道结论。",
    "- 因果性：报告是否解释为什么读取这些数据/工具。",
    "- 证据性：结论是否能对应到观察和数据源。",
    "- 边界性：是否有越权或真实交易指令风险。",
    "- 配置可改性：问题是否能落到 Workshop/Loop YAML 的 outputContract、verification、toolUsePolicy、memoryPolicy 或 contextPolicy。",
    "",
    "返回 JSON shape:",
    JSON.stringify({
      score: 0,
      passed: false,
      summary: "简短中文总结",
      problems: [
        {
          type: "missing_tool_reasoning",
          severity: "high",
          evidence: "证据",
          yamlTarget: "loops.<loopId>.outputContract.reasoningTrace",
          suggestedChange: "建议如何改 YAML",
        },
      ],
      strengths: ["做得好的地方"],
      proposedYamlPatch: {
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
    "Final Markdown report:",
    truncate(input.finalReport, MAX_REPORT_CHARS),
  ].join("\n");
}

async function callEvaluatorLlm(input: {
  userId: string;
  workshopName: string;
  loop: Loop;
  ruleReview: ReportQualityReview;
  finalReport: string;
  events: WorkshopEvent[];
}): Promise<ReportQualityReview | null> {
  const config = await resolveEvaluatorModelConfig(input.userId);
  if (!config) return null;

  const response = await fetch(buildAnthropicMessagesUrl(config.baseUrl), {
    method: "POST",
    headers: {
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      system:
        "You are a report quality evaluator. Return valid JSON only. Never provide trading advice.",
      max_tokens: positiveIntEnv("REPORT_QUALITY_EVALUATOR_MAX_TOKENS", 1800),
      temperature: 0,
      messages: [
        {
          role: "user",
          content: buildPrompt(input),
        },
      ],
    }),
    signal: AbortSignal.timeout(
      positiveIntEnv("REPORT_QUALITY_EVALUATOR_TIMEOUT_MS", 45_000),
    ),
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

  const text = (
    payload as { content?: Array<{ type?: string; text?: unknown }> } | null
  )?.content
    ?.map((part) =>
      part.type === "text" && typeof part.text === "string" ? part.text : "",
    )
    .join("")
    .trim();
  if (!text) throw new Error("Report quality evaluator returned empty text.");

  const parsed = llmReviewSchema.parse(extractJsonObject(text));
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
}) {
  const event = await appendWorkshopEvent({
    workshopId: input.workshopId,
    loopId: input.loopId,
    loopRunId: input.loopRunId,
    type: "report_quality_review",
    title: `报告质量评审：${input.review.score}/100`,
    body: [
      input.review.summary,
      input.review.problems.length > 0
        ? `问题：${input.review.problems
            .map((problem) => `${problem.severity}:${problem.type}`)
            .join("；")}`
        : "未发现需要配置改进的问题。",
    ].join("\n"),
    metadata: {
      kind: "report_quality_review",
      status: input.review.passed ? "passed" : "needs_improvement",
      completionEventId: input.completionEventId,
      ...input.review,
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
  const ruleReview = ruleBasedReview({
    loop,
    result: input.result,
    events,
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
