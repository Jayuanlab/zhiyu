import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { workshops } from "@/lib/db/schema";
import { deriveLoopDashboardStatus } from "@/lib/loops/dashboard";
import type { Loop, LoopState } from "@/lib/db/schema";
import type { LoopRunDashboardSummary } from "@/lib/loops/dashboard";

export const WORK_STATUS_PROJECTION_VERSION = "work-status.v1";
export const OUTBOX_ATTENTION_STATUSES = ["draft", "previewed", "pending", "needs_approval", "pending_approval", "approved", "blocked", "sending", "unknown"];

export function workStatusFromCounts(status: string, counts: {errorLoops: number; blockedLoops: number; pendingApprovals: number; outboxBlocked?: number; outboxUnknown?:number}, heartbeatError = false) {
  if (status === "archived") return "archived" as const;
  if (status !== "active") return "paused" as const;
  if (heartbeatError || counts.errorLoops > 0) return "error" as const;
  if (counts.pendingApprovals > 0) return "needs_approval" as const;
  if (counts.blockedLoops > 0 || (counts.outboxBlocked ?? 0) > 0 || (counts.outboxUnknown??0)>0) return "blocked" as const;
  return "active" as const;
}

export function classifyOutbox(item: { status: string; boundaryResult?: unknown }) {
  if(item.status==='sending'||item.status==='unknown')return item.status;
  if (["pending_approval", "needs_approval"].includes(item.status)) return "approval";
  if (item.status === "blocked") return "blocked";
  if (item.status === "approved") return "ready";
  const boundary = item.boundaryResult as Record<string, unknown> | null;
  if (boundary?.source === "loop_suggested_action") return null;
  return ["draft", "previewed", "pending"].includes(item.status) ? "draft" : null;
}

export function isPendingLoopActivation(state: Record<string, unknown>) {
  return state.requiresOwnerActivation === true &&
    (state.ownerActivationStatus === undefined || state.ownerActivationStatus === "pending");
}

type LoopFact = {
  status: string;
  stateJson: Record<string, unknown>;
  currentPhase: string | null;
  run: null | {
    id: string; status: string; startedAt: string; completedAt: string | null;
    requiresApproval: boolean; actionGuardBlocked: boolean;
  };
};
type OutboxGroup = { status: string; source: string | null; count: number };

export function countWorkStatus(facts: LoopFact[], outbox: OutboxGroup[]) {
  const counts = { loops: facts.length, activeLoops: 0, pendingLoopProposals: 0,
    pendingApprovals: 0, pendingOutbox: 0, blockedLoops: 0, errorLoops: 0,
    outboxDrafts: 0, outboxReady: 0, outboxBlocked: 0, outboxApprovals: 0, outboxSending:0, outboxUnknown:0, attentionCount: 0 };
  for (const fact of facts) {
    if (fact.status === "active") counts.activeLoops++;
    if (isPendingLoopActivation(fact.stateJson)) counts.pendingLoopProposals++;
    const status = deriveLoopDashboardStatus({
      loop: { status: fact.status } as Loop,
      state: { stateJson: fact.stateJson, currentPhase: fact.currentPhase } as LoopState,
      latestRun: fact.run as unknown as LoopRunDashboardSummary | null,
    });
    if (status === "needs_approval") counts.pendingApprovals++;
    if (status === "blocked") counts.blockedLoops++;
    if (status === "error") counts.errorLoops++;
  }
  for (const row of outbox) {
    const category = classifyOutbox({status: row.status, boundaryResult: {source: row.source}});
    const value = Number(row.count);
    if (!category) continue;
    counts.pendingOutbox += value;
    if (category === "approval") { counts.pendingApprovals += value; counts.outboxApprovals += value; }
    if (category === "draft") counts.outboxDrafts += value;
    if (category === "ready") counts.outboxReady += value;
    if (category === "blocked") counts.outboxBlocked += value;
    if (category === "sending") counts.outboxSending += value;
    if (category === "unknown") counts.outboxUnknown += value;
  }
  counts.attentionCount = counts.pendingApprovals - counts.outboxApprovals + counts.blockedLoops + counts.errorLoops + counts.pendingOutbox;
  return counts;
}

/** One statement snapshot. Fetch only status facts, never Loop prompts or outbox bodies. */
export async function readWorkStatusProjection(input: { userId: string; workId: string }) {
  const [row] = await db.select({
    asOf: sql<string>`statement_timestamp()::text`,
    eventCursor: sql<number>`coalesce((select max(seq) from workshop_events where workshop_id = ${input.workId}), 0)`,
    facts: sql<LoopFact[]>`coalesce((select jsonb_agg(jsonb_build_object(
      'status', l.status, 'currentPhase', s.current_phase,
      'stateJson', jsonb_strip_nulls(jsonb_build_object(
        'requiresOwnerActivation', s.state_json->'requiresOwnerActivation',
        'ownerActivationStatus', s.state_json->'ownerActivationStatus',
        'lastApprovalRequiresApproval', s.state_json->'lastApprovalRequiresApproval',
        'lastJobStatus', s.state_json->'lastJobStatus',
        'lastActionGuardBlocked', s.state_json->'lastActionGuardBlocked',
        'blockerDismissedLoopRunId', s.state_json->'blockerDismissedLoopRunId',
        'blockedClearedLoopRunId', s.state_json->'blockedClearedLoopRunId',
        'blockerDismissedAt', s.state_json->'blockerDismissedAt',
        'blockerClearedAt', s.state_json->'blockerClearedAt'
      )) || case when s.state_json ? 'ownerActivationStatus'
        then jsonb_build_object('ownerActivationStatus', s.state_json->'ownerActivationStatus') else '{}'::jsonb end,
      'run', case when r.id is null then null else jsonb_build_object(
        'id', r.id, 'status', r.status, 'startedAt', r.started_at, 'completedAt', r.completed_at,
        'requiresApproval', coalesce(r.verification_result->'approval'->'requiresApproval', 'false'::jsonb),
        'actionGuardBlocked', coalesce(r.verification_result->'actionGuard'->'blocked', 'false'::jsonb)
      ) end
    )) from loops l left join loop_states s on s.loop_id = l.id
      left join lateral (select id, status, started_at, completed_at, verification_result
        from loop_runs where loop_id = l.id order by started_at desc, created_at desc, id desc limit 1) r on true
      where l.workshop_id = ${input.workId} and l.user_id = ${input.userId}), '[]'::jsonb)`,
    outbox: sql<OutboxGroup[]>`coalesce((select jsonb_agg(g) from (
      select status, boundary_result->>'source' as source, count(*)::int as count
      from workshop_outbox where workshop_id = ${input.workId}
      group by status, boundary_result->>'source'
    ) g), '[]'::jsonb)`,
  }).from(workshops).where(and(eq(workshops.id, input.workId), eq(workshops.userId, input.userId))).limit(1);
  if (!row) return null;
  return { version: WORK_STATUS_PROJECTION_VERSION, asOf: new Date(row.asOf).toISOString(),
    eventCursor: Number(row.eventCursor), counts: countWorkStatus(row.facts, row.outbox) };
}

export type WorkStatusProjection = NonNullable<Awaited<ReturnType<typeof readWorkStatusProjection>>>;
