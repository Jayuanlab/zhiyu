import { describe, expect, it, vi } from "vitest";
import { createHostAnswerEvidenceSession, selectHostAnswerEvidenceContract } from "@/lib/ai/runtime/answer-evidence-selection";

const id = "11111111-1111-4111-8111-111111111111";
describe("one host-selected answer contract", () => {
  it("chooses only the established Loop gate for its exact current executor question", () => {
    const question = `Loop ${id} 当前执行器正在运行吗？`;
    expect(selectHostAnswerEvidenceContract(question, { loopMode: "enforce_critical", platformMode: "enforce_supported" }))
      .toMatchObject({ kind: "loop", mode: "enforce_critical", loopId: id });
    expect(selectHostAnswerEvidenceContract(question, { loopMode: "off", platformMode: "enforce_supported" })).toBeNull();
  });
  it("requires a valid server mode and supported original read-only question", () => {
    const question = `loopRuns ${id} 的输出和验证结果是什么？`;
    expect(selectHostAnswerEvidenceContract(question, { platformMode: "enforce_supported" })).toMatchObject({ kind: "platform", mode: "enforce_supported", scope: "supported_platform_readonly" });
    for (const mode of [undefined, "off", "enforce_critical", "anything"]) expect(selectHostAnswerEvidenceContract(question, { platformMode: mode })).toBeNull();
    for (const text of [`暂停 Loop ${id} 然后读结果`, `读取 loopRuns ${id} 并删除它`, "截至昨天的记忆分布有多少？", "解释一个完全无关问题"])
      expect(selectHostAnswerEvidenceContract(text, { platformMode: "enforce_supported" })).toBeNull();
  });
  it("binds platform plan to the host original question and one idempotent finalization", async () => {
    const question = `chat ${id} 的标题是什么？`;
    const selected = selectHostAnswerEvidenceContract(question, { platformMode: "enforce_supported" })!;
    const auditSink = vi.fn(async () => undefined);
    const authorizeFinal = vi.fn(async () => true);
    const session = createHostAnswerEvidenceSession(selected, { ownerId: "owner-a", turnId: "turn-a", runtimeHash: "runtime",
      policyHash: "policy", question, auditSink, authorizeFinal });
    const input = { terminal: { schemaVersion: "agent-runtime-terminal.v1" as const, status: "completed" as const, cleanupStatus: "completed" as const }, rawDraft: "invented title" };
    const [one, two] = await Promise.all([session.finalize(input), session.finalize(input)]);
    expect(one).toBe(two); expect(one.renderedText).not.toContain("invented title");
    expect(authorizeFinal).toHaveBeenCalledOnce();
    expect(auditSink.mock.calls.filter(([event]: any[]) => event.eventType === "final_evidence")).toHaveLength(1);
  });
});
