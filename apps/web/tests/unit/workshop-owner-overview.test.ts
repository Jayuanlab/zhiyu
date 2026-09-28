import { describe, expect, it } from "vitest";
import { deriveOwnerWorkOverview, type OwnerWorkFacts } from "@/lib/workshops/owner-overview";

const asOf = "2026-09-26T06:00:00.000Z";
const emptyAttention = {
  review: 0, reviewOther: 0, loopApproval: 0, outboxApproval: 0, loopBlocker: 0,
  outboxBlocked: 0, outboxUnknown: 0, collaboration: 0,
  runNeedsReview: 0, drafts: 0,
};
const base: OwnerWorkFacts = {
  workId: "work-a", workStatus: "active", leasePhase: "idle", leaseRunId: null,
  leaseUntil: null, run: null, collaboration: null,
  schedules: [{name: "next check", nextAt: "2026-09-28T00:45:00.000Z"}],
  heartbeatNextAt: null, attention: emptyAttention,
};

describe("owner work overview", () => {
  it("does not mistake an enabled employee or recent completion for active work", () => {
    const view = deriveOwnerWorkOverview(base, asOf);
    expect(view.execution.state).toBe("scheduled");
    expect(view.execution.title).toBe("当前未运行");
    expect(view.execution.nextLabel).toBe("next check");
  });

  it("requires a matching live lease before claiming a run is executing", () => {
    const run = {id: "run-a", status: "running", triggerReason: {type: "loop_execution"},
      startedAt: "2026-09-26T05:59:00.000Z", loopName: "market check", collaborationGoal: null};
    const stale = deriveOwnerWorkOverview({...base, run, leasePhase: "running",
      leaseRunId: run.id, leaseUntil: "2026-09-26T05:59:59.000Z"}, asOf);
    expect(stale.execution.state).toBe("uncertain");
    const live = deriveOwnerWorkOverview({...base, run, leasePhase: "running",
      leaseRunId: run.id, leaseUntil: "2026-09-26T06:01:00.000Z"}, asOf);
    expect(live.execution.state).toBe("running");
    expect(live.execution.title).toBe("market check");
    const contradictory = deriveOwnerWorkOverview({...base, run: {...run, status: "queued"},
      leasePhase: "running", leaseRunId: run.id, leaseUntil: "2026-09-26T06:01:00.000Z"}, asOf);
    expect(contradictory.execution.state).toBe("uncertain");
  });

  it("keeps owner decisions separate from drafts and uncertain outbox records", () => {
    const view = deriveOwnerWorkOverview({...base, attention: {
      ...emptyAttention, drafts: 9, outboxUnknown: 9, outboxBlocked: 1, loopBlocker: 1,
    }}, asOf);
    expect(view.attention.review + view.attention.loopApproval + view.attention.outboxApproval).toBe(0);
    expect(view.attention.drafts).toBe(9);
    expect(view.attention.outboxUnknown).toBe(9);
  });

  it("shows the temporary conversation task as the queued and active execution goal", () => {
    const run = { id: "conversation-run", status: "queued", triggerReason: {
      type: "conversation", content: "  清洗这份文件\n并生成 Markdown 分片  ",
    }, startedAt: null, loopName: null, collaborationGoal: null };
    const queued = deriveOwnerWorkOverview({ ...base, run }, asOf);
    expect(queued.execution).toMatchObject({ state: "queued", title: "临时任务：清洗这份文件 并生成 Markdown 分片" });
    const running = deriveOwnerWorkOverview({ ...base, run: { ...run, status: "running" },
      leasePhase: "running", leaseRunId: run.id, leaseUntil: "2026-09-26T06:01:00.000Z" }, asOf);
    expect(running.execution).toMatchObject({ state: "running", title: queued.execution.title });
    const long = deriveOwnerWorkOverview({ ...base, run: { ...run,
      triggerReason: { type: "conversation", content: "任务".repeat(200) } } }, asOf);
    expect(long.execution.title).toHaveLength(125);
    expect(long.execution.title.endsWith("…")).toBe(true);
  });

  it("shows a colleague reply as awaiting original-side verification", () => {
    const view = deriveOwnerWorkOverview({...base, collaboration: {
      status: "replied", recipientName: "colleague", problem: "old rationale",
      updatedAt: "2026-09-26T05:00:00.000Z",
    }}, asOf);
    expect(view.execution.state).toBe("needs_verification");
  });

  it("does not claim a past schedule is an upcoming run", () => {
    const view = deriveOwnerWorkOverview({...base, schedules: [
      {name: "missed check", nextAt: "2026-09-25T06:00:00.000Z"},
    ]}, asOf);
    expect(view.execution.state).toBe("uncertain");
    expect(view.execution.nextAt).toBeNull();
  });

  it("does not promise a scheduled run while the employee is paused", () => {
    const view = deriveOwnerWorkOverview({...base, workStatus: "paused"}, asOf);
    expect(view.execution.state).toBe("paused");
    expect(view.execution.nextAt).toBeNull();
  });
});
