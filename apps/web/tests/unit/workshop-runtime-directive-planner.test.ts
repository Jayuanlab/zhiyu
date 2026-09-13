import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Loop,
  Workshop,
  WorkshopDirective,
  WorkshopEvent,
  WorkshopRun,
} from "@/lib/db/schema";

const now = new Date("2026-07-07T00:00:00.000Z");
const events = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const appendWorkshopEventMock = vi.hoisted(() => vi.fn());
const completeWorkshopRunMock = vi.hoisted(() => vi.fn());
const createOutboxDraftMock = vi.hoisted(() => vi.fn());
const executeWorkshopAgentMock = vi.hoisted(() => vi.fn());
const listActiveDirectivesMock = vi.hoisted(() => vi.fn());
const listLoopsForWorkshopMock = vi.hoisted(() => vi.fn());
const planWorkshopDirectiveMock = vi.hoisted(() => vi.fn());
const proposeWorkshopLoopFromNaturalLanguageMock = vi.hoisted(() => vi.fn());
const fenceMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/work-runtime/run-output',()=>({captureRunOutput:vi.fn(async(_lease,value)=>value),readCapturedRunOutput:vi.fn(async()=>null)}));
vi.mock('@/lib/work-runtime/run-plan',()=>({readCapturedRunPlan:vi.fn(async()=>null),captureRunPlan:vi.fn(async(_lease,value)=>value),applyRunPlanStep:vi.fn(async(_lease,_step,write)=>write({append:appendWorkshopEventMock}))}));
vi.mock('@/lib/work-runtime/execution-lease',()=>({withExecutionWrite:fenceMock,renewExecutionLease:vi.fn(async()=>new Date())}));
import {resolveExecutionLease} from '@/lib/work-runtime/execution-context';
import {ExecutionLeaseError} from '@/lib/work-runtime/execution-errors';
import {captureCompletedWorkshopRunEvidence} from '@/lib/harness-evolution/capture-service';

vi.mock("@/lib/loops/service", () => ({
  listLoopsForWorkshop: listLoopsForWorkshopMock,
}));

vi.mock("@/lib/workshops/directive-planner", () => ({
  planWorkshopDirective: planWorkshopDirectiveMock,
}));

vi.mock("@/lib/workshops/executor", () => ({
  executeWorkshopAgent: executeWorkshopAgentMock,
}));

vi.mock("@/lib/workshops/heartbeat", () => ({
  scheduleWorkshopWakeupFromSuggestion: vi.fn(),
}));

vi.mock("@/lib/workshops/loop-service", () => ({
  proposeWorkshopLoopFromNaturalLanguage:
    proposeWorkshopLoopFromNaturalLanguageMock,
}));

vi.mock("@/lib/workshops/outbox-wechat", () => ({
  autoSendWorkshopOutboxIfWhitelisted: vi.fn(),
}));

vi.mock("@/lib/workshops/service", () => ({
  addWorkshopMemory: vi.fn(),
  appendWorkshopEvent: appendWorkshopEventMock,
  completeWorkshopRun: completeWorkshopRunMock,
  createOutboxDraft: createOutboxDraftMock,
  createWorkshopRun: vi.fn(),
  getWorkshop: vi.fn(),
  listActiveDirectives: listActiveDirectivesMock,
  listRecentSourceEventIds: vi.fn(async () => []),
  listWorkshopEvents: vi.fn(async () => []),
  listWorkshopMemories: vi.fn(async () => []),
  listWorkshopOutbox: vi.fn(async () => []),
  listWorkshopSources: vi.fn(async () => []),
}));

vi.mock("@/lib/harness-evolution/capture-service",()=>({captureCompletedWorkshopRunEvidence:vi.fn(),prepareRunHarnessCaptureContext:vi.fn()}));
vi.mock("@/lib/brain/service",()=>({createBrainStateSnapshot:vi.fn(),createBrainMemoryCandidate:vi.fn(),writeBrainMemory:vi.fn()}));

import {
  executeWorkshopRunLifecycle,
  startWorkshopRun,
  selectDirectivesForWorkshopRun,
} from "@/lib/workshops/runtime";

it('rejects the retired detached start entry',async()=>{
  await expect(startWorkshopRun({userId:'owner',workshopId:'work'})).rejects.toThrow('legacy_workshop_start_retired_use_work_runtime');
});

