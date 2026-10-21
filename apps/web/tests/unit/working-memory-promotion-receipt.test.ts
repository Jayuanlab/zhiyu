import { describe, expect, it, vi } from "vitest";
import { appendOwnerWorkingMemoryPromotion, type OwnerPromotionReceiptInput, type OwnerPromotionReceiptDependencies } from "@/lib/workshops/working-memory-promotion-receipt";
import { parseWorkingMemoryPromotionCommand, WORKING_MEMORY_PROMOTION_SOURCE } from "@/lib/workshops/working-memory-promotion";
import { promotionLoopId, promotionRunId, promotionUserId, promotionWorkId } from "../fixtures/working-memory-promotion";

function input(loop = false): OwnerPromotionReceiptInput {
  const command = parseWorkingMemoryPromotionCommand({ runKind: loop ? "loop" : "workshop", runId: promotionRunId,
    ...(loop ? { loopId: promotionLoopId } : {}), noteKey: "paper:method", expectedVersion: 1, commandId: "promote-1" });
  return { userId: promotionUserId, workshopId: promotionWorkId, command, event: {
    workshopId: promotionWorkId, runId: promotionRunId, ...(loop ? { loopId: promotionLoopId, loopRunId: promotionRunId } : {}),
    type: "working_memory_promoted", title: "Candidate submitted", metadata: { receiptAuthority: "runtime", status: "candidate", commandId: command.commandId,
      source: WORKING_MEMORY_PROMOTION_SOURCE, version: command.expectedVersion, noteKey: command.noteKey, requestHash: "a".repeat(64), candidateId: promotionUserId,
      runIdentity: command.runKind === "loop" ? { runKind: "loop", loopId: command.loopId, runId: command.runId } : { runKind: "workshop", runId: command.runId } },
  } };
}
function dependencies(rows: Record<string, unknown>[][] = [[{ id: promotionWorkId }], [{ status: "completed", completed_worker: "former-worker" }]]) {
  const execute = vi.fn(); rows.forEach(result => execute.mockResolvedValueOnce(result));
  const append = vi.fn(async event => ({ id: "receipt", ...event }));
  const deps: OwnerPromotionReceiptDependencies = { hasExecutionLease: vi.fn(async () => false),
    transaction: vi.fn(async work => work({ execute } as never, append as never, async <T>(attempt: () => Promise<T>) => attempt())) };
  return { deps, execute, append };
}

describe("finalized owner memory promotion receipts", () => {
  it("records a completed leased run through the owner control plane, without resuming its former worker", async () => {
    const { deps, execute, append } = dependencies();
    await appendOwnerWorkingMemoryPromotion(input(), deps);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ runId: promotionRunId, type: "working_memory_promoted",
      metadata: expect.objectContaining({ actorId: promotionUserId, actorKind: "owner", controlPlane: "working_memory_promotion", status: "candidate" }) }));
  });
  it("accepts the exact completed Loop with a distinct linked workshop execution ID", async () => {
    const { deps, append } = dependencies([[{ id: promotionWorkId }], [{ status: "success", completedAt: "2026-10-16T00:00:00.000Z", executionRunId: "99999999-9999-4999-a999-999999999999" }]]);
    const request = input(true); request.event.runId = "99999999-9999-4999-a999-999999999999";
    await appendOwnerWorkingMemoryPromotion(request, deps);
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ loopId: promotionLoopId, loopRunId: promotionRunId, runId: request.event.runId }));
  });
  it("rejects an ambient worker capability before opening the owner transaction", async () => {
    const { deps, append } = dependencies(); deps.hasExecutionLease = async () => true;
    await expect(appendOwnerWorkingMemoryPromotion(input(), deps)).rejects.toMatchObject({ code: "owner_promotion_required" });
    expect(deps.transaction).not.toHaveBeenCalled(); expect(append).not.toHaveBeenCalled();
  });
  it("allows only its fixed candidate receipt and exact owner scope", async () => {
    for (const patch of [{ type: "working_memory_updated" }, { workshopId: promotionUserId }, { loopRunId: promotionRunId }, { metadata: { status: "active" } }]) {
      const { deps, append } = dependencies(), request = input(); Object.assign(request.event, patch);
      await expect(appendOwnerWorkingMemoryPromotion(request, deps)).rejects.toMatchObject({ code: "invalid_promotion_receipt" });
      expect(deps.transaction).not.toHaveBeenCalled(); expect(append).not.toHaveBeenCalled();
    }
    const { deps, append } = dependencies([[]]);
    await expect(appendOwnerWorkingMemoryPromotion(input(), deps)).rejects.toMatchObject({ code: "workshop_not_found", status: 404 });
    expect(append).not.toHaveBeenCalled();
  });
  it("rechecks locked Loop terminal status and execution identity before appending", async () => {
    for (const run of [
      { status: "running", completedAt: null }, { status: "needs_review", completedAt: "2026-10-16T00:00:00.000Z" },
      { status: "success", completedAt: null }, { status: "success", completedAt: "2026-10-16T00:00:00.000Z", executionRunId: promotionUserId },
    ]) {
      const { deps, append } = dependencies([[{ id: promotionWorkId }], [run]]);
      await expect(appendOwnerWorkingMemoryPromotion(input(true), deps)).rejects.toMatchObject({ code: run.executionRunId ? "invalid_promotion_receipt" : "working_memory_run_not_terminal" });
      expect(append).not.toHaveBeenCalled();
    }
  });
  it("propagates an audit failure instead of reporting a confirmed submission", async () => {
    const { deps, append } = dependencies(); append.mockRejectedValueOnce(Error("audit unavailable"));
    await expect(appendOwnerWorkingMemoryPromotion(input(), deps)).rejects.toThrow("audit unavailable");
  });
});
