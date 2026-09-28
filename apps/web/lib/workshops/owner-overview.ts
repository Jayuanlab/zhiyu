import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

export type OwnerExecutionState =
  | "running" | "queued" | "waiting_colleague" | "needs_verification"
  | "scheduled" | "idle" | "paused" | "archived" | "uncertain";

export type OwnerWorkOverview = {
  workId: string;
  execution: {
    state: OwnerExecutionState;
    title: string;
    detail: string;
    runId: string | null;
    sinceAt: string | null;
    nextAt: string | null;
    nextLabel: string | null;
  };
  attention: {
    review: number;
    reviewOther: number;
    loopApproval: number;
    outboxApproval: number;
    loopBlocker: number;
    outboxBlocked: number;
    outboxUnknown: number;
    collaboration: number;
    runNeedsReview: number;
    drafts: number;
  };
};

export type OwnerWorkOverviewResponse = {asOf: string; works: OwnerWorkOverview[]};

type RawRun = {
  id: string;
  status: string;
  triggerReason: Record<string, unknown> | null;
  startedAt: string | Date | null;
  loopName: string | null;
  collaborationGoal: string | null;
};
type RawCollaboration = {
  status: string;
  recipientName: string;
  problem: string;
  updatedAt: string | Date;
};
export type OwnerWorkFacts = {
  workId: string;
  workStatus: string;
  leasePhase: string | null;
  leaseRunId: string | null;
  leaseUntil: string | Date | null;
  run: RawRun | null;
  collaboration: RawCollaboration | null;
  schedules: Array<{name: string; nextAt: string | null}>;
  heartbeatNextAt: string | Date | null;
  attention: OwnerWorkOverview["attention"];
};

const iso = (value: string | Date | null | undefined) => value
  ? new Date(value).toISOString() : null;

function runTitle(run: RawRun) {
  if (run.loopName) return run.loopName;
  if (run.collaborationGoal) return run.collaborationGoal;
  const reason = run.triggerReason ?? {};
  if (reason.type === "manual") return "老板发起的工作";
  if (reason.type === "directive") return "执行老板的新方向";
  if (reason.type === "conversation") {
    const content = typeof reason.content === "string" ? reason.content.replace(/\s+/gu, " ").trim() : "";
    return content ? `临时任务：${content.length > 120 ? content.slice(0, 119) + "…" : content}` : "老板交代的临时任务";
  }
  return "本轮目标未记录";
}

function nextSchedule(facts: OwnerWorkFacts, nowMs: number) {
  const candidates = facts.schedules
    .map((item) => ({at: Date.parse(item.nextAt ?? ""), name: item.name}))
    .filter((item) => Number.isFinite(item.at));
  const heartbeatAt = Date.parse(iso(facts.heartbeatNextAt) ?? "");
  if (Number.isFinite(heartbeatAt)) candidates.push({at: heartbeatAt, name: "车间定期唤醒"});
  candidates.sort((a, b) => a.at - b.at);
  return {
    next: candidates.find((item) => item.at >= nowMs) ?? null,
    overdue: candidates.some((item) => item.at < nowMs),
  };
}

