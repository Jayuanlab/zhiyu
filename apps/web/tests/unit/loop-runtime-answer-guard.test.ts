import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@openzhiyu/ai/agent/types";
import { directLoopRuntimeQuestionId, guardDirectLoopRuntimeAnswer } from "@/lib/ai/loop-runtime-answer-guard";
import { exactCurrentLoopEvidenceSubject } from "@/lib/ai/runtime/answer-evidence-session";

const ownerId = "11111111-1111-4111-8111-111111111111";
const loopId = "780bf494-0095-4b8a-8d0b-3c6dd4996858";
const otherId = "3153b95e-df02-4d31-9949-04f19e4eb8d4";
const question = `Loop ID ${loopId} 现在是否在运行？请核对执行租约和心跳。`;
type RuntimeFixture = { ownerId: string; status: string; provider: string; loopId: string; observedAt: string;
  observationScope: string; loopConfiguration: { status: string; updatedAt: string }; maximumHeartbeatAgeMs?: number;
  linkedExecution: null | { heartbeatFresh: boolean; leaseUnexpired: boolean; leaseMatchesRun: boolean; workRunId: string;
    loopRunId: string; leaseUntil: string; leasePhase: string; workRunStatus: string; heartbeatAt: string; heartbeatAgeMs: number } };
const observation: { ok: boolean; data: { runtimeObservation: RuntimeFixture } } = { ok: true, data: { runtimeObservation: {
  ownerId, status: "no_active_linked_execution_observed", provider: "workshop_execution_leases",
  loopId, observedAt: "2026-09-24T00:00:00.000Z", observationScope: "active_linked_execution_mapping_only",
  loopConfiguration: { status: "active", updatedAt: "2026-09-23T00:00:00.000Z" }, linkedExecution: null,
} } };
const toolEvents: AgentMessage[] = [
  { type: "tool_use", id: "call", name: "platformRecall", input: { runtimeRead: { loopId } } },
  { type: "tool_result", toolUseId: "call", output: JSON.stringify(observation) },
];
async function collect(events: AgentMessage[], prompt = question) {
  async function* source() { for (const event of events) yield event; }
  const visible: AgentMessage[] = [];
  for await (const event of guardDirectLoopRuntimeAnswer(source(), prompt, { ownerId })) visible.push(event);
  return visible;
}

function assertRuntimeDelivery(events: AgentMessage[], expected: Record<string, unknown>) {
  const delivery = events.find(e => e.type === "answer_evidence" && e.answerEvidence?.schemaVersion === "loop-runtime-facet-delivery.v1")?.answerEvidence;
  expect(delivery).toMatchObject({ rawModelProse: "withheld_not_independently_verified", fullOriginalQuestionVerified: false,
    contentVerdict: "requires_independent_review" });
  expect(delivery?.runtimeFacet).toMatchObject({ schemaVersion: "loop-runtime-observation-facet.v1", provider: "workshop_execution_leases",
    subject: { ownerId, loopId }, currentProcessActivity: "unknown", ...expected });
  expect(events.filter(e => e.type === "tool_use")).toHaveLength(events.filter(e => e.type === "tool_result").length);
  return delivery;
}
const exactAbsent = { state: "observed", reason: null, toolCallId: "call", observedAt: "2026-09-24T00:00:00.000Z",
  mapping: "no_active_linked_mapping_observed", lease: { evaluated: false, matchesRun: null, unexpired: null },
  heartbeat: { evaluated: false, fresh: null, ageMs: null }, configuration: { status: "active", updatedAt: "2026-09-23T00:00:00.000Z" } };
