import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Loop } from "@/lib/db/schema";

const mocks = vi.hoisted(() => ({
  appendEvent: vi.fn(),
  getWorkshop: vi.fn(),
  getLoop: vi.fn(),
  listEvents: vi.fn(),
  getProvider: vi.fn(),
  upsertProposal: vi.fn(),
}));
vi.mock("@/lib/workshops/service", () => ({
  appendWorkshopEvent: mocks.appendEvent,
  getWorkshop: mocks.getWorkshop,
  listWorkshopEvents: mocks.listEvents,
}));
vi.mock("@/lib/loops/service", () => ({ getLoopInWorkshop: mocks.getLoop }));
vi.mock("@/lib/ai/user-llm-api-settings", () => ({
  getUserLlmProviderConfig: mocks.getProvider,
}));
vi.mock("@/lib/workshops/review-items", () => ({
  upsertWorkshopReviewItemFromProposalEvent: mocks.upsertProposal,
}));
vi.mock("@/lib/work-runtime/execution-context", () => ({
  resolveExecutionLease: () => null,
}));
vi.mock("@/lib/work-runtime/loop-execution", () => ({
  applyLoopExecutionStep: vi.fn(),
  readLoopExecutionStep: vi.fn(),
}));

import {
  buildReportQualityOpenAiCompatibleHeaders,
  evaluateLoopReportQuality,
  evaluateReportQualityWithModel,
  parseReportQualityLlmReview,
} from "@/lib/work-evolution/report-quality-evaluator";

const completeReport = [
  "# Research result",
  "## Conclusion",
  "A bounded project assessment with no external action.",
  "## Evidence",
  "The report links evidence to the current project source.",
  "## Next observation",
  "Verify the limited conclusion against fresh primary sources. ".repeat(12),
].join("\n");

