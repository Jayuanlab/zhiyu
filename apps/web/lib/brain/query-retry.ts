import type { BrainRecallPlan } from "./recall-planner";
import type { BrainContextPack } from "./context";
import { checkRecallEvidence, type EvidenceCheck } from "./jev-evidence-check";
import { buildAnswerRequirements, type AnswerRequirements } from "./answer-requirements";
import { checkEvidenceTime, inferEvidenceTimePolicy, type EvidenceTimePolicy, type EvidenceTimeCheck } from "./evidence-time";

export type RecallRetryTrace = {
  originalQuery: string;
  rewrittenQuery?: string;
  reason?: string;
  attempts: 1 | 2;
  stopReason: string;
  contextLogIds: string[];
  evidenceCheck?: EvidenceCheck;
  answerRequirements?: AnswerRequirements;
  evidenceTime?: { policy: EvidenceTimePolicy; checks: EvidenceTimeCheck[] };
};

type RecallResult = BrainContextPack & {
  routeResults: Array<{ status: string; count: number }>;
};

/** Empty means no useful or filtered candidates, not merely a low result count. */
export function recallRetryStopReason(result: RecallResult): string | undefined {
  if (result.routeResults.some(route => ["failed", "degraded", "skipped"].includes(route.status))) return "source_unavailable";
  if (result.items.length || result.routeResults.some(route => route.count > 0)) return "results_available";
  if (result.denied.length) return "access_denied";
  if (result.omitted.length) return "candidates_filtered";
  if (result.warnings?.length) return "context_warning";
  return undefined;
}

export async function runBoundedRecall<T extends RecallResult>(input: {
  originalQuery: string;
  plan: BrainRecallPlan;
  enabled: boolean;
  run: (plan: BrainRecallPlan, query: string) => Promise<T>;
  checkEvidence?: typeof checkRecallEvidence;
  selectMissingInformationRetry?: (result: T) => BrainRecallPlan['queryRetry'];
}): Promise<{ result: T; trace: RecallRetryTrace }> {
  const first = await input.run(input.plan, input.originalQuery);
  // Never let semantic judgments override permission/filter/source failures.
  const blocked = first.denied.length ? "access_denied" : first.omitted.length ? "candidates_filtered"
    : first.warnings?.length ? "context_warning"
    : first.routeResults.some(route => ["failed", "degraded", "skipped"].includes(route.status)) ? "source_unavailable" : undefined;
  const answerRequirements = buildAnswerRequirements(input.originalQuery);
  const timePolicy = inferEvidenceTimePolicy(input.originalQuery);
  const evidence = first.items.map(item => ({ id: item.id, observation: { kind: "memory" as const, observedAt: item.freshness?.updatedAt }, content: JSON.stringify({ subject: item.subject, content: item.content, freshness: item.freshness, evidenceRefs: item.evidenceRefs }) }));
  const evidenceCheck = await (input.checkEvidence ?? checkRecallEvidence)({
    question: input.originalQuery, blocked, requirementsPlan: answerRequirements, timePolicy, evidence,
  });
  const trace: RecallRetryTrace = {
    originalQuery: input.originalQuery, attempts: 1,
    stopReason: blocked ?? recallRetryStopReason(first) ?? "no_alternative",
    contextLogIds: first.contextLogId ? [first.contextLogId] : [],
    evidenceCheck,
    answerRequirements,
    evidenceTime: { policy: timePolicy, checks: evidence.map(item => checkEvidenceTime(item.id, item.observation, timePolicy)) },
  };
  const insufficient = !blocked && evidenceCheck.mode === "active" && evidenceCheck.status === "ok"
    && !evidenceCheck.truncated && evidenceCheck.coverage?.some(item => item.support < 0.65);
  const missingInformationRetry = input.enabled && !blocked
    ? input.selectMissingInformationRetry?.(first) : undefined;
  const alternative = missingInformationRetry ?? input.plan.queryRetry;
  const preservePartial = insufficient || Boolean(missingInformationRetry);
  if (!input.enabled) trace.stopReason = "disabled";
  if (!input.enabled || (recallRetryStopReason(first) && !preservePartial) || !alternative) return { result: first, trace };
  const terms = [...new Set([...input.plan.searchTerms, ...alternative.searchTerms])];
  if (!alternative.searchTerms.some(term => !input.plan.searchTerms.includes(term))) {
    trace.stopReason = "unchanged_terms";
    return { result: first, trace };
  }
  trace.rewrittenQuery = alternative.query;
  trace.reason = alternative.reason;
  trace.attempts = 2;
  try {
    // Only lexical terms change. All scope, time, status, confidence and source constraints survive.
    const second = await input.run({ ...input.plan, searchTerms: terms, queryRetry: undefined }, alternative.query);
    if (second.contextLogId) trace.contextLogIds.push(second.contextLogId);
    trace.stopReason = recallRetryStopReason(second) ?? "empty_after_retry";
    if (preservePartial && first.items.length) {
      // Preserve the first snapshot rather than replacing useful partial evidence.
      // Denied/filtered IDs from either attempt remain excluded from the union.
      const excluded = new Set([...first.denied, ...second.denied, ...first.omitted, ...second.omitted].map(item => item.id));
      const items = [...new Map([...first.items, ...second.items].map(item => [item.id, item])).values()].filter(item => !excluded.has(item.id));
      const selectedCanonicalKinds: BrainContextPack["selection"]["selectedCanonicalKinds"] = {};
      for (const item of items) if (item.canonicalKind) selectedCanonicalKinds[item.canonicalKind] = (selectedCanonicalKinds[item.canonicalKind] ?? 0) + 1;
      const denied = [...first.denied, ...second.denied];
      const omitted = [...first.omitted, ...second.omitted];
      trace.stopReason = second.routeResults.some(route => ["failed", "degraded", "skipped"].includes(route.status))
        ? "coverage_retry_degraded" : "coverage_retry_complete";
      return { result: { ...second, items, denied, omitted,
        warnings: [...(first.warnings ?? []), ...(second.warnings ?? [])],
        routeResults: [...first.routeResults, ...second.routeResults],
        selection: { ...second.selection, selectedCount: items.length, deniedCount: denied.length, omittedCount: omitted.length, selectedCanonicalKinds },
      }, trace };
    }
    return { result: second, trace };
  } catch {
    trace.stopReason = "retry_failed";
    return { result: first, trace };
  }
}
