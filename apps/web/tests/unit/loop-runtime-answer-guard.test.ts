import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@openzhiyu/ai/agent/types";
import { directLoopRuntimeQuestionId, guardDirectLoopRuntimeAnswer } from "@/lib/ai/loop-runtime-answer-guard";

const loopId = "780bf494-0095-4b8a-8d0b-3c6dd4996858";
const otherId = "3153b95e-df02-4d31-9949-04f19e4eb8d4";
const question = `Loop ID ${loopId} 现在是否在运行？请核对执行租约和心跳。`;
const observation = { ok: true, data: { runtimeObservation: {
  status: "no_active_linked_execution_observed", provider: "workshop_execution_leases",
  loopId, observedAt: "2026-09-24T00:00:00.000Z", observationScope: "active_linked_execution_mapping_only",
  loopConfiguration: { status: "active", updatedAt: "2026-09-23T00:00:00.000Z" }, linkedExecution: null,
} } };
const toolEvents: AgentMessage[] = [
  { type: "tool_use", id: "call", name: "platformRecall" },
  { type: "tool_result", toolUseId: "call", output: JSON.stringify(observation) },
];
async function collect(events: AgentMessage[], prompt = question) {
  async function* source() { for (const event of events) yield event; }
  const visible: AgentMessage[] = [];
  for await (const event of guardDirectLoopRuntimeAnswer(source(), prompt)) visible.push(event);
  return visible;
}

describe("direct Loop runtime answer guard", () => {
  it("selects only one exact, current Loop question", () => {
    expect(directLoopRuntimeQuestionId(question)).toBe(loopId);
    expect(directLoopRuntimeQuestionId(`Loop ID ${loopId} 和 ${otherId} 现在是否运行？`)).toBeNull();
    expect(directLoopRuntimeQuestionId(`Loop ID ${loopId} 昨天执行过什么？`)).toBeNull();
    expect(directLoopRuntimeQuestionId(`Work ID ${loopId} 现在是否运行？`)).toBeNull();
    expect(directLoopRuntimeQuestionId(`Work ID ${loopId} 所属 Loop 列表和当前运行记录`)).toBeNull();
  });
  it("replaces streamed lease absence claims before any answer token reaches the consumer", async () => {
    const events = [...toolEvents,
      { type: "text", content: "未观察到活动" }, { type: "text", content: "租约并不证明已停止。" },
      { type: "result", content: "success" }, { type: "done" }] as AgentMessage[];
    const visible = await collect(events);
    expect(visible.slice(0, 2)).toEqual(toolEvents);
    expect(visible.filter(e => e.type === "text")).toHaveLength(1);
    const answer = visible.find(e => e.type === "text")?.content ?? "";
    expect(answer).toContain("未查到活动的 Loop 与执行记录关联映射");
    expect(answer).toContain("没有评估该 Loop 的执行租约或心跳");
    expect(answer).toContain("配置更新时间 2026-09-23T00:00:00.000Z");
    expect(answer).not.toContain("未观察到活动租约");
    expect(visible.at(-1)?.type).toBe("done");
  });
  it("preserves a supported answer and its original streamed chunks", async () => {
    const text = "读取时没有活动关联映射，租约和心跳没有被评估；回答瞬间是否运行未知。";
    const events = [...toolEvents, { type: "text", content: text }, { type: "result", content: "success" }, { type: "done" }] as AgentMessage[];
    expect(await collect(events)).toEqual(events);
  });
  it("does not use mismatched or failed evidence to invent a runtime state", async () => {
    const mismatched = JSON.parse(JSON.stringify(observation));
    mismatched.data.runtimeObservation.loopId = otherId;
    const visible = await collect([
      { type: "tool_use", id: "bad", name: "platformRecall" },
      { type: "tool_result", toolUseId: "bad", output: JSON.stringify(mismatched) },
      { type: "tool_use", id: "failed", name: "platformRecall" },
      { type: "tool_result", toolUseId: "failed", output: JSON.stringify(observation), isError: true },
      { type: "text", content: "这个 Loop 正在运行。" }, { type: "result", content: "success" }, { type: "done" },
    ]);
    const answer = visible.find(e => e.type === "text")?.content ?? "";
    expect(answer).toContain("本轮未取得该 Loop 可用的执行观测");
    expect(answer).not.toContain("正在运行");
    expect(visible.filter(e => e.type === "tool_result")).toHaveLength(2);
  });
  it("does not promote a recent heartbeat to guaranteed present liveness", async () => {
    const active = JSON.parse(JSON.stringify(observation));
    active.data.runtimeObservation.status = "active_lease_recent_heartbeat";
    active.data.runtimeObservation.observationScope = "linked_execution_and_matching_lease";
    active.data.runtimeObservation.linkedExecution = { heartbeatFresh: true, leaseUnexpired: true };
    const visible = await collect([
      { type: "tool_use", id: "call", name: "platformRecall" },
      { type: "tool_result", toolUseId: "call", output: JSON.stringify(active) },
      { type: "text", content: "当前 Loop 执行器仍在线。" }, { type: "result", content: "success" }, { type: "done" },
    ]);
    const answer = visible.find(e => e.type === "text")?.content ?? "";
    expect(answer).toContain("观察到匹配的有效租约与近期心跳");
    expect(answer).toContain("不能证明回答瞬间的进程状态");
  });
  it("bounds the answer buffer and degrades explicitly", async () => {
    const visible = await collect([...toolEvents, { type: "text", content: "x".repeat(64_001) },
      { type: "result", content: "success" }, { type: "done" }] as AgentMessage[]);
    expect(visible.find(e => e.type === "text")?.content).toContain("没有评估该 Loop 的执行租约或心跳");
    expect(visible.some(e => e.content?.includes("xxx"))).toBe(false);
  });
  it("does not emit buffered text when the agent fails", async () => {
    const visible = await collect([...toolEvents, { type: "text", content: "未观察到活动租约" },
      { type: "error", message: "provider failed" }, { type: "done" }] as AgentMessage[]);
    expect(visible.some(e => e.type === "text" || e.type === "result")).toBe(false);
    expect(visible.some(e => e.type === "error")).toBe(true);
  });
  it("leaves unrelated questions as live streams", async () => {
    const events = [{ type: "text", content: "hello" }, { type: "done" }] as AgentMessage[];
    expect(await collect(events, "你好")).toEqual(events);
  });
});
