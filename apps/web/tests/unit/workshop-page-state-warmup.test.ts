import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearWorkshopDashboardWarmups,
  scheduleWorkshopDashboardWarmup,
} from "@/lib/workshops/page-state-warmup";

describe("scheduleWorkshopDashboardWarmup", () => {
  afterEach(() => {
    clearWorkshopDashboardWarmups();
    vi.useRealTimers();
  });

  it("deduplicates in-flight workshop dashboard warmups", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);

    expect(
      scheduleWorkshopDashboardWarmup({
        userId: "user-a",
        workshopId: "workshop-a",
        run,
        delayMs: 10,
      }),
    ).toBe(true);
    expect(
      scheduleWorkshopDashboardWarmup({
        userId: "user-a",
        workshopId: "workshop-a",
        run,
        delayMs: 10,
      }),
    ).toBe(false);

    await vi.advanceTimersByTimeAsync(10);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("allows a new warmup after the previous task settles", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);

    scheduleWorkshopDashboardWarmup({
      userId: "user-a",
      workshopId: "workshop-a",
      run,
      delayMs: 10,
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.runAllTicks();

    expect(
      scheduleWorkshopDashboardWarmup({
        userId: "user-a",
        workshopId: "workshop-a",
        run,
        delayMs: 10,
      }),
    ).toBe(true);
  });
});
