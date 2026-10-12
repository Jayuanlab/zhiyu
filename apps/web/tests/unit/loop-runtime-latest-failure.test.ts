import type { LoopRuntimeObservationFacet } from "@/lib/ai/loop-runtime-evidence-boundary";
import type { OwnerLoopFacetSession } from "@/lib/ai/loop-owner-facet-session";
type DeliveryView = { runtimeFacet: LoopRuntimeObservationFacet; rawModelProse: string };
type ScopeView = { fullOriginalQuestionVerified: boolean; hostCoverage: ReturnType<OwnerLoopFacetSession["project"]> };
// Test projection types describe real host metadata; no AgentMessage substitute or ambient shim.
const deliveryView = (value: Record<string, unknown> | undefined) => value as DeliveryView | undefined;
const scopeView = (value: Record<string, unknown> | undefined) => value as ScopeView | undefined;
const inputObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid_synthetic_tool_input");
  return value as Record<string, unknown>;
};
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@openzhiyu/ai/agent/types";
import { evidenceWindow } from "@/lib/ai/evidence-window";
import { guardOwnerLoopFacetAnswer } from "@/lib/ai/loop-owner-facet-session";
const ownerId = "11111111-1111-4111-8111-111111111111", loopId = "22222222-2222-4222-8222-222222222222";
const A = "33333333-3333-4333-8333-333333333333", B = "66666666-6666-4666-8666-666666666666";
const C = "44444444-4444-4444-8444-444444444444", D = "77777777-7777-4777-8777-777777777777";
const question = `Loop ${loopId} 上次失败，后来出现一次完成，是不是已经修好？现在是否运行？`;
const context = { ownerId, loopId, adapter: "owner_workflow_runtime_reader", toolName: "readLoopRuntimeObservation" } as const;
const hashA = "a".repeat(64), hashB = "c".repeat(64), wrong = "b".repeat(64);
function pair(id: string, name: string, input: unknown, output: unknown): AgentMessage[] {
  return [{ type: "tool_use", id, name, input }, { type: "tool_result", toolUseId: id, output: JSON.stringify(output) }];
}
type TimelineRow = { id: string; loopId: string; status: string; createdAt: string | undefined };
const rows: TimelineRow[] = [
  { id: B, loopId, status: "failed", createdAt: "2026-10-04T00:00:01.000Z" },
  { id: C, loopId, status: "completed", createdAt: "2026-10-04T00:00:02.000Z" },
];
function timeline(runs = rows, cursor: string | null = null, hasMore = false, id = "timeline"): AgentMessage[] {
  return pair(id, "readLoopRunTimeline", { loopId, afterRunId: A, ...(cursor ? { cursorRunId: cursor } : {}) }, {
    status: "read", loopId, afterRunId: A, cursorRunId: cursor,
    baseline: { id: A, status: "failed", createdAt: "2026-10-04T00:00:00.000Z" },
    ordering: "createdAt_asc_id_asc", runs, coverage: { hasMore, nextCursorRunId: hasMore ? runs.at(-1)?.id : null, returnedCount: runs.length },
  });
}
function record(id: string, status: string, target: string, passed: boolean, expectedHash: string): AgentMessage[] {
  const content = JSON.stringify({ source: "loopRuns", id, fields: { id, loopId, status, createdAt: id === A ? "2026-10-04T00:00:00.000Z" : id === B ? "2026-10-04T00:00:01.000Z" : id === C ? "2026-10-04T00:00:02.000Z" : "2026-10-04T00:00:03.000Z", error: passed ? null : "recorded_failure",
    verificationResult: { inputVersion: "same-input", target, expectedHash, observedHash: passed ? expectedHash : wrong, passed } } });
  return pair("record-" + id, "readRunRecord", { runId: id, offset: 0 }, { ...evidenceWindow(content), source: "loopRuns", id });
}
function fixtures(verifiedTarget = "artifact-B", verifiedHash = hashB): AgentMessage[] {
  return [...timeline(), ...record(A, "failed", "artifact-A", false, hashA),
    ...record(B, "failed", "artifact-B", false, hashB), ...record(C, "completed", verifiedTarget, true, verifiedHash),
    ...pair("runtime", "readLoopRuntimeObservation", {}, { ownerId, loopId, provider: "workshop_execution_leases",
      status: "no_active_linked_execution_observed", observedAt: "2026-10-04T01:00:00.000Z",
      observationScope: "active_linked_execution_mapping_only", linkedExecution: null,
      loopConfiguration: { status: "active", updatedAt: "2026-10-04T00:00:00.000Z" } })];
}
async function render(events: AgentMessage[]) {
  async function* source() { yield* events; yield { type: "text", content: "旧A已经修好，当前执行器已经停止。" } satisfies AgentMessage; yield { type: "done" } satisfies AgentMessage; }
  const output: AgentMessage[] = []; for await (const event of guardOwnerLoopFacetAnswer(source(), question, context)) output.push(event);
  const partial = output.find(e => e.answerEvidence?.schemaVersion === "owner-loop-partial-delivery.v1")?.answerEvidence;
  if (partial) {
    expect(partial).toMatchObject({ outputPolicy: "unsafe_draft_withheld_gap_notice", fullOriginalQuestionVerified: false, commitState: "uncommitted", sdkContextCommitObserved: false, committedIndependentFacts: [] });
    expect(output.filter(e => e.type === "text").map(e => e.content).join("")).not.toContain("旧A已经修好");
    expect(output.some(e => e.type === "result")).toBe(false);
  }
  return { output, text: output.filter(e => e.type === "text").map(e => e.content).join(""),
    delivered: deliveryView(output.find(e => e.answerEvidence?.schemaVersion === "loop-runtime-facet-delivery.v1")?.answerEvidence),
    fallback: scopeView(output.find(e => e.answerEvidence?.schemaVersion === "owner-loop-partial-delivery.v1" || e.answerEvidence?.outputPolicy === "baseline_stream_preserved")?.answerEvidence) };
}
describe("last failure requires complete latest failure and matching verified successor", () => {
  it("binds B and matching C, while preserving original timeline anchor A", async () => {
    const result = await render(fixtures()); expect(result.delivered).toBeTruthy();
    expect(result.text).toContain(`失败基线 ${B}`); expect(result.text).toContain("artifact-B");
    expect(result.text).not.toContain(`失败基线 ${A}`); expect(result.text).not.toContain("旧A已经修好");
    expect(result.text).toContain("当前执行器活动未知");
  });
  it("does not use C verifying old A to repair newer B", async () => {
    const result = await render(fixtures("artifact-A", hashA)); expect(result.delivered).toBeUndefined();
    expect(result.fallback?.hostCoverage.repairCoverage?.latestFailedBaselineRunId).toBe(B);
    expect(result.fallback?.hostCoverage.repairCoverage?.latestFailureHasMatchingVerifiedSuccessor).toBe(false);
  });
  it("accepts a consistent continuous multi-page timeline", async () => {
    const result = await render([...timeline([rows[0]], null, true, "timeline-1"), ...timeline([rows[1]], B, false, "timeline-2"), ...fixtures().slice(2)]);
    expect(result.delivered).toBeTruthy(); expect(result.text).toContain(`失败基线 ${B}`);
  });
  for (const missing of [A, B, C]) it("unread " + missing + " prevents takeover", async () => {
    const result = await render(fixtures().filter(e => e.id !== "record-" + missing && e.toolUseId !== "record-" + missing));
    expect(result.delivered).toBeUndefined(); expect(result.fallback?.fullOriginalQuestionVerified).toBe(false);
  });
  it("incomplete timeline prevents takeover", async () => {
    const result = await render([...timeline(rows, null, true), ...fixtures().slice(2)]); expect(result.delivered).toBeUndefined();
  });
  it("skipped cursor prevents takeover", async () => {
    const result = await render([...timeline([rows[0]], null, true, "timeline-1"), ...timeline([rows[1]], C, false, "timeline-2"), ...fixtures().slice(2)]);
    expect(result.delivered).toBeUndefined(); expect(result.fallback?.hostCoverage.invalid).toBe("owner_timeline_not_read_contiguously_from_baseline");
  });
  it("a newer failed D after verified C needs its own verified successor", async () => {
    const extended = [...rows, { id: D, loopId, status: "failed", createdAt: "2026-10-04T00:00:03.000Z" }];
    const result = await render([...timeline(extended), ...fixtures().slice(2), ...record(D, "failed", "artifact-D", false, "d".repeat(64))]);
    expect(result.delivered).toBeUndefined(); expect(result.fallback?.hostCoverage.repairCoverage?.latestFailedBaselineRunId).toBe(D);
  });
  it("complete record status cannot contradict timeline status", async () => {
    const events = fixtures().filter(e => e.id !== "record-" + B && e.toolUseId !== "record-" + B);
    const result = await render([...events, ...record(B, "completed", "artifact-B", false, hashB)]);
    expect(result.delivered).toBeUndefined(); expect(result.fallback?.hostCoverage.repairCoverage?.timelineOrderAndCompleteRecordStatusConsistent).toBe(false);
  });
  it("wrong expectation hash or input version prevents latest matching verification", async () => {
    expect((await render(fixtures("artifact-B", hashA))).delivered).toBeUndefined();
    const events = fixtures(); const target = events.find(e => e.toolUseId === "record-" + C)!;
    const page = JSON.parse(target.output!); const doc = JSON.parse(page.content); doc.fields.verificationResult.inputVersion = "different-input";
    target.output = JSON.stringify({ ...evidenceWindow(JSON.stringify(doc)), source: "loopRuns", id: C });
    expect((await render(events)).delivered).toBeUndefined();
  });
  it("timeline time/order missing or decreasing prevents latest selection", async () => {
    for (const mutated of [rows.map(row => ({ ...row, createdAt: undefined })), [rows[1], rows[0]]]) {
      const result = await render([...timeline(mutated), ...fixtures().slice(2)]); expect(result.delivered).toBeUndefined();
    }
  });
});
