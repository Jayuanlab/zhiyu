import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { withWorkshopEventTransaction } from "./event-write";
import { getWorkshop } from "./service";
import { ReviewAssistantError, loadReviewAssistantSnapshot, reviewAssistantFingerprint, isReviewAssistantAnalysisBound, type ReviewAssistantSnapshot } from "./review-assistant-service";
import type { ReviewAssistantDecision, ReviewAssistantResponse } from "./review-assistant";
import { REVIEW_ASSISTANT_AGENT_SCHEMA, type ReviewAssistantEvaluation } from "./review-assistant-model";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function date(value: unknown) { return new Date(String(value)).toISOString(); }

/** The model proposes advice; only this bounded policy and independent facts can close a review. */
export function planReviewAssistantDecisions(snapshot: ReviewAssistantSnapshot, response: ReviewAssistantResponse, result: ReviewAssistantEvaluation): ReviewAssistantDecision[] {
  if (result.status !== "ok" || response.mode !== "ai" || response.fingerprint !== reviewAssistantFingerprint(snapshot)) return [];
  if (result.schemaVersion === REVIEW_ASSISTANT_AGENT_SCHEMA && !isReviewAssistantAnalysisBound(response, result)) return [];
  return result.items.flatMap(judgment => {
    const item = response.items.find(candidate => candidate.id === judgment.id);
    const source = snapshot.sources.find(candidate => candidate.item.id === judgment.id);
    if (!item || !source) return [];
    const p = "probabilities" in judgment ? judgment.probabilities : null;
    const sample = snapshot.workObservations;
    const memoryQuiet = item.kind === "memory_recall_quality" && sample && sample.sampleCount > 0 &&
      sample.warningCount === 0 && sample.noEvidenceSelectedCount === 0 && sample.duplicateOmittedCount === 0 &&
      (record(source.item.metadata).source === "memory_recall_quality_report" || record(record(source.item.metadata).observationScope).includesOtherWorkshops === true);
    // A generated explanation cannot establish report completeness. Current advice
    // may close only the existing memory case supported by independent Work observations.
    const reportComplete = p && item.kind === "report_quality_config_proposal" && !item.missingInfo.length && p.sufficientEvidence >= 0.8;
    const mayClose = item.category === "optional" && item.suggestion === "defer" &&
      (p !== null || ("suggestion" in judgment && judgment.suggestion === "defer")) && !judgment.truncated &&
      item.riskLevel !== "high" && record(source.item.metadata).destructive !== true &&
      (!p || (p.currentImpact <= 0.2 && p.significantSideEffects <= 0.2)) && !snapshot.observationWarning &&
      Boolean(memoryQuiet || reportComplete);
    const outcome: ReviewAssistantDecision["outcome"] = mayClose ? "closed_for_now" :
      item.category === "required" || item.priority === "first" ? "owner_review" : "investigate";
    return [{ itemId: item.id, title: item.title, outcome,
      reason: mayClose ? "AI 决定本车间暂不跟进这条可选事项；原记录和判断依据保留，后续出现新事实可恢复核查。" : item.reason,
      knownFacts: item.knownFacts ?? [], evidence: item.evidence, missingInfo: item.missingInfo,
      sourceUpdatedAt: item.sourceUpdatedAt, sourceEventId: item.sourceEventId,
      applied: mayClose }];
  });
}

export async function getReviewAssistantDecisions(userId: string, workId: string): Promise<ReviewAssistantDecision[]> {
  if (!uuid.test(workId) || !uuid.test(userId)) throw new ReviewAssistantError("invalid_request", 400);
  if (!await getWorkshop(userId, workId)) throw new ReviewAssistantError("not_found", 404);
  const rows = await db.execute(sql`SELECT id, created_at, metadata FROM workshop_events
    WHERE workshop_id=${workId}::uuid AND type='review_assistant_decisions_recorded'
      AND metadata->>'actorId'=${userId} AND metadata->>'source'='review_assistant_decision'
    ORDER BY seq DESC LIMIT 8`) as Array<{ id: string; created_at: unknown; metadata: unknown }>;
  const seen = new Set<string>();
  const decisions = rows.flatMap(row => {
    const meta = record(row.metadata);
    return (Array.isArray(meta.decisions) ? meta.decisions : []).flatMap(value => {
      const decision = record(value);
      if (typeof decision.itemId !== "string" || seen.has(decision.itemId) ||
        !["closed_for_now", "owner_review", "investigate"].includes(String(decision.outcome))) return [];
      seen.add(decision.itemId);
      return [{ ...decision, decisionEventId: row.id, decidedAt: date(row.created_at) } as ReviewAssistantDecision];
    });
  }).slice(0, 24);
  if (!decisions.length) return [];
  const statusRows = await db.execute(sql`SELECT id, status, metadata FROM workshop_review_items
    WHERE workshop_id=${workId}::uuid`) as Array<{ id: string; status: string; metadata: unknown }>;
  const statusById = new Map(statusRows.map(row => [row.id, row]));
  return decisions.map(decision => {
    const row = statusById.get(decision.itemId);
    const resolution = record(record(row?.metadata).resolution);
    return { ...decision, applied: Boolean(decision.applied && row?.status === "dismissed" && resolution.decisionEventId === decision.decisionEventId) };
  });
}

