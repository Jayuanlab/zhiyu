import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearWorkshopPageStateCache,
  getCachedWorkshopPageState,
  refreshCachedWorkshopPageState,
  setCachedWorkshopPageState,
} from "@/lib/workshops/page-state-cache";

type PageState = {
  selectedWorkshopId: string | null;
  workshops: Array<{ id: string }>;
};

function pageState(id: string): PageState {
  return {
    selectedWorkshopId: id,
    workshops: [{ id }],
  };
}

describe("workshop page-state cache", () => {
  afterEach(() => {
    clearWorkshopPageStateCache();
    vi.useRealTimers();
    delete process.env.WORKSHOP_PAGE_STATE_CACHE_TTL_MS;
    delete process.env.WORKSHOP_PAGE_STATE_CACHE_STALE_TTL_MS;
  });

  it("returns fresh cached page-state by user", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    process.env.WORKSHOP_PAGE_STATE_CACHE_TTL_MS = "1000";

    setCachedWorkshopPageState({
      userId: "user-a",
      value: pageState("workshop-a"),
    });

    const cached = getCachedWorkshopPageState<PageState>("user-a");

    expect(cached).toMatchObject({
      hit: true,
      stale: false,
      refreshing: false,
      value: {
        selectedWorkshopId: "workshop-a",
      },
    });
    expect(getCachedWorkshopPageState<PageState>("user-b")).toBeNull();
  });

  it("marks expired entries stale inside the stale window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    process.env.WORKSHOP_PAGE_STATE_CACHE_TTL_MS = "100";
    process.env.WORKSHOP_PAGE_STATE_CACHE_STALE_TTL_MS = "1000";

    setCachedWorkshopPageState({
      userId: "user-a",
      value: pageState("workshop-a"),
    });

    vi.setSystemTime(1_200);

    const cached = getCachedWorkshopPageState<PageState>("user-a");

    expect(cached).toMatchObject({
      stale: true,
      value: {
        selectedWorkshopId: "workshop-a",
      },
    });
  });

  it("refreshes a stale cached page-state in background", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    process.env.WORKSHOP_PAGE_STATE_CACHE_TTL_MS = "100";
    process.env.WORKSHOP_PAGE_STATE_CACHE_STALE_TTL_MS = "1000";

    setCachedWorkshopPageState({
      userId: "user-a",
      value: pageState("old-workshop"),
    });

    const run = vi.fn(async () => pageState("new-workshop"));

    expect(refreshCachedWorkshopPageState({ userId: "user-a", run })).toBe(true);
    expect(refreshCachedWorkshopPageState({ userId: "user-a", run })).toBe(false);

    await vi.runAllTicks();

    const cached = getCachedWorkshopPageState<PageState>("user-a");

    expect(run).toHaveBeenCalledTimes(1);
    expect(cached?.value.selectedWorkshopId).toBe("new-workshop");
  });
});
