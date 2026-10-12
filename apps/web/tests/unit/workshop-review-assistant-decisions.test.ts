import { describe, expect, it } from "vitest";
import { planReviewAssistantDecisions, applyReviewAssistantDecisions } from "@/lib/workshops/review-assistant-decisions";
import { reviewAssistantBaseline, applyReviewAssistantJudgments, type ReviewAssistantSnapshot } from "@/lib/workshops/review-assistant-service";
import { REVIEW_ASSISTANT_AGENT_SCHEMA, type ReviewAssistantModelResult, type ReviewAssistantAgentResult } from "@/lib/workshops/review-assistant-model";

const workId = "22222222-2222-4222-8222-222222222222";
const userId = "11111111-1111-4111-8111-111111111111";
const itemId = "33333333-3333-4333-8333-333333333333";
const updatedAt = "2026-09-26T09:37:00.920Z";
function snapshot(kind = "memory_recall_quality"): ReviewAssistantSnapshot {
  return { workshop: { id: workId, userId, name: "清洗专员", mission: "清洗文档" } as ReviewAssistantSnapshot["workshop"],
    total: 1, pendingUpdatedAt: updatedAt,
    sources: [{ item: { id: itemId, kind, title: "Original review", summary: "Review recall logs", riskLevel: "medium",
      updatedAt, metadata: { source: "memory_recall_quality_report", issueKind: "trace_warnings", issueCount: 3 } }, event: null }],
    workObservations: { windowDays: 7, sampleCount: 5, firstEventAt: updatedAt, lastEventAt: updatedAt,
      eventIds: [], warningCount: 0, noEvidenceSelectedCount: 0, duplicateOmittedCount: 0 } };
}
function judgment(): ReviewAssistantModelResult {
  return { status: "ok", model: "jev-1.13.0", schemaVersion: "review-assistant-atomic.v2",
    thresholds: { select: 0.8, exclude: 0.2 }, inputHash: "a".repeat(64), elapsedMs: 1,
    items: [{ id: itemId, truncated: false, probabilities: {
      currentImpact: 0.14, concreteBenefit: 0.21, sufficientEvidence: 0.56, significantSideEffects: 0.07 } }] };
}
function advice(): ReviewAssistantAgentResult {
  return { status: "ok", provider: "fixture-main", model: "fixture-model", schemaVersion: REVIEW_ASSISTANT_AGENT_SCHEMA,
    inputHash: "a".repeat(64), elapsedMs: 1,
    items: [{ id: itemId, truncated: false, suggestion: "defer", priority: "later", reason: "当前车间抽样未观察到对应告警，历史记录保留供后续核查。", missingInfo: [] }] };
}
describe("AI direct review decisions", () => {
  it("closes only a low-impact optional historical signal with a quiet current Work sample and retains evidence", () => {
    const source = snapshot(); const result = judgment();
    const response = applyReviewAssistantJudgments(reviewAssistantBaseline(source), result, updatedAt);
    const [decision] = planReviewAssistantDecisions(source, response, result);
    expect(decision).toMatchObject({ itemId, outcome: "closed_for_now", applied: true, sourceUpdatedAt: updatedAt });
    expect(decision.knownFacts.join(" ")).toContain("跨智能体");
    expect(decision.missingInfo.join(" ")).toContain("统计起止时间");
  });
  it("keeps configuration decisions with the owner even when the model rates current impact low", () => {
    const source = snapshot("agent_change_proposal"); const result = judgment();
    const response = applyReviewAssistantJudgments(reviewAssistantBaseline(source), result, updatedAt);
    expect(planReviewAssistantDecisions(source, response, result)).toMatchObject([{ outcome: "owner_review", applied: false }]);
  });
  it("does not close a memory issue when current Work observations are unknown or indicate an issue", () => {
    for (const observed of [null, 1]) {
      const source = snapshot();
      if (observed === null) source.workObservations = null;
      else source.workObservations!.warningCount = observed;
      const result = judgment();
      const response = applyReviewAssistantJudgments(reviewAssistantBaseline(source), result, updatedAt);
      expect(planReviewAssistantDecisions(source, response, result)[0].applied).toBe(false);
    }
  });
  it("retains reversible quiet-memory closure with direct advice and independent current Work facts", () => {
    const source = snapshot(); const result = advice();
    const response = applyReviewAssistantJudgments(reviewAssistantBaseline(source), result, updatedAt);
    expect(planReviewAssistantDecisions(source, response, result)).toMatchObject([{ itemId, outcome: "closed_for_now", applied: true, sourceUpdatedAt: updatedAt }]);
  });
  it("never treats the generated deferral or completeness explanation as independent closing evidence", () => {
    const cases = [
      (source: ReviewAssistantSnapshot) => { source.workObservations = null; },
      (source: ReviewAssistantSnapshot) => { source.workObservations!.sampleCount = 0; },
      (source: ReviewAssistantSnapshot) => { source.workObservations!.warningCount = 1; },
      (source: ReviewAssistantSnapshot) => { source.workObservations!.noEvidenceSelectedCount = null; },
      (source: ReviewAssistantSnapshot) => { source.workObservations!.duplicateOmittedCount = 1; },
      (source: ReviewAssistantSnapshot) => { source.observationWarning = "observation unavailable"; },
      (source: ReviewAssistantSnapshot) => { source.sources[0].item.riskLevel = "high"; },
      (source: ReviewAssistantSnapshot) => { (source.sources[0].item.metadata as Record<string, unknown>).destructive = true; },
      (source: ReviewAssistantSnapshot) => { source.sources[0].item.metadata = {}; },
    ];
    for (const change of cases) {
      const source = snapshot(); change(source); const result = advice();
      const response = applyReviewAssistantJudgments(reviewAssistantBaseline(source), result, updatedAt);
      expect(planReviewAssistantDecisions(source, response, result)[0].applied).toBe(false);
    }
    const report = snapshot("report_quality_config_proposal"); const result = advice();
    const response = applyReviewAssistantJudgments(reviewAssistantBaseline(report), result, updatedAt);
    response.items[0].missingInfo = [];
    expect(planReviewAssistantDecisions(report, response, result)[0].applied).toBe(false);
  });
  it("keeps mandatory approvals, truncated input and changed source fingerprints out of automatic closure", () => {
    const required = snapshot("permission_boundary"); const result = advice();
    const response = applyReviewAssistantJudgments(reviewAssistantBaseline(required), result, updatedAt);
    expect(planReviewAssistantDecisions(required, response, result)[0]).toMatchObject({ outcome: "owner_review", applied: false });
    const source = snapshot(); result.items[0].truncated = true;
    expect(planReviewAssistantDecisions(source, applyReviewAssistantJudgments(reviewAssistantBaseline(source), result, updatedAt), result)[0].applied).toBe(false);
    const before = reviewAssistantBaseline(source); source.sources[0].item.summary = "changed source";
    expect(planReviewAssistantDecisions(source, { ...before, mode: "ai" }, advice())).toEqual([]);
  });
  it("rejects legacy Jev results before any current action authority", async () => {
    const source = snapshot(); const result = judgment();
    const response = applyReviewAssistantJudgments(reviewAssistantBaseline(source), result, updatedAt);
    await expect(applyReviewAssistantDecisions({ userId, workId, fingerprint: response.fingerprint, response, result })).rejects.toMatchObject({ code: "invalid_request", status: 400 });
  });
  it("rejects a later cache result mixed with the earlier generated response under the same source fingerprint", async () => {
    const source = snapshot(); const generated = advice();
    const response = applyReviewAssistantJudgments(reviewAssistantBaseline(source), generated, updatedAt);
    const later = structuredClone(generated);
    later.model = "later-main-model";
    later.items[0].suggestion = "need_evidence";
    expect(planReviewAssistantDecisions(source, response, later)).toEqual([]);
    await expect(applyReviewAssistantDecisions({ userId, workId, fingerprint: response.fingerprint, response, result: later })).rejects.toMatchObject({ code: "source_changed", status: 409 });
    later.model = generated.model;
    expect(planReviewAssistantDecisions(source, response, later)).toEqual([]);
    await expect(applyReviewAssistantDecisions({ userId, workId, fingerprint: response.fingerprint, response, result: later })).rejects.toMatchObject({ code: "source_changed", status: 409 });
    later.items[0].suggestion = "defer"; later.items[0].reason = "A later generation with a different explanation";
    expect(planReviewAssistantDecisions(source, response, later)).toEqual([]);
    expect(planReviewAssistantDecisions(source, response, structuredClone(generated))[0].applied).toBe(true);
  });
  it("requires deferral in the current generated judgment even if a response item was changed to defer", () => {
    const source = snapshot(); const result = advice(); result.items[0].suggestion = "need_evidence";
    const response = applyReviewAssistantJudgments(reviewAssistantBaseline(source), result, updatedAt);
    response.items[0].suggestion = "defer";
    expect(planReviewAssistantDecisions(source, response, result)[0].applied).toBe(false);
  });
});
