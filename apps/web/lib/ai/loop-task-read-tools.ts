import { listLatestLoopRunsByLoopId, listLoops, listLoopsForWorkshop } from "@/lib/loops";

type LoopSummaryInput = {
  id?: string;
  name?: string;
  description?: string | null;
  goal?: string;
  status?: string;
  workshopId?: string | null;
  triggerConfig?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
};

function safeLimit(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(200, Math.trunc(value)))
    : 50;
}

export function summarizeLoopTask(loop: LoopSummaryInput) {
  return {
    id: loop.id,
    name: loop.name,
    description: loop.description,
    goal: loop.goal,
    status: loop.status,
    workshopId: loop.workshopId ?? null,
    trigger: loop.triggerConfig,
    updatedAt: loop.updatedAt,
    createdAt: loop.createdAt,
  };
}

export async function listLoopTasksForUser(input: {
  userId: string;
  includeArchived?: boolean;
  workshopId?: string;
  limit?: number;
  listLoopRows?: typeof listLoops;
  listWorkshopLoopRows?: typeof listLoopsForWorkshop;
  listLatestRuns?: typeof listLatestLoopRunsByLoopId;
}) {
  try {
    const limit = safeLimit(input.limit);
    const loops = input.workshopId
      ? await (input.listWorkshopLoopRows ?? listLoopsForWorkshop)({
          userId: input.userId, workshopId: input.workshopId, limit: limit + 1,
        })
      : await (input.listLoopRows ?? listLoops)(input.userId, { limit });
    const visibleLoops = input.includeArchived
      ? loops
      : loops.filter((loop) => loop.status !== "archived");
    const page = visibleLoops.slice(0, limit);
    // Run IDs come only from the owner-scoped Work Loop list above.
    let latestRuns: Awaited<ReturnType<typeof listLatestLoopRunsByLoopId>> = new Map();
    let latestRunStatus = input.workshopId ? "read" : "not_requested";
    if (input.workshopId) {
      try { latestRuns = await (input.listLatestRuns ?? listLatestLoopRunsByLoopId)(page.map(loop => loop.id)); }
      catch { latestRunStatus = "source_unavailable"; }
    }
    const data = {
      success: true,
      loops: page.map(loop => {
        const run = latestRuns.get(loop.id);
        return { ...summarizeLoopTask(loop), ...(input.workshopId ? { latestRecordedRun: latestRunStatus === "source_unavailable"
          ? { status: "source_unavailable" } : run ? {
          id: run.id, status: run.status, startedAt: run.startedAt,
          completedAt: run.completedAt, createdAt: run.createdAt,
          read: { source: "loopRuns", id: run.id, offset: 0 },
          temporalScope: "last_persisted_run_not_current_executor_activity",
        } : null } : {}) };
      }),
      ...(input.workshopId ? { workshopId: input.workshopId,
        latestRunCoverage: { status: latestRunStatus,
          warning: latestRunStatus === "source_unavailable"
            ? "Latest persisted runs could not be read. Loop configuration remains available; do not infer no runs."
            : "Latest persisted runs are not current executor activity or a complete run history." },
        coverage: { returnedCount: Math.min(visibleLoops.length, limit),
          hasMoreUnfilteredRows: loops.length > limit,
          warning: "Owner-scoped Work Loop list. Archived rows may be omitted; when hasMoreUnfilteredRows is true, this is not the complete list." } } : {}),
    };
    return {
      ok: true,
      text: JSON.stringify(data, null, 2),
      data,
      isError: false,
    };
  } catch (error) {
    return {
      ok: false,
      text: JSON.stringify(
        {
          success: false,
          message: `Failed to list loop tasks: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
        null,
        2,
      ),
      isError: true,
    };
  }
}
