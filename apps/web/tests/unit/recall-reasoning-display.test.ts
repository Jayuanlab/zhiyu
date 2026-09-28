import { describe, expect, it } from "vitest";
import { describeRecallReasoning } from "@/lib/ai/recall-reasoning-display";
const event = (fields: object) => JSON.stringify({ stage: "jev_replaces_initial_recall_decision", ...fields });
describe("recall reasoning display", () => {
  it("does not present an uncertain selected subset as successful retrieval", () => {
    const result = describeRecallReasoning(event({ status: "degraded", detail: "uncertain_route", sources: ["architecture"] }), "zh-CN");
    expect(result).toContain("不确定"); expect(result).not.toContain("项目架构");
  });
  it("distinguishes source selection from retrieved evidence", () => {
    expect(describeRecallReasoning(event({ status: "ok", sources: ["architecture", "records"] }), "zh")).toContain("具体事实以工具读取结果为准");
    expect(describeRecallReasoning(event({ status: "ok", sources: [] }), "en")).toContain("No source");
  });
  it("preserves ordinary reasoning, partial JSON and unknown protocols", () => {
    for (const input of ["ordinary reasoning", "{", '{"stage":"other"}', event({ status: "ok", sources: ["__proto__"] })]) {
      expect(describeRecallReasoning(input, "zh")).toBeNull();
    }
  });
  it("shows cancellation separately from transport fallback", () => {
    expect(describeRecallReasoning(event({ status: "degraded", detail: "aborted" }), "zh")).toContain("取消");
    expect(describeRecallReasoning(event({ status: "degraded", detail: "timeout" }), "zh")).toContain("暂不可用");
  });
});
