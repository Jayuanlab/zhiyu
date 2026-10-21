const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export type OwnedLoopRun = {
  id: string; loopId: string; ownerId: string; workshopId: string; status: string;
  completedAt: string | Date | null;
};
export class OwnerLoopRunError extends Error {
  constructor(readonly code: string, message: string, readonly status = 404) { super(message); }
}
export type OwnerLoopRunInput = { ownerId: string; workshopId: string; loopId: string; runId: string };
export type OwnerLoopRunDependencies = { loadRun(input: OwnerLoopRunInput): Promise<OwnedLoopRun | null> };

const defaultDependencies: OwnerLoopRunDependencies = {
  async loadRun(input) {
    const { db } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const rows = await db.execute(sql`SELECT r.id,r.loop_id AS "loopId",r.status,r.completed_at AS "completedAt",
      l.user_id AS "ownerId",l.workshop_id AS "workshopId"
      FROM loop_runs r JOIN loops l ON l.id=r.loop_id JOIN workshops w ON w.id=l.workshop_id
      WHERE l.user_id=${input.ownerId}::uuid AND w.user_id=${input.ownerId}::uuid
        AND w.id=${input.workshopId}::uuid AND l.id=${input.loopId}::uuid AND r.id=${input.runId}::uuid`);
    return (rows[0] as unknown as OwnedLoopRun | undefined) ?? null;
  },
};

/** Exact owner + workshop + Loop + run lookup. Never falls back to workshop_runs. */
export async function readOwnerLoopRun(input: OwnerLoopRunInput, dependencies = defaultDependencies) {
  if (![input.ownerId, input.workshopId, input.loopId, input.runId].every(value => UUID.test(value)))
    throw new OwnerLoopRunError("loop_run_not_found", "没有找到当前用户的这轮 Loop 运行。");
  const run = await dependencies.loadRun(input);
  if (!run || run.id !== input.runId || run.loopId !== input.loopId || run.ownerId !== input.ownerId || run.workshopId !== input.workshopId)
    throw new OwnerLoopRunError("loop_run_not_found", "没有找到当前用户、车间和持续任务对应的这轮运行。");
  return { run };
}