function evaluate(output = completeReport, requiredFieldsMissing: string[] = []) {
  return evaluateLoopReportQuality({
    userId: "user-1",
    workshopId: "work-1",
    loopId: "loop-1",
    loopRunId: "run-1",
    completionEventId: "completion-1",
    result: {
      status: "success", duration: 100, output,
      result: { structuredReport: { requiredFieldsMissing } },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getWorkshop.mockResolvedValue({ id: "work-1", name: "Researcher" });
  mocks.getLoop.mockResolvedValue({
    id: "loop-1", name: "Research", verificationConfig: {},
  } as Loop);
  mocks.listEvents.mockResolvedValue([]);
  mocks.getProvider.mockResolvedValue(undefined);
  mocks.appendEvent.mockImplementation(async (event) => ({
    id: `event-${mocks.appendEvent.mock.calls.length}`, ...event,
  }));
  vi.stubEnv("REPORT_QUALITY_EVALUATOR_ENABLED", "true");
  vi.stubEnv("REPORT_QUALITY_EVALUATOR_LLM_PROVIDER", "openai_compatible");
  vi.stubEnv("REPORT_QUALITY_EVALUATOR_LLM_API_KEY", "test-key");
  vi.stubEnv("REPORT_QUALITY_EVALUATOR_LLM_BASE_URL", "https://example.invalid/v1");
  vi.stubEnv("REPORT_QUALITY_EVALUATOR_LLM_MODEL", "test-reviewer");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("report quality evaluator", () => {
  const problemTypes = ["missing_final_markdown", "report_too_short", "missing_required_section", "missing_tool_reasoning",
    "tool_error_noise", "verification_gap", "boundary_language_risk", "formatting_gap"];
  const validReview = () => ({ score: 88, passed: true, summary: "The supplied evidence and report were assessed.",
    problems: [], strengths: ["Evidence limits are explicit."], proposedYamlPatch: null, riskLevel: "low", needsOwnerReview: false });
  function replyFetch(review: unknown, provider: "openai_compatible" | "anthropic_compatible" = "openai_compatible") {
    const fetch = vi.fn(async () => Response.json(provider === "anthropic_compatible"
      ? { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(review) }] }
      : { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(review) } }] }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it.each(["openai_compatible", "anthropic_compatible"] as const)("sends the exact compact JSON output contract to the %s reviewer", async provider => {
    vi.stubEnv("REPORT_QUALITY_EVALUATOR_LLM_PROVIDER", provider);
    const fetch = replyFetch(validReview(), provider);
    const result = await evaluate();
    expect(result?.review.evaluatorMode).toBe("llm");
    expect(fetch).toHaveBeenCalledOnce();
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    const prompt = body.messages.find((message: { role: string }) => message.role === "user").content;
    expect(prompt).toMatch(/problems\[\]\.severity[^\n]*"low"[^\n]*"medium"[^\n]*"high"/);
    expect(prompt).toMatch(/riskLevel[^\n]*"low"[^\n]*"medium"[^\n]*"high"/);
    expect(prompt).toMatch(/problems\[\]\.type[^\n]*missing_final_markdown/);
    for (const type of problemTypes) expect(prompt).toContain(`"${type}"`);
    expect(prompt).toContain("critical、blocker、info 或中文枚举");
    expect(prompt).toContain("非空字符串");
    expect(prompt).toMatch(/passed[^\n]*needsOwnerReview[^\n]*boolean/);
    expect(prompt).toContain("0 到 100");
    expect(prompt).toContain("没有问题时 problems 必须为 []");
    expect(prompt).toContain("1800 tokens");
    expect(prompt).toContain("不要复述或复制 finalReport");
    expect(prompt.split(completeReport.trim())).toHaveLength(2);
    expect(body.max_tokens).toBe(1800);
  });

  it.each(["critical", "blocker", "info", "严重"])("retains strict degradation for a complete HTTP JSON review with illegal severity %s", async severity => {
    const fetch = replyFetch({ ...validReview(), problems: [{ type: "verification_gap", severity,
      evidence: "A source claim remains unverified.", yamlTarget: "loops.fixture.verification",
      suggestedChange: "Keep the unresolved claim explicit." }] });
    const result = await evaluate();
    expect(fetch).toHaveBeenCalledOnce();
    expect(result?.review).toMatchObject({ score: 100, passed: true, evaluatorMode: "rule_based" });
    expect(result?.review.error).toContain("severity");
    expect(result?.reviewEvent.metadata).toMatchObject({ status: "degraded", degraded: true,
      semanticReviewStatus: "not_completed", ruleBasedScore: 100 });
    expect(result?.reviewEvent.body).toContain("模型评审未完成");
    expect(result?.proposalEvent).toBeNull();
  });

  it("accepts a complete legal schema with every supported problem type without promoting the result to a pass", async () => {
    const problems = problemTypes.map((type, index) => ({ type, severity: ["low", "medium", "high"][index % 3],
      evidence: `Observed issue ${index + 1}.`, yamlTarget: "loops.fixture.outputContract",
      suggestedChange: "Review this bounded configuration issue." }));
    const fetch = replyFetch({ ...validReview(), score: 68, passed: false, problems, riskLevel: "medium", needsOwnerReview: true });
    const result = await evaluate();
    expect(fetch).toHaveBeenCalledOnce();
    expect(result?.review).toMatchObject({ score: 68, passed: false, evaluatorMode: "llm", problems, error: null });
    expect(result?.reviewEvent.metadata).toMatchObject({ status: "needs_improvement", degraded: false,
      semanticReviewStatus: "completed", ruleBasedScore: null });
    expect(result?.proposalEvent).toBeNull();
  });

  const freeformReport = "The paper's replay boundary adds little to applyRecordedStep: the function already returns a stored result. Its useful addition would be reconciling an unknown remote outcome, but only if the provider exposes an idempotency key. A local simulation can falsify the proposal by crashing after the provider accepts a request and checking that recovery creates no second effect.";
  const freeformConfig = {
    role: "agent_frontier_researcher",
    researchReportStyle: "freeform_project_value",
  };

  function setReportStyle(modelConfig: Record<string, unknown>) {
    mocks.getWorkshop.mockResolvedValue({ id: "work-1", name: "Researcher", modelConfig });
    mocks.getLoop.mockResolvedValue({
      id: "loop-1", name: "Research", verificationConfig: {
        requiredFields: ["coverage", "projectAssessment", "researchProcess"],
      },
    } as unknown as Loop);
  }

  it("accepts focused freeform project analysis without length, section or internal-field penalties", async () => {
    setReportStyle(freeformConfig);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Model unavailable")));

    const result = await evaluate(freeformReport);

    expect(result?.review).toMatchObject({ score: 100, passed: true, problems: [] });
    expect(result?.reviewEvent.metadata).toMatchObject({
      status: "degraded", semanticReviewStatus: "not_completed",
    });
    expect(result?.reviewEvent.body).toContain("不能证明报告结论或研究证据正确");
    expect(result?.proposalEvent).toBeNull();
  });

  it.each([
    { role: "general_workshop", researchReportStyle: "freeform_project_value" },
    { role: "agent_frontier_researcher", researchReportStyle: "structured" },
    { role: "agent_frontier_researcher" },
  ])("retains established report checks outside the exact freeform research opt-in: %j", async (config) => {
    setReportStyle(config);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Model unavailable")));

    const result = await evaluate(freeformReport);

    expect(result?.review.passed).toBe(false);
    expect(result?.review.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "missing_final_markdown" }),
      expect.objectContaining({ type: "report_too_short" }),
      expect.objectContaining({ type: "formatting_gap" }),
      expect.objectContaining({ type: "missing_required_section" }),
      expect.objectContaining({ type: "missing_tool_reasoning" }),
    ]));
  });

  it("keeps empty reports and explicit verification gaps visible for freeform research", async () => {
    setReportStyle(freeformConfig);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Model unavailable")));

    const result = await evaluate("", ["researchProcess"]);

    expect(result?.review.passed).toBe(false);
    expect(result?.review.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "missing_final_markdown", evidence: "The final report is empty." }),
      expect.objectContaining({ type: "missing_required_section" }),
    ]));
    const patch = result?.review.proposedYamlPatch as any;
    expect(patch.loops["loop-1"].outputContract).toMatchObject({
      finalOutput: "freeform_project_value_report",
    });
    expect(patch.loops["loop-1"].outputContract).not.toHaveProperty("requiredSections");
  });

  it("keeps source failures, denied actions and boundary risks visible in freeform research", async () => {
    setReportStyle(freeformConfig);
    mocks.listEvents.mockResolvedValue([
      { id: "source-error", seq: 1, type: "tool_error", loopRunId: "run-1" },
      { id: "denied", seq: 2, type: "permission_decision", loopRunId: "run-1", metadata: { decision: "deny" } },
    ]);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Model unavailable")));

    const result = await evaluate(`${freeformReport} 立即下单`);

    expect(result?.review.passed).toBe(false);
    expect(result?.review.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_error_noise" }),
      expect.objectContaining({ type: "verification_gap" }),
      expect.objectContaining({ type: "boundary_language_risk" }),
    ]));
  });

  it("does not treat the actual research report's quoted boundary-rule examples as trading advice", async () => {
    setReportStyle(freeformConfig);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Model unavailable")));
    const ruleExplanation = '**规则评审**（362-525 行）执行 8 类确定性检查：报告是否存在 Markdown 标题、长度是否≥600 字符、章节数是否≥3、是否包含工具推理关键词（"为什么""证据""reason"等）、是否有工具错误噪声、是否有 denied 决策、是否缺少必填字段、是否包含边界语言风险（"立即下单""全仓买入"等）。评分按 high=22、medium=12、low=5 扣分，≥80 且零问题才通过。';

    const result = await evaluate(ruleExplanation);

    expect(result?.review.problems).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "boundary_language_risk" }),
    ]));
    expect(result?.review).toMatchObject({ score: 100, passed: true });
    expect(result?.reviewEvent.metadata).toMatchObject({
      status: "degraded", semanticReviewStatus: "not_completed",
    });
  });

  it.each([
    '规则评审会检测“立即下单”“全仓买入”等风险词，但我建议主人现在执行“立即下单”，并且“全仓买入”。',
    '源码规则会检测“全仓买入”，主人现在“全仓买入”。',
    '源码规则会检测“全仓买入”，请“全仓买入”。',
  ])("still detects quoted trading recommendations in a sentence discussing boundary rules: %s", async (report) => {
    setReportStyle(freeformConfig);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Model unavailable")));

    const result = await evaluate(report);

    expect(result?.review.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "boundary_language_risk", severity: "high" }),
    ]));
    expect(result?.review).toMatchObject({ score: 78, passed: false });
  });

  it("asks the target model reviewer to assess project value with falsifiable claims instead of a report template", async () => {
    setReportStyle(freeformConfig);
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        score: 87, passed: true, summary: "Project value was assessed.",
      }) } }] }),
    });
    vi.stubGlobal("fetch", fetch);

    const result = await evaluate(freeformReport);

    const prompt = JSON.parse(fetch.mock.calls[0][1].body).messages[1].content;
    expect(prompt).toContain("不得因字数、章节数量、标题格式或正文未出现内部字段名而扣分");
    expect(prompt).toContain("不是必填章节或报告模板");
    expect(prompt).toContain("文章论点");
    expect(prompt).toContain("当前相关源码");
    expect(prompt).toContain("有效增量");
    expect(prompt).toContain("成立条件与反例");
    expect(prompt).toContain("可证伪验证");
    expect(prompt).toContain("抓取降级");
    expect(prompt).not.toContain("完整性：最终报告是否是完整 Markdown");
    expect(prompt).toContain("项目价值与可检验性");
    expect(prompt).toContain("项目已经足够或文章不适用也可有价值");
    expect(prompt).toContain("没有配置问题时 proposedYamlPatch 可为 null 或 {}");
    expect(prompt).toContain('"proposedYamlPatch":null');
    expect(prompt).not.toContain("配置可改性：问题是否能落到 Workshop/Loop YAML");
    expect(prompt).not.toContain("建议如何改 YAML");
    expect(prompt.split("Project value report:\n")[1]).toBe(freeformReport);
    expect(result?.reviewEvent.metadata).not.toHaveProperty("reportSampling");
  });

  it("samples both ends of long freeform reports within the unchanged model review budget", async () => {
    setReportStyle(freeformConfig);
    const longReport = `HEAD_SENTINEL ${"a".repeat(9_000)} MIDDLE_SENTINEL ${"b".repeat(9_000)} TAIL_SENTINEL`;
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        score: 85, passed: true, summary: "Only the supplied excerpts were assessed.",
      }) } }] }),
    });
    vi.stubGlobal("fetch", fetch);

    const result = await evaluate(longReport);

    const prompt = JSON.parse(fetch.mock.calls[0][1].body).messages[1].content;
    const excerpt = prompt.split("Project value report:\n")[1];
    expect(excerpt.length).toBeLessThanOrEqual(12_000);
    expect(excerpt).toContain("HEAD_SENTINEL");
    expect(excerpt).toContain("TAIL_SENTINEL");
    expect(excerpt).not.toContain("MIDDLE_SENTINEL");
    expect(excerpt).toContain("不能声称完整报告已全面审阅");
    expect(excerpt).toContain("不得将摘录中看不到的内容认定为全篇缺失");
    expect(result?.reviewEvent.body).toContain("不能代表全篇已核验");
    expect(result?.reviewEvent.metadata).toMatchObject({
      reviewScope: "report_head_tail_excerpt",
      reportSampling: { mode: "head_tail", originalChars: longReport.length, maxInputChars: 12_000 },
    });
  });

  it("preserves prefix-only report sampling for ordinary workshops", async () => {
    const longReport = `HEAD_SENTINEL ${"a".repeat(9_000)} MIDDLE_SENTINEL ${"b".repeat(9_000)} TAIL_SENTINEL`;
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        score: 85, passed: true, summary: "The default model review was completed.",
      }) } }] }),
    });
    vi.stubGlobal("fetch", fetch);

    const result = await evaluate(longReport);

    const prompt = JSON.parse(fetch.mock.calls[0][1].body).messages[1].content;
    expect(prompt.split("Final Markdown report:\n")[1]).toBe(`${longReport.slice(0, 12_000)}...`);
    expect(prompt).not.toContain("TAIL_SENTINEL");
    expect(prompt).not.toContain("不能声称完整报告已全面审阅");
    expect(result?.reviewEvent.metadata).not.toHaveProperty("reportSampling");
  });

  it("exposes model timeout as degraded while preserving the original rule result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Model review timed out")));

    const result = await evaluate();

    expect(result?.review).toMatchObject({
      score: 100, passed: true, evaluatorMode: "rule_based", error: "Model review timed out",
    });
    expect(result?.reviewEvent.title).toContain("仅规则检查（100/100）");
    expect(result?.reviewEvent.body).toContain("模型评审未完成");
    expect(result?.reviewEvent.body).toContain("Model review timed out");
    expect(result?.reviewEvent.body).toContain("不能证明报告结论或研究证据正确");
    expect(result?.reviewEvent.metadata).toMatchObject({
      status: "degraded", degraded: true, semanticReviewStatus: "not_completed",
      ruleBasedScore: 100, ruleBasedPassed: true, score: 100, passed: true,
      completionEventId: "completion-1",
    });
    expect(result?.proposalEvent).toBeNull();
  });

  it("labels an unavailable model as rules only without issuing a model request", async () => {
    for (const key of [
      "REPORT_QUALITY_EVALUATOR_LLM_API_KEY", "OPENCODE_API_KEY",
      "WORKSHOP_PLANNER_LLM_API_KEY", "LLM_API_KEY",
      "REPORT_QUALITY_EVALUATOR_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
    ]) vi.stubEnv(key, "");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const result = await evaluate();

    expect(fetch).not.toHaveBeenCalled();
    expect(result?.reviewEvent.body).toContain("未配置可用的模型评审器");
    expect(result?.reviewEvent.metadata).toMatchObject({
      status: "degraded", semanticReviewStatus: "not_completed", ruleBasedScore: 100,
    });
  });

  it("retains rule failures and improvement proposals after model failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Model unavailable")));

    const result = await evaluate("# Incomplete report");

    expect(result?.review.passed).toBe(false);
    expect(result?.review.score).toBeLessThan(80);
    expect(result?.review.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "report_too_short" }),
      expect.objectContaining({ type: "formatting_gap" }),
    ]));
    expect(result?.reviewEvent.metadata).toMatchObject({
      status: "degraded", ruleBasedPassed: false,
    });
    expect(result?.reviewEvent.body).toContain("规则检查未通过");
    expect(result?.proposalEvent?.type).toBe("report_quality_config_proposed");
    expect(mocks.upsertProposal).toHaveBeenCalledOnce();
  });

  it("keeps a completed model review distinct from the fallback score", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        score: 88, passed: true, summary: "Evidence and reasoning were reviewed.",
      }) } }] }),
    });
    vi.stubGlobal("fetch", fetch);

    const result = await evaluate();

    expect(result?.review).toMatchObject({ score: 88, passed: true, evaluatorMode: "llm" });
    expect(result?.reviewEvent.title).toBe("报告质量评审：88/100");
    expect(result?.reviewEvent.body).not.toContain("模型评审未完成");
    expect(result?.reviewEvent.metadata).toMatchObject({
      status: "passed", degraded: false, semanticReviewStatus: "completed",
      ruleBasedScore: null, ruleBasedPassed: null,
    });
    const prompt = JSON.parse(fetch.mock.calls[0][1].body).messages[1].content;
    expect(prompt).toContain("完整性：最终报告是否是完整 Markdown");
    expect(prompt).toContain("报告是否解释为什么读取这些数据/工具");
    expect(prompt).toContain("配置可改性：问题是否能落到 Workshop/Loop YAML");
    expect(prompt).toContain("建议如何改 YAML");
    expect(prompt).not.toContain("不是必填章节或报告模板");
  });

  it("adds an OpenCode Go session header for OpenAI-compatible requests", () => {
    const headers = buildReportQualityOpenAiCompatibleHeaders({
      apiKey: "test-key",
      baseUrl: "https://opencode.ai/zen/go",
    });

    expect(headers.Authorization).toBe("Bearer test-key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["x-opencode-session"]).toMatch(
      /^zhiyu-report-quality-/,
    );
  });

  it("normalizes unknown LLM problem types instead of rejecting the review", () => {
    const parsed = parseReportQualityLlmReview(
      JSON.stringify({
        score: 72,
        passed: false,
        summary: "The report needs more actionable detail.",
        problems: [
          {
            type: "unsupported_provider_label",
            severity: "medium",
            evidence: "The evaluator used a provider-specific label.",
            yamlTarget: "loops.demo.outputContract",
            suggestedChange: "Use one of the supported quality categories.",
          },
        ],
        strengths: ["The report is readable."],
        proposedYamlPatch: null,
        riskLevel: "low",
        needsOwnerReview: true,
      }),
    );

    expect(parsed.problems[0]?.type).toBe("formatting_gap");
    expect(parsed.summary).toContain("actionable");
  });
  it.each(["environment", "saved"])("uses the documented Qwen Go protocol for %s Anthropic configuration", async source => {
    for (const prefix of ["REPORT_QUALITY_EVALUATOR_LLM", "OPENCODE", "WORKSHOP_PLANNER_LLM", "LLM", "REPORT_QUALITY_EVALUATOR_ANTHROPIC", "ANTHROPIC"]) {
      for (const field of ["API_KEY", "BASE_URL", "MODEL"]) vi.stubEnv(`${prefix}_${field}`, "");
    }
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    if (source === "environment") {
      vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
      vi.stubEnv("ANTHROPIC_BASE_URL", "https://opencode.ai/zen/go/v1");
      vi.stubEnv("ANTHROPIC_MODEL", "qwen3.7-plus");
    } else {
      mocks.getProvider.mockImplementation(async ({ providerType }) => providerType === "anthropic_compatible" ? {
        apiKey: "test-key", baseUrl: "https://opencode.ai/zen/go/v1", model: "qwen3.7-plus",
      } : undefined);
    }
    const fetchMock = vi.fn(async () => Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({
      score: 88, passed: true, summary: "Evidence was assessed.",
    }) }] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await evaluate();
    expect(result?.review.evaluatorMode).toBe("llm");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://opencode.ai/inference/go/anthropic/v1/messages");
    expect(init).toMatchObject({ redirect: "error", headers: { "User-Agent": "zhiyu-agent/0.5.0" } });
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "qwen3.7-plus", max_tokens: 1800, thinking: { type: "disabled" } });
    expect(result?.reviewEvent.metadata).toMatchObject({ provider: {
      source: source === "environment" ? "env_anthropic_compatible" : "user_anthropic_compatible",
      protocol: "anthropic-messages", migrated: true,
      baseUrl: "https://opencode.ai/inference/go/anthropic", model: "qwen3.7-plus",
    } });
    expect(JSON.stringify(result)).not.toContain("test-key");
  });
  it.each(["length", "content_filter", "tool_calls", null])("does not promote an incomplete OpenAI review %s to semantic success", async finishReason => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ finish_reason: finishReason, message: { content: JSON.stringify({
      score: 99, passed: true, summary: "A parseable but incomplete response.",
    }) } }] })));
    const result = await evaluate();
    expect(result?.review.evaluatorMode).toBe("rule_based");
    expect(result?.reviewEvent.metadata).toMatchObject({ status: "degraded", semanticReviewStatus: "not_completed", provider: {
      source: "env_openai_compatible", protocol: "openai-completions", model: "test-reviewer",
    } });
    expect(result?.review.error).toContain("report_quality_provider_incomplete_response");
  });
  it("allows model-only diagnostics without persisting a review or configuration proposal", async () => {
    const providerResolved = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
      score: 88, passed: true, summary: "The supplied report was assessed.",
    }) } }] })));
    const result = await evaluateReportQualityWithModel({
      userId: "user-1", workshopName: "Researcher", loop: { id: "loop-1", name: "Research" } as Loop,
      ruleReview: { score: 100, passed: true, summary: "Rules checked.", problems: [], strengths: [], proposedYamlPatch: null,
        riskLevel: "low", needsOwnerReview: true, evaluatorMode: "rule_based", model: null, error: null },
      finalReport: completeReport, events: [], freeformProjectValue: true, onProviderResolved: providerResolved,
    });
    expect(result).toMatchObject({ evaluatorMode: "llm", provider: { finishReason: "stop" } });
    expect(providerResolved).toHaveBeenCalledOnce();
    expect(mocks.appendEvent).not.toHaveBeenCalled();
    expect(mocks.upsertProposal).not.toHaveBeenCalled();
    expect(mocks.getWorkshop).not.toHaveBeenCalled();
    expect(mocks.getLoop).not.toHaveBeenCalled();
  });
});