/** A read model: a recent conclusion never proves that an employee is running now. */
export function deriveOwnerWorkOverview(facts: OwnerWorkFacts, asOf: string): OwnerWorkOverview {
  const nowMs = Date.parse(asOf);
  const schedule = nextSchedule(facts, nowMs);
  const nextAt = schedule.next ? new Date(schedule.next.at).toISOString() : null;
  const nextLabel = schedule.next?.name ?? null;
  const base = {workId: facts.workId, attention: facts.attention};
  const execution = (state: OwnerExecutionState, title: string, detail: string,
    runId: string | null = null, sinceAt: string | null = null): OwnerWorkOverview => ({
      ...base, execution: {state, title, detail, runId, sinceAt,
        nextAt: state === "scheduled" ? nextAt : null,
        nextLabel: state === "scheduled" ? nextLabel : null},
    });

  if (facts.workStatus === "archived") return execution("archived", "已归档", "不会再自动领取工作");
  if (facts.workStatus !== "active") return execution("paused", "已暂停", "当前不会自动领取新工作");

  const run = facts.run;
  const leaseFresh = facts.leasePhase === "running" && facts.leaseRunId === run?.id &&
    Date.parse(iso(facts.leaseUntil) ?? "") > nowMs;
  if (run?.status === "running" || run?.status === "cancel_requested" || facts.leasePhase === "running") {
    if (!run || run.status !== "running" || !leaseFresh) {
      return execution("uncertain", "运行状态待核对", "运行记录与执行租约未能共同证明仍在执行", run?.id ?? facts.leaseRunId);
    }
    return execution("running", runTitle(run), "正在执行", run.id, iso(run.startedAt));
  }
  if (run?.status === "queued") {
    return execution("queued", runTitle(run), "已进入执行队列，尚未开始", run.id);
  }
  if (run?.status === "needs_review" || facts.leasePhase === "needs_review") {
    return execution("uncertain", "上次执行待核对", "需先核对执行结果和外部效果", run?.id ?? facts.leaseRunId);
  }

  const collaboration = facts.collaboration;
  if (collaboration?.status === "replied") {
    return execution("needs_verification", "待核对同事回复", `来自${collaboration.recipientName}：${collaboration.problem}`,
      null, iso(collaboration.updatedAt));
  }
  if (collaboration) {
    return execution("waiting_colleague", "等待同事回复", `已向${collaboration.recipientName}求助：${collaboration.problem}`,
      null, iso(collaboration.updatedAt));
  }
  if (schedule.next) return execution("scheduled", "当前未运行", "等待下次工作安排");
  if (schedule.overdue) return execution("uncertain", "计划时间已过", "尚未读到新的运行或调度安排");
  return execution("idle", "当前未运行", "暂无已安排的下一次工作");
}

type DbRow = Record<string, unknown> & {work_id: string; work_status: string};
const count = (value: unknown) => Number(value) || 0;
function parseRun(row: DbRow): RawRun | null {
  if (!row.run_id) return null;
  return {
    id: String(row.run_id), status: String(row.run_status),
    triggerReason: row.trigger_reason && typeof row.trigger_reason === "object"
      ? row.trigger_reason as Record<string, unknown> : null,
    startedAt: row.run_started_at as string | Date | null,
    loopName: row.run_loop_name ? String(row.run_loop_name) : null,
    collaborationGoal: row.run_collaboration_goal ? String(row.run_collaboration_goal) : null,
  };
}

