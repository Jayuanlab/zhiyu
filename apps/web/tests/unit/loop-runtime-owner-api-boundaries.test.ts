import type { LoopRuntimeObservationFacet } from "@/lib/ai/loop-runtime-evidence-boundary";
import type { OwnerLoopFacetSession } from "@/lib/ai/loop-owner-facet-session";
type DeliveryView = { runtimeFacet: LoopRuntimeObservationFacet; rawModelProse: string };
type ScopeView = { protectedByNewRuntimeBoundary: boolean; hostCoverage: ReturnType<OwnerLoopFacetSession["project"]> };
// Test projection types describe real host metadata; no AgentMessage substitute or ambient shim.
const deliveryView = (value: Record<string, unknown> | undefined) => value as DeliveryView | undefined;
const scopeView = (value: Record<string, unknown> | undefined) => value as ScopeView | undefined;
const inputObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid_synthetic_tool_input");
  return value as Record<string, unknown>;
};
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@openzhiyu/ai/agent/types";
import { directLoopRuntimeQuestionId, guardDirectLoopRuntimeAnswer } from "@/lib/ai/loop-runtime-answer-guard";
import { guardOwnerLoopFacetAnswer } from "@/lib/ai/loop-owner-facet-session";
const ownerId = "11111111-1111-4111-8111-111111111111";
const loopId = "780bf494-0095-4b8a-8d0b-3c6dd4996858", otherId = "3153b95e-df02-4d31-9949-04f19e4eb8d4";
const question = `Loop ID ${loopId} 现在是否在运行？请核对执行租约和心跳。`;
const observedAt = "2026-09-24T00:00:00.000Z";
type RuntimeFixture = { ownerId: string; status: string; provider: string; loopId: string; observedAt: string;
  observationScope: string; loopConfiguration: { status: string; updatedAt: string }; maximumHeartbeatAgeMs?: number;
  linkedExecution: null | { heartbeatFresh: boolean; leaseUnexpired: boolean; leaseMatchesRun: boolean; workRunId: string;
    loopRunId: string; leaseUntil: string; leasePhase: string; workRunStatus: string; heartbeatAt: string; heartbeatAgeMs: number } };
const observation: { ok: boolean; data: { runtimeObservation: RuntimeFixture } } = { ok: true, data: { runtimeObservation: {
  ownerId, status: "no_active_linked_execution_observed", provider: "workshop_execution_leases",
  loopId, observedAt, observationScope: "active_linked_execution_mapping_only",
  loopConfiguration: { status: "active", updatedAt: "2026-09-23T00:00:00.000Z" }, linkedExecution: null,
} } };
function registered(output: unknown = observation, input?: unknown, name = "platformRecall", callId = "call"): AgentMessage[] {
  const actualInput = arguments.length < 2 ? { runtimeRead: { loopId } } : input;
  return [{ type: "tool_use", id: callId, name, input: actualInput },
    { type: "tool_result", toolUseId: callId, output: JSON.stringify(output) }] satisfies AgentMessage[];
}
const tail = [{ type: "text", content: "未观察到活动租约。当前执行器已经停止。" },
  { type: "result", content: "success" }, { type: "done" }] satisfies AgentMessage[];
async function collect(events: AgentMessage[], prompt = question, host: { ownerId: string } | undefined = { ownerId }) {
  async function* source() { yield* events; }
  const output: AgentMessage[] = [];
  for await (const e of guardDirectLoopRuntimeAnswer(source(), prompt, host)) output.push(e);
  return output;
}
const answer = (events: AgentMessage[]) => events.filter(e => e.type === "text").map(e => e.content).join("");
const delivered = (events: AgentMessage[]) => deliveryView(events.find(e => e.type === "answer_evidence"
  && e.answerEvidence?.schemaVersion === "loop-runtime-facet-delivery.v1")?.answerEvidence);
