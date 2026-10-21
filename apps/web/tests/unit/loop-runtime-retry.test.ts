import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobExecutionResult } from "@/lib/cron/types";
import type { Loop } from "@/lib/db/schema";

const now = new Date("2026-06-30T00:00:00.000Z");
const loops = vi.hoisted(() => new Map<string, Loop>());
const completeLoopRunMock = vi.hoisted(() => vi.fn());
const upsertLoopStateMock = vi.hoisted(() => vi.fn());
const checkpointFixture = vi.hoisted(() => ({ lease: null as Record<string, unknown> | null, snapshots: [] as unknown[], workshop: null as unknown }));
vi.mock('@/lib/db/client', () => ({ db: { execute: vi.fn(async () => checkpointFixture.snapshots) } }));
vi.mock('@/lib/work-runtime/execution-context', () => ({ resolveExecutionLease: vi.fn(() => checkpointFixture.lease) }));
vi.mock('@/lib/work-runtime/execution-guard', () => ({ createExecutionGuard: vi.fn(() => async () => undefined) }));
vi.mock('@/lib/brain/memory-dependencies', () => ({ assertMemoryDependenciesCurrentInTransaction: vi.fn(async () => undefined) }));

// Isolate retry policy; real PostgreSQL tests cover durable admission and fencing.
vi.mock("@/lib/work-runtime/loop-execution", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/work-runtime/loop-execution")>(),
  executeAcceptedWorkLoop: vi.fn(async (_command, execute) => execute(new AbortController())),
  withLinkedLoopWrite: vi.fn(async (_loopId, work) => work({ db: { execute: async () => [] }, append: async () => ({}) })),
}));
import {executeAcceptedWorkLoop} from "@/lib/work-runtime/loop-execution";
vi.mock("@/lib/workshops/service",()=>({getWorkshop:vi.fn(async()=>checkpointFixture.workshop),
  listWorkshopEvents:vi.fn(async()=>[]),appendWorkshopEvent:vi.fn(async()=>({id:'checkpoint-receipt'}))}));

vi.mock("@/lib/ai/user-llm-api-settings", () => ({
  getUserLlmProviderConfig: vi.fn(async () => null),
}));

vi.mock("@/lib/loops/service", () => ({
  completeLoopRun: completeLoopRunMock,
  createLoopApprovalRequest: vi.fn(),
  createLoop: vi.fn(),
  createLoopRun: vi.fn(async () => ({
    id: "run-1",
    loopId: "loop-1",
    status: "running",
    triggerReason: {},
    inputSnapshot: {},
    outputSummary: null,
    verificationResult: null,
    error: null,
    startedAt: now,
    completedAt: null,
  })),
  getLoop: vi.fn(async (_userId: string, loopId: string) => loops.get(loopId) ?? null),
  getLoopState: vi.fn(async () => null),
  listLoops: vi.fn(async () => []),
  upsertLoopState: upsertLoopStateMock,
}));

import { runNativeLoopOnce } from "@/lib/loops/runtime";

