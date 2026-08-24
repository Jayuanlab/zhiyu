import { buildAgentToolMatrix } from "@/lib/agent-tools/matrix";
import { loadSkills } from "@/lib/ai/skills/loader";
import { listLoopsForWorkshop } from "@/lib/loops/service";
import {
  getWorkshopDashboard,
  listWorkshopDashboard,
  summarizeWorkshopContextCost,
  type WorkshopDashboard,
  type WorkshopDashboardCounts,
} from "@/lib/workshops/dashboard";
import {
  countWorkshopDashboardMetrics,
  countWorkshopOutboxByStatuses,
  getWorkshop,
  getWorkshopHeartbeat,
  getWorkshopDetail,
  listWorkshopEvents,
  listWorkshopWorkVersions,
} from "@/lib/workshops/service";
import { getWorkshopLoopDetail } from "@/lib/workshops/loop-detail";
import { buildWorkshopWorkModel } from "@/lib/workshops/work-model";
import {
  WORK_RUNTIME_INTERFACE_VERSION,
  type WorkListSnapshot,
  type WorkModelSnapshot,
  type WorkSummarySnapshot,
  type WorkSnapshot,
} from "./types";

function nowIso() {
  return new Date().toISOString();
}

const PENDING_OUTBOX_STATUSES = [
  "draft",
  "previewed",
  "pending",
  "needs_approval",
  "blocked",
];

function isoTime(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function dashboardStatusFromCounts(
  workshopStatus: string,
  counts: WorkshopDashboardCounts,
): WorkshopDashboard["status"] {
  if (workshopStatus === "archived") return "archived";
  if (workshopStatus !== "active") return "paused";
  if (counts.errorLoops > 0) return "error";
  if (counts.blockedLoops > 0) return "blocked";
  if (counts.pendingApprovals > 0 || counts.pendingLoopProposals > 0) {
    return "needs_approval";
  }
  return "active";
}

export async function listWorks(input: {
  userId: string;
  limit?: number;
}): Promise<WorkListSnapshot> {
  return {
    interfaceVersion: WORK_RUNTIME_INTERFACE_VERSION,
    generatedAt: nowIso(),
    works: await listWorkshopDashboard({
      userId: input.userId,
      limit: input.limit,
    }),
  };
}

export async function getWorkSummarySnapshot(input: {
  userId: string;
  workId: string;
}): Promise<WorkSummarySnapshot | null> {
  const workshop = await getWorkshop(input.userId, input.workId);
  if (!workshop) return null;

  const [loops, heartbeat, events, metrics, pendingOutboxCount] =
    await Promise.all([
      listLoopsForWorkshop({
        userId: input.userId,
        workshopId: input.workId,
        limit: 80,
      }),
      getWorkshopHeartbeat(input.workId),
      listWorkshopEvents(input.workId, { limit: 100, order: "latest" }),
      countWorkshopDashboardMetrics(input.workId),
      countWorkshopOutboxByStatuses(input.workId, PENDING_OUTBOX_STATUSES),
    ]);

  const counts: WorkshopDashboardCounts = {
    loops: loops.length,
    activeLoops: loops.filter((loop) => loop.status === "active").length,
    pendingLoopProposals: loops.filter((loop) => loop.status === "paused").length,
    pendingOutbox: pendingOutboxCount,
    pendingApprovals: 0,
    blockedLoops: loops.filter((loop) => loop.status === "error").length,
    errorLoops: loops.filter((loop) => loop.status === "error").length,
    sources: metrics.sources,
    memories: metrics.memories,
    directives: metrics.directives,
  };
  const latestEvent = events.at(-1) ?? null;
  const recentFinding =
    [...events]
      .reverse()
      .find((event) =>
        ["source_checked", "memory_written", "loop_run_completed", "decision"].includes(
          event.type,
        ),
      ) ?? null;
  const dashboard: WorkshopDashboard = {
    workshop,
    status: dashboardStatusFromCounts(workshop.status, counts),
    counts,
    nextWork: {
      source: heartbeat?.nextWakeupAt ? "heartbeat" : null,
      at: isoTime(heartbeat?.nextWakeupAt),
      label: heartbeat?.nextWakeupAt ? "车间心跳" : "暂无安排",
    },
    contextCost: summarizeWorkshopContextCost(events),
    recentFinding,
    latestEvent,
    pendingOutbox: [],
    pendingLoopProposals: [],
    blockedLoops: [],
    loops: [],
    recentEvents: events,
    outbox: [],
    memories: [],
    sources: [],
    runs: [],
    heartbeat,
  };

  return {
    interfaceVersion: WORK_RUNTIME_INTERFACE_VERSION,
    generatedAt: nowIso(),
    workId: input.workId,
    detail: {
      workshop,
      heartbeat,
      loops,
      sources: [],
      memories: [],
      outbox: [],
      runs: [],
      events,
    },
    dashboard,
  };
}

export async function getWorkModelSnapshot(input: {
  userId: string;
  workId: string;
  versionLimit?: number;
}): Promise<WorkModelSnapshot | null> {
  const workshop = await getWorkshop(input.userId, input.workId);
  if (!workshop) return null;

  const [loops, heartbeat, versions] = await Promise.all([
    listLoopsForWorkshop({
      userId: input.userId,
      workshopId: input.workId,
      limit: 200,
    }),
    getWorkshopHeartbeat(input.workId),
    listWorkshopWorkVersions(input.userId, input.workId, input.versionLimit ?? 10),
  ]);
  const toolMatrix = buildAgentToolMatrix({
    runtime: "workshop",
    workshopId: input.workId,
    workshop,
  });
  const availableSkillNames = loadSkills().map((skill) => skill.name);

  return {
    interfaceVersion: WORK_RUNTIME_INTERFACE_VERSION,
    generatedAt: nowIso(),
    work: buildWorkshopWorkModel({
      workshop,
      loops,
      heartbeat,
      toolMatrix,
      availableSkillNames,
    }),
    versions: versions ?? [],
  };
}

export async function getWorkSnapshot(input: {
  userId: string;
  workId: string;
}): Promise<WorkSnapshot | null> {
  const [detail, dashboard, model] = await Promise.all([
    getWorkshopDetail(input.userId, input.workId),
    getWorkshopDashboard({
      userId: input.userId,
      workshopId: input.workId,
    }),
    getWorkModelSnapshot(input),
  ]);

  if (!detail || !model) return null;

  return {
    interfaceVersion: WORK_RUNTIME_INTERFACE_VERSION,
    generatedAt: nowIso(),
    workId: input.workId,
    detail,
    dashboard,
    work: model.work,
    versions: model.versions,
  };
}

export async function getWorkToolMatrix(input: {
  userId: string;
  workId: string;
}) {
  const workshop = await getWorkshop(input.userId, input.workId);
  if (!workshop) return null;
  return buildAgentToolMatrix({
    runtime: "workshop",
    workshopId: input.workId,
    workshop,
  });
}

export async function getWorkLoopDetail(input: {
  userId: string;
  workId: string;
  loopId: string;
}) {
  return getWorkshopLoopDetail({
    userId: input.userId,
    workshopId: input.workId,
    loopId: input.loopId,
  });
}
