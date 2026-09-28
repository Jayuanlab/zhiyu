import { describe, expect, it } from "vitest";
import type {
  Workshop,
  WorkshopEvent,
  WorkshopHeartbeat,
  WorkshopOutboxItem,
} from "@/lib/db/schema";
import type { LoopDashboardSummary } from "@/lib/loops/dashboard";
import {
  buildWorkshopDashboard,
  deriveWorkshopDashboardStatus,
  deriveWorkshopNextWork,
  summarizeWorkshopContextCost,
} from "@/lib/workshops/dashboard";

const now = new Date("2026-07-06T00:00:00.000Z");

function workshop(overrides: Partial<Workshop> = {}): Workshop {
  return {
    id: "workshop-1",
    userId: "user-1",
    name: "Research workshop",
    mission: "Track research signals.",
    status: "active",
    autonomyLevel: "draft",
    boundaryPolicy: {},
    modelConfig: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Workshop;
}

function loop(
  overrides: Partial<LoopDashboardSummary> = {},
): LoopDashboardSummary {
  return {
    id: "loop-1",
    workshopId: null,
    name: "Daily brief",
    description: null,
    goal: "Prepare a daily brief",
    status: "active",
    dashboardStatus: "active",
    triggerConfig: { type: "cron", expression: "0 9 * * *" },
    currentPhase: "idle",
    nextAction: null,
    blockedReason: null,
    lastObservation: null,
    stateJson: {},
    nextScheduledRunAt: null,
    lastScheduledRunAt: null,
    schedulerStatus: "idle",
    spaceSummary: {
      triggerLabel: "每天 09:00",
      contextLabel: "按任务说明收集上下文",
      deliveryLabel: null,
      plannerAgent: "planner",
      executorAgent: "executor",
      verifierAgent: "verifier",
      harness: "loop-run-harness",
      externalWriteMode: "manual_approval",
      permissionLabel: "执行前需要审批",
    },
    latestRun: null,
    updatedAt: now,
    createdAt: now,
    ...overrides,
  };
}

function outbox(
  overrides: Partial<WorkshopOutboxItem> = {},
): WorkshopOutboxItem {
  return {
    id: "outbox-1",
    workshopId: "workshop-1",
    runId: null,
    channel: "wechat_desktop",
    recipientName: "File Transfer",
    message: "Please review this draft.",
    status: "draft",
    confidence: 80,
    riskLevel: "low",
    sourceEventIds: [],
    boundaryResult: {},
    sentAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as WorkshopOutboxItem;
}

function heartbeat(
  overrides: Partial<WorkshopHeartbeat> = {},
): WorkshopHeartbeat {
  return {
    workshopId: "workshop-1",
    enabled: true,
    mode: "suggested",
    nextWakeupAt: null,
    lastWakeupAt: null,
    lastHeartbeatAt: null,
    schedulerStatus: "idle",
    schedulerError: null,
    consecutiveFailures: 0,
    leaseUntil: null,
    heartbeatPolicy: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as WorkshopHeartbeat;
}

function event(overrides: Partial<WorkshopEvent> = {}): WorkshopEvent {
  return {
    id: "event-1",
    workshopId: "workshop-1",
    runId: null,
    loopId: "loop-1",
    loopRunId: "run-1",
    seq: 1,
    type: "memory_written",
    title: "Found a durable signal",
    body: "Signal body",
    metadata: {},
    visibility: "user",
    createdAt: now,
    ...overrides,
  } as WorkshopEvent;
}

describe("workshop dashboard", () => {
  it("marks explicitly pending approval outbox as needs approval", () => {
    const status = deriveWorkshopDashboardStatus({
      workshop: workshop(),
      loops: [loop()],
      pendingOutbox: [outbox({status: "pending_approval"})],
      heartbeat: null,
    });

    expect(status).toBe("needs_approval");
  });

  it("does not treat loop suggested actions as actionable pending outbox", () => {
    const dashboard = buildWorkshopDashboard({
      workshop: workshop(),
      loops: [loop()],
      events: [],
      outbox: [
        outbox({
          boundaryResult: {
            source: "loop_suggested_action",
            loopId: "loop-1",
            requiresConfirmation: true,
          },
        }),
      ],
      memories: [],
      sources: [],
      heartbeat: null,
    });

    expect(dashboard.status).toBe("active");
    expect(dashboard.counts.pendingOutbox).toBe(0);
    expect(dashboard.pendingOutbox).toEqual([]);
  });

  it("prefers explicit error state over approval and blocked states", () => {
    const status = deriveWorkshopDashboardStatus({
      workshop: workshop(),
      loops: [
        loop({ dashboardStatus: "blocked" }),
        loop({ id: "loop-2", dashboardStatus: "needs_approval" }),
      ],
      pendingOutbox: [outbox()],
      heartbeat: heartbeat({ schedulerError: "lease failed" }),
    });

    expect(status).toBe("error");
  });

  it("picks the earliest next work from heartbeat and loops", () => {
    const next = deriveWorkshopNextWork({
      heartbeat: heartbeat({
        nextWakeupAt: new Date("2026-07-06T03:00:00.000Z"),
      }),
      loops: [
        loop({
          name: "Sooner loop",
          nextScheduledRunAt: "2026-07-06T02:00:00.000Z",
        }),
      ],
    });

    expect(next).toMatchObject({
      source: "loop",
      label: "Sooner loop",
      at: "2026-07-06T02:00:00.000Z",
    });
  });

  it("builds dashboard counts and recent finding", () => {
    const dashboard = buildWorkshopDashboard({
      workshop: workshop(),
      loops: [
        loop(),
        loop({ id: "loop-2", dashboardStatus: "blocked" }),
      ],
      events: [event()],
      outbox: [outbox(), outbox({ id: "outbox-2", status: "sent" })],
      memories: [],
      sources: [],
      heartbeat: null,
    });

    expect(dashboard.status).toBe("blocked");
    expect(dashboard.counts).toMatchObject({
      loops: 2,
      activeLoops: 2,
      pendingOutbox: 1,
      blockedLoops: 1,
    });
    expect(dashboard.recentFinding?.title).toBe("Found a durable signal");
  });

  it("surfaces pending loop proposals as approval work", () => {
    const dashboard = buildWorkshopDashboard({
      workshop: workshop(),
      loops: [
        loop({
          status: "paused",
          dashboardStatus: "needs_approval",
          currentPhase: "approval",
          stateJson: {
            requiresOwnerActivation: true,
            ownerActivationStatus: "pending",
          },
        }),
      ],
      events: [],
      outbox: [],
      memories: [],
      sources: [],
      heartbeat: null,
    });

    expect(dashboard.status).toBe("needs_approval");
    expect(dashboard.counts).toMatchObject({
      pendingLoopProposals: 1,
      pendingApprovals: 1,
    });
    expect(dashboard.pendingLoopProposals[0].id).toBe("loop-1");
  });

  it("summarizes context budget sections so oversized prompt sources are visible", () => {
    const summary = summarizeWorkshopContextCost([
      event({
        id: "runtime-1",
        type: "agent_configured",
        metadata: {
          runtime: {
            engine: "claude",
            adapter: "claude-agent-sdk",
          },
          runtimeSelection: {
            engine: "claude",
            source: "default",
          },
          modelTier: "standard",
          modelSource: "workshop",
          model: "claude-sonnet",
        },
      }),
      event({
        id: "runtime-2",
        type: "agent_configured",
        createdAt: new Date("2026-07-06T02:00:00.000Z"),
        metadata: {
          runtime: {
            engine: "pi",
            adapter: "pi-agent-core",
          },
          runtimeSelection: {
            engine: "pi",
            source: "workshop.modelConfig",
            piProtocol: "openai-responses",
          },
          modelTier: "high",
          modelSource: "workshop",
          model: "gpt-5.1",
          runtimeRunSnapshot: {
            schemaVersion: "agent-runtime-run-snapshot.v1",
            engine: "pi",
            adapter: "pi-agent-core",
            adapterVersion: "0.85.1",
            selectionSource: "workshop.modelConfig",
            piProtocol: "openai-responses",
            model: "gpt-5.1",
            modelTier: "high",
            modelSource: "workshop",
            runtimeHash:
              "runtimehash0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
            promptHash:
              "prompthash0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
            allowedToolsHash:
              "toolshash0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
            policyHash:
              "policyhash0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
            allowedToolCount: 3,
          },
        },
      }),
      event({
        id: "context-1",
        type: "context_budget_report",
        metadata: {
          profile: "normal",
          promptChars: 1000,
          estimatedPromptTokens: 250,
          sections: [
            {
              name: "events",
              chars: 600,
              estimatedTokens: 150,
              maxChars: 500,
              overBudget: true,
            },
            {
              name: "memoryContext",
              chars: 200,
              estimatedTokens: 50,
              maxChars: 1000,
              overBudget: false,
            },
          ],
          largestSections: [
            { name: "events", chars: 600, estimatedTokens: 150 },
          ],
        },
      }),
      event({
        id: "context-2",
        type: "context_budget_report",
        createdAt: new Date("2026-07-06T01:00:00.000Z"),
        metadata: {
          profile: "normal",
          promptChars: 2000,
          estimatedPromptTokens: 500,
          sections: [
            {
              name: "events",
              chars: 800,
              estimatedTokens: 200,
              maxChars: 500,
              overBudget: true,
            },
            {
              name: "memoryContext",
              chars: 900,
              estimatedTokens: 225,
              maxChars: 1000,
              overBudget: false,
            },
          ],
          largestSections: [
            { name: "memoryContext", chars: 900, estimatedTokens: 225 },
          ],
        },
      }),
    ]);

    expect(summary.recentReportCount).toBe(2);
    expect(summary.runtimeEngineCounts).toEqual({ claude: 1, pi: 1 });
    expect(summary.latestRuntime).toMatchObject({
      engine: "pi",
      adapter: "pi-agent-core",
      source: "workshop.modelConfig",
      piProtocol: "openai-responses",
      modelTier: "high",
      model: "gpt-5.1",
      runtimeHash:
        "runtimehash0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      promptHash:
        "prompthash0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      allowedToolsHash:
        "toolshash0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      policyHash:
        "policyhash0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      allowedToolCount: 3,
    });
    expect(summary.largestSection).toEqual({
      name: "memoryContext",
      chars: 900,
      estimatedTokens: 225,
    });
    expect(summary.sectionStats[0]).toMatchObject({
      name: "memoryContext",
      reportCount: 2,
      avgEstimatedTokens: 138,
      latestEstimatedTokens: 225,
      latestPromptShare: 0.45,
    });
    expect(summary.sectionStats.find((item) => item.name === "events")).toMatchObject({
      overBudgetCount: 2,
      maxEstimatedTokens: 200,
    });
  });
});
