import { selectPlatformAnswerContract } from "./runtime/platform-answer-contract";
import { parsePlatformRequestedStateCounts } from "./runtime/platform-requested-state-counts";
import { canonicalPlatformStatisticSource, validatePlatformStatisticsProof } from "./platform-statistics-proof";
import { checkEvidenceTime, type EvidenceTimePolicy } from "@/lib/brain/evidence-time";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const statistics = (body: Record<string, unknown>) => record(body.statistics ?? record(body.data).statistics);
// Existing raw-state grammar sources, used only to retain unknown obligations
// when a historical or otherwise unsupported original request has no contract.
const stateSources = ["brain_memories.status", "interaction_processing_jobs.status", "interaction_events.processed_status",
  "paper_orders.status", "workshop_outbox.status", "workshop_heartbeats.scheduler_status", "loops.status", "workshops.status"];

/** Explicit values for the host's original request, independent of answer mode.
 * This projects an already-read complete live owner proof; it never reads data,
 * changes a source group, accepts model prose or chooses a business category. */
export function attachPlatformRequestedCounts<T>(result: T, input: {
  ownerId: string; originalQuestion: string; timePolicy: EvidenceTimePolicy;
}): T {
  const plan = selectPlatformAnswerContract(input.originalQuestion);
  const requests = plan?.kind === "stored_status_distribution" ? plan.requirements.filter(item => item.metricRequest)
    : !plan ? parsePlatformRequestedStateCounts(input.originalQuestion, stateSources).requirements : [];
  if (!requests.length) return result;
  // Reuse the actual contract residual instead of enumerating relative dates.
  // Consume only its recognized state-label syntax, then neutral count/source
  // presentation words. Literal values and the original requests remain intact.
  const grammarQuestion = parsePlatformRequestedStateCounts(input.originalQuestion, plan?.statisticSources ?? stateSources).grammarQuestion;
  const scopePlan = selectPlatformAnswerContract(grammarQuestion.replace(/总体|返回|数据来源/gu, ""));
  const unresolvedScope = !scopePlan || scopePlan.kind !== "stored_status_distribution" || Boolean(scopePlan.requestedSnapshotAt)
    || scopePlan.requirements.some(item => item.id === "unassessed_clause" || item.id === "source_lifecycle_history");
  const body = record(result), collection = statistics(body);
  if (!Object.keys(collection).length) return result;
  let visible = body;
  if (typeof body.text === "string") {
    try { visible = record(JSON.parse(body.text)); } catch { return result; }
  }
  const shown = statistics(visible);
  const members = Array.isArray(collection.results) ? collection.results : [];
  const shownMembers = Array.isArray(shown.results) ? shown.results : [];
  const requestedCounts = requests.map(requirement => {
    const request = requirement.metricRequest!;
    const base = { source: requirement.source, requestedLabel: request.requestedLabel, value: request.value };
    const candidates = members.flatMap(raw => {
      const member = record(raw);
      if (member.status !== "ok" || typeof member.source !== "string"
        || canonicalPlatformStatisticSource(member.source) !== requirement.source) return [];
      const check = validatePlatformStatisticsProof(member.scopeProof, {
        ownerId: input.ownerId, source: member.source, total: member.total, groups: member.groups,
      });
      if (!check.valid || !check.proof || check.proof.observation.kind !== "live"
        || typeof check.proof.observation.observedAt !== "string"
        || member.observedAt !== check.proof.observation.observedAt || !Array.isArray(member.groups)
        || !shownMembers.some(shownMember => JSON.stringify(shownMember) === JSON.stringify(raw))) return [];
      const observedAt = check.proof.observation.observedAt;
      return [{ proofId: check.proof.proofId, observedAt,
        groups: member.groups as Array<{ value: unknown; count: number }> }];
    }).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
    const selected = candidates[0];
    const timeEligible = selected && checkEvidenceTime(selected.proofId, { kind: "live", observedAt: selected.observedAt }, input.timePolicy).state === "eligible";
    if (!plan || unresolvedScope || !selected || !timeEligible || candidates.some(item => item.observedAt === selected.observedAt && item.proofId !== selected.proofId)) {
      return { ...base, status: "unknown" as const, count: null, proofId: null, observedAt: null,
        reason: input.timePolicy.mode === "as_of" || input.timePolicy.mode === "unresolved" || selected && !timeEligible
          ? "requested_time_proof_unavailable" : !plan ? "original_request_contract_unavailable"
            : unresolvedScope ? "original_request_scope_unresolved" : "complete_owner_scope_proof_unavailable" };
    }
    const group = selected.groups.find(item => typeof item.value === typeof request.value && item.value === request.value);
    return { ...base, status: "supported" as const, count: group?.count ?? 0,
      proofId: selected.proofId, observedAt: selected.observedAt,
      reason: group ? "matching_source_dimension_value" : "absent_dimension_value_in_complete_query" };
  });
  const projection = { requestedCountsVersion: "platform-requested-counts.v1", requestedCounts };
  const attach = (target: Record<string, unknown>) => Object.hasOwn(body, "statistics")
    ? { ...target, statistics: { ...statistics(target), ...projection } }
    : { ...target, data: { ...record(target.data), statistics: { ...statistics(target), ...projection } } };
  const updated = attach(body);
  return { ...updated, ...(typeof body.text === "string" ? { text: JSON.stringify(attach(visible)) } : {}) } as T;
}
