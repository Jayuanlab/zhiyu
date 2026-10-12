import { describe, expect, it } from "vitest";
import { buildPlatformAnswerCoverage } from "@/lib/ai/platform-answer-coverage";

describe("question-driven record coverage", () => {
  it("retains trigger, action and approval obligations including hard deny fields", () => {
    const plan = buildPlatformAnswerCoverage("任务什么时候自动触发，能做哪些动作，哪些动作要等我审核？", [{ source: "loops", id: "task",
      fields: { triggerConfig: { cron: "0 8 * * *" }, actionPolicy: { denied: ["send"] }, approvalPolicy: { externalWrites: "deny" } } }]);
    expect(plan.facts.find(fact => fact.field === "approvalPolicy")).toMatchObject({ value: { externalWrites: "deny" } });
    expect(plan.obligations.map(item => item.requestedFields)).toEqual(expect.arrayContaining([["triggerConfig"], ["actionPolicy"], ["approvalPolicy", "boundaryPolicy"]]));
    expect(plan.answerCompleteness).toBe("not_verified");
  });
  it("keeps the parent task identity and run result as separate sourced facts", () => {
    const plan = buildPlatformAnswerCoverage("这次运行属于哪个持续任务？说明任务目标、本次触发原因及运行结果。", [
      { source: "loop_runs", id: "run", fields: { loop_id: "task", trigger_reason: "schedule", output_summary: "Built the report", name: "wrong run label" } },
      { source: "loops", id: "task", fields: { name: "Research", goal: "Review evidence" } },
    ]);
    const relationship = plan.obligations.find(item => item.requestedFields.includes("loopId"))!;
    expect(relationship.references).toEqual(expect.arrayContaining([{ evidenceId: "loops:task", field: "name", state: "available" }, { evidenceId: "loop_runs:run", field: "loop_id", state: "available" }]));
    expect(relationship.references).not.toContainEqual(expect.objectContaining({ evidenceId: "loop_runs:run", field: "name" }));
    expect(plan.facts).not.toContainEqual(expect.objectContaining({ evidenceId: "loop_runs:run", field: "name" }));
    expect(plan.facts).toContainEqual(expect.objectContaining({ evidenceId: "loops:task", field: "goal", value: "Review evidence" }));
  });
  it("exposes an unread large field with a version-bound read without inventing its content", () => {
    const record = { source: "loopRuns", id: "run", fields: { status: "completed" }, fieldAvailability: { status: "shown", outputSummary: "present_unread" },
      read: { source: "loopRuns", id: "run", offset: 0, expectedHash: "a".repeat(64) } };
    const plan = buildPlatformAnswerCoverage("运行结果是什么？", [record]);
    expect(plan.obligations[0].references).toContainEqual(expect.objectContaining({ field: "outputSummary", state: "present_unread", read: record.read }));
    expect(plan.facts.some(fact => fact.field === "outputSummary")).toBe(false);
    expect(plan.obligations[0].unreadFields).toEqual(["outputSummary"]);
    expect(plan.obligations[0].status).toBe("exact_read_required");
    expect(plan.answerCompleteness).toBe("not_verified");
  });
  it("keeps missing, NULL and empty values distinct and never certifies every obligation", () => {
    const plan = buildPlatformAnswerCoverage("触发原因和实际内容是什么？", [{ source: "loopRuns", id: "run", fields: { triggerReason: null, body: "" } }]);
    expect(plan.facts).toEqual(expect.arrayContaining([expect.objectContaining({ field: "triggerReason", state: "not_recorded" })]));
    expect(plan.obligations.find(item => item.requestedFields.includes("triggerReason"))?.status).toBe("no_recorded_value");
    const absent = buildPlatformAnswerCoverage("哪些动作需要审核？", []);
    expect(absent.obligations.every(item => item.status === "unobserved")).toBe(true);
    expect(absent.answerCompleteness).toBe("not_verified");
  });
  it("lists absent requested fields separately when another field was read", () => {
    const plan = buildPlatformAnswerCoverage("引擎、适配器、模型是什么？", [{ source: "workshopRuntimeSnapshots", id: "snapshot", fields: { engine: "pi" } }]);
    expect(plan.obligations[0]).toMatchObject({ status: "partial_evidence", missingFields: ["adapter", "model"], unreadFields: [] });
    expect(plan.answerCompleteness).toBe("not_verified");
  });
  it("preserves undefined and empty fields without calling them present facts", () => {
    const plan = buildPlatformAnswerCoverage("实际内容和触发原因是什么？", [{ source: "run", id: "one", fields: { body: "", triggerReason: undefined, content: {} } }]);
    expect(plan.facts).toEqual(expect.arrayContaining([expect.objectContaining({ field: "triggerReason", state: "unobserved" }),
      expect.objectContaining({ field: "body", state: "empty_string" }), expect.objectContaining({ field: "content", state: "empty_object" })]));
  });
  it("never slices a large policy object into an allowed-only JSON prefix", () => {
    const policy = { allowed: ["read"], padding: "x".repeat(3000), denied: ["external_write"] };
    const plan = buildPlatformAnswerCoverage("能做哪些动作？", [{ source: "loops", id: "task", fields: { actionPolicy: policy } }]);
    expect(plan.facts[0]).toMatchObject({ valueOmitted: true, representation: "source_record_field_reference", truncated: false });
    expect(plan.facts[0]).not.toHaveProperty("value");
    expect(policy.denied).toEqual(["external_write"]);
  });
  it("keeps an unread task goal even when a related workshop mission is available", () => {
    const record = { source: "loops", id: "task", fields: { name: "Task" }, fieldAvailability: { goal: "present_unread" },
      read: { source: "loops", id: "task", offset: 0, expectedHash: "a".repeat(64) } };
    const plan = buildPlatformAnswerCoverage("这次运行属于哪个持续任务？任务目标是什么？", [record,
      { source: "workshops", id: "work", fields: { mission: "Workshop mission" } }]);
    expect(plan.obligations.find(item => item.requestedFields.includes("goal"))).toMatchObject({
      status: "exact_read_required", unreadFields: ["goal"],
    });
    expect(plan.answerCompleteness).toBe("not_verified");
  });
});
