import { beforeEach, describe, expect, it, vi } from "vitest";

const listRunnableJobsMock = vi.hoisted(() => vi.fn());
const processInteractionEventsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/interactions/processing-jobs", () => ({
  listRunnableInteractionProcessingJobs: listRunnableJobsMock,
}));

vi.mock("@/lib/interactions/processor", () => ({
  processInteractionEvents: processInteractionEventsMock,
}));

import { runPendingInteractionProcessingJobs } from "@/lib/interactions/worker";

describe("interaction processing worker", () => {
  it('keeps active work occupied, cancels pending queue slots and passes the host signal',async()=>{
    const controller=new AbortController();let finish!:(value:unknown)=>void;
    listRunnableJobsMock.mockResolvedValue([1,2,3].map(n=>({id:`job-${n}`,eventIds:[`event-${n}`],processingMode:'full'})));
    processInteractionEventsMock.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    let settled=false;
    const run=runPendingInteractionProcessingJobs({userId:'user-1',signal:controller.signal,concurrency:1}).then(result=>{settled=true;return result;});
    await vi.waitFor(()=>expect(processInteractionEventsMock).toHaveBeenCalledTimes(1));
    controller.abort();expect(settled).toBe(false);
    expect(processInteractionEventsMock.mock.calls[0][0].signal).toBe(controller.signal);
    finish({mode:'llm'});
    expect(await run).toEqual({completed:1,failed:0,skipped:2});
    expect(processInteractionEventsMock).toHaveBeenCalledTimes(1);
  });
  it('exposes fallback summaries as degraded and does not count inaccessible events as completed',async()=>{
    listRunnableJobsMock.mockResolvedValue([1,2].map(n=>({id:`job-${n}`,eventIds:[`event-${n}`],processingMode:'full'})));
    processInteractionEventsMock.mockResolvedValueOnce({mode:'fallback_summary'}).mockResolvedValueOnce({mode:'skipped'});
    expect(await runPendingInteractionProcessingJobs({userId:'user-1'})).toEqual({completed:1,degraded:1,failed:0,skipped:1});
  });
  beforeEach(() => {
    listRunnableJobsMock.mockReset();
    processInteractionEventsMock.mockReset();
  });

  it("replays durable jobs with their stored event IDs and mode", async () => {
    listRunnableJobsMock.mockResolvedValue([
      {
        id: "job-1",
        eventIds: ["event-1", "event-2"],
        processingMode: "summary_only",
      },
    ]);
    processInteractionEventsMock.mockResolvedValue({ mode: "llm" });

    const result = await runPendingInteractionProcessingJobs({
      userId: "user-1",
    });

    expect(result).toEqual({ completed: 1, failed: 0, skipped: 0 });
    expect(processInteractionEventsMock).toHaveBeenCalledWith({
      userId: "user-1",
      eventIds: ["event-1", "event-2"],
      processingMode: "summary_only",
      processingJobId: "job-1",
      fallbackToSummary: true,
    });
  });

  it("leaves failures available for the persisted retry policy", async () => {
    listRunnableJobsMock.mockResolvedValue([
      {
        id: "job-2",
        eventIds: ["event-3"],
        processingMode: "full",
      },
    ]);
    processInteractionEventsMock.mockRejectedValue(new Error("provider down"));

    const result = await runPendingInteractionProcessingJobs({
      userId: "user-1",
    });

    expect(result).toEqual({ completed: 0, failed: 1, skipped: 0 });
  });
});
