import { describe, expect, it, vi } from "vitest";
import { listLoopTasksForUser } from "@/lib/ai/loop-task-read-tools";

describe("Loop task read tool adapter", () => {
  it("lists only owner-scoped Loops for a resolved Work and reports bounded coverage", async () => {
    const listWorkshopLoopRows = vi.fn(async () => [
      { id: "loop-1", name: "Morning", workshopId: "work-1", status: "active" },
      { id: "loop-2", name: "Evening", workshopId: "work-1", status: "paused" },
    ]);
    const result = await listLoopTasksForUser({ userId: "owner", workshopId: "work-1", limit: 5,
      listWorkshopLoopRows: listWorkshopLoopRows as never,
      listLatestRuns: vi.fn(async () => new Map([["loop-1", { id: "run-1", status: "completed",
        startedAt: "2026-09-23T00:00:00Z" }]])) as never });
    expect(listWorkshopLoopRows).toHaveBeenCalledExactlyOnceWith({ userId: "owner", workshopId: "work-1", limit: 6 });
    expect(result.data).toMatchObject({ workshopId: "work-1", coverage: { returnedCount: 2,
      hasMoreUnfilteredRows: false }, loops: [{ id: "loop-1", latestRecordedRun: {
        id: "run-1", status: "completed", temporalScope: "last_persisted_run_not_current_executor_activity" } },
        { id: "loop-2", latestRecordedRun: null }] });
  });
  it("keeps Loop configuration when the latest-run source fails", async () => {
    const result = await listLoopTasksForUser({ userId: "owner", workshopId: "work-1",
      listWorkshopLoopRows: vi.fn(async () => [{ id: "loop-1", status: "active", workshopId: "work-1" }]) as never,
      listLatestRuns: vi.fn(async () => { throw Error("run source down"); }) as never });
    expect(result.data).toMatchObject({ loops: [{ id: "loop-1", latestRecordedRun: {
      status: "source_unavailable" } }], latestRunCoverage: { status: "source_unavailable" } });
  });
  it("lists owner Loop tasks and hides archived rows by default", async () => {
    const listLoopRows = vi.fn(async () => [
      {
        id: "loop-1",
        name: "Morning review",
        goal: "Review tasks",
        status: "active",
        workshopId: null,
        triggerConfig: { type: "daily" },
        updatedAt: "2026-09-14T00:00:00.000Z",
        createdAt: "2026-09-13T00:00:00.000Z",
      },
      {
        id: "loop-2",
        name: "Old task",
        status: "archived",
        workshopId: null,
      },
    ]);

    const result = await listLoopTasksForUser({
      userId: "user-1",
      limit: 999,
      listLoopRows: listLoopRows as never,
    });

    expect(listLoopRows).toHaveBeenCalledWith("user-1", {
      limit: 200,
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        success: true,
        loops: [
          {
            id: "loop-1",
            name: "Morning review",
            status: "active",
            trigger: { type: "daily" },
          },
        ],
      },
      isError: false,
    });
    expect(result.text).toContain("Morning review");
  });

  it("can include archived Loop tasks when explicitly requested", async () => {
    const listLoopRows = vi.fn(async () => [
      {
        id: "loop-2",
        name: "Old task",
        status: "archived",
        workshopId: null,
      },
    ]);

    const result = await listLoopTasksForUser({
      userId: "user-1",
      includeArchived: true,
      limit: 5,
      listLoopRows: listLoopRows as never,
    });

    expect(listLoopRows).toHaveBeenCalledWith("user-1", {
      limit: 5,
    });
    expect(result.data?.loops).toEqual([
      expect.objectContaining({
        id: "loop-2",
        status: "archived",
      }),
    ]);
  });
});
