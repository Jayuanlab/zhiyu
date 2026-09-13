import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Loop, LoopState } from "@/lib/db/schema";

const now = new Date("2026-06-16T00:00:00.000Z");

const stateByLoopId = vi.hoisted(() => new Map<string, LoopState>());
const loops = vi.hoisted(() => [] as Loop[]);
const runLoopHarnessMock = vi.hoisted(() => vi.fn());
const runWorkshopLoopOnceMock = vi.hoisted(() => vi.fn());
const dispatchScheduledWorkLoopMock=vi.hoisted(()=>vi.fn());
const executeWorkshopLoopCommandMock=vi.hoisted(()=>vi.fn());
vi.mock('@/lib/work-runtime/loop-schedule',()=>({dispatchScheduledWorkLoop:dispatchScheduledWorkLoopMock}));

vi.mock("@/lib/loops/service", () => ({
  getLoopState: vi.fn(async (loopId: string) => stateByLoopId.get(loopId) ?? null),
  listLoops: vi.fn(async () => loops),
  upsertLoopState: vi.fn(async (loopId: string, input: Partial<LoopState>) => {
    const existing = stateByLoopId.get(loopId) ?? state(loopId);
    const updated = {
      ...existing,
      ...input,
      stateJson: {
        ...(existing.stateJson as Record<string, unknown>),
        ...((input.stateJson as Record<string, unknown> | undefined) ?? {}),
      },
      updatedAt: now,
    } as LoopState;
    stateByLoopId.set(loopId, updated);
    return updated;
  }),
}));

vi.mock("@/lib/loops/harness", () => ({
  runLoopHarness: runLoopHarnessMock,
}));

vi.mock("@/lib/workshops/loop-runtime", () => ({
  runWorkshopLoopOnce: runWorkshopLoopOnceMock,
  executeWorkshopLoopCommand:executeWorkshopLoopCommandMock,
}));

import {upsertLoopState} from "@/lib/loops/service";
import { listDueNativeLoops, runDueNativeLoops } from "@/lib/loops/native-scheduler";

function loop(overrides: Partial<Loop> = {}): Loop {
  return {
    id: "loop-1",
    userId: "user-1",
    workshopId: null,
    name: "Loop",
    description: null,
    goal: "Review risk",
    status: "active",
    triggerConfig: { type: "once", at: "2026-06-16T00:00:00.000Z" },
    contextConfig: {},
    actionPolicy: {},
    verificationConfig: {},
    approvalPolicy: {},
    retryPolicy: {},
    escalationPolicy: {},
    createdAt: new Date(now.getTime()-60_000),
    updatedAt: new Date(now.getTime()-60_000),
    ...overrides,
  } as Loop;
}

function state(loopId = "loop-1", overrides: Partial<LoopState> = {}): LoopState {
  return {
    loopId,
    currentPhase: "idle",
    memorySummary: null,
    openQuestions: [],
    lastObservation: null,
    nextAction: null,
    blockedReason: null,
    stateJson: {},
    updatedAt: now,
    ...overrides,
  } as LoopState;
}

