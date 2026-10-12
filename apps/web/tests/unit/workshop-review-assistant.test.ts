import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db/client", () => ({ db: { execute: vi.fn() } }));
vi.mock("@/lib/workshops/service", () => ({ getWorkshop: vi.fn(), appendWorkshopEvent: vi.fn() }));
import { db } from "@/lib/db/client";
import { getWorkshop, appendWorkshopEvent } from "@/lib/workshops/service";
import { buildReviewAssistantItem } from "@/lib/workshops/review-assistant";
import { applyReviewAssistantJudgments, createReviewAssistantService, loadReviewAssistantSnapshot, reviewAssistantBaseline, reviewAssistantFingerprint, reviewAssistantModelInputs, type ReviewAssistantSnapshot } from "@/lib/workshops/review-assistant-service";
import { REVIEW_ASSISTANT_JEV_MODEL, REVIEW_ASSISTANT_JEV_SCHEMA, REVIEW_ASSISTANT_AGENT_SCHEMA, REVIEW_ASSISTANT_THRESHOLDS, type ReviewAssistantModelResult, type ReviewAssistantModelInput, type ReviewAssistantAgentResult, type ReviewAssistantEvaluation, type ReviewAssistantAgentModel } from "@/lib/workshops/review-assistant-model";

const owner = "11111111-1111-4111-8111-111111111111";
const workId = "22222222-2222-4222-8222-222222222222";
const itemId = "33333333-3333-4333-8333-333333333333";
const sourceId = "44444444-4444-4444-8444-444444444444";
function snapshot(kind = "report_quality_config_proposal"): ReviewAssistantSnapshot {
  return { workshop: { id: workId, userId: owner, name: "文档专员", mission: "整理文档" } as never, total: 1, pendingUpdatedAt: "2026-09-26T00:00:00.000Z",
    sources: [{ item: { id: itemId, kind, title: "报告改进", summary: "汇报未附上原文页码", riskLevel: "low", sourceEventId: sourceId,
      updatedAt: "2026-09-26T00:00:00.000Z", metadata: {} }, event: { id: sourceId, type: "report_quality_config_proposed", title: "报告改进", body: "汇报没有注明页码", metadata: {} } }] };
}
function result(overrides: Partial<ReviewAssistantModelResult> = {}): ReviewAssistantModelResult {
  return { status: "ok", model: REVIEW_ASSISTANT_JEV_MODEL, schemaVersion: REVIEW_ASSISTANT_JEV_SCHEMA, thresholds: { ...REVIEW_ASSISTANT_THRESHOLDS },
    inputHash: "a".repeat(64), elapsedMs: 20,
    items: [{ id: itemId, truncated: false, probabilities: { currentImpact: 0.1, concreteBenefit: 0.9, sufficientEvidence: 0.9, significantSideEffects: 0.1 } }], ...overrides };
}
function agentResult(overrides: Partial<ReviewAssistantAgentResult> = {}): ReviewAssistantAgentResult {
  return { status: "ok", provider: "fixture-main", model: "fixture-model", schemaVersion: REVIEW_ASSISTANT_AGENT_SCHEMA,
    inputHash: "a".repeat(64), elapsedMs: 20,
    items: [{ id: itemId, truncated: false, suggestion: "review", priority: "normal", reason: "先核对汇报引用页码，再决定改动。", missingInfo: [] }], ...overrides };
}
function fixture(current = snapshot()) {
  let cached: { generatedAt: string; result: ReviewAssistantEvaluation; modelIdentity: string } | null = null;
  let cachedFingerprint: string | null = null;
  const configured: ReviewAssistantAgentModel = { status: "ok", provider: "fixture-main", model: "fixture-model", cacheIdentity: "c".repeat(64), runtime: {} as never };
  const dependencies = {
    snapshot: vi.fn(async () => structuredClone(current)),
    resolveModel: vi.fn(async () => configured),
    cached: vi.fn(async (_owner: string, _work: string, fingerprint: string, modelIdentity: string) => fingerprint === cachedFingerprint && modelIdentity === cached?.modelIdentity ? cached : null),
    evaluate: vi.fn(async (_inputs: ReviewAssistantModelInput[]): Promise<ReviewAssistantEvaluation> => agentResult()),
    save: vi.fn(async (_owner: string, _work: string, fingerprint: string, value: typeof cached) => { cached = value; cachedFingerprint = fingerprint; }),
  };
  return { current, dependencies, service: createReviewAssistantService(dependencies) };
}

