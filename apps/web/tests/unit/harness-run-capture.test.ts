import { describe, expect, it } from "vitest";
import {
  buildCapturedRunEvidence,
  readRunHarnessCaptureContext,
} from "@/lib/harness-evolution";

describe("harness run evidence capture", () => {
  const context = {
    interfaceVersion: "run-harness-context.v1" as const,
    workId: "work-1",
    workVersionId: "version-1",
    harnessSnapshotId: "snapshot-1",
    componentSetHash: "hash-1",
    model: "model-1",
    capturedAt: "2026-08-12T00:00:00.000Z",
  };

  it("reads only a complete embedded Harness context", () => {
    expect(readRunHarnessCaptureContext({ harnessEvolution: context })).toEqual(
      context,
    );
    expect(
      readRunHarnessCaptureContext({
        harnessEvolution: { ...context, harnessSnapshotId: "" },
      }),
    ).toBeNull();
  });

  it("captures only host usage receipts and retains missing usage as an explicit unknown subtotal", () => {
    const capture = (events: Array<{ id: string; invocation: number; inputTokens: number | null; usageStatus: string }>, options: { pendingForward?: boolean; eventsComplete?: boolean } = {}) => buildCapturedRunEvidence({
      id: "usage-evidence", userId: "user-1", workId: "work-1", workRunId: "run-1", loopId: null, loopRunId: null, context,
      status: "completed", startedAt: "2026-10-13T00:00:00Z", completedAt: "2026-10-13T00:00:01Z", outputSummary: null, error: null,
      contextLogs: [], eventsComplete: options.eventsComplete,
      events: [...events.flatMap((event) => [{ id: `prepared-${event.id}`, type: "working_memory_projected", createdAt: "2026-10-13T00:00:00Z",
        metadata: { schemaVersion: "host-working-memory.v1", receiptAuthority: "runtime", status: "provider_request_prepared", mode: "apply", version: 1 } },
        { id: event.id, type: "working_memory_usage", createdAt: "2026-10-13T00:00:01Z",
        metadata: { schemaVersion: "host-working-memory.v1", receiptAuthority: "runtime", invocation: event.invocation,
          status: "provider_result_received", source: "sdk_result", mode: "apply", version: 1,
          usageStatus: event.usageStatus, inputTokens: event.inputTokens, outputTokens: 5, totalTokens: event.inputTokens === null ? null : event.inputTokens + 5 } }]),
        ...(options.pendingForward ? [{ id: "unsettled-forward", type: "working_memory_projected", createdAt: "2026-10-13T00:00:02Z",
          metadata: { schemaVersion: "host-working-memory.v1", receiptAuthority: "runtime", status: "provider_request_prepared", mode: "apply", version: 1 } }] : [])],
    });
    const known = capture([{ id: "usage-1", invocation: 1, inputTokens: 20, usageStatus: "reported" }, { id: "usage-2", invocation: 2, inputTokens: 10, usageStatus: "reported" }]);
    expect(known.runtime.tokenUsageStatus).toBe("reported");
    expect(known.runtime.tokenUsage).toEqual({ inputTokens: 30, outputTokens: 10, totalTokens: 40 });
    const partial = capture([{ id: "usage-1", invocation: 1, inputTokens: 20, usageStatus: "reported" }, { id: "usage-2", invocation: 2, inputTokens: null, usageStatus: "unknown" }]);
    expect(partial.runtime.tokenUsageStatus).toBe("unknown");
    expect(partial.runtime.tokenUsage.totalTokens).toBe(25);
    expect(partial.warnings.some((warning) => warning.includes("subtotals"))).toBe(true);
    expect(capture([{ id: "usage-gap", invocation: 2, inputTokens: 20, usageStatus: "reported" }]).runtime.tokenUsageStatus).toBe("unknown");
    expect(capture([{ id: "usage-1", invocation: 1, inputTokens: 20, usageStatus: "reported" }, { id: "usage-duplicate", invocation: 1, inputTokens: 20, usageStatus: "reported" }]).runtime.tokenUsage.totalTokens).toBe(25);
    const failedFinalForward = capture([{ id: "usage-1", invocation: 1, inputTokens: 20, usageStatus: "reported" }], { pendingForward: true });
    expect(failedFinalForward.runtime.tokenUsageStatus).toBe("unknown");
    expect(failedFinalForward.runtime.tokenUsage.totalTokens).toBe(25);
    expect(failedFinalForward.warnings.some((warning) => warning.includes("subtotals"))).toBe(true);
    const truncated = capture([{ id: "usage-1", invocation: 1, inputTokens: 20, usageStatus: "reported" }], { eventsComplete: false });
    expect(truncated.runtime.tokenUsageStatus).toBe("unknown");
    expect(truncated.runtime.tokenUsage.totalTokens).toBe(25);
  });

  it("excludes SDK test counters while retaining only the real provider subtotal", () => {
    const receipts = (invocation: number, executionKind: string) => [
      { id: `prepared-${invocation}`, type: "working_memory_projected", createdAt: "2026-10-13T00:00:00Z",
        metadata: { schemaVersion: "host-working-memory.v1", receiptAuthority: "runtime", executionKind,
          status: "provider_request_prepared", mode: "apply", version: 1 } },
      { id: `usage-${invocation}`, type: "working_memory_usage", createdAt: "2026-10-13T00:00:01Z",
        metadata: { schemaVersion: "host-working-memory.v1", receiptAuthority: "runtime", executionKind, invocation,
          status: "provider_result_received", source: "sdk_result", mode: "apply", version: 1,
          usageStatus: "reported", inputTokens: 20, outputTokens: 5, totalTokens: 25 } },
    ];
    const capture = (events: ReturnType<typeof receipts>) => buildCapturedRunEvidence({
      id: "usage-evidence", userId: "user-1", workId: "work-1", workRunId: "run-1", loopId: null, loopRunId: null, context,
      status: "completed", startedAt: "2026-10-13T00:00:00Z", completedAt: "2026-10-13T00:00:01Z", outputSummary: null, error: null,
      contextLogs: [], events,
    });
    const onlyStub = capture(receipts(1, "sdk-test"));
    expect(onlyStub.runtime.tokenUsageStatus).toBe("unknown");
    expect(onlyStub.runtime.tokenUsage).toEqual({});
    expect(onlyStub.warnings.some((warning) => warning.includes("Non-provider"))).toBe(true);
    const mixed = capture([...receipts(1, "provider"), ...receipts(2, "sdk-test")]);
    expect(mixed.runtime.tokenUsageStatus).toBe("unknown");
    expect(mixed.runtime.tokenUsage).toEqual({ inputTokens: 20, outputTokens: 5, totalTokens: 25 });
    expect(capture(receipts(1, "provider")).runtime.tokenUsageStatus).toBe("reported");
    expect(capture(receipts(1, "unknown-executor")).runtime.tokenUsage).toEqual({});
  });

  it("builds a traceable bundle without copying event bodies", () => {
    const bundle = buildCapturedRunEvidence({
      id: "evidence-1",
      userId: "user-1",
      workId: "work-1",
      workRunId: null,
      loopId: "loop-1",
      loopRunId: "loop-run-1",
      context,
      status: "failed",
      startedAt: "2026-08-12T00:00:00.000Z",
      completedAt: "2026-08-12T00:00:02.000Z",
      outputSummary: "Sensitive output must not be copied.",
      error: "tool failed",
      verificationResult: {
        passed: false,
        verification: {
          passed: false,
          issues: [{ code: "missing_required_field", message: "Missing plan" }],
        },
        decision: { attemptsUsed: 2 },
        toolGate: {
          decisions: [
            { actionName: "readData", decision: "allow" },
            { actionName: "sendMessage", decision: "deny" },
          ],
        },
      },
      events: [
        {
          id: "event-source",
          type: "source_checked",
          metadata: { provider: "market", freshness: "fresh" },
          createdAt: "2026-08-12T00:00:01.000Z",
        },
        {
          id: "event-tool",
          type: "tool_call",
          metadata: { toolName: "readData" },
          createdAt: "2026-08-12T00:00:01.500Z",
        },
      ],
      contextLogs: [
        {
          id: "context-1",
          selectedMemoryIds: ["memory-1"],
          deniedCount: 2,
          createdAt: "2026-08-12T00:00:00.500Z",
        },
      ],
      createdAt: "2026-08-12T00:00:02.000Z",
    });

    expect(bundle.completeness).toBe("complete");
    expect(bundle.actions.toolNames).toEqual(["readData", "sendMessage"]);
    expect(bundle.actions.deniedCount).toBe(3);
    expect(bundle.outcome.requiredFieldsMissing).toEqual(["Missing plan"]);
    expect(bundle.evidenceRefs.map((reference) => reference.id)).toEqual([
      "loop-run-1",
      "event-source",
      "context-1",
    ]);
    expect(JSON.stringify(bundle)).not.toContain("Sensitive output");
  });
});
