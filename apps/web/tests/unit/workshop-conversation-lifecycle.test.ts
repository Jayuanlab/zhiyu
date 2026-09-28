import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/workshops/service", () => ({
  appendWorkshopEvent: vi.fn(async () => ({ id: "event-new" })),
  completeWorkshopRun: vi.fn(async () => ({ status: "completed" })),
  createOutboxDraft: vi.fn(),
  createWorkshopRun: vi.fn(),
  listActiveDirectives: vi.fn(async () => [{ id: "directive-1", runId: null, scope: "persistent", content: "Standing boundary" }]),
  listRecentSourceEventIds: vi.fn(async () => []),
  listWorkshopEvents: vi.fn(async () => [{ id: "event-1", runId: "old-run", type: "observation" }]),
  listWorkshopMemories: vi.fn(async () => []),
  listWorkshopOutbox: vi.fn(async () => []),
  listWorkshopSources: vi.fn(async () => [{ id: "permanent-source", type: "file", name: "Reference" }]),
}));
vi.mock("@/lib/loops/service", () => ({ listLoopsForWorkshop: vi.fn(async () => []) }));
vi.mock("@/lib/workshops/executor", () => ({ executeWorkshopAgent: vi.fn(async () => ({
  status: "success", output: "Direct reply", toolCallCount: 1, durationMs: 10,
  structured: {
    memoryCandidates: [{ content: "Do not save this" }],
    outboxDrafts: [{ message: "Do not send this", notifyReason: "owner_requested", whyNow: "Temporary reply" }],
    nextWakeupSuggestion: { reason: "Do not schedule this" },
  },
})) }));
vi.mock("@/lib/workshops/conversation-context", () => ({
  loadPersistentWorkshopEvents: vi.fn(async (_workId, events) => events.filter((event: { id: string }) => event.id !== "event-1")),
  loadWorkshopConversationContext: vi.fn(async () => ({ content: "Current question", history: [], inputFiles: [] })),
}));
vi.mock("@/lib/workshops/directive-planner", () => ({ planWorkshopDirective: vi.fn() }));
vi.mock("@/lib/brain/service", () => ({ createBrainMemoryCandidate: vi.fn(), writeBrainMemory: vi.fn() }));
vi.mock("@/lib/workshops/heartbeat", () => ({ scheduleWorkshopWakeupFromSuggestion: vi.fn() }));
vi.mock("@/lib/workshops/loop-service", () => ({ proposeWorkshopLoopFromNaturalLanguage: vi.fn() }));
vi.mock("@/lib/workshops/outbox-wechat", () => ({ autoSendWorkshopOutboxIfWhitelisted: vi.fn() }));
vi.mock("@/lib/harness-evolution/capture-service", () => ({ captureCompletedWorkshopRunEvidence: vi.fn() }));
vi.mock("@/lib/work-runtime/execution-context", () => ({
  resolveExecutionLease: vi.fn(() => null), withExecutionContext: vi.fn(async (_lease, execute) => execute()),
}));

import { executeWorkshopRunLifecycle } from "@/lib/workshops/runtime";
import * as service from "@/lib/workshops/service";
import { executeWorkshopAgent } from "@/lib/workshops/executor";
import { planWorkshopDirective } from "@/lib/workshops/directive-planner";
import { createBrainMemoryCandidate, writeBrainMemory } from "@/lib/brain/service";
import { scheduleWorkshopWakeupFromSuggestion } from "@/lib/workshops/heartbeat";
import { captureCompletedWorkshopRunEvidence } from "@/lib/harness-evolution/capture-service";

beforeEach(() => vi.clearAllMocks());

describe("conversation Work run lifecycle", () => {
  it("replies through the current run without directive planning or autonomous persistent outputs", async () => {
    const triggerReason = { type: "conversation", content: "Current question", parentRunId: null, inputFiles: [] };
    await executeWorkshopRunLifecycle({
      userId: "11111111-1111-4111-8111-111111111111",
      workshop: { id: "22222222-2222-4222-8222-222222222222", name: "Helper", modelConfig: {} } as any,
      run: { id: "33333333-3333-4333-8333-333333333333", triggerReason } as any,
      triggerReason: { type: "directive", content: "Standing boundary" },
    });

    expect(executeWorkshopAgent).toHaveBeenCalledWith(expect.objectContaining({
      conversation: { content: "Current question", history: [], inputFiles: [] },
      events: [],
      sources: [expect.objectContaining({ id: "permanent-source" })],
    }));
    expect(planWorkshopDirective).not.toHaveBeenCalled();
    expect(createBrainMemoryCandidate).not.toHaveBeenCalled();
    expect(writeBrainMemory).not.toHaveBeenCalled();
    expect(service.createOutboxDraft).not.toHaveBeenCalled();
    expect(scheduleWorkshopWakeupFromSuggestion).not.toHaveBeenCalled();
    expect(captureCompletedWorkshopRunEvidence).not.toHaveBeenCalled();
    expect(service.completeWorkshopRun).toHaveBeenCalledWith(expect.objectContaining({
      status: "completed", outputSummary: "Direct reply", directiveIds: [], sourceMemoryIds: [],
    }));
  });
});
