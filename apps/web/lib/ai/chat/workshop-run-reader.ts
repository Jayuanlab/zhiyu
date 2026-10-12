import type { listWorkRuns } from "@/lib/work-runtime/queries";
import type { WorkshopRun } from "@/lib/db/schema";
import { NativeWorkshopRunError } from "./native-workshop-run";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
type Dependencies = { listRuns: typeof listWorkRuns };
const defaults: Dependencies = {
  async listRuns(input) { return (await import("@/lib/work-runtime/queries")).listWorkRuns(input); },
};

/** Discover a bounded recent window without choosing a run or rebinding chat
 * context. The existing query verifies ownership before loading any runs. */
export async function readOwnerWorkshopRuns(input: {
  ownerId: string; workshopId: string; limit?: number;
}, dependencies: Dependencies = defaults) {
  const limit = input.limit ?? 1;
  if (![input.ownerId, input.workshopId].every(id => typeof id === "string" && UUID.test(id))
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new NativeWorkshopRunError("workshop_runs_invalid_request", "车间运行列表的读取范围无效。", 400);
  }
  const snapshot = await dependencies.listRuns({ userId: input.ownerId, workId: input.workshopId, limit: limit + 1 });
  if (!snapshot || snapshot.workshop.id !== input.workshopId || snapshot.workshop.userId !== input.ownerId) {
    throw new NativeWorkshopRunError("workshop_run_not_found", "没有找到当前用户的这个车间。", 404);
  }
  const observedRuns: WorkshopRun[] = snapshot.runs;
  if (observedRuns.some(run => run.workshopId !== input.workshopId || !UUID.test(run.id))) {
    throw new NativeWorkshopRunError("workshop_run_not_found", "车间运行列表的来源无法核对。", 404);
  }
  const runs = observedRuns.slice(0, limit).map(run => ({
    id: run.id, workshopId: run.workshopId, status: run.status,
    createdAt: run.createdAt, updatedAt: run.updatedAt, startedAt: run.startedAt, completedAt: run.completedAt,
    nextRead: { tool: "observeWorkshop", workshopId: input.workshopId, runId: run.id, view: "result" },
  }));
  return { ok: true as const, status: "runs_observed" as const,
    workshop: { id: snapshot.workshop.id, name: snapshot.workshop.name, status: snapshot.workshop.status },
    runs, coverage: { scope: "owner_workshop_recent_runs", order: "createdAt_desc_id_desc", limit,
      hasMore: snapshot.runs.length > limit, exhaustive: snapshot.runs.length <= limit },
    observedAt: new Date().toISOString(),
    instruction: "这是指定车间按创建时间排序的最近运行记录。按实际 runId 读取需要的结果；列表不证明执行器当前活动或业务验收，不改变原对话焦点。hasMore=true 时不代表已列出全部历史。" };
}
