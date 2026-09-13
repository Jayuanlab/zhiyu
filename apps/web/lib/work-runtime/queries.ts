import { summarizeLoop } from "@/lib/loops/dashboard";
import { readWorkStatusProjection } from "@/lib/workshops/status-projection";
import { buildAgentToolMatrix } from "@/lib/agent-tools/matrix";
import { loadSkills } from "@/lib/ai/skills/loader";
import { listLoopsForWorkshop, listLoopStatesByLoopId, listLatestLoopRunsByLoopId } from "@/lib/loops/service";
import {
  getWorkshopDashboard,
  listWorkshopDashboard,
  buildWorkshopDashboard,
  type WorkshopDashboard,

} from "@/lib/workshops/dashboard";
import {
  countWorkshopDashboardMetrics,

  getWorkshop,
  getWorkshopConfigurationBaseline,
  getWorkshopHeartbeat,
  getWorkshopDetail,
  listWorkshopEvents,
  listWorkshopRuns,
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

export async function listWorkRuns(input: {userId: string; workId: string; limit?: number}) {
  const workshop = await getWorkshop(input.userId, input.workId);
  if (!workshop) return null;
  const limit = Number.isSafeInteger(input.limit) ? Math.max(1, Math.min(input.limit!, 100)) : 20;
  return {workshop, runs: await listWorkshopRuns(input.workId, limit)};
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
  const baseline = await getWorkshopConfigurationBaseline(input.userId, input.workId);
  if (!baseline) return null;
  const {workshop, commandVersion} = baseline;

  const [loops, heartbeat, events, metrics, projection] =
    await Promise.all([
      listLoopsForWorkshop({
        userId: input.userId,
        workshopId: input.workId,
        limit: 80,
      }),
      getWorkshopHeartbeat(input.workId),
      listWorkshopEvents(input.workId, { limit: 100, order: "latest" }),
      countWorkshopDashboardMetrics(input.workId),
      readWorkStatusProjection({ userId: input.userId, workId: input.workId }),
    ]);

  if (!projection) return null;
  const ids = loops.map(loop => loop.id);
  const [states, runs] = await Promise.all([listLoopStatesByLoopId(ids), listLatestLoopRunsByLoopId(ids)]);
  const summaries = loops.map(loop => summarizeLoop({loop, state: states.get(loop.id) ?? null, latestRun: runs.get(loop.id) ?? null}));
  const dashboard: WorkshopDashboard = buildWorkshopDashboard({
    workshop, loops: summaries, heartbeat, events,
    memoriesCount: metrics.memories, sourcesCount: metrics.sources, directivesCount: metrics.directives,
    statusProjection: projection,
  });
  dashboard.heartbeat = heartbeat;
  dashboard.recentEvents = events;

  return {
    interfaceVersion: WORK_RUNTIME_INTERFACE_VERSION,
    generatedAt: nowIso(),
    workId: input.workId,
    detail: {
      commandVersion,
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
