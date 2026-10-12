import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { platformPublishedRecordFacts } from "@/lib/ai/platform-published-record-facts";
const id = "22222222-2222-4222-8222-222222222222";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
it("reserves complete bounded run timestamps before a large optional summary", () => {
  const fields = { id, loopId: "33333333-3333-4333-8333-333333333333", status: "completed", error: null,
    triggerReason: { reason: "scheduled" }, outputSummary: "x".repeat(2800),
    startedAt: "2026-10-02T06:00:00.000Z", completedAt: "2026-10-02T06:01:00.000Z", createdAt: "2026-10-02T05:59:59.000Z" };
  const before = JSON.stringify(fields);
  const facts = platformPublishedRecordFacts({ source: "loopRuns", id, parentContentHash: hash(fields), fields })!;
  expect(JSON.stringify(facts).length).toBeLessThanOrEqual(4000);
  for (const fieldKey of ["startedAt", "completedAt", "createdAt", "error"] as const) {
    expect(facts.fields.find(f => f.fieldKey === fieldKey)).toMatchObject({ complete: true, value: fields[fieldKey], valueHash: hash(fields[fieldKey]) });
  }
  expect(facts.fields.find(f => f.fieldKey === "outputSummary")).toMatchObject({ status: "withheld", complete: false });
  expect(facts.rawRecordComplete).toBe(false);
  expect(JSON.stringify(fields)).toBe(before);
});
it("keeps a missing or contradictory timestamp a gap and preserves recorded null", () => {
  const fields = { id, status: "completed", error: null, outputSummary: "x".repeat(2800),
    startedAt: null, completedAt: "2026-10-02T06:01:00.000Z", completed_at: "2026-10-03T06:01:00.000Z" };
  const facts = platformPublishedRecordFacts({ source: "loopRuns", id, parentContentHash: hash(fields), fields })!;
  expect(facts.fields.find(f => f.fieldKey === "startedAt")).toMatchObject({ status: "not_recorded", complete: true, value: null });
  expect(facts.fields.find(f => f.fieldKey === "completedAt")).toEqual({ fieldKey: "completedAt", status: "invalid", complete: false });
  expect(facts.fields.find(f => f.fieldKey === "createdAt")).toEqual({ fieldKey: "createdAt", status: "not_present", complete: false });
  expect(JSON.stringify(facts).length).toBeLessThanOrEqual(4000);
});