describe("direct Loop runtime answer guard", () => {
  it("selects only one exact, current Loop question", () => {
    expect(directLoopRuntimeQuestionId(question)).toBe(loopId);
    expect(directLoopRuntimeQuestionId(`Loop ID ${loopId} 和 ${otherId} 现在是否运行？`)).toBeNull();
    expect(directLoopRuntimeQuestionId(`Loop ID ${loopId} 昨天执行过什么？`)).toBeNull();
    expect(directLoopRuntimeQuestionId(`Work ID ${loopId} 现在是否运行？`)).toBeNull();
    expect(directLoopRuntimeQuestionId(`Work ID ${loopId} 所属 Loop 列表和当前运行记录`)).toBeNull();
  });
  it("admits the same lease/heartbeat vocabulary through the complete session predicate", () => {
    for (const details of ["leaseMatchesRun and heartbeatFresh", "leases and heartbeats", "leaseUntil and heartbeatAgeMs", "heart-beat", "heart beat"]) {
      const prompt = `Loop ${loopId} current ${details}?`;
      expect(directLoopRuntimeQuestionId(prompt)).toBe(loopId);
      expect(exactCurrentLoopEvidenceSubject(prompt)).not.toBeNull();
      expect(exactCurrentLoopEvidenceSubject(`${prompt} and pause it now`)).toBeNull();
      expect(exactCurrentLoopEvidenceSubject(`${prompt} compare Loop ${otherId}`)).toBeNull();
    }
  });
  it("replaces streamed lease absence claims before any answer token reaches the consumer", async () => {
    const events = [...toolEvents,
      { type: "text", content: "未观察到活动" }, { type: "text", content: "租约并不证明已停止。" },
      { type: "result", content: "success" }, { type: "done" }] satisfies AgentMessage[];
    const visible = await collect(events);
    assertRuntimeDelivery(visible, exactAbsent);
    expect(visible.slice(0, 2)).toEqual(toolEvents);
    expect(visible.filter(e => e.type === "text")).toHaveLength(1);
    const answer = visible.find(e => e.type === "text")?.content ?? "";
    expect(answer).toContain("未查到活动的 Loop 与执行记录关联映射");
    expect(answer).toContain("未评估该 Loop 的执行租约或心跳");
    const evidence = visible.find(e => e.answerEvidence?.schemaVersion === "loop-runtime-facet-delivery.v1")?.answerEvidence;
    const runtime = evidence?.runtimeFacet;
    expect(runtime && typeof runtime === "object" && "configuration" in runtime && runtime.configuration).toMatchObject({ updatedAt: "2026-09-23T00:00:00.000Z" });
    expect(answer).not.toContain("未观察到活动租约");
    expect(visible.at(-1)?.type).toBe("done");
  });
  // originalTestTitle: preserves a supported answer and its original streamed chunks
  // The authenticated contract preserves canonical fact semantics and refs, not chunk bytes.
  it("preserves supported runtime semantics and refs in the canonical answer", async () => {
    const text = "读取时没有活动关联映射，租约和心跳没有被评估；回答瞬间是否运行未知。";
    const events = [...toolEvents, { type: "text", content: text }, { type: "result", content: "success" }, { type: "done" }] satisfies AgentMessage[];
    const visible = await collect(events);
    expect(visible.slice(0, 2)).toEqual(toolEvents);
    expect(visible.find(e => e.answerEvidence?.schemaVersion === "loop-runtime-facet-delivery.v1")?.answerEvidence?.runtimeFacet)
      .toMatchObject({ mapping: "no_active_linked_mapping_observed", currentProcessActivity: "unknown", lease: { evaluated: false }, heartbeat: { evaluated: false } });
    expect(visible.filter(e => e.type === "text")).toHaveLength(1);
    expect(visible.find(e => e.type === "text")?.content).toContain("当前执行器活动未知");
  });
  it("does not use mismatched or failed evidence to invent a runtime state", async () => {
    const mismatched = structuredClone(observation);
    mismatched.data.runtimeObservation.loopId = otherId;
    const visible = await collect([
      { type: "tool_use", id: "bad", name: "platformRecall", input: { runtimeRead: { loopId } } },
      { type: "tool_result", toolUseId: "bad", output: JSON.stringify(mismatched) },
      { type: "tool_use", id: "failed", name: "platformRecall", input: { runtimeRead: { loopId } } },
      { type: "tool_result", toolUseId: "failed", output: JSON.stringify(observation), isError: true },
      { type: "text", content: "这个 Loop 正在运行。" }, { type: "result", content: "success" }, { type: "done" },
    ]);
    const answer = visible.find(e => e.type === "text")?.content ?? "";
    expect(answer).toContain("本轮执行观测未核实");
    expect(answer).not.toContain("正在运行");
    assertRuntimeDelivery(visible, { state: "unknown", observedAt: null, mapping: "unknown", lease: { evaluated: false }, heartbeat: { evaluated: false } });
    expect(visible.filter(e => e.type === "tool_result")).toHaveLength(2);
  });
  it("does not promote a recent heartbeat to guaranteed present liveness", async () => {
    const active = structuredClone(observation);
    active.data.runtimeObservation.status = "active_lease_recent_heartbeat";
    active.data.runtimeObservation.observationScope = "linked_execution_and_matching_lease";
    active.data.runtimeObservation.maximumHeartbeatAgeMs = 60000;
    active.data.runtimeObservation.linkedExecution = { heartbeatFresh: true, leaseUnexpired: true, leaseMatchesRun: true,
      workRunId: otherId, loopRunId: "33333333-3333-4333-8333-333333333333", leaseUntil: "2026-09-24T00:01:00.000Z",
      leasePhase: "running", workRunStatus: "running", heartbeatAt: "2026-09-23T23:59:50.000Z", heartbeatAgeMs: 10000 };
    const visible = await collect([
      { type: "tool_use", id: "call", name: "platformRecall", input: { runtimeRead: { loopId } } },
      { type: "tool_result", toolUseId: "call", output: JSON.stringify(active) },
      { type: "text", content: "当前 Loop 执行器仍在线。" }, { type: "result", content: "success" }, { type: "done" },
    ]);
    const answer = visible.find(e => e.type === "text")?.content ?? "";
    assertRuntimeDelivery(visible, { state: "observed", reason: null, observedAt: "2026-09-24T00:00:00.000Z", mapping: "linked", lease: { evaluated: true, matchesRun: true, unexpired: true }, heartbeat: { evaluated: true, fresh: true, ageMs: 10000 }, observedActivity: "matching_lease_recent_heartbeat" });
    expect(answer).toContain("观察到匹配的有效租约与近期心跳");
    expect(answer).toContain("回答瞬间进程活动仍未知");
  });
  it("bounds the answer buffer and degrades explicitly", async () => {
    const visible = await collect([...toolEvents, { type: "text", content: "x".repeat(64_001) },
      { type: "result", content: "success" }, { type: "done" }] satisfies AgentMessage[]);
    expect(visible.find(e => e.type === "text")?.content).toContain("未评估该 Loop 的执行租约或心跳");
    assertRuntimeDelivery(visible, exactAbsent);
    expect(visible.some(e => e.content?.includes("xxx"))).toBe(false);
  });
  it("does not emit buffered text when the agent fails", async () => {
    const visible = await collect([...toolEvents, { type: "text", content: "未观察到活动租约" },
      { type: "error", message: "provider failed" }, { type: "done" }] satisfies AgentMessage[]);
    expect(visible.some(e => e.type === "text" || e.type === "result")).toBe(false);
    expect(visible.some(e => e.type === "error")).toBe(true);
    expect(visible.some(e => e.answerEvidence?.schemaVersion === "loop-runtime-facet-delivery.v1")).toBe(false);
  });
  it("leaves unrelated questions as live streams", async () => {
    const events = [{ type: "text", content: "hello" }, { type: "done" }] satisfies AgentMessage[];
    expect(await collect(events, "你好")).toEqual(events);
  });
});