/** One owner-scoped statement keeps the roster cheap and internally consistent. */
export async function getOwnerWorkOverview(ownerId: string): Promise<OwnerWorkOverviewResponse> {
  const rows = await db.execute(sql`
    SELECT w.id AS work_id, w.status AS work_status, statement_timestamp() AS as_of,
      lease.phase AS lease_phase, lease.run_id AS lease_run_id, lease.lease_until,
      active_run.id AS run_id, active_run.status AS run_status,
      active_run.trigger_reason, active_run.started_at AS run_started_at,
      (SELECT l.name FROM loops l WHERE l.id::text=active_run.trigger_reason->>'loopId' AND l.workshop_id=w.id LIMIT 1) AS run_loop_name,
      (SELECT c.desired_outcome FROM work_collaboration_requests c
        WHERE c.id::text=active_run.trigger_reason->>'requestId' AND c.owner_id=w.user_id
          AND (c.requester_work_id=w.id OR c.recipient_work_id=w.id) LIMIT 1) AS run_collaboration_goal,
      waiting.status AS collaboration_status, waiting.recipient_name AS collaboration_recipient,
      waiting.problem AS collaboration_problem, waiting.updated_at AS collaboration_updated_at,
      hb.next_wakeup_at AS heartbeat_next_at,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('name', l.name,
        'nextAt', s.state_json->>'nextScheduledRunAt')) FROM loops l
        LEFT JOIN loop_states s ON s.loop_id=l.id
        WHERE l.workshop_id=w.id AND l.user_id=w.user_id AND l.status='active'), '[]'::jsonb) AS schedules,
      (SELECT count(*)::int FROM workshop_review_items i WHERE i.workshop_id=w.id AND i.status='pending'
        AND i.kind IN ('watchlist_proposal','agent_change_proposal','insight_change_proposal',
          'memory_recall_change_plan','memory_recall_governance_proposal','loop_change_proposal')) AS review_count,
      (SELECT count(*)::int FROM workshop_review_items i WHERE i.workshop_id=w.id AND i.status='pending'
        AND i.kind NOT IN ('watchlist_proposal','agent_change_proposal','insight_change_proposal',
          'memory_recall_change_plan','memory_recall_governance_proposal','loop_change_proposal','loop_blocker')) AS review_other_count,
      (SELECT count(*)::int FROM workshop_review_items i WHERE i.workshop_id=w.id AND i.status='pending' AND i.kind='loop_blocker') AS loop_blocker_count,
      (SELECT count(*)::int FROM loop_approval_requests a JOIN loops l ON l.id=a.loop_id
        WHERE l.workshop_id=w.id AND a.user_id=w.user_id AND a.status='pending') AS loop_approval_count,
      (SELECT count(*)::int FROM workshop_outbox o WHERE o.workshop_id=w.id AND o.status IN ('pending_approval','needs_approval')) AS outbox_approval_count,
      (SELECT count(*)::int FROM workshop_outbox o WHERE o.workshop_id=w.id AND o.status='blocked') AS outbox_blocked_count,
      (SELECT count(*)::int FROM workshop_outbox o WHERE o.workshop_id=w.id AND o.status='unknown') AS outbox_unknown_count,
      (SELECT count(*)::int FROM workshop_outbox o WHERE o.workshop_id=w.id
        AND o.status IN ('draft','previewed','pending')
        AND o.boundary_result->>'source' IS DISTINCT FROM 'loop_suggested_action') AS draft_count,
      (SELECT count(*)::int FROM work_collaboration_requests c WHERE c.owner_id=w.user_id
        AND (c.requester_work_id=w.id OR c.recipient_work_id=w.id) AND c.attention_reason IS NOT NULL
        AND c.status IN ('delivered','accepted','needs_info','replied')) AS collaboration_attention_count,
      (SELECT count(*)::int FROM workshop_runs r WHERE r.workshop_id=w.id AND r.status='needs_review') AS run_needs_review_count
    FROM workshops w
    LEFT JOIN workshop_execution_leases lease ON lease.workshop_id=w.id
    LEFT JOIN workshop_heartbeats hb ON hb.workshop_id=w.id
    LEFT JOIN LATERAL (
      SELECT r.id, r.status, r.trigger_reason, r.started_at FROM workshop_runs r
      WHERE r.workshop_id=w.id AND r.status IN ('running','cancel_requested','queued','needs_review')
      ORDER BY CASE r.status WHEN 'running' THEN 0 WHEN 'cancel_requested' THEN 1
        WHEN 'queued' THEN 2 ELSE 3 END, r.created_at DESC LIMIT 1
    ) active_run ON true
    LEFT JOIN LATERAL (
      SELECT c.status, c.recipient_name, c.problem, c.updated_at
      FROM work_collaboration_requests c WHERE c.owner_id=w.user_id AND c.requester_work_id=w.id
        AND c.status IN ('delivered','accepted','needs_info','replied')
      ORDER BY c.updated_at DESC LIMIT 1
    ) waiting ON true
    WHERE w.user_id=${ownerId}::uuid
    ORDER BY w.created_at, w.id
  `) as unknown as DbRow[];
  const asOf = rows[0] ? iso(rows[0].as_of as string | Date) ?? new Date().toISOString()
    : new Date().toISOString();
  return {asOf, works: rows.map((row) => deriveOwnerWorkOverview({
    workId: row.work_id, workStatus: row.work_status,
    leasePhase: row.lease_phase ? String(row.lease_phase) : null,
    leaseRunId: row.lease_run_id ? String(row.lease_run_id) : null,
    leaseUntil: row.lease_until as string | Date | null,
    run: parseRun(row),
    collaboration: row.collaboration_status ? {
      status: String(row.collaboration_status), recipientName: String(row.collaboration_recipient),
      problem: String(row.collaboration_problem),
      updatedAt: row.collaboration_updated_at as string | Date,
    } : null,
    schedules: Array.isArray(row.schedules) ? row.schedules as OwnerWorkFacts["schedules"] : [],
    heartbeatNextAt: row.heartbeat_next_at as string | Date | null,
    attention: {
      review: count(row.review_count), reviewOther: count(row.review_other_count),
      loopApproval: count(row.loop_approval_count),
      outboxApproval: count(row.outbox_approval_count), loopBlocker: count(row.loop_blocker_count),
      outboxBlocked: count(row.outbox_blocked_count), outboxUnknown: count(row.outbox_unknown_count),
      collaboration: count(row.collaboration_attention_count),
      runNeedsReview: count(row.run_needs_review_count), drafts: count(row.draft_count),
    },
  }, asOf))};
}
