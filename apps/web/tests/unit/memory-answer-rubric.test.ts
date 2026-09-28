import { describe, expect, it } from "vitest";
import { answerRubric } from "../../scripts/memory-answer-rubric-v2.mjs";

describe("question-aligned evaluation rubric", () => {
  it("removes unasked tier without mutating historical gold", () => {
    const c = { id: "REAL-025", question: "engine adapter model", expected: { facts: { run_id: "r", engine: "pi", adapter: "h", model: "m", model_tier: "cheap" } } };
    const rubric = answerRubric(c);
    expect(rubric.requirements.map((r: any) => r.id)).toEqual(["facts.engine", "facts.adapter", "facts.model"]);
    expect(c.expected.facts.model_tier).toBe("cheap");
  });
  it("keeps zero distinct from unsupported evidence and retains safety musts", () => {
    const rubric = answerRubric({ id: "REAL-028", question: "heartbeat", expected: { facts: { total: 0, scope: "owner", table: "heartbeats" }, must: ["No inference of inactivity"] } });
    expect(rubric.requirements).toEqual([{ id: "facts.total", expected: 0 }, { id: "must.0", expected: "No inference of inactivity" }]);
  });
});
