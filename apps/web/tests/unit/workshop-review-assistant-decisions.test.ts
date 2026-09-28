import { describe, expect, it } from "vitest";
import { planReviewAssistantDecisions } from "@/lib/workshops/review-assistant-decisions";
import { reviewAssistantBaseline, applyReviewAssistantJudgments, type ReviewAssistantSnapshot } from "@/lib/workshops/review-assistant-service";
import type { ReviewAssistantModelResult } from "@/lib/workshops/review-assistant-model";

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
});
