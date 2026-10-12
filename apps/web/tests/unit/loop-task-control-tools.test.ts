import { describe, expect, it, vi } from "vitest";
import {
  normalizeLoopTaskStatusControl,
  setLoopTaskStatusForUser,
} from "@/lib/ai/loop-task-control-tools";

describe("Loop task control tool adapter", () => {
  it("normalizes only supported status controls", () => {
    expect(normalizeLoopTaskStatusControl("active")).toBe("active");
    expect(normalizeLoopTaskStatusControl("paused")).toBe("paused");
    expect(normalizeLoopTaskStatusControl("archived")).toBe("archived");
    expect(normalizeLoopTaskStatusControl("deleted")).toBeNull();
  });

  it("updates an owner-scoped loop status through the shared adapter", async () => {
    const updateLoopRow = vi.fn(async () => ({
      id: "loop-1",
      userId: "user-1",
      name: "Morning review",
      description: null,
      goal: "Review sources",
      status: "paused",
      workshopId: null,
      triggerConfig: { type: "cron" },
      contextConfig: {},
      actionPolicy: {},
      verificationConfig: {},
      approvalPolicy: {},
      retryPolicy: {},
      escalationPolicy: {},
      updatedAt: new Date("2026-09-14T12:00:00.000Z"),
      createdAt: new Date("2026-09-14T08:00:00.000Z"),
    }));

    const result = await setLoopTaskStatusForUser({
      userId: "user-1",
      loopId: "loop-1",
      status: "paused",
      updateLoopRow,
    });

    expect(updateLoopRow).toHaveBeenCalledWith("user-1", "loop-1", {
      status: "paused",
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        success: true,
        loop: {
          id: "loop-1",
          name: "Morning review",
          status: "paused",
        },
      },
      isError: false,
    });
    expect(result.data?.receiptSemantics).toMatchObject({
      scheduleUpdate: { status: "not_recomputed" },
      futureAdmissionObservation: "not_observed_by_this_command",
      inFlightCancellation: "not_requested_by_this_command",
      historyDeletion: "not_requested_by_this_command",
    });
    expect(result.data).not.toHaveProperty("nextScheduledRunAt");
    expect(updateLoopRow).toHaveBeenCalledTimes(1);
  });

  it("returns a visible error when the loop is not found", async () => {
    const updateLoopRow = vi.fn(async () => null);

    const result = await setLoopTaskStatusForUser({
      userId: "user-1",
      loopId: "missing-loop",
      status: "archived",
      updateLoopRow,
    });

    expect(result).toMatchObject({
      ok: false,
      data: {
        success: false,
        message: "Loop not found: missing-loop",
      },
      isError: true,
    });
    expect(result.data).not.toHaveProperty("receiptSemantics");
  });

  it("returns a visible error when the update fails", async () => {
    const updateLoopRow = vi.fn(async () => {
      throw new Error("database unavailable");
    });

    const result = await setLoopTaskStatusForUser({
      userId: "user-1",
      loopId: "loop-1",
      status: "active",
      updateLoopRow,
    });

    expect(result).toMatchObject({
      ok: false,
      data: {
        success: false,
        message: "Failed to update loop task: database unavailable",
      },
      isError: true,
    });
    expect(result.data).not.toHaveProperty("receiptSemantics");
  });
});
