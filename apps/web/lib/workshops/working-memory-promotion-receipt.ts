import { sql } from "drizzle-orm";
import type { withWorkshopEventTransaction } from "./event-write";
import type { AppendWorkshopEventInput } from "./types";
import { canonicalCommandJson } from "@/lib/work-runtime/command-payload";
import { WorkingMemoryPromotionError, parseWorkingMemoryPromotionCommand, WORKING_MEMORY_PROMOTION_SOURCE, type WorkingMemoryPromotionCommand } from "./working-memory-promotion";

type TransactionWork = Parameters<typeof withWorkshopEventTransaction>[0];
export type OwnerPromotionReceiptInput = { userId: string; workshopId: string; command: WorkingMemoryPromotionCommand; event: AppendWorkshopEventInput };
export type OwnerPromotionReceiptDependencies = {
  hasExecutionLease(): Promise<boolean>;
  transaction(work: TransactionWork): Promise<unknown>;
};
const defaults: OwnerPromotionReceiptDependencies = {
  async hasExecutionLease() { return !!(await import("@/lib/work-runtime/execution-context")).resolveExecutionLease(); },
  async transaction(work) { return (await import("./event-write")).withWorkshopEventTransaction(work); },
};
const fail = (code: string, message: string, status = 409): never => { throw new WorkingMemoryPromotionError(code, message, status); };

/** Owner control-plane receipt for a finalized run, never a late worker write. */
export async function appendOwnerWorkingMemoryPromotion(input: OwnerPromotionReceiptInput, deps = defaults) {
  const command = parseWorkingMemoryPromotionCommand(input.command), { event } = input;
  const identity = command.runKind === "loop" ? { runKind: command.runKind, loopId: command.loopId, runId: command.runId } : { runKind: command.runKind, runId: command.runId };
  let identityMatches = false;
  try { identityMatches = canonicalCommandJson(event.metadata?.runIdentity) === canonicalCommandJson(identity); } catch { /* Missing identities are not accepted. */ }
  if (await deps.hasExecutionLease()) fail("owner_promotion_required", "工作记忆送审须由主人控制面执行，运行中的智能体不能代为提交。");
  if (event.workshopId !== input.workshopId || event.type !== "working_memory_promoted" || event.metadata?.receiptAuthority !== "runtime" ||
    event.metadata?.status !== "candidate" || event.metadata?.source !== WORKING_MEMORY_PROMOTION_SOURCE || event.metadata?.commandId !== command.commandId ||
    event.metadata?.version !== command.expectedVersion || event.metadata?.noteKey !== command.noteKey || !identityMatches ||
    !/^[a-f0-9]{64}$/i.test(String(event.metadata?.requestHash ?? "")) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(String(event.metadata?.candidateId ?? "")) ||
    (command.runKind === "loop" ? event.loopId !== command.loopId || event.loopRunId !== command.runId : event.runId !== command.runId || !!event.loopId || !!event.loopRunId))
    fail("invalid_promotion_receipt", "记忆送审回执与主人选中的运行不一致。");
  return deps.transaction(async (tx, append) => {
    const owner = await tx.execute(sql`SELECT id FROM workshops WHERE id=${input.workshopId}::uuid AND user_id=${input.userId}::uuid FOR UPDATE`);
    if (!owner[0]) fail("workshop_not_found", "没有找到当前用户的车间。", 404);
    if (command.runKind === "loop") {
      const rows = await tx.execute(sql`SELECT r.status,r.completed_at AS "completedAt",x.run_id AS "executionRunId"
        FROM loop_runs r JOIN loops l ON l.id=r.loop_id LEFT JOIN workshop_loop_executions x ON x.loop_run_id=r.id
        WHERE l.user_id=${input.userId}::uuid AND l.workshop_id=${input.workshopId}::uuid
          AND l.id=${command.loopId}::uuid AND r.id=${command.runId}::uuid FOR UPDATE OF r,l`);
      const run = rows[0];
      if (!run) fail("loop_run_not_found", "没有找到当前车间的这轮 Loop 运行。", 404);
      if (!["success", "failed", "cancelled", "blocked"].includes(String(run.status)) || !run.completedAt ||
        !Number.isFinite(new Date(run.completedAt as string | Date).getTime()))
        fail("working_memory_run_not_terminal", "这轮 Loop 尚未结束，不能记录记忆送审回执。");
      if (event.runId && event.runId !== (run.executionRunId ?? command.runId))
        fail("invalid_promotion_receipt", "Loop 运行与车间执行编号不一致。");
    } else {
      const rows = await tx.execute(sql`SELECT status FROM workshop_runs WHERE id=${command.runId}::uuid AND workshop_id=${input.workshopId}::uuid FOR UPDATE`);
      if (!rows[0]) fail("workshop_run_not_found", "没有找到当前车间的这轮运行。", 404);
      if (!["completed", "failed", "interrupted", "cancelled"].includes(String(rows[0].status)))
        fail("working_memory_run_not_terminal", "这轮运行尚未结束，不能记录记忆送审回执。");
    }
    // The Brain service commits independently. A failure here remains visible to the
    // caller; a retry recovers the same pending candidate without changing its status.
    return append({ ...event, metadata: { ...event.metadata, actorId: input.userId, actorKind: "owner", controlPlane: "working_memory_promotion" } });
  });
}