export async function applyReviewAssistantDecisions(input: {
  userId: string; workId: string; fingerprint: string;
  response: ReviewAssistantResponse; result: ReviewAssistantEvaluation;
}) {
  if (input.result.schemaVersion !== REVIEW_ASSISTANT_AGENT_SCHEMA) throw new ReviewAssistantError("invalid_request", 400);
  const result = input.result;
  if (!isReviewAssistantAnalysisBound(input.response, result)) throw new ReviewAssistantError("source_changed", 409);
  const snapshot = await loadReviewAssistantSnapshot(input.userId, input.workId);
  if (reviewAssistantFingerprint(snapshot) !== input.fingerprint || input.response.fingerprint !== input.fingerprint) throw new ReviewAssistantError("source_changed", 409);
  const decisions = planReviewAssistantDecisions(snapshot, input.response, input.result);
  if (!decisions.length) return [];
  return withWorkshopEventTransaction(async (tx, append) => {
    const owned = await tx.execute(sql`SELECT id FROM workshops WHERE id=${input.workId}::uuid AND user_id=${input.userId}::uuid FOR UPDATE`);
    if (!owned[0]) throw new ReviewAssistantError("not_found", 404);
    const previous = await tx.execute(sql`SELECT id, created_at, metadata FROM workshop_events
      WHERE workshop_id=${input.workId}::uuid AND type='review_assistant_decisions_recorded'
        AND metadata->>'fingerprint'=${input.fingerprint} AND metadata->>'actorId'=${input.userId}
      ORDER BY seq DESC LIMIT 1`);
    if (previous[0]) return (Array.isArray(record(previous[0].metadata).decisions) ? record(previous[0].metadata).decisions : []) as ReviewAssistantDecision[];
    const rows = await tx.execute(sql`SELECT id, status, updated_at, metadata FROM workshop_review_items
      WHERE workshop_id=${input.workId}::uuid ORDER BY id FOR UPDATE`) as Array<{ id: string; status: string; updated_at: unknown; metadata: unknown }>;
    for (const decision of decisions) {
      const row = rows.find(value => value.id === decision.itemId);
      if (!row || row.status !== "pending" || date(row.updated_at) !== decision.sourceUpdatedAt) throw new ReviewAssistantError("source_changed", 409);
    }
    const event = await append({ workshopId: input.workId, type: "review_assistant_decisions_recorded",
      title: "AI 已作出待办处理决定", visibility: "user",
      body: `本次判断 ${decisions.length} 项，暂不跟进 ${decisions.filter(value => value.applied).length} 项；具体依据见每项记录。`,
      metadata: { source: "review_assistant_decision", actorId: input.userId, fingerprint: input.fingerprint,
        model: result.model, provider: result.provider, schemaVersion: result.schemaVersion, modelInputHash: result.inputHash,
        analysis: input.response.analysis,
        decisions: decisions.map(value => ({ ...value, advice: result.items.find(item => item.id === value.itemId) })) },
    });
    for (const decision of decisions.filter(value => value.applied)) {
      const row = rows.find(value => value.id === decision.itemId)!;
      const metadata = record(row.metadata);
      const resolution = { status: "dismissed", source: "review_assistant_decision", reason: decision.reason,
        decisionEventId: event.id, sourceFingerprint: input.fingerprint, resolvedAt: new Date().toISOString() };
      await tx.execute(sql`UPDATE workshop_review_items SET status='dismissed', resolved_at=now(), updated_at=now(),
        metadata=${JSON.stringify({ ...metadata, resolution, resolvedReviewItemId: decision.itemId })}::jsonb
        WHERE workshop_id=${input.workId}::uuid AND id=${decision.itemId}::uuid AND status='pending'`);
    }
    return decisions.map(value => ({ ...value, decisionEventId: event.id, decidedAt: date(event.createdAt) }));
  });
}

export async function restoreReviewAssistantDecision(input: { userId: string; workId: string; itemId: string; decisionEventId: string }) {
  if (![input.userId, input.workId, input.itemId, input.decisionEventId].every(value => uuid.test(value))) throw new ReviewAssistantError("invalid_request", 400);
  return withWorkshopEventTransaction(async (tx, append) => {
    const owned = await tx.execute(sql`SELECT id FROM workshops WHERE id=${input.workId}::uuid AND user_id=${input.userId}::uuid FOR UPDATE`);
    if (!owned[0]) throw new ReviewAssistantError("not_found", 404);
    const rows = await tx.execute(sql`SELECT id, status, metadata FROM workshop_review_items
      WHERE workshop_id=${input.workId}::uuid AND id=${input.itemId}::uuid FOR UPDATE`);
    const row = rows[0];
    if (!row) throw new ReviewAssistantError("not_found", 404);
    const metadata = record(row.metadata);
    const resolution = record(metadata.resolution);
    if (row.status === "pending" && metadata.restoredFromDecisionEventId === input.decisionEventId) return { restored: true, itemId: input.itemId };
    if (row.status !== "dismissed" || resolution.source !== "review_assistant_decision" || resolution.decisionEventId !== input.decisionEventId) throw new ReviewAssistantError("source_changed", 409);
    const restoredMetadata = { ...metadata, previousResolution: resolution, resolution: null, restoredFromDecisionEventId: input.decisionEventId };
    await tx.execute(sql`UPDATE workshop_review_items SET status='pending', resolved_at=NULL, updated_at=now(),
      metadata=${JSON.stringify(restoredMetadata)}::jsonb WHERE workshop_id=${input.workId}::uuid AND id=${input.itemId}::uuid`);
    await append({ workshopId: input.workId, type: "review_assistant_decision_restored", title: "已恢复待办供重新处理",
      visibility: "user", metadata: { source: "review_assistant_decision", actorId: input.userId,
        itemId: input.itemId, decisionEventId: input.decisionEventId } });
    return { restored: true, itemId: input.itemId };
  });
}