function workshop(overrides: Partial<Workshop> = {}): Workshop {
  return {
    id: "workshop-1",
    userId: "user-1",
    name: "Research workshop",
    mission: "Plan and run durable research work.",
    status: "active",
    autonomyLevel: "draft",
    boundaryPolicy: {},
    modelConfig: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Workshop;
}

function directive(
  overrides: Partial<WorkshopDirective> = {},
): WorkshopDirective {
  return {
    id: "directive-1",
    workshopId: "workshop-1",
    runId: null,
    content: "每个交易日开盘前生成关注列表",
    priority: 0,
    scope: "current_run",
    status: "active",
    createdAt: now,
    ...overrides,
  } as WorkshopDirective;
}

function run(overrides: Partial<WorkshopRun> = {}): WorkshopRun {
  return {
    id: "run-1",
    workshopId: "workshop-1",
    status: "running",
    triggerReason: {},
    inputSnapshot: {},
    outputSummary: null,
    error: null,
    startedAt: now,
    completedAt: null,
    createdAt: now,
    ...overrides,
  } as WorkshopRun;
}

function loop(overrides: Partial<Loop> = {}): Loop {
  return {
    id: "loop-existing",
    userId: "user-1",
    workshopId: "workshop-1",
    name: "盘前关注列表",
    description: "Every trading day before market open, generate a watchlist.",
    goal: "Generate a watchlist before market open on each trading day.",
    status: "paused",
    triggerConfig: {},
    contextConfig: {},
    actionPolicy: {},
    verificationConfig: {},
    approvalPolicy: {},
    retryPolicy: {},
    escalationPolicy: {},
    createdAt: now,
    updatedAt: now,
  } as Loop;
}

async function executeWithDirective() {
  await executeWorkshopRunLifecycle({
    userId: "user-1",
    workshop: workshop(),
    run: run(),
    triggerReason: {
      type: "directive",
      directiveId: "directive-1",
      content: "每个交易日开盘前生成关注列表",
    },
  });
}

describe("workshop runtime directive planning", () => {
  beforeEach(() => {
    fenceMock.mockReset();
    fenceMock.mockResolvedValue(undefined);
    vi.mocked(captureCompletedWorkshopRunEvidence).mockClear();
    events.length = 0;
    appendWorkshopEventMock.mockReset();
    appendWorkshopEventMock.mockImplementation(async (input) => {
      events.push(input);
      return {
        id: `event-${events.length}`,
        seq: events.length,
        createdAt: now,
        ...input,
      } as WorkshopEvent;
    });
    completeWorkshopRunMock.mockReset();
    completeWorkshopRunMock.mockResolvedValue(undefined);
    createOutboxDraftMock.mockReset();
    createOutboxDraftMock.mockResolvedValue({ id: "outbox-1" });
    executeWorkshopAgentMock.mockReset();
    executeWorkshopAgentMock.mockResolvedValue({
      status: "success",
      output: "run completed",
      structured: null,
      toolCallCount: 0,
      durationMs: 1,
    });
    listActiveDirectivesMock.mockReset();
    listActiveDirectivesMock.mockResolvedValue([directive()]);
    listLoopsForWorkshopMock.mockReset();
    listLoopsForWorkshopMock.mockResolvedValue([]);
    planWorkshopDirectiveMock.mockReset();
    proposeWorkshopLoopFromNaturalLanguageMock.mockReset();
    proposeWorkshopLoopFromNaturalLanguageMock.mockResolvedValue({
      loop: {
        id: "loop-1",
        name: "盘前关注列表",
        description: "Create watchlist before market open.",
      },
      draft: {},
    });
  });

  it("converts create_loop_task decisions into paused loop proposals", async () => {
    planWorkshopDirectiveMock.mockResolvedValue({
      action: "create_loop_task",
      confidence: 0.93,
      reason: "This is durable trading-day work.",
      taskIntent:
        "Every trading day before market open, generate a watchlist.",
      model: "planner-model",
    });

    await executeWithDirective();

    expect(proposeWorkshopLoopFromNaturalLanguageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        workshopId: "workshop-1",
        runId: "run-1",
        intent:
          "Every trading day before market open, generate a watchlist.",
        proposedBy: "workshop_agent",
        proposalReason: "This is durable trading-day work.",
      }),
    );
    expect(executeWorkshopAgentMock).not.toHaveBeenCalled();
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        status: "completed",
      }),
    );
    expect(events.map((event) => event.type)).toEqual([
      "directive_planned",
    ]);
  });

  it("skips create_loop_task proposals when a similar workshop loop already exists", async () => {
    listLoopsForWorkshopMock.mockResolvedValue([loop()]);
    planWorkshopDirectiveMock.mockResolvedValue({
      action: "create_loop_task",
      confidence: 0.93,
      reason: "This is durable trading-day work.",
      taskIntent:
        "Every trading day before market open, generate a watchlist.",
      model: "planner-model",
    });

    await executeWithDirective();

    expect(proposeWorkshopLoopFromNaturalLanguageMock).not.toHaveBeenCalled();
    expect(executeWorkshopAgentMock).not.toHaveBeenCalled();
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        status: "completed",
        outputSummary: "Skipped duplicate task proposal: 盘前关注列表",
      }),
    );
    expect(events.map((event) => event.type)).toEqual([
      "directive_planned",
      "directive_duplicate_ignored",
    ]);
  });

  it("passes run_once planning context into the full workshop agent", async () => {
    planWorkshopDirectiveMock.mockResolvedValue({
      action: "run_once",
      confidence: 0.86,
      reason: "This should be handled in the current run.",
      model: "planner-model",
    });

    await executeWithDirective();

    expect(executeWorkshopAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({
            type: "directive_planned",
            metadata: expect.objectContaining({
              action: "run_once",
            }),
          }),
        ]),
      }),
    );
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(expect.objectContaining({status:'completed'}));
  });

  it("keeps old current-run directives out of a newly triggered run", async () => {
    const staleDirective = directive({
      id: "directive-old",
      content: "分析机器人ETF鹏华",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    const currentDirective = directive({
      id: "directive-1",
      content: "分析汇川技术",
      createdAt: new Date("2026-08-03T00:00:00.000Z"),
    });
    const persistentDirective = directive({
      id: "directive-persistent",
      content: "长期保持交易更激进，少观察，多执行。",
      scope: "persistent",
    });

    expect(
      selectDirectivesForWorkshopRun({
        directives: [staleDirective, currentDirective, persistentDirective],
        runId: "run-1",
        trigger: {
          directiveId: "directive-1",
          content: "分析汇川技术",
        },
      }).map((item) => item.content),
    ).toEqual(["分析汇川技术", "长期保持交易更激进，少观察，多执行。"]);

    listActiveDirectivesMock.mockResolvedValue([
      staleDirective,
      currentDirective,
      persistentDirective,
    ]);
    planWorkshopDirectiveMock.mockResolvedValue({
      action: "run_once",
      confidence: 0.86,
      reason: "This should be handled in the current run.",
      model: "planner-model",
    });

    await executeWorkshopRunLifecycle({
      userId: "user-1",
      workshop: workshop(),
      run: run(),
      triggerReason: {
        type: "directive",
        directiveId: "directive-1",
        content: "分析汇川技术",
      },
    });

    expect(planWorkshopDirectiveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        directive: expect.objectContaining({ content: "分析汇川技术" }),
        activeDirectives: expect.arrayContaining([
          expect.objectContaining({ content: "分析汇川技术" }),
          expect.objectContaining({
            content: "长期保持交易更激进，少观察，多执行。",
          }),
        ]),
      }),
    );
    expect(executeWorkshopAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        directives: [
          expect.objectContaining({ content: "分析汇川技术" }),
          expect.objectContaining({
            content: "长期保持交易更激进，少观察，多执行。",
          }),
        ],
      }),
    );
    expect(executeWorkshopAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        directives: expect.not.arrayContaining([
          expect.objectContaining({ content: "分析机器人ETF鹏华" }),
        ]),
      }),
    );
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(expect.objectContaining({
      workshopId: "workshop-1",
      runId: "run-1",
      directiveIds: ["directive-1"],
    }));
  });

  it("logs planned subtasks and passes them into the full workshop agent", async () => {
    planWorkshopDirectiveMock.mockResolvedValue({
      action: "spawn_subtask",
      confidence: 0.88,
      reason: "The directive needs decomposition.",
      subtasks: [
        {
          title: "Collect market catalysts",
          goal: "Find important catalysts before market open.",
        },
        {
          title: "Rank watchlist candidates",
          goal: "Prioritize symbols by conviction.",
        },
      ],
      model: "planner-model",
    });

    await executeWithDirective();

    expect(executeWorkshopAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({ type: "directive_planned" }),
          expect.objectContaining({
            type: "directive_subtasks_planned",
            body: "Collect market catalysts\nRank watchlist candidates",
          }),
        ]),
      }),
    );
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(expect.objectContaining({status:'completed'}));
  });

  it("turns clarification decisions into owner-visible outbox drafts", async () => {
    planWorkshopDirectiveMock.mockResolvedValue({
      action: "ask_clarification",
      confidence: 0.8,
      reason: "Recipient is missing.",
      clarificationQuestion: "要把关注列表发给谁？",
      model: "planner-model",
    });

    await executeWithDirective();

    expect(createOutboxDraftMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workshopId: "workshop-1",
        runId: "run-1",
        message: "要把关注列表发给谁？",
        status: "draft",
        confidence: 80,
        riskLevel: "low",
        boundaryResult: expect.objectContaining({
          status: "needs_owner_input",
          directiveId: "directive-1",
          plannerAction: "ask_clarification",
        }),
      }),
    );
    expect(proposeWorkshopLoopFromNaturalLanguageMock).not.toHaveBeenCalled();
    expect(executeWorkshopAgentMock).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      "directive_planned",
      "directive_needs_clarification",
    ]);
  });

  it("falls back to the full workshop agent when planning fails", async () => {
    planWorkshopDirectiveMock.mockRejectedValue(new Error("planner unavailable"));

    await executeWithDirective();

    expect(executeWorkshopAgentMock).toHaveBeenCalledTimes(1);
    expect(proposeWorkshopLoopFromNaturalLanguageMock).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toContain(
      "directive_plan_failed",
    );
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(expect.objectContaining({status:'completed'}));
  });

  it('matches explicit directive identity and never borrows another run input',()=>{
    const selected=selectDirectivesForWorkshopRun({runId:'run-1',trigger:{directiveId:'wanted',content:'same'},directives:[
      directive({id:'wanted',content:'same'}),directive({id:'duplicate-text',content:'same'}),directive({id:'wanted',content:'same',runId:'another-run'}),
    ]});
    expect(selected.map(item=>item.id)).toEqual(['wanted']);
  });

  it('propagates the same capability through executor and completion',async()=>{
    listActiveDirectivesMock.mockResolvedValue([]);
    const lease={userId:'user-1',workshopId:'workshop-1',runId:'run-1',workerId:'worker',token:1};
    executeWorkshopAgentMock.mockImplementation(async input=>{
      expect(input.executionLease).toEqual(lease);
      expect(resolveExecutionLease()).toEqual(lease);
      return {status:'success',output:'ok',structured:null,toolCallCount:0,durationMs:1};
    });
    completeWorkshopRunMock.mockImplementation(async input=>{
      expect(input.lease).toEqual(lease);
      expect(resolveExecutionLease()).toEqual(lease);
    });
    await executeWorkshopRunLifecycle({userId:'user-1',workshop:workshop(),run:run(),executionLease:lease});
    expect(executeWorkshopAgentMock).toHaveBeenCalledOnce();
    expect(completeWorkshopRunMock).toHaveBeenCalledOnce();
    expect(resolveExecutionLease()).toBeUndefined();
  });

  it('rejects a mismatched capability before dispatch',async()=>{
    await expect(executeWorkshopRunLifecycle({userId:'user-1',workshop:workshop(),run:run(),executionLease:{userId:'other',workshopId:'workshop-1',runId:'run-1',workerId:'worker',token:1}})).rejects.toMatchObject({code:'invalid_lease'});
    expect(executeWorkshopAgentMock).not.toHaveBeenCalled();
    expect(completeWorkshopRunMock).not.toHaveBeenCalled();
  });

  it('does not turn lease loss after model output into failed completion',async()=>{
    listActiveDirectivesMock.mockResolvedValue([]);
    const controller=new AbortController();
    executeWorkshopAgentMock.mockImplementation(async()=>{
      fenceMock.mockRejectedValue(new ExecutionLeaseError('lease_lost'));
      return {status:'success',output:'late',structured:{outboxDrafts:[{message:'late'}]},toolCallCount:0,durationMs:1};
    });
    await expect(executeWorkshopRunLifecycle({userId:'user-1',workshop:workshop(),run:run(),abortController:controller,executionLease:{userId:'user-1',workshopId:'workshop-1',runId:'run-1',workerId:'worker',token:1}})).rejects.toMatchObject({code:'lease_lost'});
    expect(controller.signal.aborted).toBe(true);
    expect(completeWorkshopRunMock).not.toHaveBeenCalled();
    expect(createOutboxDraftMock).not.toHaveBeenCalled();
    expect(captureCompletedWorkshopRunEvidence).not.toHaveBeenCalled();
  });

  it('discards structured actions from an unsuccessful model result',async()=>{
    listActiveDirectivesMock.mockResolvedValue([]);
    executeWorkshopAgentMock.mockResolvedValue({status:'error',output:'partial',error:'failed',structured:{outboxDrafts:[{message:'must not send'}],nextWakeupSuggestion:{delayMinutes:30}},toolCallCount:1,durationMs:2});
    await executeWorkshopRunLifecycle({userId:'user-1',workshop:workshop(),run:run()});
    expect(createOutboxDraftMock).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(expect.objectContaining({status:'failed',outputSummary:'partial',error:'failed'}));
  });

  it('reports failure to atomic completion without an independent completion event',async()=>{
    planWorkshopDirectiveMock.mockResolvedValue({action:'run_once',confidence:1,reason:'test'});
    executeWorkshopAgentMock.mockRejectedValue(new Error('executor failed'));
    await executeWithDirective();
    expect(completeWorkshopRunMock).toHaveBeenCalledWith(expect.objectContaining({status:'failed',error:'executor failed',directiveIds:['directive-1']}));
    expect(events.some(event=>event.type==='run_completed'||event.type==='run_failed')).toBe(false);
  });
});
