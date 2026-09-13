import { describe, expect, it } from "vitest";
import {
  getWorkshopLiveRefreshPlan,
  shouldRefreshLiveWorkshopDetail,
} from "@/lib/workshops/live-refresh-policy";

describe("workshop live refresh policy", () => {
  it("ignores chatty stream events that are already patched into the log", () => {
    expect(getWorkshopLiveRefreshPlan({ type: "agent_text" })).toEqual({
      detail: false,
      panels: [],
      loopDetail: false,
    });
    expect(shouldRefreshLiveWorkshopDetail({ type: "agent_text" })).toBe(false);
  });

  it("refreshes only memory panel for memory events", () => {
    expect(getWorkshopLiveRefreshPlan({ type: "memory_written" })).toEqual({
      detail: false,
      panels: ["memories"],
      loopDetail: false,
    });
  });

  it("refreshes aggregate facts as well as outbox items", () => {
    expect(getWorkshopLiveRefreshPlan({ type: "outbox_draft" })).toEqual({
      detail: true,
      panels: ["outbox", "dashboard"],
      loopDetail: false,
    });
  });

  it("refreshes review panel for review item proposal events", () => {
    expect(
      getWorkshopLiveRefreshPlan({ type: "workshop_agent_change_proposed" }),
    ).toEqual({
      detail: false,
      panels: ["review"],
      loopDetail: false,
    });
  });

  it("refreshes review panel for service error events without refreshing detail", () => {
    expect(getWorkshopLiveRefreshPlan({ type: "tool_error" })).toEqual({
      detail: false,
      panels: ["review"],
      loopDetail: false,
    });
  });

  it("refreshes outbox and review panels for outbox service failures", () => {
    expect(getWorkshopLiveRefreshPlan({ type: "work_outbox_send_failed" })).toEqual({
      detail: true,
      panels: ["outbox", "dashboard", "review"],
      loopDetail: false,
    });
  });

  it("refreshes only source panel for source inventory events", () => {
    expect(getWorkshopLiveRefreshPlan({ type: "source_added" })).toEqual({
      detail: false,
      panels: ["sources"],
      loopDetail: false,
    });
  });

  it("keeps loop started events local because the stream event carries enough status", () => {
    expect(
      getWorkshopLiveRefreshPlan({
        type: "loop_run_started",
        loopId: "loop-1",
      }),
    ).toEqual({
      detail: false,
      panels: [],
      loopDetail: false,
    });
  });

  it("refreshes dashboard and loop detail for loop events", () => {
    expect(
      getWorkshopLiveRefreshPlan({
        type: "loop_run_completed",
        loopId: "loop-1",
      }),
    ).toEqual({
      detail: true,
      panels: ["dashboard"],
      loopDetail: true,
    });
  });

  it("refreshes work and dashboard for work model change events", () => {
    expect(
      getWorkshopLiveRefreshPlan({
        type: "workshop_agent_change_applied",
      }),
    ).toEqual({
      detail: true,
      panels: ["work", "dashboard", "review"],
      loopDetail: false,
    });
  });

  it("refreshes dashboard and review for resolved watchlist proposals", () => {
    expect(
      getWorkshopLiveRefreshPlan({
        type: "watchlist_proposal_applied",
      }),
    ).toEqual({
      detail: true,
      panels: ["review", "dashboard"],
      loopDetail: false,
    });
  });
});
