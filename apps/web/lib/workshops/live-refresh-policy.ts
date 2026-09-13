export type WorkshopLiveRefreshPanel =
  | "dashboard"
  | "work"
  | "sources"
  | "memories"
  | "outbox"
  | "review";

export type WorkshopLiveRefreshPlan = {
  detail: boolean;
  panels: WorkshopLiveRefreshPanel[];
  loopDetail: boolean;
};

type WorkshopEventLike = {
  type: string;
  loopId?: string | null;
};

const IGNORED_EVENT_TYPES = new Set([
  "agent_text",
  "agent_configured",
  "error",
  "source_checked",
  "tool_call",
  "tool_result",
]);

const LOOP_EVENT_TYPES = new Set([
  "run_completed",
  "run_failed",
  "loop_run_completed",
  "loop_run_failed",
  "next_wakeup_suggested",
]);

const MEMORY_EVENT_TYPES = new Set(["memory_written", "memory_reviewed"]);

const SOURCE_EVENT_TYPES = new Set(["source_added"]);

const OUTBOX_EVENT_TYPES = new Set([
  "outbox_dismissed",
  "outbox_draft",
  "outbox_suppressed",
  "outbox_blocked",
  "outbox_preview_ready",
  "outbox_sent",
  "outbox_auto_send_blocked",
  "outbox_auto_send_failed",
  "work_outbox_send_requested",
  "work_outbox_send_failed",
  "publish_draft",
]);

const WORK_EVENT_TYPES = new Set([
  "directive_added",
  "report_quality_review",
  "work_command_applied",
  "workshop_agent_change_applied",
  "workshop_agent_change_rejected",
  "workshop_agent_change_superseded",
]);

const REVIEW_EVENT_TYPES = new Set([
  "outbox_dismissed",
  "tool_error",
  "outbox_blocked",
  "outbox_auto_send_failed",
  "work_outbox_send_failed",
  "workshop_agent_change_proposed",
  "workshop_agent_change_applied",
  "workshop_agent_change_rejected",
  "workshop_agent_change_superseded",
  "watchlist_proposal",
  "watchlist_proposal_applied",
  "watchlist_proposal_rejected",
  "watchlist_proposal_repaired",
  "report_quality_config_proposed",
]);

function uniquePanels(panels: WorkshopLiveRefreshPanel[]) {
  return Array.from(new Set(panels));
}

export function getWorkshopLiveRefreshPlan(
  event: WorkshopEventLike,
): WorkshopLiveRefreshPlan {
  if (IGNORED_EVENT_TYPES.has(event.type)) {
    return { detail: false, panels: [], loopDetail: false };
  }

  const panels: WorkshopLiveRefreshPanel[] = [];
  let detail = false;
  let loopDetail = false;

  if (LOOP_EVENT_TYPES.has(event.type)) {
    detail = true;
    loopDetail = Boolean(event.loopId);
    panels.push("dashboard");
  }

  if (MEMORY_EVENT_TYPES.has(event.type)) {
    panels.push("memories");
  }

  if (SOURCE_EVENT_TYPES.has(event.type)) {
    panels.push("sources");
  }

  if (OUTBOX_EVENT_TYPES.has(event.type)) {
    detail = true;
    panels.push("outbox", "dashboard");
  }

  if (WORK_EVENT_TYPES.has(event.type)) {
    detail = true;
    panels.push("work", "dashboard");
  }

  if (REVIEW_EVENT_TYPES.has(event.type)) {
    panels.push("review");
  }

  if (
    event.type === "watchlist_proposal_applied" ||
    event.type === "watchlist_proposal_rejected" ||
    event.type === "watchlist_proposal_repaired"
  ) {
    detail = true;
    panels.push("dashboard");
  }

  return {
    detail,
    panels: uniquePanels(panels),
    loopDetail,
  };
}

export function shouldRefreshLiveWorkshopDetail(event: WorkshopEventLike) {
  const plan = getWorkshopLiveRefreshPlan(event);
  return plan.detail || plan.panels.length > 0 || plan.loopDetail;
}
