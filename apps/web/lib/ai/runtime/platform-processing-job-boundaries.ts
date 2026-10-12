import {
  INTERACTION_PROCESSING_JOB_CLAIMABLE_STATUSES,
  INTERACTION_PROCESSING_JOB_CLAIM_POLICY_VERSION,
} from "@/lib/interactions/processing-job-policy";
import type { PlatformMetricFact } from "./platform-answer-contract";

export const PLATFORM_PROCESSING_JOB_STATUS_SOURCE = "interaction_processing_jobs.status";
type BoundaryUnavailable = { state: "unknown" | "denied"; reason: string };
export type ProcessingJobWaitingBranch = {
  status: "pending" | "resume_pending" | "needs_review";
  count: number;
  definition: string;
  countReason: "observed_group" | "absent_group_in_complete_query";
};
export type ProcessingJobBoundaryBinding = {
  source: typeof PLATFORM_PROCESSING_JOB_STATUS_SOURCE;
  scope: "owner_stored_status";
  proofId: string;
  observedAt: string;
  policyVersion: typeof INTERACTION_PROCESSING_JOB_CLAIM_POLICY_VERSION;
  policyModule: "apps/web/lib/interactions/processing-job-policy.ts";
  policyFunctions: readonly ["claimInteractionProcessingJob", "listRunnableInteractionProcessingJobs"];
  necessaryStatuses: typeof INTERACTION_PROCESSING_JOB_CLAIMABLE_STATUSES;
  rawGroups: ReadonlyArray<{ value: string | number | boolean | null; count: number }>;
};
export type ProcessingJobBoundaryResult = {
  waiting: BoundaryUnavailable | {
    state: "conditional";
    reason: "waiting_has_multiple_feature_definitions";
    branches: ProcessingJobWaitingBranch[];
  };
  runnable: BoundaryUnavailable | {
    state: "supported";
    count: 0;
    reason: "fixed_service_necessary_status_empty";
  };
  binding?: ProcessingJobBoundaryBinding;
};

const waitingDefinitions = [
  { status: "pending", definition: "初次排队的 pending 原始状态；不代表全部业务等待或此刻可领取。" },
  { status: "resume_pending", definition: "经审核按原计划恢复后排队，界面称等待按原计划恢复或等待后台领取。" },
  { status: "needs_review", definition: "等待人工核对的理解作业，暂停自动重试；不是后台可领取状态。" },
] as const;

function unavailable(reason: string, state: "unknown" | "denied" = "unknown"): ProcessingJobBoundaryResult {
  return { waiting: { state, reason }, runnable: { state, reason } };
}
function validMetric(metric: PlatformMetricFact): boolean {
  if (!metric || metric.kind !== "metric" || metric.source !== PLATFORM_PROCESSING_JOB_STATUS_SOURCE || metric.scope !== "owner_stored_status"
    || !/^[a-f0-9]{64}$/u.test(metric.proofId ?? "") || !Number.isSafeInteger(metric.total) || metric.total < 0
    || !/^\d{4}-\d{2}-\d{2}T/u.test(metric.observedAt ?? "") || !Number.isFinite(Date.parse(metric.observedAt))
    || !["live", "snapshot"].includes(metric.observation?.kind) || metric.observation?.observedAt !== metric.observedAt
    || !Array.isArray(metric.groups)) return false;
  const values = new Set<string>();
  let sum = 0;
  for (const group of metric.groups) {
    if (!group || !Number.isSafeInteger(group.count) || group.count < 0) return false;
    const value = group.value;
    if (!(value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value))) return false;
    const key = JSON.stringify([typeof value, value]);
    if (values.has(key)) return false;
    values.add(key);
    sum += group.count;
    if (!Number.isSafeInteger(sum)) return false;
  }
  return sum === metric.total;
}

/**
 * Accept only host-validated PlatformMetricFacts whose authorization, original
 * question time and snapshot checks remain eligible in the renderer. A proofId
 * in arbitrary model JSON is not validation. This adds a necessary-set boundary,
 * never a new SQL population or a unique definition of natural-language waiting.
 */
export function derivePlatformProcessingJobBoundaries(input: {
  metrics: readonly PlatformMetricFact[];
  contextState: "eligible" | "denied" | "unavailable" | "snapshot_mismatch";
}): ProcessingJobBoundaryResult {
  if (input.contextState === "denied") return unavailable("permission_denied", "denied");
  if (input.contextState !== "eligible") return unavailable(input.contextState === "snapshot_mismatch" ? "requested_snapshot_not_matched" : "runtime_not_completed");
  if (!Array.isArray(input.metrics) || !input.metrics.length) return unavailable("complete_owner_scope_proof_unavailable");
  if (input.metrics.some(metric => !validMetric(metric))) return unavailable("processing_job_metric_binding_invalid");
  const sorted = [...input.metrics].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  const selected = sorted[0];
  const selectedContent = JSON.stringify({ total: selected.total, groups: selected.groups, observation: selected.observation });
  if (sorted.some(metric => metric.observedAt === selected.observedAt
    && (metric.proofId !== selected.proofId || JSON.stringify({ total: metric.total, groups: metric.groups, observation: metric.observation }) !== selectedContent))) {
    return unavailable("processing_job_metric_conflict");
  }
  // validMetric requires complete, count-conserving groups. Keep unknown varchar
  // labels and NULL in the binding rather than converting the table to an enum.
  const groups: NonNullable<PlatformMetricFact["groups"]> = selected.groups!;
  const count = (status: string) => groups.find(group => group.value === status)?.count ?? 0;
  const binding: ProcessingJobBoundaryBinding = {
    source: PLATFORM_PROCESSING_JOB_STATUS_SOURCE, scope: "owner_stored_status", proofId: selected.proofId, observedAt: selected.observedAt,
    policyVersion: INTERACTION_PROCESSING_JOB_CLAIM_POLICY_VERSION, policyModule: "apps/web/lib/interactions/processing-job-policy.ts",
    policyFunctions: ["claimInteractionProcessingJob", "listRunnableInteractionProcessingJobs"],
    necessaryStatuses: INTERACTION_PROCESSING_JOB_CLAIMABLE_STATUSES, rawGroups: groups.map(group => ({ ...group })),
  };
  return {
    binding,
    waiting: { state: "conditional", reason: "waiting_has_multiple_feature_definitions", branches: waitingDefinitions.map(({ status, definition }) => ({
      status, definition, count: count(status), countReason: groups.some(group => group.value === status) ? "observed_group" : "absent_group_in_complete_query",
    })) },
    runnable: INTERACTION_PROCESSING_JOB_CLAIMABLE_STATUSES.every(status => count(status) === 0)
      ? { state: "supported", count: 0, reason: "fixed_service_necessary_status_empty" }
      : { state: "unknown", reason: "runnable_schedule_and_attempts_required" },
  };
}
