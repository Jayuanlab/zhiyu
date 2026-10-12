import { describe, expect, it, vi } from "vitest";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createPiAgentRuntime } from "@openzhiyu/ai/agent/runtime";
import type { AgentMessage } from "@openzhiyu/ai/agent/types";
import { createNativePiWebChatToolDefinitions } from "@/lib/ai/native-pi-web-chat-tools";
import { recallPlatformInformationForUser } from "@/lib/ai/platform-recall";
import type { PlatformWholeFieldRead } from "@/lib/ai/platform-field-reader";
import { createGuardedPiTool } from "@/lib/ai/runtime/pi-tool-adapter";
import { createOwnerLoopPartialHost } from "@/lib/ai/loop-partial-host";
import { guardOwnerLoopFacetAnswer, type OwnerLoopFacetSession } from "@/lib/ai/loop-owner-facet-session";
import { evidenceWindow } from "@/lib/ai/evidence-window";
import { answerTextHash, type SdkContextCommit } from "@/lib/ai/runtime/answer-evidence-core";
import type { AnswerEvidenceAuditEvent } from "@/lib/ai/runtime/answer-evidence-contract";

// Synthetic identifiers and records only. The producer, formatter, adapter,
// installed Faux SDK, host construction and SDK context callbacks remain real.
const ownerId = "8a310000-0000-4000-8000-000000000001";
const loopId = "8a320000-0000-4000-8000-000000000002";
const foreignId = "8a330000-0000-4000-8000-000000000003";
const runIds = [0, 1, 2, 3].map(index => `8a340000-0000-4000-8000-00000000001${index}`);
const context = { ownerId, loopId, adapter: "native_platform_recall", toolName: "platformRecall" } as const;
const question = `Loop ${loopId} latest failed run repaired and current executor?`;
const expectedHash = "a".repeat(64);
const wrongHash = "b".repeat(64);
const runtimeObservation = {
  provider: "workshop_execution_leases", ownerId, loopId,
  observedAt: "2026-10-04T00:00:09.000Z",
  status: "no_active_linked_execution_observed",
  observationScope: "active_linked_execution_mapping_only", linkedExecution: null,
  loopConfiguration: { status: "paused", updatedAt: "2026-10-04T00:00:08.000Z" },
  warning: "A linked mapping observation does not establish current process activity.",
};

const rows = runIds.map((id, index) => ({
  id, loopId, status: index === 0 ? "failed" : "completed",
  createdAt: `2026-10-04T00:00:0${index}.000Z`,
  error: index === 0 ? "Synthetic verification failure" : null,
  verificationResult: index === 1 ? null : {
    inputVersion: "synthetic-input-v1", target: index === 2 ? "other-target" : "synthetic-target",
    expectedHash, observedHash: index === 0 ? wrongHash : expectedHash, passed: index !== 0,
  },
}));
const recordPages = rows.map(row => ({
  ...evidenceWindow(JSON.stringify({ source: "loopRuns", id: row.id, fields: row })),
  source: "loopRuns", id: row.id,
}));
const goal = "Synthetic owner goal; a recorded goal and paused configuration do not establish process liveness.";
const goalPage = { ...evidenceWindow(JSON.stringify({ source: "loops", id: loopId, fields: { id: loopId, goal } })),
  source: "loops", id: loopId };

type Shape = "producer_top_level" | "producer_field_envelope" | "legacy_nested";
type Mutation = "wrong_source" | "wrong_id" | "wrong_offset" | "wrong_hash"
  | "non_contiguous" | "version_changed" | "timeline_gap" | "timeline_baseline_changed"
  | "ambiguous_record_candidates";
type Scenario = {
  shape?: Shape; mutation?: Mutation; omitRecordCommit?: string;
  wrongRuntimeOwner?: boolean; authorize?: boolean; denied?: boolean; goal?: boolean;
};
type PartialView = Record<string, unknown> & {
  committedIndependentFacts: Array<{ facet: string; text: string; evidenceRefs: string[] }>;
  gaps: string[];
  hostCoverage?: ReturnType<OwnerLoopFacetSession["project"]>;
};