describe("review assistant facts and boundaries", () => {
  beforeEach(() => vi.clearAllMocks());
  it("keeps observed memory signals and their scope in the JEV input", () => {
    const current = snapshot("memory_recall_quality");
    current.sources[0].event = null;
    current.sources[0].item.sourceEventId = null;
    current.sources[0].item.metadata = { source: "memory_recall_quality_report", issueKind: "duplicate_canonical_groups", issueCount: 4,
      periodDays: null, recommendedActions: ["Review canonical grouping"], evidenceHints: ["duplicateCanonicalGroupCount"],
      blockedActions: ["Do not bulk merge memories without source evidence and rollback notes."], feedbackTraceDiagnostics: { runs: [], loops: [] } };
    const input = reviewAssistantModelInputs(current, reviewAssistantBaseline(current))[0];
    expect(input.facts).toContain("duplicate_canonical_groups");
    expect(input.facts).toContain('"issueCount":4');
    expect(input.facts).toContain("duplicateCanonicalGroupCount");
    expect(input.facts).toContain("Do not bulk merge");
  });
  it("explains old aggregate memory records without turning uncertainty into an owner evidence request", () => {
    const current = snapshot("memory_recall_quality");
    current.sources[0].event = null;
    current.sources[0].item.sourceEventId = null;
    current.sources[0].item.metadata = { source: "memory_recall_quality_report", issueKind: "duplicate_canonical_groups", issueCount: 4,
      periodDays: null, feedbackTraceDiagnostics: { runs: [], loops: [] } };
    const observed = result();
    observed.items[0].probabilities = { currentImpact: 0.1, concreteBenefit: 0.41, sufficientEvidence: 0.53, significantSideEffects: 0.06 };
    const item = applyReviewAssistantJudgments(reviewAssistantBaseline(current), observed, "now").items[0];
    expect(item.title).not.toContain("被重复放进");
    expect(item.knownFacts?.join(" ")).toMatch(/4.*过滤/);
    expect(item.suggestion).toBe("defer");
    expect(item.missingInfo.join(" ")).toContain("分组");
    expect(item.nextStep).toContain("记忆");
    expect(item.reason).not.toContain("影响、收益、证据或副作用");
  });
  it("does not block useful review just because the benefit score is uncertain", () => {
    const observed = result();
    observed.items[0].probabilities = { currentImpact: 0.9, concreteBenefit: 0.5, sufficientEvidence: 0.95, significantSideEffects: 0.1 };
    const item = applyReviewAssistantJudgments(reviewAssistantBaseline(snapshot()), observed, "now").items[0];
    expect(item.suggestion).toBe("review");
    expect(item.priority).toBe("first");
    expect(item.missingInfo.join(" ")).not.toContain("当前资料不能明确判断影响和收益");
  });
  it("explains report improvement without inventing configuration application", () => {
    const item = buildReviewAssistantItem({ ...snapshot().sources[0].item, riskLevel: "high" });
    expect(item.category).toBe("optional");
    expect(item.priority).toBe("first");
    expect(item.impact).toContain("关闭待办不会修改报告");
    expect(item.decision).toContain("当前智能体对话");
    expect(item.aiAssisted).toBe(false);
  });
  it("uses distinct understandable memory/report topics and keeps technical text in original evidence", () => {
    const descriptions = [
      ["trace_warnings", "查找记忆时有异常提示"],
      ["duplicate_canonical_groups", "记忆查找中过滤了重复候选"],
      ["no_evidence_selected", "参考记忆缺少可核验的来源"],
    ];
    for (const [issueKind, title] of descriptions) {
      const item = buildReviewAssistantItem({ ...snapshot().sources[0].item, kind: "memory_recall_quality", summary: "ContextPack canonical groups warning", metadata: { issueKind } });
      expect(item.title).toBe(title); expect(item.what).not.toMatch(/ContextPack|canonical/);
      expect(item.evidence.join(" ")).toContain("ContextPack");
    }
    const item = buildReviewAssistantItem(snapshot().sources[0].item, { ...snapshot().sources[0].event!, metadata: { problems: [{ type: "verification_gap", evidence: "No source evidence", suggestedChange: "补充原文页码" }] } });
    expect(item.title).toBe("为汇报补上数据来源和核验依据");
    expect(item.what).toContain("补充原文页码"); expect(item.what).not.toContain("No source evidence");
  });
  it("keeps configuration, Loop and permission decisions at fixed priority", () => {
    for (const kind of ["loop_change_proposal", "agent_change_proposal", "permission_boundary"]) {
      const baseline = reviewAssistantBaseline(snapshot(kind));
      const observed = result();
      observed.items[0].probabilities = { currentImpact: 0.1, concreteBenefit: 0.1, sufficientEvidence: 0.9, significantSideEffects: 0.1 };
      const item = applyReviewAssistantJudgments(baseline, observed, new Date().toISOString()).items[0];
      expect(item).toMatchObject({ category: "required", priority: "first", prioritySource: "rules", suggestion: "review" });
    }
  });
  it("requires more evidence on uncertain or truncated judgment, and never fabricates narrative", () => {
    const baseline = reviewAssistantBaseline(snapshot());
    const uncertain = result(); uncertain.items[0].probabilities.significantSideEffects = 0.5;
    const first = applyReviewAssistantJudgments(baseline, uncertain, "now").items[0];
    expect(first.suggestion).toBe("need_evidence");
    expect(first.reason).toContain("副作用");
    expect(first.what).toBe(baseline.items[0].what);
    const truncated = result(); truncated.items[0].truncated = true;
    expect(applyReviewAssistantJudgments(baseline, truncated, "now").items[0].suggestion).toBe("need_evidence");
  });
  it("can recommend deferring optional work only on clear judgments and sufficient evidence", () => {
    const observed = result(); observed.items[0].probabilities.concreteBenefit = 0.1;
    expect(applyReviewAssistantJudgments(reviewAssistantBaseline(snapshot()), observed, "now").items[0]).toMatchObject({ suggestion: "defer", priority: "later", prioritySource: "ai" });
  });
  it("hashes complete source metadata and owner even outside a displayed excerpt", () => {
    const first = snapshot(); const second = structuredClone(first);
    second.sources[0].event!.metadata = { hiddenTail: "changed" };
    expect(reviewAssistantFingerprint(first)).not.toBe(reviewAssistantFingerprint(second));
    second.sources[0].event!.metadata = {}; second.workshop.userId = sourceId;
    expect(reviewAssistantFingerprint(first)).not.toBe(reviewAssistantFingerprint(second));
  });
  it("separates current Work observations from historic aggregate counts and invalidates old analysis", () => {
    const current = snapshot("memory_recall_quality");
    current.workObservations = { windowDays: 7, sampleCount: 5, firstEventAt: "2026-09-25T00:00:00Z", lastEventAt: "2026-09-26T00:00:00Z",
      eventIds: [sourceId], warningCount: 0, noEvidenceSelectedCount: 0, duplicateOmittedCount: 0 };
    const initialHash = reviewAssistantFingerprint(current);
    const baseline = reviewAssistantBaseline(current);
    expect(baseline.items[0].knownFacts?.join(" ")).toContain("本车间近 7 天抽样 5 条");
    expect(baseline.items[0].knownFacts?.join(" ")).toContain("不代表全部运行");
    const input = JSON.parse(reviewAssistantModelInputs(current, baseline)[0].facts);
    expect(input.currentWorkSample).toMatchObject({ sampleCount: 5, warningCount: 0, scope: "current_work_only_sample_not_all_runs" });
    current.workObservations.warningCount = 1;
    expect(reviewAssistantFingerprint(current)).not.toBe(initialHash);
    current.workObservations = null;
    current.observationWarning = "current work read failed";
    expect(reviewAssistantBaseline(current).warning).toBe("current work read failed");
  });
  it("keeps bounded model input valid JSON with explicit omission, while retaining primary observations", () => {
    const current = snapshot("memory_recall_quality");
    current.sources[0].item.metadata = { issueKind: "trace_warnings", issueCount: 3, recommendedActions: Array(20).fill("x".repeat(2000)) };
    current.sources[0].item.summary = "y".repeat(9000);
    const input = reviewAssistantModelInputs(current, reviewAssistantBaseline(current))[0];
    expect(input.truncated).toBe(true);
    expect(input.facts.length).toBeLessThanOrEqual(2800);
    expect(JSON.parse(input.facts)).toMatchObject({ issueKind: "trace_warnings", issueCount: 3 });
  });
  it("checks ownership before reading either review rows or source events", async () => {
    vi.mocked(getWorkshop).mockResolvedValueOnce(null);
    await expect(loadReviewAssistantSnapshot(owner, workId)).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(db.execute).not.toHaveBeenCalled();
    expect(appendWorkshopEvent).not.toHaveBeenCalled();
  });
});

