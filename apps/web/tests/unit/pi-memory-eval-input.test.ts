import { describe, expect, it } from "vitest";
import { buildMemoryEvalRequest } from "../../scripts/lib/pi-memory-eval-request.mjs";

describe("memory evaluation input boundary", () => {
  it("does not let gold labels or expected tool sources influence the HTTP request", () => {
    const question = "这个车间现在是什么状态？";
    const first = buildMemoryEvalRequest({ question, gold: "secret answer", evalRequirements: { platformRecallSections: ["architecture"] } }, ["platformRecall"]);
    const second = buildMemoryEvalRequest({ question, gold: "different answer", evalRequirements: { platformRecallSections: ["brain"] } }, ["platformRecall"]);
    expect(first).toEqual(second);
    expect(first.prompt).toBe(question);
    expect(JSON.stringify(first)).not.toMatch(/secret answer|platformRecallSections|evalRequirements/);
    expect(first.allowedTools).toEqual(["platformRecall"]);
  });
});
