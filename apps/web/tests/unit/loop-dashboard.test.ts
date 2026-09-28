import { describe, expect, it } from "vitest";
import {
  deriveLoopDashboardStatus,
  resolveDashboardNextScheduledRunAt,
  summarizeLoop,
  summarizeLoopRun,
  type LoopRunDashboardSummary,
} from "@/lib/loops";
import type { Loop, LoopRun, LoopState } from "@/lib/db/schema";

const now = new Date("2026-06-16T00:00:00.000Z");

const emptyExecutionTrace = {
  events: [],
  toolCallCount: 0,
  failedToolCallCount: 0,
  permissionDecisionCount: 0,
  durationMs: null,
};

function runtimeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "agent-runtime-run-snapshot.v1",
    engine: "pi",
    adapter: "pi-agent-core",
    adapterVersion: "0.85.1",
    selectionSource: "config",
    piProtocol: "openai-responses",
    model: "fixture-model",
    modelTier: "standard",
    modelSource: "user",
    promptHash: "p".repeat(64),
    allowedToolsHash: "t".repeat(64),
    policyHash: "c".repeat(64),
    runtimeHash: "r".repeat(64),
    allowedToolCount: 2,
    ...overrides,
  };
}

function loop(overrides: Partial<Loop> = {}): Loop {
  return {
    id: "loop-1",
    userId: "user-1",
    name: "Loop",
    description: null,
    goal: "Review risk",
    status: "active",
    triggerConfig: {},
    contextConfig: {},
    actionPolicy: {},
    verificationConfig: {},
    approvalPolicy: {},
    retryPolicy: {},
    escalationPolicy: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Loop;
}

function state(overrides: Partial<LoopState> = {}): LoopState {
  return {
    loopId: "loop-1",
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

describe("loop dashboard", () => {
  it("summarizes run verification and approval state", () => {
    const summary = summarizeLoopRun({
      id: "run-1",
      loopId: "loop-1",
      status: "needs_approval",
      startedAt: now,
      completedAt: now,
      outputSummary: "Needs approval",
      error: null,
      triggerReason: {},
      inputSnapshot: {},
      verificationResult: {
        verification: { passed: true },
        checker: { checkerType: "hybrid" },
        decision: { action: "needs_approval" },
        approval: { requiresApproval: true, denied: false },
        actionGuard: { mode: "advisory", blocked: false },
        modelChecker: {
          enabled: true,
          reason: "Model checker is enabled for this loop.",
        },
        executionTrace: {
          events: [
            {
              type: "agent_configured",
              title: "Agent configured",
              timestamp: "2026-06-16T00:00:00.500Z",
              metadata: {
                runtimeRunSnapshot: runtimeSnapshot(),
              },
            },
            {
              type: "tool_used",
              title: "Tool used",
              toolName: "wechatDesktopSendMessage",
              status: "running",
              timestamp: "2026-06-16T00:00:01.000Z",
              metadata: {
                runtime: {
                  engine: "pi",
                  adapter: "pi-agent-core",
                },
              },
            },
            {
              type: "tool_result",
              title: "Tool completed",
              status: "completed",
              timestamp: "2026-06-16T00:00:02.000Z",
            },
            {
              type: "permission_decision",
              title: "Tool permission allowed",
              toolName: "wechatDesktopSendMessage",
              status: "completed",
              timestamp: "2026-06-16T00:00:01.500Z",
            },
          ],
          toolCallCount: 1,
          failedToolCallCount: 0,
          permissionDecisionCount: 1,
          durationMs: 1200,
        },
      },
      createdAt: now,
      updatedAt: now,
    } as LoopRun);

    expect(summary).toMatchObject({
      verificationPassed: true,
      checkerAction: "needs_approval",
      checkerType: "hybrid",
      requiresApproval: true,
      denied: false,
      actionGuardMode: "advisory",
      actionGuardBlocked: false,
      modelCheckerEnabled: true,
      modelCheckerReason: "Model checker is enabled for this loop.",
      executionTrace: {
        toolCallCount: 1,
        failedToolCallCount: 0,
        permissionDecisionCount: 1,
        durationMs: 1200,
      },
    });
    expect(summary.executionTrace.events[0]).toMatchObject({
      type: "agent_configured",
      runtimeSnapshot: {
        engine: "pi",
        adapter: "pi-agent-core",
        runtimeHash: "r".repeat(64),
        allowedToolCount: 2,
      },
    });
    expect(summary.executionTrace.events[1]).toMatchObject({
      type: "tool_used",
      toolName: "wechatDesktopSendMessage",
      metadata: {
        runtime: {
          engine: "pi",
          adapter: "pi-agent-core",
        },
      },
    });
  });

  it("derives needs approval before blocked or error", () => {
    const latestRun: LoopRunDashboardSummary = {
      id: "run-1",
      status: "blocked",
      startedAt: now,
      completedAt: now,
      outputSummary: null,
      error: null,
      verificationPassed: false,
      checkerAction: "block",
      checkerType: "deterministic",
      requiresApproval: true,
      denied: false,
      actionGuardMode: null,
      actionGuardBlocked: false,
      modelCheckerEnabled: false,
      modelCheckerReason: null,
      executionTrace: emptyExecutionTrace,
    };

    expect(
      deriveLoopDashboardStatus({
        loop: loop(),
        state: state({ currentPhase: "blocked" }),
        latestRun,
      }),
    ).toBe("needs_approval");
  });

  it("derives pending owner activation as needs approval even when paused", () => {
    expect(
      deriveLoopDashboardStatus({
        loop: loop({ status: "paused" }),
        state: state({
          currentPhase: "approval",
          stateJson: {
            requiresOwnerActivation: true,
            ownerActivationStatus: "pending",
          },
        }),
        latestRun: null,
      }),
    ).toBe("needs_approval");
  });

  it("derives blocked and error dashboard states", () => {
    expect(
      deriveLoopDashboardStatus({
        loop: loop(),
        state: state({ currentPhase: "retry_recommended" }),
        latestRun: null,
      }),
    ).toBe("blocked");

    expect(
      deriveLoopDashboardStatus({
        loop: loop(),
        state: state({ currentPhase: "error" }),
        latestRun: null,
      }),
    ).toBe("error");
  });

  it("does not derive blocked from a latest blocked run that was explicitly cleared", () => {
    const latestRun: LoopRunDashboardSummary = {
      id: "run-1",
      status: "blocked",
      startedAt: now,
      completedAt: now,
      outputSummary: null,
      error: null,
      verificationPassed: false,
      checkerAction: "block",
      checkerType: "deterministic",
      requiresApproval: false,
      denied: false,
      actionGuardMode: null,
      actionGuardBlocked: false,
      modelCheckerEnabled: false,
      modelCheckerReason: null,
      executionTrace: emptyExecutionTrace,
    };

    expect(
      deriveLoopDashboardStatus({
        loop: loop(),
        state: state({
          currentPhase: "idle",
          stateJson: {
            blockedClearedLoopRunId: "run-1",
            blockedClearedAt: "2026-08-13T00:00:00.000Z",
          },
        }),
        latestRun,
      }),
    ).toBe("active");
  });

  it("does not derive error from a latest failed run dismissed without rerun", () => {
    const latestRun: LoopRunDashboardSummary = {
      id: "run-1",
      status: "failed",
      startedAt: now,
      completedAt: now,
      outputSummary: null,
      error: "ZodError: invalid structured output",
      verificationPassed: false,
      checkerAction: "block",
      checkerType: "deterministic",
      requiresApproval: false,
      denied: false,
      actionGuardMode: null,
      actionGuardBlocked: false,
      modelCheckerEnabled: false,
      modelCheckerReason: null,
      executionTrace: emptyExecutionTrace,
    };

    expect(
      deriveLoopDashboardStatus({
        loop: loop(),
        state: state({
          currentPhase: "idle",
          stateJson: {
            blockerDismissedLoopRunId: "run-1",
            blockerDismissedAt: "2026-08-13T00:00:00.000Z",
          },
        }),
        latestRun,
      }),
    ).toBe("active");
  });

  it("does not re-add a failed run dismissed by timestamp before explicit dismiss ids existed", () => {
    const latestRun: LoopRunDashboardSummary = {
      id: "run-1",
      status: "failed",
      startedAt: new Date("2026-08-13T00:00:00.000Z"),
      completedAt: new Date("2026-08-13T00:01:00.000Z"),
      outputSummary: null,
      error: "ZodError: invalid structured output",
      verificationPassed: false,
      checkerAction: "block",
      checkerType: "deterministic",
      requiresApproval: false,
      denied: false,
      actionGuardMode: null,
      actionGuardBlocked: false,
      modelCheckerEnabled: false,
      modelCheckerReason: null,
      executionTrace: emptyExecutionTrace,
    };

    expect(
      deriveLoopDashboardStatus({
        loop: loop(),
        state: state({
          currentPhase: "idle",
          stateJson: {
            blockerClearedAt: "2026-08-13T00:02:00.000Z",
          },
        }),
        latestRun,
      }),
    ).toBe("active");
  });

  it("derives blocked when action guard enforces a failed block", () => {
    const latestRun: LoopRunDashboardSummary = {
      id: "run-1",
      status: "blocked",
      startedAt: now,
      completedAt: now,
      outputSummary: null,
      error: null,
      verificationPassed: true,
      checkerAction: "complete",
      checkerType: "deterministic",
      requiresApproval: false,
      denied: true,
      actionGuardMode: "enforce",
      actionGuardBlocked: true,
      modelCheckerEnabled: false,
      modelCheckerReason: null,
      executionTrace: emptyExecutionTrace,
    };

    expect(
      deriveLoopDashboardStatus({
        loop: loop(),
        state: state(),
        latestRun,
      }),
    ).toBe("blocked");
  });

  it("keeps successful runs active when only suggested actions are blocked", () => {
    const latestRun: LoopRunDashboardSummary = {
      id: "run-1",
      status: "success",
      startedAt: now,
      completedAt: now,
      outputSummary: null,
      error: null,
      verificationPassed: true,
      checkerAction: "complete",
      checkerType: "deterministic",
      requiresApproval: false,
      denied: true,
      actionGuardMode: "enforce",
      actionGuardBlocked: true,
      modelCheckerEnabled: false,
      modelCheckerReason: null,
      executionTrace: emptyExecutionTrace,
    };

    expect(
      deriveLoopDashboardStatus({
        loop: loop(),
        state: state({ stateJson: { lastJobStatus: "success" } }),
        latestRun,
      }),
    ).toBe("active");
  });

  it("summarizes the loop task space from LoopSpec metadata", () => {
    const summary = summarizeLoop({
      loop: loop({
        triggerConfig: {
          type: "cron",
          expression: "0 9 * * *",
          timezone: "Asia/Shanghai",
        },
        approvalPolicy: {
          externalWrites: "allow",
        },
        contextConfig: {
          instructions: "Fetch weather",
        },
      }),
      state: state({
        stateJson: {
          loopSpec: {
            metadata: {
              harness: "loop-run-harness",
              agents: {
                planner: "natural-language-planner",
                executor: "native-loop-executor",
                verifier: "loop-verifier",
              },
              weather: {
                city: "北京",
              },
              delivery: {
                platform: "wechat_desktop",
                recipientName: "文件传输助手",
              },
            },
          },
        },
      }),
      latestRun: null,
    });

    expect(summary.spaceSummary).toMatchObject({
      triggerLabel: "Cron 0 9 * * *",
      contextLabel: "北京",
      deliveryLabel: "微信：文件传输助手",
      plannerAgent: "natural-language-planner",
      executorAgent: "native-loop-executor",
      verifierAgent: "loop-verifier",
      harness: "loop-run-harness",
      externalWriteMode: "auto",
      permissionLabel: "按任务自动执行",
    });
  });

  it("advances stale cron next run for dashboard display after the missed-run grace window", () => {
    const summaryNext = resolveDashboardNextScheduledRunAt({
      loop: loop({
        triggerConfig: {
          type: "cron",
          expression: "40 9 * * 1-5",
          timezone: "Asia/Shanghai",
        },
      }),
      stateJson: {
        nextScheduledRunAt: "2026-08-24T01:40:00.000Z",
      },
      now: new Date("2026-08-24T07:54:32.000Z"),
    });

    expect(summaryNext).toBe("2026-08-25T01:40:00.000Z");
  });

  it("keeps due cron next run visible while it is still inside the grace window", () => {
    const summaryNext = resolveDashboardNextScheduledRunAt({
      loop: loop({
        triggerConfig: {
          type: "cron",
          expression: "45 15 * * 1-5",
          timezone: "Asia/Shanghai",
        },
      }),
      stateJson: {
        nextScheduledRunAt: "2026-08-24T07:45:00.000Z",
      },
      now: new Date("2026-08-24T07:54:32.000Z"),
    });

    expect(summaryNext).toBe("2026-08-24T07:45:00.000Z");
  });
});