async function execute(scenario: Scenario = {}) {
  const originalQuestion = scenario.goal
    ? `Loop ${loopId} goal and current executor? Also report the unknown failure count.` : question;
  const audit: AnswerEvidenceAuditEvent[] = [];
  const callbacks: SdkContextCommit[] = [];
  const delivered: Array<Record<string, unknown>> = [];
  const host = createOwnerLoopPartialHost({
    selectedEvidence: null, context, originalQuestion, turnId: "synthetic-native-delivered-turn",
    runtimeHash: "installed-faux-sdk", policyHash: "owner-read-only-native-policy", toolNames: ["platformRecall"],
    auditSink: async event => { audit.push(event); }, authorizeFinal: async () => scenario.authorize !== false,
  });
  expect(host).toBeDefined();
  if (!host) throw Error("Synthetic authenticated host unavailable");

  const readRecord = vi.fn(async (input: { userId: string; source: string; id: string; offset?: number }) => {
    expect(input.userId).toBe(ownerId);
    if (scenario.goal) {
      expect(input.source).toBe("loops");
      expect(input.id).toBe(loopId);
      return { ...goalPage };
    }
    expect(input.source).toBe("loopRuns");
    const index = runIds.indexOf(input.id);
    if (index < 0) throw Error("Unexpected synthetic record");
    let page: Record<string, unknown> = { ...recordPages[index] };
    if (index === 0) {
      if (scenario.mutation === "wrong_source") page.source = "loopStates";
      if (scenario.mutation === "wrong_id") page.id = foreignId;
      if (scenario.mutation === "wrong_offset") page.offset = 1;
      if (scenario.mutation === "wrong_hash") page.contentHash = wrongHash;
      if (scenario.mutation === "non_contiguous") page.nextOffset = recordPages[index].content.length - 1;
      if (scenario.mutation === "version_changed") page.status = "version_changed";
    }
    if (scenario.shape === "producer_field_envelope") {
      // This is an unrelated directed field observation. It cannot replace the
      // complete, parent-hashed record that the repair projection requires.
      const fieldRead: PlatformWholeFieldRead = {
        schemaVersion: "platform-field-read.v1", status: "not_recorded", source: "loopRuns", id: input.id,
        observedAt: runtimeObservation.observedAt, parentContentHash: recordPages[index].contentHash,
        fields: [{ fieldKey: "outputSummary", value: null, valueHash: answerTextHash("null"), complete: true }],
        fieldAvailability: { outputSummary: "not_recorded" }, coverage: { fieldComplete: true, rawRecordComplete: false },
        representation: "whole_published_field", scope: "authenticated_owner_exact_source",
        warning: "Synthetic unrelated optional field is not recorded.",
      };
      page = { ...page, fieldRead };
    }
    return page;
  });
  const readTimeline = vi.fn(async (input: {
    userId: string; loopId: string; afterRunId: string; cursorRunId?: string;
  }) => {
    expect(input.userId).toBe(ownerId);
    expect(input.loopId).toBe(loopId);
    expect(input.afterRunId).toBe(runIds[0]);
    const index = input.cursorRunId === undefined ? 1 : runIds.indexOf(input.cursorRunId) + 1;
    if (index < 1 || index > 3) throw Error("Unexpected synthetic timeline cursor");
    const row = rows[index];
    return {
      status: "read", loopId, afterRunId: runIds[0],
      cursorRunId: scenario.mutation === "timeline_gap" && index === 3 ? foreignId : input.cursorRunId ?? null,
      baseline: { id: rows[0].id, status: rows[0].status,
        createdAt: scenario.mutation === "timeline_baseline_changed" && index === 3
          ? "2026-10-03T23:59:59.000Z" : rows[0].createdAt },
      runs: [{ id: row.id, loopId, status: row.status, createdAt: row.createdAt }],
      ordering: "createdAt_asc_id_asc",
      coverage: { hasMore: index < 3, nextCursorRunId: index < 3 ? row.id : null },
      completionGate: index < 3 ? "timeline_continuation_required" : "timeline_read_complete",
    };
  });
  const readRuntime = vi.fn(async (input: { userId: string; loopId: string }) => {
    expect(input).toEqual({ userId: ownerId, loopId });
    return { ...runtimeObservation, ...(scenario.wrongRuntimeOwner ? { ownerId: foreignId } : {}) };
  });
  const unavailable = vi.fn(async () => { throw Error("Unrequested adapter must not run"); });
  const recall = vi.fn(async (input: Parameters<typeof recallPlatformInformationForUser>[0]) => {
    // Actual platform-recall creates both its raw data and delivered text. Only
    // the three owner-read adapters are injected; no database/provider is used.
    const result = await recallPlatformInformationForUser(input, {
      readRecord: readRecord as never, readTimeline: readTimeline as never, readRuntime: readRuntime as never,
      listArchitectureMemories: unavailable as never, listSnapshots: unavailable as never,
      listGrants: unavailable as never, inspectWork: unavailable as never, listLoops: unavailable as never,
      listKnowledgeDocuments: unavailable as never, listToolCapabilities: unavailable as never,
    });
    if (scenario.shape === "legacy_nested") {
      // Explicit compatibility transport, not the current producer shape. The
      // same actual native formatter still chooses this result's text.
      return { ...result, text: JSON.stringify({ ok: result.ok, data: "data" in result ? result.data : undefined }) };
    }
    if (scenario.mutation === "ambiguous_record_candidates" && input.recordRead?.id === runIds[0]) {
      const publicResult = JSON.parse(result.text) as Record<string, unknown>;
      return { ...result, text: JSON.stringify({ ...publicResult,
        data: { recordRead: { ...recordPages[0], id: foreignId } } }) };
    }
    return result;
  });
  const args: Parameters<typeof createNativePiWebChatToolDefinitions> = [];
  args[0] = { userId: ownerId, question: originalQuestion, turnId: host.turnId, includeMemoryAccess: false,
    policy: { allowedTools: ["platformRecall"], deniedTools: scenario.denied ? ["platformRecall"] : [], defaultDecision: "deny" } };
  args[22] = recall as never;
  const definition = createNativePiWebChatToolDefinitions(...args).find(tool => tool.name === "platformRecall");
  expect(definition?.formatResult).toBeTypeOf("function");
  if (!definition?.formatResult) throw Error("Actual native platformRecall definition missing");
  const formatter = vi.spyOn(definition, "formatResult");
  const construction = vi.fn(host.onResultConstructed);
  const tool = createGuardedPiTool({ ...definition, onResultConstructed: construction });

  const requests = scenario.goal ? [
    { recordRead: { source: "loops", id: loopId, offset: 0, expectedHash: goalPage.contentHash } },
    { runtimeRead: { loopId } },
  ] : [
    ...recordPages.map(page => ({ recordRead: { source: "loopRuns", id: page.id, offset: 0, expectedHash: page.contentHash } })),
    ...[1, 2, 3].map(index => ({ timelineRead: { loopId, afterRunId: runIds[0], limit: 1,
      ...(index > 1 ? { cursorRunId: runIds[index - 1] } : {}) } })),
    { runtimeRead: { loopId } },
  ];
  const faux = createFauxCore({});
  faux.setResponses([
    ...requests.map(params => fauxAssistantMessage(fauxToolCall("platformRecall", params), { stopReason: "toolUse" })),
    fauxAssistantMessage("UNSAFE_NATIVE_DRAFT: all faults fixed; current executor stopped; complete."),
  ]);
  const runtime = createPiAgentRuntime({ adapter: "harness", model: faux.getModel(), streamFn: faux.streamSimple, tools: [tool] });
  const actual = runtime.run({ operation: "run", prompt: originalQuestion, options: {
    onToolContextCommitted: async receipt => {
      callbacks.push(receipt);
      const value = JSON.parse(receipt.modelText) as Record<string, unknown>;
      delivered.push(value);
      const data = value.data as { recordRead?: { id?: string } } | undefined;
      const record = (value.recordRead ?? data?.recordRead ?? value) as { id?: string };
      if (scenario.omitRecordCommit !== undefined && record.id === scenario.omitRecordCommit) return;
      await host.onToolContextCommitted(receipt);
    },
  } });
  const visible: AgentMessage[] = [];
  for await (const event of guardOwnerLoopFacetAnswer(actual, originalQuestion, context, host.binding)) visible.push(event);
  const evidence = visible.find(event => event.answerEvidence?.schemaVersion === "owner-loop-partial-delivery.v1")
    ?.answerEvidence as PartialView | undefined;
  const text = visible.filter(event => event.type === "text").map(event => event.content ?? "").join("");
  expect(text).not.toContain("UNSAFE_NATIVE_DRAFT");
  expect(evidence).toMatchObject({ fullOriginalQuestionVerified: false,
    originalQuestion: { text: originalQuestion, charactersUtf16: originalQuestion.length,
      sha256: answerTextHash(JSON.stringify(originalQuestion)) } });
  expect(unavailable).not.toHaveBeenCalled();
  const emitted = visible.filter(event => event.type === "tool_result");
  return { host, evidence, text, audit, callbacks, delivered, emitted, formatter, construction, recall, readRecord, readTimeline, readRuntime };
}