describe("native loop scheduler", () => {
 beforeEach(()=>{stateByLoopId.clear();loops.length=0;vi.clearAllMocks();dispatchScheduledWorkLoopMock.mockReset();executeWorkshopLoopCommandMock.mockReset();});
 it.each([
 {type:"once",at:"2026-06-16T00:00:00.000Z"},
 {type:"cron",expression:"0 9 * * *",timezone:"Asia/Shanghai"},
 {type:"cron",expression:"10 9 * * 1-5",timezone:"Asia/Shanghai",tradingCalendar:"a-share"}
 ])("observes due $type slots without changing state",async triggerConfig=>{
 loops.push(loop({triggerConfig} as Partial<Loop>));
 const original=state("loop-1",{lastObservation:"preserved",stateJson:{nextScheduledRunAt:"2026-10-01T01:10:00.000Z"}});
 stateByLoopId.set("loop-1",original);
 expect(await listDueNativeLoops({userId:"user-1",now:new Date("2026-10-03T02:00:00Z")})).toHaveLength(1);
 expect(stateByLoopId.get("loop-1")).toEqual(original);expect(upsertLoopState).not.toHaveBeenCalled();
 });
 it("does not persist an initial cursor or include future and manual loops",async()=>{
 loops.push(loop(),loop({id:"future",triggerConfig:{type:"once",at:"2030-01-01T00:00:00Z"}}),loop({id:"manual",triggerConfig:{type:"manual"}}));
 expect((await listDueNativeLoops({userId:"user-1",now})).map(x=>x.loop.id)).toEqual(["loop-1"]);
 expect(stateByLoopId.size).toBe(0);expect(upsertLoopState).not.toHaveBeenCalled();
 });
 it.each(["agent","dry_run"] as const)("rejects standalone %s scheduling without advancing or executing",async executionMode=>{
 loops.push(loop());const original=state("loop-1",{stateJson:{nextScheduledRunAt:now.toISOString()},lastObservation:"keep"});
 stateByLoopId.set("loop-1",original);
 expect(await runDueNativeLoops({userId:"user-1",now,executionMode,awaitCompletion:true})).toMatchObject({launched:0,skipped:1,errors:[{loopId:"loop-1",code:"loop_migration_required"}]});
 expect(stateByLoopId.get("loop-1")).toEqual(original);
 expect(upsertLoopState).not.toHaveBeenCalled();expect(runLoopHarnessMock).not.toHaveBeenCalled();
 expect(dispatchScheduledWorkLoopMock).not.toHaveBeenCalled();expect(executeWorkshopLoopCommandMock).not.toHaveBeenCalled();
 });
 it.each([true,false])("queues Work slots and consumes only when requested (%s)",async awaitCompletion=>{
 loops.push(loop({workshopId:"work-1"}));
 dispatchScheduledWorkLoopMock.mockResolvedValue({state:"accepted",replayed:false,runId:"run-1",request:{commandId:"slot"}});
 expect(await runDueNativeLoops({userId:"user-1",now,executionMode:"dry_run",awaitCompletion})).toEqual({launched:awaitCompletion?1:0,skipped:0,queued:1});
 expect(dispatchScheduledWorkLoopMock).toHaveBeenCalledWith({userId:"user-1",workId:"work-1",loopId:"loop-1",scheduledAt:now.toISOString(),mode:"dry_run"});
 expect(executeWorkshopLoopCommandMock).toHaveBeenCalledTimes(awaitCompletion?1:0);
 if(awaitCompletion)expect(executeWorkshopLoopCommandMock).toHaveBeenCalledWith({commandId:"slot"},{acceptedRunId:"run-1",workerId:expect.any(String),signal:undefined});
 expect(upsertLoopState).not.toHaveBeenCalled();
 });
 it.each([{state:"accepted",replayed:true},{state:"skipped"},{state:"busy"}])("does not execute replayed or unaccepted slots",async result=>{
 loops.push(loop({workshopId:"work-1"}));dispatchScheduledWorkLoopMock.mockResolvedValue(result);
 expect(await runDueNativeLoops({userId:"user-1",now,awaitCompletion:true})).toEqual({launched:0,skipped:1});
 expect(executeWorkshopLoopCommandMock).not.toHaveBeenCalled();
 });
 it("returns failures and continues with the next Work",async()=>{
 loops.push(loop({workshopId:"work-1"}),loop({id:"loop-2",workshopId:"work-2"}));
 dispatchScheduledWorkLoopMock.mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValueOnce({state:"accepted",replayed:false,runId:"run-2",request:{}});
 expect(await runDueNativeLoops({userId:"user-1",now})).toEqual({launched:0,queued:1,skipped:1,errors:[{loopId:"loop-1",message:"database unavailable"}]});
 expect(upsertLoopState).not.toHaveBeenCalled();
 });
 it("does nothing without an owner",async()=>{
 loops.push(loop({workshopId:"work-1"}));expect(await runDueNativeLoops({now})).toEqual({launched:0,skipped:0});expect(dispatchScheduledWorkLoopMock).not.toHaveBeenCalled();
 });
 it('stops further admission after cancellation during a committed dispatch',async()=>{
   const controller=new AbortController();
   loops.push(loop({workshopId:'work-1'}),loop({id:'loop-2',workshopId:'work-2'}));
   dispatchScheduledWorkLoopMock.mockImplementationOnce(async()=>{
     controller.abort();return {state:'accepted',replayed:false,runId:'run-1',request:{}};
   });
   expect(await runDueNativeLoops({userId:'user-1',now,signal:controller.signal,awaitCompletion:true}))
     .toEqual({launched:0,skipped:0,queued:1});
   expect(dispatchScheduledWorkLoopMock).toHaveBeenCalledTimes(1);
   expect(executeWorkshopLoopCommandMock).not.toHaveBeenCalled();
 });
 it('does not dispatch with an already aborted signal',async()=>{
   loops.push(loop({workshopId:'work-1'}));
   await runDueNativeLoops({userId:'user-1',now,signal:AbortSignal.abort()});
   expect(dispatchScheduledWorkLoopMock).not.toHaveBeenCalled();
 });
});