function loop(overrides: Partial<Loop> = {}): Loop {
  return {
    id: "loop-1",
    userId: "user-1",
    workshopId: "work-1",
    name: "Daily report",
    description: null,
    goal: "Send a daily report",
    status: "active",
    triggerConfig: { type: "cron", cron: "0 9 * * *" },
    contextConfig: {},
    actionPolicy: {},
    verificationConfig: {
      type: "structured_check",
      requiredFields: ["outcome"],
      requiredSources: [],
      successCriteria: ["Has a final outcome"],
    },
    approvalPolicy: {},
    retryPolicy: { maxAttempts: 2, onFailure: "summarize_and_block" },
    escalationPolicy: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Loop;
}

describe("native loop runtime retry", () => {
  beforeEach(() => {
    loops.clear();
    completeLoopRunMock.mockReset();
    upsertLoopStateMock.mockReset();
    checkpointFixture.lease = null;
    checkpointFixture.snapshots = [];
    checkpointFixture.workshop = null;
  });

  it('does not save a business checkpoint when the actual run binding cannot be verified',async()=>{
    loops.set('loop-1',loop({retryPolicy:{maxAttempts:1}}));
    await runNativeLoopOnce({userId:'user-1',loopId:'loop-1',triggeredBy:'manual',execute:async()=>({status:'success',duration:1,output:'Research draft',
      result:{structuredReport:{outcome:'A provisional study',checkpoint:{nextQuestions:['Verify the current outbox implementation'],pendingVerification:['Check current source revision'],opportunityStates:{outbox:'study'}}}}})});
    const state = upsertLoopStateMock.mock.calls.at(-1)?.[1];
    expect(state?.stateJson).toMatchObject({ businessCheckpointOutcome: { status: 'omitted', reason: 'applicability_snapshot_unavailable' } });
    expect(state?.stateJson).not.toHaveProperty('businessCheckpoint');
    expect(state?.openQuestions ?? []).not.toContain('Verify the current outbox implementation');
  });

  it('saves the actual host run binding even if the current Work or model report names another project',async()=>{
    loops.set('loop-1',loop({retryPolicy:{maxAttempts:1}}));
    checkpointFixture.lease={userId:'user-1',workshopId:'work-1',runId:'run-1',workerId:'worker',token:1};
    checkpointFixture.snapshots=[{snapshot_json:{schemaVersion:'agent-runtime-run-snapshot.v1',extra:{workshopId:'work-1',workingMemoryPolicy:{applicabilityHash:'a'.repeat(64)}}}}];
    checkpointFixture.workshop={id:'work-1',userId:'user-1',status:'active',autonomyLevel:'auto',boundaryPolicy:{},modelConfig:{memoryApplicability:{schemaVersion:'memory-applicability.v1',scenarioKeys:['project:beta']}}};
    await runNativeLoopOnce({userId:'user-1',loopId:'loop-1',triggeredBy:'manual',execute:async()=>({status:'success',duration:1,output:'Research draft',
      result:{structuredReport:{outcome:'A provisional study',checkpoint:{nextQuestions:['Verify Alpha source'],applicabilityHash:'b'.repeat(64)}}}})});
    expect(upsertLoopStateMock).toHaveBeenLastCalledWith('loop-1',expect.objectContaining({
      openQuestions:expect.arrayContaining(['Verify Alpha source']),stateJson:expect.objectContaining({businessCheckpoint:expect.objectContaining({
        applicabilityHash:'a'.repeat(64),sourceRunId:'run-1',receiptEventId:'checkpoint-receipt'}),businessCheckpointOutcome:{status:'saved'}}),
    }));
  });

  it("retries native execution with checker feedback before completing the run", async () => {
    loops.set("loop-1", loop());
    const execute = vi.fn(async ({ attemptContext }): Promise<JobExecutionResult> => {
      if (attemptContext?.attemptNumber === 1) {
        return {
          status: "success",
          output: "drafted",
          duration: 10,
          result: {
            structuredReport: {
              summary: "Drafted the report.",
              reasoningChain: [],
              suggestedActions: [],
            },
          },
        };
      }

      expect(attemptContext).toMatchObject({
        attemptNumber: 2,
        maxAttempts: 2,
      });
      expect(attemptContext?.previousFeedback).toContain(
        'Required field "outcome" was not observed',
      );

      return {
        status: "success",
        output: "sent",
        duration: 12,
        result: {
          structuredReport: {
            summary: "Sent the report.",
            outcome: "Report delivered.",
            reasoningChain: [],
            suggestedActions: [],
          },
        },
      };
    });

    const result = await runNativeLoopOnce({
      userId: "user-1",
      loopId: "loop-1",
      triggeredBy: "scheduler",
      execute,
    });

    expect(result.output).toBe("sent");
    expect(executeAcceptedWorkLoop).toHaveBeenCalledWith(expect.objectContaining({workId:"work-1",loopId:"loop-1"}),expect.any(Function));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(completeLoopRunMock).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        status: "success",
      }),
    );
    expect(upsertLoopStateMock).toHaveBeenLastCalledWith(
      "loop-1",
      expect.objectContaining({
        currentPhase: "idle",
        stateJson: expect.objectContaining({
          lastAutoAttemptCount: 2,
          lastOutcomeAction: "complete",
          lastAttemptsUsed: 2,
        }),
      }),
    );
  });
});