function assertExactDeliveryJoin(result: Awaited<ReturnType<typeof execute>>, expectedCount: number) {
  expect(result.construction).toHaveBeenCalledTimes(expectedCount);
  expect(result.emitted).toHaveLength(expectedCount);
  expect(result.callbacks).toHaveLength(expectedCount);
  expect(new Set(result.callbacks.map(receipt => receipt.entryId)).size).toBe(expectedCount);
  const constructed = result.construction.mock.calls.map(([receipt]) => receipt);
  expect(new Set(constructed.map(receipt => receipt.toolCallId)).size).toBe(expectedCount);
  for (const receipt of constructed) {
    if (typeof receipt.modelText !== "string") throw Error("Actual construction did not retain formatted text");
    const emitted = result.emitted.filter(event => event.toolUseId === receipt.toolCallId);
    const committed = result.callbacks.filter(event => event.toolCallId === receipt.toolCallId);
    expect(emitted).toHaveLength(1);
    expect(committed).toHaveLength(1);
    // Exact UTF-16 text and full SHA-256 join, including the timeline results
    // that intentionally cannot manufacture a fact receipt of their own.
    expect(emitted[0].output).toBe(receipt.modelText);
    expect(committed[0].modelText).toBe(receipt.modelText);
    expect(answerTextHash(emitted[0].output ?? "")).toBe(answerTextHash(receipt.modelText));
    expect(answerTextHash(committed[0].modelText)).toBe(answerTextHash(receipt.modelText));
    const formatted = result.formatter.mock.calls.find(([input]) => input === receipt.result);
    expect(formatted).toBeDefined();
  }
}

