import { describe, expect, it } from "vitest";
import { taskState } from "@/lib/interactions/task-state";

describe("interaction task meaning and source time", () => {
  it("does not equate confirming information with completing a task", () => {
    expect(taskState({title: "task", status: "confirmed", dueAt: null, metadata: {}})).toMatchObject({verificationStatus: "confirmed", taskStatus: "open", needsTimeReview: true});
  });
  it("anchors a historical tomorrow to its original message, not digest generation", () => {
    expect(taskState({title: "明天回复材料", status: "candidate", dueAt: null, metadata: {}, sourceObservedAt: "2026-08-03T18:00:00+08:00"})).toMatchObject({dueAt: "2026-08-04T15:59:59.999Z", dueAtConfidence: "inferred", needsTimeReview: true});
  });
  it("leaves missing or ambiguous dates pending review", () => {
    expect(taskState({title: "明天回复", status: "candidate", dueAt: null, metadata: {}}).dueAt).toBeNull();
    expect(taskState({title: "今天或明天回复", status: "candidate", dueAt: null, metadata: {}, sourceObservedAt: "2026-08-03T18:00:00+08:00"}).dueAt).toBeNull();
    expect(taskState({title: "明天回复", status: "candidate", dueAt: null, metadata: {}, sourceObservedAt: "2026-08-03T18:00:00"}).dueAt).toBeNull();
  });
});
