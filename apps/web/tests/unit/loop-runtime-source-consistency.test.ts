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
import { guardDirectLoopRuntimeAnswer } from "@/lib/ai/loop-runtime-answer-guard";
import { isPublishedRunCreatedAt } from "@/lib/ai/loop-repair-read-coverage";
const ownerId = "11111111-1111-4111-8111-111111111111", loopId = "22222222-2222-4222-8222-222222222222";
const A = "33333333-3333-4333-8333-333333333333", B = "44444444-4444-4444-8444-444444444444";
const C = "55555555-5555-4555-8555-555555555555", D = "77777777-7777-4777-8777-777777777777";
const other = "66666666-6666-4666-8666-666666666666", good = "a".repeat(64), bad = "b".repeat(64);
const stamp = (n: number) => `2026-10-04T00:00:0${n}.000Z`;
const question = `Loop ${loopId} 上次失败，后来出现一次完成，是不是已经修好？现在是否运行？`;
const context = { ownerId, loopId, adapter: "owner_workflow_runtime_reader", toolName: "readLoopRuntimeObservation" } as const;
function pair(id: string, name: string, input: unknown, output: unknown): AgentMessage[] {
  return [{ type: "tool_use", id, name, input }, { type: "tool_result", toolUseId: id, output: JSON.stringify(output) }];
}
type TimelineRow = { id: string; loopId: string; status: string; createdAt: string | undefined };
const rows: TimelineRow[] = [{ id: B, loopId, status: "failed", createdAt: stamp(1) }, { id: C, loopId, status: "completed", createdAt: stamp(2) }];
function timeline(id = "timeline", runs = rows, cursor: string | null = null, hasMore = false,
  baseline: Record<string, unknown> = { id: A, status: "failed", createdAt: stamp(0) }) {
  return pair(id, "readLoopRunTimeline", { loopId, afterRunId: A, ...(cursor ? { cursorRunId: cursor } : {}) }, {
    status: "read", loopId, afterRunId: A, cursorRunId: cursor, baseline, ordering: "createdAt_asc_id_asc", runs,
    observedAt: stamp(9), coverage: { hasMore, nextCursorRunId: hasMore ? runs.at(-1)?.id : null, returnedCount: runs.length },
  });
}
function record(id: string, status: string, createdAt: unknown, extra: Record<string, unknown> = {}, padding = 0) {
  const content = JSON.stringify({ source: "loopRuns", id, fields: { id, loopId, status, createdAt,
    error: status === "failed" ? "synthetic_failure" : null,
    verificationResult: { inputVersion: "input-v1", target: id === A ? "artifact-A" : "artifact-B",
      expectedHash: good, observedHash: status === "failed" ? bad : good, passed: status === "completed" },
    ...(padding ? { outputSummary: "x".repeat(padding) } : {}), ...extra } });
  return pair("record-" + id, "readRunRecord", { runId: id, offset: 0 }, { ...evidenceWindow(content), source: "loopRuns", id });
}
function runtime() { return pair("runtime", "readLoopRuntimeObservation", { loopId }, {
  provider: "workshop_execution_leases", ownerId, loopId, observedAt: stamp(9), status: "no_active_linked_execution_observed",
  observationScope: "active_linked_execution_mapping_only", linkedExecution: null,
}); }
function records() { return [...record(A, "failed", stamp(0)), ...record(B, "failed", stamp(1)), ...record(C, "completed", stamp(2)), ...runtime()]; }
function replaceRecord(events: AgentMessage[], id: string, replacement: AgentMessage[]) {
  return [...events.filter(e => e.id !== "record-" + id && e.toolUseId !== "record-" + id), ...replacement];
}
async function render(events: AgentMessage[], native = false) {
  const input = native ? events.map(event => {
    if (event.type === "tool_use") {
      const params = inputObject(event.input);
      const input = event.name === "readLoopRunTimeline" ? { timelineRead: params }
        : event.name === "readRunRecord" ? { recordRead: { source: "loopRuns", id: params.runId, offset: params.offset, expectedHash: params.expectedHash } }
          : { runtimeRead: params };
      return { ...event, name: "platformRecall", input };
    }
    if (event.type === "tool_result") {
      const value = JSON.parse(event.output!); const tool = events.find(e => e.id === event.toolUseId)?.name;
      const field = tool === "readLoopRunTimeline" ? "timeline" : tool === "readRunRecord" ? "recordRead" : "runtimeObservation";
      return { ...event, output: JSON.stringify({ ok: true, data: { [field]: value } }) };
    }
    return event;
  }) : events;
  async function* source(): AsyncGenerator<AgentMessage> {
    yield* input; yield { type: "text", content: "synthetic unsupported baseline draft" }; yield { type: "done" };
  }
  const output: AgentMessage[] = [];
  const stream = native ? guardDirectLoopRuntimeAnswer(source(), question, { ownerId }) : guardOwnerLoopFacetAnswer(source(), question, context);
  for await (const event of stream) output.push(event);
  const partial = output.find(e => e.answerEvidence?.schemaVersion === "owner-loop-partial-delivery.v1")?.answerEvidence;
  if (partial) {
    expect(partial).toMatchObject({ outputPolicy: "unsafe_draft_withheld_gap_notice", fullOriginalQuestionVerified: false, commitState: "uncommitted", sdkContextCommitObserved: false, committedIndependentFacts: [] });
    expect(output.filter(e => e.type === "text").map(e => e.content).join("")).not.toContain("synthetic unsupported");
    expect(output.some(e => e.type === "result")).toBe(false);
  }
  return { text: output.filter(e => e.type === "text").map(e => e.content).join(""),
    delivered: deliveryView(output.find(e => e.answerEvidence?.schemaVersion === "loop-runtime-facet-delivery.v1")?.answerEvidence),
    fallback: scopeView(output.find(e => e.answerEvidence?.schemaVersion === "owner-loop-partial-delivery.v1" || e.answerEvidence?.outputPolicy === "baseline_stream_preserved")?.answerEvidence) };
}
describe("v4 source creation time and unchanged initial anchor boundaries", () => {
  it.each([false, true])("real reader shape stays usable and discloses live multi-read limit: native=%s", async native => {
    const result = await render([...timeline(), ...records()], native); expect(result.delivered).toBeTruthy();
    expect(result.text).toContain(`失败基线 ${B}`); expect(result.text).toContain("不是跨读取的全局快照");
    expect(result.text).toContain("当前执行器活动未知"); expect(result.text).not.toContain("synthetic unsupported");
  });
  it.each([false, true])("a full hashed B created after C prevents claiming C repaired B: native=%s", async native => {
    const result = await render(replaceRecord([...timeline(), ...records()], B, record(B, "failed", stamp(3))), native);
    expect(result.delivered).toBeUndefined(); expect(result.fallback?.hostCoverage.repairCoverage?.timelineOrderAndCompleteRecordCreatedAtConsistent).toBe(false);
  });
  it.each([A, B, C])("every full record creation time must equal its timeline row: %s", async id => {
    const result = await render(replaceRecord([...timeline(), ...records()], id, record(id, id === C ? "completed" : "failed", stamp(4))));
    expect(result.delivered).toBeUndefined(); expect(result.fallback?.hostCoverage.repairCoverage?.timelineOrderAndCompleteRecordCreatedAtConsistent).toBe(false);
  });
  it.each([undefined, null, 0, "", "2026-02-30T00:00:01.000Z", "2026-10-04T00:00:01", "2026-10-04T08:00:01.000+08:00",
    "2026-10-04T00:00:01.0001Z", "2026-10-04T00:00:01.000Z ", "not-a-date"])("missing or non-published createdAt cannot use observedAt instead: %s", async value => {
    const result = await render(replaceRecord([...timeline(), ...records()], B, record(B, "failed", value, { observedAt: stamp(1) })));
    expect(result.delivered).toBeUndefined(); expect(result.fallback?.hostCoverage.repairCoverage?.gaps).toContainEqual({ runId: B, reason: "record_created_at_unavailable_or_invalid" });
  });
  it.each([{ id: A, status: "completed", createdAt: stamp(0) }, { id: A, status: "failed", createdAt: stamp(1) },
    { id: A, status: "failed", createdAt: undefined }, { id: B, status: "failed", createdAt: stamp(0) }])("a continuation cannot replace the first baseline: %s", async anchor => {
    const result = await render([...timeline("t0", [rows[0]], null, true), ...timeline("t1", [rows[1]], B, false, anchor), ...records()]);
    expect(result.delivered).toBeUndefined(); expect(result.fallback?.fullOriginalQuestionVerified).toBe(false);
  });
  it("third page compares to the original baseline as well", async () => {
    const third = { id: D, loopId, status: "completed", createdAt: stamp(3) };
    const result = await render([...timeline("t0", [rows[0]], null, true), ...timeline("t1", [rows[1]], B, true),
      ...timeline("t2", [third], C, false, { id: A, status: "completed", createdAt: stamp(0) }), ...records(), ...record(D, "completed", stamp(3))]);
    expect(result.delivered).toBeUndefined(); expect(result.fallback?.hostCoverage.invalid).toBe("owner_timeline_baseline_changed_across_reads");
  });
  it("continuous identical anchors on all three pages remain usable", async () => {
    const third = { id: D, loopId, status: "completed", createdAt: stamp(3) };
    const result = await render([...timeline("t0", [rows[0]], null, true), ...timeline("t1", [rows[1]], B, true),
      ...timeline("t2", [third], C), ...records(), ...record(D, "completed", stamp(3))]); expect(result.delivered).toBeTruthy();
  });
  it("equal creation instants keep the reader's increasing ID tie-break", async () => {
    const equal = [{ ...rows[0] }, { ...rows[1], createdAt: stamp(1) }];
    const result = await render(replaceRecord([...timeline("timeline", equal), ...records()], C, record(C, "completed", stamp(1)))); expect(result.delivered).toBeTruthy();
  });
  it("a complete two-window record retains its actual createdAt", async () => {
    const split = record(B, "failed", stamp(1), {}, 9000); const page = JSON.parse(split[1].output!);
    const document = JSON.stringify({ source: "loopRuns", id: B, fields: { id: B, loopId, status: "failed", createdAt: stamp(1), error: "synthetic_failure",
      verificationResult: { inputVersion: "input-v1", target: "artifact-B", expectedHash: good, observedHash: bad, passed: false }, outputSummary: "x".repeat(9000) } });
    const continuation = pair("record-B-tail", "readRunRecord", { runId: B, offset: page.nextOffset, expectedHash: page.contentHash },
      { ...evidenceWindow(document, page.nextOffset, page.contentHash), source: "loopRuns", id: B });
    const result = await render(replaceRecord([...timeline(), ...records()], B, [...split, ...continuation])); expect(result.delivered).toBeTruthy();
  });
  it.each(["ownerId", "userId"])("explicit foreign reader owner input is rejected: %s", async ownerKey => {
    const events = [...timeline(), ...records()]; events[0].input = { ...inputObject(events[0].input), [ownerKey]: other };
    const result = await render(events); expect(result.delivered).toBeUndefined(); expect(result.fallback?.hostCoverage.invalid).toBe("registered_owner_read_input_mismatch");
  });
  it("published UTC leap-day and epoch instants are accepted as source fields", () => {
    expect(isPublishedRunCreatedAt("2024-02-29T23:59:59.999Z")).toBe(true); expect(isPublishedRunCreatedAt("1970-01-01T00:00:00.000Z")).toBe(true);
  });
});
