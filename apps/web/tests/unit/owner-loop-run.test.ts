import { describe, expect, it, vi } from "vitest";
import { OwnerLoopRunError, readOwnerLoopRun, type OwnedLoopRun } from "@/lib/loops/owner-loop-run";
import { promotionLoopId, promotionRunId, promotionUserId, promotionWorkId } from "../fixtures/working-memory-promotion";

const input = { ownerId: promotionUserId, workshopId: promotionWorkId, loopId: promotionLoopId, runId: promotionRunId };
const actual = (): OwnedLoopRun => ({ id: promotionRunId, loopId: promotionLoopId, ownerId: promotionUserId,
  workshopId: promotionWorkId, status: "success", completedAt: "2026-10-16T00:00:00.000Z" });

describe("exact owner Loop run reader", () => {
  it("passes every authority coordinate to the loader and returns only its exact owned run", async () => {
    const run = actual(), loadRun = vi.fn(async () => run);
    expect(await readOwnerLoopRun(input, { loadRun })).toEqual({ run });
    expect(loadRun).toHaveBeenCalledWith(input);
  });
  it.each(["ownerId", "workshopId", "loopId", "id"] as const)("rejects a returned run with another %s", async key => {
    const run = { ...actual(), [key]: "77777777-7777-4777-a777-777777777777" };
    await expect(readOwnerLoopRun(input, { loadRun: async () => run })).rejects.toMatchObject({ code: "loop_run_not_found", status: 404 });
  });
  it("does not invoke the loader for an invalid identity or guess another run table", async () => {
    const loadRun = vi.fn(async () => actual());
    await expect(readOwnerLoopRun({ ...input, loopId: "invalid" }, { loadRun })).rejects.toBeInstanceOf(OwnerLoopRunError);
    expect(loadRun).not.toHaveBeenCalled();
    await expect(readOwnerLoopRun(input, { loadRun: async () => null })).rejects.toMatchObject({ code: "loop_run_not_found" });
  });
});