describe("review assistant lifecycle", () => {
  it("GET only reads rules, then returns exact source-matched persisted judgments", async () => {
    const { service, dependencies } = fixture();
    const initial = await service.get({ userId: owner, workId });
    expect(initial).toMatchObject({ mode: "rules", cached: false, coverage: { analyzed: 0, scope: "pending_review_items" } });
    expect(dependencies.save).not.toHaveBeenCalled(); expect(dependencies.evaluate).not.toHaveBeenCalled();
    const generated = await service.generate({ userId: owner, workId, fingerprint: initial.fingerprint });
    expect(generated).toMatchObject({ mode: "ai", cached: false, coverage: { analyzed: 1 } });
    const again = await service.get({ userId: owner, workId });
    expect(again).toMatchObject({ mode: "ai", cached: true });
    expect(dependencies.evaluate).toHaveBeenCalledTimes(1); expect(dependencies.save).toHaveBeenCalledTimes(1);
  });
  it("coalesces concurrent generation and never resolves a review", async () => {
    const { service, dependencies, current } = fixture();
    let finish!: (value: ReviewAssistantEvaluation) => void;
    dependencies.evaluate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const input = { userId: owner, workId, fingerprint: reviewAssistantFingerprint(current) };
    const a = service.generate(input); const b = service.generate(input);
    await vi.waitFor(() => expect(dependencies.evaluate).toHaveBeenCalledTimes(1));
    finish(agentResult()); await Promise.all([a, b]);
    expect(dependencies.save).toHaveBeenCalledTimes(1);
    expect(current).toEqual(snapshot());
    expect(appendWorkshopEvent).not.toHaveBeenCalled();
  });
  it("rejects stale requests without paying for a model and rejects results whose sources changed in flight", async () => {
    const { service, dependencies, current } = fixture();
    await expect(service.generate({ userId: owner, workId, fingerprint: "b".repeat(64) })).rejects.toMatchObject({ code: "source_changed" });
    expect(dependencies.evaluate).not.toHaveBeenCalled();
    const fingerprint = reviewAssistantFingerprint(current);
    dependencies.evaluate.mockImplementationOnce(async () => { current.sources[0].item.summary = "已经发生变化"; return agentResult(); });
    await expect(service.generate({ userId: owner, workId, fingerprint })).rejects.toMatchObject({ code: "source_changed" });
    expect(dependencies.save).toHaveBeenCalledWith(owner, workId, fingerprint, expect.anything());
  });
  it("does not reuse cached AI when original source metadata changes", async () => {
    const { service, dependencies, current } = fixture();
    await service.generate({ userId: owner, workId, fingerprint: reviewAssistantFingerprint(current) });
    current.sources[0].event!.metadata = { changed: true };
    expect((await service.get({ userId: owner, workId })).mode).toBe("rules");
  });
  it("rejects forged or omitted IDs in model/cache results and falls back explicitly", async () => {
    const { service, dependencies, current } = fixture();
    const forged = agentResult(); forged.items[0].id = sourceId;
    dependencies.evaluate.mockResolvedValueOnce(forged);
    const response = await service.generate({ userId: owner, workId, fingerprint: reviewAssistantFingerprint(current) });
    expect(response).toMatchObject({ mode: "rules", coverage: { analyzed: 0 } });
    expect(response.warning).toContain("完整性校验");
    expect(response.items.map(item => item.id)).toEqual([itemId]);
  });
  it("persists a visible fallback on missing key or transport failure, with bounded negative caching", async () => {
    const { service, dependencies, current } = fixture();
    dependencies.evaluate.mockResolvedValueOnce(agentResult({ status: "degraded", detail: "missing_model_configuration", items: [] }));
    const response = await service.generate({ userId: owner, workId, fingerprint: reviewAssistantFingerprint(current) });
    expect(response.warning).toContain("当前生成模型"); expect(response.warning).not.toContain("TYPESAFE"); expect(response.mode).toBe("rules");
    expect((await service.get({ userId: owner, workId })).cached).toBe(true);
    expect(dependencies.save).toHaveBeenCalledTimes(1);
  });
  it("discloses the exact analyzed subset and keeps remaining items as rules", async () => {
    const many = snapshot(); many.sources = Array.from({ length: 12 }, (_, i) => ({ ...structuredClone(many.sources[0]), item: { ...many.sources[0].item, id: `33333333-3333-4333-8333-${String(i).padStart(12, "0")}` } }));
    many.total = 15;
    const { service, dependencies } = fixture(many);
    dependencies.evaluate.mockImplementationOnce(async inputs => agentResult({ items: inputs.map(input => ({ ...agentResult().items[0], id: input.id })) }));
    const response = await service.generate({ userId: owner, workId, fingerprint: reviewAssistantFingerprint(many) });
    expect(response.coverage).toMatchObject({ total: 15, included: 12, analyzed: 8, hasMore: true });
    expect(response.items.filter(item => item.aiAssisted)).toHaveLength(8);
    expect(response.coverage.note).toContain("不包含独立的视频审核");
  });
  it("rejects legacy Jev cache and evaluator output even with the current source fingerprint", async () => {
    const { service, dependencies, current } = fixture();
    dependencies.cached.mockResolvedValueOnce({ generatedAt: new Date().toISOString(), result: result(), modelIdentity: "c".repeat(64) });
    expect((await service.get({ userId: owner, workId })).mode).toBe("rules");
    dependencies.evaluate.mockResolvedValueOnce(result());
    const response = await service.generate({ userId: owner, workId, fingerprint: reviewAssistantFingerprint(current) });
    expect(response.mode).toBe("rules"); expect(response.warning).toContain("完整性校验");
  });
  it("separates cached advice when the current model or endpoint identity changes", async () => {
    const { service, dependencies, current } = fixture();
    await service.generate({ userId: owner, workId, fingerprint: reviewAssistantFingerprint(current) });
    const configured = await dependencies.resolveModel();
    dependencies.resolveModel.mockResolvedValue({ ...configured, cacheIdentity: "d".repeat(64) });
    expect((await service.get({ userId: owner, workId })).mode).toBe("rules");
    expect(dependencies.cached).toHaveBeenLastCalledWith(owner, workId, reviewAssistantFingerprint(current), "d".repeat(64));
  });
  it("preserves source facts and fixed human review priority when direct advice proposes deferral", () => {
    for (const kind of ["agent_change_proposal", "loop_change_proposal", "permission_boundary"]) {
      const baseline = reviewAssistantBaseline(snapshot(kind));
      const advice = agentResult(); advice.items[0].suggestion = "defer"; advice.items[0].priority = "later";
      const item = applyReviewAssistantJudgments(baseline, advice, "now").items[0];
      expect(item.category).toBe("required"); expect(item.priority).toBe("first"); expect(item.prioritySource).toBe("rules");
      expect(item.suggestion).not.toBe("defer"); expect(item.knownFacts).toEqual(baseline.items[0].knownFacts);
      expect(item.evidence).toEqual(baseline.items[0].evidence); expect(item.what).toBe(baseline.items[0].what);
    }
  });
  it("keeps truncation and code-detected missing information despite an optimistic explanation", () => {
    const baseline = reviewAssistantBaseline(snapshot());
    const advice = agentResult(); advice.items[0].truncated = true; advice.items[0].suggestion = "defer";
    const item = applyReviewAssistantJudgments(baseline, advice, "now").items[0];
    expect(item.suggestion).toBe("need_evidence");
    expect(item.missingInfo).toEqual(expect.arrayContaining(baseline.items[0].missingInfo));
    expect(item.missingInfo.join(" ")).toContain("摘要未包含全部明细");
  });
});
