import { describe, expect, it } from "vitest";
import { buildAnswerRequirements } from "@/lib/brain/answer-requirements";
describe("answer requirements", () => {
  it("splits comma questions while retaining the subject in original context", () => {
    const result = buildAnswerRequirements("AI 博主承担什么使命，目前处于什么状态？");
    expect(result.requirements).toEqual(["AI 博主承担什么使命", "目前处于什么状态"]);
    expect(result.originalQuestion).toContain("AI 博主");
  });
  it("expands a supported list of record fields without treating the list as a comparison", () => {
    expect(buildAnswerRequirements("记录 abc 的引擎、适配器和模型分别是什么？").requirements).toHaveLength(3);
    const comparison = buildAnswerRequirements("引擎和适配器有什么区别？");
    expect(comparison.requirements).toEqual(["引擎和适配器有什么区别"]);
    expect(comparison.unresolved).toHaveLength(1);
  });
  it("never silently drops unknown facets", () => {
    const result = buildAnswerRequirements("它的使命和模型和工资是什么？");
    expect(result.unresolved).toContain("它的使命和模型和工资是什么");
    expect(result.requirements).toContain("它的使命和模型和工资是什么");
    expect(buildAnswerRequirements("记录 abc 的引擎、适配器和模型以及费用是什么？").unresolved).toHaveLength(1);
    expect(buildAnswerRequirements("引擎和费用是什么，当前状态是什么？").unresolved).toContain("引擎和费用是什么");
  });
  it("uses explicit requirements without rewriting them", () => {
    expect(buildAnswerRequirements("q", ["condition A", "condition B", "condition A"]).requirements).toEqual(["condition A", "condition B"]);
  });
});