describe("Native delivered record/timeline reads through the actual formatter and installed SDK", () => {
  it.each(["producer_top_level", "producer_field_envelope", "legacy_nested"] as const)(
    "%s preserves exact repair evidence after eight real SDK tool results", async shape => {
      const result = await execute({ shape });
      expect(result.readRecord).toHaveBeenCalledTimes(4);
      expect(result.readTimeline).toHaveBeenCalledTimes(3);
      expect(result.readRuntime).toHaveBeenCalledTimes(1);
      expect(result.recall).toHaveBeenCalledTimes(8);
      expect(result.formatter).toHaveBeenCalledTimes(8);
      expect(result.construction).toHaveBeenCalledTimes(8);
      expect(result.callbacks).toHaveLength(8);
      assertExactDeliveryJoin(result, 8);
      expect(result.host.core.snapshot()).toMatchObject({ receiptCount: 5, contextReceiptCount: 5 });
      expect(result.evidence).toMatchObject({ outcome: "partial", commitState: "committed_partial",
        factCommitState: "verified_partial_facts_committed", sdkContextCommitObserved: true,
        runtimeFacet: { state: "observed", currentProcessActivity: "unknown", lease: { evaluated: false }, heartbeat: { evaluated: false } } });
      expect(result.evidence?.committedIndependentFacts).toEqual([expect.objectContaining({
        facet: "repair_evidence", evidenceRefs: recordPages.map(page => `loopRuns:${page.id}@${page.contentHash}`),
      })]);
      const coverage = result.evidence?.hostCoverage;
      expect(coverage).toMatchObject({ ready: true, invalid: null, automaticReadsExecuted: false });
      expect(coverage?.repairCoverage?.completeRunRecords).toHaveLength(4);
      expect(coverage?.repairCoverage?.comparisons.map(row => row.repairedTargetObserved)).toEqual([false, false, true]);
      expect(coverage?.repairCoverage).toMatchObject({ timelineAtReadEnd: true, totalQuestionComplete: false,
        timelineOrderAndCompleteRecordStatusConsistent: true, timelineOrderAndCompleteRecordCreatedAtConsistent: true });
      expect(result.audit.filter(event => event.eventType === "context_committed")).toHaveLength(5);
      expect(result.audit.at(-1)?.eventType).toBe("turn_completed");
      if (shape === "producer_top_level") {
        expect(result.delivered[0]).toMatchObject({ source: "loopRuns", id: runIds[0], status: "read" });
        expect(result.delivered[0]).not.toHaveProperty("data");
        expect(result.delivered[4]).toMatchObject({ loopId, afterRunId: runIds[0], ordering: "createdAt_asc_id_asc" });
        expect(result.delivered[4]).not.toHaveProperty("data");
      } else if (shape === "producer_field_envelope") {
        expect(result.delivered[0]).toMatchObject({ recordRead: { source: "loopRuns", id: runIds[0] },
          fieldRead: { schemaVersion: "platform-field-read.v1", status: "not_recorded",
            fieldAvailability: { outputSummary: "not_recorded" }, coverage: { fieldComplete: true, rawRecordComplete: false } } });
      } else expect(result.delivered[0]).toHaveProperty("data.recordRead.id", runIds[0]);
    },
  );

  it("the same actual top-level producer preserves a complete goal and separately bounded runtime with an unknown obligation", async () => {
    const result = await execute({ goal: true });
    assertExactDeliveryJoin(result, 2);
    expect(result.readRecord).toHaveBeenCalledTimes(1);
    expect(result.readTimeline).not.toHaveBeenCalled();
    expect(result.readRuntime).toHaveBeenCalledTimes(1);
    expect(result.delivered[0]).toMatchObject({ source: "loops", id: loopId, status: "read" });
    expect(result.delivered[0]).not.toHaveProperty("data");
    expect(result.host.core.snapshot()).toMatchObject({ receiptCount: 2, contextReceiptCount: 2 });
    expect(result.evidence?.committedIndependentFacts).toEqual([expect.objectContaining({ facet: "configuration_postcondition",
      evidenceRefs: [`loops:${loopId}@${goalPage.contentHash}`] })]);
    expect(result.text).toContain(JSON.stringify(goal));
    expect(result.evidence?.gaps).toContain("unknown_independent_question_obligations");
    expect(result.evidence).toMatchObject({ outcome: "partial", commitState: "committed_partial",
      fullOriginalQuestionVerified: false, runtimeFacet: { state: "observed", currentProcessActivity: "unknown" } });
  });

  it.each(["wrong_source", "wrong_id", "wrong_offset", "wrong_hash", "non_contiguous", "version_changed",
    "timeline_gap", "timeline_baseline_changed", "ambiguous_record_candidates"] as const)(
    "does not commit a repair fact when delivered evidence has %s", async mutation => {
      const result = await execute({ mutation });
      expect(result.callbacks).toHaveLength(8);
      expect(result.evidence?.committedIndependentFacts.some(fact => fact.facet === "repair_evidence")).toBe(false);
      expect(result.evidence?.hostCoverage?.ready).toBe(false);
      expect(result.evidence).toMatchObject({ fullOriginalQuestionVerified: false,
        runtimeFacet: { state: "observed", currentProcessActivity: "unknown" } });
    },
  );

  it("requires every record's actual SDK context commit even when all complete records were emitted", async () => {
    const result = await execute({ omitRecordCommit: runIds[3] });
    expect(result.callbacks).toHaveLength(8);
    expect(result.host.core.snapshot()).toMatchObject({ receiptCount: 5, contextReceiptCount: 4 });
    expect(result.evidence?.hostCoverage?.ready).toBe(true);
    expect(result.evidence?.hostCoverage?.repairCoverage?.comparisons.map(row => row.repairedTargetObserved)).toEqual([false, false, true]);
    expect(result.evidence?.committedIndependentFacts).toEqual([]);
    expect(result.evidence?.gaps.some(gap => gap.startsWith(`context_commit_unverified:loopRuns:${runIds[3]}@`))).toBe(true);
    expect(result.evidence).toMatchObject({ outcome: "partial", runtimeFacet: { state: "observed", currentProcessActivity: "unknown" } });
  });

  it("retains separately committed historical repair while a foreign-owner runtime remains unknown", async () => {
    const result = await execute({ wrongRuntimeOwner: true });
    expect(result.host.core.snapshot().contextReceiptCount).toBe(4);
    expect(result.evidence?.committedIndependentFacts).toEqual([expect.objectContaining({ facet: "repair_evidence" })]);
    expect(result.evidence).toMatchObject({ outcome: "partial", runtimeFacet: { state: "unknown", currentProcessActivity: "unknown" },
      fullOriginalQuestionVerified: false });
  });

  it("final authorization denial clears constructed and SDK-committed repair/runtime facts", async () => {
    const result = await execute({ authorize: false });
    expect(result.host.core.snapshot().contextReceiptCount).toBe(5);
    expect(result.evidence).toMatchObject({ outcome: "unknown", commitState: "uncommitted", committedIndependentFacts: [],
      finalFactCommitAccepted: false, runtimeFacet: { state: "unknown" } });
    expect(result.text).not.toContain("Synthetic verification failure");
  });

  it("denied remains stronger than allowed before the real native read adapter executes", async () => {
    const result = await execute({ denied: true });
    expect(result.recall).not.toHaveBeenCalled();
    expect(result.formatter).not.toHaveBeenCalled();
    expect(result.construction).not.toHaveBeenCalled();
    expect(result.callbacks).toHaveLength(0);
    expect(result.host.core.snapshot().contextReceiptCount).toBe(0);
    expect(result.evidence).toMatchObject({ outcome: "unknown", commitState: "uncommitted", committedIndependentFacts: [] });
  });
});