describe("nine original runtime obligations migrated to authenticated registered-reader API", () => {
  it("selects only one exact, current Loop question", () => {
    expect(directLoopRuntimeQuestionId(question)).toBe(loopId);
    for (const prompt of [`Loop ID ${loopId} 和 ${otherId} 现在是否运行？`, `Loop ID ${loopId} 昨天执行过什么？`,
      `Work ID ${loopId} 现在是否运行？`, `Work ID ${loopId} 所属 Loop 列表和当前运行记录`]) expect(directLoopRuntimeQuestionId(prompt)).toBeNull();
  });
  it("admits the same complete lease/heartbeat vocabulary", () => {
    for (const details of ["leaseMatchesRun and heartbeatFresh", "leases and heartbeats", "leaseUntil and heartbeatAgeMs", "heart-beat", "heart beat"])
      expect(directLoopRuntimeQuestionId(`Loop ${loopId} current ${details}?`)).toBe(loopId);
  });
  it("withholds lease absence inference before visible answer tokens", async () => {
    const events = registered(); const output = await collect([...events, ...tail]);
    expect(output.slice(0, 2)).toEqual(events); expect(output.filter(e => e.type === "text")).toHaveLength(1);
    expect(answer(output)).toContain("未查到活动的 Loop 与执行记录关联映射");
    expect(answer(output)).toContain("未评估该 Loop 的执行租约或心跳");
    expect(delivered(output)?.runtimeFacet.configuration?.updatedAt).toBe("2026-09-23T00:00:00.000Z");
    expect(answer(output)).not.toContain("未观察到活动租约"); expect(output.at(-1)?.type).toBe("done");
  });
  it("retains supported observed facts and unknown present activity", async () => {
    const output = await collect([...registered(), { type: "text", content: "读取时没有活动关联映射，租约和心跳没有被评估；回答瞬间是否运行未知。" }, ...tail.slice(1)]);
    expect(delivered(output)?.runtimeFacet.mapping).toBe("no_active_linked_mapping_observed");
    expect(answer(output)).toContain("当前执行器活动未知");
    expect(delivered(output)?.rawModelProse).toBe("withheld_not_independently_verified");
  });
  it("does not use mismatched or failed evidence to invent state", async () => {
    const mismatched = structuredClone(observation); mismatched.data.runtimeObservation.loopId = otherId;
    const fail = registered(observation, { runtimeRead: { loopId } }, "platformRecall", "failed");
    fail[1].isError = true;
    const output = await collect([...registered(mismatched), ...fail, ...tail]);
    expect(delivered(output)?.runtimeFacet.state).toBe("unknown"); expect(answer(output)).toContain("当前执行器活动未知");
    expect(answer(output)).not.toContain("正在运行"); expect(output.filter(e => e.type === "tool_result")).toHaveLength(2);
  });
  it("does not promote a matching recent heartbeat to guaranteed present liveness", async () => {
    const active = structuredClone(observation); const value = active.data.runtimeObservation;
    value.status = "active_lease_recent_heartbeat"; value.observationScope = "linked_execution_and_matching_lease";
    value.maximumHeartbeatAgeMs = 60000; value.linkedExecution = { workRunId: otherId, loopRunId: "33333333-3333-4333-8333-333333333333",
      leaseMatchesRun: true, leaseUnexpired: true, leaseUntil: "2026-09-24T00:01:00.000Z", leasePhase: "running", workRunStatus: "running",
      heartbeatFresh: true, heartbeatAt: "2026-09-23T23:59:50.000Z", heartbeatAgeMs: 10000 };
    const output = await collect([...registered(active), ...tail]);
    expect(answer(output)).toContain("观察到匹配的有效租约与近期心跳");
    expect(answer(output)).toContain("回答瞬间进程活动仍未知");
  });
  it("bounds delivery by withholding arbitrary answer chunks", async () => {
    const output = await collect([...registered(), { type: "text", content: "x".repeat(64001) }, ...tail.slice(1)]);
    expect(answer(output)).toContain("未评估该 Loop 的执行租约或心跳"); expect(answer(output)).not.toContain("xxx");
  });
  it("does not emit answer success when the agent fails", async () => {
    const output = await collect([...registered(), { type: "text", content: "未观察到活动租约" }, { type: "error", message: "provider failed" }, { type: "done" }]);
    expect(output.some(e => e.type === "text" || e.type === "result")).toBe(false); expect(output.some(e => e.type === "error")).toBe(true);
  });
  it("leaves unrelated questions as live streams", async () => {
    const events = [{ type: "text", content: "hello" }, { type: "done" }] satisfies AgentMessage[];
    expect(await collect(events, "你好")).toEqual(events);
  });
});
describe("hard host and actual call/source boundaries", () => {
  it("missing and explicitly undefined host do not crash or gain protected delivery", async () => {
    async function* source() { yield* tail; }
    for (const output of [await Array.fromAsync(guardDirectLoopRuntimeAnswer(source(), question)),
      await Array.fromAsync(guardDirectLoopRuntimeAnswer(source(), question, undefined)),
      await collect(tail, question, { ownerId: "invalid" })]) {
      expect(delivered(output)).toBeUndefined(); expect(output.some(e => e.answerEvidence?.protectedByNewRuntimeBoundary === false)).toBe(true);
    }
  });
  for (const [name, input] of [["wrong runtimeRead subject", { runtimeRead: { loopId: otherId } }],
    ["unregistered bare Loop parameter", { loopId }], ["absent reader input", undefined],
    ["wrong question subject", { question: `Loop ${otherId} 现在是否运行？` }],
    ["unrelated source selector", { runtimeRead: { loopId }, recordRead: { source: "loops", id: loopId } }]] as const) {
    it(name, async () => {
      const output = await collect([...registered(observation, input), ...tail]);
      expect(delivered(output)?.runtimeFacet.state).toBe("unknown");
      expect(delivered(output)?.runtimeFacet.observedAt).toBeNull();
    });
  }
  it("wrong owner output is unknown", async () => {
    const wrong = structuredClone(observation); wrong.data.runtimeObservation.ownerId = otherId;
    expect(delivered(await collect([...registered(wrong), ...tail]))?.runtimeFacet.state).toBe("unknown");
  });
  it("unregistered tool name/result id and wrong provider are unknown", async () => {
    const wrongSource = structuredClone(observation); wrongSource.data.runtimeObservation.provider = "other_source";
    const wrongCall = registered(); wrongCall[1].toolUseId = "not-called";
    for (const events of [registered(observation, { runtimeRead: { loopId } }, "Read"), wrongCall, registered(wrongSource)])
      expect(delivered(await collect([...events, ...tail]))?.runtimeFacet.state).toBe("unknown");
  });
  it("multi, mismatch and implicit pronoun questions do not enter the shared owner guard", async () => {
    async function* source() { yield* tail; }
    for (const prompt of [`Loop ${loopId} 和 Loop ${otherId} 现在是否运行？`, `Loop ${otherId} 现在是否运行？`, "它现在是否运行？"])
      expect(delivered(await Array.fromAsync(guardOwnerLoopFacetAnswer(source(), prompt, { ownerId, loopId,
        adapter: "owner_workflow_runtime_reader", toolName: "readLoopRuntimeObservation" })))).toBeUndefined();
  });
});
