import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { WorkshopExecutionResult } from "@/lib/workshops/executor";

const fixture = vi.hoisted(() => ({ captured: false }));
const body = "The full pinned paper has already been returned; only final claim quotations are invalid.";
const bodyHash = createHash("sha256").update(body).digest("hex");
const validationIssues = [
  "必读来源 deepseek-math 第 2 条结论 的短摘未完整出现在所引用的同版正文窗口中。",
  "必读来源 deepseek-r1 第 2 条结论：数字 79.8% 未在短摘中出现。",
];
const contract = { version: "primary-reading/v1", reportDelivery: "grounded-report/v1",
  requiredPrimarySources: [{ id: "deepseek-r1", label: "DeepSeek-R1", urls: ["https://example.test/r1"] }] };
const failed = (): WorkshopExecutionResult => ({ status: "error", structured: null,
  output: "Final validation correction limit exhausted", error: "Final validation correction limit exhausted",
  toolCallCount: 11, durationMs: 100,
  researchEvidenceContext: { modelConfig: { researchEvidenceContract: contract }, taskText: "Read DeepSeek" },
});

vi.mock("@/lib/workshops/service", () => ({
  appendWorkshopEvent: vi.fn(async (value) => ({ ...value, id: "new-event" })),
  completeWorkshopRun: vi.fn(async () => ({ status: "failed" })),
  createOutboxDraft: vi.fn(), createWorkshopRun: vi.fn(), getOwnedWorkshopDirective: vi.fn(),
  listActiveDirectives: vi.fn(async () => []), listRecentSourceEventIds: vi.fn(async () => []),
  listWorkshopEvents: vi.fn(async (_workId, options) => {
    if (options?.types?.includes("research_final_validation_rejected")) return [{
      id: "rejection-event", runId: "fixture-run", type: "research_final_validation_rejected",
      createdAt: new Date("2026-10-09T00:00:01Z"),
      metadata: { receiptAuthority: "runtime", attempt: 2, maxCorrections: 2,
        issues: validationIssues, feedback: "Exact host failure details.", status: "correction_required" },
    }, { id: "terminal-event", runId: "fixture-run", type: "agent_final_output_rejected", createdAt: new Date("2026-10-09T00:00:02Z"),
      metadata: { receiptAuthority: "runtime", terminalStatus: "failed", cleanupStatus: "completed",
        error: "Final validation correction limit exhausted" } }];
    if (options?.types?.includes("source_checked")) return [{ id: "source-event", runId: "fixture-run", type: "source_checked",
      metadata: { receiptAuthority: "runtime", toolName: "webReadPage", method: "jina_defuddle", ok: true,
        url: "https://example.test/r1", finalUrl: "https://example.test/r1", evidenceId: "snapshot",
        contentHash: bodyHash, qualityScore: 80, offset: 0, contentLength: body.length, totalChars: body.length, nextOffset: null } }];
    return [];
  }),
  listWorkshopMemories: vi.fn(async () => []), listWorkshopOutbox: vi.fn(async () => []),
  listWorkshopSources: vi.fn(async () => []),
}));
vi.mock("@/lib/loops/service", () => ({ listLoopsForWorkshop: vi.fn(async () => []) }));
vi.mock("@/lib/workshops/executor", () => ({ executeWorkshopAgent: vi.fn(async () => failed()) }));
vi.mock("@/lib/ai/jina-page-reader", () => ({ loadWebEvidence: vi.fn(async () => ({ snapshot: {
  evidenceId: "snapshot", contentHash: bodyHash, url: "https://example.test/r1", content: body,
} })) }));
vi.mock("@/lib/workshops/conversation-context", () => ({
  loadPersistentWorkshopEvents: vi.fn(async () => []),
  loadWorkshopConversationContext: vi.fn(async () => ({ content: "Read DeepSeek", history: [], inputFiles: [] })),
}));
vi.mock("@/lib/workshops/directive-planner", () => ({ planWorkshopDirective: vi.fn() }));
vi.mock("@/lib/brain/service", () => ({ createBrainMemoryCandidate: vi.fn(), writeBrainMemory: vi.fn() }));
vi.mock("@/lib/workshops/heartbeat", () => ({ scheduleWorkshopWakeupFromSuggestion: vi.fn() }));
vi.mock("@/lib/workshops/loop-service", () => ({ proposeWorkshopLoopFromNaturalLanguage: vi.fn() }));
vi.mock("@/lib/workshops/outbox-wechat", () => ({ autoSendWorkshopOutboxIfWhitelisted: vi.fn() }));
vi.mock("@/lib/harness-evolution/capture-service", () => ({ captureCompletedWorkshopRunEvidence: vi.fn() }));
vi.mock("@/lib/work-runtime/execution-context", () => ({
  resolveExecutionLease: vi.fn((lease) => lease ?? null), withExecutionContext: vi.fn(async (_lease, execute) => execute()),
}));
vi.mock("@/lib/work-runtime/execution-guard", () => ({ createExecutionGuard: vi.fn(() => async () => undefined) }));
vi.mock("@/lib/work-runtime/execution-heartbeat", () => ({ startExecutionHeartbeat: vi.fn(async () => ({ stop: async () => undefined })) }));
vi.mock("@/lib/work-runtime/run-output", () => ({
  readCapturedRunOutput: vi.fn(async () => fixture.captured ? { result: failed(), directiveIds: [] } : null),
  captureRunOutput: vi.fn(async (_lease, output) => output),
}));
vi.mock("@/lib/work-runtime/run-plan", () => ({
  readCapturedRunPlan: vi.fn(async () => null), captureRunPlan: vi.fn(),
  applyRunPlanStep: vi.fn(async (_lease, _step, write) => write({ append: vi.fn() })),
}));

import { executeWorkshopRunLifecycle } from "@/lib/workshops/runtime";
import * as service from "@/lib/workshops/service";
import { executeWorkshopAgent } from "@/lib/workshops/executor";
import { createBrainMemoryCandidate, writeBrainMemory } from "@/lib/brain/service";
import { scheduleWorkshopWakeupFromSuggestion } from "@/lib/workshops/heartbeat";

beforeEach(() => { fixture.captured = false; vi.clearAllMocks(); });

describe("actual Workshop lifecycle preserves runtime terminal failure", () => {
  it.each([false, true])("preserves the host rejection instead of validating null (captured=%s)", async (captured) => {
    fixture.captured = captured;
    const triggerReason = { type: "conversation", content: "Read DeepSeek", inputFiles: [] };
    await executeWorkshopRunLifecycle({ userId: "fixture-owner",
      workshop: { id: "fixture-work", name: "Researcher", modelConfig: { researchEvidenceContract: contract } } as any,
      run: { id: "fixture-run", triggerReason, startedAt: new Date("2026-10-09T00:00:00Z") } as any,
      executionLease: { userId: "fixture-owner", workshopId: "fixture-work", runId: "fixture-run" } as any,
    });
    const complete = vi.mocked(service.completeWorkshopRun).mock.calls.at(-1)?.[0];
    expect(complete?.status).toBe("failed");
    expect(complete?.error).toContain(validationIssues[0]);
    expect(complete?.error).toContain(validationIssues[1]);
    expect(complete?.error).not.toContain("received null");
    expect(complete?.outputSummary).toContain("纠正次数已用尽");
    expect(complete?.metadata).toMatchObject({ failureReason: "research_final_validation_rejected",
      runtimeFailure: { runId: "fixture-run", validationEventId: "rejection-event", issues: validationIssues },
      presentation: { source: "host_runtime_failure" },
    });
    expect(createBrainMemoryCandidate).not.toHaveBeenCalled();
    expect(writeBrainMemory).not.toHaveBeenCalled();
    expect(service.createOutboxDraft).not.toHaveBeenCalled();
    expect(scheduleWorkshopWakeupFromSuggestion).not.toHaveBeenCalled();
    expect(service.appendWorkshopEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "research_report_rejected" }));
    expect(executeWorkshopAgent).toHaveBeenCalledTimes(captured ? 0 : 1);
  });
});
